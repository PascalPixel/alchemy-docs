// Puts Alchemy's accepted progress figures in public/: bun scripts/figures.ts
//
// CI accepts each landing's measurement and archives `<commit>.site.tar.gz`
// in Alchemy's report archive: the `decomp-reports` release and its numbered
// successors (`decomp-reports-2` and on), since GitHub holds 1,000 assets in a
// release. This takes the archive for the cloned commit, or the newest one
// when that commit's CI has not finished.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const docs = fileURLToPath(new URL('..', import.meta.url));
const repo = process.env.ALCHEMY ?? join(docs, '../alchemy');
const FILES = ['PROGRESS.png', 'PROGRESS_CHART.png', 'history.tsv', 'source.tsv'];

type Asset = { name: string; created_at: string; browser_download_url: string };

const volume = (tag: string): number => {
  if (tag === 'decomp-reports') return 1;
  const n = /^decomp-reports-([1-9][0-9]*)$/.exec(tag)?.[1];
  return n && Number(n) > 1 ? Number(n) : 0;
};

async function reportAssets(): Promise<Asset[]> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const assets: Asset[] = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`https://api.github.com/repos/PascalPixel/alchemy/releases?per_page=100&page=${page}`, { headers });
    if (!res.ok) throw new Error(`releases: ${res.status}`);
    const releases = (await res.json()) as { tag_name: string; assets: Asset[] }[];
    for (const r of releases) if (volume(r.tag_name)) assets.push(...r.assets);
    if (releases.length < 100) break;
  }
  if (!assets.length) throw new Error('release: no report archive');
  return assets;
}

const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const assets = await reportAssets();
let site = assets.find((a) => a.name === `${head}.site.tar.gz`);
if (!site) {
  const sites = assets.filter((a) => a.name.endsWith('.site.tar.gz')).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  site = sites[sites.length - 1];
  if (!site) throw new Error('release: no site archive');
  console.log(`figures: ${head} not accepted yet, using ${site.name}`);
}
const name = site.name;
const res = await fetch(site.browser_download_url);
if (!res.ok) throw new Error(`${name}: ${res.status}`);

const tmp = mkdtempSync(join(tmpdir(), 'figures-'));
const archive = join(tmp, name);
writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
const listed = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
if (listed.join() !== FILES.join()) throw new Error(`${name}: holds ${listed.join(', ')}`);
const out = join(docs, 'public');
mkdirSync(out, { recursive: true });
execFileSync('tar', ['-xzf', archive, '-C', out]);
console.log(`figures: ${name}`);
