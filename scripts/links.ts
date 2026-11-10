// Checks the site as built (dist/public): every link from a page to another
// page leads to one that was written, and every link to a heading to an id
// that page has. `bun run build` ends with it, so a page that moves or a
// heading that is renamed fails the build instead of leaving a dead link.
// The pictures the Blob store serves (vercel.json) and files are not pages.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist/public', import.meta.url));
const NOT_PAGES = ['assets', 'RSC', 'stills', 'og', 'llms.mdx', 'api'];
const STORED = /^\/(places|abilities|guides|story)\//;

const pages = new Map<string, string>();
const walk = (dir: string) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) {
      if (dir !== root || !NOT_PAGES.includes(e.name)) walk(path);
    } else if (e.name.endsWith('.html') && path !== join(root, '404.html')) {
      const url = `/${path.slice(root.length + 1)}`.replace(/\/index\.html$/, '').replace(/\.html$/, '') || '/';
      pages.set(url, readFileSync(path, 'utf8'));
    }
  }
};
walk(root);

const ids = new Map<string, Set<string>>();
const idsOf = (url: string) => {
  if (!ids.has(url)) ids.set(url, new Set([...pages.get(url)!.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
  return ids.get(url)!;
};

const dead = new Map<string, string[]>();
const note = (target: string, from: string) => dead.set(target, [...(dead.get(target) ?? []), from]);
let checked = 0;
for (const [url, html] of pages) {
  // The sidebar is the same on every page, and is checked on the first.
  const body = checked ? html.replace(/<aside[\s\S]*?<\/aside>/g, '') : html;
  for (const m of body.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)) {
    const href = m[1].replace(/&amp;/g, '&');
    if (/^[a-z]+:/.test(href) || href.startsWith('//')) continue;
    const [to, hash] = href.split('#');
    if (to && !to.startsWith('/')) continue;
    const path = to ? to.replace(/\/$/, '') || '/' : url;
    if (STORED.test(path) || /\.\w+$/.test(path)) continue;
    checked++;
    if (!pages.has(path)) {
      if (!existsSync(join(root, path))) note(path, url);
    } else if (hash && !idsOf(path).has(decodeURIComponent(hash))) note(`${path}#${hash}`, url);
  }
}

console.log(`links: ${checked} checked on ${pages.size} pages, ${dead.size} dead`);
for (const [target, from] of dead) console.log(`  ${target}  from ${from[0]}${from.length > 1 ? ` and ${from.length - 1} more` : ''}`);
if (dead.size) process.exit(1);
