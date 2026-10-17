import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const outputDir = path.resolve('store-assets/google-play');
await mkdir(outputDir, { recursive: true });

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="500" viewBox="0 0 1024 500">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#160f1a"/><stop offset="55%" stop-color="#321522"/><stop offset="100%" stop-color="#671c32"/></linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#fb7185"/><stop offset="100%" stop-color="#f59e0b"/></linearGradient>
    <radialGradient id="glow"><stop offset="0%" stop-color="#fb7185" stop-opacity=".28"/><stop offset="100%" stop-color="#fb7185" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="1024" height="500" fill="url(#bg)"/>
  <circle cx="835" cy="240" r="285" fill="url(#glow)"/>
  <circle cx="835" cy="240" r="143" fill="none" stroke="#fb7185" stroke-opacity=".18" stroke-width="2"/>
  <circle cx="835" cy="240" r="108" fill="none" stroke="#fda4af" stroke-opacity=".25" stroke-width="2"/>
  <g transform="translate(835 240)">
    <path d="M-63 -6 C-63 -54 -3 -69 0 -22 C3 -69 63 -54 63 -6 C63 29 0 71 0 71 C0 71 -63 29 -63 -6Z" fill="url(#accent)" opacity=".96"/>
    <path d="M-37 -3 C-37 -24 -11 -31 0 -9 C11 -31 37 -24 37 -3 C37 14 0 39 0 39 C0 39 -37 14 -37 -3Z" fill="#fff1f2" opacity=".9"/>
  </g>
  <text x="84" y="205" font-family="Inter, Arial, sans-serif" font-size="98" font-weight="800" letter-spacing="-5" fill="#fff7f8">Vow<tspan fill="#fb7185">.</tspan></text>
  <rect x="88" y="235" width="74" height="6" rx="3" fill="url(#accent)"/>
  <text x="84" y="294" font-family="Inter, Arial, sans-serif" font-size="31" font-weight="600" fill="#ffe4e6">Meaningful connections.</text>
  <text x="84" y="336" font-family="Inter, Arial, sans-serif" font-size="31" font-weight="600" fill="#ffe4e6">Serious relationships.</text>
  <text x="86" y="407" font-family="Inter, Arial, sans-serif" font-size="16" font-weight="500" letter-spacing="2" fill="#fda4af">A PREVIEW OF VOW'S CURRENT BRAND DIRECTION</text>
</svg>`;

await writeFile(path.join(outputDir, 'feature-graphic.svg'), svg, 'utf8');
await sharp(Buffer.from(svg)).flatten({ background: '#160f1a' }).png().toFile(path.join(outputDir, 'feature-graphic.png'));
console.log('Generated store-assets/google-play/feature-graphic.png (1024x500)');
