// One-off: Weyard Emoji, a COLRv0 colour font from SerenityOS's emoji PNGs
// (github.com/SerenityOS/serenity, Base/res/emoji, BSD-2-Clause).
//   node emoji.js <pngdir> <out.otf> <codepoint-hex>...
// Each opaque pixel is a square; each colour is one layer glyph, its colour
// in CPAL. 1em = 16 pixels; the 10-row emoji sit centred on Weyard's 16-pixel
// line (ascender 11, descender 5): bottom row 2 pixels under the baseline.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { PNG } = require('pngjs');
globalThis.opentype = require("opentype.js");
globalThis.P = 128;
// outline(), checksum() and addTable() from gsfont2.js
vm.runInThisContext(fs.readFileSync(path.join(__dirname, 'emoji-lib.js'), 'utf8'));

const [dir, out, ...codes] = process.argv.slice(2);
const u16 = (v) => [(v >> 8) & 255, v & 255];
const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];

const palette = []; // 'r,g,b,a'
const glyphs = [new opentype.Glyph({ name: '.notdef', unicode: 0, advanceWidth: 8 * P, path: new opentype.Path() })];
const bases = []; // [baseGid, [[layerGid, paletteIndex]...]]
const layerGlyphs = [];
for (const hex of codes) {
  const png = PNG.sync.read(fs.readFileSync(path.join(dir, `U+${hex}.png`)));
  const base = png.height - 3; // row whose bottom edge is the baseline: 2 rows hang below it
  const colours = new Map();
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) {
      const o = (y * png.width + x) * 4;
      if (png.data[o + 3] === 0) continue;
      const key = [png.data[o], png.data[o + 1], png.data[o + 2], png.data[o + 3]].join(',');
      if (!colours.has(key)) colours.set(key, Array.from({ length: png.height }, () => Array(png.width).fill(false)));
      colours.get(key)[y][x] = true;
    }
  const all = Array.from({ length: png.height }, (_, y) => Array.from({ length: png.width }, (_, x) => png.data[(y * png.width + x) * 4 + 3] !== 0));
  const advance = (png.width + 1) * P;
  const baseGlyph = new opentype.Glyph({ name: 'u' + hex, unicode: parseInt(hex, 16), advanceWidth: advance, path: outline(all, base, 0) });
  const layers = [];
  for (const [key, bits] of colours) {
    let pi = palette.indexOf(key);
    if (pi < 0) { palette.push(key); pi = palette.length - 1; }
    const g = new opentype.Glyph({ name: `u${hex}.layer${layers.length}`, advanceWidth: advance, path: outline(bits, base, 0) });
    layers.push([g, pi]);
  }
  glyphs.push(baseGlyph);
  bases.push([baseGlyph, layers]);
  layerGlyphs.push(...layers.map((l) => l[0]));
}
// U+FE0F (emoji presentation) is part of each emoji's cluster and draws nothing.
glyphs.push(new opentype.Glyph({ name: 'uFE0F', unicode: 0xfe0f, advanceWidth: 0, path: new opentype.Path() }));
glyphs.push(...layerGlyphs);

const font = new opentype.Font({ familyName: 'Weyard Emoji', styleName: 'Regular', fullName: 'Weyard Emoji Regular', postScriptName: 'WeyardEmoji-Regular', unitsPerEm: 16 * P, ascender: 11 * P, descender: -5 * P, glyphs });
let buf = Buffer.from(font.toArrayBuffer());
const gid = (g) => glyphs.indexOf(g);

// COLR v0
const records = bases.map(([g, layers]) => [gid(g), layers]).sort((a, b) => a[0] - b[0]);
const baseRecs = [], layerRecs = [];
for (const [g, layers] of records) {
  baseRecs.push(...u16(g), ...u16(layerRecs.length / 4), ...u16(layers.length));
  for (const [lg, pi] of layers) layerRecs.push(...u16(gid(lg)), ...u16(pi));
}
const colr = Buffer.from([...u16(0), ...u16(records.length), ...u32(14), ...u32(14 + baseRecs.length), ...u16(layerRecs.length / 4), ...baseRecs, ...layerRecs]);
// CPAL v0: one palette, BGRA records
const colours = palette.map((k) => k.split(',').map(Number)).flatMap(([r, g, b, a]) => [b, g, r, a]);
const cpal = Buffer.from([...u16(0), ...u16(palette.length), ...u16(1), ...u16(palette.length), ...u32(14), ...u16(0), ...colours]);
buf = addTable(buf, 'COLR', colr);
buf = addTable(buf, 'CPAL', cpal);
fs.writeFileSync(out, buf);
console.log('wrote', out, codes.length, 'emoji,', palette.length, 'colours,', layerGlyphs.length, 'layers,', buf.length, 'bytes');
