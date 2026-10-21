// The renders of the game: the pictures under /places, /abilities, /guides and
// /story. They live in the Vercel Blob store `alchemy-renders`, not in git;
// vercel.json routes each prefix to the store, and render/manifest.tsv lists
// every picture the store holds with its hash, size and dimensions, so the
// build knows what exists and how big it is without the files.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PREFIXES = ['places', 'abilities', 'guides', 'story'] as const;
export type Prefix = (typeof PREFIXES)[number];

export type Entry = { pathname: string; sha256: string; bytes: number; width: number; height: number };

export const MANIFEST = 'render/manifest.tsv';
export const MANIFEST_BLOB = 'renders-manifest.tsv';
export const MANIFEST_HEAD = ['pathname', 'sha256', 'bytes', 'width', 'height'];

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

export function readManifest(docs: string): Map<string, Entry> {
  const file = join(docs, MANIFEST);
  return existsSync(file) ? parseManifest(readFileSync(file, 'utf8')) : new Map();
}

// The store's public address, from the rewrite vercel.json routes /places to.
export function storeUrl(docs: string): string {
  const config = JSON.parse(readFileSync(join(docs, 'vercel.json'), 'utf8')) as { rewrites?: { source: string; destination: string }[] };
  const rule = config.rewrites?.find((r) => r.source.startsWith('/places/'));
  if (!rule) throw new Error('vercel.json: no rewrite for /places/');
  return new URL(rule.destination).origin;
}

// The address a page uses: the same path, with the picture's hash as a query
// so a re-render is a new URL and every cache can keep a picture for a year.
export const versioned = (path: string, e: Entry) => `/${path}?v=${e.sha256.slice(0, 12)}`;

// A render's current pathname: vercel.json's redirects from old render folders
// (`/places/scene-188/:path*`) followed, so a page that names an old address
// shows the picture it now has.
export function renderRedirects(docs: string): (path: string) => string {
  const config = JSON.parse(readFileSync(join(docs, 'vercel.json'), 'utf8')) as { redirects?: { source: string; destination: string }[] };
  const moves = (config.redirects ?? [])
    .filter((r) => renderPath(r.source) && r.source.endsWith('/:path*') && r.destination.endsWith('/:path*'))
    .map((r) => [r.source.slice(1, -':path*'.length), r.destination.slice(1, -':path*'.length)] as const);
  return (path) => {
    const move = moves.find(([from]) => path.startsWith(from));
    return move ? move[1] + path.slice(move[0].length) : path;
  };
}
