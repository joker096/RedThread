import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCompatibilityPayload } from './MatchCompatibilityPanel.tsx';

const payload = {
  overallScore: 84,
  dimensions: [
    { id: 'family', score: 75, alignedCount: 3, total: 4, differences: ['children'] },
    { id: 'budget', score: 100, alignedCount: 4, total: 4, differences: [] },
    { id: 'conflict', score: 80, alignedCount: 4, total: 5, differences: ['fidelity'] },
    { id: 'lifestyle', score: 100, alignedCount: 2, total: 2, differences: [] }
  ],
  yourDealbreakerConflicts: ['children'],
  partnerDealbreakerConflicts: ['fidelity']
};

test('normalizes a complete private compatibility matrix', () => {
  const result = normalizeCompatibilityPayload(payload);
  assert.ok(result);
  assert.equal(result.overallScore, 84);
  assert.equal(result.dimensions.length, 4);
  assert.deepEqual(result.yourDealbreakerConflicts, ['children']);
  assert.deepEqual(result.partnerDealbreakerConflicts, ['fidelity']);
});

test('rejects incomplete, duplicated, out-of-range or unknown compatibility data', () => {
  assert.equal(normalizeCompatibilityPayload(null), null);
  assert.equal(normalizeCompatibilityPayload({ ...payload, overallScore: 101 }), null);
  assert.equal(normalizeCompatibilityPayload({ ...payload, dimensions: payload.dimensions.slice(0, 3) }), null);
  assert.equal(normalizeCompatibilityPayload({ ...payload, yourDealbreakerConflicts: ['password'] }), null);
  assert.equal(normalizeCompatibilityPayload({ ...payload, dimensions: payload.dimensions.map((item, i) => i ? item : { ...item, score: 101 }) }), null);
});
