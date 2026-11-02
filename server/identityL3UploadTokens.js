import { createHash, randomBytes } from 'node:crypto';

const TOKEN_BYTES = 32;
const TOKEN_LIFETIME_MINUTES = 10;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;\nexport const IDENTITY_L3_CONSENT_VERSION = 1;

export class IdentityL3UploadTokenError extends Error {
  constructor(code) {
    super(code);
    this.name = 'IdentityL3UploadTokenError';
    this.code = code;
  }
}

export function createIdentityL3UploadToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashIdentityL3UploadToken(token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    throw new IdentityL3UploadTokenError('l3_upload_token_invalid');
  }
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

async function lockL3Account(client, userId) {
  // Share the same account-level advisory lock used by destructive account and gift workflows.
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('gift-safety-user:' || $1::uuid::text))",
    [userId]
  );
  const result = await client.query(
    `SELECT u.status AS account_status, p.gender,
            iv.provider, iv.status AS identity_status, iv.provider_environment,\n            EXISTS (\n              SELECT 1 FROM identity_l3_consents c\n              WHERE c.user_id = u.id\n                AND c.consent_version = $1::int\n                AND c.withdrawn_at IS NULL\n            ) AS l3_consent_active
     FROM users u
     JOIN profiles p ON p.user_id = u.id
     JOIN identity_verifications iv ON iv.user_id = u.id
     WHERE u.id = $1
       AND iv.provider = 'didit'
       AND iv.provider_status = 'Approved'
       AND iv.provider_session_id IS NOT NULL
     FOR UPDATE OF u, p, iv`,
    [userId]
  );
  const account = result.rows[0];
  if (!account || account.account_status !== 'active' || account.gender !== 'male' ||
      account.identity_status !== 'verified' || account.provider_environment !== 'live' ||\n      account.l3_consent_active !== true) {
    throw new IdentityL3UploadTokenError(\n      account?.l3_consent_active === true ? 'l3_upload_requires_live_l2' : 'l3_consent_required'\n    );
  }
}

function setAuditActor(client, userId) {
  return client.query(
    "SELECT set_config('app.identity_l3_actor_user_id', $1, true), set_config('app.identity_l3_reason_code', 'applicant_upload_authorization', true)",
    [userId]
  );
}

/**
 * Must run inside the caller's PostgreSQL transaction. Caller commits only after
 * the returned capability has been created; plaintext is returned once and never stored.
 */
export async function issueIdentityL3UploadCapability(client, { userId }) {
  await lockL3Account(client, userId);
  await setAuditActor(client, userId);

  let submission = await client.query(
    `SELECT id, status FROM identity_l3_submissions
     WHERE user_id = $1
       AND status IN ('draft', 'upload_authorized', 'uploaded', 'processing', 'pending_review')
     FOR UPDATE`,
    [userId]
  );
  let row = submission.rows[0];
  if (!row) {
    submission = await client.query(
      "INSERT INTO identity_l3_submissions (user_id, status) VALUES ($1, 'draft') RETURNING id, status",
      [userId]
    );
    row = submission.rows[0];
  }
  if (!['draft', 'upload_authorized'].includes(row.status)) {
    throw new IdentityL3UploadTokenError('l3_submission_not_uploadable');
  }

  if (row.status === 'draft') {
    await client.query(
      "UPDATE identity_l3_submissions SET status = 'upload_authorized' WHERE id = $1",
      [row.id]
    );
  }

  // Re-authorization invalidates every previous unused token, including expired rows.
  await client.query(
    `UPDATE identity_l3_upload_tokens SET revoked_at = NOW()
     WHERE submission_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`,
    [row.id]
  );

  const token = createIdentityL3UploadToken();
  const tokenHash = hashIdentityL3UploadToken(token);
  const inserted = await client.query(
    `INSERT INTO identity_l3_upload_tokens
       (submission_id, user_id, token_sha256, expires_at)
     VALUES ($1, $2, $3, NOW() + ($4::int * INTERVAL '1 minute'))
     RETURNING expires_at`,
    [row.id, userId, tokenHash, TOKEN_LIFETIME_MINUTES]
  );

  return {
    submissionId: row.id,
    uploadToken: token,
    expiresAt: inserted.rows[0].expires_at,
    maxBytes: 104857600,
    acceptedMimeTypes: ['video/mp4', 'video/webm']
  };
}

/**
 * Atomically consumes a bearer token for its authenticated owner. Must run in a
 * caller-owned transaction before accepting bytes. Keep that transaction and its
 * account advisory lock open until the encrypted object key is persisted on the
 * submission, or commit the consumed token on failure. This prevents account deletion
 * from racing an in-flight upload and leaving an orphaned private object.
 */
export async function consumeIdentityL3UploadCapability(client, { userId, uploadToken }) {
  const tokenHash = hashIdentityL3UploadToken(uploadToken);
  await lockL3Account(client, userId);
  const candidate = await client.query(
    `SELECT t.id AS token_id, t.submission_id, s.status
     FROM identity_l3_upload_tokens t
     JOIN identity_l3_submissions s ON s.id = t.submission_id
     WHERE t.user_id = $1 AND t.token_sha256 = $2
       AND t.consumed_at IS NULL AND t.revoked_at IS NULL
       AND t.expires_at > NOW() AND s.user_id = $1
     FOR UPDATE OF t, s`,
    [userId, tokenHash]
  );
  const row = candidate.rows[0];
  if (!row || row.status !== 'upload_authorized') {
    throw new IdentityL3UploadTokenError('l3_upload_token_invalid_or_expired');
  }

  const consumed = await client.query(
    `UPDATE identity_l3_upload_tokens
     SET consumed_at = NOW()
     WHERE id = $1 AND user_id = $2 AND consumed_at IS NULL
       AND revoked_at IS NULL AND expires_at > NOW()
     RETURNING submission_id`,
    [row.token_id, userId]
  );
  if (!consumed.rowCount) {
    throw new IdentityL3UploadTokenError('l3_upload_token_invalid_or_expired');
  }
  return { submissionId: consumed.rows[0].submission_id };
}

export const IDENTITY_L3_UPLOAD_TOKEN_LIFETIME_MINUTES = TOKEN_LIFETIME_MINUTES;
