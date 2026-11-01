import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Docker database network is isolated from the public web proxy container', async () => {
  const compose = await readFile(new URL('../compose.yaml', import.meta.url), 'utf8');
  const serviceBlock = name => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`^  ${escaped}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:\\n|^networks:\\n|$)`, 'm').exec(compose);
    assert.ok(match, `missing compose service: ${name}`);
    return match[1];
  };
  const networksFor = name => {
    const block = serviceBlock(name);
    const match = /^    networks: \\[(.*?)\\]$/m.exec(block);
    assert.ok(match, `missing explicit network assignment for ${name}`);
    return match[1].split(',').map(value => value.trim());
  };

  assert.deepEqual(networksFor('db'), ['backend']);
  assert.deepEqual(networksFor('migrate'), ['backend']);
  assert.deepEqual(networksFor('ad-event-retention'), ['backend']);
  assert.deepEqual(networksFor('gift-request-expiry'), ['backend']);
  assert.deepEqual(networksFor('api'), ['backend', 'frontend', 'egress']);
  assert.deepEqual(networksFor('web'), ['frontend']);

  assert.match(compose, /^  backend:\\n    internal: true$/m);
  assert.match(compose, /^  frontend:\\n    internal: true$/m);
  assert.doesNotMatch(serviceBlock('db'), /^    ports:/m,
    'PostgreSQL must not publish a host port');
});
