import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeProfileImage, PHOTO_LIMITS } from './photoSecurity.js';
const sig=Buffer.from([137,80,78,71,13,10,26,10]);
function chunk(type,data){const n=Buffer.from(type),l=Buffer.alloc(4);l.writeUInt32BE(data.length);return Buffer.concat([l,n,data,Buffer.alloc(4)]);}
function png(extra=[]){const h=Buffer.alloc(13);h.writeUInt32BE(1,0);h.writeUInt32BE(1,4);h[8]=8;h[9]=2;return Buffer.concat([sig,chunk('IHDR',h),...extra,chunk('IDAT',Buffer.from([1,2,3])),chunk('IEND',Buffer.alloc(0))]);}
test('PNG strips EXIF and text metadata',()=>{const clean=sanitizeProfileImage(png([chunk('tEXt',Buffer.from('GPS=private')),chunk('eXIf',Buffer.from('private exif'))]));assert.equal(clean.mimeType,'image/png');assert.equal(clean.width,1);assert.equal(clean.height,1);assert.equal(clean.buffer.includes(Buffer.from('GPS=private')),false);assert.equal(clean.buffer.includes(Buffer.from('private exif')),false);assert.equal(clean.buffer.includes(Buffer.from('IDAT')),true);});
test('rejects unsupported and malformed files',()=>{assert.throws(()=>sanitizeProfileImage(Buffer.from('GIF89a-not-an-image')),/unsupported_image_format/);assert.throws(()=>sanitizeProfileImage(Buffer.concat([sig,Buffer.from('broken')]),/invalid_image|invalid_png/);});
test('enforces documented byte and pixel limits',()=>{assert.equal(PHOTO_LIMITS.maxBytes,8*1024*1024);assert.equal(PHOTO_LIMITS.maxPixels,20_000_000);const huge=png();huge.writeUInt32BE(50000,16);huge.writeUInt32BE(50000,20);assert.throws(()=>sanitizeProfileImage(huge),/invalid_image_dimensions/);});
