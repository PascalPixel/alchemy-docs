// The Weyard fonts, built from Golden Sun's own glyphs in an Alchemy checkout.
//   node weyard.js <alchemy> <outdir>
//
// Eight Latin faces, bold/regular x italic/upright x sans/mono, plus a Japanese face:
//   upright glyphs: the menu letters, games/tbs/src/graphics/ui/window_tiles.png
//                   (tile n = code n, ink is pen 1), game widths from
//                   games/tbs/src/graphics/window/glyph_widths.inc
//   italic glyphs:  the text-box font, games/tbs/src/graphics/font/text.png
//                   (16x16 cells from 0x20, text.tsv widths)
//   Japanese:       games/tbs/src/graphics/font/text_ja.png, cells mapped by charmap_ja.tsv
// Bold is the game's double strike: the glyph again one pixel to the right.
// Sans: side bearings measured from the ink, then pair kerning measured from
// the pixels, written as a GPOS 'kern' feature. Mono: one fixed advance, no kerning.
// Every face: 1em = 16 game pixels, ascender 11, descender 5, so a 16px font
// draws one game pixel per CSS pixel.
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const opentype = require('opentype.js');
const [repo, outdir] = process.argv.slice(2);
const P = 128;
const EM = 16, ASC = 11, DESC = 5;
const report = [];

function readSheet(file) {
  const png = PNG.sync.read(fs.readFileSync(path.join(repo, file)));
  const pal = (png.palette || []).map((c) => c.slice(0, 3).join(','));
  const index = (x, y) => {
    const o = (y * png.width + x) * 4;
    return pal.indexOf([png.data[o], png.data[o + 1], png.data[o + 2]].join(','));
  };
  return { width: png.width, height: png.height, index };
}
const cell = (sheet, n, size, rows, isInk) => {
  const cols = sheet.width / size, x0 = (n % cols) * size, y0 = Math.floor(n / cols) * size;
  const bits = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let x = 0; x < size; x++) row.push(isInk(sheet.index(x0 + x, y0 + r)));
    bits.push(row);
  }
  return bits;
};
const empty = (bits) => !bits.some((row) => row.some(Boolean));
const widen = (bits, n) => bits.map((row) => row.concat(Array(n).fill(false)));
const embolden = (bits) => widen(bits, 1).map((row) => row.map((v, x) => v || (x > 0 && row[x - 1])));
// Shear about the baseline: a row h pixels above it moves floor(h/2) right (dir 1) or left (dir -1).
function shear(g, dir) {
  const pad = 8;
  const bits = g.bits.map((row, r) => {
    const s = dir * Math.floor((g.base - r) / 2);
    const out = Array(row.length + 2 * pad).fill(false);
    row.forEach((v, x) => { if (v) out[x + pad + s] = true; });
    return out;
  });
  return { ...g, bits };
}

function outline(bits, base, shift) {
  const H = bits.length;
  const ink = (x, r) => r >= 0 && r < H && x >= 0 && x < bits[r].length && bits[r][x];
  const edges = new Map();
  const add = (a, b) => { const k = a.join(','); if (!edges.has(k)) edges.set(k, []); edges.get(k).push(b); };
  for (let r = 0; r < H; r++)
    for (let x = 0; x < bits[r].length; x++) {
      if (!ink(x, r)) continue;
      const y = base - r, sx = x + shift;
      if (!ink(x, r + 1)) add([sx, y], [sx + 1, y]);
      if (!ink(x + 1, r)) add([sx + 1, y], [sx + 1, y + 1]);
      if (!ink(x, r - 1)) add([sx + 1, y + 1], [sx, y + 1]);
      if (!ink(x - 1, r)) add([sx, y + 1], [sx, y]);
    }
  const p = new opentype.Path();
  for (;;) {
    const startKey = [...edges.keys()].find((k) => edges.get(k).length);
    if (!startKey) break;
    const start = startKey.split(',').map(Number);
    const pts = [start];
    let cur = start;
    for (;;) {
      const next = edges.get(cur.join(',')).shift();
      if (next[0] === start[0] && next[1] === start[1]) break;
      pts.push(next);
      cur = next;
    }
    const keep = pts.filter((q, i) => {
      const a = pts[(i - 1 + pts.length) % pts.length], c = pts[(i + 1) % pts.length];
      return !((a[0] === q[0] && q[0] === c[0]) || (a[1] === q[1] && q[1] === c[1]));
    });
    keep.forEach((q, i) => (i ? p.lineTo(q[0] * P, q[1] * P) : p.moveTo(q[0] * P, q[1] * P)));
    p.close();
  }
  return p;
}

