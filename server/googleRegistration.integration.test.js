import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createAccountReuseDigest, hashSessionToken } from './security.js';

const { Pool } = pg;

async function findFreePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a test port');
  const { port } = address;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

test('Google registration ticket is bound to verified email and consumed atomically with account creation', {
  skip: !process.env.DATABASE_URL,
  timeout: 30_000
}, async () => {
  const port = await findFreePort();
  const origin = 'http://localhost:3000';
  const api = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env,
      API_PORT: String(port),
      APP_ORIGIN: origin,
      NODE_ENV: 'test',
      GOOGLE_CLIENT_ID: '',
      ACCOUNT_REUSE_HMAC_KEY: 'b'.repeat(64),
      AUTH_RATE_LIMIT: '1000',
      EMAIL_VERIFICATION_REQUIRED: 'true',
      PG_STATEMENT_TIMEOUT_MS: '8000'
    },
    stdio: 'ignore'
  });
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 3,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined
  });
  const tickets = [];
  const emails = [];
  const reuseRestrictionDigests = [];
  const reuseKey = 'b'.repeat(64);

  async function request(body) {
    return fetch(`${api}/api/auth/register`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify(body)
    });
  }

  function registrationPayload(email, ticket) {
    return {
      email,
      password: 'Google Registration Test 2026! Secure',
      displayName: 'Google test profile',
      birthDate: '1990-01-01',
      gender: 'female',
      country: 'Georgia',
      city: 'Tbilisi',
      relationshipIntent: 'family_without_marriage',
      familyFormat: 'cohabitation',
      hasChildren: false,
      wantsChildren: 'yes',
      childrenLivingArrangement: 'not_applicable',
      googleRegistrationTicket: ticket
    };
  }

  async function createTicket(email, subject) {
    const raw = randomBytes(32).toString('base64url');
    tickets.push(hashSessionToken(raw));
    emails.push(email);
    await pool.query(
      `INSERT INTO google_registration_tickets
       (ticket_hash, provider_subject, email, display_name, expires_at)
       VALUES ($1, $2, $3, 'Google test profile', NOW() + INTERVAL '10 minutes')`,
      [hashSessionToken(raw), subject, email]
    );
    return raw;
  }

  try {
    let healthy = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`API process exited with code ${child.exitCode}`);
      try {
        const response = await fetch(`${api}/api/health`, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) { healthy = true; break; }
      } catch {
        // Wait for the API process to bind its port.
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(healthy, true, 'API should start before Google registration ticket tests');

    const suffix = randomUUID();
    const subject = `google-registration-${suffix}`;
    const email = `google-register-${suffix}@example.test`;
    const ticket = await createTicket(email, subject);
    const payload = registrationPayload(email, ticket);

    const concurrent = await Promise.all([request(payload), request(payload)]);
    assert.deepEqual(concurrent.map(response => response.status).sort(), [201, 400],
      'concurrent requests using one ticket must create exactly one account');
    const success = concurrent.find(response => response.status === 201);
    assert.ok(success);
    const result = await success.json();
    assert.equal(result.user.email, email);
    const cookie = success.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie?.startsWith('nit_session='));

    const stored = await pool.query(
      `SELECT u.status, u.email_verified_at, i.provider_subject
       FROM users u JOIN user_auth_identities i ON i.user_id = u.id
       WHERE u.email = $1 AND i.provider = 'google'`,
      [email]
    );
    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0].status, 'active');
    assert.ok(stored.rows[0].email_verified_at, 'Google verified email must activate the account without local email delivery');
    assert.equal(stored.rows[0].provider_subject, subject);
    const consumedTicket = await pool.query(
      'SELECT 1 FROM google_registration_tickets WHERE ticket_hash = $1',
      [tickets[0]]
    );
    assert.equal(consumedTicket.rowCount, 0,
      'a successful registration must delete the one-time ticket and its temporary email/subject data');

    const mismatchEmail = `google-mismatch-${suffix}@example.test`;
    const mismatchTicket = await createTicket(mismatchEmail, `google-mismatch-${suffix}`);
    const wrongEmail = await request(registrationPayload(`wrong-${suffix}@example.test`, mismatchTicket));
    assert.equal(wrongEmail.status, 400, 'a ticket must not authorize a different email');
    const correctEmail = await request(registrationPayload(mismatchEmail, mismatchTicket));
    assert.equal(correctEmail.status, 201, 'a rejected email mismatch must not consume the valid ticket');

    const duplicateSubjectEmail = `google-duplicate-sub-${suffix}@example.test`;
    const duplicateSubjectTicket = await createTicket(duplicateSubjectEmail, subject);
    const duplicateSubject = await request(registrationPayload(duplicateSubjectEmail, duplicateSubjectTicket));
    assert.equal(duplicateSubject.status, 409, 'a Google subject must never create a second Vow account');
    const duplicateAccount = await pool.query('SELECT 1 FROM users WHERE email = $1', [duplicateSubjectEmail]);
    assert.equal(duplicateAccount.rowCount, 0);
    
    const restrictedEmail = `google-restricted-${suffix}@example.test`;
    const restrictionDigest = createAccountReuseDigest(restrictedEmail, reuseKey);
    reuseRestrictionDigests.push(restrictionDigest);
    await pool.query("INSERT INTO account_reuse_restrictions (email_hmac, expires_at) VALUES ($1, NOW() + INTERVAL '1 day')", [restrictionDigest]);
    const restrictedTicket = await createTicket(restrictedEmail, `google-restricted-${suffix}`);
    const restrictedResponse = await request(registrationPayload(restrictedEmail, restrictedTicket));
    assert.equal(restrictedResponse.status, 429, 'Google registration must not bypass account recreation restrictions');
    const retainedTicket = await pool.query('SELECT 1 FROM google_registration_tickets WHERE ticket_hash = $1', [hashSessionToken(restrictedTicket)]);
    assert.equal(retainedTicket.rowCount, 1, 'a blocked registration must not consume its ticket');
    await pool.query('DELETE FROM account_reuse_restrictions WHERE email_hmac = $1', [restrictionDigest]);
    const retryAfterRestriction = await request(registrationPayload(restrictedEmail, restrictedTicket));
    assert.equal(retryAfterRestriction.status, 201, 'the ticket can be retried after the restriction is lifted');

  } finally {
    await pool.query('DELETE FROM google_registration_tickets WHERE ticket_hash = ANY($1::text[])', [tickets]).catch(() => {});
    await pool.query('DELETE FROM account_reuse_restrictions WHERE email_hmac = ANY($1::text[])', [reuseRestrictionDigests]).catch(() => {});
    await pool.query('DELETE FROM users WHERE email = ANY($1::text[])', [emails]).catch(() => {});
    await pool.end();
    child.kill('SIGTERM');
    await Promise.race([
      once(child, 'exit'),
      new Promise(resolve => setTimeout(resolve, 5_000))
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});
