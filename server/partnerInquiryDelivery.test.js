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
      if (options.sentRowCount === 0 && sql.includes("delivery_status = 'sent'")) return { rowCount: 0 };
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
  const result = await deliverPendingPartnerInquiries(fake.pool, async payload => {
    emails.push(payload);
    return { providerMessageId: 'resend_msg_123' };
  });
  assert.deepEqual(result, { claimed: 1, sent: 1, failed: 0, reconciliationPending: 0 });
  assert.match(fake.calls[1].sql, /FOR UPDATE OF inquiry SKIP LOCKED/);
  assert.match(fake.calls[1].sql, /FOR SHARE OF application/);
  assert.doesNotMatch(fake.calls[1].sql, /FOR SHARE OF active_match|FOR SHARE OF requester/);
  assert.match(fake.calls[1].sql, /JOIN matches active_match[\s\S]*active_match.status = 'active'/);
  assert.match(fake.calls[1].sql, /JOIN users requester[\s\S]*requester.status = 'active'[\s\S]*email_verified_at IS NOT NULL/);
  assert.match(fake.calls[1].sql, /LOWER\(BTRIM\(requester.email\)\) = inquiry.requester_email/);
  assert.match(fake.calls[1].sql, /delivery_status = 'pending'/);
  assert.equal(fake.calls[3].sql, 'COMMIT');
  assert.equal(fake.wasReleased(), true);
  assert.equal(emails[0].to, sample.contactEmail);
  assert.equal(emails[0].idempotencyKey, 'partner-service-inquiry/' + sample.id);
  assert.match(emails[0].html, /&lt;User&gt;/);
  assert.match(emails[0].html, /person@example\.test/);
  assert.match(fake.calls.at(-1).sql, /delivery_status = 'sent'/);
  assert.match(fake.calls.at(-1).sql, /provider_message_id = \$2/);
  assert.deepEqual(fake.calls.at(-1).values, [sample.id, 'resend_msg_123']);
});

test('transport errors remain sending because provider acceptance is ambiguous', async () => {
  const fake = fakePool([sample]);
  const result = await deliverPendingPartnerInquiries(fake.pool, async () => {
    throw new Error('connection reset after provider accepted request');
  });
  assert.deepEqual(result, { claimed: 1, sent: 0, failed: 0, reconciliationPending: 1 });
  assert.equal(fake.calls.some(call => call.sql.includes("delivery_status = 'failed'")), false,
    'a transport exception must never be treated as proof that the provider rejected the email');
  assert.ok(fake.calls.some(call => call.sql.includes("delivery_status = 'reconciliation_required'")),
    'the active sending state must end before moderator reconciliation is allowed');
  const commitIndex = fake.calls.findIndex(call => call.sql === 'COMMIT');
  const reconciliationIndex = fake.calls.findIndex(call => call.sql.includes("delivery_status = 'reconciliation_required'"));
  assert.ok(commitIndex >= 0 && reconciliationIndex > commitIndex,
    'the claim commits before provider I/O and only then becomes eligible for reconciliation');
});

test('database ambiguity after provider acceptance moves out of active sending', async () => {
  const ambiguous = fakePool([sample], { failStatus: true });
  const second = await deliverPendingPartnerInquiries(ambiguous.pool, async () => {});
  assert.deepEqual(second, { claimed: 1, sent: 0, failed: 0, reconciliationPending: 1 });
});

test('worker retains the provider message ID when sent-state persistence becomes ambiguous', async () => {
  const fake = fakePool([sample], { failStatus: true });
  const result = await deliverPendingPartnerInquiries(fake.pool, async () => ({
    providerMessageId: 'resend_msg_worker_123'
  }));
  assert.deepEqual(result, { claimed: 1, sent: 0, failed: 0, reconciliationPending: 1 });
  const recovery = fake.calls.at(-1);
  assert.match(recovery.sql, /delivery_status = 'reconciliation_required'/);
  assert.match(recovery.sql, /provider_message_id = COALESCE/);
  assert.deepEqual(recovery.values, [sample.id, 'resend_msg_worker_123']);
});

