import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createSessionToken, hashSessionToken } from './security.js';
import { runIdentityL3PurgeOnce } from './process-identity-l3-queue.js';

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

test('L3 moderator queue, authenticated media review, decisions and rejected-media purge work end to end', {
  skip: !process.env.DATABASE_URL,
  timeout: 60_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  const applicantId = randomUUID();
  const moderatorId = randomUUID();
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'vow-identity-l3-moderation-'));
  await chmod(storageRoot, 0o700);
  const encryptionKey = randomBytes(32).toString('hex');
  const applicantSession = createSessionToken();
  const moderatorSession = createSessionToken();
  let child;

  async function seedUser(userId, role, gender, label, token) {
    await pool.query(
      "INSERT INTO users (id, email, role, status, email_verified_at) VALUES ($1, $2, $3, 'active', NOW())",
      [userId, label + '-' + randomUUID() + '@example.invalid', role]
    );
    await pool.query(
      `INSERT INTO profiles
         (user_id, display_name, birth_date, gender, country, city, children_disclosure_confirmed_at)
       VALUES ($1, $2, DATE '1990-01-01', $3, 'Georgia', 'Tbilisi', NOW())`,
      [userId, label, gender]
    );
    await pool.query(
      "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')",
      [userId, hashSessionToken(token)]
    );
  }

  async function createPendingSubmission(videoBytes, request, applicantCookie) {
    const capabilityResponse = await request('/api/identity/l3/upload-capability', {
      method: 'POST',
      headers: { Cookie: applicantCookie }
    });
    assert.equal(capabilityResponse.status, 201);
    const capability = await capabilityResponse.json();
    assert.equal(typeof capability.uploadToken, 'string');
    assert.equal(capability.maxBytes, 100 * 1024 * 1024);

    const uploadResponse = await request('/api/identity/l3/upload', {
      method: 'POST',
      headers: {
        Cookie: applicantCookie,
        'Content-Type': 'video/mp4',
        'X-Identity-L3-Upload-Token': capability.uploadToken
      },
      body: videoBytes
    });
    assert.equal(uploadResponse.status, 201);
    const uploaded = await uploadResponse.json();
    assert.equal(uploaded.submissionId, capability.submissionId);
    assert.equal(uploaded.status, 'uploaded');

    const replay = await request('/api/identity/l3/upload', {
      method: 'POST',
      headers: {
        Cookie: applicantCookie,
        'Content-Type': 'video/mp4',
        'X-Identity-L3-Upload-Token': capability.uploadToken
      },
      body: Buffer.from('replay must not be accepted')
    });
    assert.equal(replay.status, 401, 'a consumed upload capability must never be reusable');

    await pool.query(
      "UPDATE identity_l3_submissions SET status = 'processing' WHERE id = $1",
      [capability.submissionId]
    );
    await pool.query(
      `UPDATE identity_l3_submissions
       SET status = 'pending_review', media_duration_seconds = 30,
           processing_completed_at = NOW()
       WHERE id = $1`,
      [capability.submissionId]
    );
    return { submissionId: capability.submissionId };
  }

  try {
    await seedUser(applicantId, 'member', 'male', 'L3 applicant', applicantSession);
    await seedUser(moderatorId, 'moderator', 'female', 'L3 moderator', moderatorSession);
    await pool.query(
      `INSERT INTO identity_verifications
         (user_id, provider, provider_session_id, workflow_id, status, provider_status, provider_environment)
       VALUES ($1, 'didit', $2, $3, 'verified', 'Approved', 'live')`,
      [applicantId, randomUUID(), randomUUID()]
    );
    await pool.query(
      `INSERT INTO identity_l3_consents (user_id, consent_version, granted_at)
       VALUES ($1, 1, statement_timestamp())`,
      [applicantId]
    );

    const port = await findFreePort();
    const origin = 'http://localhost:3000';
    const api = 'http://127.0.0.1:' + port;
    child = spawn(process.execPath, ['server/index.js'], {
      env: {
        ...process.env,
        API_PORT: String(port),
        APP_ORIGIN: origin,
        NODE_ENV: 'test',
        EMAIL_VERIFICATION_REQUIRED: 'false',
        IDENTITY_L3_ENABLED: 'true',
        IDENTITY_L3_STORAGE_DIR: storageRoot,
        IDENTITY_L3_ENCRYPTION_KEY: encryptionKey,
        PG_STATEMENT_TIMEOUT_MS: '8000'
      },
      stdio: 'ignore'
    });

    async function request(urlPath, options = {}) {
      return fetch(api + urlPath, {
        ...options,
        signal: options.signal || AbortSignal.timeout(10_000),
        headers: {
          Origin: origin,
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(options.headers || {})
        }
      });
    }

    let healthy = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (child.exitCode !== null) throw new Error('L3 moderation API exited with code ' + child.exitCode);
      try {
        const response = await fetch(api + '/api/health', { signal: AbortSignal.timeout(2_000) });
        if (response.ok) { healthy = true; break; }
      } catch {
        // Wait for the child process to bind its port.
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(healthy, true, 'moderation API must start');

    const moderatorCookie = 'nit_session=' + moderatorSession;
    const applicantCookie = 'nit_session=' + applicantSession;

    const firstVideo = Buffer.from('private encrypted L3 moderator review fixture');
    const first = await createPendingSubmission(firstVideo, request, applicantCookie);
    const forbiddenQueue = await request('/api/moderation/identity-l3/submissions', {
      headers: { Cookie: applicantCookie }
    });
    assert.equal(forbiddenQueue.status, 403);

    const queue = await request('/api/moderation/identity-l3/submissions', {
      headers: { Cookie: moderatorCookie }
    });
    assert.equal(queue.status, 200);
    const queuePayload = await queue.json();
    assert.deepEqual(
      queuePayload.submissions.map(item => item.submissionId),
      [first.submissionId]
    );
    assert.equal(JSON.stringify(queuePayload).includes(storageRoot), false,
      'moderation queue must never expose private storage paths');

    const media = await request('/api/moderation/identity-l3/submissions/' + first.submissionId + '/media', {
      headers: { Cookie: moderatorCookie }
    });
    assert.equal(media.status, 200);
    assert.equal(media.headers.get('cache-control'), 'private, no-store, max-age=0');
    assert.deepEqual(Buffer.from(await media.arrayBuffer()), firstVideo,
      'moderator receives authenticated plaintext only after encrypted media integrity checks');
    const mediaAccessAudit = await pool.query(
      'SELECT moderator_user_id, access_type FROM identity_l3_media_access_events WHERE submission_id = $1',
      [first.submissionId]
    );
    assert.deepEqual(mediaAccessAudit.rows, [{ moderator_user_id: moderatorId, access_type: 'viewed' }]);


    const approved = await request('/api/moderation/identity-l3/submissions/' + first.submissionId + '/decision', {
      method: 'POST',
      headers: { Cookie: moderatorCookie },
      body: JSON.stringify({ decision: 'approved', reasonCode: 'video_matches_l2' })
    });
    assert.equal(approved.status, 200);
    const approvedPayload = await approved.json();
    assert.equal(approvedPayload.status, 'approved');
    assert.ok(approvedPayload.expiresAt);
    const approvedState = await pool.query(
      `SELECT identity_l3_has_active_approval($1) AS active,
              (SELECT COUNT(*)::int FROM identity_l3_media_purge_jobs WHERE submission_id = $2) AS purge_jobs`,
      [applicantId, first.submissionId]
    );
    assert.equal(approvedState.rows[0].active, true);
    assert.equal(approvedState.rows[0].purge_jobs, 0,
      'an active approval retains its encrypted evidence for the six-month review period');

    const mediaAfterApproval = await request('/api/moderation/identity-l3/submissions/' + first.submissionId + '/media', {
      headers: { Cookie: moderatorCookie }
    });
    assert.equal(mediaAfterApproval.status, 404,
      'a decision closes the pending-review media endpoint');

    // Withdrawal revokes an existing approval immediately and the purge worker
    // must be able to clear media from the now-revoked terminal submission.
    const withdrawn = await request('/api/identity/l3/consent', {
      method: 'DELETE',
      headers: { Cookie: applicantCookie }
    });
    assert.equal(withdrawn.status, 200);
    const withdrawnPayload = await withdrawn.json();
    assert.equal(withdrawnPayload.accepted, false);
    assert.equal(withdrawnPayload.withdrawn, true);
    assert.equal(withdrawnPayload.purgeStatus, 'pending');
    const revokedApproval = await pool.query(
      'SELECT status, storage_object_key FROM identity_l3_submissions WHERE id = $1',
      [first.submissionId]
    );
    assert.equal(revokedApproval.rows[0].status, 'revoked');
    assert.ok(revokedApproval.rows[0].storage_object_key);
    const revokedPurge = await runIdentityL3PurgeOnce(pool, {
      storageRoot,
      submissionId: first.submissionId
    });
    assert.equal(revokedPurge.status, 'completed',
      'revoked media must be physically deleted after consent withdrawal: ' + JSON.stringify(revokedPurge));
    const revokedPurgeState = await pool.query(
      `SELECT j.status AS purge_status, s.storage_object_key, s.media_purged_at
       FROM identity_l3_media_purge_jobs j
       JOIN identity_l3_submissions s ON s.id = j.submission_id
       WHERE j.submission_id = $1`,
      [first.submissionId]
    );
    assert.equal(revokedPurgeState.rows[0].purge_status, 'completed');
    assert.equal(revokedPurgeState.rows[0].storage_object_key, null);
    assert.ok(revokedPurgeState.rows[0].media_purged_at);
    const inactiveApproval = await pool.query(
      'SELECT identity_l3_has_active_approval($1) AS active',
      [applicantId]
    );
    assert.equal(inactiveApproval.rows[0].active, false,
      'withdrawal must revoke L3 access before physical deletion finishes');

    const regranted = await request('/api/identity/l3/consent', {
      method: 'PUT',
      headers: { Cookie: applicantCookie },
      body: JSON.stringify({ accepted: true, version: 1 })
    });
    assert.equal(regranted.status, 201);
    assert.equal((await regranted.json()).accepted, true);

    // The workflow permits only one active submission per applicant. Resolve the
    // first submission before creating the second so this test exercises the
    // supported lifecycle instead of bypassing the single-active-submission rule.
    const secondVideo = Buffer.from('private encrypted L3 rejected media fixture');
    const second = await createPendingSubmission(secondVideo, request, applicantCookie);
    const queueAfterSecondUpload = await request('/api/moderation/identity-l3/submissions', {
      headers: { Cookie: moderatorCookie }
    });
    assert.equal(queueAfterSecondUpload.status, 200);
    const queueAfterSecondUploadPayload = await queueAfterSecondUpload.json();
    assert.deepEqual(
      queueAfterSecondUploadPayload.submissions.map(item => item.submissionId),
      [second.submissionId]
    );

    const rejected = await request('/api/moderation/identity-l3/submissions/' + second.submissionId + '/decision', {
      method: 'POST',
      headers: { Cookie: moderatorCookie },
      body: JSON.stringify({ decision: 'rejected', reasonCode: 'video_mismatch' })
    });
    assert.equal(rejected.status, 200);
    assert.equal((await rejected.json()).status, 'rejected');
    const queued = await pool.query(
      'SELECT status FROM identity_l3_media_purge_jobs WHERE submission_id = $1',
      [second.submissionId]
    );
    assert.deepEqual(queued.rows, [{ status: 'queued' }],
      'rejected media must be queued for physical deletion automatically');

    const purged = await runIdentityL3PurgeOnce(pool, { storageRoot, submissionId: second.submissionId });
    assert.equal(purged.status, 'completed', 'rejected-media purge must complete: ' + JSON.stringify(purged));
    const purgeState = await pool.query(
      `SELECT j.status AS purge_status, s.storage_object_key, s.media_purged_at
       FROM identity_l3_media_purge_jobs j
       JOIN identity_l3_submissions s ON s.id = j.submission_id
       WHERE j.submission_id = $1`,
      [second.submissionId]
    );
    assert.equal(purgeState.rows[0].purge_status, 'completed');
    assert.equal(purgeState.rows[0].storage_object_key, null);
    assert.ok(purgeState.rows[0].media_purged_at);
    const finalApproval = await pool.query(
      'SELECT identity_l3_has_active_approval($1) AS active',
      [applicantId]
    );
    assert.equal(finalApproval.rows[0].active, false,
      'the latest rejected decision must supersede an earlier approval');
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        once(child, 'exit'),
        new Promise(resolve => setTimeout(resolve, 5_000))
      ]);
    }
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[applicantId, moderatorId]]).catch(() => {});
    await pool.end();
    await rm(storageRoot, { recursive: true, force: true });
  }
});
