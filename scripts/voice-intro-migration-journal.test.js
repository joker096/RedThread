import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createVoiceIntroMigrationJournalEntry,
  transitionVoiceIntroMigrationJournalEntry,
  isVoiceIntroMigrationJournalState
} from './voice-intro-migration-journal.js';

const id = 'd3f0b8f0-0f1d-4f6f-9a7d-6d7f0a6c5b4e';
const sourcePath = '/private/voice/source.enc';
const stagedPath = '/private/voice/staging/source.v2.enc';
const sourceSha256 = 'a'.repeat(64);
const stagedSha256 = 'b'.repeat(64);
const createdAt = '2026-11-13T10:00:00.000Z';

function makeEntry() {
  return createVoiceIntroMigrationJournalEntry({
    id, sourcePath, sourceSha256, sourceFormat: 'VOWVOICE1',
    targetKeyId: 'voice-2026-02', createdAt
  });
}

test('journal enforces ordered authenticated staging and reference switch', () => {
  const planned = makeEntry();
  const authenticated = transitionVoiceIntroMigrationJournalEntry(
    planned, 'source_authenticated', { now: '2026-11-13T10:01:00.000Z' }
  );
  const staged = transitionVoiceIntroMigrationJournalEntry(
    authenticated, 'staged_authenticated', {
      now: '2026-11-13T10:02:00.000Z', stagedPath, stagedSha256
    }
  );
  const switched = transitionVoiceIntroMigrationJournalEntry(
    staged, 'reference_switched', { now: '2026-11-13T10:03:00.000Z' }
  );
  const rollbackWindow = transitionVoiceIntroMigrationJournalEntry(
    switched, 'rollback_window', { now: '2026-11-13T10:04:00.000Z' }
  );
  const completed = transitionVoiceIntroMigrationJournalEntry(
    rollbackWindow, 'completed', { now: '2026-11-13T10:05:00.000Z' }
  );

  assert.equal(planned.state, 'planned');
  assert.equal(authenticated.state, 'source_authenticated');
  assert.equal(staged.state, 'staged_authenticated');
  assert.equal(switched.state, 'reference_switched');
  assert.equal(rollbackWindow.state, 'rollback_window');
  assert.equal(completed.state, 'completed');
  assert.equal(completed.sourcePath, sourcePath);
  assert.equal(completed.sourceSha256, sourceSha256);
  assert.equal(completed.stagedPath, stagedPath);
  assert.equal(completed.stagedSha256, stagedSha256);
  assert.equal(completed.switchedAt, '2026-11-13T10:03:00.000Z');
  assert.equal(completed.completedAt, '2026-11-13T10:05:00.000Z');
  assert.ok(Object.isFrozen(completed));
  assert.equal(planned.state, 'planned', 'transitions must not mutate prior journal snapshots');
});

test('journal rejects skipped, reversed and terminal transitions', () => {
  const planned = makeEntry();
  assert.throws(() => transitionVoiceIntroMigrationJournalEntry(planned, 'staged_authenticated', {
    now: '2026-11-13T10:01:00.000Z', stagedPath, stagedSha256
  }), /transition_not_allowed/);
  assert.throws(() => transitionVoiceIntroMigrationJournalEntry(planned, 'reference_switched', {
    now: '2026-11-13T10:01:00.000Z'
  }), /transition_not_allowed/);

  const authenticated = transitionVoiceIntroMigrationJournalEntry(
    planned, 'source_authenticated', { now: '2026-11-13T10:01:00.000Z' }
  );
  assert.throws(() => transitionVoiceIntroMigrationJournalEntry(
    authenticated, 'staged_authenticated', {
      now: '2026-11-13T10:02:00.000Z', stagedPath, stagedSha256: 'bad'
    }
  ), /staged_sha256_invalid/);
  assert.throws(() => transitionVoiceIntroMigrationJournalEntry(
    authenticated, 'staged_authenticated', {
      now: '2026-11-13T10:02:00.000Z', stagedPath: sourcePath, stagedSha256
    }
  ), /staged_path_must_differ/);

  const staged = transitionVoiceIntroMigrationJournalEntry(
    authenticated, 'staged_authenticated', {
      now: '2026-11-13T10:02:00.000Z', stagedPath, stagedSha256
    }
  );
  const switched = transitionVoiceIntroMigrationJournalEntry(
    staged, 'reference_switched', { now: '2026-11-13T10:03:00.000Z' }
  );
  const done = transitionVoiceIntroMigrationJournalEntry(
    switched, 'rolled_back', { now: '2026-11-13T10:04:00.000Z' }
  );
  assert.throws(() => transitionVoiceIntroMigrationJournalEntry(
    done, 'completed', { now: '2026-11-13T10:05:00.000Z' }
  ), /transition_not_allowed/);
});

test('journal validates immutable source identity and monotonic timestamps', () => {
  assert.throws(() => createVoiceIntroMigrationJournalEntry({
    id, sourcePath, sourceSha256: 'not-a-digest', sourceFormat: 'VOWVOICE1',
    targetKeyId: 'voice-2026-02', createdAt
  }), /source_sha256_invalid/);
  assert.throws(() => createVoiceIntroMigrationJournalEntry({
    id, sourcePath, sourceSha256, sourceFormat: 'plain', targetKeyId: 'voice-2026-02', createdAt
  }), /source_format_invalid/);
  const planned = makeEntry();
  assert.throws(() => transitionVoiceIntroMigrationJournalEntry(
    planned, 'source_authenticated', { now: '2026-11-13T09:59:59.000Z' }
  ), /timestamp_invalid/);
  assert.equal(isVoiceIntroMigrationJournalState('planned'), true);
  assert.equal(isVoiceIntroMigrationJournalState('unknown'), false);
});
