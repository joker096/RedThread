import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('sending a chat message enforces the same Premium entitlement as reading chat history', async () => {
  const source = await readFile(new URL('./index.js', import.meta.url), 'utf8');
  assert.match(
    source,
    /app\.post\('\/api\/matches\/:matchId\/messages',\s*messageLimiter,\s*validateRequestOrigin,\s*requireSession,\s*requirePaidFeatures,\s*async/
  );
  assert.match(
    source,
    /app\.get\('\/api\/matches\/:matchId\/messages',\s*requireSession,\s*requirePaidFeatures,\s*async/
  );
});
