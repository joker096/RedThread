import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

async function findFreePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a test port');
  const port = address.port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

test('voice intro HTTP API enforces consent, authentication and withdrawal history', {
  skip: !process.env.DATABASE_URL,
  timeout: 45_000
}, async () => {
  const port = await findFreePort();
  const origin = 'http://localhost:3000';
  const api = 'http://127.0.0.1:' + port;
  const serverDatabaseUrl = new URL(process.env.DATABASE_URL);
  serverDatabaseUrl.searchParams.set('application_name', 'vow-voice-intro-api-integration');
  const db = new Pool({ connectionString: serverDatabaseUrl.toString(), max: 2 });
  const child = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env,
      API_PORT: String(port),
      APP_ORIGIN: origin,
      NODE_ENV: 'test',
      GOOGLE_CLIENT_ID: '   ',
      AUTH_RATE_LIMIT: '1000',
      DATABASE_URL: serverDatabaseUrl.toString(),
      ACCOUNT_REUSE_HMAC_KEY: 'a'.repeat(64),
      VOICE_INTRO_ENCRYPTION_KEY: 'b'.repeat(64),
      VOICE_INTRO_STORAGE_DIR: '/tmp/vow-voice-intro-api-test-' + randomUUID(),
      PG_STATEMENT_TIMEOUT_MS: '8000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let apiLogs = '';
  child.stdout.on('data', chunk => { apiLogs += chunk.toString(); });
  child.stderr.on('data', chunk => { apiLogs += chunk.toString(); });

  async function request(path, options = {}) {
    return fetch(api + path, {
      ...options,
      signal: options.signal || AbortSignal.timeout(10_000),
      headers: { Origin: origin, ...(options.headers || {}) }
    });
  }

  let userId = null;
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null) throw new Error('API exited with code ' + child.exitCode + ': ' + apiLogs);
      try {
        const response = await fetch(api + '/api/health', { signal: AbortSignal.timeout(1_500) });
        if (response.ok) { healthy = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(healthy, true, 'API should start successfully. Logs: ' + apiLogs);

    const email = 'voice-api-' + randomUUID() + '@example.test';
    const registration = await request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: 'Test Password 2026! Secure',
        displayName: 'Voice API integration',
        birthDate: '1990-01-01',
        gender: 'female',
        country: 'Georgia',
        city: 'Tbilisi',
        relationshipIntent: 'family_without_marriage',
        familyFormat: 'cohabitation',
        hasChildren: false,
        wantsChildren: 'yes',
        childrenLivingArrangement: 'not_applicable'
      })
    });
    assert.equal(registration.status, 201, 'registration failed: ' + await registration.clone().text());
    const registered = await registration.json();
    userId = registered.user.id;
    const cookie = registration.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie?.startsWith('nit_session='));

    const unauthenticatedRead = await request('/api/profiles/me/voice-intro');
    assert.equal(unauthenticatedRead.status, 401);

    const missingConsent = await request('/api/profiles/me/voice-intro', {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'audio/mp4' },
      body: Buffer.alloc(96, 1)
    });
    assert.equal(missingConsent.status, 428);
    assert.equal((await missingConsent.json()).error, 'voice_intro_consent_required');

    const staleConsent = await request('/api/profiles/me/voice-intro', {
      method: 'PUT',
      headers: {
        Cookie: cookie,
        'Content-Type': 'audio/mp4',
        'X-Vow-Voice-Intro-Consent': 'granted',
        'X-Vow-Voice-Intro-Consent-Version': '0'
      },
      body: Buffer.alloc(96, 1)
    });
    assert.equal(staleConsent.status, 428);

    const invalidMedia = await request('/api/profiles/me/voice-intro', {
      method: 'PUT',
      headers: {
        Cookie: cookie,
        'Content-Type': 'audio/mp4',
        'X-Vow-Voice-Intro-Consent': 'granted',
        'X-Vow-Voice-Intro-Consent-Version': '1'
      },
      body: Buffer.alloc(96, 1)
    });
    assert.equal(invalidMedia.status, 400,
      'valid consent must not bypass independent AAC media validation');

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO profile_voice_intro_consents (user_id, consent_version) VALUES ($1, 1)',
        [userId]
      );
      await client.query(
        "INSERT INTO profile_voice_intro_consent_events (user_id, actor_user_id, event_type, consent_version, occurred_at) SELECT user_id, user_id, 'granted', consent_version, granted_at FROM profile_voice_intro_consents WHERE user_id = $1",
        [userId]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    const withdrawn = await request('/api/profiles/me/voice-intro', {
      method: 'DELETE',
      headers: { Cookie: cookie }
    });
    assert.equal(withdrawn.status, 204);

    const consentState = await db.query(
      'SELECT consent_version, withdrawn_at FROM profile_voice_intro_consents WHERE user_id = $1',
      [userId]
    );
    assert.equal(consentState.rowCount, 1);
    assert.equal(consentState.rows[0].consent_version, 1);
    assert.ok(consentState.rows[0].withdrawn_at instanceof Date);

    const history = await db.query(
      'SELECT event_type, consent_version FROM profile_voice_intro_consent_events WHERE user_id = $1 ORDER BY id',
      [userId]
    );
    assert.deepEqual(history.rows, [
      { event_type: 'granted', consent_version: 1 },
      { event_type: 'withdrawn', consent_version: 1 }
    ]);

    const repeatedWithdrawal = await request('/api/profiles/me/voice-intro', {
      method: 'DELETE',
      headers: { Cookie: cookie }
    });
    assert.equal(repeatedWithdrawal.status, 204);
    const historyAfterRepeat = await db.query(
      "SELECT COUNT(*)::int AS count FROM profile_voice_intro_consent_events WHERE user_id = $1 AND event_type = 'withdrawn'",
      [userId]
    );
    assert.equal(historyAfterRepeat.rows[0].count, 1);
  } finally {
    if (userId) await db.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
    await db.end().catch(() => {});
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      let exitTimer;
      await Promise.race([
        once(child, 'exit'),
        new Promise(resolve => { exitTimer = setTimeout(resolve, 2_000); })
      ]);
      clearTimeout(exitTimer);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }
  }
});
