import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = new URL('./privacy-recovery-stop-writers.sh', import.meta.url).pathname;

async function fixture(scenario = 'readonly') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vow-writer-isolation-'));
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  const composeFile = path.join(root, 'restore.compose.yml');
  const hostGate = path.join(root, 'host-gate');
  const log = path.join(root, 'calls.log');
  await writeFile(composeFile, 'services: {}\n');
  await writeFile(log, '');
  await writeFile(hostGate, '#!/usr/bin/env bash\nset -eu\necho host-gate >> "$CALL_LOG"\n');
  await chmod(hostGate, 0o700);
  const gateOwner = spawnSync('sudo', ['-n', 'chown', '0:0', hostGate], { encoding: 'utf8' });
  assert.equal(gateOwner.status, 0, gateOwner.stderr);
  const docker = [
    '#!/usr/bin/env bash','set -eu','if [[ "$1" == --context ]]; then [[ "$2" == "$RESTORE_DOCKER_CONTEXT" ]] || exit 80; shift 2; fi','[[ -z "${DOCKER_HOST:-}" ]] || exit 81','printf "docker:%s\\n" "$*" >> "$CALL_LOG"',
    'if [[ "$1" == context && "$2" == inspect ]]; then printf \'%s\\n\' "$DOCKER_ENDPOINT_OUTPUT"',
    'elif [[ "$1" == info ]]; then printf \'%s\\n\' "$DOCKER_DAEMON_ID_OUTPUT"',
    'elif [[ "$1" == compose ]]; then',
    ' case "$*" in *"config --services"*) printf "db\napi\nworker\n" ;; *" stop "*) exit 0 ;; *) exit 2 ;; esac',
    'elif [[ "$1" == ps && "$*" != *"label=com.docker.compose.project="* ]]; then printf "db1\nforeign1\n"',
    'elif [[ "$1" == ps ]]; then printf "db1\n"',
    'elif [[ "$1" == inspect && "$2" == --format ]]; then printf "db\n"',
    'elif [[ "$1" == inspect ]]; then',
    ' [[ "$SCENARIO" != inspect-error ]] || exit 9',
    ' if [[ "$SCENARIO" == malformed-inspect ]]; then printf "%s\\n" "[]"',
    ' elif [[ "$SCENARIO" == writable ]]; then printf \'%s\\n\' \'[{"Mounts":[{"Type":"volume","Name":"vow-restore-test_private_photos","RW":true}]}]\'',
    ' else printf \'%s\\n\' \'[{"Mounts":[{"Type":"volume","Name":"vow-restore-test_private_photos","RW":false}]}]\'; fi',
    'else exit 2; fi'
  ].join('\n') + '\n';
  await writeFile(path.join(bin, 'docker'), docker);
  await chmod(path.join(bin, 'docker'), 0o700);
  const jq = [
    '#!/usr/bin/env node',
    'let input = ""; for await (const chunk of process.stdin) input += chunk;',
    'const volume = process.argv[process.argv.indexOf("--arg") + 2];',
    'try { const data = JSON.parse(input); if (!Array.isArray(data) || data.length !== 1 || !data[0] || typeof data[0] !== "object" || !Array.isArray(data[0].Mounts)) process.exit(4); const found = data[0].Mounts.some(mount => mount && mount.Type === "volume" && mount.Name === volume && mount.RW === true); const expression = process.argv.at(-1) || ""; if (!found && expression.includes("select(")) process.exit(4); process.exit(found ? 0 : 1); } catch { process.exit(4); }'
  ].join('\n') + '\n';
  await writeFile(path.join(bin, 'jq'), jq);
  await chmod(path.join(bin, 'jq'), 0o700);
  return { root, bin, composeFile, hostGate, log, scenario };
}

function run(f, overrides = {}) {
  return spawnSync('bash', [script], {
    encoding: 'utf8',
    env: {
      ...process.env, PATH: f.bin + path.delimiter + (process.env.PATH || ''),
      CALL_LOG: f.log, SCENARIO: f.scenario, RESTORE_DOCKER_CONTEXT: 'vow-restore-test-context',
      RESTORE_DOCKER_ENDPOINT: 'unix:///run/vow-restore-test/docker.sock', DOCKER_ENDPOINT_OUTPUT: overrides.DOCKER_ENDPOINT_OUTPUT || 'unix:///run/vow-restore-test/docker.sock',
      RESTORE_DOCKER_DAEMON_ID: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      DOCKER_DAEMON_ID_OUTPUT: overrides.DOCKER_DAEMON_ID_OUTPUT || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      RESTORE_COMPOSE_PROJECT: 'vow-restore-test', RESTORE_COMPOSE_FILE: f.composeFile,
      PRIVACY_RECOVERY_MEDIA_VOLUMES: [
        'vow-restore-test_private_photos','vow-restore-test_private_voice_intros','vow-restore-test_private_identity_l3'
      ].join(','),
      HOST_WRITER_ISOLATION_GATE_EXECUTABLE: f.hostGate, ...overrides
    }
  });
}

