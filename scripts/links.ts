// Checks the site as built (out): every link from a page to another
// page leads to one that was written, and every link to a heading to an id
// that page has. `bun run build` ends with it, so a page that moves or a
// heading that is renamed fails the build instead of leaving a dead link.
// The pictures the Blob store serves (vercel.json) and files are not pages.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../out', import.meta.url));
const NOT_PAGES = ['_next', 'stills', 'og', 'llms.mdx', 'api'];
const STORED = /^\/(places|abilities|guides|story)\//;

// Each page is read once, and only its ids and its links are kept: the
// pages whole would hold gigabytes.
const pages = new Map<string, string>();
const walk = (dir: string) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) {
      if (dir !== root || !NOT_PAGES.includes(e.name)) walk(path);
    } else if (e.name.endsWith('.html') && path !== join(root, '404.html') && path !== join(root, '_not-found.html')) {
      const url = `/${path.slice(root.length + 1)}`.replace(/\/index\.html$/, '').replace(/\.html$/, '') || '/';
      pages.set(url, path);
    }
  }
};
walk(root);

// A string cut from a page would keep the whole page in memory: what is
// kept is copied out of it.
const own = (text: string) => Buffer.from(text).toString();
// Bun collects the pages already read only when asked: left to itself, it
// holds gigabytes of them.
const collect = () => (globalThis as { Bun?: { gc(force: boolean): void } }).Bun?.gc(true);

const ids = new Map<string, Set<string>>();
const links: [from: string, path: string, hash: string | undefined][] = [];
for (const [url, file] of pages) {
  if (ids.size % 100 === 0) collect();
  const html = readFileSync(file, 'utf8');
  ids.set(url, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => own(m[1]))));
  // The sidebar is the same on every page, and is checked on the first.
  const body = links.length ? html.replace(/<aside[\s\S]*?<\/aside>/g, '') : html;
  for (const m of body.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)) {
    const href = m[1].replace(/&amp;/g, '&');
    if (/^[a-z]+:/.test(href) || href.startsWith('//')) continue;
    const [to, hash] = href.split('#');
    if (to && !to.startsWith('/')) continue;
    const path = to ? to.replace(/\/$/, '') || '/' : url;
    if (STORED.test(path) || /\.\w+$/.test(path)) continue;
    links.push([url, own(path), hash && own(hash)]);
  }
}

const dead = new Map<string, string[]>();
const note = (target: string, from: string) => dead.set(target, [...(dead.get(target) ?? []), from]);
for (const [url, path, hash] of links) {
  if (!pages.has(path)) {
    if (!existsSync(join(root, path))) note(path, url);
  } else if (hash && !ids.get(path)!.has(decodeURIComponent(hash))) note(`${path}#${hash}`, url);
}

console.log(`links: ${links.length} checked on ${pages.size} pages, ${dead.size} dead`);
for (const [target, from] of dead) console.log(`  ${target}  from ${from[0]}${from.length > 1 ? ` and ${from.length - 1} more` : ''}`);
if (dead.size) process.exit(1);
