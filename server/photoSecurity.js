const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 20_000_000;
const PNG_SIGNATURE = Buffer.from([137,80,78,71,13,10,26,10]);

function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_IMAGE_PIXELS) throw new Error('invalid_image_dimensions');
  return { width, height };
}

function sanitizeJpeg(input) {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) throw new Error('invalid_jpeg');
  const chunks=[input.subarray(0,2)]; let offset=2; let imageDimensions=null; let sawScan=false;
  while(offset<input.length) {
    if(input[offset]!==0xff) throw new Error('invalid_jpeg_segment');
    while(offset<input.length && input[offset]===0xff) offset++;
    if(offset>=input.length) throw new Error('truncated_jpeg');
    const marker=input[offset++];
    if(marker===0xd9){chunks.push(Buffer.from([0xff,marker]));break;}
    if(marker===0xda){
      if(offset+2>input.length) throw new Error('truncated_jpeg');
      const length=input.readUInt16BE(offset);
      if(length<2||offset+length>input.length) throw new Error('invalid_jpeg_segment');
      chunks.push(Buffer.from([0xff,marker]),input.subarray(offset,offset+length),input.subarray(offset+length)); sawScan=true; break;
    }
    if(marker===0x01||(marker>=0xd0&&marker<=0xd7)){chunks.push(Buffer.from([0xff,marker]));continue;}
    if(offset+2>input.length) throw new Error('truncated_jpeg');
    const length=input.readUInt16BE(offset);
    if(length<2||offset+length>input.length) throw new Error('invalid_jpeg_segment');
    const end=offset+length, payload=input.subarray(offset+2,end);
    if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
      if(payload.length<5) throw new Error('invalid_jpeg_dimensions');
      imageDimensions=dimensions(payload.readUInt16BE(3),payload.readUInt16BE(1));
    }
    if(!(marker>=0xe1&&marker<=0xef)&&marker!==0xfe) chunks.push(Buffer.from([0xff,marker]),input.subarray(offset,end));
    offset=end;
  }
  if(!sawScan||!imageDimensions) throw new Error('invalid_or_incomplete_jpeg');
  const buffer=Buffer.concat(chunks);
  if(buffer.length>MAX_IMAGE_BYTES) throw new Error('image_too_large');
  return {buffer,mimeType:'image/jpeg',extension:'jpg',...imageDimensions};
}

function sanitizePng(input) {
  if(input.length<33||!input.subarray(0,8).equals(PNG_SIGNATURE)) throw new Error('invalid_png');
  let offset=8,width=0,height=0,sawHeader=false,sawEnd=false; const chunks=[PNG_SIGNATURE];
  while(offset+12<=input.length){
    const length=input.readUInt32BE(offset), end=offset+12+length;
    if(end>input.length) throw new Error('invalid_png_chunk');
    const type=input.toString('ascii',offset+4,offset+8), data=input.subarray(offset+8,offset+8+length);
    if(!sawHeader){
      if(type!=='IHDR'||length!==13) throw new Error('invalid_png_header');
      width=data.readUInt32BE(0); height=data.readUInt32BE(4); dimensions(width,height); sawHeader=true;
    }
    if(!['eXIf','tEXt','zTXt','iTXt'].includes(type)) chunks.push(input.subarray(offset,end));
    offset=end;
    if(type==='IEND'){sawEnd=true;break;}
  }
  if(!sawHeader||!sawEnd||offset!==input.length) throw new Error('invalid_or_incomplete_png');
  const buffer=Buffer.concat(chunks);
  if(buffer.length>MAX_IMAGE_BYTES) throw new Error('image_too_large');
  return {buffer,mimeType:'image/png',extension:'png',width,height};
}

export function sanitizeProfileImage(input) {
  if(!Buffer.isBuffer(input)||input.length<16) throw new Error('invalid_image');
  if(input.length>MAX_IMAGE_BYTES) throw new Error('image_too_large');
  if(input[0]===0xff&&input[1]===0xd8) return sanitizeJpeg(input);
  if(input.subarray(0,8).equals(PNG_SIGNATURE)) return sanitizePng(input);
  throw new Error('unsupported_image_format');
}
export const PHOTO_LIMITS=Object.freeze({maxBytes:MAX_IMAGE_BYTES,maxPixels:MAX_IMAGE_PIXELS});
