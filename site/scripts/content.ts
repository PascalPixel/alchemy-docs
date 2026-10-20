// Builds the generated part of the site from the repository: the home page
// from the README, the guides from the folder READMEs, and a reference page
// for every C file of both games, from Doxygen's XML. Everything it writes is
// ignored by git; `bun run content` rebuilds it, and `bun run build` runs it
// first. The hand-written pages (.mdx) and the sidebar's order (meta.json)
// around them are tracked.

import { DOMParser } from '@xmldom/xmldom';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { filter } from './filter';

const docs = fileURLToPath(new URL('..', import.meta.url));
// The Alchemy checkout it reads: ALCHEMY, or the one beside this repository.
const repo = process.env.ALCHEMY ?? join(docs, '../../alchemy');
const content = join(docs, 'content/docs');
const work = join(docs, '.doxygen');
const github = 'https://github.com/PascalPixel/alchemy/blob/main';

type Game = 'tbs' | 'tla';
const GAMES: Record<Game, { edition: string; tla: number }> = {
  tbs: { edition: 'TBS_EDITION_EN', tla: 0 },
  tla: { edition: 'TLA_EDITION_EN', tla: 1 },
};
const ROOTS = ['src', 'include'];

const yaml = (s: string) => JSON.stringify(s);
const MD_SPECIAL = /[\\`*_{}[\]<>#|~]/g;
const escape = (s: string) => s.replace(MD_SPECIAL, (c) => `\\${c}`);
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-|-$/g, '');

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function page(path: string, front: Record<string, string>, body: string) {
  const head = Object.entries(front)
    .map(([k, v]) => `${k}: ${yaml(v)}`)
    .join('\n');
  write(join(content, path), `---\n${head}\n---\n\n${body.trim()}\n`);
}

// ---------------------------------------------------------------------------
// Where things are on the site.

// A source file's or folder's page, from its path in the repository.
function sourceUrl(path: string): string | undefined {
  const m = path.replace(/\/$/, '').match(/^games\/(tbs|tla)(?:\/(.*))?$/);
  if (!m) return;
  const [, game, rest = ''] = m;
  if (rest && !ROOTS.includes(rest.split('/')[0])) return;
  const url = `/docs/${game}/source${rest ? '/' + rest : ''}`;
  return /\.[ch]$/.test(rest) ? url.replace(/\.([ch])$/, '-$1') : url;
}

// The guides: each ☀️ folder README, where its page sits and its title.
const GUIDES: [string, string, string][] = [
  ['field', 'world/field', 'Field'],
  ['object', 'world/objects', 'Field objects'],
  ['scene', 'world/scenes', 'Scenes'],
  ['battle', 'battle/battles', 'Battles'],
  ['effect', 'battle/effects/index', 'Battle effects'],
  ['menu', 'menus/menus', 'Menus'],
  ['window', 'menus/windows', 'Windows'],
  ['shop', 'menus/shops', 'Shops'],
  ['game', 'game', 'Game rules'],
  ['graphics', 'engine/graphics', 'Graphics'],
  ['sound', 'engine/sound', 'Sound'],
  ['runtime', 'engine/runtime', 'Runtime'],
  ['system', 'engine/system', 'System'],
  ['debug', 'engine/debug', 'Debug rooms'],
];
const guideUrl = (target: string) => `/docs/tbs/${target.replace(/\/index$/, '')}`;
const guideOf = new Map(GUIDES.map(([folder, target, title]) => [`games/tbs/src/${folder}`, { url: guideUrl(target), title }]));

// A link in a README, pointed at the site where the site has the page.
function siteLink(path: string): string {
  const clean = normalize(path).replace(/\/$/, '');
  if (clean === 'README.md') return '/docs';
  const guide = guideOf.get(dirname(clean));
  if (guide && basename(clean) === 'README.md') return guide.url;
  const url = existsSync(join(repo, clean)) ? sourceUrl(clean) : undefined;
  return url ?? `${github}/${clean}`;
}

// ---------------------------------------------------------------------------
// The prose pages: the README and the folder READMEs, without their first
// heading (the page's title) and with their repository links resolved.

function prose(source: string, target: string, title: string, description: string, after = '') {
  let text = readFileSync(join(repo, source), 'utf8');
  const heading = text.match(/^# (.+)\n+/);
  if (heading) text = text.slice(heading[0].length);
  text = text.replace(/(!?)\[([^\]]*)\]\(([^)#\s]*)(#[^)]*)?\)/g, (all, bang: string, label: string, link: string, hash = '') => {
    if (/^[a-z]+:/.test(link)) return all;
    if (!link) return all;
    const resolved = normalize(join(dirname(source), link));
    if (bang) return `![${label}](${github.replace('/blob/', '/raw/')}/${resolved}${hash})`;
    return `[${label}](${siteLink(resolved)}${hash})`;
  });
  page(target, { title, description, source }, text + after);
}

function guides() {
  for (const [folder, target, title] of GUIDES) {
    const dir = `games/tbs/src/${folder}`;
    const readme = readFileSync(join(repo, dir, 'README.md'), 'utf8');
    // The description: the README's first paragraph, if it is short.
    const first = readme.replace(/^# .+\n+/, '').split('\n\n')[0].replace(/\s+/g, ' ').trim();
    const description = first.length < 200 && !first.startsWith('#') ? first.replace(/[`*]/g, '') : '';
    prose(`${dir}/README.md`, `tbs/${target}.md`, title, description, `\n\n## Source\n\nEvery file of this folder: [${dir}](${sourceUrl(dir)}).\n`);
  }
}

