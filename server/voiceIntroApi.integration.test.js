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
      USER_DATA_EXPORT_RATE_LIMIT: '100',
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
    if (userId) {
      await db.query("UPDATE users SET status = 'deleted' WHERE id = $1", [userId]).catch(() => {});
      await db.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
    }
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


test('voice intro HTTP API covers encrypted upload, moderator review, owner playback and withdrawal purge', {
  skip: !process.env.DATABASE_URL,
  timeout: 90_000
}, async () => {
  const { mkdtemp, readFile, writeFile, stat, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const port = await findFreePort();
  const origin = 'http://localhost:3000';
  const api = 'http://127.0.0.1:' + port;
  const storageDir = await mkdtemp(join(tmpdir(), 'vow-voice-intro-api-'));
  const serverDatabaseUrl = new URL(process.env.DATABASE_URL);
  serverDatabaseUrl.searchParams.set('application_name', 'vow-voice-intro-media-integration');
  const db = new Pool({ connectionString: serverDatabaseUrl.toString(), max: 3 });
  const child = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env,
      API_PORT: String(port),
      APP_ORIGIN: origin,
      NODE_ENV: 'test',
      GOOGLE_CLIENT_ID: '   ',
      AUTH_RATE_LIMIT: '1000',
      DATABASE_URL: serverDatabaseUrl.toString(),
      ACCOUNT_REUSE_HMAC_KEY: 'c'.repeat(64),
      VOICE_INTRO_ENCRYPTION_KEY: 'd'.repeat(64),
      VOICE_INTRO_STORAGE_DIR: storageDir,
      PHOTO_STORAGE_DIR: storageDir,
      USER_DATA_EXPORT_RATE_LIMIT: '100',
      PG_STATEMENT_TIMEOUT_MS: '8000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let apiLogs = '';
  child.stdout.on('data', chunk => { apiLogs += chunk.toString(); });
  child.stderr.on('data', chunk => { apiLogs += chunk.toString(); });
  const createdUsers = [];

  async function request(path, options = {}) {
    return fetch(api + path, {
      ...options,
      signal: options.signal || AbortSignal.timeout(15_000),
      headers: { Origin: origin, ...(options.headers || {}) }
    });
  }

  async function register(gender, label) {
    const email = 'voice-media-' + label + '-' + randomUUID() + '@example.test';
    const response = await request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: 'Test Password 2026! Secure',
        displayName: 'Voice media ' + label,
        birthDate: '1990-01-01',
        gender,
        country: 'Georgia',
        city: 'Tbilisi',
        relationshipIntent: 'family_without_marriage',
        familyFormat: 'cohabitation',
        hasChildren: false,
        wantsChildren: 'yes',
        childrenLivingArrangement: 'not_applicable'
      })
    });
    assert.equal(response.status, 201, label + ' registration failed: ' + await response.clone().text());
    const result = await response.json();
    createdUsers.push(result.user.id);
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie?.startsWith('nit_session='));
    return { id: result.user.id, cookie };
  }

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

    const fixtureDir = await mkdtemp(join(tmpdir(), 'vow-aac-fixture-'));
    const fixturePath = join(fixtureDir, 'voice-intro.m4a');
    try {
      const generated = spawnSync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
        'anullsrc=r=44100:cl=mono', '-t', '20', '-c:a', 'aac', '-b:a', '48k',
        '-movflags', '+faststart', fixturePath
      ], { encoding: 'utf8', timeout: 20_000 });
      assert.equal(generated.error, undefined,
        'ffmpeg must be installed in the integration-test runner: ' + (generated.error?.message || ''));
      assert.equal(generated.status, 0, 'could not generate deterministic AAC fixture: ' + generated.stderr);
      const audio = await readFile(fixturePath);
      assert.ok(audio.length >= 64 && audio.length <= 2 * 1024 * 1024);

      const owner = await register('female', 'owner');
      const moderator = await register('female', 'moderator');
      const viewer = await register('male', 'viewer');
      await db.query("UPDATE users SET role = 'moderator' WHERE id = $1", [moderator.id]);

      const ordinaryModeratorList = await request('/api/admin/voice-intros', {
        headers: { Cookie: owner.cookie }
      });
      assert.equal(ordinaryModeratorList.status, 403,
        'ordinary account must not enumerate pending voice recordings');

      const uploaded = await request('/api/profiles/me/voice-intro', {
        method: 'PUT',
        headers: {
          Cookie: owner.cookie,
          'Content-Type': 'audio/mp4',
          'X-Vow-Voice-Intro-Consent': 'granted',
          'X-Vow-Voice-Intro-Consent-Version': '1'
        },
        body: audio
      });
      assert.equal(uploaded.status, 201, 'valid AAC upload failed: ' + await uploaded.clone().text());
      const uploadedBody = await uploaded.json();
      const voiceIntroId = uploadedBody.voiceIntro.id;
      const expectedDurationMs = uploadedBody.voiceIntro.durationMs;
      assert.equal(uploadedBody.voiceIntro.status, 'pending');
      // AAC packet/frame padding can add a few milliseconds to a nominal 20-second fixture.
      assert.ok(expectedDurationMs >= 20_000 && expectedDurationMs <= 20_100,
        '20-second AAC fixture duration should stay within 100ms: ' + expectedDurationMs);

      const stored = await db.query(
        'SELECT storage_path, byte_size, duration_ms, review_status FROM profile_voice_intros WHERE id = $1 AND user_id = $2',
        [voiceIntroId, owner.id]
      );
      assert.equal(stored.rowCount, 1);
      assert.equal(stored.rows[0].review_status, 'pending');
      assert.equal(stored.rows[0].byte_size, audio.length);
      assert.equal(stored.rows[0].duration_ms, expectedDurationMs);
      const encryptedPath = stored.rows[0].storage_path;
      const encryptedStat = await stat(encryptedPath);
      assert.equal(encryptedStat.mode & 0o777, 0o600);
      assert.notDeepEqual(await readFile(encryptedPath), audio,
        'private storage must contain ciphertext rather than raw AAC');

      const ownerPlayback = await request('/api/profiles/me/voice-intro', {
        headers: { Cookie: owner.cookie }
      });
      assert.equal(ownerPlayback.status, 200);
      assert.equal(ownerPlayback.headers.get('cache-control'), 'private, no-store');
      assert.equal(ownerPlayback.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(ownerPlayback.headers.get('content-type'), 'audio/mp4');
      assert.deepEqual(Buffer.from(await ownerPlayback.arrayBuffer()), audio);

      // Seed a real private photo asset in the same isolated storage directory.
      // The export route must authorize by photo_assets ownership, not profile visibility.
      const photoId = randomUUID();
      const photoPath = join(storageDir, photoId + '.png');
      const photoBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/WQAAAABJRU5ErkJggg==', 'base64');
      await writeFile(photoPath, photoBytes, { flag: 'wx', mode: 0o600 });
      await db.query(
        `INSERT INTO photo_assets (id, user_id, storage_path, mime_type, byte_size, width, height, review_status)
         VALUES ($1, $2, $3, 'image/png', $4, 1, 1, 'pending')`,
        [photoId, owner.id, photoPath, photoBytes.length]
      );
      await db.query(
        "UPDATE profiles SET photo_urls = COALESCE(photo_urls, '{}') || ARRAY[$2]::text[] WHERE user_id = $1",
        [owner.id, '/api/photos/' + photoId]
      );

      const dataExport = await request('/api/account/export', {
        method: 'POST',
        headers: { Cookie: owner.cookie }
      });
      assert.equal(dataExport.status, 200, 'account data export should include owner media references');
      const exported = await dataExport.json();
      const exportedPhoto = exported.photos.find(photo => photo.id === photoId);
      assert.ok(exportedPhoto, 'JSON export should include the owner photo metadata');
      assert.equal(exportedPhoto.downloadPath, '/api/account/export/media/photo/' + photoId);
      const photoExport = await request(exportedPhoto.downloadPath, { headers: { Cookie: owner.cookie } });
      assert.equal(photoExport.status, 200, 'owner should be able to download own private photo');
      assert.equal(photoExport.headers.get('content-type'), 'image/png');
      assert.equal(photoExport.headers.get('content-disposition'), 'attachment; filename="' + photoId + '.png"');
      assert.equal(photoExport.headers.get('cache-control'), 'no-store, private');
      assert.deepEqual(Buffer.from(await photoExport.arrayBuffer()), photoBytes);
      const otherAccountPhotoExport = await request(exportedPhoto.downloadPath, { headers: { Cookie: viewer.cookie } });
      assert.equal(otherAccountPhotoExport.status, 404,
        'another account must not download a private photo even when it knows the asset id');

      const exportedVoice = exported.voiceIntroduction;
      assert.equal(exportedVoice.id, voiceIntroId);
      assert.equal(exportedVoice.downloadPath, '/api/account/export/media/voice-intro/' + voiceIntroId);

      const mediaExport = await request(exportedVoice.downloadPath, {
        headers: { Cookie: owner.cookie }
      });
      assert.equal(mediaExport.status, 200, 'owner should be able to download own unwithdrawn voice source');
      assert.equal(mediaExport.headers.get('content-disposition'), 'attachment; filename="' + voiceIntroId + '.m4a"');
      assert.equal(mediaExport.headers.get('cache-control'), 'no-store, private');
      assert.deepEqual(Buffer.from(await mediaExport.arrayBuffer()), audio);

      const otherAccountMediaExport = await request(exportedVoice.downloadPath, {
        headers: { Cookie: viewer.cookie }
      });
      assert.equal(otherAccountMediaExport.status, 404,
        'another account must not download this voice source even when it knows the asset id');

      const pendingList = await request('/api/admin/voice-intros', {
        headers: { Cookie: moderator.cookie }
      });
      assert.equal(pendingList.status, 200);
      const pendingItems = (await pendingList.json()).voiceIntros;
      assert.ok(pendingItems.some(item => item.id === voiceIntroId && item.durationMs === expectedDurationMs));

      const moderatorPreview = await request('/api/admin/voice-intros/' + voiceIntroId + '/audio', {
        headers: { Cookie: moderator.cookie }
      });
      assert.equal(moderatorPreview.status, 200);
      assert.equal(moderatorPreview.headers.get('cache-control'), 'private, no-store');
      assert.deepEqual(Buffer.from(await moderatorPreview.arrayBuffer()), audio);

      const approved = await request('/api/admin/voice-intros/' + voiceIntroId + '/review', {
        method: 'POST',
        headers: { Cookie: moderator.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approve' })
      });
      assert.equal(approved.status, 200, 'moderator approval failed: ' + await approved.clone().text());
      assert.equal((await approved.json()).reviewStatus, 'approved');

      const ordinaryReview = await request('/api/admin/voice-intros/' + voiceIntroId + '/review', {
        method: 'POST',
        headers: { Cookie: owner.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'reject', reason: 'must not be allowed' })
      });
      assert.equal(ordinaryReview.status, 404,
        'a reviewed clip must no longer be mutable through the pending-only review route');

      const unverifiedPublicViewer = await request('/api/profiles/' + owner.id + '/voice-intro', {
        headers: { Cookie: viewer.cookie }
      });
      assert.equal(unverifiedPublicViewer.status, 403);
      assert.equal((await unverifiedPublicViewer.json()).error, 'identity_verification_required');

      const withdrawn = await request('/api/profiles/me/voice-intro', {
        method: 'DELETE',
        headers: { Cookie: owner.cookie }
      });
      assert.equal(withdrawn.status, 204);
      const removed = await db.query(
        'SELECT 1 FROM profile_voice_intros WHERE user_id = $1',
        [owner.id]
      );
      assert.equal(removed.rowCount, 0);
      const purge = await db.query(
        'SELECT attempts, next_attempt_at FROM private_voice_intro_purge_queue WHERE storage_path = $1',
        [encryptedPath]
      );
      assert.equal(purge.rowCount, 1, 'withdrawal must enqueue encrypted media for physical purge');
      assert.equal(purge.rows[0].attempts, 0);

      const ownerAfterWithdrawal = await request('/api/profiles/me/voice-intro', {
        headers: { Cookie: owner.cookie }
      });
      assert.equal(ownerAfterWithdrawal.status, 404);
      const mediaAfterWithdrawal = await request('/api/account/export/media/voice-intro/' + voiceIntroId, {
        headers: { Cookie: owner.cookie }
      });
      assert.equal(mediaAfterWithdrawal.status, 404,
        'withdrawn voice consent must disable the export download immediately');
      const history = await db.query(
        'SELECT event_type FROM profile_voice_intro_consent_events WHERE user_id = $1 ORDER BY id',
        [owner.id]
      );
      assert.deepEqual(history.rows.map(row => row.event_type), ['granted', 'withdrawn']);
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  } finally {
    for (const userId of createdUsers) {
      await db.query("UPDATE users SET status = 'deleted' WHERE id = $1", [userId]).catch(() => {});
      await db.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
    }
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
    await rm(storageDir, { recursive: true, force: true }).catch(() => {});
  }
});
