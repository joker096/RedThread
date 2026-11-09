import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { hashPassword } from './security.js';

const { Pool } = pg;

async function findFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate test port');
  const port = address.port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test('native mobile auth login, refresh rotation, replay revocation and device logout', {
  skip: !process.env.DATABASE_URL,
  timeout: 60_000
}, async () => {
  const port = await findFreePort();
  const api = `http://127.0.0.1:${port}`;
  const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  const userId = randomUUID();
  const email = `mobile-auth-${userId}@example.invalid`;
  const password = 'Native Mobile Auth Test Password 2026!';
  const passwordHash = await hashPassword(password);
  const deviceA = {
    platform: 'android',
    deviceId: randomUUID(),
    deviceName: 'Android test device'
  };
  const deviceB = {
    platform: 'ios',
    deviceId: randomUUID(),
    deviceName: 'iOS test device'
  };
  const child = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env,
      API_PORT: String(port),
      APP_ORIGIN: 'http://localhost:3000',
      NODE_ENV: 'test',
      EMAIL_VERIFICATION_REQUIRED: 'false',
      AUTH_RATE_LIMIT: '1000',
      ACCOUNT_REUSE_HMAC_KEY: 'a'.repeat(64),
      DATABASE_URL: process.env.DATABASE_URL
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk.toString(); });
  child.stderr.on('data', chunk => { logs += chunk.toString(); });

  async function waitForApi() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`API exited: ${child.exitCode}\n${logs}`);
      try {
        const response = await fetch(`${api}/api/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) return;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`API did not start\n${logs}`);
  }

  async function request(path, { method = 'GET', token, body, origin } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    if (origin) headers.Origin = origin;
    return fetch(`${api}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000)
    });
  }

  const activeTokens = [];
  try {
    await db.query(
      "INSERT INTO users (id, email, password_hash, status, email_verified_at) VALUES ($1, $2, $3, 'active', NOW())",
      [userId, email, passwordHash]
    );
    await db.query(
      "INSERT INTO profiles (user_id, display_name, gender, country, city) VALUES ($1, 'Mobile Auth Test', 'female', 'Georgia', 'Tbilisi')",
      [userId]
    );
    await waitForApi();

    const allowedPreflight = await fetch(`${api}/api/mobile/auth/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://localhost',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type'
      }
    });
    assert.equal(allowedPreflight.status, 204);
    assert.equal(allowedPreflight.headers.get('access-control-allow-origin'), 'https://localhost');
    assert.equal(allowedPreflight.headers.get('access-control-allow-credentials'), null,
      'mobile API must not enable credentialed cookie CORS');

    const deniedPreflight = await fetch(`${api}/api/mobile/auth/login`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://attacker.invalid', 'Access-Control-Request-Method': 'POST' }
    });
    assert.equal(deniedPreflight.status, 403);

    const blockedOrigin = await request('/api/mobile/auth/login', {
      method: 'POST',
      body: { email, password, ...deviceA },
      origin: 'https://attacker.invalid'
    });
    assert.equal(blockedOrigin.status, 403);

    const invalidPassword = await request('/api/mobile/auth/login', {
      method: 'POST',
      body: { email, password: 'incorrect password', ...deviceA }
    });
    assert.equal(invalidPassword.status, 401);

    const registrationEmail = `mobile-register-${randomUUID()}@example.invalid`;
    const registration = await request('/api/mobile/auth/register', {
      method: 'POST',
      body: {
        email: registrationEmail,
        password: 'Native Registration Test Password 2026!',
        displayName: 'Mobile Registration',
        birthDate: '1990-01-01',
        gender: 'female',
        country: 'Georgia',
        city: 'Tbilisi',
        relationshipIntent: 'family_without_marriage',
        familyFormat: 'cohabitation',
        hasChildren: false,
        wantsChildren: 'discuss',
        childrenLivingArrangement: 'not_applicable',
        ...deviceA
      }
    });
    assert.equal(registration.status, 201, logs);
    const registered = await registration.json();
    assert.equal(registered.user.email, registrationEmail);
    assert.match(registered.accessToken, /^vow_access_/);
    assert.match(registered.refreshToken, /^vow_refresh_/);
    assert.equal(registration.headers.get('set-cookie'), null,
      'native registration must not issue a browser cookie');
    const registeredMe = await request('/api/mobile/auth/me', { token: registered.accessToken });
    assert.equal(registeredMe.status, 200);
    await db.query('DELETE FROM users WHERE id = $1', [registered.user.id]);

    const loginA = await request('/api/mobile/auth/login', {
      method: 'POST',
      body: { email, password, ...deviceA }
    });
    assert.equal(loginA.status, 200, logs);
    assert.equal(loginA.headers.get('set-cookie'), null, 'native login must never issue a browser session cookie');
    const pairA = await loginA.json();
    assert.equal(pairA.user.id, userId);
    assert.match(pairA.accessToken, /^vow_access_/);
    assert.match(pairA.refreshToken, /^vow_refresh_/);
    assert.ok(pairA.accessTokenExpiresAt);
    assert.ok(pairA.refreshTokenExpiresAt);
    activeTokens.push(pairA.accessToken, pairA.refreshToken);

    const meA = await request('/api/mobile/auth/me', { token: pairA.accessToken });
    assert.equal(meA.status, 200);
    assert.equal((await meA.json()).user.id, userId);

    const mismatch = await request('/api/mobile/auth/refresh', {
      method: 'POST', token: pairA.refreshToken, body: { ...deviceB }
    });
    assert.equal(mismatch.status, 401, 'refresh must be bound to the registered installation');

    const loginB = await request('/api/mobile/auth/login', {
      method: 'POST', body: { email, password, ...deviceB }
    });
    assert.equal(loginB.status, 200, logs);
    const pairB = await loginB.json();
    activeTokens.push(pairB.accessToken, pairB.refreshToken);

    const rotateA = await request('/api/mobile/auth/refresh', {
      method: 'POST', token: pairA.refreshToken, body: { ...deviceA }
    });
    assert.equal(rotateA.status, 200, logs);
    const pairA2 = await rotateA.json();
    activeTokens.push(pairA2.accessToken, pairA2.refreshToken);
    assert.notEqual(pairA2.refreshToken, pairA.refreshToken);

    const oldAccess = await request('/api/mobile/auth/me', { token: pairA.accessToken });
    assert.equal(oldAccess.status, 401, 'refresh rotation must invalidate the previous access token');

    const replay = await request('/api/mobile/auth/refresh', {
      method: 'POST', token: pairA.refreshToken, body: { ...deviceA }
    });
    assert.equal(replay.status, 401);
    assert.equal((await replay.json()).error, 'refresh_token_reuse_detected');

    const revokedA = await request('/api/mobile/auth/me', { token: pairA2.accessToken });
    const revokedB = await request('/api/mobile/auth/me', { token: pairB.accessToken });
    assert.equal(revokedA.status, 401, 'refresh token replay must revoke the current device session');
    assert.equal(revokedB.status, 401, 'refresh token replay must revoke every session for the account');

    const loginAfterReplay = await request('/api/mobile/auth/login', {
      method: 'POST', body: { email, password, ...deviceA }
    });
    assert.equal(loginAfterReplay.status, 200, logs);
    const afterReplay = await loginAfterReplay.json();
    activeTokens.push(afterReplay.accessToken, afterReplay.refreshToken);

    const logout = await request('/api/mobile/auth/logout', {
      method: 'POST', token: afterReplay.accessToken, body: {}
    });
    assert.equal(logout.status, 204);
    const afterLogout = await request('/api/mobile/auth/me', { token: afterReplay.accessToken });
    assert.equal(afterLogout.status, 401);

    const loginForAll = await request('/api/mobile/auth/login', {
      method: 'POST', body: { email, password, ...deviceB }
    });
    assert.equal(loginForAll.status, 200, logs);
    const pairForAll = await loginForAll.json();
    activeTokens.push(pairForAll.accessToken, pairForAll.refreshToken);
    const logoutAll = await request('/api/mobile/auth/logout-all', {
      method: 'POST', token: pairForAll.accessToken, body: {}
    });
    assert.equal(logoutAll.status, 204);
    const afterLogoutAll = await request('/api/mobile/auth/me', { token: pairForAll.accessToken });
    assert.equal(afterLogoutAll.status, 401);

    const sessions = await db.query(
      "SELECT COUNT(*)::int AS active FROM mobile_sessions WHERE user_id = $1 AND revoked_at IS NULL",
      [userId]
    );
    assert.equal(sessions.rows[0].active, 0);

    const loginConcurrent = await request('/api/mobile/auth/login', {
      method: 'POST', body: { email, password, ...deviceA }
    });
    assert.equal(loginConcurrent.status, 200, logs);
    const concurrentPair = await loginConcurrent.json();
    activeTokens.push(concurrentPair.accessToken, concurrentPair.refreshToken);
    const concurrentResults = await Promise.all([
      request('/api/mobile/auth/refresh', {
        method: 'POST', token: concurrentPair.refreshToken, body: { ...deviceA }
      }),
      request('/api/mobile/auth/refresh', {
        method: 'POST', token: concurrentPair.refreshToken, body: { ...deviceA }
      })
    ]);
    assert.deepEqual(concurrentResults.map(response => response.status).sort(), [200, 401],
      'parallel refresh must never produce two successful rotations');
    const concurrentSuccess = concurrentResults.find(response => response.status === 200);
    const concurrentNewPair = await concurrentSuccess.json();
    activeTokens.push(concurrentNewPair.accessToken, concurrentNewPair.refreshToken);
    const concurrentRevoked = await request('/api/mobile/auth/me', { token: concurrentNewPair.accessToken });
    assert.equal(concurrentRevoked.status, 401,
      'the losing parallel refresh must trigger replay response and revoke the account sessions');
  } finally {
    await db.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
    child.kill('SIGTERM');
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      const timeout = setTimeout(resolve, 3000);
      child.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
    await db.end();
  }
});