// Per height above the baseline: leftmost and rightmost ink column.
function profile(g) {
  const left = new Map(), right = new Map();
  g.bits.forEach((row, r) => {
    const h = g.base - r;
    row.forEach((v, x) => {
      if (!v) return;
      if (!left.has(h) || x < left.get(h)) left.set(h, x);
      if (!right.has(h) || x > right.get(h)) right.set(h, x);
    });
  });
  return { left, right };
}
function box(g, heights) {
  let l = Infinity, r = -Infinity;
  const pr = profile(g);
  for (const [h, x] of pr.left) if (!heights || heights.includes(h)) l = Math.min(l, x);
  for (const [h, x] of pr.right) if (!heights || heights.includes(h)) r = Math.max(r, x);
  return l === Infinity ? null : [l, r];
}
const ZONE = [0, 1, 2, 3, 4]; // the x-height band above the baseline, the same five rows in both glyph sets

// ---- Glyph sets ---------------------------------------------------------
const latin = (code) => (code >= 0x20 && code <= 0x7e) || (code >= 0xa1 && code <= 0xff);

function italicSet() {
  const dir = 'games/tbs/src/graphics/font';
  const sheet = readSheet(path.join(dir, 'text.png'));
  const tsv = fs.readFileSync(path.join(repo, dir, 'text.tsv'), 'utf8').trim().split('\n').map((l) => l.split('\t'));
  const meta = Object.fromEntries(tsv.filter((f) => ['first', 'top', 'rows'].includes(f[0])).map((f) => [f[0], parseInt(f[1], 16)]));
  const set = new Map();
  tsv.filter((f) => !['first', 'top', 'rows'].includes(f[0])).forEach((f, i) => {
    const code = parseInt(f[0], 16), width = parseInt(f[1], 16);
    if (!latin(code)) return;
    const bits = cell(sheet, i, 16, meta.top + meta.rows, (v) => v === 1).slice(meta.top);
    if (code !== 0x20 && empty(bits)) return;
    set.set(code, { bits, base: 10 - meta.top, width });
  });
  return set;
}
function uprightSet() {
  const sheet = readSheet('games/tbs/src/graphics/ui/window_tiles.png');
  const inc = fs.readFileSync(path.join(repo, 'games/tbs/src/graphics/window/glyph_widths.inc'), 'utf8');
  const intl = inc.slice(inc.indexOf('.if EDITION_INTERNATIONAL'), inc.indexOf('.else'));
  const widths = [...intl.matchAll(/\d+/g)].map((m) => +m[0]);
  const set = new Map();
  for (let code = 0x20; code <= 0xff; code++) {
    if (!latin(code)) continue;
    const bits = cell(sheet, code, 8, 8, (v) => v === 1);
    if (code !== 0x20 && empty(bits)) continue;
    set.set(code, { bits, base: 6, width: widths[code - 0x20] });
  }
  // The sheet's 0x5C is the yen sign; backslash is its slash mirrored.
  set.set(0xa5, set.get(0x5c));
  const slash = set.get(0x2f);
  set.set(0x5c, { ...slash, bits: slash.bits.map((row) => row.slice(0, 6).reverse().concat(row.slice(6))) });
  return set;
}

