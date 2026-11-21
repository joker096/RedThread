import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createIdentityL3UploadToken,
  hashIdentityL3UploadToken,
  IDENTITY_L3_UPLOAD_TOKEN_LIFETIME_MINUTES,
  IDENTITY_L3_CONSENT_VERSION,
  IDENTITY_L3_CONSENT_NOTICE,
  IdentityL3UploadTokenError
} from './identityL3UploadTokens.js';

test('L3 upload capability is cryptographically random and URL-safe', () => {
  const first = createIdentityL3UploadToken();
  const second = createIdentityL3UploadToken();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.match(second, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
  assert.equal(Buffer.from(first, 'base64url').length, 32);
});

test('L3 upload capability hashes deterministically without exposing plaintext', () => {
  const token = createIdentityL3UploadToken();
  const digest = hashIdentityL3UploadToken(token);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(hashIdentityL3UploadToken(token), digest);
  assert.notEqual(digest, token);
});

test('L3 upload capability rejects malformed bearer values', () => {
  for (const value of ['', 'short', 'x'.repeat(200), null, undefined, 123]) {
    assert.throws(
      () => hashIdentityL3UploadToken(value),
      error => error instanceof IdentityL3UploadTokenError &&
        error.code === 'l3_upload_token_invalid'
    );
  }
});

test('L3 upload capability lifetime is short and bounded', () => {
  assert.equal(IDENTITY_L3_UPLOAD_TOKEN_LIFETIME_MINUTES, 10);
});


function fakeClient(responses) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      const next = responses.shift();
      if (!next) throw new Error('unexpected_query');
      if (next.error) throw next.error;
      return next;
    }
  };
}

