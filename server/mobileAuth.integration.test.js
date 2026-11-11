import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createSessionToken, hashPassword, hashSessionToken } from './security.js';
import { hashMobileToken } from './mobileTokens.js';

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
  let registrationUserId = null;
  const pendingUserId = randomUUID();
  const pendingEmail = `mobile-pending-${pendingUserId}@example.invalid`;
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

    const iosPreflight = await fetch(`${api}/api/mobile/auth/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'capacitor://localhost',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type'
      }
    });
    assert.equal(iosPreflight.status, 204);
    assert.equal(iosPreflight.headers.get('access-control-allow-origin'), 'capacitor://localhost',
      'iOS Capacitor custom origin must be preserved exactly');

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
    registrationUserId = registered.user.id;
    assert.match(registered.accessToken, /^vow_access_/);
    assert.match(registered.refreshToken, /^vow_refresh_/);
    assert.equal(registration.headers.get('set-cookie'), null,
      'native registration must not issue a browser cookie');
    const registeredMe = await request('/api/mobile/auth/me', { token: registered.accessToken });
    assert.equal(registeredMe.status, 200);
    await db.query('DELETE FROM users WHERE id = $1', [registrationUserId]);
    registrationUserId = null;

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

    await db.query(
      "INSERT INTO users (id, email, password_hash, status) VALUES ($1, $2, $3, 'pending')",
      [pendingUserId, pendingEmail, passwordHash]
    );
    await db.query(
      "INSERT INTO profiles (user_id, display_name, gender, country, city) VALUES ($1, 'Pending Mobile User', 'male', 'Georgia', 'Tbilisi')",
      [pendingUserId]
    );
    const verificationToken = createSessionToken();
    await db.query(
      "INSERT INTO account_action_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1, 'email_verification', $2, NOW() + INTERVAL '5 minutes')",
      [pendingUserId, hashSessionToken(verificationToken)]
    );
    const pendingLogin = await request('/api/mobile/auth/login', {
      method: 'POST', body: { email: pendingEmail, password, ...deviceB }
    });
    assert.equal(pendingLogin.status, 403, 'pending email accounts cannot create mobile sessions');
    const verified = await request('/api/mobile/auth/verify-email', {
      method: 'POST', body: { token: verificationToken }
    });
    assert.equal(verified.status, 200);
    assert.equal((await verified.json()).verified, true);
    const verifiedLogin = await request('/api/mobile/auth/login', {
      method: 'POST', body: { email: pendingEmail, password, ...deviceB }
    });
    assert.equal(verifiedLogin.status, 200, logs);
    const verifiedPair = await verifiedLogin.json();
    activeTokens.push(verifiedPair.accessToken, verifiedPair.refreshToken);
    await db.query('DELETE FROM users WHERE id = $1', [pendingUserId]);

    const meA = await request('/api/mobile/auth/me', { token: pairA.accessToken });
    assert.equal(meA.status, 200);
    assert.equal((await meA.json()).user.id, userId);

    const notifications = await request('/api/notifications', { token: pairA.accessToken });
    assert.equal(notifications.status, 200,
      'native access tokens must authenticate shared protected API routes');
    const nativeMutation = await request('/api/notifications/read-all', {
      method: 'POST',
      token: pairA.accessToken,
      body: {},
      origin: 'https://localhost'
    });
    assert.equal(nativeMutation.status, 204, logs);
    assert.equal(nativeMutation.headers.get('access-control-allow-origin'), 'https://localhost');
    const iosNativeMutation = await request('/api/notifications/read-all', {
      method: 'POST',
      token: pairA.accessToken,
      body: {},
      origin: 'capacitor://localhost'
    });
    assert.equal(iosNativeMutation.status, 204, logs);
    assert.equal(iosNativeMutation.headers.get('access-control-allow-origin'), 'capacitor://localhost');

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
    assert.equal(pairA2.user.id, userId,
      'refresh must return the account id, not the internal mobile session id');
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

    const loginForReset = await request('/api/mobile/auth/login', {
      method: 'POST', body: { email, password, ...deviceA }
    });
    assert.equal(loginForReset.status, 200, logs);
    const resetPair = await loginForReset.json();
    activeTokens.push(resetPair.accessToken, resetPair.refreshToken);
    const resetToken = createSessionToken();
    await db.query(
      "INSERT INTO account_action_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1, 'password_reset', $2, NOW() + INTERVAL '5 minutes')",
      [userId, hashSessionToken(resetToken)]
    );
    const reset = await request('/api/mobile/auth/password-reset/complete', {
      method: 'POST',
      body: { token: resetToken, password: 'New Native Password 2026! Secure' }
    });
    assert.equal(reset.status, 200, logs);
    const revokedByReset = await request('/api/mobile/auth/me', { token: resetPair.accessToken });
    assert.equal(revokedByReset.status, 401, 'password reset must revoke all mobile sessions');
    const oldPasswordLogin = await request('/api/mobile/auth/login', {
      method: 'POST', body: { email, password, ...deviceA }
    });
    assert.equal(oldPasswordLogin.status, 401);
    const newPasswordLogin = await request('/api/mobile/auth/login', {
      method: 'POST', body: { email, password: 'New Native Password 2026! Secure', ...deviceA }
    });
    assert.equal(newPasswordLogin.status, 200, logs);
    const newPasswordPair = await newPasswordLogin.json();
    activeTokens.push(newPasswordPair.accessToken, newPasswordPair.refreshToken);
    const sameDeviceLogin = await request('/api/mobile/auth/login', {
      method: 'POST',
      body: { email, password: 'New Native Password 2026! Secure', ...deviceA }
    });
    assert.equal(sameDeviceLogin.status, 200, logs);
    const sameDevicePair = await sameDeviceLogin.json();
    activeTokens.push(sameDevicePair.accessToken, sameDevicePair.refreshToken);
    const replacedDeviceToken = await request('/api/mobile/auth/me', { token: newPasswordPair.accessToken });
    assert.equal(replacedDeviceToken.status, 401,
      'a new login on the same installation must replace its previous active session');
    const activeDeviceSessions = await db.query(
      'SELECT COUNT(*)::int AS count FROM mobile_sessions WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL',
      [userId, deviceA.deviceId]
    );
    assert.equal(activeDeviceSessions.rows[0].count, 1);

    const wrongRefreshCredential = await request('/api/mobile/auth/refresh', {
      method: 'POST', token: sameDevicePair.accessToken, body: { ...deviceA }
    });
    assert.equal(wrongRefreshCredential.status, 400,
      'an access token must never be accepted as a refresh credential');

    const missingOriginMutation = await request('/api/notifications/read-all', {
      method: 'POST', body: {}
    });
    assert.equal(missingOriginMutation.status, 403,
      'an origin-less browser mutation without a native bearer token must remain rejected');

    const untrustedOriginMutation = await request('/api/notifications/read-all', {
      method: 'POST', token: sameDevicePair.accessToken, body: {}, origin: 'https://attacker.invalid'
    });
    assert.equal(untrustedOriginMutation.status, 403,
      'a valid native token must not override an untrusted browser Origin');

    const originlessNativeMutation = await request('/api/notifications/read-all', {
      method: 'POST', token: sameDevicePair.accessToken, body: {}
    });
    assert.equal(originlessNativeMutation.status, 204,
      'native HTTP clients without a browser Origin may use a valid bearer token');

    const expiryLogin = await request('/api/mobile/auth/login', {
      method: 'POST', body: { email, password: 'New Native Password 2026! Secure', ...deviceB }
    });
    assert.equal(expiryLogin.status, 200, logs);
    const expiryPair = await expiryLogin.json();
    activeTokens.push(expiryPair.accessToken, expiryPair.refreshToken);
    await db.query(
      "UPDATE mobile_sessions SET access_expires_at = NOW() - INTERVAL '1 second' WHERE access_token_hash = $1",
      [hashMobileToken(expiryPair.accessToken, 'access')]
    );
    const expiredAccess = await request('/api/mobile/auth/me', { token: expiryPair.accessToken });
    assert.equal(expiredAccess.status, 401, 'expired access tokens must be rejected');

    const deviceC = { ...deviceB, deviceId: randomUUID(), deviceName: 'iOS expiry test device' };
    const refreshExpiryLogin = await request('/api/mobile/auth/login', {
      method: 'POST', body: {
        email, password: 'New Native Password 2026! Secure', ...deviceC
      }
    });
    assert.equal(refreshExpiryLogin.status, 200, logs);
    const refreshExpiryPair = await refreshExpiryLogin.json();
    activeTokens.push(refreshExpiryPair.accessToken, refreshExpiryPair.refreshToken);
    await db.query(
      "UPDATE mobile_sessions SET access_expires_at = NOW() - INTERVAL '2 seconds', refresh_expires_at = NOW() - INTERVAL '1 second' WHERE refresh_token_hash = $1",
      [hashMobileToken(refreshExpiryPair.refreshToken, 'refresh')]
    );
    const expiredRefresh = await request('/api/mobile/auth/refresh', {
      method: 'POST', token: refreshExpiryPair.refreshToken, body: deviceC
    });
    assert.equal(expiredRefresh.status, 401, 'expired refresh tokens must be rejected');

    const deviceD = { ...deviceB, deviceId: randomUUID(), deviceName: 'Suspension test device' };
    const suspensionLogin = await request('/api/mobile/auth/login', {
      method: 'POST', body: {
        email, password: 'New Native Password 2026! Secure', ...deviceD
      }
    });
    assert.equal(suspensionLogin.status, 200, logs);
    const suspensionPair = await suspensionLogin.json();
    activeTokens.push(suspensionPair.accessToken, suspensionPair.refreshToken);
    await db.query("UPDATE users SET status = 'suspended' WHERE id = $1", [userId]);
    const suspendedAccess = await request('/api/mobile/auth/me', { token: suspensionPair.accessToken });
    assert.equal(suspendedAccess.status, 401, 'suspended accounts cannot keep using mobile access tokens');
    const suspendedRefresh = await request('/api/mobile/auth/refresh', {
      method: 'POST', token: suspensionPair.refreshToken, body: deviceD
    });
    assert.equal(suspendedRefresh.status, 401);
    assert.equal((await suspendedRefresh.json()).error, 'account_unavailable');
    const suspensionState = await db.query(
      "SELECT revoked_reason FROM mobile_sessions WHERE user_id = $1 AND device_id = $2",
      [userId, deviceD.deviceId]
    );
    assert.equal(suspensionState.rows[0]?.revoked_reason, 'account_unavailable',
      'refresh after account suspension must persist a security revocation reason');
  } finally {
    if (registrationUserId) await db.query('DELETE FROM users WHERE id = $1', [registrationUserId]).catch(() => {});
    await db.query('DELETE FROM users WHERE id = $1', [pendingUserId]).catch(() => {});
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

test('mobile account deletion validates the authenticated mobile session and revokes it', {
  skip: !process.env.DATABASE_URL,
  timeout: 60_000
}, async () => {
  const port = await findFreePort();
  const api = `http://127.0.0.1:${port}`;
  const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  const userId = randomUUID();
  const email = `mobile-delete-${userId}@example.invalid`;
  const password = 'Mobile Account Deletion Test Password 2026!';
  const passwordHash = await hashPassword(password);
  const device = {
    platform: 'android',
    deviceId: randomUUID(),
    deviceName: 'Account deletion test device'
  };
  const child = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env,
      API_PORT: String(port),
      APP_ORIGIN: 'http://localhost:3000',
      NODE_ENV: 'test',
      EMAIL_VERIFICATION_REQUIRED: 'false',
      AUTH_RATE_LIMIT: '1000',
      ACCOUNT_REUSE_HMAC_KEY: 'c'.repeat(64),
      DATABASE_URL: process.env.DATABASE_URL
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk.toString(); });
  child.stderr.on('data', chunk => { logs += chunk.toString(); });

  try {
    await db.query(
      "INSERT INTO users (id, email, password_hash, status, email_verified_at) VALUES ($1, $2, $3, 'active', NOW())",
      [userId, email, passwordHash]
    );
    await db.query(
      "INSERT INTO profiles (user_id, display_name, gender, country, city) VALUES ($1, 'Mobile Delete Test', 'female', 'Georgia', 'Tbilisi')",
      [userId]
    );

    let healthy = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`API exited: ${child.exitCode}\n${logs}`);
      try {
        const response = await fetch(`${api}/api/health`, { signal: AbortSignal.timeout(1_000) });
        if (response.ok) { healthy = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(healthy, true, `API should start before account deletion test\n${logs}`);

    const login = await fetch(`${api}/api/mobile/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, ...device }),
      signal: AbortSignal.timeout(10_000)
    });
    assert.equal(login.status, 200, logs);
    const session = await login.json();
    assert.match(session.accessToken, /^vow_access_/);

    const deletion = await fetch(`${api}/api/account`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(15_000)
    });
    assert.equal(deletion.status, 204, `mobile session should authorize account deletion\n${await deletion.text()}\n${logs}`);

    const deleted = await db.query(
      "SELECT status, password_hash, email FROM users WHERE id = $1",
      [userId]
    );
    assert.equal(deleted.rows[0]?.status, 'deleted');
    assert.equal(deleted.rows[0]?.password_hash, null);
    assert.equal(deleted.rows[0]?.email, `deleted+${userId}@deleted.invalid`);

    const revoked = await db.query(
      "SELECT revoked_at, revoked_reason FROM mobile_sessions WHERE user_id = $1",
      [userId]
    );
    assert.ok(revoked.rowCount > 0);
    assert.ok(revoked.rows.every(row => row.revoked_at));
    assert.ok(revoked.rows.every(row => row.revoked_reason === 'account_unavailable'));
  } finally {
    await db.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
    child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 5_000))
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await db.end();
  }
});
