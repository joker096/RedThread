import {
  acquireGiftSafetyPairLock,
  acquireGiftSafetyUserLocks
} from './giftOrderCreationService.js';

export async function lockGiftAddressDraftOrder(client, { publicReference, recipientUserId } = {}) {
  const pair = await client.query(
    `SELECT sender_id, recipient_id
       FROM gift_delivery_orders
      WHERE public_reference = $1 AND recipient_id = $2`,
    [publicReference, recipientUserId]
  );
  if (!pair.rows[0]) return { ok: false, status: 404, error: 'gift_address_draft_not_available' };

  const { sender_id: senderId, recipient_id: recipientId } = pair.rows[0];
  await acquireGiftSafetyUserLocks(client, senderId, recipientId);
  await acquireGiftSafetyPairLock(client, senderId, recipientId);

  const accounts = await client.query(
    'SELECT id, status FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE',
    [[senderId, recipientId]]
  );
  if (accounts.rowCount !== 2 || accounts.rows.some(row => row.status !== 'active')) {
    return { ok: false, status: 409, error: 'gift_address_draft_not_available' };
  }

  const selected = await client.query(
    `SELECT o.id, o.sender_id, o.recipient_id, o.status, o.expires_at,
            o.consent_withdrawn_at, m.status AS match_status,
            EXISTS (
              SELECT 1 FROM user_blocks b
               WHERE (b.blocker_id = o.sender_id AND b.blocked_id = o.recipient_id)
                  OR (b.blocker_id = o.recipient_id AND b.blocked_id = o.sender_id)
            ) AS has_block,
            EXISTS (
              SELECT 1 FROM user_reports r
               WHERE r.status IN ('open', 'reviewing')
                 AND ((r.reporter_ref = o.sender_id AND r.reported_user_ref = o.recipient_id)
                   OR (r.reporter_ref = o.recipient_id AND r.reported_user_ref = o.sender_id))
            ) AS has_open_report,
            EXISTS (
              SELECT 1 FROM user_safety_screenings ss
               WHERE ss.user_id IN (o.sender_id, o.recipient_id)
                 AND ss.severity = 'high'
                 AND ss.review_status IN ('pending', 'reviewing', 'actioned')
            ) AS safety_restricted
       FROM gift_delivery_orders o
       JOIN matches m ON m.id = o.match_id
      WHERE o.public_reference = $1 AND o.recipient_id = $2
        AND o.expires_at > statement_timestamp()
      FOR UPDATE OF o`,
    [publicReference, recipientUserId]
  );
  const order = selected.rows[0];
  if (!order || order.status !== 'recipient_accepted' ||
      order.consent_withdrawn_at != null ||
      new Date(order.expires_at).getTime() <= Date.now() ||
      order.match_status !== 'active' || order.has_block ||
      order.has_open_report || order.safety_restricted) {
    return { ok: false, status: 409, error: 'gift_address_draft_not_available' };
  }
  return { ok: true, order };
}

export async function withdrawGiftAddressDraft(client, {
  orderId, recipientUserId, actorUserId = null, consentVersion = 1
} = {}) {
  const current = await client.query(
    `SELECT action FROM gift_address_draft_consent_events
      WHERE order_id = $1 AND recipient_user_id = $2
      ORDER BY id DESC LIMIT 1`,
    [orderId, recipientUserId]
  );
  const deleted = await client.query(
    'DELETE FROM gift_address_drafts WHERE order_id = $1 AND recipient_user_id = $2',
    [orderId, recipientUserId]
  );
  if (current.rows[0]?.action === 'granted') {
    await client.query(
      `INSERT INTO gift_address_draft_consent_events
         (order_id, recipient_user_id, consent_version, action, actor_user_id)
       VALUES ($1, $2, $3, 'withdrawn', $4)`,
      [orderId, recipientUserId, consentVersion, actorUserId]
    );
  }
  return { deleted: deleted.rowCount > 0, withdrawn: current.rows[0]?.action === 'granted' };
}