test('upload capability issuance fails closed unless persisted account and Didit L2 are valid', async () => {
  const { issueIdentityL3UploadCapability } = await import('./identityL3UploadTokens.js');
  const client = fakeClient([
    { rows: [], rowCount: 0 },
    { rows: [{ account_status: 'active', gender: 'male', identity_status: 'verified', provider_environment: 'sandbox', l3_consent_active: true }], rowCount: 1 }
  ]);
  await assert.rejects(
    issueIdentityL3UploadCapability(client, { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    error => error.code === 'l3_upload_requires_live_l2'
  );
  assert.equal(client.calls.length, 2);
  assert.match(client.calls[1].sql, /FOR UPDATE OF u, p, iv/);
  assert.match(client.calls[1].sql, /identity_l3_consents/);
  assert.equal(client.calls[1].params[0], 2);
});

test('upload capability issuance persists only a digest and returns plaintext once', async () => {
  const { issueIdentityL3UploadCapability } = await import('./identityL3UploadTokens.js');
  const client = fakeClient([
    { rows: [], rowCount: 0 },
    { rows: [{ account_status: 'active', gender: 'male', identity_status: 'verified', provider_environment: 'live', l3_consent_active: true }], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [{ media_purge_pending: false }], rowCount: 1 },
    { rows: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'draft' }], rowCount: 1 },
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [{ expires_at: '2026-11-01T12:10:00.000Z' }], rowCount: 1 }
  ]);
  const result = await issueIdentityL3UploadCapability(client, {
    userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  });
  assert.match(result.uploadToken, /^[A-Za-z0-9_-]{43}$/);
  assert.match(client.calls[0].sql, /pg_advisory_xact_lock\(hashtext\('gift-safety-user:'/,
    'capability issuance must use the same account safety lock as consent withdrawal');
  assert.equal(result.submissionId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  assert.equal(result.maxBytes, 104857600);
  assert.deepEqual(result.acceptedMimeTypes, ['video/mp4', 'video/webm']);
  const insert = client.calls.find(call => /INSERT INTO identity_l3_upload_tokens/.test(call.sql));
  assert.ok(insert);
  assert.equal(insert.params[2], hashIdentityL3UploadToken(result.uploadToken));
  assert.notEqual(insert.params[2], result.uploadToken);
});

test('replacement L3 uploads wait until every terminal prior video is physically purged', async () => {
  const { issueIdentityL3UploadCapability } = await import('./identityL3UploadTokens.js');
  const client = fakeClient([
    { rows: [], rowCount: 0 },
    { rows: [{
      account_status: 'active', gender: 'male', identity_status: 'verified',
      provider_environment: 'live', l3_consent_active: true
    }], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [{ media_purge_pending: true }], rowCount: 1 }
  ]);
  await assert.rejects(
    issueIdentityL3UploadCapability(client, {
      userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    }),
    error => error instanceof IdentityL3UploadTokenError && error.code === 'l3_media_purge_pending'
  );
  assert.equal(client.calls.length, 4, 'no replacement submission or token may be created before purge');
  assert.match(client.calls[3].sql, /storage_object_key IS NOT NULL/);
  assert.match(client.calls[3].sql, /'withdrawn', 'revoked', 'rejected', 'expired', 'failed'/);
});

test('upload capability consumption binds the token to the authenticated user and submission', async () => {
  const { consumeIdentityL3UploadCapability } = await import('./identityL3UploadTokens.js');
  const token = createIdentityL3UploadToken();
  const client = fakeClient([
    { rows: [], rowCount: 0 },
    { rows: [{ account_status: 'active', gender: 'male', identity_status: 'verified', provider_environment: 'live', l3_consent_active: true }], rowCount: 1 },
    { rows: [{ token_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', submission_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'upload_authorized' }], rowCount: 1 },
    { rows: [{ submission_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }], rowCount: 1 }
  ]);
  const result = await consumeIdentityL3UploadCapability(client, {
    userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    uploadToken: token
  });
  assert.equal(result.submissionId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  assert.match(client.calls[0].sql, /pg_advisory_xact_lock\(hashtext\('gift-safety-user:'/,
    'capability consumption must use the same account safety lock as consent withdrawal');
  const lookup = client.calls.find(call => /FROM identity_l3_upload_tokens t/.test(call.sql));
  assert.equal(lookup.params[0], 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(lookup.params[1], hashIdentityL3UploadToken(token));
  assert.match(lookup.sql, /t\.expires_at > NOW\(\)/);
});

test('upload capability issuance fails closed when explicit current L3 consent is absent', async () => {
  const { issueIdentityL3UploadCapability } = await import('./identityL3UploadTokens.js');
  const client = fakeClient([
    { rows: [], rowCount: 0 },
    { rows: [{
      account_status: 'active', gender: 'male', identity_status: 'verified',
      provider_environment: 'live', l3_consent_active: false
    }], rowCount: 1 }
  ]);
  await assert.rejects(
    issueIdentityL3UploadCapability(client, { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    error => error.code === 'l3_consent_required'
  );
  assert.equal(client.calls.length, 2);
  assert.match(client.calls[1].sql, /c\.withdrawn_at IS NULL/);
});

test('upload capability consumption fails closed after L3 consent is absent or withdrawn', async () => {
  const { consumeIdentityL3UploadCapability } = await import('./identityL3UploadTokens.js');
  const token = createIdentityL3UploadToken();
  const client = fakeClient([
    { rows: [], rowCount: 0 },
    { rows: [{
      account_status: 'active', gender: 'male', identity_status: 'verified',
      provider_environment: 'live', l3_consent_active: false
    }], rowCount: 1 }
  ]);
  await assert.rejects(
    consumeIdentityL3UploadCapability(client, {
      userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      uploadToken: token
    }),
    error => error.code === 'l3_consent_required'
  );
  assert.equal(client.calls.length, 2, 'a token lookup must not occur after consent is missing');
});

test('L3 consent notice is explicit and versioned', () => {
  assert.equal(IDENTITY_L3_CONSENT_NOTICE.version, IDENTITY_L3_CONSENT_VERSION);
  assert.equal(IDENTITY_L3_CONSENT_VERSION, 2);
  assert.match(IDENTITY_L3_CONSENT_NOTICE.text, /30–60 секунд/);
  assert.match(IDENTITY_L3_CONSENT_NOTICE.text, /уполномоченные модераторы Vow/);
  assert.match(IDENTITY_L3_CONSENT_NOTICE.text, /отозвать согласие в любое время/);
  assert.match(IDENTITY_L3_CONSENT_NOTICE.text, /очередь на удаление/);
  assert.match(IDENTITY_L3_CONSENT_NOTICE.text, /шесть месяцев/);
  assert.match(IDENTITY_L3_CONSENT_NOTICE.text, /30 дней/);
  assert.equal(Object.isFrozen(IDENTITY_L3_CONSENT_NOTICE), true);
});


test('L3 consent withdrawal requires durable ACK before touching consent or media access', () => {
  const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  const start = source.indexOf("app.delete('/api/identity/l3/consent'");
  const end = source.indexOf("app.get('/api/ads/consent'", start);
  assert.ok(start >= 0 && end > start, 'L3 withdrawal route boundaries must exist');
  const route = source.slice(start, end);
  const preflight = route.indexOf('const preflight = await pool.query');
  const coordinator = route.indexOf('runAckGatedPrivacyRecoveryOperation({');
  assert.ok(preflight >= 0 && coordinator > preflight, 'lock-free preflight must precede the Ledger coordinator');
  assert.equal(route.includes('enqueuePrivacyRecoveryEvent'), false, 'L3 withdrawal must not use the legacy outbox');
  assert.ok(route.includes("eventType: 'identity_l3_consent_withdrawn'"));
  assert.ok(route.includes('granted_at::text AS granted_at'));
  assert.ok(route.includes('withdrawn_at::text AS withdrawn_at'));
  assert.ok(route.includes('apply: transactionClient => applyWithdrawal(transactionClient, expectedConsent, true)'));
  assert.ok(route.includes('current.granted_at === expectedConsent.granted_at'));
  assert.ok(route.includes('current.withdrawn_at === expectedConsent.withdrawn_at'));
  assert.ok(route.includes('FOR UPDATE'), 'the exact consent lifecycle must be rechecked under lock');
  assert.ok(route.includes('UPDATE identity_l3_upload_tokens'));
  assert.ok(route.includes('UPDATE identity_l3_submissions'));
  assert.ok(route.includes('identity_l3_media_purge_jobs'));
  assert.ok(route.includes('INSERT INTO identity_l3_consent_events'));
});
