import { VOICE_INTRO_CONSENT_VERSION } from './voiceIntroConsent.js';

const EXPORT_FORMAT = 'vow-user-data-export';
const EXPORT_VERSION = 1;

async function readRows(db, sql, userId) {
  const result = await db.query(sql, [userId]);
  return result.rows;
}

export async function buildUserDataExport(db, userId, generatedAt = new Date()) {
  if (!db || typeof db.query !== 'function') throw new TypeError('database client is required');
  if (typeof userId !== 'string' || !userId) throw new TypeError('userId is required');

  const accountRows = await readRows(db, `
    SELECT id, email, role, created_at, updated_at, phone_e164, phone_verified_at,
           female_trial_ends_at, premium_until
    FROM users
    WHERE id = $1 AND status = 'active'
  `, userId);
  const account = accountRows[0];
  if (!account) return null;

  const [
    profile, preferences, assessment, likesSent, passesSent, matches, messages,
    blocks, notifications, photos, voiceIntro, adConsent, adConsentHistory,
    adEvents, giftPreferences, giftOrders, giftEvents, billingTransactions,
    identityVerification, identityConsents, l3Submissions, l3Events,
    voiceIntroConsent, voiceIntroConsentEvents, providerProfile, serviceBookings,
    reports
  ] = await Promise.all([
    readRows(db, "SELECT to_jsonb(p) - 'user_id' AS data FROM profiles p WHERE p.user_id = $1", userId),
    readRows(db, "SELECT to_jsonb(p) - 'user_id' AS data FROM profile_preferences p WHERE p.user_id = $1", userId),
    readRows(db, "SELECT to_jsonb(a) - 'user_id' AS data FROM relationship_assessments a WHERE a.user_id = $1", userId),
    readRows(db, `SELECT created_at FROM likes WHERE sender_id = $1 ORDER BY created_at`, userId),
    readRows(db, `SELECT created_at FROM profile_passes WHERE passer_id = $1 ORDER BY created_at`, userId),
    readRows(db, `
      SELECT id, status, created_at
      FROM matches
      WHERE user_a_id = $1 OR user_b_id = $1
      ORDER BY created_at
    `, userId),
    readRows(db, `
      SELECT m.id AS match_id,
             CASE WHEN msg.sender_id = $1 THEN 'sent' ELSE 'received' END AS direction,
             CASE WHEN msg.deleted_at IS NULL THEN msg.body ELSE NULL END AS body,
             msg.created_at, msg.deleted_at
      FROM messages msg
      JOIN matches m ON m.id = msg.match_id
      WHERE m.user_a_id = $1 OR m.user_b_id = $1
      ORDER BY msg.created_at
    `, userId),
    readRows(db, `SELECT created_at FROM user_blocks WHERE blocker_id = $1 ORDER BY created_at`, userId),
    readRows(db, `
      SELECT type, created_at, read_at
      FROM user_notifications
      WHERE user_id = $1
      ORDER BY created_at
    `, userId),
    readRows(db, `
      SELECT id, mime_type, byte_size, width, height, created_at,
             '/api/account/export/media/photo/' || id::text AS "downloadPath"
      FROM photo_assets
      WHERE user_id = $1
      ORDER BY created_at
    `, userId),
    readRows(db, `
      SELECT vi.id, vi.mime_type, vi.byte_size, vi.duration_ms, vi.review_status, vi.reviewed_at,
             vi.created_at, vi.updated_at,
             CASE WHEN EXISTS (
               SELECT 1 FROM profile_voice_intro_consents c
               WHERE c.user_id = vi.user_id AND c.consent_version = ${VOICE_INTRO_CONSENT_VERSION} AND c.withdrawn_at IS NULL
             ) THEN '/api/account/export/media/voice-intro/' || vi.id::text ELSE NULL END AS "downloadPath"
      FROM profile_voice_intros vi
      WHERE user_id = $1
    `, userId),
    readRows(db, `
      SELECT ads_consent, date_offers_consent, wedding_offers_consent,
             marriage_planning_opt_in, category_consents, consent_version, updated_at
      FROM ad_consent_preferences
      WHERE user_id = $1
    `, userId),
    readRows(db, `
      SELECT consent_version, preferences, recorded_at
      FROM ad_consent_history
      WHERE user_id = $1
      ORDER BY recorded_at
    `, userId),
    readRows(db, `
      SELECT campaign_id, event_type, created_at
      FROM ad_events
      WHERE user_id = $1
      ORDER BY created_at
    `, userId),
    readRows(db, `
      SELECT requests_enabled, updated_at
      FROM gift_receiving_preferences
      WHERE user_id = $1
    `, userId),
    readRows(db, `
      SELECT public_reference, product_name_snapshot, product_category,
             total_minor_units, currency, status, payment_status,
             recipient_consent_at, address_verified_at, fulfilment_authorized_at,
             dispatched_at, delivered_at, estimated_delivery_start,
             estimated_delivery_end, expires_at, created_at, updated_at
      FROM gift_delivery_orders
      WHERE sender_id = $1 OR recipient_id = $1
      ORDER BY created_at
    `, userId),
    readRows(db, `
      SELECT e.event_type, e.from_status, e.to_status, e.created_at
      FROM gift_delivery_order_events e
      JOIN gift_delivery_orders o ON o.id = e.order_id
      WHERE o.sender_id = $1 OR o.recipient_id = $1
      ORDER BY e.created_at
    `, userId),
    readRows(db, `
      SELECT plan, status, amount_minor_units, currency_code, occurred_at, received_at
      FROM paddle_transaction_events
      WHERE user_id = $1
      ORDER BY COALESCE(occurred_at, received_at)
    `, userId),
    readRows(db, `
      SELECT provider, status, provider_status, provider_environment, created_at, updated_at
      FROM identity_verifications
      WHERE user_id = $1
    `, userId),
    readRows(db, `
      SELECT consent_version, provider, environment, consented_at
      FROM identity_verification_consents
      WHERE user_id = $1
      ORDER BY consented_at
    `, userId),
    readRows(db, `
      SELECT status, media_mime_type, media_size_bytes, media_duration_seconds,
             uploaded_at, processing_completed_at, reviewed_at, decision_reason_code,
             approved_at, expires_at, revoked_at, media_purged_at, created_at, updated_at
      FROM identity_l3_submissions
      WHERE user_id = $1
      ORDER BY created_at
    `, userId),
    readRows(db, `
      SELECT e.event_type, e.from_status, e.to_status, e.reason_code, e.occurred_at
      FROM identity_l3_decision_events e
      WHERE e.user_id = $1
      ORDER BY e.occurred_at
    `, userId),
    readRows(db, `
      SELECT consent_version, granted_at, withdrawn_at, updated_at
      FROM profile_voice_intro_consents
      WHERE user_id = $1
    `, userId),
    readRows(db, `
      SELECT event_type, consent_version, occurred_at
      FROM profile_voice_intro_consent_events
      WHERE user_id = $1
      ORDER BY occurred_at
    `, userId),
    readRows(db, "SELECT to_jsonb(p) - 'user_id' AS data FROM partner_providers p WHERE p.user_id = $1", userId),
    readRows(db, `
      SELECT service_country, status, request_note, created_at, updated_at
      FROM service_booking_requests
      WHERE requested_by = $1
      ORDER BY created_at
    `, userId),
    readRows(db, `
      SELECT category, details, status, created_at
      FROM user_reports
      WHERE reporter_id = $1
      ORDER BY created_at
    `, userId)
  ]);

  const first = rows => rows[0]?.data ?? null;
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    generatedAt: generatedAt.toISOString(),
    account,
    profile: first(profile),
    profilePreferences: first(preferences),
    relationshipAssessment: first(assessment),
    interactions: { likesSent, passesSent, blocks },
    matches,
    messages,
    notifications,
    photos,
    voiceIntroduction: voiceIntro[0] ?? null,
    advertising: { consent: adConsent[0] ?? null, consentHistory: adConsentHistory, events: adEvents },
    gifts: { receivingPreferences: giftPreferences[0] ?? null, orders: giftOrders, events: giftEvents },
    billingTransactions,
    identityVerification: { current: identityVerification[0] ?? null, consents: identityConsents },
    identityL3: { submissions: l3Submissions, decisionHistory: l3Events },
    voiceIntroductionConsent: { current: voiceIntroConsent[0] ?? null, history: voiceIntroConsentEvents },
    partnerProfile: first(providerProfile),
    serviceBookings,
    reports
  };
}
