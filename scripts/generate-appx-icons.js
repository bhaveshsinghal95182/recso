import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

const iconPath = path.resolve('public/R.png');
const appxDir = path.resolve('build/appx');

if (!fs.existsSync(appxDir)) {
  fs.mkdirSync(appxDir, { recursive: true });
}

const assets = [
  { name: 'StoreLogo.png', width: 50, height: 50 },
  { name: 'Square150x150Logo.png', width: 150, height: 150 },
  { name: 'Square44x44Logo.png', width: 44, height: 44 },
  { name: 'Square71x71Logo.png', width: 71, height: 71 },
  { name: 'Square310x310Logo.png', width: 310, height: 310 },
  {
    name: 'Wide310x150Logo.png',
    width: 310,
    height: 150,
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
  {
    name: 'SplashScreen.png',
    width: 620,
    height: 300,
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
];

async function generate() {
  console.log('Starting icon generation...');
  for (const asset of assets) {
    const outPath = path.join(appxDir, asset.name);
    try {
      await sharp(iconPath)
        .resize({
          width: asset.width,
          height: asset.height,
          fit: asset.fit || 'fill',
          background: asset.background || { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .toFile(outPath);
      console.log(`Generated ${asset.name}`);
    } catch (err) {
      console.error(`Error generating ${asset.name}:`, err);
    }
  }
  console.log('Finished generating icons.');
}

generate();
