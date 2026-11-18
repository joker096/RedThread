import { createHash } from 'node:crypto';
import { assertPrivacyRecoveryRestoreTarget, assertPrivacyRecoveryRestoreTargetConfig } from './privacyRecoveryTargetGuard.js';

const OUTCOMES = Object.freeze({
  private_photo_erasure_requested: ['photo_erasure_queued', 'photos'],
  voice_intro_erasure_requested: ['voice_intro_erasure_queued', 'voice'],
  voice_intro_consent_withdrawn: ['voice_intro_consent_withdrawn', 'voice_consent'],
  identity_l3_consent_withdrawn: ['identity_l3_consent_withdrawn', 'identity_l3_consent']
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
  assertPrivacyRecoveryRestoreTargetConfig(env);
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
    await assertPrivacyRecoveryRestoreTarget(client, env);
    const result = await client.query(
      `SELECT e.ledger_sequence, e.event_id, e.schema_version, e.event_type,
              e.subject_ref, e.resource_ref, e.occurred_at, e.received_at,
              r.event_digest, r.event_type AS receipt_event_type,
              r.outcome_code, x.event_type AS effect_event_type, x.subject_user_id, x.resource_id, x.purge_count
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
      if (!row.event_digest || row.event_type !== row.receipt_event_type || row.event_type !== row.effect_event_type ||
          row.outcome_code !== expected[0] || row.event_digest !== eventDigest(row)) {
        throw new Error('privacy_recovery_verification_receipt_mismatch');
      }
      if (!row.subject_user_id ||
          (['voice_consent', 'identity_l3_consent'].includes(expected[1]) ? row.resource_id !== null : !row.resource_id) ||
          !Number.isSafeInteger(Number(row.purge_count)) || Number(row.purge_count) < 0 ||
          (!['voice_consent', 'identity_l3_consent'].includes(expected[1]) && Number(row.purge_count) !== 1)) {
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

    const l3Effects = effects.filter(row => row.event_type === 'identity_l3_consent_withdrawn');
    for (const effect of l3Effects) {
      const consent = await client.query(
        'SELECT withdrawn_at FROM identity_l3_consents WHERE user_id = $1',
        [effect.subject_user_id]
      );
      if (consent.rowCount !== 1 || !consent.rows[0].withdrawn_at) {
        throw new Error('privacy_recovery_verification_identity_l3_consent_active');
      }
      const tokens = await client.query(
        `SELECT id FROM identity_l3_upload_tokens
          WHERE user_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`,
        [effect.subject_user_id]
      );
      if ((tokens.rows || []).length) {
        throw new Error('privacy_recovery_verification_identity_l3_upload_token_active');
      }
      const submissions = await client.query(
        `SELECT id FROM identity_l3_submissions
          WHERE user_id = $1
            AND (
              status IN ('draft', 'upload_authorized', 'uploaded', 'processing', 'pending_review', 'approved')
              OR storage_object_key IS NOT NULL
            )`,
        [effect.subject_user_id]
      );
      if ((submissions.rows || []).length) {
        throw new Error('privacy_recovery_verification_identity_l3_media_remains');
      }
      const jobs = await client.query(
        `SELECT id FROM identity_l3_media_purge_jobs
          WHERE user_id = $1 AND status <> 'completed'`,
        [effect.subject_user_id]
      );
      if ((jobs.rows || []).length) {
        throw new Error('privacy_recovery_verification_identity_l3_purge_incomplete');
      }
    }

    const obligationsResult = await client.query(
      `SELECT ledger_sequence, queue_name, storage_path_sha256
         FROM privacy_recovery_replay_purge_obligations
        WHERE ledger_sequence > $1 AND ledger_sequence <= $2`,
      [snapshotLedgerSequence, throughSequence]
    );
    const obligationRows = obligationsResult.rows || [];
    for (const row of effects) {
      const expectedQueue = row.event_type === 'private_photo_erasure_requested'
        ? 'private_photo'
        : row.event_type === 'identity_l3_consent_withdrawn'
          ? 'identity_l3_media' : 'private_voice_intro';
      const eventObligations = obligationRows.filter(item =>
        String(item.ledger_sequence) === String(row.ledger_sequence)
      );
      if (eventObligations.length !== Number(row.purge_count) ||
          eventObligations.some(item => item.queue_name !== expectedQueue)) {
        throw new Error('privacy_recovery_verification_purge_obligation_missing');
      }
    }
    const completionResult = await client.query(
      `SELECT ledger_sequence, queue_name, storage_path_sha256
         FROM privacy_recovery_replay_purge_completions
        WHERE ledger_sequence > $1 AND ledger_sequence <= $2`,
      [snapshotLedgerSequence, throughSequence]
    );
    const completionRows = completionResult.rows || [];
    if (completionRows.length !== obligationRows.length) {
      throw new Error('privacy_recovery_verification_purge_completion_missing');
    }
    const photoQueue = await client.query('SELECT storage_path FROM private_photo_purge_queue');
    const voiceQueue = await client.query('SELECT storage_path FROM private_voice_intro_purge_queue');
    const l3Objects = await client.query('SELECT storage_object_key FROM identity_l3_submissions WHERE storage_object_key IS NOT NULL');
    const queueDigests = {
      private_photo: new Set((photoQueue.rows || []).map(row => sha256(row.storage_path))),
      private_voice_intro: new Set((voiceQueue.rows || []).map(row => sha256(row.storage_path))),
      identity_l3_media: new Set((l3Objects.rows || []).map(row => sha256(row.storage_object_key)))
    };
    for (const obligation of obligationRows) {
      const completionCount = completionRows.filter(item =>
        String(item.ledger_sequence) === String(obligation.ledger_sequence) &&
        item.queue_name === obligation.queue_name &&
        item.storage_path_sha256 === obligation.storage_path_sha256
      ).length;
      if (completionCount !== 1) {
        throw new Error('privacy_recovery_verification_purge_completion_missing');
      }
      if (queueDigests[obligation.queue_name]?.has(obligation.storage_path_sha256)) {
        throw new Error('privacy_recovery_verification_purge_still_queued');
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
      verifiedPurgeObligationCount: obligationRows.length,
      verifiedPurgeCompletionCount: completionRows.length,
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
