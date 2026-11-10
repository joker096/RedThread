import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { generateNativeAppIcons } from './generate-native-app-icons.mjs';

async function createIconFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vow-native-icons-'));
  await mkdirPublic(root);
  return root;
}

async function mkdirPublic(root) {
  const publicDir = path.join(root, 'public');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(publicDir, { recursive: true });
  await writeFile(path.join(publicDir, 'icon.svg'), await readFile(new URL('../public/icon.svg', import.meta.url)));
  await writeFile(path.join(publicDir, 'vow-mark.svg'), await readFile(new URL('../public/vow-mark.svg', import.meta.url)));
}

test('Android launcher, round and adaptive foreground icons are generated from the SVG source', async () => {
  const root = await createIconFixture();
  try {
    const result = await generateNativeAppIcons('android', root);
    assert.equal(result.densityCount, 5);
    for (const [density, size] of Object.entries({ mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 })) {
      for (const filename of ['ic_launcher.png', 'ic_launcher_round.png']) {
        const metadata = await sharp(path.join(root, 'android/app/src/main/res/mipmap-' + density, filename)).metadata();
        assert.equal(metadata.width, size);
        assert.equal(metadata.height, size);
      }
      const foreground = await sharp(path.join(root, 'android/app/src/main/res/mipmap-' + density, 'ic_launcher_foreground.png')).metadata();
      assert.equal(foreground.width, size * 2.25);
      assert.equal(foreground.height, size * 2.25);
    }
    const adaptive = await readFile(path.join(root, 'android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml'), 'utf8');
    assert.match(adaptive, /ic_launcher_foreground/);
    assert.match(adaptive, /ic_launcher_background/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('iOS AppIcon asset catalog receives a 1024px PNG generated from the vector icon', async () => {
  const root = await createIconFixture();
  try {
    const result = await generateNativeAppIcons('ios', root);
    assert.equal(result.iconSize, 1024);
    const iconPath = path.join(root, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png');
    const metadata = await sharp(iconPath).metadata();
    assert.equal(metadata.width, 1024);
    assert.equal(metadata.height, 1024);
    const contents = JSON.parse(await readFile(path.join(path.dirname(iconPath), 'Contents.json'), 'utf8'));
    assert.equal(contents.images[0].filename, 'AppIcon-1024.png');
    assert.equal(contents.images[0].size, '1024x1024');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native icon generator rejects unknown platforms', async () => {
  await assert.rejects(() => generateNativeAppIcons('web'), /unsupported_native_icon_platform/);
});