// The arrow: the set's own hyphen, one pixel longer, with two-pixel barbs.
function arrow(set, italic) {
  const h = set.get(0x2d);
  const r0 = h.bits.findIndex((row) => row.some(Boolean));
  const [l, rr] = box(h);
  const end = rr + 1;
  const bits = h.bits.map((row) => row.concat([false, false, false]).map(() => false));
  for (let x = l; x <= end; x++) bits[r0][x] = true;
  for (const d of [1, 2]) { bits[r0 - d][end - d] = true; bits[r0 + d][end - d] = true; }
  let g = { bits, base: h.base, width: h.width + 2 };
  if (italic) {
    // slant the barbs as the text font slants, keeping the shaft where it is
    const s0 = Math.floor((g.base - r0) / 2);
    g = { ...g, bits: g.bits.map((row, r) => { const s = Math.floor((g.base - r) / 2) - s0; const out = Array(row.length + 4).fill(false); row.forEach((v, x) => { if (v) out[x + 2 + s] = true; }); return out; }) };
  }
  return g;
}
function completeSets() {
  const it = italicSet(), up = uprightSet();
  const filled = { italic: [], upright: [] };
  for (const [code, g] of up) if (!it.has(code) && code !== 0x20) { it.set(code, { ...shear(g, 1), width: g.width }); filled.italic.push(String.fromCharCode(code)); }
  for (const [code, g] of it) if (!up.has(code) && code !== 0x20) { up.set(code, { ...shear(g, -1), width: g.width }); filled.upright.push(String.fromCharCode(code)); }
  for (const [set, italic] of [[it, true], [up, false]]) {
    set.set(0x2019, set.get(0x27)); // ’ is the game's apostrophe
    set.set(0x2013, set.get(0x2d)); // – is the game's hyphen
    set.set(0x2192, arrow(set, italic)); // → drawn from the hyphen
  }
  report.push('italic filled by shearing the menu letters: ' + filled.italic.join(' '));
  report.push('upright filled by unshearing the text font: ' + filled.upright.join(' '));
  return { it, up };
}

// ---- Spacing and kerning --------------------------------------------------
function standardGap(set) {
  // the game's own gap in the x-height band, median over lowercase pairs
  const gaps = [];
  for (let a = 0x61; a <= 0x7a; a++)
    for (let b = 0x61; b <= 0x7a; b++) {
      const A = set.get(a), B = set.get(b);
      const za = box(A, ZONE), zb = box(B, ZONE);
      if (za && zb) gaps.push(A.width - za[1] - 1 + zb[0]);
    }
  gaps.sort((x, y) => x - y);
  return Math.max(1, gaps[Math.floor(gaps.length / 2)]);
}
function sansMetrics(set, bold, G) {
  const L = Math.floor(G / 2), R = G - L;
  const out = new Map();
  for (const [code, g0] of set) {
    const g = bold ? { ...g0, bits: embolden(g0.bits) } : g0;
    if (code === 0x20) { out.set(code, { g, shift: 0, adv: g0.width + (bold ? 1 : 0) }); continue; }
    // Sides from the whole glyph, so nothing hangs left of the pen (a T's
    // bar would be clipped at a line's start); the kerning pairs tuck.
    const z = box(g);
    const shift = L - z[0];
    out.set(code, { g, shift, adv: z[1] + shift + 1 + R });
  }
  return out;
}
function kerns(m, G) {
  const prof = new Map();
  for (const [code, e] of m) {
    const p = profile(e.g);
    const sh = (mp) => new Map([...mp].map(([h, x]) => [h, x + e.shift]));
    prof.set(code, { left: sh(p.left), right: sh(p.right) });
  }
  // The left glyph's right edge includes its shadow (one pixel right and
  // down), since the page draws one and a gap the shadow fills reads as touching.
  for (const p of prof.values()) {
    const rs = new Map(p.right);
    for (const [h, x] of p.right) rs.set(h - 1, Math.max(rs.get(h - 1) ?? -Infinity, x + 1));
    p.shadowRight = rs;
  }
  const measure = (a, b) => {
    const A = prof.get(a), B = prof.get(b), adv = m.get(a).adv;
    let same = Infinity, adj = Infinity;
    for (const [h, ra] of A.shadowRight) if (B.left.has(h)) same = Math.min(same, B.left.get(h) + adv - ra - 1);
    for (const [h, ra] of A.right) for (const d of [-1, 1]) if (B.left.has(h + d)) adj = Math.min(adj, B.left.get(h + d) + adv - ra - 1);
    return { same, adj };
  };
  // The standard: the closest approach of a typical lowercase pair.
  const lower = [];
  for (let a = 0x61; a <= 0x7a; a++) for (let b = 0x61; b <= 0x7a; b++) { const s = measure(a, b).same; if (s !== Infinity) lower.push(s); }
  lower.sort((x, y) => x - y);
  const S = lower[Math.floor(lower.length / 2)];
  const pairs = [];
  for (let a = 0x21; a <= 0x7e; a++)
    for (let b = 0x21; b <= 0x7e; b++) {
      // punctuation against punctuation (::, (), ...) keeps its spacing
      if (!/[A-Za-z0-9]/.test(String.fromCharCode(a) + String.fromCharCode(b))) continue;
      const { same, adj } = measure(a, b);
      if (same === Infinity && adj === Infinity) continue;
      let k = same === Infinity ? 0 : S - same;
      if (adj !== Infinity) k = Math.max(k, 1 - adj); // ink never touches, not even diagonally
      k = Math.max(-2, Math.min(1, k));
      if (k) pairs.push([a, b, k]);
    }
  pairs.standard = S;
  return pairs;
}

