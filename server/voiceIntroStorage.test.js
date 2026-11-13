import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  decryptVoiceIntro,
  encryptVoiceIntro,
  parseVoiceIntroEncryptionKey,
  parseVoiceIntroEncryptionKeyring,
  resolvePrivateVoiceIntroPath,
  ensurePrivateVoiceIntroStorageRoot,
  validateVoiceIntro,
  persistVoiceIntroReview,
  VOICE_INTRO_LIMITS
} from './voiceIntroStorage.js';

const key = Buffer.alloc(32, 7);

test('voice intro encryption uses authenticated encryption and rejects tampering', () => {
  const plain = Buffer.from('short private voice introduction');
  const encrypted = encryptVoiceIntro(plain, key);
  assert.notDeepEqual(encrypted, plain);
  assert.deepEqual(decryptVoiceIntro(encrypted, key), plain);
  const tampered = Buffer.from(encrypted);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decryptVoiceIntro(tampered, key), /voice_intro_authentication_failed/);
  assert.throws(() => decryptVoiceIntro(Buffer.from('not encrypted'), key), /invalid_voice_intro_ciphertext/);
});

test('voice intro key parser accepts only a 32-byte hexadecimal key', () => {
  assert.equal(parseVoiceIntroEncryptionKey('not-a-key'), null);
  assert.equal(parseVoiceIntroEncryptionKey('a'.repeat(64)).length, 32);
  assert.equal(parseVoiceIntroEncryptionKey('a'.repeat(63)), null);
});

test('voice intro storage paths are constrained to one UUID encrypted file under the private root', () => {
  const id = randomUUID();
  assert.equal(resolvePrivateVoiceIntroPath('/private/voice/' + id + '.enc', '/private/voice'), '/private/voice/' + id + '.enc');
  assert.throws(() => resolvePrivateVoiceIntroPath('/private/voice/../secret.enc', '/private/voice'), /outside the configured storage root/);
  assert.throws(() => resolvePrivateVoiceIntroPath('/private/voice/not-a-uuid.enc', '/private/voice'), /outside the configured storage root/);
});

test('voice intro validation enforces AAC, size and 15–25 second duration using parsed media metadata', async () => {
  const parser = async () => ({ format: { codec: 'AAC', duration: 20 } });
  const valid = await validateVoiceIntro(Buffer.alloc(100), 'audio/mp4; codecs=aac', parser);
  assert.deepEqual(valid, { mimeType: 'audio/mp4', durationMs: 20_000, byteSize: 100 });
  await assert.rejects(() => validateVoiceIntro(Buffer.alloc(100), 'audio/mpeg', parser), /unsupported_voice_intro_format/);
  await assert.rejects(() => validateVoiceIntro(Buffer.alloc(100), 'audio/mp4', async () => ({ format: { codec: 'AAC', duration: 14.9 } })), /voice_intro_duration_out_of_range/);
  await assert.rejects(() => validateVoiceIntro(Buffer.alloc(100), 'audio/mp4', async () => ({ format: { codec: 'AAC', duration: 25.1 } })), /voice_intro_duration_out_of_range/);
  await assert.rejects(() => validateVoiceIntro(Buffer.alloc(100), 'audio/mp4', async () => ({ format: { codec: 'MP3', duration: 20 } })), /invalid_voice_intro_metadata/);
  await assert.rejects(() => validateVoiceIntro(Buffer.alloc(VOICE_INTRO_LIMITS.maxBytes + 1), 'audio/mp4', parser), /voice_intro_too_large/);
});

