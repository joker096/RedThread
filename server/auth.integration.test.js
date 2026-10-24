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

    const partnerApplication = {
      category: 'photography',
      businessName: 'Test Studio',
      contactName: 'Test Contact',
      contactEmail: `partner-${randomUUID()}@example.test`,
      country: 'Georgia',
      city: 'Tbilisi',
      website: 'https://example.test',
      serviceDescription: 'Wedding and couple photography services for local clients.',
      priceFrom: '0.29',
      priceCurrency: 'GEL',
      serviceLanguages: 'Georgian, Russian',
      availabilityNote: 'By appointment'
    };
    const partnerApplicationWithoutOrigin = await request('/api/partner-applications', {
      method: 'POST',
      headers: { Origin: '' },
      body: JSON.stringify(partnerApplication)
    });
    assert.equal(partnerApplicationWithoutOrigin.status, 403, 'partner application mutations must reject requests without a trusted Origin before applying rate limits');

    const partnerInquiryWithoutOrigin = await request('/api/partner-service-inquiries', {
      method: 'POST',
      headers: { Origin: '' },
      body: JSON.stringify({
        applicationId: randomUUID(),
        matchId: randomUUID(),
        requestKey: randomUUID(),
        requestNote: 'Please send details about this service.',
        shareContact: true
      })
    });
    assert.equal(partnerInquiryWithoutOrigin.status, 403,
      'partner inquiry mutations must reject untrusted Origins before session or database processing');

    const insecurePartnerWebsite = await request('/api/partner-applications', {
      method: 'POST',
      body: JSON.stringify({ ...partnerApplication, website: 'http://example.test' })
    });
    assert.equal(insecurePartnerWebsite.status, 400, 'partner websites must use HTTPS');

    const invalidPrice = await request('/api/partner-applications', {
      method: 'POST',
      body: JSON.stringify({ ...partnerApplication, priceFrom: '-1' })
    });
    assert.equal(invalidPrice.status, 400, 'partner prices must be non-negative');
    const invalidCurrency = await request('/api/partner-applications', {
      method: 'POST',
      body: JSON.stringify({ ...partnerApplication, priceCurrency: 'BTC' })
    });
    assert.equal(invalidCurrency.status, 400, 'partner prices must use a supported currency');

    const partnerSubmission = await request('/api/partner-applications', {
      method: 'POST',
      body: JSON.stringify(partnerApplication)
    });
    assert.equal(partnerSubmission.status, 201);
    const submittedPartner = await partnerSubmission.json();
    assert.equal(submittedPartner.application.status, 'pending');
    assert.equal('contactEmail' in submittedPartner.application, false, 'public response must not echo contact details');

    const publicDirectory = await request('/api/partner-services?country=Georgia&category=photo');
    assert.equal(publicDirectory.status, 200, 'the public directory is readable without a session');
    const directoryPayload = await publicDirectory.json();
    assert.deepEqual(directoryPayload.providers, [], 'pending applications must not appear in the public directory');
    assert.equal(JSON.stringify(directoryPayload).includes(partnerApplication.contactEmail), false, 'directory responses must not expose contact email');
    assert.equal(JSON.stringify(directoryPayload).includes(partnerApplication.contactName), false, 'directory responses must not expose contact name');
    assert.equal(JSON.stringify(directoryPayload).includes(partnerApplication.serviceDescription), false, 'pending application details must remain private');

    // Exercise the public photo filter against an approved and published photography listing.
    const testPool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const promoted = await testPool.query(
        "UPDATE partner_service_applications SET status = 'approved', published_at = NOW() WHERE contact_email = $1",
        [partnerApplication.contactEmail]
      );
      assert.equal(promoted.rowCount, 1, 'the regression test must promote exactly its own submitted application');
      const publishedDirectoryResponse = await request('/api/partner-services?country=Georgia&category=photo');
      assert.equal(publishedDirectoryResponse.status, 200);
      const publishedDirectory = await publishedDirectoryResponse.json();
      assert.ok(publishedDirectory.providers.some(provider =>
        provider.category === 'photography' && provider.businessName === partnerApplication.businessName
      ), 'photo filter must include published photography providers');
      assert.equal(JSON.stringify(publishedDirectory).includes(partnerApplication.contactEmail), false,
        'published directory must not expose provider contact email');
      assert.equal(JSON.stringify(publishedDirectory).includes(partnerApplication.contactName), false,
        'published directory must not expose provider contact name');
    } finally {
      await testPool.query('DELETE FROM partner_service_applications WHERE contact_email = $1', [partnerApplication.contactEmail]);
      await testPool.end();
    }

    const invalidDirectoryFilter = await request('/api/partner-services?category=admin');
    assert.equal(invalidDirectoryFilter.status, 400, 'directory filters must reject unsupported categories');
    const repeatedDirectoryFilter = await request('/api/partner-services?category=legal&category=photo');
    assert.equal(repeatedDirectoryFilter.status, 400, 'directory filters must reject repeated parameters');

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

    const inquiryWithoutConsent = await request('/api/partner-service-inquiries', {
      method: 'POST',
      headers: { Cookie: firstCookie },
      body: JSON.stringify({
        applicationId: randomUUID(),
        matchId: randomUUID(),
        requestKey: randomUUID(),
        requestNote: 'Please send details about this service.',
        shareContact: false
      })
    });
    assert.equal(inquiryWithoutConsent.status, 400, 'a partner inquiry must require explicit contact-sharing consent');

    const inquiryWithInvalidDate = await request('/api/partner-service-inquiries', {
      method: 'POST',
      headers: { Cookie: firstCookie },
      body: JSON.stringify({
        applicationId: randomUUID(),
        matchId: randomUUID(),
        requestKey: randomUUID(),
        requestNote: 'Please send details about this service.',
        serviceDate: '2026-13-40',
        shareContact: true
      })
    });
    assert.equal(inquiryWithInvalidDate.status, 400, 'partner inquiry dates must be real ISO calendar dates');
    const billingStatus = await request('/api/billing/status', { headers: { Cookie: firstCookie } });
    assert.equal(billingStatus.status, 200);
    const trial = await billingStatus.json();
    assert.equal(trial.access, 'full');
    assert.equal(trial.trialActive, true);
    assert.equal(trial.paymentConfigured, false);

    const notificationList = await request('/api/notifications', { headers: { Cookie: firstCookie } });
    assert.equal(notificationList.status, 200);
    assert.deepEqual((await notificationList.json()).notifications, []);
    for (const adminPath of ['/api/admin/reports', '/api/admin/photos', '/api/admin/audit-log', '/api/admin/partner-applications']) {
      const forbidden = await request(adminPath, { headers: { Cookie: firstCookie } });
      assert.equal(forbidden.status, 403);
    }

    for (const publicationPath of ['/api/admin/partner-applications/'+randomUUID()+'/publish', '/api/admin/partner-applications/'+randomUUID()+'/unpublish']) {
      const forbiddenPublication = await request(publicationPath, { method: 'POST', headers: { Cookie: firstCookie }, body: JSON.stringify({}) });
      assert.equal(forbiddenPublication.status, 403, 'ordinary users must not publish or hide partner listings');
    }

    const forbiddenModerationAction = await request(`/api/admin/reports/${randomUUID()}/action`, {
      method: 'POST',
      headers: { Cookie: firstCookie },
      body: JSON.stringify({ action: 'suspend_user', confirmed: true, reason: 'authorization regression test' })
    });
    assert.equal(forbiddenModerationAction.status, 403, 'ordinary users must not perform moderator actions');

    const selfReport = await request('/api/reports', {
      method: 'POST',
      headers: { Cookie: firstCookie },
      body: JSON.stringify({
        reportedUserId: registered.user.id,
        category: 'spam',
        details: 'A user cannot report their own account'
      })
    });
    assert.equal(selfReport.status, 400, 'users must not submit reports against themselves');

    const invalidReportCategory = await request('/api/reports', {
      method: 'POST',
      headers: { Cookie: firstCookie },
      body: JSON.stringify({
        reportedUserId: randomUUID(),
        category: 'make_admin',
        details: 'Invalid category must be rejected before target lookup'
      })
    });
    assert.equal(invalidReportCategory.status, 400, 'unknown report categories must be rejected');
    const markNotificationsRead = await request('/api/notifications/read-all', {
      method: 'POST',
      headers: { Cookie: firstCookie }
    });
    assert.equal(markNotificationsRead.status, 204);

    const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/n1sAAAAASUVORK5CYII=', 'base64');
    const photoUpload = await request('/api/photos', {
      method: 'POST',
      headers: { Cookie: firstCookie, 'Content-Type': 'image/png' },
      body: tinyPng
    });
    assert.equal(photoUpload.status, 201);
    const uploadedPhoto = await photoUpload.json();
    assert.match(uploadedPhoto.photoUrl, /^\/api\/photos\/[a-f0-9-]{36}$/i);
    const photoRead = await request(uploadedPhoto.photoUrl, { headers: { Cookie: firstCookie } });
    assert.equal(photoRead.status, 200);
    assert.equal(photoRead.headers.get('content-type'), 'image/png');


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

    const underageRegistration = await request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: `underage-${randomUUID()}@example.test`,
        password,
        displayName: 'Несовершеннолетний',
        birthDate: '2010-01-01',
        gender: 'female',
        country: 'Грузия',
        city: 'Тбилиси',
        relationshipIntent: 'serious_relationship',
        familyFormat: 'open_to_both',
        hasChildren: false,
        wantsChildren: 'discuss',
        childrenLivingArrangement: 'not_applicable'
      })
    });
    assert.equal(underageRegistration.status, 400);
    assert.equal((await underageRegistration.json()).error, 'must_be_18_or_older_with_valid_birth_date');

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

    const loggedOutMatches = await request('/api/matches', { headers: { Cookie: firstCookie } });
    assert.equal(loggedOutMatches.status, 401, 'expired or logged-out sessions must not load server matches');

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

    const pendingPhotoReadByOtherAccount = await request(uploadedPhoto.photoUrl, { headers: { Cookie: maleCookie } });
    assert.equal(pendingPhotoReadByOtherAccount.status, 404, 'pending photos must not be visible to other accounts');
    const crossAccountPhotoAttach = await request('/api/profiles/me', {
      method: 'PATCH',
      headers: { Cookie: maleCookie },
      body: JSON.stringify({ photoUrls: [uploadedPhoto.photoUrl] })
    });
    assert.equal(crossAccountPhotoAttach.status, 400);
    const duplicatePhotoReferences = await request('/api/profiles/me', {
      method: 'PATCH',
      headers: { Cookie: secondCookie },
      body: JSON.stringify({ photoUrls: [uploadedPhoto.photoUrl, uploadedPhoto.photoUrl] })
    });
    assert.equal(duplicatePhotoReferences.status, 400, 'the same private photo cannot be attached more than once');

    const removePhoto = await request('/api/profiles/me', {
      method: 'PATCH',
      headers: { Cookie: secondCookie },
      body: JSON.stringify({ photoUrls: [] })
    });
    assert.equal(removePhoto.status, 200);
    const removedPhotoRead = await request(uploadedPhoto.photoUrl, { headers: { Cookie: secondCookie } });
    assert.equal(removedPhotoRead.status, 404);
    const assessmentAnswers = {
      relationshipGoal: 'marriage_soon',
      children: 'want_soon',
      financialModel: 'shared_equal',
      lifestyleExpectation: 'balanced',
      gifts: 'medium',
      household: 'equal',
      fidelity: 'strict',
      conflictStyle: 'talk_soon',
      honesty: 'essential',
      trustRepair: 'accountability_actions',
      conflictSafety: 'no_insults_control',
      debtTransparency: 'open_before_commitment',
      substanceLifestyle: 'occasional_social',
      relocation: 'depends_on_plan',
      caregiving: 'shared_care'
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

    const undoTargetPass = await request('/api/passes/' + registered.user.id, {
      method: 'POST',
      headers: { Cookie: maleCookie }
    });
    assert.equal(undoTargetPass.status, 204);
    const undoMostRecentPass = await request('/api/passes/undo', {
      method: 'POST',
      headers: { Cookie: maleCookie },
      body: JSON.stringify({ targetId: registered.user.id })
    });
    assert.equal(undoMostRecentPass.status, 200);
    assert.equal((await undoMostRecentPass.json()).profile.id, registered.user.id);
    const afterTargetedUndoSearch = await request('/api/profiles/search', { headers: { Cookie: maleCookie } });
    assert.equal((await afterTargetedUndoSearch.json()).profiles.some(profile => profile.id === registered.user.id), true);
    const undoNoPass = await request('/api/passes/undo', {
      method: 'POST',
      headers: { Cookie: maleCookie }
    });
    assert.equal(undoNoPass.status, 404);

    // A stale or manually crafted request must not like a profile that is still passed.
    const passAgain = await request(`/api/passes/${registered.user.id}`, {
      method: 'POST',
      headers: { Cookie: maleCookie },
      body: JSON.stringify({})
    });
    assert.equal(passAgain.status, 204);
    const likePassedProfile = await request(`/api/likes/${registered.user.id}`, {
      method: 'POST',
      headers: { Cookie: maleCookie },
      body: JSON.stringify({})
    });
    assert.equal(likePassedProfile.status, 404, 'a passed profile cannot be liked through a stale or direct API request');
    const undoPassAgain = await request('/api/passes/undo', {
      method: 'POST',
      headers: { Cookie: maleCookie },
      body: JSON.stringify({ targetId: registered.user.id })
    });
    assert.equal(undoPassAgain.status, 200);

    const passForReloadUndo = await request(`/api/passes/${registered.user.id}`, {
      method: 'POST',
      headers: { Cookie: maleCookie },
      body: JSON.stringify({})
    });
    assert.equal(passForReloadUndo.status, 204);
    const persistedPassUndo = await request('/api/discovery/undo', {
      method: 'POST',
      headers: { Cookie: maleCookie },
      body: JSON.stringify({})
    });
    assert.equal(persistedPassUndo.status, 200);
    assert.equal((await persistedPassUndo.json()).type, 'pass');

    const firstLike = await request(`/api/likes/${maleRegistered.user.id}`, {
      method: 'POST',
      headers: { Cookie: secondCookie }
    });
    assert.equal(firstLike.status, 201);
    assert.equal((await firstLike.json()).matched, false);

    const afterLikeSearch = await request('/api/profiles/search', { headers: { Cookie: secondCookie } });
    assert.equal((await afterLikeSearch.json()).profiles.some(profile => profile.id === maleRegistered.user.id), false,
      'profiles already liked by the current user must not be repeated in discovery');

    const undoLike = await request(`/api/likes/${maleRegistered.user.id}`, {
      method: 'DELETE',
      headers: { Cookie: secondCookie }
    });
    assert.equal(undoLike.status, 204);
    const undoLikeAgain = await request(`/api/likes/${maleRegistered.user.id}`, {
      method: 'DELETE',
      headers: { Cookie: secondCookie }
    });
    assert.equal(undoLikeAgain.status, 404, 'undo must report when there is no like to remove');
    const afterUndoLikeSearch = await request('/api/profiles/search', { headers: { Cookie: secondCookie } });
    assert.equal((await afterUndoLikeSearch.json()).profiles.some(profile => profile.id === maleRegistered.user.id), true,
      'undoing a like makes the profile eligible for discovery again');

    const firstLikeAgain = await request(`/api/likes/${maleRegistered.user.id}`, {
      method: 'POST',
      headers: { Cookie: secondCookie }
    });
    assert.equal(firstLikeAgain.status, 201);
    assert.equal((await firstLikeAgain.json()).matched, false);

    const persistedLikeUndo = await request('/api/discovery/undo', {
      method: 'POST',
      headers: { Cookie: secondCookie },
      body: JSON.stringify({})
    });
    assert.equal(persistedLikeUndo.status, 200);
    const persistedLikeUndoPayload = await persistedLikeUndo.json();
    assert.equal(persistedLikeUndoPayload.type, 'like');
    assert.equal(persistedLikeUndoPayload.profile.id, maleRegistered.user.id);

    const firstLikeThird = await request(`/api/likes/${maleRegistered.user.id}`, {
      method: 'POST',
      headers: { Cookie: secondCookie },
      body: JSON.stringify({})
    });
    assert.equal(firstLikeThird.status, 201);

    const reciprocalLike = await request(`/api/likes/${registered.user.id}`, {
      method: 'POST',
      headers: { Cookie: maleCookie }
    });
    assert.equal(reciprocalLike.status, 201);
    const matchPayload = await reciprocalLike.json();
    assert.equal(matchPayload.matched, true);
    assert.ok(matchPayload.match.id);

    // Repeating the reciprocal like must return the existing match, not create a duplicate.
    const repeatedReciprocalLike = await request(`/api/likes/${registered.user.id}`, {
      method: 'POST',
      headers: { Cookie: maleCookie }
    });
    assert.equal(repeatedReciprocalLike.status, 201);
    const repeatedMatchPayload = await repeatedReciprocalLike.json();
    assert.equal(repeatedMatchPayload.matched, true);
    assert.equal(repeatedMatchPayload.match.id, matchPayload.match.id,
      'repeated reciprocal likes must preserve the original match id');

    const cannotUndoMatchedLike = await request(`/api/likes/${maleRegistered.user.id}`, {
      method: 'DELETE',
      headers: { Cookie: secondCookie }
    });
    assert.equal(cannotUndoMatchedLike.status, 409, 'an active mutual match must not be silently broken by undo');
    const cannotUndoMatchedLikeAfterReload = await request('/api/discovery/undo', {
      method: 'POST',
      headers: { Cookie: secondCookie },
      body: JSON.stringify({})
    });
    assert.equal(cannotUndoMatchedLikeAfterReload.status, 409, 'the unified undo endpoint must also preserve active matches');

    const cannotPassMatchedProfile = await request(`/api/passes/${maleRegistered.user.id}`, {
      method: 'POST',
      headers: { Cookie: secondCookie },
      body: JSON.stringify({})
    });
    assert.equal(cannotPassMatchedProfile.status, 404, 'matched profiles cannot be passed from a stale discovery card');

    const femaleMatches = await request('/api/matches', { headers: { Cookie: secondCookie } });
    assert.equal(femaleMatches.status, 200);
    assert.equal((await femaleMatches.json()).matches.some(match => match.id === matchPayload.match.id), true);

    const outsiderRegistration = await request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: `outsider-${randomUUID()}@example.test`,
        password,
        displayName: 'Посторонний пользователь',
        birthDate: '1992-03-15',
        gender: 'female',
        country: 'Грузия',
        city: 'Батуми',
        relationshipIntent: 'serious_relationship',
        familyFormat: 'open_to_both',
        hasChildren: false,
        wantsChildren: 'discuss',
        childrenLivingArrangement: 'not_applicable'
      })
    });
    assert.equal(outsiderRegistration.status, 201);
    const outsiderCookie = outsiderRegistration.headers.get('set-cookie')?.split(';')[0];
    assert.ok(outsiderCookie?.startsWith('nit_session='));

    const outsiderReadMessages = await request(`/api/matches/${matchPayload.match.id}/messages`, {
      headers: { Cookie: outsiderCookie }
    });
    assert.equal(outsiderReadMessages.status, 404, 'a non-participant must not read another pair\'s conversation');

    const outsiderSendMessage = await request(`/api/matches/${matchPayload.match.id}/messages`, {
      method: 'POST',
      headers: { Cookie: outsiderCookie },
      body: JSON.stringify({ text: 'Попытка написать в чужой чат' })
    });
    assert.equal(outsiderSendMessage.status, 404, 'a non-participant must not send messages to another pair\'s conversation');

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
        occupation: 'Инженер',
        education: 'Высшее',
        languages: ['Русский', 'Английский'],
        hasChildren: true,
        familyFormat: 'cohabitation',
        wantsChildren: 'no',
        childrenLivingArrangement: 'with_me'
      })
    });
    assert.equal(profileUpdate.status, 200);
    const updatedProfile = (await profileUpdate.json()).profile;
    assert.equal(updatedProfile.occupation, 'Инженер');
    assert.deepEqual(updatedProfile.languages, ['Русский', 'Английский']);
    assert.equal(updatedProfile.hasChildren, true);
    assert.equal(updatedProfile.familyFormat, 'cohabitation');
    assert.equal(updatedProfile.wantsChildren, 'no');
    assert.ok(updatedProfile.childrenDisclosureConfirmedAt);

    const invalidPhotoUrl = await request('/api/profiles/me', {
      method: 'PATCH',
      headers: { Cookie: maleCookie },
      body: JSON.stringify({ photoUrls: ['https://images.example.test/profile.jpg'] })
    });
    assert.equal(invalidPhotoUrl.status, 400);

    const familySearch = await request('/api/profiles/search?hasChildren=true&familyFormat=cohabitation&intent=family_without_marriage', {
      headers: { Cookie: secondCookie }
    });
    assert.equal(familySearch.status, 200);
    assert.equal((await familySearch.json()).profiles.some(profile => profile.id === maleRegistered.user.id), false);

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

    // Blocking must work in both directions: the blocked account cannot create a new like either.
    const reverseAfterBlockLike = await request(`/api/likes/${registered.user.id}`, {
      method: 'POST',
      headers: { Cookie: maleCookie },
      body: JSON.stringify({})
    });
    assert.equal(reverseAfterBlockLike.status, 404,
      'a user must not like an account that has blocked them');

    const blockedMatchMessages = await request(`/api/matches/${matchPayload.match.id}/messages`, {
      headers: { Cookie: secondCookie }
    });
    assert.equal(blockedMatchMessages.status, 404);

    const blockedMatchSend = await request(`/api/matches/${matchPayload.match.id}/messages`, {
      method: 'POST',
      headers: { Cookie: maleCookie },
      body: JSON.stringify({ text: 'This message must not be delivered after a block.' })
    });
    assert.equal(blockedMatchSend.status, 404,
      'neither participant may send messages after the match is blocked');

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

    const missingOrigin = await fetch(api + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    assert.equal(missingOrigin.status, 403);

    const deleteWithoutConfirmation = await request('/api/account', {
      method: 'DELETE',
      headers: { Cookie: secondCookie },
      body: JSON.stringify({})
    });
    assert.equal(deleteWithoutConfirmation.status, 400,
      'account deletion must require explicit password confirmation');

    const deleteWrongPassword = await request('/api/account', {
      method: 'DELETE',
      headers: { Cookie: secondCookie },
      body: JSON.stringify({ password: 'incorrect password' })
    });
    assert.equal(deleteWrongPassword.status, 401);

    const deleteAccount = await request('/api/account', {
      method: 'DELETE',
      headers: { Cookie: secondCookie },
      body: JSON.stringify({ password })
    });
    assert.equal(deleteAccount.status, 204);

    const deletedAccountMe = await request('/api/auth/me', { headers: { Cookie: secondCookie } });
    assert.equal(deletedAccountMe.status, 401);

    const deletedAccountMatches = await request('/api/matches', { headers: { Cookie: secondCookie } });
    assert.equal(deletedAccountMatches.status, 401,
      'a deleted account must not retain access to server matches');

    const deletedAccountMessages = await request(`/api/matches/${matchPayload.match.id}/messages`, {
      headers: { Cookie: secondCookie }
    });
    assert.equal(deletedAccountMessages.status, 401,
      'a deleted account must not retain access to previously authorized conversations');

  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  }
});
