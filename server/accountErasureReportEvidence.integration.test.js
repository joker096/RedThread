import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

test('account erasure nulls live user-report links but preserves immutable report identity snapshots', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const reporterId = randomUUID();
  const targetId = randomUUID();
  const reportId = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO users (id, email, password_hash, status)
       VALUES ($1, $2, 'test-only-hash', 'active'),
              ($3, $4, 'test-only-hash', 'active')`,
      [reporterId, `reporter-${reporterId}@example.invalid`, targetId, `target-${targetId}@example.invalid`]
    );
    await client.query(
      `INSERT INTO user_reports (id, reporter_id, reported_user_id, category, details)
       VALUES ($1, $2, $3, 'spam', 'privacy recovery report evidence fixture')`,
      [reportId, reporterId, targetId]
    );

    await client.query(
      `UPDATE users SET status = 'deleted', updated_at = statement_timestamp() WHERE id = $1`,
      [targetId]
    );

    const report = await client.query(
      `SELECT reporter_id, reported_user_id, reporter_ref, reported_user_ref, category, details
         FROM user_reports WHERE id = $1`,
      [reportId]
    );
    assert.equal(report.rowCount, 1);
    assert.equal(report.rows[0].reporter_id, reporterId);
    assert.equal(report.rows[0].reported_user_id, null);
    assert.equal(report.rows[0].reporter_ref, reporterId);
    assert.equal(report.rows[0].reported_user_ref, targetId);
    assert.equal(report.rows[0].category, 'spam');
    assert.equal(report.rows[0].details, 'privacy recovery report evidence fixture');
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
});
