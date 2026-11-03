import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Pool } = pg;

test('date plan schema enforces mutual confirmation and cancels plans on safety changes', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const tables = await client.query(
      "SELECT to_regclass('public.date_plans') AS plans, to_regclass('public.date_plan_events') AS events"
    );
    assert.equal(tables.rows[0].plans, 'date_plans');
    assert.equal(tables.rows[0].events, 'date_plan_events');

    const columns = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'date_plans'"
    );
    const names = new Set(columns.rows.map(row => row.column_name));
    for (const name of ['match_id', 'proposed_by', 'venue_name', 'is_public_venue', 'starts_at', 'time_zone', 'status', 'confirmed_by_a_at', 'confirmed_by_b_at']) {
      assert.ok(names.has(name), 'date_plans must persist ' + name);
    }

    const notificationConstraint = await client.query(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'user_notifications'::regclass
         AND conname = 'user_notifications_type_check'`
    );
    assert.equal(notificationConstraint.rowCount, 1);
    for (const type of ['date_plan_proposed', 'date_plan_confirmed', 'date_plan_cancelled', 'date_plan_declined']) {
      assert.ok(notificationConstraint.rows[0].definition.includes(type),
        'notification constraint must permit ' + type);
    }

    const triggers = await client.query(
      `SELECT c.relname AS table_name, t.tgname
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE NOT t.tgisinternal AND t.tgname IN ('matches_cancel_date_plans_on_close', 'user_blocks_cancel_date_plans')`
    );
    assert.ok(triggers.rows.some(row => row.tgname === 'matches_cancel_date_plans_on_close'));
    assert.ok(triggers.rows.some(row => row.tgname === 'user_blocks_cancel_date_plans'));

    await client.query('BEGIN');
    const users = await client.query(
      `INSERT INTO users (email, status) VALUES ($1, 'active'), ($2, 'active') RETURNING id`,
      [`date-plan-a-${Date.now()}@example.test`, `date-plan-b-${Date.now()}@example.test`]
    );
    const [a, b] = users.rows.map(row => row.id).sort();
    await client.query(
      `INSERT INTO profiles (user_id, display_name, gender, country, city)
       VALUES ($1, 'Date Plan A', 'female', 'Georgia', 'Tbilisi'),
              ($2, 'Date Plan B', 'female', 'Georgia', 'Tbilisi')`,
      [a, b]
    );
    const match = await client.query(
      "INSERT INTO matches (user_a_id, user_b_id, status) VALUES ($1, $2, 'active') RETURNING id",
      [a, b]
    );
    const matchId = match.rows[0].id;
    const plan = await client.query(
      `INSERT INTO date_plans (match_id, proposed_by, venue_name, is_public_venue, starts_at, time_zone)
       VALUES ($1, $2, 'Public Cafe', TRUE, NOW() + INTERVAL '2 hours', 'Asia/Tbilisi') RETURNING id`,
      [matchId, a]
    );
    const planId = plan.rows[0].id;
    await client.query(
      "UPDATE date_plans SET confirmed_by_a_at = NOW() WHERE id = $1",
      [planId]
    );
    const partial = await client.query('SELECT status, confirmed_by_a_at, confirmed_by_b_at FROM date_plans WHERE id = $1', [planId]);
    assert.equal(partial.rows[0].status, 'proposed');
    assert.ok(partial.rows[0].confirmed_by_a_at);
    assert.equal(partial.rows[0].confirmed_by_b_at, null);

    await client.query('SAVEPOINT invalid_date_plan_confirmation_state');
    await assert.rejects(
      client.query("UPDATE date_plans SET confirmed_by_b_at = NOW() WHERE id = $1", [planId]),
      error => error?.code === '23514',
      'the database must reject two confirmations while the plan remains proposed'
    );
    await client.query('ROLLBACK TO SAVEPOINT invalid_date_plan_confirmation_state');

    await client.query(
      "UPDATE date_plans SET confirmed_by_b_at = NOW(), status = 'confirmed' WHERE id = $1",
      [planId]
    );
    const confirmed = await client.query('SELECT status, confirmed_by_a_at, confirmed_by_b_at FROM date_plans WHERE id = $1', [planId]);
    assert.equal(confirmed.rows[0].status, 'confirmed');
    assert.ok(confirmed.rows[0].confirmed_by_a_at && confirmed.rows[0].confirmed_by_b_at);

    await client.query("INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)", [a, b]);
    const cancelled = await client.query('SELECT status, confirmed_by_a_at, confirmed_by_b_at FROM date_plans WHERE id = $1', [planId]);
    assert.equal(cancelled.rows[0].status, 'cancelled');
    assert.equal(cancelled.rows[0].confirmed_by_a_at, null);
    assert.equal(cancelled.rows[0].confirmed_by_b_at, null);
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
});
