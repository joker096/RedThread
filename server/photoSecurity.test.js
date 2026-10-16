import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeProfileImage, PHOTO_LIMITS } from './photoSecurity.js';
const sig=Buffer.from([137,80,78,71,13,10,26,10]);
function chunk(type,data){const n=Buffer.from(type),l=Buffer.alloc(4);l.writeUInt32BE(data.length);return Buffer.concat([l,n,data,Buffer.alloc(4)]);}
function png(extra=[]){const h=Buffer.alloc(13);h.writeUInt32BE(1,0);h.writeUInt32BE(1,4);h[8]=8;h[9]=2;return Buffer.concat([sig,chunk('IHDR',h),...extra,chunk('IDAT',Buffer.from([1,2,3])),chunk('IEND',Buffer.alloc(0))]);}
test('PNG strips EXIF and text metadata',()=>{const clean=sanitizeProfileImage(png([chunk('tEXt',Buffer.from('GPS=private')),chunk('eXIf',Buffer.from('private exif'))]));assert.equal(clean.mimeType,'image/png');assert.equal(clean.width,1);assert.equal(clean.height,1);assert.equal(clean.buffer.includes(Buffer.from('GPS=private')),false);assert.equal(clean.buffer.includes(Buffer.from('private exif')),false);assert.equal(clean.buffer.includes(Buffer.from('IDAT')),true);});
test('rejects unsupported and malformed files',()=>{assert.throws(()=>sanitizeProfileImage(Buffer.from('GIF89a-not-an-image')),/unsupported_image_format/);assert.throws(()=>sanitizeProfileImage(Buffer.concat([sig,Buffer.from('broken')])),/invalid_image|invalid_png/);});
test('rejects malformed JPEG end markers',()=>{const bad=Buffer.from([0xff,0xd8,0xff,0xc0,0,11,8,0,1,0,1,1,1,17,0,0xff,0xda,0,8,1,1,0,0,63,0,0,0,0]);assert.throws(()=>sanitizeProfileImage(bad),/invalid_jpeg_eoi|invalid_or_incomplete_jpeg/);});
test('enforces documented byte and pixel limits',()=>{assert.equal(PHOTO_LIMITS.maxBytes,8*1024*1024);assert.equal(PHOTO_LIMITS.maxPixels,20_000_000);const huge=png();huge.writeUInt32BE(50000,16);huge.writeUInt32BE(50000,20);assert.throws(()=>sanitizeProfileImage(huge),/invalid_image_dimensions/);});
