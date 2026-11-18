import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, randomUUID, sign as signSignature } from 'node:crypto';
import {
  appendPrivacyRecoveryEvent,
  createPrivacyRecoverySnapshotBarrier,
  releasePrivacyRecoverySnapshotBarrier
} from './privacyRecoveryLedger.js';

const proofKeys = generateKeyPairSync('ed25519');
const proofPublicKey = proofKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const baseEnv = {
  NODE_ENV: 'test',
  PRIVACY_RECOVERY_LEDGER_REQUIRED: 'true',
  PRIVACY_RECOVERY_LEDGER_URL: 'https://ledger.example',
  PRIVACY_RECOVERY_LEDGER_HMAC_SECRET: 'auth-secret-at-least-32-characters-long',
  PRIVACY_RECOVERY_LEDGER_PSEUDONYM_KEY: 'pseudonym-secret-at-least-32-characters',
  PRIVACY_RECOVERY_LEDGER_PROOF_PUBLIC_KEY: proofPublicKey
};


function barrierResponse({ snapshotId, barrierId, status, sequence, releasedAt = null, tamper = false, duplicate = false }) {
  const proof = {
    barrier_id: barrierId,
    snapshot_id: snapshotId,
    ledger_sequence: sequence,
    status,
    created_at: '2026-11-19T08:00:00.000Z',
    released_at: releasedAt
  };
  const signature = signSignature(null, Buffer.from(JSON.stringify(proof)), proofKeys.privateKey).toString('hex');
  return {
    ok: true,
    status: status === 'active' ? 201 : 200,
    json: async () => ({
      accepted: true,
      ...(status === 'active' ? { duplicate } : {}),
      ...proof,
      signature: tamper ? '0'.repeat(64) : signature
    })
  };
}

test('snapshot barrier client signs create and verifies the returned watermark proof', async () => {
  const snapshotId = 'backup-2026-11-19';
  const barrierId = '123e4567-e89b-42d3-a456-426614174030';
  let captured;
  const proof = await createPrivacyRecoverySnapshotBarrier({ snapshotId, barrierId }, {
    env: baseEnv,
    now: () => Date.UTC(2026, 10, 19, 8, 0, 0),
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return barrierResponse({ snapshotId, barrierId, status: 'active', sequence: 27 });
    }
  });
  assert.equal(captured.url, 'https://ledger.example/v1/snapshot-barriers');
  assert.equal(captured.options.method, 'POST');
  assert.deepEqual(JSON.parse(captured.options.body), { snapshot_id: snapshotId, barrier_id: barrierId });
  assert.equal(captured.options.headers['x-ledger-timestamp'], '1795075200');
  assert.equal(captured.options.headers['x-ledger-signature'],
    createHmac('sha256', baseEnv.PRIVACY_RECOVERY_LEDGER_HMAC_SECRET)
      .update('1795075200.' + captured.options.body, 'utf8').digest('hex'));
  assert.equal(proof.ledger_sequence, 27);
  assert.equal(proof.status, 'active');
  assert.equal(proof.duplicate, false);
});

test('snapshot barrier client signs release and verifies the release receipt', async () => {
  const snapshotId = 'backup-2026-11-19';
  const barrierId = '123e4567-e89b-42d3-a456-426614174031';
  let captured;
  const proof = await releasePrivacyRecoverySnapshotBarrier({ snapshotId, barrierId }, {
    env: baseEnv,
    now: () => Date.UTC(2026, 10, 19, 8, 0, 0),
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return barrierResponse({
        snapshotId, barrierId, status: 'released', sequence: 27,
        releasedAt: '2026-11-19T08:05:00.000Z'
      });
    }
  });
  assert.equal(captured.url, 'https://ledger.example/v1/snapshot-barriers/' + barrierId + '/release');
  assert.deepEqual(JSON.parse(captured.options.body), { snapshot_id: snapshotId });
  assert.equal(proof.status, 'released');
  assert.equal(proof.released_at, '2026-11-19T08:05:00.000Z');
});

test('snapshot barrier client rejects tampered proof and invalid identifiers', async () => {
  const snapshotId = 'backup-2026-11-19';
  const barrierId = '123e4567-e89b-42d3-a456-426614174032';
  await assert.rejects(
    createPrivacyRecoverySnapshotBarrier({ snapshotId, barrierId }, {
      env: baseEnv,
      fetchImpl: async () => barrierResponse({
        snapshotId, barrierId, status: 'active', sequence: 27, tamper: true
      })
    }),
    /signature_invalid/
  );
  await assert.rejects(
    createPrivacyRecoverySnapshotBarrier({ snapshotId: '../bad', barrierId }, {
      env: baseEnv,
      fetchImpl: async () => { throw new Error('must not call'); }
    }),
    /invalid_privacy_recovery_snapshot_barrier/
  );
});

test('required ledger fails closed when configuration is missing', async () => {
  await assert.rejects(
    appendPrivacyRecoveryEvent({ eventType: 'account_erasure_requested', userId: 'u-1' }, {
      env: { NODE_ENV: 'production' }, fetchImpl: async () => { throw new Error('must not call'); }
    }),
    /not_configured/
  );
});

