// Puts the renderer's crops of the game into the illustrations that show
// them.
//
//   bun scripts/crops.ts FOLDER SVG... [--check]
//
// An illustration that shows the game (a plane of a screen, a sprite, part
// of a frame) holds each crop as an <image> with a data-crop attribute naming
// the PNG that `alchemy-devtools render guide` wrote, relative to its output
// FOLDER (`data-crop="planes/field/bg3.png"`). A browser shows an SVG used as
// a picture without fetching anything else, so the crop has to be inside the
// file: this writes each named PNG into its <image>'s href as a data URL, and
// the rest of the SVG stays text to edit. After a re-render, run it again.
// --check changes nothing and exits 1 if any crop differs from its PNG or is
// missing.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const check = args.includes('--check');
const [folder, ...svgs] = args.filter((a) => a !== '--check');
if (!folder || svgs.length === 0) {
  console.error('usage: bun scripts/crops.ts FOLDER SVG... [--check]');
  process.exit(2);
}

const IMAGE = /<image\b[^>]*>/g;
let stale = 0;
for (const svg of svgs) {
  const text = readFileSync(svg, 'utf8');
  let count = 0;
  const out = text.replace(IMAGE, (tag) => {
    const crop = tag.match(/\sdata-crop="([^"]+)"/)?.[1];
    if (!crop) return tag;
    const file = join(folder, crop);
    if (!existsSync(file)) {
      console.error(`${svg}: ${crop} is not in ${folder}`);
      stale++;
      return tag;
    }
    count++;
    const href = `data:image/png;base64,${readFileSync(file).toString('base64')}`;
    const next = /\shref="[^"]*"/.test(tag) ? tag.replace(/\shref="[^"]*"/, ` href="${href}"`) : tag.replace(/^<image\b/, `<image href="${href}"`);
    if (next !== tag && check) {
      console.error(`${svg}: ${crop} differs from its render`);
      stale++;
    }
    return next;
  });
  if (!check && out !== text) writeFileSync(svg, out);
  console.log(`${svg}: ${count} crops${check ? ' checked' : ''}`);
}
process.exit(stale ? 1 : 0);
