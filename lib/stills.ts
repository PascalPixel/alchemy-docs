// A still of a recording: its first frame, as a GIF of one frame, or its
// first picture faded fully in when the first one is black (firstShown). A card for
// a page (app/[[...slug]]/page.tsx) and the page's preview image
// (app/og/[...slug]/route.tsx) show the page's first recording this way, a
// few kilobytes rather than the whole recording's megabytes. The recordings
// are in the Blob store, so only the start of each is fetched, enough to
// hold its first frame; the stills go to public/stills, which git ignores,
// named by the recording's hash so a re-render is a new still. A place's
// card shows its entrance shot instead, a small PNG kept whole. The preview
// images are drawn by next/og, which reads PNG but not GIF and smooths a
// picture it scales: each still is also kept in build/stills, for the build
// alone, as a PNG already scaled to the preview's size by a whole number,
// each pixel a square block (ogScale).
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

// The brightest channel of any pixel of a picture, 0 to 255: a black screen,
// as a fade or a load leaves it, is at most 16, and a picture faded fully in
// reaches 200.
async function brightest(picture: Uint8Array) {
  const { channels } = await sharp(picture).stats();
  return Math.max(...channels.slice(0, 3).map((c) => c.max));
}

// One picture of a recording, as a GIF of one frame, composed as the player
// sees it.
async function picture(url: string, name: string, frame: number) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  const gif = new Uint8Array(await res.arrayBuffer());
  const { pages = 1 } = await sharp(gif).metadata();
  if (frame >= pages) throw new Error(`${name} has ${pages} pictures, no picture ${frame}`);
  return new Uint8Array(await sharp(gif, { page: frame }).gif().toBuffer());
}

// The first picture of a recording faded fully in, as a GIF of one frame: a recording that opens on a fade (the console switched on) would
// otherwise show its card as a black box. The whole recording is fetched, and
// sharp composes each frame as the player sees it.
async function firstShown(url: string, name: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  const gif = new Uint8Array(await res.arrayBuffer());
  const { pages = 1 } = await sharp(gif).metadata();
  for (let page = 0; page < pages; page++) {
    const picture = await sharp(gif, { page }).gif().toBuffer();
    if ((await brightest(picture)) >= 200) return new Uint8Array(picture);
  }
  throw new Error(`${name}: no picture is faded fully in`);
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
    if (e.pathname.endsWith('.png')) {
      const res = await fetch(`${store}/${e.pathname}`);
      if (!res.ok) throw new Error(`${e.pathname}: ${res.status}`);
      return writeFileSync(join(docs, 'public', stillPath(e)), new Uint8Array(await res.arrayBuffer()));
    }
    if (e.frame !== undefined) return writeFileSync(join(docs, 'public', stillPath(e)), await picture(`${store}/${e.pathname}`, e.pathname, e.frame));
    for (let bytes = 1 << 16; ; bytes *= 4) {
      const res = await fetch(`${store}/${e.pathname}`, { headers: { Range: `bytes=0-${Math.min(bytes, e.bytes) - 1}` } });
      if (!res.ok) throw new Error(`${e.pathname}: ${res.status}`);
      const frame = firstFrame(new Uint8Array(await res.arrayBuffer()));
      if (frame && (await brightest(frame)) > 16) return writeFileSync(join(docs, 'public', stillPath(e)), frame);
      if (frame) return writeFileSync(join(docs, 'public', stillPath(e)), await firstShown(`${store}/${e.pathname}`, e.pathname));
      if (bytes >= e.bytes) throw new Error(`${e.pathname}: no first frame`);
    }
  };
  for (let i = 0; i < todo.length; i += 16) await Promise.all(todo.slice(i, i + 16).map(one));
  mkdirSync(join(docs, 'build/stills'), { recursive: true });
  for (const e of entries) {
    const png = stillPng(docs, stillPath(e));
    const k = ogScale(e.width, e.height);
    if (!existsSync(png)) await sharp(readFileSync(join(docs, 'public', stillPath(e)))).resize(e.width * k, e.height * k, { kernel: 'nearest' }).png().toFile(png);
  }
  return todo.length;
}

// The room a preview image gives its still (app/og/[...slug]/route.tsx), and
// the whole number a still of a size is scaled by to fill as much of it as
// fits: 2 for the game's screen.
export const OG_STILL = { width: 480, height: 320 };
export const ogScale = (width: number, height: number) => Math.max(1, Math.floor(Math.min(OG_STILL.width / width, OG_STILL.height / height)));
