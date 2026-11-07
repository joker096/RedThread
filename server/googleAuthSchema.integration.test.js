import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

test('Google identity subject is unique and challenges/tickets can be consumed only once', {
  skip: !process.env.DATABASE_URL,
  timeout: 15_000
}, async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined
  });
  const suffix = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();
  const nonceHash = `nonce-${suffix}`;
  const ticketHash = `ticket-${suffix}`;
  const subject = `google-sub-${suffix}`;
  const expiredNonceHash = `expired-nonce-${suffix}`;
  const expiredTicketHash = `expired-ticket-${suffix}`;

  try {
    await pool.query(
      'INSERT INTO users (id, email, status) VALUES ($1, $2, \'active\'), ($3, $4, \'active\')',
      [userA, `google-a-${suffix}@example.test`, userB, `google-b-${suffix}@example.test`]
    );
    await pool.query(
      'INSERT INTO google_auth_challenges (nonce_hash, expires_at) VALUES ($1, NOW() + INTERVAL \'5 minutes\')',
      [nonceHash]
    );
    const challengeConsumes = await Promise.all([
      pool.query(`UPDATE google_auth_challenges SET consumed_at = NOW()
        WHERE nonce_hash = $1 AND consumed_at IS NULL AND expires_at > NOW() RETURNING id`, [nonceHash]),
      pool.query(`UPDATE google_auth_challenges SET consumed_at = NOW()
        WHERE nonce_hash = $1 AND consumed_at IS NULL AND expires_at > NOW() RETURNING id`, [nonceHash])
    ]);
    assert.equal(challengeConsumes.reduce((sum, result) => sum + result.rowCount, 0), 1,
      'only one concurrent request may consume a challenge');
    await pool.query(
      `INSERT INTO google_auth_challenges (nonce_hash, expires_at) VALUES ($1, NOW() - INTERVAL '1 minute')`,
      [expiredNonceHash]
    );
    const expiredChallenge = await pool.query(
      `UPDATE google_auth_challenges SET consumed_at = NOW()
       WHERE nonce_hash = $1 AND consumed_at IS NULL AND expires_at > NOW() RETURNING id`,
      [expiredNonceHash]
    );
    assert.equal(expiredChallenge.rowCount, 0, 'expired challenges must not be consumable');

    await pool.query(
      `INSERT INTO google_registration_tickets
       (ticket_hash, provider_subject, email, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')`,
      [ticketHash, subject, `google-a-${suffix}@example.test`]
    );
    const ticketConsumes = await Promise.all([
      pool.query(`UPDATE google_registration_tickets SET consumed_at = NOW()
        WHERE ticket_hash = $1 AND consumed_at IS NULL AND expires_at > NOW() RETURNING id`, [ticketHash]),
      pool.query(`UPDATE google_registration_tickets SET consumed_at = NOW()
        WHERE ticket_hash = $1 AND consumed_at IS NULL AND expires_at > NOW() RETURNING id`, [ticketHash])
    ]);
    assert.equal(ticketConsumes.reduce((sum, result) => sum + result.rowCount, 0), 1,
      'only one concurrent request may consume a registration ticket');
    await pool.query(
      `INSERT INTO google_registration_tickets
       (ticket_hash, provider_subject, email, expires_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '1 minute')`,
      [expiredTicketHash, `expired-${subject}`, `expired-${suffix}@example.test`]
    );
    const expiredTicket = await pool.query(
      `UPDATE google_registration_tickets SET consumed_at = NOW()
       WHERE ticket_hash = $1 AND consumed_at IS NULL AND expires_at > NOW() RETURNING id`,
      [expiredTicketHash]
    );
    assert.equal(expiredTicket.rowCount, 0, 'expired registration tickets must not be consumable');

    await pool.query(
      "INSERT INTO user_auth_identities (user_id, provider, provider_subject) VALUES ($1, 'google', $2)",
      [userA, subject]
    );
    await assert.rejects(
      pool.query(
        "INSERT INTO user_auth_identities (user_id, provider, provider_subject) VALUES ($1, 'google', $2)",
        [userB, subject]
      ),
      error => error?.code === '23505'
    );
    await assert.rejects(
      pool.query(
        "INSERT INTO user_auth_identities (user_id, provider, provider_subject) VALUES ($1, 'google', $2)",
        [userA, `second-subject-${suffix}`]
      ),
      error => error?.code === '23505'
    );

    await pool.query("UPDATE users SET status = 'deleted' WHERE id = $1", [userA]);
    const erasedIdentity = await pool.query(
      "SELECT 1 FROM user_auth_identities WHERE user_id = $1",
      [userA]
    );
    assert.equal(erasedIdentity.rowCount, 0,
      'soft account erasure must remove the Google subject mapping, not only rely on ON DELETE CASCADE');
  } finally {
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[userA, userB]]).catch(() => {});
    await pool.query('DELETE FROM google_auth_challenges WHERE nonce_hash = ANY($1::text[])', [[nonceHash, expiredNonceHash]]).catch(() => {});
    await pool.query('DELETE FROM google_registration_tickets WHERE ticket_hash = ANY($1::text[])', [[ticketHash, expiredTicketHash]]).catch(() => {});
    await pool.end();
  }
});
