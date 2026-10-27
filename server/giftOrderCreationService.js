import { evaluateGiftOrderCreation } from './giftOrderCreationPolicy.js';
import { resolveProfileCountryCode } from './adCampaignRegistry.js';

export async function acquireGiftOrderRateLocks(client, ...userIds) {
  const orderedIds = [...new Set(userIds.map(value => String(value).toLowerCase()))].sort();
  for (const userId of orderedIds) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('gift-user-rate:' || $1::uuid::text))",
      [userId]
    );
  }
}

export async function recipientGiftAcceptanceLimitReached(client, recipientId) {
  const accepted = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM gift_delivery_orders
     WHERE recipient_id = $1
       AND recipient_consent_at >= NOW() - INTERVAL '7 days'`,
    [recipientId]
  );
  return Number(accepted.rows[0]?.count ?? 0) >= 1;
}

/** Call inside the order-transition transaction so notification and state cannot diverge. */
export async function notifyGiftRequestUpdate(client, userId, orderReference, transition) {
  if (typeof orderReference !== 'string' || !/^gift_[a-f0-9]{32}$/i.test(orderReference) ||
      !['recipient_decision', 'consent_withdrawn'].includes(transition)) {
    throw new Error('invalid_gift_request_update_notification');
  }
  const dedupeKey = 'gift_request_update:' + orderReference + ':' + transition;
  return client.query(
    "INSERT INTO user_notifications (user_id, type, metadata, dedupe_key) VALUES ($1, 'gift_request_update', $2::jsonb, $3) ON CONFLICT (user_id, dedupe_key) DO NOTHING",
    [userId, JSON.stringify({ orderReference }), dedupeKey]
  );
}
export async function expireStaleGiftRequestsForPair(client, { matchId, senderId, recipientId }) {
  const candidates = await client.query(
    `SELECT id, payment_status
     FROM gift_delivery_orders
     WHERE match_id = $1
       AND LEAST(sender_id, recipient_id) = LEAST($2::uuid, $3::uuid)
       AND GREATEST(sender_id, recipient_id) = GREATEST($2::uuid, $3::uuid)
       AND status = 'awaiting_recipient_consent'
       AND expires_at <= NOW()
     ORDER BY id
     FOR UPDATE`,
    [matchId, senderId, recipientId]
  );
  if (candidates.rows.some(row => !['not_started', 'voided', 'failed'].includes(row.payment_status))) {
    return { ok: false, error: 'gift_payment_requires_reconciliation', expiredOrders: [] };
  }
  if (candidates.rows.length === 0) return { ok: true, expiredOrders: [] };

  const expired = await client.query(
    `UPDATE gift_delivery_orders
     SET status = 'expired', updated_at = NOW()
     WHERE id = ANY($1::uuid[])
       AND status = 'awaiting_recipient_consent'
       AND expires_at <= NOW()
       AND payment_status IN ('not_started', 'voided', 'failed')
     RETURNING id, public_reference AS "publicReference"`,
    [candidates.rows.map(row => row.id)]
  );
  for (const order of expired.rows) {
    await client.query(
      `INSERT INTO gift_delivery_order_events
         (order_id, actor_type, event_type, from_status, to_status)
       VALUES ($1, 'system', 'expired', 'awaiting_recipient_consent', 'expired')`,
      [order.id]
    );
  }
  return { ok: true, expiredOrders: expired.rows };
}

export async function acquireGiftSafetyUserLocks(client, ...userIds) {
  const orderedIds = [...new Set(userIds.map(value => String(value).toLowerCase()))].sort();
  for (const userId of orderedIds) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('gift-safety-user:' || $1::uuid::text))",
      [userId]
    );
  }
}

export async function acquireGiftSafetyPairLock(client, firstUserId, secondUserId) {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('gift-safety:' || LEAST($1::uuid, $2::uuid)::text || ':' || GREATEST($1::uuid, $2::uuid)::text))",
    [firstUserId, secondUserId]
  );
}

function deny(status, error) {
  return { status, commit: false, body: { error } };
}

function safeSenderStatus(status) {
  return ['declined', 'expired', 'cancelled', 'blocked', 'reported'].includes(status)
    ? 'not_available'
    : status;
}

function replayResult(row) {
  return {
    status: 200,
    commit: true,
    body: {
      order: {
        id: row.publicReference,
        status: safeSenderStatus(row.status),
        productName: row.productName,
        totalMinorUnits: Number(row.totalMinorUnits),
        currency: row.currency
      },
      replayed: true
    }
  };
}

/**
 * Creates only an unpaid, expiring request for recipient consent.
 * The caller must have started a PostgreSQL transaction and must COMMIT only
 * when the returned result has commit=true. No payment or address access occurs.
 */
export async function createGiftOrderRequest(client, {
  senderId,
  matchId,
  catalogItemId,
  idempotencyKey
}) {
  const preview = await client.query(
    `SELECT user_a_id, user_b_id
     FROM matches
     WHERE id = $1 AND (user_a_id = $2 OR user_b_id = $2)`,
    [matchId, senderId]
  );
  if (!preview.rows[0]) return deny(404, 'gift_match_not_available');

  const recipientId = String(preview.rows[0].user_a_id).toLowerCase() === String(senderId).toLowerCase()
    ? preview.rows[0].user_b_id
    : preview.rows[0].user_a_id;

  // Rate locks use a globally consistent UUID order. Every creation and
  // acceptance path takes these locks before the pair lock, preventing
  // concurrent senders from bypassing the sender/recipient rolling limits.
  await acquireGiftOrderRateLocks(client, senderId, recipientId);
  await acquireGiftSafetyPairLock(client, senderId, recipientId);

  const expiration = await expireStaleGiftRequestsForPair(client, { matchId, senderId, recipientId });
  if (!expiration.ok) return deny(409, expiration.error);
  const reject = (status, error) => ({
    status,
    commit: expiration.expiredOrders.length > 0,
    body: { error }
  });

  const existing = await client.query(
    `SELECT public_reference AS "publicReference", match_id AS "matchId",
            catalog_item_id AS "catalogItemId", status,
            recipient_requests_disabled_at AS "recipientRequestsDisabledAt",
            product_name_snapshot AS "productName",
            total_minor_units::text AS "totalMinorUnits", currency
     FROM gift_delivery_orders
     WHERE sender_id = $1 AND idempotency_key = $2
     FOR UPDATE`,
    [senderId, idempotencyKey]
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (String(row.matchId).toLowerCase() !== String(matchId).toLowerCase() ||
        String(row.catalogItemId || '').toLowerCase() !== String(catalogItemId).toLowerCase()) {
      return reject(409, 'gift_idempotency_key_conflict');
    }
    if (row.status === 'expired') return reject(409, 'gift_request_expired');
    if (row.recipientRequestsDisabledAt != null) return reject(409, 'gift_request_unavailable');

    // Idempotency must not disclose an old order after the relationship's
    // safety state changes. Re-check current account and pair restrictions
    // before returning any previously stored order details.
    const replaySafety = await client.query(
      `SELECT
         sender.status = 'active' AND recipient.status = 'active' AS accounts_active,
         m.status = 'active' AS match_active,
         COALESCE(gp.requests_enabled, FALSE) AS recipient_requests_enabled,
         (sender_profile.birth_date IS NOT NULL AND sender_profile.birth_date <= (CURRENT_DATE - INTERVAL '18 years')::date)
           AND (recipient_profile.birth_date IS NOT NULL AND recipient_profile.birth_date <= (CURRENT_DATE - INTERVAL '18 years')::date)
           AS both_users_adult,
         EXISTS (
           SELECT 1 FROM user_identity_verifications iv
           WHERE iv.user_id = sender.id
             AND iv.status = 'approved'
             AND iv.verified_at <= NOW()
             AND iv.expires_at > NOW()
             AND iv.verification_level >= CASE
               WHEN sender_profile.gender = 'male' THEN 3
               WHEN sender_profile.gender = 'female' THEN 1
               ELSE 2147483647
             END
         ) AS sender_identity_verified,
         EXISTS (
           SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = sender.id AND b.blocked_id = recipient.id)
              OR (b.blocker_id = recipient.id AND b.blocked_id = sender.id)
         ) AS has_block,
         EXISTS (
           SELECT 1 FROM user_reports r
           WHERE r.status IN ('open', 'reviewing')
             AND ((r.reporter_id = sender.id AND r.reported_user_id = recipient.id)
               OR (r.reporter_id = recipient.id AND r.reported_user_id = sender.id))
         ) AS has_open_report,
         EXISTS (
           SELECT 1 FROM user_safety_screenings ss
           WHERE ss.user_id IN (sender.id, recipient.id)
             AND ss.severity = 'high'
             AND ss.review_status IN ('pending', 'reviewing', 'actioned')
         ) AS safety_restricted
       FROM users sender
       JOIN users recipient ON recipient.id = $2
       JOIN matches m ON m.id = $3
         AND ((m.user_a_id = sender.id AND m.user_b_id = recipient.id)
           OR (m.user_b_id = sender.id AND m.user_a_id = recipient.id))
       JOIN profiles sender_profile ON sender_profile.user_id = sender.id
       JOIN profiles recipient_profile ON recipient_profile.user_id = recipient.id
       LEFT JOIN gift_receiving_preferences gp ON gp.user_id = recipient.id
       WHERE sender.id = $1
       FOR UPDATE OF sender, recipient, m, sender_profile, recipient_profile`,
      [senderId, recipientId, matchId]
    );
    const safety = replaySafety.rows[0];
    if (!safety || !safety.accounts_active || !safety.match_active ||
        !safety.recipient_requests_enabled || !safety.both_users_adult ||
        !safety.sender_identity_verified || safety.has_block ||
        safety.has_open_report || safety.safety_restricted) {
      return reject(409, 'gift_request_unavailable');
    }
    return replayResult(row);
  }

  // Missing preferences are opt-out by default. This only creates a disabled
  // row and never enables gift requests on a recipient's behalf.
  await client.query(
    `INSERT INTO gift_receiving_preferences (user_id, requests_enabled)
     VALUES ($1, FALSE)
     ON CONFLICT (user_id) DO NOTHING`,
    [recipientId]
  );

  const contextResult = await client.query(
    `SELECT
       m.id AS match_id,
       m.status AS match_status,
       FLOOR(EXTRACT(EPOCH FROM (NOW() - m.created_at)) / 86400)::int AS match_age_days,
       NOW() AS safety_snapshot_at,
       sender.id AS sender_id,
       sender.status AS sender_status,
       sender_profile.gender AS sender_gender,
       (sender_profile.birth_date IS NOT NULL AND sender_profile.birth_date <= (CURRENT_DATE - INTERVAL '18 years')::date) AS sender_is_adult,
       EXISTS (
         SELECT 1 FROM user_identity_verifications iv
         WHERE iv.user_id = sender.id
           AND iv.status = 'approved'
           AND iv.verified_at <= NOW()
           AND iv.expires_at > NOW()
           AND iv.verification_level >= CASE
             WHEN sender_profile.gender = 'male' THEN 3
             WHEN sender_profile.gender = 'female' THEN 1
             ELSE 2147483647
           END
       ) AS sender_identity_verified,
       EXISTS (
         SELECT 1 FROM user_safety_screenings ss
         WHERE ss.user_id = sender.id AND ss.severity = 'high'
           AND ss.review_status IN ('pending', 'reviewing', 'actioned')
       ) AS sender_safety_restricted,
       recipient.id AS recipient_id,
       recipient.status AS recipient_status,
       recipient_profile.gender AS recipient_gender,
       recipient_profile.birth_date AS recipient_birth_date,
       recipient_profile.country AS recipient_country,
       recipient_profile.city AS recipient_city,
       (recipient_profile.birth_date IS NOT NULL AND recipient_profile.birth_date <= (CURRENT_DATE - INTERVAL '18 years')::date) AS recipient_is_adult,
       EXISTS (
         SELECT 1 FROM user_safety_screenings ss
         WHERE ss.user_id = recipient.id AND ss.severity = 'high'
           AND ss.review_status IN ('pending', 'reviewing', 'actioned')
       ) AS recipient_safety_restricted,
       EXISTS (
         SELECT 1 FROM user_blocks b
         WHERE (b.blocker_id = sender.id AND b.blocked_id = recipient.id)
            OR (b.blocker_id = recipient.id AND b.blocked_id = sender.id)
       ) AS has_block,
       EXISTS (
         SELECT 1 FROM user_reports r
         WHERE r.status IN ('open', 'reviewing')
           AND ((r.reporter_id = sender.id AND r.reported_user_id = recipient.id)
             OR (r.reporter_id = recipient.id AND r.reported_user_id = sender.id))
       ) AS has_open_report
     FROM matches m
     JOIN users sender ON sender.id = $2
     JOIN profiles sender_profile ON sender_profile.user_id = sender.id
     JOIN users recipient ON recipient.id = CASE WHEN m.user_a_id = sender.id THEN m.user_b_id ELSE m.user_a_id END
     JOIN profiles recipient_profile ON recipient_profile.user_id = recipient.id
     WHERE m.id = $1 AND (m.user_a_id = sender.id OR m.user_b_id = sender.id)
     FOR UPDATE OF m, sender, recipient, sender_profile, recipient_profile`,
    [matchId, senderId]
  );
  const contextRow = contextResult.rows[0];
  if (!contextRow) return reject(404, 'gift_match_not_available');

  const preferenceResult = await client.query(
    'SELECT requests_enabled FROM gift_receiving_preferences WHERE user_id = $1 FOR SHARE',
    [recipientId]
  );
  const requestsEnabled = preferenceResult.rows[0]?.requests_enabled === true;

  const countryCode = resolveProfileCountryCode(contextRow.recipient_country);
  if (!countryCode || typeof contextRow.recipient_city !== 'string' || !contextRow.recipient_city.trim()) {
    return reject(409, 'gift_request_unavailable');
  }

  // Both supplier and carrier must be reviewed and the carrier's local fee
  // must be configured; region and fee always come from recipient-side records.
  const productResult = await client.query(
    `SELECT
       item.id AS catalog_item_id,
       item.category,
       item.display_name,
       item.price_minor_units::text AS item_price_minor_units,
       item.currency,
       supplier.status AS supplier_status,
       supplier.privacy_reviewed_at AS supplier_privacy_reviewed_at,
       supplier.contract_reviewed_at AS supplier_contract_reviewed_at,
       partner.id AS delivery_partner_id,
       partner.status AS partner_status,
       coverage.active AS coverage_active,
       coverage.verified_at AS coverage_verified_at,
       coverage.country_code,
       coverage.city_key,
       coverage.delivery_fee_minor_units::text AS delivery_fee_minor_units,
       coverage.delivery_fee_currency
     FROM gift_catalog_items item
     JOIN gift_suppliers supplier ON supplier.supplier_key = item.supplier_key
     JOIN gift_delivery_partner_coverage coverage
       ON coverage.country_code = $2
      AND LOWER(REGEXP_REPLACE(BTRIM(coverage.city_key), '[[:space:]]+', ' ', 'g')) =
          LOWER(REGEXP_REPLACE(BTRIM($3), '[[:space:]]+', ' ', 'g'))
      AND coverage.active = TRUE
      AND coverage.verified_at IS NOT NULL
      AND coverage.verified_at <= NOW()
     JOIN gift_delivery_partners partner ON partner.id = coverage.partner_id
     WHERE item.id = $1
       AND item.active = TRUE AND item.approved = TRUE
       AND supplier.status = 'verified'
       AND supplier.privacy_reviewed_at IS NOT NULL
       AND supplier.contract_reviewed_at IS NOT NULL
       AND partner.status = 'verified'
       AND partner.privacy_reviewed_at IS NOT NULL
       AND partner.contract_reviewed_at IS NOT NULL
       AND coverage.delivery_fee_minor_units IS NOT NULL
       AND coverage.delivery_fee_currency = item.currency
     ORDER BY partner.partner_key
     LIMIT 1
     FOR SHARE OF item, supplier, coverage, partner`,
    [catalogItemId, countryCode, contextRow.recipient_city]
  );
  const productRow = productResult.rows[0];
  if (!productRow) return reject(409, 'gift_request_unavailable');

  const itemPrice = Number(productRow.item_price_minor_units);
  const deliveryFee = Number(productRow.delivery_fee_minor_units);
  const totalPrice = itemPrice + deliveryFee;
  if (!Number.isSafeInteger(itemPrice) || itemPrice <= 0 ||
      !Number.isSafeInteger(deliveryFee) || deliveryFee < 0 ||
      !Number.isSafeInteger(totalPrice) || totalPrice <= 0) {
    return reject(409, 'gift_request_unavailable');
  }

  const activityResult = await client.query(
    `SELECT
       COUNT(*) FILTER (
         WHERE sender_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
       )::int AS sender_requests_last_30_days,
       COUNT(*) FILTER (
         WHERE recipient_id = $2
           AND recipient_consent_at >= NOW() - INTERVAL '7 days'
       )::int AS accepted_gifts_to_recipient_last_7_days
     FROM gift_delivery_orders`,
    [senderId, recipientId]
  );
  const pendingResult = await client.query(
    `SELECT COUNT(*)::int AS pending_requests_for_pair
     FROM gift_delivery_orders
     WHERE match_id = $1
       AND LEAST(sender_id, recipient_id) = LEAST($2::uuid, $3::uuid)
       AND GREATEST(sender_id, recipient_id) = GREATEST($2::uuid, $3::uuid)
       AND status = 'awaiting_recipient_consent'`,
    [matchId, senderId, recipientId]
  );
  const messageResult = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE sender_id = $2)::int AS sender_messages,
       COUNT(*) FILTER (WHERE sender_id = $3)::int AS recipient_messages
     FROM messages
     WHERE match_id = $1 AND deleted_at IS NULL`,
    [matchId, senderId, recipientId]
  );

  const context = {
    sender: {
      id: contextRow.sender_id,
      accountStatus: contextRow.sender_status,
      isAdult: contextRow.sender_is_adult === true,
      identityVerified: contextRow.sender_identity_verified === true,
      safetyRestricted: contextRow.sender_safety_restricted === true
    },
    recipient: {
      id: contextRow.recipient_id,
      accountStatus: contextRow.recipient_status,
      isAdult: contextRow.recipient_is_adult === true,
      safetyRestricted: contextRow.recipient_safety_restricted === true,
      giftRequestsEnabled: requestsEnabled
    },
    match: {
      status: contextRow.match_status,
      includesSender: String(contextRow.sender_id).toLowerCase() === String(senderId).toLowerCase(),
      includesRecipient: String(contextRow.recipient_id).toLowerCase() === String(recipientId).toLowerCase(),
      ageDays: Number(contextRow.match_age_days)
    },
    product: {
      category: productRow.category,
      active: true,
      approved: true,
      supplierVerified: productRow.supplier_status === 'verified' &&
        Boolean(productRow.supplier_privacy_reviewed_at) && Boolean(productRow.supplier_contract_reviewed_at),
      totalMinorUnits: totalPrice,
      currency: productRow.currency
    },
    delivery: {
      partnerVerified: productRow.partner_status === 'verified',
      coverageActive: productRow.coverage_active === true && Boolean(productRow.coverage_verified_at),
      countryCodeMatches: productRow.country_code === countryCode,
      cityKeyMatches: typeof productRow.city_key === 'string' &&
        productRow.city_key.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US') ===
          contextRow.recipient_city.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
    },
    activity: {
      senderMessages: Number(messageResult.rows[0]?.sender_messages ?? 0),
      recipientMessages: Number(messageResult.rows[0]?.recipient_messages ?? 0),
      pendingRequestsForPair: Number(pendingResult.rows[0]?.pending_requests_for_pair ?? 0),
      senderRequestsLast30Days: Number(activityResult.rows[0]?.sender_requests_last_30_days ?? 0),
      acceptedGiftsToRecipientLast7Days: Number(activityResult.rows[0]?.accepted_gifts_to_recipient_last_7_days ?? 0)
    },
    safety: {
      blocked: contextRow.has_block === true,
      openReport: contextRow.has_open_report === true,
      snapshotAt: new Date(contextRow.safety_snapshot_at).toISOString()
    },
    idempotency: { valid: true, duplicate: false }
  };

  const eligibility = evaluateGiftOrderCreation(context);
  if (!eligibility.eligible) {
    if (eligibility.reason === 'sender_request_rate_limit' || eligibility.reason === 'recipient_gift_rate_limit') {
      return reject(429, 'gift_request_rate_limited');
    }
    if (eligibility.reason === 'pending_request_exists') return reject(409, 'gift_request_already_pending');
    return reject(409, 'gift_request_unavailable');
  }

  const inserted = await client.query(
    `INSERT INTO gift_delivery_orders (
       match_id, sender_id, recipient_id, catalog_item_id,
       product_name_snapshot, product_category,
       item_price_minor_units, delivery_fee_minor_units, delivery_fee_currency,
       total_minor_units, currency, delivery_partner_id, status, payment_status, idempotency_key
     )
     VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11, $12,
       'awaiting_recipient_consent', 'not_started', $13
     )
     RETURNING public_reference AS id, status,
               product_name_snapshot AS "productName",
               total_minor_units::text AS "totalMinorUnits", currency,
               expires_at AS "expiresAt"`,
    [
      matchId, senderId, recipientId, catalogItemId,
      productRow.display_name, productRow.category,
      itemPrice, deliveryFee, productRow.delivery_fee_currency,
      totalPrice, productRow.currency, productRow.delivery_partner_id, idempotencyKey
    ]
  );
  const order = inserted.rows[0];
  await client.query(
    `INSERT INTO gift_delivery_order_events
       (order_id, actor_user_id, actor_type, event_type, from_status, to_status, metadata)
     SELECT id, $2, 'sender', 'request_created', NULL, 'awaiting_recipient_consent', $3::jsonb
     FROM gift_delivery_orders WHERE public_reference = $1`,
    [order.id, senderId, JSON.stringify({
      catalogItemId,
      itemPriceMinorUnits: itemPrice,
      deliveryFeeMinorUnits: deliveryFee,
      currency: productRow.currency
    })]
  );

  // Notify the recipient inside the same transaction as the order and audit event.
  // Metadata contains only the public order reference, never location or contact data.
  await client.query(
    `INSERT INTO user_notifications (user_id, type, metadata, dedupe_key)
     VALUES ($1, 'gift_request', $2::jsonb, $3)
     ON CONFLICT (user_id, dedupe_key) DO NOTHING`,
    [recipientId, JSON.stringify({ orderReference: order.id }), `gift_request:${order.id}`]
  );

  return {
    status: 201,
    commit: true,
    body: {
      order: {
        id: order.id,
        status: order.status,
        productName: order.productName,
        totalMinorUnits: Number(order.totalMinorUnits),
        currency: order.currency,
        expiresAt: order.expiresAt
      },
      replayed: false,
      paymentAuthorized: false,
      addressAccessGranted: false
    }
  };
}