// ---- GPOS: one PairPos format 1 lookup under 'kern', spliced into the sfnt --
function gposTable(pairs, gid) {
  const byFirst = new Map();
  for (const [a, b, k] of pairs) {
    if (!byFirst.has(gid(a))) byFirst.set(gid(a), []);
    byFirst.get(gid(a)).push([gid(b), k * P]);
  }
  const firsts = [...byFirst.keys()].sort((x, y) => x - y);
  const u16 = (v) => [(v >> 8) & 255, v & 255];
  // PairPos subtable
  const headLen = 10 + 2 * firsts.length;
  const pairSets = firsts.map((f) => {
    const recs = byFirst.get(f).sort((x, y) => x[0] - y[0]);
    return [...u16(recs.length), ...recs.flatMap(([g, v]) => [...u16(g), ...u16(v & 0xffff)])];
  });
  let off = headLen;
  const setOffs = pairSets.map((s) => { const o = off; off += s.length; return o; });
  const coverage = [...u16(1), ...u16(firsts.length), ...firsts.flatMap(u16)];
  const coverageOff = off;
  if (coverageOff + coverage.length > 65535) throw new Error('kern subtable too large');
  const sub = [...u16(1), ...u16(coverageOff), ...u16(4), ...u16(0), ...u16(firsts.length), ...setOffs.flatMap(u16), ...pairSets.flat(), ...coverage];
  // Lookup list: one lookup (type 2) with one subtable
  const lookup = [...u16(2), ...u16(0), ...u16(1), ...u16(8)];
  const lookupList = [...u16(1), ...u16(4), ...lookup, ...sub];
  // Feature list: 'kern' -> lookup 0
  const featureList = [...u16(1), ...[...'kern'].map((c) => c.charCodeAt(0)), ...u16(8), ...u16(0), ...u16(1), ...u16(0)];
  // Script list: DFLT and latn, default LangSys -> feature 0
  const langSys = [...u16(0), ...u16(0xffff), ...u16(1), ...u16(0)];
  const script = [...u16(4), ...u16(0), ...langSys];
  const scriptList = [...u16(2), ...[...'DFLT'].map((c) => c.charCodeAt(0)), ...u16(14), ...[...'latn'].map((c) => c.charCodeAt(0)), ...u16(14 + script.length), ...script, ...script];
  const scriptOff = 10, featureOff = scriptOff + scriptList.length, lookupOff = featureOff + featureList.length;
  return Buffer.from([...u16(1), ...u16(0), ...u16(scriptOff), ...u16(featureOff), ...u16(lookupOff), ...scriptList, ...featureList, ...lookupList]);
}
function checksum(buf) {
  let sum = 0;
  const padded = Buffer.concat([buf, Buffer.alloc((4 - (buf.length % 4)) % 4)]);
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
}
function addTable(font, tag, data) {
  const num = font.readUInt16BE(4);
  const tables = [];
  for (let i = 0; i < num; i++) {
    const o = 12 + 16 * i;
    const t = font.toString('latin1', o, o + 4), off = font.readUInt32BE(o + 8), len = font.readUInt32BE(o + 12);
    tables.push({ tag: t, data: Buffer.from(font.subarray(off, off + len)) });
  }
  tables.push({ tag, data });
  tables.sort((a, b) => (a.tag < b.tag ? -1 : 1));
  const n = tables.length;
  let pow = 1, log = 0;
  while (pow * 2 <= n) { pow *= 2; log++; }
  const header = Buffer.alloc(12 + 16 * n);
  header.writeUInt32BE(font.readUInt32BE(0), 0);
  header.writeUInt16BE(n, 4); header.writeUInt16BE(pow * 16, 6); header.writeUInt16BE(log, 8); header.writeUInt16BE(n * 16 - pow * 16, 10);
  let off = header.length;
  const bodies = [];
  tables.forEach((t, i) => {
    if (t.tag === 'head') t.data.writeUInt32BE(0, 8);
    const o = 12 + 16 * i;
    header.write(t.tag, o, 'latin1');
    header.writeUInt32BE(checksum(t.data), o + 4);
    header.writeUInt32BE(off, o + 8);
    header.writeUInt32BE(t.data.length, o + 12);
    const pad = Buffer.alloc((4 - (t.data.length % 4)) % 4);
    bodies.push(t.data, pad);
    off += t.data.length + pad.length;
  });
  const out = Buffer.concat([header, ...bodies]);
  const head = tables.findIndex((t) => t.tag === 'head');
  const headOff = header.readUInt32BE(12 + 16 * head + 8);
  out.writeUInt32BE((0xb1b0afba - checksum(out)) >>> 0, headOff + 8);
  return out;
}

