import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverPendingPartnerInquiries } from './partnerInquiryDelivery.js';

function fakePool(rows = [], options = {}) {
  const calls = [];
  let released = false;
  const client = {
    async query(sql, values) {
      calls.push({ sql, values, scope: 'client' });
      if (sql.trimStart().startsWith('SELECT inquiry.id')) return { rows };
      if (options.failClaim && sql.startsWith('UPDATE partner_service_inquiries')) throw new Error('claim failed');
      return { rowCount: 1 };
    },
    release() { released = true; }
  };
  const pool = {
    async connect() { return client; },
    async query(sql, values) {
      calls.push({ sql, values, scope: 'pool' });
      if (options.failStatus && sql.includes("delivery_status = 'sent'")) throw new Error('status failed');
      return { rowCount: 1 };
    }
  };
  return { pool, calls, wasReleased: () => released };
}

const sample = {
  id: '00000000-0000-4000-8000-000000000001',
  requesterName: '<User>',
  requesterEmail: 'person@example.test',
  serviceDate: '2026-12-24',
  requestNote: 'Please share available dates and prices.',
  contactEmail: 'provider@example.test'
};

test('pending partner inquiries are claimed with row locks and sent with a stable idempotency key', async () => {
  const fake = fakePool([sample]);
  const emails = [];
  const result = await deliverPendingPartnerInquiries(fake.pool, async payload => emails.push(payload));
  assert.deepEqual(result, { claimed: 1, sent: 1, failed: 0, reconciliationPending: 0 });
  assert.match(fake.calls[1].sql, /FOR UPDATE OF inquiry SKIP LOCKED/);
  assert.match(fake.calls[1].sql, /FOR SHARE OF application/);
  assert.match(fake.calls[1].sql, /delivery_status = 'pending'/);
  assert.equal(fake.calls[3].sql, 'COMMIT');
  assert.equal(fake.wasReleased(), true);
  assert.equal(emails[0].to, sample.contactEmail);
  assert.equal(emails[0].idempotencyKey, 'partner-service-inquiry/' + sample.id);
  assert.match(emails[0].html, /&lt;User&gt;/);
  assert.match(emails[0].html, /person@example\.test/);
  assert.match(fake.calls.at(-1).sql, /delivery_status = 'sent'/);
});

test('transport errors remain sending because provider acceptance is ambiguous', async () => {
  const fake = fakePool([sample]);
  const result = await deliverPendingPartnerInquiries(fake.pool, async () => {
    throw new Error('connection reset after provider accepted request');
  });
  assert.deepEqual(result, { claimed: 1, sent: 0, failed: 0, reconciliationPending: 1 });
  assert.equal(fake.calls.some(call => call.sql.includes("delivery_status = 'failed'")), false,
    'a transport exception must never be treated as proof that the provider rejected the email');
  assert.equal(fake.calls.at(-1).sql, 'COMMIT',
    'the claim transaction commits before the external provider call');
});

test('database ambiguity after provider acceptance remains sending', async () => {
  const ambiguous = fakePool([sample], { failStatus: true });
  const second = await deliverPendingPartnerInquiries(ambiguous.pool, async () => {});
  assert.deepEqual(second, { claimed: 1, sent: 0, failed: 0, reconciliationPending: 1 });
});

test('empty queue does not call email provider', async () => {
  const fake = fakePool([]);
  let calls = 0;
  const result = await deliverPendingPartnerInquiries(fake.pool, async () => { calls += 1; });
  assert.deepEqual(result, { claimed: 0, sent: 0, failed: 0, reconciliationPending: 0 });
  assert.equal(calls, 0);
});

test('invalid batch limits fail before connecting to the database', async () => {
  let connections = 0;
  const pool = { async connect() { connections += 1; } };
  await assert.rejects(() => deliverPendingPartnerInquiries(pool, async () => {}, { limit: 0 }), RangeError);
  assert.equal(connections, 0);
});
