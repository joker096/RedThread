import test from 'node:test';
import assert from 'node:assert/strict';
import { lockGiftAddressDraftOrder, withdrawGiftAddressDraft } from './giftAddressDraftService.js';

test('draft order lookup is recipient scoped before acquiring locks', async () => {
  const calls = [];
  const client = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes('SELECT sender_id, recipient_id')) return { rows: [] };
    return { rows: [] };
  }};
  const result = await lockGiftAddressDraftOrder(client, { publicReference: 'gift_x', recipientUserId: 'u1' });
  assert.deepEqual(result, { ok: false, status: 404, error: 'gift_address_draft_not_available' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, ['gift_x', 'u1']);
});

test('withdraw physically deletes ciphertext and appends a versioned withdrawal only after grant', async () => {
  const calls = [];
  const client = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes('SELECT action')) return { rows: [{ action: 'granted' }] };
    if (sql.includes('DELETE FROM gift_address_drafts')) return { rowCount: 1 };
    return { rowCount: 1 };
  }};
  assert.deepEqual(await withdrawGiftAddressDraft(client, {
    orderId: 'o1', recipientUserId: 'u1', actorUserId: 'u1', consentVersion: 1
  }), { deleted: true, withdrawn: true });
  assert.match(calls[1].sql, /DELETE FROM gift_address_drafts/);
  assert.match(calls[2].sql, /'withdrawn'/);
});

test('withdraw without an active grant still deletes any orphaned ciphertext but does not fabricate consent history', async () => {
  const calls = [];
  const client = { async query(sql) {
    calls.push(sql);
    if (sql.includes('SELECT action')) return { rows: [{ action: 'withdrawn' }] };
    if (sql.includes('DELETE FROM gift_address_drafts')) return { rowCount: 1 };
    return { rowCount: 1 };
  }};
  assert.deepEqual(await withdrawGiftAddressDraft(client, { orderId: 'o1', recipientUserId: 'u1' }),
    { deleted: true, withdrawn: false });
  assert.equal(calls.length, 2);
});