test('worker does not count a provider acceptance as sent when the guarded status update changes no row', async () => {
  const fake = fakePool([sample], { sentRowCount: 0 });
  const result = await deliverPendingPartnerInquiries(fake.pool, async () => {});
  assert.deepEqual(result, { claimed: 1, sent: 0, failed: 0, reconciliationPending: 1 });
});

test('worker claim query requires an active match and a still-verified requester email', async () => {
  const fake = fakePool([]);
  await deliverPendingPartnerInquiries(fake.pool, async () => {});
  const sql = fake.calls.find(call => call.sql.includes('SELECT inquiry.id'))?.sql || '';
  assert.match(sql, /JOIN matches active_match/);
  assert.match(sql, /active_match.status = 'active'/);
  assert.match(sql, /JOIN users requester/);
  assert.match(sql, /requester.status = 'active'/);
  assert.match(sql, /requester.email_verified_at IS NOT NULL/);
  assert.match(sql, /requester.email\)\) = inquiry.requester_email/);
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


test('synchronous API moves ambiguous provider outcomes to reconciliation-required', async () => {
  const calls = [];
  const pool = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rowCount: 1 };
    }
  };
  const payload = {
    to: sample.contactEmail,
    idempotencyKey: 'partner-service-inquiry/' + sample.id,
    subject: 'Новый запрос по услуге в Vow',
    html: '<p>consented content</p>'
  };
  const result = await (await import('./partnerInquiryDelivery.js')).deliverClaimedPartnerInquiry(
    pool,
    async sent => {
      assert.deepEqual(sent, payload);
      throw new Error('connection reset after provider accepted the request');
    },
    sample.id,
    payload
  );
  assert.deepEqual(result, { sent: false, emailProviderAccepted: null, deliveryStatus: 'reconciliation_required' });
  assert.equal(calls.length, 1, 'ambiguous provider response must transition out of active sending');
  assert.match(calls[0].sql, /delivery_status = 'reconciliation_required'/,
    'ambiguous provider response must not mark the inquiry failed or sent');
});

test('synchronous API delivery marks sent only after provider acceptance and database confirmation', async () => {
  const calls = [];
  const pool = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rowCount: 1 };
    }
  };
  const result = await (await import('./partnerInquiryDelivery.js')).deliverClaimedPartnerInquiry(
    pool, async () => ({ providerMessageId: 'resend_msg_sync_123' }), sample.id, { idempotencyKey: 'partner-service-inquiry/' + sample.id }
  );
  assert.deepEqual(result, { sent: true, emailProviderAccepted: true, providerMessageId: 'resend_msg_sync_123', deliveryStatus: 'sent' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /delivery_status = 'sent'/);
  assert.deepEqual(calls[0].values, [sample.id, 'resend_msg_sync_123']);
});

test('synchronous API never reports sent when provider acceptance cannot be persisted', async () => {
  let updates = 0;
  const calls = [];
  const pool = { async query(sql, values) {
    calls.push({ sql, values });
    updates += 1;
    if (updates === 1) throw new Error('database connection lost');
    return { rowCount: 1 };
  } };
  const result = await (await import('./partnerInquiryDelivery.js')).deliverClaimedPartnerInquiry(
    pool, async () => ({ providerMessageId: 'resend_msg_ambiguous_123' }), sample.id, {}
  );
  assert.deepEqual(result, { sent: false, emailProviderAccepted: true, providerMessageId: 'resend_msg_ambiguous_123', deliveryStatus: 'reconciliation_required' });
  assert.equal(updates, 2, 'a failed sent-state write must attempt a fail-closed reconciliation transition');
  assert.match(calls[1].sql, /provider_message_id = COALESCE/);
  assert.deepEqual(calls[1].values, [sample.id, 'resend_msg_ambiguous_123']);
});

test('synchronous API does not overwrite a row that is no longer actively sending', async () => {
  const pool = { async query() { return { rowCount: 0 }; } };
  const result = await (await import('./partnerInquiryDelivery.js')).deliverClaimedPartnerInquiry(
    pool, async () => ({ providerMessageId: 'resend_msg_ambiguous_123' }), sample.id, {}
  );
  assert.deepEqual(result, { sent: false, emailProviderAccepted: true, providerMessageId: 'resend_msg_ambiguous_123', deliveryStatus: 'reconciliation_required' });
});
