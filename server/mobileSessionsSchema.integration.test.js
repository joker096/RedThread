import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

test('mobile session schema enforces token integrity, rotation history and account cleanup', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const userId = randomUUID();
  const sessionId = randomUUID();
  const accessHash = 'a'.repeat(64);
  const refreshHash = 'b'.repeat(64);
  const oldRefreshHash = 'c'.repeat(64);

  try {
    await db.query(
      "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'test-only-hash')",
      [userId, `mobile-session-${userId}@example.invalid`]
    );
    await db.query(
      "INSERT INTO profiles (user_id, display_name, gender, country, city) VALUES ($1, 'Mobile Test', 'female', 'Georgia', 'Tbilisi')",
      [userId]
    );

    await db.query(
      `INSERT INTO mobile_sessions
         (id, user_id, platform, device_id, device_name, access_token_hash, refresh_token_hash, access_expires_at, refresh_expires_at)
       VALUES ($1, $2, 'android', $3, 'Test device', $4, $5, NOW() + INTERVAL '10 minutes', NOW() + INTERVAL '30 days')`,
      [sessionId, userId, randomUUID(), accessHash, refreshHash]
    );

    await db.query(
      'INSERT INTO mobile_refresh_token_history (session_id, token_hash) VALUES ($1, $2)',
      [sessionId, oldRefreshHash]
    );

    await assert.rejects(
      db.query('UPDATE mobile_refresh_token_history SET token_hash = $2 WHERE session_id = $1', [sessionId, 'd'.repeat(64)]),
      /append-only/
    );

    await assert.rejects(
      db.query(
        `INSERT INTO mobile_sessions
           (user_id, platform, device_id, device_name, access_token_hash, refresh_token_hash, access_expires_at, refresh_expires_at)
         VALUES ($1, 'windows', $2, 'Bad platform', $3, $4, NOW() + INTERVAL '1 minute', NOW() + INTERVAL '1 day')`,
        [userId, randomUUID(), 'e'.repeat(64), 'f'.repeat(64)]
      ),
      /mobile_sessions_platform_check/
    );

    await assert.rejects(
      db.query(
        `INSERT INTO mobile_sessions
           (user_id, platform, device_id, device_name, access_token_hash, refresh_token_hash, access_expires_at, refresh_expires_at)
         VALUES ($1, 'ios', $2, 'Bad expiry', $3, $4, NOW() + INTERVAL '2 days', NOW() + INTERVAL '1 day')`,
        [userId, randomUUID(), '1'.repeat(64), '2'.repeat(64)]
      ),
      /mobile_sessions_check/
    );

    await db.query('DELETE FROM users WHERE id = $1', [userId]);
    const sessions = await db.query('SELECT id FROM mobile_sessions WHERE id = $1', [sessionId]);
    const history = await db.query('SELECT id FROM mobile_refresh_token_history WHERE session_id = $1', [sessionId]);
    assert.equal(sessions.rowCount, 0, 'account deletion must cascade to mobile sessions');
    assert.equal(history.rowCount, 0, 'account deletion must cascade to refresh history');
  } finally {
    await db.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
    await db.end();
  }
});
