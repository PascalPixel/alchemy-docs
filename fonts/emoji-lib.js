globalThis.outline = function outline(bits, base, shift) {
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
globalThis.checksum = function checksum(buf) {
  let sum = 0;
  const padded = Buffer.concat([buf, Buffer.alloc((4 - (buf.length % 4)) % 4)]);
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
}
globalThis.addTable = function addTable(font, tag, data) {
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
