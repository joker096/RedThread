import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ANDROID_DENSITIES = Object.freeze({
  mdpi: { launcher: 48, foreground: 108 },
  hdpi: { launcher: 72, foreground: 162 },
  xhdpi: { launcher: 96, foreground: 216 },
  xxhdpi: { launcher: 144, foreground: 324 },
  xxxhdpi: { launcher: 192, foreground: 432 }
});

const ADAPTIVE_ICON_XML = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`;

const ANDROID_BACKGROUND_XML = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#0C0A09</color>
</resources>
`;

const IOS_ICON_CONTENTS = {
  images: [{
    filename: 'AppIcon-1024.png',
    idiom: 'universal',
    platform: 'ios',
    size: '1024x1024'
  }],
  info: { author: 'xcode', version: 1 }
};

export async function generateNativeAppIcons(platform, root = process.cwd()) {
  if (!['android', 'ios'].includes(platform)) throw new TypeError('unsupported_native_icon_platform');
  const publicDir = path.join(root, 'public');
  const appIconSvg = await readFile(path.join(publicDir, 'icon.svg'));
  const markSvg = await readFile(path.join(publicDir, 'vow-mark.svg'));
  if (!/^\\s*<svg\\b/.test(appIconSvg.toString('utf8')) ||
      !/^\\s*<svg\\b/.test(markSvg.toString('utf8'))) {
    throw new Error('invalid_vow_vector_icon_source');
  }

  if (platform === 'android') {
    for (const [density, sizes] of Object.entries(ANDROID_DENSITIES)) {
      const directory = path.join(root, 'android', 'app', 'src', 'main', 'res', 'mipmap-' + density);
      await mkdir(directory, { recursive: true });
      const launcher = sharp(appIconSvg).resize(sizes.launcher, sizes.launcher).png();
      await launcher.toFile(path.join(directory, 'ic_launcher.png'));
      await sharp(appIconSvg).resize(sizes.launcher, sizes.launcher).png()
        .toFile(path.join(directory, 'ic_launcher_round.png'));
      await sharp(markSvg).resize(sizes.foreground, sizes.foreground, { fit: 'contain' }).png()
        .toFile(path.join(directory, 'ic_launcher_foreground.png'));
    }
    const adaptiveDir = path.join(root, 'android', 'app', 'src', 'main', 'res', 'mipmap-anydpi-v26');
    const valuesDir = path.join(root, 'android', 'app', 'src', 'main', 'res', 'values');
    await mkdir(adaptiveDir, { recursive: true });
    await mkdir(valuesDir, { recursive: true });
    await writeFile(path.join(adaptiveDir, 'ic_launcher.xml'), ADAPTIVE_ICON_XML);
    await writeFile(path.join(adaptiveDir, 'ic_launcher_round.xml'), ADAPTIVE_ICON_XML);
    await writeFile(path.join(valuesDir, 'ic_launcher_background.xml'), ANDROID_BACKGROUND_XML);
    return { platform, densityCount: Object.keys(ANDROID_DENSITIES).length };
  }

  const iconSetDir = path.join(root, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset');
  await mkdir(iconSetDir, { recursive: true });
  await sharp(appIconSvg).resize(1024, 1024).png()
    .toFile(path.join(iconSetDir, 'AppIcon-1024.png'));
  await writeFile(path.join(iconSetDir, 'Contents.json'), JSON.stringify(IOS_ICON_CONTENTS, null, 2) + '\n');
  return { platform, iconSize: 1024 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const platform = process.argv[2];
  generateNativeAppIcons(platform).then(result => {
    console.log('Generated Vow vector-derived native app icons:', result);
  }).catch(error => {
    console.error('Native app icon generation failed:', error.message);
    process.exitCode = 1;
  });
}
