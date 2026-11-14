import { createHash, createHmac } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { acquireGiftSafetyUserLocks } from './giftOrderCreationService.js';
import { resolvePrivatePhotoPath, queuePrivatePhotoPurges } from './photoPurge.js';
import {
  ensurePrivateVoiceIntroStorageRoot,
  resolvePrivateVoiceIntroPath,
  queuePrivateVoiceIntroPurges
} from './voiceIntroStorage.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_OUTCOMES = Object.freeze({
  private_photo_erasure_requested: ['photo_erasure_queued', 'photos'],
  voice_intro_erasure_requested: ['voice_intro_erasure_queued', 'voice'],
  voice_intro_consent_withdrawn: ['voice_intro_consent_withdrawn', 'voice_consent']
});

function canonicalEvent(row) {
  return [
    String(row.ledger_sequence), row.event_id, String(row.schema_version), row.event_type,
    String(row.subject_ref).toLowerCase(), row.resource_ref?.toLowerCase() ?? null,
    new Date(row.occurred_at).toISOString(), new Date(row.received_at).toISOString()
  ];
}

function digestEvent(row) {
  return createHash('sha256').update(JSON.stringify(canonicalEvent(row))).digest('hex');
}

function assertUuid(value, code) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(code);
}

function assertMapping(row, mapping, pseudonymKey) {
  if (!mapping || mapping.status !== 'matched' || typeof pseudonymKey !== 'string' || pseudonymKey.length < 32) {
    throw new Error('privacy_recovery_mapping_unresolved');
  }
  assertUuid(mapping.subjectUserId, 'privacy_recovery_subject_mapping_invalid');
  const subjectRef = createHmac('sha256', pseudonymKey).update(mapping.subjectUserId, 'utf8').digest('hex');
  if (subjectRef !== String(row.subject_ref).toLowerCase()) throw new Error('privacy_recovery_subject_mapping_mismatch');
  if (row.event_type !== 'voice_intro_consent_withdrawn') {
    assertUuid(mapping.resourceId, 'privacy_recovery_resource_mapping_invalid');
    const resourceRef = createHmac('sha256', pseudonymKey).update(mapping.resourceId, 'utf8').digest('hex');
    if (resourceRef !== String(row.resource_ref || '').toLowerCase()) throw new Error('privacy_recovery_resource_mapping_mismatch');
  }
}

async function assertPhotoRoot(storageRoot) {
  if (typeof storageRoot !== 'string' || storageRoot.trim() === '') throw new Error('privacy_recovery_photo_root_required');
  const root = path.resolve(storageRoot);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) {
    throw new Error('privacy_recovery_photo_root_not_private_directory');
  }
  return root;
}

async function readStagedEvent(client, mapping) {
  const result = await client.query(
    `SELECT ledger_sequence, event_id, schema_version, event_type, subject_ref,
            resource_ref, occurred_at, received_at
       FROM privacy_recovery_events
      WHERE ledger_sequence = $1 AND event_id = $2
      FOR SHARE`,
    [mapping.sequence, mapping.eventId]
  );
  if (result.rowCount !== 1) throw new Error('privacy_recovery_staged_event_missing');
  return result.rows[0];
}

/**
 * Apply one mapped photo/voice event to an isolated restored database.
 * The database receipt and domain mutations commit atomically. This function
 * only queues encrypted/private files; it never unlinks files or starts workers.
 */
