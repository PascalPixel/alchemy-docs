// A still of a recording: its first frame, as a GIF of one frame. A card for
// a page (app/[[...slug]]/page.tsx) and the page's preview image
// (app/og/[...slug]/route.tsx) show the page's first recording this way, a
// few kilobytes rather than the whole recording's megabytes. The recordings
// are in the Blob store, so only the start of each is fetched, enough to
// hold its first frame; the stills go to public/stills, which git ignores,
// named by the recording's hash so a re-render is a new still. The preview
// images are drawn by next/og, which reads PNG but not GIF: each still is
// also kept as a PNG in build/stills, for the build alone.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { stillPath, stillPng, storeUrl, type Entry } from './renders';

export const STILLS = 'public/stills';

// The first frame of a GIF, with the header, the global palette and the
// frame's graphic control, and nothing after it; undefined until `gif` holds
// the whole frame.
export function firstFrame(gif: Uint8Array): Uint8Array | undefined {
  if (gif.length < 13) return undefined;
  // The sub-blocks from at; the offset just past their terminator.
  const skip = (at: number) => {
    while (at < gif.length && gif[at] !== 0) at += gif[at] + 1;
    return at < gif.length ? at + 1 : undefined;
  };
  const palette = gif[10] & 0x80 ? 3 << ((gif[10] & 7) + 1) : 0;
  let at = 13 + palette;
  let control: [number, number] | undefined;
  while (at < gif.length) {
    if (gif[at] === 0x21) {
      const end = skip(at + 2);
      if (end === undefined) return undefined;
      if (gif[at + 1] === 0xf9) control = [at, end];
      at = end;
    } else if (gif[at] === 0x2c) {
      if (at + 10 >= gif.length) return undefined;
      const local = gif[at + 9] & 0x80 ? 3 << ((gif[at + 9] & 7) + 1) : 0;
      const end = skip(at + 10 + local + 1);
      if (end === undefined) return undefined;
      const parts = [gif.subarray(0, 13 + palette), ...(control ? [gif.subarray(...control)] : []), gif.subarray(at, end), Uint8Array.of(0x3b)];
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      parts.reduce((n, p) => (out.set(p, n), n + p.length), 0);
      return out;
    } else return undefined;
  }
  return undefined;
}

// Writes the still of every recording given that public/stills lacks,
// fetching each recording's start from the store, more of it only when the
// first frame runs past what came.
export async function makeStills(docs: string, entries: Entry[]) {
  const dir = join(docs, STILLS);
  mkdirSync(dir, { recursive: true });
  const store = storeUrl(docs);
  const todo = entries.filter((e) => !existsSync(join(docs, 'public', stillPath(e))));
  const one = async (e: Entry) => {
    for (let bytes = 1 << 16; ; bytes *= 4) {
      const res = await fetch(`${store}/${e.pathname}`, { headers: { Range: `bytes=0-${Math.min(bytes, e.bytes) - 1}` } });
      if (!res.ok) throw new Error(`${e.pathname}: ${res.status}`);
      const frame = firstFrame(new Uint8Array(await res.arrayBuffer()));
      if (frame) return writeFileSync(join(docs, 'public', stillPath(e)), frame);
      if (bytes >= e.bytes) throw new Error(`${e.pathname}: no first frame`);
    }
  };
  for (let i = 0; i < todo.length; i += 16) await Promise.all(todo.slice(i, i + 16).map(one));
  mkdirSync(join(docs, 'build/stills'), { recursive: true });
  for (const e of entries) {
    const png = stillPng(docs, stillPath(e));
    if (!existsSync(png)) await sharp(readFileSync(join(docs, 'public', stillPath(e)))).png().toFile(png);
  }
  return todo.length;
}