test('writer isolation refuses the default Docker context', async () => {
  const f = await fixture();
  try { const result = run(f, { RESTORE_DOCKER_CONTEXT: 'default' }); assert.notEqual(result.status, 0); assert.match(result.stderr, /non-default restore Docker context/); }
  finally { await rm(f.root, { recursive: true, force: true }); }
});

test('writer isolation ignores an ambient DOCKER_HOST and uses the pinned context', async () => {
  const f = await fixture();
  try { const result = run(f, { DOCKER_HOST: 'tcp://untrusted-shared-daemon:2375' }); assert.equal(result.status, 0, result.stderr || result.stdout); }
  finally { await rm(f.root, { recursive: true, force: true }); }
});

test('writer isolation rejects an unexpected Docker daemon ID', async () => {
  const f = await fixture();
  try { const result = run(f, { DOCKER_DAEMON_ID_OUTPUT: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' }); assert.notEqual(result.status, 0); assert.match(result.stderr, /daemon ID does not match/); assert.equal((await readFile(f.log, 'utf8')).includes('docker:compose'), false); }
  finally { await rm(f.root, { recursive: true, force: true }); }
});

test('writer isolation rejects an unexpected Docker context endpoint', async () => {
  const f = await fixture();
  try { const result = run(f, { DOCKER_ENDPOINT_OUTPUT: 'unix:///var/run/docker.sock' }); assert.notEqual(result.status, 0); assert.match(result.stderr, /context endpoint does not match/); assert.equal((await readFile(f.log, 'utf8')).includes('docker:compose'), false); }
  finally { await rm(f.root, { recursive: true, force: true }); }
});

test('writer isolation refuses to proceed without the mandatory host gate', async () => {
  const f = await fixture();
  try { const result = run(f, { HOST_WRITER_ISOLATION_GATE_EXECUTABLE: '' }); assert.notEqual(result.status, 0); assert.match(result.stderr, /HOST_WRITER_ISOLATION_GATE_EXECUTABLE/); }
  finally { await rm(f.root, { recursive: true, force: true }); }
});

test('writer isolation rejects writable media attachments from any running container', async () => {
  const f = await fixture('writable');
  try { const result = run(f); assert.notEqual(result.status, 0); assert.match(result.stderr, /writable private-media volume attachment remains/); assert.equal((await readFile(f.log, 'utf8')).includes('host-gate'), false); }
  finally { await rm(f.root, { recursive: true, force: true }); }
});

test('read-only Docker attachments pass only after project services stop and host gate succeeds', async () => {
  const f = await fixture('readonly');
  try {
    const result = run(f); assert.equal(result.status, 0, result.stderr || result.stdout);
    const calls = await readFile(f.log, 'utf8');
    assert.ok(calls.includes('docker:compose --profile * -p vow-restore-test'));
    assert.ok(calls.includes(' stop api worker'));
    assert.ok(calls.indexOf('docker:compose') < calls.indexOf('host-gate'));
    assert.ok(calls.endsWith('host-gate\n'));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('writer isolation fails closed when Docker inspect cannot verify a running container', async () => {
  const f = await fixture('inspect-error');
  try { const result = run(f); assert.notEqual(result.status, 0); assert.equal((await readFile(f.log, 'utf8')).includes('host-gate'), false); }
  finally { await rm(f.root, { recursive: true, force: true }); }
});

test('writer isolation fails closed when Docker inspect returns an unexpected JSON shape', async () => {
  const f = await fixture('malformed-inspect');
  try { const result = run(f); assert.notEqual(result.status, 0); assert.equal((await readFile(f.log, 'utf8')).includes('host-gate'), false); }
  finally { await rm(f.root, { recursive: true, force: true }); }
});

test('writer isolation rejects a non-dedicated Compose project name', async () => {
  const f = await fixture();
  try { const result = run(f, { RESTORE_COMPOSE_PROJECT: 'vow-production' }); assert.notEqual(result.status, 0); assert.match(result.stderr, /dedicated Compose project/); }
  finally { await rm(f.root, { recursive: true, force: true }); }
});
