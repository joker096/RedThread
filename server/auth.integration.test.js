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
        relationshipIntent: 'family_without_marriage',
        familyFormat: 'cohabitation',
        hasChildren: false,
        wantsChildren: 'yes',
        childrenLivingArrangement: 'not_applicable'
      })
    });
    assert.equal(registration.status, 201);
    const registered = await registration.json();
    assert.equal(registered.user.email, email);
    assert.equal(registered.user.country, 'Грузия');
    assert.equal('password_hash' in registered.user, false);
    const firstCookie = registration.headers.get('set-cookie')?.split(';')[0];
    assert.ok(firstCookie?.startsWith('nit_session='));
    const billingStatus = await request('/api/billing/status', { headers: { Cookie: firstCookie } });
    assert.equal(billingStatus.status, 200);
    const trial = await billingStatus.json();
    assert.equal(trial.access, 'full');
    assert.equal(trial.trialActive, true);
    assert.equal(trial.paymentConfigured, false);

    const missingChildrenDisclosure = await request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: `missing-children-${randomUUID()}@example.test`,
        password,
        displayName: 'Без ответа',
        birthDate: '1990-01-01',
        gender: 'female',
        country: 'Грузия',
        city: 'Тбилиси'
      })
    });
    assert.equal(missingChildrenDisclosure.status, 400);
    assert.equal((await missingChildrenDisclosure.json()).error, 'children_status_required');

    const duplicate = await request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password,
        displayName: 'Другая анкета',
        birthDate: '1990-01-01',
        gender: 'female',
        country: 'Грузия',
        city: 'Тбилиси',
        hasChildren: false
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
        relationshipIntent: 'family_without_marriage',
        familyFormat: 'cohabitation',
        hasChildren: false,
        wantsChildren: 'yes',
        childrenLivingArrangement: 'not_applicable'
      })
    });
    assert.equal(maleRegistration.status, 201);
    const maleRegistered = await maleRegistration.json();
    const maleCookie = maleRegistration.headers.get('set-cookie')?.split(';')[0];
    assert.ok(maleCookie?.startsWith('nit_session='));

    const assessmentAnswers = {
      relationshipGoal: 'marriage_soon',
      children: 'want_soon',
      financialModel: 'shared_equal',
      lifestyleExpectation: 'balanced',
      gifts: 'medium',
      household: 'equal',
      fidelity: 'strict',
      conflictStyle: 'talk_soon',
      honesty: 'essential'
    };
    const incompleteAssessment = await request('/api/assessment', {
      method: 'PUT',
      headers: { Cookie: secondCookie },
      body: JSON.stringify({ answers: { financialModel: 'provider_full' } })
    });
    assert.equal(incompleteAssessment.status, 400);

    const savedFemaleAssessment = await request('/api/assessment', {
      method: 'PUT',
      headers: { Cookie: secondCookie },
      body: JSON.stringify({ answers: assessmentAnswers })
    });
    assert.equal(savedFemaleAssessment.status, 200);
    const savedMaleAssessment = await request('/api/assessment', {
      method: 'PUT',
      headers: { Cookie: maleCookie },
      body: JSON.stringify({ answers: assessmentAnswers })
    });
    assert.equal(savedMaleAssessment.status, 200);

    const assessmentRead = await request('/api/assessment', { headers: { Cookie: secondCookie } });
    assert.equal(assessmentRead.status, 200);
    assert.equal((await assessmentRead.json()).assessment.answers.financialModel, 'shared_equal');

    const search = await request('/api/profiles/search?minAge=36&maxAge=36&minFinancialAlignment=100&country=' + encodeURIComponent('грузия') + '&city=' + encodeURIComponent('тбилиси'), {
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

    const firstLike = await request(`/api/likes/${maleRegistered.user.id}`, {
      method: 'POST',
      headers: { Cookie: secondCookie }
    });
    assert.equal(firstLike.status, 201);
    assert.equal((await firstLike.json()).matched, false);

    const reciprocalLike = await request(`/api/likes/${registered.user.id}`, {
      method: 'POST',
      headers: { Cookie: maleCookie }
    });
    assert.equal(reciprocalLike.status, 201);
    const matchPayload = await reciprocalLike.json();
    assert.equal(matchPayload.matched, true);
    assert.ok(matchPayload.match.id);

    const femaleMatches = await request('/api/matches', { headers: { Cookie: secondCookie } });
    assert.equal(femaleMatches.status, 200);
    assert.equal((await femaleMatches.json()).matches.some(match => match.id === matchPayload.match.id), true);

    const sendMessage = await request(`/api/matches/${matchPayload.match.id}/messages`, {
      method: 'POST',
      headers: { Cookie: maleCookie },
      body: JSON.stringify({ text: 'Здравствуйте! Рад нашему совпадению.' })
    });
    assert.equal(sendMessage.status, 201);
    const sentMessage = (await sendMessage.json()).message;
    assert.equal(sentMessage.text, 'Здравствуйте! Рад нашему совпадению.');

    const readMessages = await request(`/api/matches/${matchPayload.match.id}/messages`, {
      headers: { Cookie: secondCookie }
    });
    assert.equal(readMessages.status, 200);
    assert.equal((await readMessages.json()).messages.some(message => message.id === sentMessage.id), true);

    const noSessionMessages = await request(`/api/matches/${matchPayload.match.id}/messages`);
    assert.equal(noSessionMessages.status, 401);

    const report = await request('/api/reports', {
      method: 'POST',
      headers: { Cookie: secondCookie },
      body: JSON.stringify({
        reportedUserId: maleRegistered.user.id,
        category: 'other',
        details: 'Тестовая жалоба из интеграционного теста'
      })
    });
    assert.equal(report.status, 201);

    const profileUpdate = await request('/api/profiles/me', {
      method: 'PATCH',
      headers: { Cookie: maleCookie },
      body: JSON.stringify({
        bio: 'Ищу серьёзные отношения',
        photoUrls: ['https://images.example.test/profile.jpg'],
        occupation: 'Инженер',
        education: 'Высшее',
        languages: ['Русский', 'Английский']
      })
    });
    assert.equal(profileUpdate.status, 200);
    const updatedProfile = (await profileUpdate.json()).profile;
    assert.deepEqual(updatedProfile.photoUrls, ['https://images.example.test/profile.jpg']);
    assert.equal(updatedProfile.occupation, 'Инженер');
    assert.deepEqual(updatedProfile.languages, ['Русский', 'Английский']);

    const invalidPhotoUrl = await request('/api/profiles/me', {
      method: 'PATCH',
      headers: { Cookie: maleCookie },
      body: JSON.stringify({ photoUrls: ['http://insecure.example/profile.jpg'] })
    });
    assert.equal(invalidPhotoUrl.status, 400);

    const block = await request(`/api/blocks/${maleRegistered.user.id}`, {
      method: 'POST',
      headers: { Cookie: secondCookie },
      body: JSON.stringify({})
    });
    assert.equal(block.status, 204);

    const blockedList = await request('/api/blocks', { headers: { Cookie: secondCookie } });
    assert.equal(blockedList.status, 200);
    assert.equal((await blockedList.json()).blocks.some(item => item.id === maleRegistered.user.id), true);

    const afterBlockSearch = await request('/api/profiles/search', { headers: { Cookie: secondCookie } });
    assert.equal((await afterBlockSearch.json()).profiles.some(profile => profile.id === maleRegistered.user.id), false);

    const afterBlockLike = await request(`/api/likes/${maleRegistered.user.id}`, {
      method: 'POST',
      headers: { Cookie: secondCookie },
      body: JSON.stringify({})
    });
    assert.equal(afterBlockLike.status, 404);

    const blockedMatchMessages = await request(`/api/matches/${matchPayload.match.id}/messages`, {
      headers: { Cookie: secondCookie }
    });
    assert.equal(blockedMatchMessages.status, 404);

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
