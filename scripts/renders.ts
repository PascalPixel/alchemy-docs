// Publishes the renders to the Vercel Blob store, and checks a built site's
// pictures against it.
//
//   bun scripts/renders.ts publish FOLDER PREFIX [--prune] [--dry-run]
//   bun scripts/renders.ts check [OUT]
//
// publish uploads every picture under FOLDER to PREFIX/ in the store (places,
// abilities, guides or story), at the pathname its site URL has, public, with
// no random suffix and a year's cache: pages ask for each picture with its
// hash as a query (lib/renders.ts), so a re-render is a new URL. A picture
// whose hash and size the manifest already lists is skipped. --prune deletes
// the store's pictures under PREFIX/ that FOLDER no longer has. The TSV files
// in FOLDER (index.tsv and the renderer's other records) are copied to
// public/PREFIX/, which git keeps. The manifest is written to
// render/manifest.tsv and to the store as renders-manifest.tsv; commit the
// manifest and the TSV files after publishing.
//
// check reads every page under OUT (default out/), and asks the store (HEAD)
// for every render a page shows or links; any other site path must be a file
// in OUT. It prints what is missing and exits 1 if anything is.
//
// BLOB_READ_WRITE_TOKEN is the store's token; Bun reads it from .env.local
// (`vercel env pull .env.local`).
import { del, list, put } from '@vercel/blob';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatManifest, MANIFEST, MANIFEST_BLOB, parseManifest, PREFIXES, readManifest, renderPath, storeUrl, type Entry } from '../lib/renders';