test('rejecting a voice intro queues encrypted media for purge and writes an audit event', async () => {
  const statements = [];
  const storagePath = '/private/voice/' + randomUUID() + '.enc';
  const client = {
    query: async (sql, params) => {
      statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (sql.includes('UPDATE profile_voice_intros')) {
        return { rows: [{ id: 'voice-1', userId: 'user-1', storagePath }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }
  };
  const result = await persistVoiceIntroReview(client, {
    voiceIntroId: 'voice-1', ownerId: 'user-1', moderatorId: 'moderator-1',
    status: 'rejected', reason: 'manual_review_rejected'
  });
  assert.deepEqual(result, { id: 'voice-1', userId: 'user-1', reviewStatus: 'rejected' });
  const purge = statements.find(item => item.sql.startsWith('INSERT INTO private_voice_intro_purge_queue'));
  assert.ok(purge);
  assert.deepEqual(purge.params, [[storagePath]]);
  assert.ok(statements.some(item => item.sql.startsWith('INSERT INTO moderation_audit_log')));
});

test('approving a voice intro preserves the encrypted media and writes an audit event', async () => {
  const statements = [];
  const client = {
    query: async (sql, params) => {
      statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (sql.includes('UPDATE profile_voice_intros')) {
        return { rows: [{ id: 'voice-2', userId: 'user-2', storagePath: '/private/voice/' + randomUUID() + '.enc' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }
  };
  const result = await persistVoiceIntroReview(client, {
    voiceIntroId: 'voice-2', ownerId: 'user-2', moderatorId: 'moderator-2',
    status: 'approved'
  });
  assert.equal(result.reviewStatus, 'approved');
  assert.equal(statements.some(item => item.sql.startsWith('INSERT INTO private_voice_intro_purge_queue')), false);
  assert.ok(statements.some(item => item.sql.startsWith('INSERT INTO moderation_audit_log')));
});

test('voice intro review rejects invalid status before database writes', async () => {
  let writes = 0;
  await assert.rejects(() => persistVoiceIntroReview({ query: async () => { writes += 1; } }, {
    voiceIntroId: 'voice-3', ownerId: 'user-3', moderatorId: 'moderator-3', status: 'pending'
  }), /invalid_voice_intro_review_status/);
  assert.equal(writes, 0);
});


test('versioned voice envelope resolves key IDs and preserves legacy decryption', () => {
  const legacyKey = Buffer.alloc(32, 7);
  const activeKey = Buffer.alloc(32, 9);
  const keyring = { activeKeyId: 'key_2026_02', keys: new Map([['key_2026_02', activeKey], ['key_2026_01', legacyKey]]), legacyKey };
  const plain = Buffer.from('private recording bytes');
  const versioned = encryptVoiceIntro(plain, keyring);
  assert.ok(versioned.subarray(0, 9).equals(Buffer.from('VOWVOICE2')));
  assert.deepEqual(decryptVoiceIntro(versioned, keyring), plain);
  assert.throws(() => decryptVoiceIntro(versioned, { keys: new Map(), legacyKey }), /key_unavailable/);
  const legacy = encryptVoiceIntro(plain, legacyKey);
  assert.deepEqual(decryptVoiceIntro(legacy, keyring), plain);
  assert.throws(() => decryptVoiceIntro(legacy, { legacyKey: Buffer.alloc(32, 8) }), /authentication_failed/);
});

test('voice keyring parser validates key IDs, active key and key material', () => {
  const a = 'a'.repeat(64), b = 'b'.repeat(64);
  const parsed = parseVoiceIntroEncryptionKeyring({ keyringValue: JSON.stringify({ old_key: a, new_key: b }), activeKeyId: 'new_key', legacyKeyValue: a });
  assert.equal(parsed.activeKeyId, 'new_key');
  assert.equal(parsed.keys.get('old_key').length, 32);
  assert.equal(parsed.legacyKey.length, 32);
  assert.equal(parseVoiceIntroEncryptionKeyring({ keyringValue: '{bad', activeKeyId: 'new_key', legacyKeyValue: a }), null);
  assert.equal(parseVoiceIntroEncryptionKeyring({ keyringValue: JSON.stringify({ new_key: 'bad' }), activeKeyId: 'new_key', legacyKeyValue: a }), null);
  assert.equal(parseVoiceIntroEncryptionKeyring({ keyringValue: JSON.stringify({ old_key: a }), activeKeyId: 'missing', legacyKeyValue: a }), null);
});


test('private voice intro storage root rejects symlinked ancestors and creates nested roots safely', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'vow-voice-storage-root-'));
  const real = path.join(parent, 'real');
  const linked = path.join(parent, 'linked');
  try {
    await mkdir(real);
    await symlink(real, linked, 'dir');
    await assert.rejects(
      ensurePrivateVoiceIntroStorageRoot(path.join(linked, 'nested'), { create: true }),
      /not_private_directory/
    );
    const nested = path.join(real, 'private', 'voice');
    assert.equal(await ensurePrivateVoiceIntroStorageRoot(nested, { create: true }), nested);
    assert.equal(await ensurePrivateVoiceIntroStorageRoot(nested), nested);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
