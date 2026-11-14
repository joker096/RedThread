import { createHmac } from 'node:crypto';

const RESOURCE_COLLECTION_BY_EVENT = Object.freeze({
  voice_intro_erasure_requested: 'voiceIntros',
  private_photo_erasure_requested: 'photos',
  gift_order_consent_withdrawn: 'giftOrders'
});

const EVENT_TYPES = new Set([
  'account_erasure_requested',
  'voice_intro_consent_withdrawn',
  'voice_intro_erasure_requested',
  'private_photo_erasure_requested',
  'identity_l3_consent_withdrawn',
  'ad_consent_revoked',
  'gift_order_consent_withdrawn'
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REF = /^[a-f0-9]{64}$/i;

function pseudonym(key, id) {
  return createHmac('sha256', key).update(id, 'utf8').digest('hex');
}

function indexCandidates(rows, key) {
  const index = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !UUID.test(row.id || '')) {
      throw new TypeError('privacy_recovery_mapping_candidate_invalid');
    }
    const ref = pseudonym(key, row.id);
    const matches = index.get(ref) || [];
    matches.push(row.id);
    index.set(ref, matches);
  }
  return index;
}

/**
 * Read-only mapping of staged pseudonyms to rows in an isolated restored snapshot.
 * No SQL, filesystem, network or domain mutation is performed.
 */
export function resolvePrivacyRecoveryMappings({
  events,
  pseudonymKey,
  users = [],
  voiceIntros = [],
  photos = [],
  giftOrders = []
}) {
  if (!Array.isArray(events) || typeof pseudonymKey !== 'string' || pseudonymKey.length < 32 ||
      !Array.isArray(users) || !Array.isArray(voiceIntros) ||
      !Array.isArray(photos) || !Array.isArray(giftOrders)) {
    throw new TypeError('privacy_recovery_mapping_input_invalid');
  }

  const indexes = {
    users: indexCandidates(users, pseudonymKey),
    voiceIntros: indexCandidates(voiceIntros, pseudonymKey),
    photos: indexCandidates(photos, pseudonymKey),
    giftOrders: indexCandidates(giftOrders, pseudonymKey)
  };

  return events.map(event => {
    if (!event || typeof event !== 'object' || !EVENT_TYPES.has(event.event_type) ||
        !REF.test(event.subject_ref || '') ||
        (event.resource_ref != null && !REF.test(event.resource_ref))) {
      throw new TypeError('privacy_recovery_mapping_event_invalid');
    }

    const subjectMatches = indexes.users.get(event.subject_ref.toLowerCase()) || [];
    const resourceCollection = RESOURCE_COLLECTION_BY_EVENT[event.event_type] || null;
    const resourceRequired = Boolean(resourceCollection);
    const resourceMatches = resourceCollection && event.resource_ref
      ? indexes[resourceCollection].get(event.resource_ref.toLowerCase()) || []
      : [];

    let status = 'matched';
    if (subjectMatches.length === 0) status = 'subject_unmatched';
    else if (subjectMatches.length > 1) status = 'subject_ambiguous';
    else if (resourceRequired && !event.resource_ref) status = 'resource_reference_missing';
    else if (resourceRequired && resourceMatches.length === 0) status = 'resource_unmatched';
    else if (resourceRequired && resourceMatches.length > 1) status = 'resource_ambiguous';

    return {
      sequence: event.sequence,
      eventId: event.event_id,
      eventType: event.event_type,
      status,
      subjectUserId: subjectMatches.length === 1 ? subjectMatches[0] : null,
      resourceId: resourceRequired && resourceMatches.length === 1 ? resourceMatches[0] : null
    };
  });
}
