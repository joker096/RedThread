import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

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

test('auth API supports registration, session lookup, logout and login', {
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
      NODE_ENV: 'test'
    },
    stdio: 'ignore'
  });

  async function request(path, options = {}) {
    return fetch(`${api}${path}`, {
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        Origin: origin,
        ...(options.headers || {})
      }
    });
  }

  try {
    let healthy = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`API process exited with code ${child.exitCode}`);
      try {
        const response = await fetch(`${api}/api/health`);
        if (response.ok) {
          healthy = true;
          break;
        }
      } catch {
        // The process may need a moment to bind its port.
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(healthy, true, 'API should start and answer the health check');

    const email = `test-${randomUUID()}@example.test`;
    const password = 'Test Password 2026! Secure';
    const registration = await request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password,
        displayName: 'Тестовая анкета',
        birthDate: '1990-01-01',
        gender: 'female',
        country: 'Грузия',
        city: 'Тбилиси',
        relationshipIntent: 'marriage_family'
      })
    });
    assert.equal(registration.status, 201);
    const registered = await registration.json();
    assert.equal(registered.user.email, email);
    assert.equal(registered.user.country, 'Грузия');
    assert.equal('password_hash' in registered.user, false);
    const firstCookie = registration.headers.get('set-cookie')?.split(';')[0];
    assert.ok(firstCookie?.startsWith('nit_session='));

    const duplicate = await request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password,
        displayName: 'Другая анкета',
        birthDate: '1990-01-01',
        gender: 'female',
        country: 'Грузия',
        city: 'Тбилиси'
      })
    });
    assert.equal(duplicate.status, 409);

    const me = await request('/api/auth/me', { headers: { Cookie: firstCookie } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.email, email);

    const logout = await request('/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: firstCookie }
    });
    assert.equal(logout.status, 204);

    const loggedOutMe = await request('/api/auth/me', { headers: { Cookie: firstCookie } });
    assert.equal(loggedOutMe.status, 401);

    const login = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    assert.equal(login.status, 200);
    const secondCookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(secondCookie?.startsWith('nit_session='));

    const maleEmail = `test-${randomUUID()}@example.test`;
    const maleRegistration = await request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: maleEmail,
        password,
        displayName: 'Тестовый профиль',
        birthDate: '1990-05-10',
        gender: 'male',
        country: 'Грузия',
        city: 'Тбилиси',
        relationshipIntent: 'marriage_family'
      })
    });
    assert.equal(maleRegistration.status, 201);

    const search = await request('/api/profiles/search?country=' + encodeURIComponent('грузия') + '&city=' + encodeURIComponent('тбилиси'), {
      headers: { Cookie: secondCookie }
    });
    assert.equal(search.status, 200);
    const searchResult = await search.json();
    assert.equal(searchResult.profiles.some(profile => profile.id === registered.user.id), false);
    assert.equal(searchResult.profiles.some(profile => profile.displayName === 'Тестовый профиль' && profile.gender === 'male'), true);

    const wrongLocation = await request('/api/profiles/search?country=' + encodeURIComponent('Россия'), {
      headers: { Cookie: secondCookie }
    });
    assert.equal(wrongLocation.status, 200);
    assert.equal((await wrongLocation.json()).profiles.length, 0);

    const unauthenticatedSearch = await request('/api/profiles/search');
    assert.equal(unauthenticatedSearch.status, 401);

    const wrongPassword = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'incorrect password' })
    });
    assert.equal(wrongPassword.status, 401);

    const rejectedOrigin = await fetch(`${api}/api/auth/login`, {
      method: 'POST',
      headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    assert.equal(rejectedOrigin.status, 403);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  }
});