function write(name, family, style, weight, glyphs, pairs, ps) {
  const all = [new opentype.Glyph({ name: '.notdef', unicode: 0, advanceWidth: 4 * P, path: new opentype.Path() }), ...glyphs];
  const font = new opentype.Font({ familyName: family, styleName: style, fullName: `${family} ${style}`, postScriptName: ps || `${family.replace(/ /g, "")}-${style.replace(/ /g, "")}`, unitsPerEm: EM * P, ascender: ASC * P, descender: -DESC * P, glyphs: all });
  let buf = Buffer.from(font.toArrayBuffer());
  if (pairs && pairs.length) {
    const ids = new Map();
    all.forEach((g, i) => { if (g.unicode !== undefined && !ids.has(g.unicode)) ids.set(g.unicode, i); });
    buf = addTable(buf, 'GPOS', gposTable(pairs.filter(([a, b]) => ids.has(a) && ids.has(b)), (c) => ids.get(c)));
  }
  fs.writeFileSync(path.join(outdir, name), buf);
  return all.length;
}
const nameOf = (code) => 'u' + code.toString(16).padStart(4, '0');

// ---- Latin faces ----------------------------------------------------------
const { it, up } = completeSets();
for (const [set, italic, label] of [[up, false, 'upright'], [it, true, 'italic']]) {
  const G = standardGap(set);
  report.push(`${label}: standard gap ${G}px`);
  for (const bold of [false, true]) {
    const suffix = (bold ? '-bold' : '') + (italic ? '-italic' : '');
    const style = [bold && "Bold", italic && "Italic"].filter(Boolean).join(" ") || "Regular";
    // sans
    const m = sansMetrics(set, bold, G);
    const pairs = kerns(m, G);
    const ks = pairs.map((p) => p[2]);
    const glyphs = [...m].map(([code, e]) => new opentype.Glyph({ name: nameOf(code), unicode: code, advanceWidth: e.adv * P, path: outline(e.g.bits, e.g.base, e.shift) }));
    const n = write(`weyard-sans${suffix}.otf`, "Weyard Sans", style, bold ? 700 : 400, glyphs, pairs);
    report.push(`weyard-sans${suffix}.otf: ${n} glyphs, ${pairs.length} kerning pairs (closest approach ${pairs.standard}px with shadow), range ${Math.min(...ks)}..${Math.max(...ks)}px`);
    // mono
    const ADV = (italic ? 9 : 7) + (bold ? 1 : 0);
    const mono = [...set].map(([code, g0]) => {
      const g = bold ? { ...g0, bits: embolden(g0.bits) } : g0;
      const b = box(g);
      const shift = b ? Math.floor((ADV - (b[1] - b[0] + 1)) / 2) - b[0] : 0;
      return new opentype.Glyph({ name: nameOf(code), unicode: code, advanceWidth: ADV * P, path: outline(g.bits, g.base, shift) });
    });
    const nm = write(`weyard-mono${suffix}.otf`, "Weyard Mono", style, bold ? 700 : 400, mono, null);
    report.push(`weyard-mono${suffix}.otf: ${nm} glyphs, advance ${ADV}px`);
  }
}

