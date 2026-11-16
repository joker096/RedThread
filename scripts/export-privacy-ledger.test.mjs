import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { fetchCompleteLedger } from './export-privacy-ledger.mjs';

const secret = 'privacy-ledger-export-test-secret-at-least-32-bytes';
const event = (sequence, overrides = {}) => ({
  sequence,
  event_id: '123e4567-e89b-42d3-a456-42661417400' + sequence,
  schema_version: 1,
  event_type: 'account_erasure_requested',
  subject_ref: 'a'.repeat(64),
  resource_ref: null,
  occurred_at: '2026-11-14T08:00:00.000Z',
  received_at: '2026-11-14T08:00:01.000Z',
  ...overrides
});

function pageResponse(events, watermark, nextAfter) {
  return new Response(JSON.stringify({ events, watermark, next_after: nextAfter }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

test('export reads every event through a pinned watermark', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    const timestamp = options.headers['x-ledger-timestamp'];
    const signedPath = 'GET\n' + parsed.pathname + parsed.search;
    const expected = createHmac('sha256', secret).update(timestamp + '.' + signedPath).digest('hex');
    assert.equal(options.headers['x-ledger-signature'], expected);
    calls.push(parsed.search);
    if (calls.length === 1) return pageResponse([event(1)], 2, 1);
    assert.equal(parsed.searchParams.get('through'), '2');
    return pageResponse([event(2)], 2, 2);
  };
  const result = await fetchCompleteLedger({
    endpoint: 'https://ledger.example.workers.dev',
    authSecret: secret,
    fetchImpl,
    now: () => Date.parse('2026-11-14T08:00:00.000Z'),
    pageSize: 1
  });
  assert.equal(result.watermark, 2);
  assert.deepEqual(result.events.map(item => item.sequence), [1, 2]);
  assert.equal(calls.length, 2);
});

test('export rejects sequence gaps rather than producing an incomplete archive', async () => {
  const fetchImpl = async () => pageResponse([event(2)], 2, 2);
  await assert.rejects(
    fetchCompleteLedger({ endpoint: 'https://ledger.example.workers.dev', authSecret: secret, fetchImpl }),
    /sequence_gap/
  );
});

test('export rejects a changing watermark between pages', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return calls === 1 ? pageResponse([event(1)], 2, 1) : pageResponse([event(2)], 3, 2);
  };
  await assert.rejects(
    fetchCompleteLedger({ endpoint: 'https://ledger.example.workers.dev', authSecret: secret, fetchImpl, pageSize: 1 }),
    /watermark_changed/
  );
});

test('export rejects a missing page before the pinned watermark', async () => {
  const fetchImpl = async () => pageResponse([], 2, 0);
  await assert.rejects(
    fetchCompleteLedger({ endpoint: 'https://ledger.example.workers.dev', authSecret: secret, fetchImpl, pageSize: 1 }),
    /page_gap/
  );
});

test('export refuses non-HTTPS endpoints and weak authentication secrets', async () => {
  await assert.rejects(fetchCompleteLedger({
    endpoint: 'http://ledger.example.workers.dev',
    authSecret: secret,
    fetchImpl: async () => pageResponse([], 0, 0)
  }), /configuration_invalid/);
  await assert.rejects(fetchCompleteLedger({
    endpoint: 'https://ledger.example.workers.dev',
    authSecret: 'short',
    fetchImpl: async () => pageResponse([], 0, 0)
  }), /configuration_invalid/);
});