// ---------------------------------------------------------------------------
// Doxygen: each game's src and include, filtered into .doxygen/src so a laid
// out paragraph stays as written, then read by one Doxygen run per game.

function walk(rel: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(repo, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) walk(r, out);
    else if (/\.[ch]$/.test(e.name)) out.push(r);
  }
  return out;
}

const filesOf = new Map<Game, string[]>();

function doxygen(game: Game): Promise<void> {
  const out = join(work, game);
  mkdirSync(out, { recursive: true });
  const { edition, tla } = GAMES[game];
  return new Promise((resolve, reject) => {
    const run = spawn('doxygen', ['doxygen/Doxyfile'], {
      cwd: docs,
      stdio: ['ignore', 'inherit', 'pipe'],
      env: { ...process.env, GAME: game, GAME_TLA: String(tla), EDITION: edition },
    });
    // Doxygen's comment parser reports the source's <blanks> as unknown
    // HTML even with warnings off; nothing here depends on them.
    run.stderr.resume();
    run.on('error', () => reject(new Error('doxygen failed; is it installed (brew install doxygen)?')));
    run.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`doxygen (${game}) exited with ${code}`))));
  });
}

async function runDoxygen() {
  rmSync(work, { recursive: true, force: true });
  for (const game of Object.keys(GAMES) as Game[]) {
    const files = ROOTS.flatMap((r) => walk(`games/${game}/${r}`));
    filesOf.set(game, files);
    for (const f of files) write(join(work, 'src', f), filter(readFileSync(join(repo, f), 'utf8')));
  }
  await Promise.all((Object.keys(GAMES) as Game[]).map(doxygen));
}

// ---------------------------------------------------------------------------
// Doxygen's XML.

type El = Element;

function children(el: El | null | undefined, tag?: string): El[] {
  if (!el) return [];
  const out: El[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (!tag || (n as El).tagName === tag)) out.push(n as El);
  }
  return out;
}
const child = (el: El | null | undefined, tag: string) => children(el, tag)[0];
const text = (el: El | null | undefined) => (el?.textContent ?? '').trim();

interface Member {
  id: string;
  game: Game;
  kind: string; // function, variable, define, enum, typedef, struct
  name: string;
  el: El;
  file: string; // the file it is on the page of, from the repository root
  line: number;
  start: number;
  end: number;
  page: string; // the page's URL
  anchor: string;
  values: string[]; // an enum's value names
}

interface SourceFile {
  game: Game;
  path: string;
  el?: El;
  members: Member[];
}

const members = new Map<string, Member>(); // by game and Doxygen id
const files = new Map<string, SourceFile>(); // by path
const fileIds = new Map<string, SourceFile>(); // by game and Doxygen id
const byName = new Map<string, Member>(); // by game and C name
const sourceCache = new Map<string, string[]>();

function sourceLines(file: string): string[] {
  let lines = sourceCache.get(file);
  if (!lines) {
    lines = readFileSync(join(repo, file), 'utf8').split('\n');
    sourceCache.set(file, lines);
  }
  return lines;
}

