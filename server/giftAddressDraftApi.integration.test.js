import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

async function findFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate API port');
  const port = address.port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test('gift address draft HTTP API is recipient-only, separately consented and encrypted', {
  skip: !process.env.DATABASE_URL,
  timeout: 60_000
}, async () => {
  const port = await findFreePort();
  const origin = 'http://localhost:3000';
  const api = 'http://127.0.0.1:' + port;
  const serverDatabaseUrl = new URL(process.env.DATABASE_URL);
  serverDatabaseUrl.searchParams.set('application_name', 'vow-gift-address-draft-api-integration');
  const db = new Pool({ connectionString: serverDatabaseUrl.toString(), max: 3 });
  const key = Buffer.alloc(32, 0x5a).toString('base64');
  const child = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env,
      API_PORT: String(port),
      APP_ORIGIN: origin,
      NODE_ENV: 'test',
      GOOGLE_CLIENT_ID: '   ',
      AUTH_RATE_LIMIT: '1000',
      USER_DATA_EXPORT_RATE_LIMIT: '100',
      DATABASE_URL: serverDatabaseUrl.toString(),
      ACCOUNT_REUSE_HMAC_KEY: 'e'.repeat(64),
      GIFT_ADDRESS_DRAFT_KEYRING: JSON.stringify({ 'draft-test-v1': key }),
      GIFT_ADDRESS_DRAFT_ACTIVE_KEY_VERSION: 'draft-test-v1',
      PG_STATEMENT_TIMEOUT_MS: '8000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let apiLogs = '';
  child.stdout.on('data', chunk => { apiLogs += chunk.toString(); });
  child.stderr.on('data', chunk => { apiLogs += chunk.toString(); });
  const users = [];
  let orderId = null;
  let matchId = null;

  async function request(path, options = {}) {
    return fetch(api + path, {
      ...options,
      signal: options.signal || AbortSignal.timeout(10_000),
      headers: { Origin: origin, ...(options.headers || {}) }
    });
  }

  async function register(label) {
    const email = 'gift-draft-' + label + '-' + randomUUID() + '@example.test';
    const response = await request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email, password: 'Test Password 2026! Secure',
        displayName: 'Gift draft ' + label, birthDate: '1990-01-01',
        gender: 'female', country: 'Georgia', city: 'Tbilisi',
        relationshipIntent: 'family_without_marriage', familyFormat: 'cohabitation',
        hasChildren: false, wantsChildren: 'yes', childrenLivingArrangement: 'not_applicable'
      })
    });
    assert.equal(response.status, 201, label + ' registration failed: ' + await response.clone().text());
    const body = await response.json();
    users.push(body.user.id);
    return { id: body.user.id, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }

  try {
    let healthy = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null) throw new Error('API exited: ' + child.exitCode + ' ' + apiLogs);
      try {
        const response = await fetch(api + '/api/health', { signal: AbortSignal.timeout(1500) });
        if (response.ok) { healthy = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(healthy, true, 'API must start. Logs: ' + apiLogs);

    const sender = await register('sender');
    const recipient = await register('recipient');
    matchId = randomUUID();
    orderId = randomUUID();
    await db.query(
      `INSERT INTO matches (id, user_a_id, user_b_id, status, created_at)
       VALUES ($1, LEAST($2::uuid, $3::uuid), GREATEST($2::uuid, $3::uuid), 'active', NOW())`,
      [matchId, sender.id, recipient.id]
    );
    const created = await db.query(
      `INSERT INTO gift_delivery_orders
         (id, match_id, sender_id, recipient_id, product_name_snapshot, product_category,
          total_minor_units, currency, idempotency_key, status, payment_status,
          recipient_consent_at, recipient_consent_version)
       VALUES ($1, $2, $3, $4, 'Draft integration gift', 'chocolate',
               1000, 'GEL', $5, 'recipient_accepted', 'not_started', NOW(), 1)
       RETURNING public_reference`,
      [orderId, matchId, sender.id, recipient.id, 'draft-api-' + randomUUID()]
    );
    const reference = created.rows[0].public_reference;
    const endpoint = '/api/gifts/orders/' + encodeURIComponent(reference) + '/address-draft';

    assert.equal((await request(endpoint)).status, 401, 'draft reads require authentication');
    assert.equal((await request(endpoint, { headers: { Cookie: sender.cookie } })).status, 404,
      'the sender must not be able to discover the recipient draft');
    const missingConsent = await request(endpoint, {
      method: 'PUT', headers: { Cookie: recipient.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ consent: false, consentVersion: 1, address: {} })
    });
    assert.equal(missingConsent.status, 400);

    const address = {
      recipientName: 'Recipient Test', phone: '+995 555 123456',
      addressLine1: 'Rustaveli Avenue 1', city: 'Tbilisi', countryCode: 'GE'
    };
    const saved = await request(endpoint, {
      method: 'PUT', headers: { Cookie: recipient.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ consent: true, consentVersion: 1, address })
    });
    assert.equal(saved.status, 201, 'recipient should be able to save a separately consented draft: ' + await saved.clone().text());
    const savedBody = await saved.json();
    assert.equal(savedBody.addressVerified, false);
    assert.equal(savedBody.fulfilmentAuthorized, false);

    const stored = await db.query(
      `SELECT d.ciphertext, d.nonce, d.auth_tag, d.key_version,
              o.status, o.address_vault_ref, o.address_verified_at
         FROM gift_address_drafts d
         JOIN gift_delivery_orders o ON o.id = d.order_id
        WHERE d.order_id = $1 AND d.recipient_user_id = $2`,
      [orderId, recipient.id]
    );
    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0].key_version, 'draft-test-v1');
    assert.equal(stored.rows[0].status, 'recipient_accepted');
    assert.equal(stored.rows[0].address_vault_ref, null);
    assert.equal(stored.rows[0].address_verified_at, null);
    assert.equal(stored.rows[0].ciphertext.includes(Buffer.from('Rustaveli')), false,
      'database ciphertext must not contain plaintext address bytes');

    const senderRead = await request(endpoint, { headers: { Cookie: sender.cookie } });
    assert.equal(senderRead.status, 404);
    const read = await request(endpoint, { headers: { Cookie: recipient.cookie } });
    assert.equal(read.status, 200);
    const readBody = await read.json();
    assert.deepEqual(readBody.draft.address, address);
    assert.equal(readBody.addressVerified, false);
    assert.equal(readBody.fulfilmentAuthorized, false);

    const deleted = await request(endpoint, { method: 'DELETE', headers: { Cookie: recipient.cookie } });
    assert.equal(deleted.status, 204);
    const [draftAfterDelete, history] = await Promise.all([
      db.query('SELECT 1 FROM gift_address_drafts WHERE order_id = $1', [orderId]),
      db.query('SELECT action, consent_version FROM gift_address_draft_consent_events WHERE order_id = $1 ORDER BY id', [orderId])
    ]);
    assert.equal(draftAfterDelete.rowCount, 0, 'withdrawal must physically delete the live ciphertext row');
    assert.deepEqual(history.rows, [
      { action: 'granted', consent_version: 1 },
      { action: 'withdrawn', consent_version: 1 }
    ]);
  } finally {
    const cleanup = await db.connect().catch(() => null);
    if (cleanup) {
      try {
        await cleanup.query('ALTER TABLE gift_address_draft_consent_events DISABLE TRIGGER gift_address_draft_consent_events_immutable').catch(() => {});
        if (orderId) await cleanup.query('DELETE FROM gift_address_drafts WHERE order_id = $1', [orderId]).catch(() => {});
        if (orderId) await cleanup.query('DELETE FROM gift_address_draft_consent_events WHERE order_id = $1', [orderId]).catch(() => {});
        if (orderId) await cleanup.query('DELETE FROM gift_delivery_orders WHERE id = $1', [orderId]).catch(() => {});
        if (matchId) await cleanup.query('DELETE FROM matches WHERE id = $1', [matchId]).catch(() => {});
        if (users.length) await cleanup.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users]).catch(() => {});
      } finally {
        await cleanup.query('ALTER TABLE gift_address_draft_consent_events ENABLE TRIGGER gift_address_draft_consent_events_immutable').catch(() => {});
        cleanup.release();
      }
    }
    await db.end().catch(() => {});
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      let timer;
      await Promise.race([once(child, 'exit'), new Promise(resolve => { timer = setTimeout(resolve, 2000); })]);
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }
  }
});
