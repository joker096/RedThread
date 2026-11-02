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
      index > start && /^(?:[a-z][a-z-]*:|  [a-z][a-z-]*:)$/.test(line)
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
  assert.deepEqual(networksFor('identity-l3-expiry'), ['backend']);
  assert.deepEqual(networksFor('clamav'), ['backend']);
  assert.deepEqual(networksFor('identity-l3-worker'), ['backend']);
  assert.deepEqual(networksFor('identity-l3-purge-worker'), ['backend']);
  const clamav = serviceBlock('clamav');
  const l3Worker = serviceBlock('identity-l3-worker');
  const l3PurgeWorker = serviceBlock('identity-l3-purge-worker');
  assert.match(clamav, /profiles: \["identity-l3"\]/);
  assert.doesNotMatch(clamav, /^    ports:/m, 'ClamAV must never publish its scanner port to the host');
  assert.match(clamav, /CLAMD_CONF_StreamMaxLength: 120M/);
  assert.match(clamav, /CLAMD_CONF_TemporaryDirectory: \/tmp/);
  assert.match(clamav, /tmpfs:\n      - \/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777/,
    'ClamAV must keep streamed plaintext in bounded ephemeral storage');
  assert.match(l3Worker, /profiles: \["identity-l3"\]/);
  assert.match(l3Worker, /private_identity_l3:\/app\/uploads\/private-identity-l3:ro/,
    'the processing worker must mount encrypted media read-only');
  assert.match(l3Worker, /IDENTITY_L3_TEMP_DIR: \/run\/identity-l3-tmp/,
    'the processing worker must use a separate plaintext scratch directory');
  assert.match(l3Worker, /tmpfs:\n      - \/run\/identity-l3-tmp:rw,noexec,nosuid,nodev,size=256m,mode=0700,uid=1000,gid=1000/,
    'the worker scratch directory must be a bounded private tmpfs owned by the unprivileged node user');
  assert.match(l3Worker, /clamav:\n        condition: service_healthy/,
    'the worker must wait for a healthy malware scanner');
  assert.match(l3PurgeWorker, /--purge-only/);
  assert.doesNotMatch(l3PurgeWorker, /profiles:/,
    'privacy purge must remain active even when the optional L3 processing profile is disabled');
  assert.match(l3PurgeWorker, /private_identity_l3:\/app\/uploads\/private-identity-l3(\n|$)/,
    'the isolated purge worker requires write access to unlink encrypted media');
  assert.doesNotMatch(l3PurgeWorker, /clamav:/,
    'the purge-only worker must not depend on or access the malware scanner');
  assert.deepEqual(networksFor('api'), ['backend', 'frontend', 'egress']);
  const api = serviceBlock('api');
  const web = serviceBlock('web');
  assert.ok(api.includes('IDENTITY_L3_STORAGE_DIR: /app/uploads/private-identity-l3'));
  assert.ok(api.includes('IDENTITY_L3_ENCRYPTION_KEY: ${IDENTITY_L3_ENCRYPTION_KEY:-}'));
  assert.ok(api.includes('IDENTITY_L3_TEMP_DIR: /run/identity-l3-tmp'));
  assert.match(api, /tmpfs:\n      - \/run\/identity-l3-tmp:rw,noexec,nosuid,nodev,size=256m,mode=0700,uid=1000,gid=1000/,
    'moderator plaintext staging must use a bounded private tmpfs');

  assert.ok(api.includes('private_identity_l3:/app/uploads/private-identity-l3'));
  assert.doesNotMatch(web, /IDENTITY_L3_ENCRYPTION_KEY|IDENTITY_L3_TEMP_DIR|private_identity_l3/,
    'L3 media storage and encryption key must be API-only');
  assert.deepEqual(networksFor('web'), ['frontend']);

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
