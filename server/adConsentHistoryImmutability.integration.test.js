import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Pool } = pg;

test('PostgreSQL consent history rejects direct updates and deletes', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const trigger = await client.query(
      `SELECT t.tgname, t.tgenabled
       FROM pg_trigger t
       WHERE t.tgrelid = 'ad_consent_history'::regclass
         AND t.tgname = 'ad_consent_history_append_only'
         AND NOT t.tgisinternal`
    );
    assert.equal(trigger.rowCount, 1, 'migration must install the append-only trigger');
    assert.equal(trigger.rows[0].tgenabled, 'O', 'append-only trigger must be enabled');

    await client.query('BEGIN');
    try {
      await client.query(`
        CREATE TEMP TABLE consent_history_immutability_test (id integer PRIMARY KEY, value text)
      `);
      await client.query(`
        CREATE TRIGGER consent_history_immutability_test_trigger
        BEFORE UPDATE OR DELETE ON consent_history_immutability_test
        FOR EACH ROW EXECUTE FUNCTION reject_ad_consent_history_mutation()
      `);
      await client.query("INSERT INTO consent_history_immutability_test VALUES (1, 'original')");

      for (const statement of [
        "UPDATE consent_history_immutability_test SET value = 'changed' WHERE id = 1",
        'DELETE FROM consent_history_immutability_test WHERE id = 1'
      ]) {
        await client.query('SAVEPOINT immutable_history_write');
        let writeError;
        try {
          await client.query(statement);
        } catch (error) {
          writeError = error;
        }
        assert.equal(writeError?.code, '55000', 'direct history mutation must be rejected');
        await client.query('ROLLBACK TO SAVEPOINT immutable_history_write');
        await client.query('RELEASE SAVEPOINT immutable_history_write');
      }

      const row = await client.query('SELECT value FROM consent_history_immutability_test WHERE id = 1');
      assert.equal(row.rows[0].value, 'original');
      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  } finally {
    client.release();
    await pool.end();
  }
});