const docs = fileURLToPath(new URL('..', import.meta.url));
const YEAR = 365 * 24 * 60 * 60;
const TYPES: Record<string, string> = { '.png': 'image/png', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

// Pro allows 75 advanced operations a second; uploads stay under 60.
const RATE = 60;
let tokens = RATE;
let last = Date.now();
async function take(n = 1) {
  for (;;) {
    const now = Date.now();
    tokens = Math.min(RATE, tokens + ((now - last) / 1000) * RATE);
    last = now;
    if (tokens >= n) {
      tokens -= n;
      return;
    }
    await new Promise((r) => setTimeout(r, ((n - tokens) / RATE) * 1000));
  }
}

async function retry<T>(what: string, f: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await f();
    } catch (e) {
      if (attempt >= 6) throw e;
      const wait = ((e as { retryAfter?: number }).retryAfter ?? 2 ** attempt) * 1000;
      console.warn(`  ${what}: ${(e as Error).message}; again in ${wait / 1000} s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

async function pool<T>(items: T[], width: number, f: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) await f(items[next++]);
  }));
}

// A PNG's or GIF's size from its header.
function dimensions(file: string, data: Buffer): { width: number; height: number } {
  if (data.subarray(1, 4).toString('latin1') === 'PNG') return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (data.subarray(0, 3).toString('latin1') === 'GIF') return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  throw new Error(`${file}: not a PNG or GIF`);
}

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []));

// The repository's manifest and the store's together. The store's copy can
// be a minute old after an overwrite (its cache), so neither alone is the
// whole list when publishes follow each other; the store's row wins where
// both have one. A row for a picture another machine published stays.
async function storeManifest(): Promise<Map<string, Entry>> {
  const out = readManifest(docs);
  const res = await fetch(`${storeUrl(docs)}/${MANIFEST_BLOB}?t=${Date.now()}`, { cache: 'no-store' });
  if (res.ok) for (const [p, e] of parseManifest(await res.text())) out.set(p, e);
  else if (res.status !== 404) throw new Error(`${MANIFEST_BLOB}: ${res.status}`);
  return out;
}

async function publish(folder: string, prefix: string, prune: boolean, dry: boolean) {
  if (!PREFIXES.includes(prefix as never)) throw new Error(`${prefix}: not one of ${PREFIXES.join(', ')}`);
  if (!dry && !process.env.BLOB_READ_WRITE_TOKEN) throw new Error('BLOB_READ_WRITE_TOKEN is not set (vercel env pull .env.local)');
  const manifest = await storeManifest();
  const files = walk(folder).sort();
  const pictures = files.filter((f) => TYPES[extname(f).toLowerCase()]);
  const records = files.filter((f) => extname(f) === '.tsv');
  const local = new Map<string, { file: string; entry: Entry }>();
  for (const file of pictures) {
    const data = readFileSync(file);
    const pathname = `${prefix}/${relative(folder, file).split('\\').join('/')}`;
    const sha256 = createHash('sha256').update(data).digest('hex');
    local.set(pathname, { file, entry: { pathname, sha256, bytes: data.length, ...dimensions(file, data) } });
  }
  const changed = [...local.values()].filter(({ entry }) => {
    const had = manifest.get(entry.pathname);
    return !had || had.sha256 !== entry.sha256 || had.bytes !== entry.bytes;
  });
  const bytes = changed.reduce((n, c) => n + c.entry.bytes, 0);
  console.log(`${prefix}: ${local.size} pictures, ${changed.length} new or changed (${(bytes / 1e6).toFixed(1)} MB)`);

  // What the store has under the prefix that the folder doesn't.
  let gone: string[] = [];
  if (prune) {
    const stored = new Set([...manifest.keys()].filter((p) => p.startsWith(`${prefix}/`)));
    if (!dry) {
      let cursor: string | undefined;
      do {
        await take();
        const page = await retry('list', () => list({ prefix: `${prefix}/`, cursor, limit: 1000 }));
        for (const b of page.blobs) stored.add(b.pathname);
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
    }
    gone = [...stored].filter((p) => !local.has(p)).sort();
    console.log(`${prefix}: ${gone.length} to delete`);
  }
  if (dry) {
    for (const c of changed.slice(0, 20)) console.log(`  put ${c.entry.pathname}`);
    for (const p of gone.slice(0, 20)) console.log(`  delete ${p}`);
    return;
  }

  let done = 0;
  const started = Date.now();
  await pool(changed, 24, async ({ file, entry }) => {
    await take();
    await retry(entry.pathname, () =>
      put(entry.pathname, readFileSync(file), {
        access: 'public',
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: TYPES[extname(file).toLowerCase()],
        cacheControlMaxAge: YEAR,
      }),
    );
    manifest.set(entry.pathname, entry);
    if (++done % 250 === 0) console.log(`  ${done} of ${changed.length} in ${((Date.now() - started) / 1000).toFixed(0)} s`);
  });
  for (let i = 0; i < gone.length; i += 50) {
    const batch = gone.slice(i, i + 50);
    await take(batch.length);
    await retry('delete', () => del(batch.map((p) => `${storeUrl(docs)}/${p}`)));
    for (const p of batch) manifest.delete(p);
  }
  // Entries the store had for files that still exist keep their row; a row
  // for a picture this folder dropped stays until it is pruned.
  for (const { entry } of local.values()) manifest.set(entry.pathname, entry);
  const text = formatManifest(manifest.values());
  writeFileSync(join(docs, MANIFEST), text);
  await take();
  await retry(MANIFEST_BLOB, () => put(MANIFEST_BLOB, text, { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'text/tab-separated-values; charset=utf-8', cacheControlMaxAge: 60 }));
  const into = join(docs, 'public', prefix);
  if (relative(into, folder)) {
    mkdirSync(into, { recursive: true });
    for (const f of records) copyFileSync(f, join(into, relative(folder, f)));
  }
  console.log(`${prefix}: ${done} uploaded (${(bytes / 1e6).toFixed(1)} MB), ${gone.length} deleted, ${records.length} records in public/${prefix}, in ${((Date.now() - started) / 1000).toFixed(0)} s`);
}

async function check(out: string) {
  const base = storeUrl(docs);
  const pages = walk(out).filter((f) => f.endsWith('.html'));
  const renders = new Map<string, string>(); // pathname: a page that shows it
  const local = new Map<string, string>();
  for (const page of pages) {
    const html = readFileSync(page, 'utf8');
    for (const m of html.matchAll(/\b(?:src|href|srcset)="(\/[^"#?]*)(?:\?[^"#]*)?(?:#[^"]*)?"/g)) {
      const path = decodeURI(m[1]);
      const render = renderPath(path);
      if (render) renders.set(render, renders.get(render) ?? relative(out, page));
      else if (/\.[a-z0-9]+$/i.test(path) && !path.startsWith('/_next/')) local.set(path, local.get(path) ?? relative(out, page));
    }
  }
  const missing: string[] = [];
  for (const [path, page] of local) {
    try {
      statSync(join(out, path));
    } catch {
      missing.push(`${path} (${page}): not in ${out}`);
    }
  }
  let asked = 0;
  await pool([...renders], 32, async ([path, page]) => {
    const res = await retry(path, () => fetch(`${base}/${path}`, { method: 'HEAD' }));
    asked++;
    if (!res.ok) missing.push(`/${path} (${page}): ${res.status}`);
    else if (!res.headers.get('content-type')?.startsWith('image/')) missing.push(`/${path} (${page}): ${res.headers.get('content-type')}`);
  });
  console.log(`check: ${pages.length} pages, ${asked} renders asked of the store, ${local.size} local files`);
  for (const m of missing.sort()) console.log(`  missing ${m}`);
  if (missing.length) process.exit(1);
}

const [command, ...args] = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const plain = args.filter((a) => !a.startsWith('--'));
if (command === 'publish' && plain.length === 2) await publish(plain[0], plain[1], flags.has('--prune'), flags.has('--dry-run'));
else if (command === 'check') await check(plain[0] ?? join(docs, 'out'));
else {
  console.error('usage: bun scripts/renders.ts publish FOLDER PREFIX [--prune] [--dry-run]\n       bun scripts/renders.ts check [OUT]');
  process.exit(2);
}
