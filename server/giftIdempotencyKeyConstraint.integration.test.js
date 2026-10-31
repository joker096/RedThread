import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Pool } = pg;

test('gift idempotency keys are non-empty and normalized at the database boundary', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const constraint = await client.query(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conname = 'gift_orders_idempotency_key_normalized'
         AND conrelid = 'gift_delivery_orders'::regclass`
    );
    assert.equal(constraint.rowCount, 1, 'migration 031 should install the idempotency-key constraint');
    const constraintDefinition = constraint.rows[0]?.definition;
    assert.equal(typeof constraintDefinition, 'string', 'PostgreSQL should expose the installed constraint definition');

    await client.query('BEGIN');
    try {
      // Exercise the exact CHECK expression installed on the production table,
      // rather than maintaining a second copy of the policy in this test.
      await client.query(`
        CREATE TEMP TABLE gift_idempotency_key_constraint_test (
          idempotency_key varchar(128) NOT NULL,
          CONSTRAINT gift_orders_idempotency_key_normalized
            ${constraintDefinition}
        ) ON COMMIT DROP
      `);

      for (const validKey of ['req_01HXYZ', '550e8400-e29b-41d4-a716-446655440000']) {
        await client.query(
          'INSERT INTO gift_idempotency_key_constraint_test (idempotency_key) VALUES ($1)',
          [validKey]
        );
      }

      for (const invalidKey of ['', '   ', ' leading', 'trailing ', ' both ']) {
        await client.query('SAVEPOINT invalid_idempotency_key');
        let insertError;
        try {
          await client.query(
            'INSERT INTO gift_idempotency_key_constraint_test (idempotency_key) VALUES ($1)',
            [invalidKey]
          );
        } catch (error) {
          insertError = error;
        }
        assert.equal(insertError?.code, '23514', `installed CHECK constraint must reject malformed idempotency key: ${JSON.stringify(invalidKey)}`);
        await client.query('ROLLBACK TO SAVEPOINT invalid_idempotency_key');
        await client.query('RELEASE SAVEPOINT invalid_idempotency_key');
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  } finally {
    client.release();
    await pool.end();
  }
});


test('gift order uniqueness constraints prevent concurrent duplicate inserts', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  const setup = await pool.connect();
  const schema = `gift_race_test_${randomUUID().replaceAll('-', '')}`;
  try {
    const definitions = await setup.query(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'gift_delivery_orders'::regclass
         AND contype = 'u'`
    );
    // Constraint names can vary between PostgreSQL-created and explicitly named
    // schemas; identify the live unique constraint by its columns if necessary.
    const uniqueKey = definitions.rows.find(row =>
      row.definition?.replaceAll(' ', '') === 'UNIQUE(sender_id,idempotency_key)'
    );
    assert.ok(uniqueKey, 'production table must enforce UNIQUE(sender_id, idempotency_key)');

    const pairIndex = await setup.query(
      `SELECT pg_get_indexdef(indexrelid) AS definition
       FROM pg_index
       WHERE indrelid = 'gift_delivery_orders'::regclass
         AND indexrelid = to_regclass('gift_orders_one_pending_per_unordered_pair_idx')`
    );
    assert.equal(pairIndex.rowCount, 1, 'production unordered-pair unique index must be installed');
    assert.match(pairIndex.rows[0].definition, /LEAST\s*\(sender_id, recipient_id\)/i);
    assert.match(pairIndex.rows[0].definition, /GREATEST\s*\(sender_id, recipient_id\)/i);
    assert.match(pairIndex.rows[0].definition, /awaiting_recipient_consent/);

    await setup.query(`CREATE SCHEMA "${schema}"`);
    await setup.query(`
      CREATE TABLE "${schema}".gift_orders_race (
        id uuid PRIMARY KEY,
        match_id uuid NOT NULL,
        sender_id uuid NOT NULL,
        recipient_id uuid NOT NULL,
        status text NOT NULL,
        idempotency_key varchar(128) NOT NULL,
        CONSTRAINT gift_race_sender_key_unique ${uniqueKey.definition}
      )
    `);
    await setup.query(`
      CREATE UNIQUE INDEX gift_race_one_pending_pair
      ON "${schema}".gift_orders_race (
        match_id, LEAST(sender_id, recipient_id), GREATEST(sender_id, recipient_id)
      )
      WHERE status = 'awaiting_recipient_consent'
    `);

    const waitForUniqueIndexLock = async (applicationName) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const waiting = await setup.query(
          `SELECT 1
           FROM pg_stat_activity
           WHERE application_name = $1
             AND state = 'active'
             AND wait_event_type = 'Lock'
             AND query ILIKE '%gift_orders_race%'
           LIMIT 1`,
          [applicationName]
        );
        if (waiting.rowCount === 1) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail('competing insert did not reach the unique-index lock within 5 seconds');
    };

    const raceInsert = async (first, second, expectedConstraint) => {
      const a = await pool.connect();
      const b = await pool.connect();
      const applicationName = `gift_race_${randomUUID().replaceAll('-', '')}`;
      try {
      await b.query('SELECT set_config(\'application_name\', $1, false)', [applicationName]);
      await a.query('BEGIN');
      await a.query(
        `INSERT INTO "${schema}".gift_orders_race
          (id, match_id, sender_id, recipient_id, status, idempotency_key)
         VALUES ($1, $2, $3, $4, 'awaiting_recipient_consent', $5)`,
        first
      );
      await b.query('BEGIN');
      const competingInsert = b.query(
        `INSERT INTO "${schema}".gift_orders_race
          (id, match_id, sender_id, recipient_id, status, idempotency_key)
         VALUES ($1, $2, $3, $4, 'awaiting_recipient_consent', $5)`,
        second
      ).then(() => ({ error: null }), error => ({ error }));
      // Wait until PostgreSQL confirms the competing insert is blocked on a
      // lock held by the first transaction; avoid timing-only race assertions.
      await waitForUniqueIndexLock(applicationName);
      await a.query('COMMIT');
      const outcome = await competingInsert;
      assert.equal(outcome.error?.code, '23505', 'the competing insert must lose the uniqueness race');
      assert.match(outcome.error?.constraint || '', new RegExp(expectedConstraint));
      await b.query('ROLLBACK').catch(() => {});
      const count = await setup.query(
        `SELECT count(*)::int AS count FROM "${schema}".gift_orders_race
         WHERE idempotency_key = $1 OR match_id = $2`,
        [first[4], first[1]]
      );
      assert.equal(count.rows[0].count, 1, 'only one row may survive each uniqueness race');
      } finally {
        // Return both connections before the next race; otherwise the setup
        // client plus two leaked clients exhausts the four-connection pool.
        b.release();
        a.release();
      }
    };

    const idA = randomUUID(), idB = randomUUID();
    const sender = randomUUID(), recipientA = randomUUID(), recipientB = randomUUID();
    await raceInsert(
      [idA, randomUUID(), sender, recipientA, 'same-request-key'],
      [idB, randomUUID(), sender, recipientB, 'same-request-key'],
      'gift_race_sender_key_unique'
    );

    const match = randomUUID(), left = randomUUID(), right = randomUUID();
    await raceInsert(
      [randomUUID(), match, left, right, 'key-left'],
      [randomUUID(), match, right, left, 'key-right'],
      'gift_race_one_pending_pair'
    );
  } finally {
    await setup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    setup.release();
    await pool.end();
  }
});
