import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('changing a proposed venue resets the public-place attestation', async () => {
  const source = await readFile(new URL('./DatePlanPanel.tsx', import.meta.url), 'utf8');
  assert.match(source, /if \(nextVenue !== venueName\) setIsPublicVenue\(false\)/);
});

test('date-plan action errors remain visible after the state refresh', async () => {
  const source = await readFile(new URL('./DatePlanPanel.tsx', import.meta.url), 'utf8');
  assert.match(source, /const actionError = cause instanceof Error[\s\S]*?await refresh\(\);\s*setError\(actionError\);/);
});
