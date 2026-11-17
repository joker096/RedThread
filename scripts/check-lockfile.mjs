import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const expectedSdkVersion = '3.11.1';
const manifestVersion = manifest.dependencies?.['@paddle/paddle-node-sdk'];
const lockVersion = lock.packages?.['node_modules/@paddle/paddle-node-sdk']?.version;

if (lock.lockfileVersion !== 3 ||
    manifestVersion !== expectedSdkVersion ||
    lockVersion !== expectedSdkVersion) {
  throw new Error('npm_lockfile_or_paddle_sdk_version_mismatch');
}

process.stdout.write('npm lockfile is consistent; Paddle Node SDK is pinned to 3.11.1\n');