test('non-production may skip an unconfigured optional ledger explicitly', async () => {
  const result = await appendPrivacyRecoveryEvent({ eventType: 'account_erasure_requested', userId: 'u-1' }, {
    env: { NODE_ENV: 'test' }
  });
  assert.deepEqual(result, { skipped: true });
});

test('event is pseudonymized, signed and only acknowledged after remote durable acceptance', async () => {
  let captured;
  const result = await appendPrivacyRecoveryEvent({
    eventType: 'voice_intro_consent_withdrawn',
    userId: 'internal-user-uuid',
    resourceId: 'internal-resource-uuid',
    occurredAt: '2026-11-14T07:00:00.000Z'
  }, {
    env: baseEnv,
    now: () => 1_800_000_000_000,
    fetchImpl: async (url, options) => {
      captured = { url, options, event: JSON.parse(options.body) };
      return new Response(JSON.stringify({ accepted: true, duplicate: false, event_id: captured.event.event_id, sequence: 17 }), {
        status: 201, headers: { 'content-type': 'application/json' }
      });
    }
  });

  assert.equal(result.acknowledged, true);
  assert.equal(result.sequence, 17);
  assert.equal(result.eventId, captured.event.event_id);
  assert.equal(captured.url, 'https://ledger.example/v1/events');
  assert.equal(captured.options.redirect, 'error', 'signed privacy events must never follow redirects to another host');
  assert.equal(captured.event.event_type, 'voice_intro_consent_withdrawn');
  assert.notEqual(captured.event.subject_ref, 'internal-user-uuid');
  assert.notEqual(captured.event.resource_ref, 'internal-resource-uuid');
  assert.equal(captured.event.schema_version, 1);
  const expected = createHmac('sha256', baseEnv.PRIVACY_RECOVERY_LEDGER_HMAC_SECRET)
    .update(`1800000000.${captured.options.body}`).digest('hex');
  assert.equal(captured.options.headers['x-ledger-signature'], expected);
});

test('ledger network failure is a hard error when required', async () => {
  await assert.rejects(
    appendPrivacyRecoveryEvent({ eventType: 'account_erasure_requested', userId: 'u-1' }, {
      env: baseEnv, fetchImpl: async () => { throw new Error('offline'); }
    }),
    /unavailable/
  );
});

test('invalid event types and non-HTTPS endpoints are rejected', async () => {
  await assert.rejects(
    appendPrivacyRecoveryEvent({ eventType: 'arbitrary', userId: 'u-1' }, { env: baseEnv }),
    /invalid_privacy_recovery_event/
  );
  await assert.rejects(
    appendPrivacyRecoveryEvent({ eventType: 'account_erasure_requested', userId: 'u-1' }, {
      env: { ...baseEnv, PRIVACY_RECOVERY_LEDGER_URL: 'http://ledger.example' },
      fetchImpl: async () => { throw new Error('must not call'); }
    }),
    /invalid_url/
  );
});

test('malformed or non-success acknowledgement is rejected', async () => {
  await assert.rejects(
    appendPrivacyRecoveryEvent({ eventType: 'account_erasure_requested', userId: 'u-1' }, {
      env: baseEnv, fetchImpl: async () => new Response(JSON.stringify({ accepted: true, sequence: 18 }), { status: 200 })
    }),
    /invalid_acknowledgement/
  );
});


test('delivery rejects malformed persisted payloads before making a network request', async () => {
  const { deliverPrivacyRecoveryLedgerPayload } = await import('./privacyRecoveryLedger.js');
  await assert.rejects(
    deliverPrivacyRecoveryLedgerPayload({
      event_id: randomUUID(), schema_version: 2, event_type: 'account_erasure_requested',
      subject_ref: 'c'.repeat(64), occurred_at: '2026-11-16T00:00:00.000Z'
    }, { env: baseEnv, fetchImpl: async () => { throw new Error('must not call'); } }),
    /invalid_privacy_recovery_event_payload/
  );
});

test('address draft consent withdrawal is a supported pseudonymized Ledger event', async () => {
  let payload;
  const result = await appendPrivacyRecoveryEvent({
    eventType: 'gift_address_draft_consent_withdrawn',
    userId: 'recipient-user',
    resourceId: 'gift-order',
    occurredAt: '2026-11-18T12:00:00.000Z'
  }, {
    env: baseEnv,
    fetchImpl: async (_url, options) => {
      payload = JSON.parse(options.body);
      return new Response(JSON.stringify({ accepted: true, event_id: payload.event_id, sequence: 29 }), { status: 201 });
    }
  });
  assert.equal(result.acknowledged, true);
  assert.equal(result.sequence, 29);
  assert.equal(payload.event_type, 'gift_address_draft_consent_withdrawn');
  assert.notEqual(payload.subject_ref, 'recipient-user');
  assert.notEqual(payload.resource_ref, 'gift-order');
});

test('address draft withdrawal payload requires the exact order resource', async () => {
  await assert.rejects(
    appendPrivacyRecoveryEvent({
      eventType: 'gift_address_draft_consent_withdrawn',
      userId: 'recipient-user'
    }, { env: baseEnv, fetchImpl: async () => { throw new Error('must not call'); } }),
    /invalid_privacy_recovery_event/
  );
});