/**
 * Lists only server-approved items that pass the same fail-closed eligibility
 * policy as order creation. It deliberately omits recipient region, carrier
 * identity, address and contact data from the response.
 */
export async function listGiftCatalogForMatch(client, { senderId, matchId }) {
  const profileResult = await client.query(
    `SELECT
       m.id AS match_id,
       m.status AS match_status,
       FLOOR(EXTRACT(EPOCH FROM (NOW() - m.created_at)) / 86400)::int AS match_age_days,
       NOW() AS safety_snapshot_at,
       sender.id AS sender_id,
       sender.status AS sender_status,
       sender_profile.gender AS sender_gender,
       (sender_profile.birth_date IS NOT NULL AND sender_profile.birth_date <= (CURRENT_DATE - INTERVAL '18 years')::date) AS sender_is_adult,
       EXISTS (
         SELECT 1 FROM user_identity_verifications iv
         WHERE iv.user_id = sender.id
           AND iv.status = 'approved'
           AND iv.verified_at <= NOW()
           AND iv.expires_at > NOW()
           AND iv.verification_level >= CASE
             WHEN sender_profile.gender = 'male' THEN 3
             WHEN sender_profile.gender = 'female' THEN 1
             ELSE 2147483647
           END
       ) AS sender_identity_verified,
       EXISTS (
         SELECT 1 FROM user_safety_screenings ss
         WHERE ss.user_id = sender.id AND ss.severity = 'high'
           AND ss.review_status IN ('pending', 'reviewing', 'actioned')
       ) AS sender_safety_restricted,
       recipient.id AS recipient_id,
       recipient.status AS recipient_status,
       recipient_profile.birth_date AS recipient_birth_date,
       recipient_profile.country AS recipient_country,
       recipient_profile.city AS recipient_city,
       (recipient_profile.birth_date IS NOT NULL AND recipient_profile.birth_date <= (CURRENT_DATE - INTERVAL '18 years')::date) AS recipient_is_adult,
       EXISTS (
         SELECT 1 FROM user_safety_screenings ss
         WHERE ss.user_id = recipient.id AND ss.severity = 'high'
           AND ss.review_status IN ('pending', 'reviewing', 'actioned')
       ) AS recipient_safety_restricted,
       COALESCE(pref.requests_enabled, FALSE) AS requests_enabled,
       EXISTS (
         SELECT 1 FROM user_blocks b
         WHERE (b.blocker_id = sender.id AND b.blocked_id = recipient.id)
            OR (b.blocker_id = recipient.id AND b.blocked_id = sender.id)
       ) AS has_block,
       EXISTS (
         SELECT 1 FROM user_reports r
         WHERE r.status IN ('open', 'reviewing')
           AND ((r.reporter_id = sender.id AND r.reported_user_id = recipient.id)
             OR (r.reporter_id = recipient.id AND r.reported_user_id = sender.id))
       ) AS has_open_report
     FROM matches m
     JOIN users sender ON sender.id = $2
     JOIN profiles sender_profile ON sender_profile.user_id = sender.id
     JOIN users recipient ON recipient.id = CASE WHEN m.user_a_id = sender.id THEN m.user_b_id ELSE m.user_a_id END
     JOIN profiles recipient_profile ON recipient_profile.user_id = recipient.id
     LEFT JOIN gift_receiving_preferences pref ON pref.user_id = recipient.id
     WHERE m.id = $1 AND m.status = 'active'
       AND (m.user_a_id = sender.id OR m.user_b_id = sender.id)`,
    [matchId, senderId]
  );
  const row = profileResult.rows[0];
  if (!row) return { status: 404, items: [] };

  const countryCode = resolveProfileCountryCode(row.recipient_country);
  if (!countryCode || typeof row.recipient_city !== 'string' || !row.recipient_city.trim()) {
    return { status: 200, items: [] };
  }

  const activityResult = await client.query(
    `SELECT
       COUNT(*) FILTER (
         WHERE sender_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
       )::int AS sender_requests_last_30_days,
       COUNT(*) FILTER (
         WHERE recipient_id = $2
           AND recipient_consent_at >= NOW() - INTERVAL '7 days'
       )::int AS accepted_gifts_to_recipient_last_7_days
     FROM gift_delivery_orders`,
    [senderId, row.recipient_id]
  );
  const pendingResult = await client.query(
    `SELECT COUNT(*)::int AS pending_requests_for_pair
     FROM gift_delivery_orders
     WHERE match_id = $1
       AND LEAST(sender_id, recipient_id) = LEAST($2::uuid, $3::uuid)
       AND GREATEST(sender_id, recipient_id) = GREATEST($2::uuid, $3::uuid)
       AND status = 'awaiting_recipient_consent'`,
    [matchId, senderId, row.recipient_id]
  );
  const messageResult = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE sender_id = $2)::int AS sender_messages,
       COUNT(*) FILTER (WHERE sender_id = $3)::int AS recipient_messages
     FROM messages
     WHERE match_id = $1 AND deleted_at IS NULL`,
    [matchId, senderId, row.recipient_id]
  );

  const baseContext = {
    sender: {
      id: row.sender_id,
      accountStatus: row.sender_status,
      isAdult: row.sender_is_adult === true,
      identityVerified: row.sender_identity_verified === true,
      safetyRestricted: row.sender_safety_restricted === true
    },
    recipient: {
      id: row.recipient_id,
      accountStatus: row.recipient_status,
      isAdult: row.recipient_is_adult === true,
      safetyRestricted: row.recipient_safety_restricted === true,
      giftRequestsEnabled: row.requests_enabled === true
    },
    match: {
      status: row.match_status,
      includesSender: String(row.sender_id).toLowerCase() === String(senderId).toLowerCase(),
      includesRecipient: String(row.recipient_id).toLowerCase() !== String(senderId).toLowerCase(),
      ageDays: Number(row.match_age_days)
    },
    activity: {
      senderMessages: Number(messageResult.rows[0]?.sender_messages ?? 0),
      recipientMessages: Number(messageResult.rows[0]?.recipient_messages ?? 0),
      pendingRequestsForPair: Number(pendingResult.rows[0]?.pending_requests_for_pair ?? 0),
      senderRequestsLast30Days: Number(activityResult.rows[0]?.sender_requests_last_30_days ?? 0),
      acceptedGiftsToRecipientLast7Days: Number(activityResult.rows[0]?.accepted_gifts_to_recipient_last_7_days ?? 0)
    },
    safety: {
      blocked: row.has_block === true,
      openReport: row.has_open_report === true,
      snapshotAt: new Date(row.safety_snapshot_at).toISOString()
    },
    idempotency: { valid: true, duplicate: false }
  };

  const catalogResult = await client.query(
    `SELECT
       item.id AS id,
       item.category,
       item.display_name AS "displayName",
       item.price_minor_units::text AS "itemPriceMinorUnits",
       item.currency,
       supplier.status AS supplier_status,
       supplier.privacy_reviewed_at AS supplier_privacy_reviewed_at,
       supplier.contract_reviewed_at AS supplier_contract_reviewed_at,
       coverage.delivery_fee_minor_units::text AS "deliveryFeeMinorUnits",
       coverage.delivery_fee_currency,
       coverage.country_code,
       coverage.city_key,
       coverage.active AS coverage_active,
       coverage.verified_at AS coverage_verified_at,
       partner.status AS partner_status,
       partner.privacy_reviewed_at AS partner_privacy_reviewed_at,
       partner.contract_reviewed_at AS partner_contract_reviewed_at
     FROM gift_catalog_items item
     JOIN gift_suppliers supplier ON supplier.supplier_key = item.supplier_key
     JOIN gift_delivery_partner_coverage coverage
       ON coverage.country_code = $1
      AND LOWER(REGEXP_REPLACE(BTRIM(coverage.city_key), '[[:space:]]+', ' ', 'g')) =
          LOWER(REGEXP_REPLACE(BTRIM($2), '[[:space:]]+', ' ', 'g'))
      AND coverage.active = TRUE
      AND coverage.verified_at IS NOT NULL
      AND coverage.verified_at <= NOW()
     JOIN gift_delivery_partners partner ON partner.id = coverage.partner_id
     WHERE item.active = TRUE AND item.approved = TRUE
       AND supplier.status = 'verified'
       AND supplier.privacy_reviewed_at IS NOT NULL
       AND supplier.contract_reviewed_at IS NOT NULL
       AND partner.status = 'verified'
       AND partner.privacy_reviewed_at IS NOT NULL
       AND partner.contract_reviewed_at IS NOT NULL
       AND coverage.delivery_fee_minor_units IS NOT NULL
       AND coverage.delivery_fee_currency = item.currency
     ORDER BY item.category, item.display_name
     LIMIT 50`,
    [countryCode, row.recipient_city]
  );

  const items = [];
  for (const product of catalogResult.rows) {
    const itemPrice = Number(product.itemPriceMinorUnits);
    const deliveryFee = Number(product.deliveryFeeMinorUnits);
    const totalPrice = itemPrice + deliveryFee;
    if (!Number.isSafeInteger(itemPrice) || itemPrice <= 0 ||
        !Number.isSafeInteger(deliveryFee) || deliveryFee < 0 ||
        !Number.isSafeInteger(totalPrice) || totalPrice <= 0) continue;

    const eligibility = evaluateGiftOrderCreation({
      ...baseContext,
      product: {
        category: product.category,
        active: true,
        approved: true,
        supplierVerified: product.supplier_status === 'verified' &&
          Boolean(product.supplier_privacy_reviewed_at) && Boolean(product.supplier_contract_reviewed_at),
        totalMinorUnits: totalPrice,
        currency: product.currency
      },
      delivery: {
        partnerVerified: product.partner_status === 'verified' &&
          Boolean(product.partner_privacy_reviewed_at) && Boolean(product.partner_contract_reviewed_at),
        coverageActive: product.coverage_active === true && Boolean(product.coverage_verified_at),
        countryCodeMatches: product.country_code === countryCode,
        cityKeyMatches: typeof product.city_key === 'string' &&
          product.city_key.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US') ===
            row.recipient_city.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
      }
    });
    if (!eligibility.eligible) continue;
    items.push({
      id: product.id,
      category: product.category,
      displayName: product.displayName,
      itemPriceMinorUnits: itemPrice,
      deliveryFeeMinorUnits: deliveryFee,
      totalMinorUnits: totalPrice,
      currency: product.currency
    });
  }
  return { status: 200, items };
}
