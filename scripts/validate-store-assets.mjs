import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve('store-assets/google-play');
const phoneDir = path.join(root, 'phone');
const expectedScreenshots = [
  '01-discover.png',
  '02-compatibility.png',
  '03-safety.png',
  '04-chats-preview.png'
];

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

async function metadataFor(filePath, label) {
  try {
    await access(filePath);
    return await sharp(filePath).metadata();
  } catch (error) {
    failures.push(`${label}: missing or unreadable image (${error.message})`);
    return null;
  }
}

const phoneFiles = (await readdir(phoneDir)).filter((name) => /\.(png|jpe?g)$/i.test(name)).sort();
for (const expected of expectedScreenshots) {
  check(phoneFiles.includes(expected), `Missing required phone screenshot: phone/${expected}`);
}
check(phoneFiles.length >= 4, 'At least four phone screenshots are required.');

for (const filename of expectedScreenshots) {
  const filePath = path.join(phoneDir, filename);
  const meta = await metadataFor(filePath, `phone/${filename}`);
  if (!meta) continue;

  check(meta.format === 'png', `phone/${filename}: expected PNG format, got ${meta.format ?? 'unknown'}`);
  check(meta.width === 1080 && meta.height === 1920,
    `phone/${filename}: expected 1080x1920, got ${meta.width}x${meta.height}`);
  check(meta.width >= 320 && meta.height >= 320 && meta.width <= 3840 && meta.height <= 3840,
    `phone/${filename}: dimensions must be between 320 and 3840 px per side`);
  check(Math.max(meta.width, meta.height) <= 2 * Math.min(meta.width, meta.height),
    `phone/${filename}: long side must not exceed twice the short side`);
  check(meta.hasAlpha !== true,
    `phone/${filename}: screenshot must not contain an alpha channel for Play Store upload`);
  console.log(`OK phone/${filename}: ${meta.width}x${meta.height}, ${meta.format}, alpha=${meta.hasAlpha === true}`);
}

const icon = await metadataFor(path.join(root, 'app-icon-512.png'), 'app-icon-512.png');
if (icon) {
  check(icon.format === 'png', 'app-icon-512.png: expected PNG format');
  check(icon.width === 512 && icon.height === 512,
    `app-icon-512.png: expected 512x512, got ${icon.width}x${icon.height}`);
  console.log(`OK app-icon-512.png: ${icon.width}x${icon.height}, ${icon.format}`);
}

const feature = await metadataFor(path.join(root, 'feature-graphic.png'), 'feature-graphic.png');
if (feature) {
  check(feature.format === 'png', 'feature-graphic.png: expected PNG format');
  check(feature.width === 1024 && feature.height === 500,
    `feature-graphic.png: expected 1024x500, got ${feature.width}x${feature.height}`);
  console.log(`OK feature-graphic.png: ${feature.width}x${feature.height}, ${feature.format}`);
}

if (failures.length) {
  console.error('\nGoogle Play asset validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`\nGoogle Play asset validation passed (${expectedScreenshots.length} required phone screenshots).`);
}