function readMembers(game: Game) {
  for (const path of filesOf.get(game)!) files.set(path, { game, path, members: [] });
  const xmlDir = join(work, game, 'xml');
  const parser = new DOMParser();
  // A member is listed in each file that declares it, sometimes under two
  // ids: one member per definition.
  const seen = new Map<string, Member>();
  const add = (m: Omit<Member, 'page' | 'anchor' | 'game'>) => {
    const key = `${game}:${m.id}`;
    if (members.has(key)) return;
    const where = `${m.kind} ${m.name} ${m.file}:${m.line}`;
    const known = seen.get(where);
    if (known) {
      members.set(key, known);
      return;
    }
    const full: Member = { ...m, game, page: '', anchor: '' };
    seen.set(where, full);
    members.set(key, full);
    files.get(m.file)?.members.push(full);
  };
  for (const file of readdirSync(xmlDir)) {
    if (!file.endsWith('.xml') || file === 'index.xml' || file === 'Doxyfile.xml' || file.startsWith('dir_')) continue;
    const root = parser.parseFromString(readFileSync(join(xmlDir, file), 'utf8'), 'text/xml').documentElement as unknown as El;
    for (const compound of children(root, 'compounddef')) {
      const kind = compound.getAttribute('kind');
      const loc = child(compound, 'location');
      if (kind === 'struct' || kind === 'union') {
        add({
          id: compound.getAttribute('id')!,
          kind: 'struct',
          name: text(child(compound, 'compoundname')),
          el: compound,
          file: loc.getAttribute('file')!,
          line: Number(loc.getAttribute('line')),
          start: Number(loc.getAttribute('bodystart') ?? loc.getAttribute('line')),
          end: Number(loc.getAttribute('bodyend') ?? -1),
          values: [],
        });
        continue;
      }
      if (kind !== 'file') continue;
      const f = files.get(loc.getAttribute('file')!);
      if (f) {
        f.el = compound;
        fileIds.set(`${game}:${compound.getAttribute('id')}`, f);
      }
      for (const sec of children(compound, 'sectiondef')) {
        for (const el of children(sec, 'memberdef')) {
          const l = child(el, 'location');
          // A function belongs where its body is; a prototype in a header
          // adds its comment to it. A function with no body in C (assembly,
          // or a far call) stays on the header that declares it.
          const body = l.getAttribute('bodyfile');
          const k = el.getAttribute('kind')!;
          const onBody = !!body && files.has(body);
          add({
            id: el.getAttribute('id')!,
            kind: k,
            name: text(child(el, 'name')),
            el,
            file: onBody ? body! : l.getAttribute('file')!,
            line: onBody && Number(l.getAttribute('bodystart')) > 0 ? Number(l.getAttribute('bodystart')) : Number(l.getAttribute('line')),
            start: onBody && Number(l.getAttribute('bodystart')) > 0 ? Number(l.getAttribute('bodystart')) : Number(l.getAttribute('line')),
            end: Number((onBody && l.getAttribute('bodyend')) || -1),
            values: children(el, 'enumvalue').map((v) => text(child(v, 'name'))),
          });
          for (const v of children(el, 'enumvalue')) {
            members.set(`${game}:${v.getAttribute('id')}`, members.get(`${game}:${el.getAttribute('id')}`)!);
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Doxygen's markup as Markdown.

let current: Game = 'tbs';

// Names in a comment that match something documented in the same game
// become links.
function linkWords(raw: string, self: string): string {
  return raw
    .split(/([A-Za-z_][A-Za-z0-9_]*)/)
    .map((part, i) => {
      if (i % 2 === 0) return escape(part);
      const m = byName.get(`${current}:${part}`);
      if (m && part !== self && part.length > 3 && /[_A-Z]/.test(part.slice(1))) {
        return `[${escape(part)}](${m.page}#${m.anchor})`;
      }
      return escape(part);
    })
    .join('');
}

function refUrl(refid: string): string | undefined {
  const m = members.get(`${current}:${refid}`);
  if (m) return `${m.page}#${m.anchor}`;
  const f = fileIds.get(`${current}:${refid}`);
  if (f) return sourceUrl(f.path);
}

function inline(el: El, self: string): string {
  let out = '';
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3) out += linkWords((n.nodeValue ?? '').replace(/\s+/g, ' '), self);
    else if (n.nodeType === 1) {
      const e = n as El;
      const tag = e.tagName;
      if (tag === 'ref') {
        const url = refUrl(e.getAttribute('refid') ?? '');
        out += url ? `[${escape(text(e))}](${url})` : escape(text(e));
      } else if (tag === 'verbatim' || tag === 'preformatted') {
        // A paragraph the filter kept as written. Doxygen keeps the comment
        // marks of its later lines and drops the first line's indent.
        const raw = (e.textContent ?? '')
          .split('\n')
          .map((l) => l.replace(/^\/\/\/ ?/, '').trimEnd())
          .filter((l) => l.trim() !== '');
        const rest = raw.slice(1).map((l) => l.match(/^ */)![0].length);
        const indent = rest.length ? Math.min(...rest) : 0;
        const first = raw[0]?.trimStart() ?? '';
        const listLike = /^(\d+\.|[a-z]\.|- )/.test(first);
        const shown = listLike ? [first, ...raw.slice(1)] : [first, ...raw.slice(1).map((l) => l.slice(indent))];
        out += '\n\n```text\n' + shown.join('\n') + '\n```\n\n';
      } else if (tag === 'programlisting') {
        const lines = children(e, 'codeline').map((c) => (c.textContent ?? '').replace(/ /g, ' '));
        out += '\n\n```c\n' + lines.join('\n') + '\n```\n\n';
      } else if (tag === 'computeroutput') out += '`' + text(e).replace(/`/g, "'") + '`';
      else if (tag === 'emphasis') out += '*' + inline(e, self).trim() + '*';
      else if (tag === 'bold') out += '**' + inline(e, self).trim() + '**';
      else if (tag === 'ulink') out += `[${inline(e, self).trim()}](${e.getAttribute('url')})`;
      else if (tag === 'sp') out += ' ';
      else if (tag === 'linebreak') out += '\n';
      else if (tag === 'itemizedlist' || tag === 'orderedlist') {
        const mark = tag === 'orderedlist' ? (i: number) => `${i + 1}. ` : () => '- ';
        out +=
          '\n\n' +
          children(e, 'listitem')
            .map((li, i) => mark(i) + block(li, self).replace(/\n/g, '\n   '))
            .join('\n') +
          '\n\n';
      } else if (tag === 'simplesect') {
        const k = e.getAttribute('kind');
        const label = k === 'return' ? 'Returns' : k === 'note' ? 'Note' : k === 'see' ? 'See' : k === 'warning' ? 'Warning' : '';
        const body = block(e, self);
        out += '\n\n' + (label ? `**${label}:** ` : '') + body + '\n\n';
      } else if (tag === 'parameterlist') {
        const items = children(e, 'parameteritem').map((item) => {
          const names = children(child(item, 'parameternamelist'), 'parametername').map(text).join(', ');
          return `- \`${names}\`: ${block(child(item, 'parameterdescription'), self).replace(/\n+/g, ' ')}`;
        });
        out += '\n\n' + items.join('\n') + '\n\n';
      } else if (tag === 'heading') out += '\n\n**' + inline(e, self).trim() + '**\n\n';
      else if (tag === 'para') out += '\n\n' + inline(e, self).trim() + '\n\n';
      else out += inline(e, self);
    }
  }
  return out;
}

function block(el: El | undefined, self: string): string {
  if (!el) return '';
  return children(el, 'para')
    .map((p) =>
      inline(p, self)
        .trim()
        .replace(/^([-+]|\d+\.) /, '\\$1 '),
    )
    .filter(Boolean)
    .join('\n\n');
}

const plain = (el: El | undefined) => text(el).replace(/\s+/g, ' ');

function description(m: Member): string {
  return [block(child(m.el, 'briefdescription'), m.name), block(child(m.el, 'detaileddescription'), m.name)]
    .filter(Boolean)
    .join('\n\n');
}

// The member's own lines of source, trailing comments included: Doxygen keeps
// only the comments above a declaration. A long table shows its first lines.
const SNIPPET_LINES = 16;

function snippet(m: Member): string {
  const lines = sourceLines(m.file);
  let end = m.end > 0 ? m.end : m.start;
  if (m.kind === 'define') while (lines[end - 1]?.endsWith('\\')) end++;
  if (m.kind === 'variable' && m.end <= 0) {
    while (end < lines.length && !lines[end - 1].includes(';')) end++;
  }
  const shown = lines.slice(m.start - 1, end);
  if (shown.length <= SNIPPET_LINES) return shown.join('\n');
  return [...shown.slice(0, SNIPPET_LINES), `/* … ${shown.length - SNIPPET_LINES} more lines */`].join('\n');
}

function signature(m: Member): string {
  const el = m.el;
  if (m.kind === 'function') {
    const isStatic = el.getAttribute('static') === 'yes' ? 'static ' : '';
    const type = text(child(el, 'type'));
    const params = children(el, 'param').map((p) => {
      const t = text(child(p, 'type'));
      const n = text(child(p, 'declname'));
      const a = text(child(p, 'array'));
      return n ? `${t}${t.endsWith('*') ? '' : ' '}${n}${a}` : t;
    });
    const head = `${isStatic}${type}${type.endsWith('*') || !type ? '' : ' '}${m.name}(`;
    const one = `${head}${params.join(', ')});`;
    if (one.length <= 80) return one;
    return `${head}\n${params.map((p) => `    ${p}`).join(',\n')});`;
  }
  return snippet(m);
}

function heading(m: Member): string {
  if (m.kind === 'enum' && m.name.startsWith('@')) {
    return `enum \\{ ${escape(m.values[0] ?? '')}${m.values.length > 1 ? ', …' : ''} \\}`;
  }
  const word = m.kind === 'struct' ? (m.el.getAttribute('kind') === 'union' ? 'union ' : 'struct ') : m.kind === 'enum' ? 'enum ' : '';
  return word + escape(m.name);
}

function section(m: Member): string {
  const code = signature(m);
  // A table's rows as plain text: highlighted, the data pages weigh many
  // times their text.
  const lang = m.kind === 'variable' && code.includes('\n') ? 'text' : 'c';
  const out = [`### ${heading(m)} [#${m.anchor}]`, '', '```' + lang, code, '```'];
  const doc = description(m);
  if (doc) out.push('', doc);
  out.push('', `Line [${m.line}](${github}/${m.file}#L${m.line}).`);
  return out.join('\n');
}

const KINDS: [string, string][] = [
  ['struct', 'Structs'],
  ['enum', 'Enums'],
  ['typedef', 'Types'],
  ['define', 'Macros'],
  ['variable', 'Data'],
  ['function', 'Functions'],
];

function sections(list: Member[]): string {
  const out: string[] = [];
  for (const [kind, title] of KINDS) {
    const of = list.filter((m) => m.kind === kind);
    if (!of.length) continue;
    out.push(`## ${title}`, '', ...of.map((m) => section(m) + '\n'));
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// The source pages: one per folder, listing what is in it, and one per file.

const fileName = (path: string) => basename(path).replace(/\.([ch])$/, '-$1');
const summaryOf = (f: SourceFile | undefined) => (f?.el ? plain(child(f.el, 'briefdescription')) : '');
const table = (rows: string[], head: string) => (rows.length ? `${head}\n${rows.join('\n')}\n` : '');

// The ☀️ folders' one-line descriptions, as the Doxygen trial gives them.
const FOLDER_BRIEFS: Record<string, string> = {
  'games/tbs/src/runtime': 'The code the rest of the game stands on.',
  'games/tbs/src/field': 'The field engine.',
  'games/tbs/src/window': 'The window system and the screens built on it.',
  'games/tbs/src/game': 'The game rules and the tables they read.',
  'games/tbs/src/menu': 'The field menu and its screens.',
  'games/tbs/src/shop': 'The counters: shops, the artifact counter and the sanctum.',
  'games/tbs/src/battle': 'Battles, from their opening transition to their spoils.',
  'games/tbs/src/effect': 'Everything drawn over a battle while an ability plays.',
  'games/tbs/src/object': 'A field scene and what plays in it.',
  'games/tbs/src/graphics': 'The pictures and the screens that are mostly pictures.',
  'games/tbs/src/sound': 'The sound cue layer and the sound driver.',
  'games/tbs/src/system': 'What ties the image together: header, IWRAM code, BIOS calls, far calls.',
  'games/tbs/src/debug': 'The three debug rooms the retail game keeps.',
  'games/tbs/src/scene': 'Every place the party can walk around in, one overlay each.',
};

function folderPages(game: Game) {
  const paths = filesOf.get(game)!;
  const dirs = new Map<string, { dirs: Set<string>; files: string[] }>();
  const entry = (d: string) => {
    if (!dirs.has(d)) dirs.set(d, { dirs: new Set(), files: [] });
    return dirs.get(d)!;
  };
  for (const p of paths) {
    entry(dirname(p)).files.push(p);
    for (let d = dirname(p); d !== `games/${game}`; d = dirname(d)) entry(dirname(d)).dirs.add(d);
  }
  const count = (d: string) => paths.filter((p) => p.startsWith(d + '/')).length;
  for (const [dir, { dirs: sub, files: list }] of dirs) {
    const rel = dir.slice(`games/${game}`.length + 1);
    const out = join(content, game, 'source', rel);
    // At the top, src before include, as the build reads them.
    const subs = [...sub].sort((a, b) => (rel ? (a < b ? -1 : 1) : ROOTS.indexOf(basename(a)) - ROOTS.indexOf(basename(b))));
    const guide = guideOf.get(dir);
    const brief = FOLDER_BRIEFS[dir] ?? '';
    const body = [
      `Source: [${escape(dir)}](${github.replace('/blob/', '/tree/')}/${dir}).`,
      guide ? `Guide: [${guide.title}](${guide.url}).` : '',
      table(
        subs.map((d) => `| [${escape(basename(d))}/](${sourceUrl(d)}) | ${count(d)} | ${escape(FOLDER_BRIEFS[d] ?? '')} |`),
        '## Folders\n\n| Folder | Files | |\n| --- | --- | --- |',
      ),
      table(
        list.map((p) => `| [${escape(basename(p))}](${sourceUrl(p)}) | ${linkWords(summaryOf(files.get(p)), '')} |`),
        '## Files\n\n| File | |\n| --- | --- |',
      ),
    ]
      .filter(Boolean)
      .join('\n\n');
    write(
      join(out, 'index.md'),
      `---\ntitle: ${yaml(rel ? basename(dir) + '/' : 'Source')}\ndescription: ${yaml(brief || (rel ? `${count(dir)} files in ${dir}.` : `Every C file of ${dir}.`))}\nsource: ${yaml(dir)}\n---\n\n${body}\n`,
    );
    write(
      join(out, 'meta.json'),
      JSON.stringify({ title: rel ? basename(dir) : 'Source', pages: [...subs.map((d) => basename(d)), ...list.map(fileName)] }) + '\n',
    );
  }
}

function filePage(f: SourceFile) {
  current = f.game;
  const lines = sourceLines(f.path);
  // An object written as parts lists them, in the order it includes them.
  const parts = lines
    .map((l) => l.match(/^#include "([\w/]+\.c)"/)?.[1])
    .filter((p): p is string => !!p)
    .map((p) => normalize(join(dirname(f.path), p)))
    .filter((p) => files.has(p));
  const partRows = parts.map((p) => `| [${escape(basename(p))}](${sourceUrl(p)}) | ${files.get(p)!.members.filter((m) => m.kind === 'function').length} | ${linkWords(summaryOf(files.get(p)), '')} |`);
  const brief = summaryOf(f);
  const detail = f.el ? block(child(f.el, 'detaileddescription'), '') : '';
  const sorted = [...f.members].sort((a, b) => a.line - b.line);
  const body = [
    `Source: [${escape(f.path)}](${github}/${f.path}), ${lines.length - 1} lines.`,
    detail,
    table(partRows, '## Parts\n\nThe parts in the order this file includes them, which is the order of their code in the ROM.\n\n| Part | Functions | What it holds |\n| --- | --- | --- |'),
    sections(sorted),
  ]
    .filter(Boolean)
    .join('\n\n');
  const rel = f.path.slice(`games/${f.game}`.length + 1);
  write(
    join(content, f.game, 'source', dirname(rel), fileName(f.path) + '.md'),
    `---\ntitle: ${yaml(basename(f.path))}\ndescription: ${yaml(brief)}\nsource: ${yaml(f.path)}\n---\n\n${body}\n`,
  );
}

// ---------------------------------------------------------------------------
// Reference: every structure, and every name A to Z, per game.

const GAME_TITLE: Record<Game, string> = { tbs: 'The Broken Seal', tla: 'The Lost Age' };

function referencePages(game: Game) {
  current = game;
  const all = [...new Set([...members.values()].filter((m) => m.game === game))];
  const where = (m: Member) => `[${escape(m.file.slice(`games/${game}/`.length))}](${sourceUrl(m.file)})`;
  const structs = all.filter((m) => m.kind === 'struct').sort((a, b) => a.name.localeCompare(b.name));
  page(
    `reference/${game}/structures.md`,
    { title: 'Structures', description: `Every structure and union ${GAME_TITLE[game]} declares.` },
    table(
      structs.map((m) => `| [${escape(m.name)}](${m.page}#${m.anchor}) | ${where(m)} | ${linkWords(plain(child(m.el, 'briefdescription')), m.name)} |`),
      '| Structure | File | |\n| --- | --- | --- |',
    ),
  );
  const named = all.filter((m) => !m.name.startsWith('@'));
  const letterOf = (m: Member) => {
    const c = m.name.replace(/^_+/, '')[0]?.toUpperCase() ?? '_';
    return /[A-Z]/.test(c) ? c : '_';
  };
  const letters = [...new Set(named.map(letterOf))].sort();
  for (const letter of letters) {
    const list = named.filter((m) => letterOf(m) === letter).sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file));
    page(
      `reference/${game}/names/${letter === '_' ? 'other' : letter.toLowerCase()}.md`,
      { title: letter === '_' ? 'Other' : letter, description: `${list.length} names in ${GAME_TITLE[game]}.` },
      table(
        list.map((m) => `| [${escape(m.name)}](${m.page}#${m.anchor}) | ${m.kind === 'define' ? 'macro' : m.kind} | ${where(m)} |`),
        '| Name | Kind | File |\n| --- | --- | --- |',
      ),
    );
  }
  page(
    `reference/${game}/names/index.md`,
    { title: 'All names A–Z', description: `Every function, variable, type, enum and macro of ${GAME_TITLE[game]}, ${named.length} in all.` },
    letters.map((l) => `[${l === '_' ? 'Other' : l}](/docs/reference/${game}/names/${l === '_' ? 'other' : l.toLowerCase()})`).join(' · '),
  );
  write(
    join(content, 'reference', game, 'names/meta.json'),
    JSON.stringify({ pages: letters.map((l) => (l === '_' ? 'other' : l.toLowerCase())) }) + '\n',
  );
  write(join(content, 'reference', game, 'meta.json'), JSON.stringify({ title: GAME_TITLE[game], pages: ['structures', 'names'] }) + '\n');
}

async function apiPages() {
  const started = Date.now();
  await runDoxygen();
  for (const game of Object.keys(GAMES) as Game[]) readMembers(game);
  // URLs and anchors, unique on each page.
  const unique = [...new Set(members.values())];
  const used = new Map<string, Set<string>>();
  for (const m of unique) {
    m.page = sourceUrl(m.file)!;
    let anchor = slug(m.name.startsWith('@') ? `enum-${m.values[0] ?? m.id}` : m.name) || 'member';
    const taken = used.get(m.page) ?? new Set();
    used.set(m.page, taken);
    if (taken.has(anchor)) anchor = `${m.kind}-${anchor}`;
    while (taken.has(anchor)) anchor += '-2';
    taken.add(anchor);
    m.anchor = anchor;
    const key = `${m.game}:${m.name}`;
    if (!m.name.startsWith('@') && !byName.has(key)) byName.set(key, m);
  }
  for (const game of Object.keys(GAMES) as Game[]) {
    current = game;
    folderPages(game);
    referencePages(game);
  }
  for (const f of files.values()) filePage(f);
  console.log(`reference: ${files.size} files, ${unique.length} members, in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

// ---------------------------------------------------------------------------
// Pictures: a few of the effects' sheets, copied from the tracked PNGs.

const PICTURES = [
  'games/tbs/src/graphics/battle_fx/rock_wall.png',
  'games/tbs/src/graphics/battle_fx/fire_pillar_b.png',
  'games/tbs/src/graphics/battle_fx/flame_column.png',
  'games/tbs/src/graphics/battle_fx/blue_burst.png',
];

function pictures() {
  const out = join(docs, 'public/pictures');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const p of PICTURES) {
    if (!existsSync(join(repo, p))) throw new Error(`${p}: missing`);
    copyFileSync(join(repo, p), join(out, basename(p)));
  }
}

// Everything generated, removed first so a deleted file loses its page.
for (const p of ['index.md', 'tbs/source', 'tla/source', 'reference/tbs', 'reference/tla', ...GUIDES.map(([, t]) => `tbs/${t}.md`)]) {
  rmSync(join(content, p), { recursive: true, force: true });
}
prose('README.md', 'index.md', 'Alchemy', 'Golden Sun rebuilt byte for byte from readable C.');
guides();
await apiPages();
pictures();
