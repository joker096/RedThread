import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('date-plan notification navigation is retained through unauthenticated or failed match-list loads', async () => {
  const source = await readFile(new URL('./ServerMatchesPanel.tsx', import.meta.url), 'utf8');
  assert.match(source, /if \(!openMatchId \|\| matchesLoading \|\| !authenticated \|\| matchesFailed\) return/);
  assert.ok(
    source.indexOf('if (!openMatchId || matchesLoading || !authenticated || matchesFailed) return;') <
      source.indexOf('onMatchOpenHandled?.();'),
    'navigation must not be acknowledged before the authenticated match list succeeds'
  );
});