export async function applyPrivateMediaPrivacyRecoveryEvent({
  pool,
  mapping,
  pseudonymKey,
  photoStorageRoot,
  voiceStorageRoot
}) {
  if (!pool || typeof pool.connect !== 'function' || !mapping ||
      !Object.hasOwn(EVENT_OUTCOMES, mapping.eventType)) {
    throw new TypeError('privacy_recovery_media_executor_input_invalid');
  }

  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;

    // Check an existing receipt before requiring resource mapping: a successful
    // first execution intentionally removed that resource's live row.
    const receiptLookup = await client.query(
      `SELECT ledger_sequence, event_id, event_digest, event_type, outcome_code
         FROM privacy_recovery_replay_receipts
        WHERE ledger_sequence = $1 OR event_id = $2
        FOR UPDATE`,
      [mapping.sequence, mapping.eventId]
    );
    const staged = await readStagedEvent(client, mapping);
    if (staged.event_type !== mapping.eventType) throw new Error('privacy_recovery_event_type_mismatch');
    const digest = digestEvent(staged);
    if (receiptLookup.rowCount) {
      const receipt = receiptLookup.rows[0];
      if (receiptLookup.rowCount !== 1 ||
          String(receipt.ledger_sequence) !== String(mapping.sequence) ||
          receipt.event_id !== mapping.eventId ||
          receipt.event_digest !== digest ||
          receipt.event_type !== mapping.eventType) {
        throw new Error('privacy_recovery_replay_receipt_conflict');
      }
      await client.query('COMMIT');
      transactionOpen = false;
      return { applied: false, alreadyApplied: true, outcome: receipt.outcome_code };
    }

    assertMapping(staged, mapping, pseudonymKey);
    const [outcome, kind] = EVENT_OUTCOMES[mapping.eventType];
    await acquireGiftSafetyUserLocks(client, mapping.subjectUserId);
    const account = await client.query(
      'SELECT id FROM users WHERE id = $1 FOR UPDATE',
      [mapping.subjectUserId]
    );
    if (account.rowCount !== 1) throw new Error('privacy_recovery_subject_missing');

    if (kind === 'photos') {
      const root = await assertPhotoRoot(photoStorageRoot);
      const asset = await client.query(
        'SELECT id, user_id, storage_path FROM photo_assets WHERE id = $1 FOR UPDATE',
        [mapping.resourceId]
      );
      if (asset.rowCount !== 1 || asset.rows[0].user_id !== mapping.subjectUserId) {
        throw new Error('privacy_recovery_photo_owner_or_asset_conflict');
      }
      resolvePrivatePhotoPath(asset.rows[0].storage_path, root);
      const profile = await client.query(
        'SELECT photo_urls FROM profiles WHERE user_id = $1 FOR UPDATE',
        [mapping.subjectUserId]
      );
      if (profile.rowCount !== 1) throw new Error('privacy_recovery_photo_profile_missing');
      const photoUrl = '/api/photos/' + mapping.resourceId;
      await client.query(
        `UPDATE profiles
            SET photo_urls = array_remove(COALESCE(photo_urls, '{}'::text[]), $2),
                updated_at = statement_timestamp()
          WHERE user_id = $1`,
        [mapping.subjectUserId, photoUrl]
      );
      await queuePrivatePhotoPurges(client, [asset.rows[0].storage_path]);
      await client.query('DELETE FROM photo_assets WHERE id = $1 AND user_id = $2', [mapping.resourceId, mapping.subjectUserId]);
    } else if (kind === 'voice') {
      const root = await ensurePrivateVoiceIntroStorageRoot(voiceStorageRoot);
      const asset = await client.query(
        'SELECT id, user_id, storage_path FROM profile_voice_intros WHERE id = $1 FOR UPDATE',
        [mapping.resourceId]
      );
      if (asset.rowCount !== 1 || asset.rows[0].user_id !== mapping.subjectUserId) {
        throw new Error('privacy_recovery_voice_owner_or_asset_conflict');
      }
      resolvePrivateVoiceIntroPath(asset.rows[0].storage_path, root);
      await queuePrivateVoiceIntroPurges(client, [asset.rows[0].storage_path]);
      await client.query('DELETE FROM profile_voice_intros WHERE id = $1 AND user_id = $2', [mapping.resourceId, mapping.subjectUserId]);
    } else {
      const root = await ensurePrivateVoiceIntroStorageRoot(voiceStorageRoot);
      const consent = await client.query(
        'SELECT consent_version, withdrawn_at FROM profile_voice_intro_consents WHERE user_id = $1 FOR UPDATE',
        [mapping.subjectUserId]
      );
      if (consent.rowCount !== 1 || consent.rows[0].withdrawn_at) {
        throw new Error('privacy_recovery_voice_consent_state_conflict');
      }
      const assets = await client.query(
        'SELECT id, storage_path FROM profile_voice_intros WHERE user_id = $1 ORDER BY id FOR UPDATE',
        [mapping.subjectUserId]
      );
      for (const asset of assets.rows) resolvePrivateVoiceIntroPath(asset.storage_path, root);
      await queuePrivateVoiceIntroPurges(client, assets.rows.map(asset => asset.storage_path));
      await client.query('DELETE FROM profile_voice_intros WHERE user_id = $1', [mapping.subjectUserId]);
      const withdrawn = await client.query(
        `UPDATE profile_voice_intro_consents
            SET withdrawn_at = statement_timestamp(), updated_at = statement_timestamp()
          WHERE user_id = $1
          RETURNING consent_version, withdrawn_at`,
        [mapping.subjectUserId]
      );
      await client.query(
        `INSERT INTO profile_voice_intro_consent_events
           (user_id, actor_user_id, event_type, consent_version, occurred_at)
         VALUES ($1, $1, 'withdrawn', $2, $3)`,
        [mapping.subjectUserId, withdrawn.rows[0].consent_version, withdrawn.rows[0].withdrawn_at]
      );
    }

    await client.query(
      `INSERT INTO privacy_recovery_replay_receipts
         (ledger_sequence, event_id, event_digest, event_type, outcome_code)
       VALUES ($1, $2, $3, $4, $5)`,
      [mapping.sequence, mapping.eventId, digest, mapping.eventType, outcome]
    );
    await client.query('COMMIT');
    transactionOpen = false;
    return { applied: true, alreadyApplied: false, outcome };
  } catch (error) {
    if (transactionOpen) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
    }
    throw error;
  } finally {
    client.release();
  }
}
