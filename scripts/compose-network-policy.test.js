import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Docker database network is isolated from the public web proxy container', async () => {
  const compose = await readFile(new URL('../compose.yaml', import.meta.url), 'utf8');
  const lines = compose.split(String.fromCharCode(10));
  const serviceBlock = name => {
    const start = lines.indexOf(`  ${name}:`);
    assert.ok(start >= 0, `missing compose service: ${name}`);
    let end = lines.findIndex((line, index) =>
      index > start && (line === 'networks:' || /^  [a-z][a-z-]*:$/.test(line))
    );
    if (end < 0) end = lines.length;
    return lines.slice(start + 1, end).join(String.fromCharCode(10));
  };
  const networksFor = name => {
    const line = serviceBlock(name).split(String.fromCharCode(10))
      .find(value => value.trimStart().startsWith('networks:'));
    assert.ok(line, `missing explicit network assignment for ${name}`);
    const value = line.trim().slice('networks:'.length).trim();
    assert.ok(value.startsWith('[') && value.endsWith(']'), `invalid network list for ${name}`);
    return value.slice(1, -1).split(',').map(item => item.trim());
  };

  assert.deepEqual(networksFor('db'), ['backend']);
  assert.deepEqual(networksFor('migrate'), ['backend']);
  assert.deepEqual(networksFor('ad-event-retention'), ['backend']);
  assert.deepEqual(networksFor('gift-request-expiry'), ['backend']);
  assert.deepEqual(networksFor('api'), ['backend', 'frontend', 'egress']);
  assert.deepEqual(networksFor('web'), ['frontend']);

  assert.ok(compose.includes(`  backend:
    internal: true`));
  assert.ok(compose.includes(`  frontend:
    internal: true`));
  assert.doesNotMatch(serviceBlock('db'), /^    ports:/m,
    'PostgreSQL must not publish a host port');
});
