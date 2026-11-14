import test from 'node:test';
import assert from 'node:assert/strict';
import {
  transitionVoiceIntroMigrationState,
  claimNextVoiceIntroMigration
} from './voiceIntroMigrationRepository.js';

const validId = '11111111-1111-4111-8111-111111111111';
const validToken = '22222222-2222-4222-8222-222222222222';

test('migration repository refuses non-atomic pointer and terminal transitions', async () => {
  const poolMustNotBeUsed = {
    async connect() { throw new Error('database_must_not_be_touched'); }
  };
  for (const nextState of ['reference_switched', 'completed', 'rolled_back']) {
    await assert.rejects(transitionVoiceIntroMigrationState(poolMustNotBeUsed, {
      id: validId,
      token: validToken,
      generation: 1,
      expectedState: nextState === 'reference_switched' ? 'staged_authenticated' :
        nextState === 'completed' ? 'rollback_window' : 'reference_switched',
      expectedVersion: 3,
      nextState,
      patch: nextState === 'completed' ? {} : undefined
    }), /requires_atomic_repository_method/);
  }
});

test('migration lease claim validates worker identity before connecting to PostgreSQL', async () => {
  const poolMustNotBeUsed = {
    async connect() { throw new Error('database_must_not_be_touched'); }
  };
  await assert.rejects(
    claimNextVoiceIntroMigration(poolMustNotBeUsed, { workerId: '   ' }),
    /worker_id_invalid/
  );
});
