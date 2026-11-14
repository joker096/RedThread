import { createHash } from 'node:crypto';

const OUTCOMES = Object.freeze({
  private_photo_erasure_requested: ['photo_erasure_queued', 'photos'],
  voice_intro_erasure_requested: ['voice_intro_erasure_queued', 'voice'],
  voice_intro_consent_withdrawn: ['voice_intro_consent_withdrawn', 'voice_consent']
});

function eventDigest(row) {
  const canonical = [
    String(row.ledger_sequence), row.event_id, String(row.schema_version), row.event_type,
    String(row.subject_ref).toLowerCase(), row.resource_ref?.toLowerCase() ?? null,
    new Date(row.occurred_at).toISOString(), new Date(row.received_at).toISOString()
  ];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertIsolated(env) {
  if (env.NODE_ENV === 'production' || env.PRIVACY_RECOVERY_RESTORE_ISOLATED !== 'true') {
    throw new Error('privacy_recovery_verification_requires_isolated_restore');
  }
}

export async function verifyPrivateMediaPrivacyRecovery({
  pool,
  env = process.env,
  snapshotLedgerSequence,
  throughSequence
}) {
  assertIsolated(env);
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('privacy_recovery_verification_pool_required');
  if (!Number.isSafeInteger(snapshotLedgerSequence) || snapshotLedgerSequence < 0 ||
      !Number.isSafeInteger(throughSequence) || throughSequence < snapshotLedgerSequence) {
    throw new TypeError('privacy_recovery_verification_watermark_invalid');
  }

  const client = await pool.connect();
  let open = false;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    open = true;
    const result = await client.query(
      `SELECT e.ledger_sequence, e.event_id, e.schema_version, e.event_type,
              e.subject_ref, e.resource_ref, e.occurred_at, e.received_at,
              r.event_digest, r.event_type AS receipt_event_type,
              r.outcome_code, x.subject_user_id, x.resource_id
         FROM privacy_recovery_events e
         LEFT JOIN privacy_recovery_replay_receipts r
           ON r.ledger_sequence = e.ledger_sequence AND r.event_id = e.event_id
         LEFT JOIN privacy_recovery_replay_effects x
           ON x.ledger_sequence = e.ledger_sequence AND x.event_id = e.event_id
        WHERE e.ledger_sequence > $1 AND e.ledger_sequence <= $2
        ORDER BY e.ledger_sequence ASC`,
      [snapshotLedgerSequence, throughSequence]
    );
    const events = result.rows || [];
    if (events.length !== throughSequence - snapshotLedgerSequence) {
      throw new Error('privacy_recovery_verification_sequence_range_incomplete');
    }

    const effects = [];
    for (let i = 0; i < events.length; i += 1) {
      const row = events[i];
      if (Number(row.ledger_sequence) !== snapshotLedgerSequence + i + 1) {
        throw new Error('privacy_recovery_verification_sequence_gap');
      }
      const expected = OUTCOMES[row.event_type];
      if (!expected) throw new Error('privacy_recovery_verification_unsupported_event');
      if (!row.event_digest || row.event_type !== row.receipt_event_type ||
          row.outcome_code !== expected[0] || row.event_digest !== eventDigest(row)) {
        throw new Error('privacy_recovery_verification_receipt_mismatch');
      }
      if (!row.subject_user_id ||
          (expected[1] === 'voice_consent' ? row.resource_id !== null : !row.resource_id)) {
        throw new Error('privacy_recovery_verification_effect_missing');
      }
      effects.push(row);
    }

    const photoIds = effects.filter(row => row.event_type === 'private_photo_erasure_requested').map(row => row.resource_id);
    const voiceIds = effects.filter(row => row.event_type === 'voice_intro_erasure_requested').map(row => row.resource_id);
    if (photoIds.length) {
      const remaining = await client.query('SELECT id FROM photo_assets WHERE id = ANY($1::uuid[])', [photoIds]);
      if ((remaining.rows || []).length) throw new Error('privacy_recovery_verification_photo_metadata_remains');
      const urls = await client.query(
        'SELECT user_id, photo_urls FROM profiles WHERE user_id = ANY($1::uuid[])',
        [[...new Set(effects.filter(row => row.event_type === 'private_photo_erasure_requested').map(row => row.subject_user_id))]]
      );
      const removedUrls = new Set(photoIds.map(id => '/api/photos/' + id));
      for (const profile of urls.rows || []) {
        if ((profile.photo_urls || []).some(url => removedUrls.has(url))) {
          throw new Error('privacy_recovery_verification_photo_visibility_remains');
        }
      }
    }
    if (voiceIds.length) {
      const remaining = await client.query('SELECT id FROM profile_voice_intros WHERE id = ANY($1::uuid[])', [voiceIds]);
      if ((remaining.rows || []).length) throw new Error('privacy_recovery_verification_voice_metadata_remains');
    }

    const consentEffects = effects.filter(row => row.event_type === 'voice_intro_consent_withdrawn');
    for (const effect of consentEffects) {
      const consent = await client.query(
        'SELECT withdrawn_at FROM profile_voice_intro_consents WHERE user_id = $1',
        [effect.subject_user_id]
      );
      if (consent.rowCount !== 1 || !consent.rows[0].withdrawn_at) {
        throw new Error('privacy_recovery_verification_voice_consent_active');
      }
      const intros = await client.query(
        'SELECT id FROM profile_voice_intros WHERE user_id = $1',
        [effect.subject_user_id]
      );
      if ((intros.rows || []).length) throw new Error('privacy_recovery_verification_voice_intros_remain');
    }

    const obligationsResult = await client.query(
      `SELECT ledger_sequence, queue_name, storage_path_sha256
         FROM privacy_recovery_replay_purge_obligations
        WHERE ledger_sequence > $1 AND ledger_sequence <= $2`,
      [snapshotLedgerSequence, throughSequence]
    );
    const photoQueue = await client.query('SELECT storage_path FROM private_photo_purge_queue');
    const voiceQueue = await client.query('SELECT storage_path FROM private_voice_intro_purge_queue');
    const queueDigests = {
      private_photo: new Set((photoQueue.rows || []).map(row => sha256(row.storage_path))),
      private_voice_intro: new Set((voiceQueue.rows || []).map(row => sha256(row.storage_path)))
    };
    for (const obligation of obligationsResult.rows || []) {
      if (!queueDigests[obligation.queue_name]?.has(obligation.storage_path_sha256)) {
        throw new Error('privacy_recovery_verification_purge_obligation_missing');
      }
    }

    await client.query('COMMIT');
    open = false;
    return {
      complete: true,
      verifiedEventCount: events.length,
      verifiedPhotoErasureCount: photoIds.length,
      verifiedVoiceErasureCount: voiceIds.length,
      verifiedVoiceConsentWithdrawalCount: consentEffects.length,
      verifiedPurgeObligationCount: (obligationsResult.rows || []).length,
      throughSequence
    };
  } catch (error) {
    if (open) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
    }
    throw error;
  } finally {
    client.release();
  }
}
