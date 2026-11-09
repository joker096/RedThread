import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const platform = process.argv[2];
if (!['android', 'ios'].includes(platform)) {
  console.error('Usage: node scripts/ensure-capacitor-platform.mjs <android|ios>');
  process.exit(2);
}

if (existsSync(platform)) {
  console.log(`Capacitor ${platform} project already exists.`);
  process.exit(0);
}

const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(command, ['cap', 'add', platform], {
  stdio: 'inherit',
  shell: process.platform === 'win32'
});
if (result.error) {
  console.error(`Could not generate Capacitor ${platform} project:`, result.error.message);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);
