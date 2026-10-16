import sharp from 'sharp';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 20_000_000;

export async function sanitizeProfileImage(input) {
  if (!Buffer.isBuffer(input) || input.length < 16) throw new Error('invalid_image');
  if (input.length > MAX_IMAGE_BYTES) throw new Error('image_too_large');

  let metadata;
  try {
    metadata = await sharp(input, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'error' }).metadata();
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    if (message.includes('pixel limit') || message.includes('dimensions')) throw new Error('invalid_image_dimensions');
    throw new Error('invalid_image');
  }

  if (!['jpeg', 'png'].includes(metadata.format || '')) throw new Error('unsupported_image_format');
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_IMAGE_PIXELS) {
    throw new Error('invalid_image_dimensions');
  }

  try {
    const pipeline = sharp(input, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'error' }).rotate();
    const output = metadata.format === 'jpeg'
      ? await pipeline.jpeg({ quality: 88, mozjpeg: true }).toBuffer({ resolveWithObject: true })
      : await pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer({ resolveWithObject: true });
    if (output.data.length > MAX_IMAGE_BYTES) throw new Error('image_too_large');
    return {
      buffer: output.data,
      mimeType: metadata.format === 'jpeg' ? 'image/jpeg' : 'image/png',
      extension: metadata.format === 'jpeg' ? 'jpg' : 'png',
      width: output.info.width,
      height: output.info.height
    };
  } catch (error) {
    if (error instanceof Error && error.message === 'image_too_large') throw error;
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    if (message.includes('pixel limit') || message.includes('dimensions')) throw new Error('invalid_image_dimensions');
    throw new Error('invalid_image');
  }
}

export const PHOTO_LIMITS = Object.freeze({ maxBytes: MAX_IMAGE_BYTES, maxPixels: MAX_IMAGE_PIXELS });
