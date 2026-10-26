import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { sanitizeProfileImage, PHOTO_LIMITS } from './photoSecurity.js';

test('decodes and re-encodes PNG while removing EXIF metadata', async () => {
  const source = await sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 25, g: 50, b: 75 } } })
    .png()
    .withExif({ IFD0: { ImageDescription: 'private metadata' } })
    .toBuffer();
  const before = await sharp(source).metadata();
  assert.ok(before.exif);
  const clean = await sanitizeProfileImage(source);
  assert.equal(clean.mimeType, 'image/png');
  assert.equal(clean.width, 1);
  assert.equal(clean.height, 1);
  const after = await sharp(clean.buffer).metadata();
  assert.equal(after.exif, undefined);
});

test('accepts JPEG and normalizes output', async () => {
  const source = await sharp({ create: { width: 2, height: 1, channels: 3, background: { r: 200, g: 100, b: 20 } } }).jpeg().toBuffer();
  const clean = await sanitizeProfileImage(source);
  assert.equal(clean.mimeType, 'image/jpeg');
  assert.equal(clean.width, 2);
  assert.equal(clean.height, 1);
  assert.equal((await sharp(clean.buffer).metadata()).format, 'jpeg');
});

test('rejects unsupported, corrupt and oversized files', async () => {
  await assert.rejects(() => sanitizeProfileImage(Buffer.from('GIF89a-not-an-image')), /unsupported_image_format|invalid_image/);
  await assert.rejects(() => sanitizeProfileImage(Buffer.from('not an image at all')), /invalid_image/);
  await assert.rejects(() => sanitizeProfileImage(Buffer.alloc(PHOTO_LIMITS.maxBytes + 1)), /image_too_large/);
});

test('documents strict byte and pixel limits', () => {
  assert.equal(PHOTO_LIMITS.maxBytes, 8 * 1024 * 1024);
  assert.equal(PHOTO_LIMITS.maxPixels, 20_000_000);
});
