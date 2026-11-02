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

  const api = serviceBlock('api');
  const web = serviceBlock('web');
  const diditVariables = [
    'DIDIT_ENVIRONMENT',
    'DIDIT_SANDBOX_KEY_CONFIRMED',
    'DIDIT_LIVE_KEY_CONFIRMED',
    'DIDIT_API_KEY',
    'DIDIT_WORKFLOW_ID',
    'DIDIT_APPLICATION_ID',
    'DIDIT_WEBHOOK_SECRET',
    'DIDIT_WEBHOOK_SECRET_PREVIOUS'
  ];
  for (const name of diditVariables) {
    assert.match(api, new RegExp('^      ' + name + ':', 'm'),
      name + ' must be passed only to the server API container');
    assert.doesNotMatch(web, new RegExp('^      ' + name + ':', 'm'),
      name + ' must never be exposed to the web container');
  }
  assert.ok(api.includes('DIDIT_ENVIRONMENT: ${DIDIT_ENVIRONMENT:-sandbox}'));
  assert.ok(api.includes('DIDIT_SANDBOX_KEY_CONFIRMED: ${DIDIT_SANDBOX_KEY_CONFIRMED:-false}'));
  assert.ok(api.includes('DIDIT_LIVE_KEY_CONFIRMED: ${DIDIT_LIVE_KEY_CONFIRMED:-false}'));

  assert.ok(compose.includes(`  backend:
    internal: true`));
  assert.ok(compose.includes(`  frontend:
    internal: true`));
  assert.doesNotMatch(serviceBlock('db'), /^    ports:/m,
    'PostgreSQL must not publish a host port');
});
