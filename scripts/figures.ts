// Puts Alchemy's accepted progress figures in public/: bun scripts/figures.ts
//
// CI accepts each landing's measurement and archives `<commit>.site.tar.gz`
// in Alchemy's `decomp-reports` release. This takes the archive for the
// cloned commit, or the newest one when that commit's CI has not finished.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const docs = join(import.meta.dir, '..');
const repo = process.env.ALCHEMY ?? join(docs, '../alchemy');
const release = 'https://github.com/PascalPixel/alchemy/releases/download/decomp-reports';
const FILES = ['PROGRESS.png', 'PROGRESS_CHART.png', 'history.tsv', 'source.tsv'];

async function newest(): Promise<string> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch('https://api.github.com/repos/PascalPixel/alchemy/releases/tags/decomp-reports', { headers });
  if (!res.ok) throw new Error(`release: ${res.status}`);
  const { assets } = (await res.json()) as { assets: { name: string; created_at: string }[] };
  const sites = assets.filter((a) => a.name.endsWith('.site.tar.gz')).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  if (!sites.length) throw new Error('release: no site archive');
  return sites[sites.length - 1].name;
}

const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
let name = `${head}.site.tar.gz`;
let res = await fetch(`${release}/${name}`);
if (res.status === 404) {
  name = await newest();
  console.log(`figures: ${head} not accepted yet, using ${name}`);
  res = await fetch(`${release}/${name}`);
}
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
