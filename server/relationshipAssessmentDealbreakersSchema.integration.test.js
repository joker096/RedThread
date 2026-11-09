import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

test('relationship assessment dealbreakers default to an array and reject malformed JSON shapes', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const userId = randomUUID();
  try {
    await db.query(
      "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'test-only-hash')",
      [userId, `assessment-dealbreakers-${userId}@example.invalid`]
    );
    await db.query(
      'INSERT INTO relationship_assessments (user_id, answers) VALUES ($1, \'{}\'::jsonb)',
      [userId]
    );
    const saved = await db.query(
      'SELECT dealbreakers FROM relationship_assessments WHERE user_id = $1',
      [userId]
    );
    assert.deepEqual(saved.rows[0].dealbreakers, []);

    await db.query(
      'UPDATE relationship_assessments SET dealbreakers = $2::jsonb WHERE user_id = $1',
      [userId, JSON.stringify(['children', 'financialModel'])]
    );
    await assert.rejects(
      db.query('UPDATE relationship_assessments SET dealbreakers = $2::jsonb WHERE user_id = $1', [userId, JSON.stringify({ children: true })]),
      /relationship_assessments_dealbreakers_array_check/
    );
    await assert.rejects(
      db.query('UPDATE relationship_assessments SET dealbreakers = $2::jsonb WHERE user_id = $1', [userId, JSON.stringify(Array(16).fill('children'))]),
      /relationship_assessments_dealbreakers_array_check/
    );
  } finally {
    await db.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
    await db.end();
  }
});