// ---- Japanese: fixed 10-pixel advance, voiced kana composed as the game draws them ----
{
  const dir = 'games/tbs/src/graphics/font';
  const sheet = readSheet(path.join(dir, 'text_ja.png'));
  const map = fs.readFileSync(path.join(repo, dir, 'charmap_ja.tsv'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t'));
  const blank = () => Array(16).fill(false);
  // two empty rows on top: the voicing marks sit two rows above the cell (glyph_arm.c: x - 3, y - 2)
  const glyphAt = (code) => [blank(), blank(), ...cell(sheet, code - 0x20, 16, 12, (v) => v === 1)];
  const entries = [];
  for (const [hex, ch] of map) {
    const code = parseInt(hex, 16);
    if (code < 0x80 || !ch || [...ch].length !== 1 || ch === '゙' || ch === '゚') continue;
    entries.push([ch.codePointAt(0), glyphAt(code)]);
  }
  // marks: the game draws code de/df as cell fe/ff three pixels before the end of the base
  const dakuten = glyphAt(0xde).slice(2), handakuten = glyphAt(0xdf).slice(2);
  const voiced = [];
  for (const [cp, bits] of entries) {
    for (const [mark, comb] of [[dakuten, '゙'], [handakuten, '゚']]) {
      const v = (String.fromCodePoint(cp) + comb).normalize('NFC');
      if ([...v].length !== 1) continue;
      const out = widen(bits, 16).map((row, r) => row.map((x, i) => x || (i >= 7 && i - 7 < 16 && r < mark.length && mark[r][i - 7])));
      voiced.push([v.codePointAt(0), out]);
    }
  }
  const have = new Set(entries.map((e) => e[0]));
  const allJa = entries.concat(voiced.filter((v) => !have.has(v[0])));
  for (const bold of [false, true]) {
    const glyphs = allJa.map(([cp, bits]) => new opentype.Glyph({ name: nameOf(cp), unicode: cp, advanceWidth: (10 + (bold ? 1 : 0)) * P, path: outline(bold ? embolden(bits) : bits, 10, 0) }));
    const n = write(`weyard-mono-ja${bold ? "-bold" : ""}.otf`, "Weyard Mono", bold ? 'Bold' : 'Regular', bold ? 700 : 400, glyphs, null, `WeyardMono-Japanese${bold ? "Bold" : "Regular"}`);
    report.push(`weyard-mono-ja${bold ? "-bold" : ""}.otf: ${n} glyphs (${voiced.length} voiced kana composed), advance ${10 + (bold ? 1 : 0)}px`);
  }
}
console.log(report.join('\n'));
