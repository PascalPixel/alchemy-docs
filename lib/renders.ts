// The renders of the game: the pictures under /places, /abilities, /guides and
// /story, and the records the renderer writes beside them. They live in the
// Vercel Blob store `alchemy-renders`, not in git; vercel.json routes each
// prefix to the store. The store's renders-manifest.tsv lists every picture
// with its hash, size and dimensions, so the build knows what exists and how
// big it is without the files, and each prefix's records (places/index.tsv,
// abilities/index.tsv) say what each picture shows. The build fetches the
// manifest and the records it reads into build/renders (fetchRecords) before
// it reads them.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const PREFIXES = ['places', 'abilities', 'guides', 'story'] as const;
export type Prefix = (typeof PREFIXES)[number];

export type Entry = { pathname: string; sha256: string; bytes: number; width: number; height: number };

export const MANIFEST_BLOB = 'renders-manifest.tsv';
export const MANIFEST_HEAD = ['pathname', 'sha256', 'bytes', 'width', 'height'];
// The records the build reads, by their pathname in the store.
export const RECORDS = ['places/index.tsv', 'abilities/index.tsv'];
// Where the build keeps what it fetched from the store; git ignores build/.
export const FETCHED = 'build/renders';

// A picture's site path (`/places/vale-storm/map-0.png`) when it is a render.
export const renderPath = (src: string): string | undefined => {
  const path = src.split(/[?#]/)[0].replace(/^\//, '');
  return PREFIXES.some((p) => path.startsWith(`${p}/`)) && !path.endsWith('.tsv') ? path : undefined;
};

export function parseManifest(text: string): Map<string, Entry> {
  const out = new Map<string, Entry>();
  for (const line of text.trim().split('\n').slice(1)) {
    if (!line) continue;
    const [pathname, sha256, bytes, width, height] = line.split('\t');
    out.set(pathname, { pathname, sha256, bytes: +bytes, width: +width, height: +height });
  }
  return out;
}

export const formatManifest = (entries: Iterable<Entry>) =>
  [MANIFEST_HEAD.join('\t'), ...[...entries].sort((a, b) => (a.pathname < b.pathname ? -1 : 1)).map((e) => [e.pathname, e.sha256, e.bytes, e.width, e.height].join('\t'))].join('\n') + '\n';

// A file fetched from the store, by its pathname there.
export function readFetched(docs: string, pathname: string): string {
  const file = join(docs, FETCHED, pathname);
  if (!existsSync(file)) throw new Error(`${join(FETCHED, pathname)} is missing: run \`bun scripts/renders.ts fetch\` first`);
  return readFileSync(file, 'utf8');
}

export const readManifest = (docs: string): Map<string, Entry> => parseManifest(readFetched(docs, MANIFEST_BLOB));

// The store's public address, from the rewrite vercel.json routes /places to.
export function storeUrl(docs: string): string {
  const config = JSON.parse(readFileSync(join(docs, 'vercel.json'), 'utf8')) as { rewrites?: { source: string; destination: string }[] };
  const rule = config.rewrites?.find((r) => r.source.startsWith('/places/'));
  if (!rule) throw new Error('vercel.json: no rewrite for /places/');
  return new URL(rule.destination).origin;
}

// A file from the store's public address, past any cache: the manifest and
// the records are overwritten in place when a re-render is published.
export async function fetchStored(docs: string, pathname: string): Promise<string | undefined> {
  const res = await fetch(`${storeUrl(docs)}/${pathname}?t=${Date.now()}`, { cache: 'no-store' });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`${pathname}: ${res.status}`);
  return res.text();
}

// Fetches the manifest and the records the build reads into build/renders.
// The store is public, so a build needs no token.
export async function fetchRecords(docs: string) {
  for (const pathname of [MANIFEST_BLOB, ...RECORDS]) {
    const text = await fetchStored(docs, pathname);
    if (text === undefined) throw new Error(`${pathname}: the store doesn't hold it`);
    const file = join(docs, FETCHED, pathname);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

// The address a page uses: the same path, with the picture's hash as a query
// so a re-render is a new URL and every cache can keep a picture for a year.
export const versioned = (path: string, e: Entry) => `/${path}?v=${e.sha256.slice(0, 12)}`;

// A render's still, named by its hash: a recording's first frame
// (lib/stills.ts), or a picture (a place's entrance shot) whole; and the
// preview images' copy of a still, scaled up, which only the build reads.
export const stillPath = (e: Entry) => `/stills/${e.sha256.slice(0, 12)}.${e.pathname.endsWith('.png') ? 'png' : 'gif'}`;
export const stillPng = (docs: string, still: string) => join(docs, 'build', still.replace(/\.(gif|png)$/, '-og.png'));
