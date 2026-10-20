// Builds the generated part of the site from an Alchemy checkout: the home
// page from the README, the guides from the folder READMEs, and the source
// pages from the games' C, read with tree-sitter. Everything it writes is
// ignored by git; `bun run content` rebuilds it, and `bun run build` runs it
// first. The hand-written pages (.mdx) and the sidebar's order (meta.json)
// around them are tracked.
//
// A source page is a folder of one game: its files, each with its summary
// (the file's /// @file comment) and every function, macro, type, struct and
// global it declares, with their /// comments, fields and values, who calls
// them, and a link to their line on GitHub. A large folder (the scenes, the
// effect parts) gets a page per file instead. Names in comments link to their
// declaration within the same game, so the two games never cross.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, type Node, Parser } from 'web-tree-sitter';

const docs = fileURLToPath(new URL('..', import.meta.url));
// The Alchemy checkout it reads: ALCHEMY, or the one beside this repository.
const repo = process.env.ALCHEMY ?? join(docs, '../alchemy');
const content = join(docs, 'content/docs');
const github = 'https://github.com/PascalPixel/alchemy/blob/main';

type Game = 'tbs' | 'tla';
const GAMES: Game[] = ['tbs', 'tla'];
const ROOTS = ['src', 'include'];
// A folder whose C is larger than this gets a page per file.
const SPLIT_BYTES = 200_000;

const yaml = (s: string) => JSON.stringify(s);

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function page(path: string, front: Record<string, string>, body: string) {
  const head = Object.entries(front)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${yaml(v)}`)
    .join('\n');
  write(join(content, path), `---\n${head}\n---\n\n${body.trim()}\n`);
}

// Text from the source, safe in Markdown outside code: the characters MDX
// and Markdown would read as syntax are escaped, code spans kept as written.
function md(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/[\\<>{}[\]*_#|~]/g, (c) => `\\${c}`)))
    .join('');
}

// ---------------------------------------------------------------------------
// Reading the C.

type Field = { name: string; type: string; doc: string };
type Decl = {
  kind: 'function' | 'prototype' | 'macro' | 'struct' | 'union' | 'enum' | 'typedef' | 'variable';
  name: string;
  signature: string;
  doc: string;
  line: number;
  fields: Field[];
  refs: Set<string>; // names this declaration uses
};
type SourceFile = { path: string; game: Game; summary: string; doc: string; decls: Decl[]; size: number };

const parser = await (async () => {
  await Parser.init();
  const p = new Parser();
  p.setLanguage(await Language.load(join(docs, 'node_modules/tree-sitter-c/tree-sitter-c.wasm')));
  return p;
})();

// A /// block's text: the prefix gone, a laid-out paragraph (a line indented
// past "/// ") kept as a code block, the rest as Markdown.
function docText(lines: string[]): string {
  const body = lines.map((l) => l.replace(/^\s*\/\/\/<?\s?/, ''));
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (!para.length) return;
    const laidOut = para.some((l) => /^ {2,}\S/.test(l)) && !/^\s*- /.test(para[0]);
    out.push(laidOut ? '```text\n' + para.join('\n') + '\n```' : md(para.join('\n')));
    para = [];
  };
  for (const l of body) {
    if (/^\s*$/.test(l)) flush();
    else para.push(l);
  }
  flush();
  return out.join('\n\n');
}

const isDoc = (n: Node | null) => !!n && n.type === 'comment' && /^\/\/\/(?!<)/.test(n.text);
const isTrailing = (n: Node | null) => !!n && n.type === 'comment' && n.text.startsWith('///<');

// The /// lines directly above a node, with no blank line between.
function docAbove(node: Node): string {
  const lines: string[] = [];
  let row = node.startPosition.row;
  for (let c = node.previousNamedSibling; isDoc(c) && c!.endPosition.row === row - 1; c = c!.previousNamedSibling) {
    if (/^\/\/\/\s*@file/.test(c!.text)) break;
    lines.unshift(c!.text);
    row = c!.startPosition.row;
  }
  return docText(lines);
}

// A ///< note on the node's own line, and its continuation lines.
function docAfter(node: Node): string {
  const lines: string[] = [];
  let row = node.endPosition.row;
  for (let c = node.nextNamedSibling; isTrailing(c) && (c!.startPosition.row === row || c!.startPosition.row === row + 1); c = c!.nextNamedSibling) {
    lines.push(c!.text);
    row = c!.endPosition.row;
  }
  return docText(lines);
}

function identifiers(node: Node, into: Set<string>) {
  for (const n of node.descendantsOfType(['identifier', 'type_identifier'])) if (n) into.add(n.text);
}

// The name a declarator declares, through pointers, arrays and parameters.
function declaredName(d: Node | null): string {
  while (d) {
    if (d.type === 'identifier' || d.type === 'field_identifier' || d.type === 'type_identifier') return d.text;
    d = d.childForFieldName('declarator') ?? d.namedChildren.find((c) => c && /declarator|identifier/.test(c.type)) ?? null;
  }
  return '';
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

function fieldsOf(body: Node | null): Field[] {
  if (!body) return [];
  const fields: Field[] = [];
  for (const c of body.namedChildren) {
    if (!c) continue;
    if (c.type === 'field_declaration' || c.type === 'enumerator') {
      const name = c.type === 'enumerator' ? c.childForFieldName('name')!.text : c.descendantsOfType('field_identifier').map((n) => n!.text).join(', ');
      const type = c.type === 'enumerator' ? oneLine(c.childForFieldName('value')?.text ?? '') : oneLine(c.text.replace(/;\s*$/, ''));
      fields.push({ name, type, doc: [docAbove(c), docAfter(c)].filter(Boolean).join('\n\n') });
    } else if (/^preproc_(if|ifdef|else|elif)$/.test(c.type)) {
      fields.push(...fieldsOf(c));
    }
  }
  return fields;
}

function declsOf(parent: Node, out: Decl[]) {
  for (const node of parent.namedChildren) {
    if (!node) continue;
    if (/^preproc_(if|ifdef|else|elif)$/.test(node.type)) {
      declsOf(node, out);
      continue;
    }
    const line = node.startPosition.row + 1;
    const refs = new Set<string>();
    const add = (d: Omit<Decl, 'line' | 'refs' | 'fields'> & { fields?: Field[] }) => {
      if (!d.name) return;
      identifiers(node, refs);
      refs.delete(d.name);
      out.push({ fields: [], ...d, line, refs });
    };
    const doc = [docAbove(node), docAfter(node)].filter(Boolean).join('\n\n');
    if (node.type === 'function_definition') {
      const body = node.childForFieldName('body');
      const signature = oneLine(node.text.slice(0, body ? body.startIndex - node.startIndex : undefined));
      add({ kind: 'function', name: declaredName(node.childForFieldName('declarator')), signature, doc });
    } else if (node.type === 'preproc_def' || node.type === 'preproc_function_def') {
      const name = node.childForFieldName('name')?.text ?? '';
      if (/^ALCHEMY_\w+_H$/.test(name)) continue;
      add({ kind: 'macro', name, signature: node.text.split('\n')[0].replace(/\\$/, '').trim(), doc });
    } else if (node.type === 'type_definition' || node.type === 'struct_specifier' || node.type === 'union_specifier' || node.type === 'enum_specifier' || node.type === 'declaration') {
      const spec = node.type.endsWith('_specifier') ? node : node.childForFieldName('type');
      const body = spec?.childForFieldName('body') ?? null;
      if (spec && body && /^(struct|union|enum)_specifier$/.test(spec.type)) {
        const kind = spec.type.split('_')[0] as 'struct' | 'union' | 'enum';
        const tag = spec.childForFieldName('name')?.text ?? '';
        const alias = node.type === 'type_definition' ? declaredName(node.childForFieldName('declarator')) : '';
        add({ kind, name: tag || alias, signature: `${kind} ${tag || alias}`, doc, fields: fieldsOf(body) });
        continue;
      }
      if (node.type === 'type_definition') {
        add({ kind: 'typedef', name: declaredName(node.childForFieldName('declarator')), signature: oneLine(node.text), doc });
      } else if (node.type === 'declaration') {
        const d = node.childForFieldName('declarator');
        const isFunction = !!d && (d.type === 'function_declarator' || d.descendantsOfType('function_declarator').length > 0) && !node.text.includes('=');
        const text = oneLine(node.text.replace(/=[\s\S]*$/, '').replace(/;\s*$/, ''));
        add({ kind: isFunction ? 'prototype' : 'variable', name: declaredName(d), signature: text, doc });
      }
    }
  }
}

function readFile(path: string, game: Game): SourceFile {
  const text = readFileSync(join(repo, path), 'utf8');
  const tree = parser.parse(text)!;
  const root = tree.rootNode;
  // The file's summary: its /// @file block.
  let doc = '';
  for (const c of root.namedChildren) {
    if (c && isDoc(c) && /^\/\/\/\s*@file/.test(c.text)) {
      const lines: string[] = [];
      let row = c.startPosition.row - 1;
      for (let n: Node | null = c.nextNamedSibling; isDoc(n) && n!.startPosition.row === row + 2; n = n!.nextNamedSibling) {
        lines.push(n!.text);
        row = n!.startPosition.row - 1;
      }
      doc = docText(lines);
      break;
    }
  }
  const decls: Decl[] = [];
  declsOf(root, decls);
  tree.delete();
  const summary = doc.split(/(?<=[.!?])\s/)[0]?.replace(/\n/g, ' ') ?? '';
  return { path, game, summary, doc, decls, size: text.length };
}

function walk(rel: string, out: string[] = []): string[] {
  if (!existsSync(join(repo, rel))) return out;
  for (const e of readdirSync(join(repo, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) walk(r, out);
    else if (/\.[ch]$/.test(e.name)) out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Where things are on the site.

const rel = (path: string) => path.replace(/^games\/(tbs|tla)\//, '');
const fileSlug = (path: string) => basename(path).replace(/\.([ch])$/, '-$1');
const anchor = (name: string) => name.toLowerCase().replace(/[^a-z0-9_-]/g, '');

const split = new Set<string>(); // folders with a page per file
function pageOf(path: string): string {
  const game = path.split('/')[1];
  const dir = dirname(path);
  const base = `/${game}/source/${rel(dir)}`;
  return split.has(dir) ? `${base}/${fileSlug(path)}` : base;
}

// Every declaration's place, per game: the name's first declaration with a
// comment, else its first definition, else its first mention.
const where = new Map<Game, Map<string, { url: string; decl: Decl; file: SourceFile }>>();
function place(game: Game, file: SourceFile, d: Decl) {
  const index = where.get(game)!;
  const known = index.get(d.name);
  const rank = (x: Decl) => (x.doc ? 2 : 0) + (x.kind === 'function' || x.kind === 'struct' || x.kind === 'enum' || x.kind === 'union' ? 1 : 0);
  if (!known || rank(d) > rank(known.decl)) index.set(d.name, { url: documented(d) ? `${pageOf(file.path)}#${anchor(d.name)}` : `${github}/${file.path}#L${d.line}`, decl: d, file });
}

// Names in comments that a game declares become links to them.
function linkNames(text: string, game: Game, self: string): string {
  const index = where.get(game)!;
  return text
    .split(/(```[\s\S]*?```|`[^`]*`|\]\([^)]*\))/)
    .map((part, i) => {
      if (i % 2) {
        const m = part.match(/^`(\w+)(?:\(\))?`$/);
        const hit = m && m[1] !== self ? index.get(m[1]) : undefined;
        return hit ? `[${part}](${hit.url})` : part;
      }
      return part.replace(/\b([A-Za-z_][A-Za-z0-9_]*)(\\_[A-Za-z0-9_\\]+)*\b/g, (word) => {
        const name = word.replace(/\\_/g, '_');
        const hit = name !== self && name.length > 3 && /[A-Z_]/.test(name.slice(1)) ? index.get(name) : undefined;
        return hit ? `[${word}](${hit.url})` : word;
      });
    })
    .join('');
}

// ---------------------------------------------------------------------------
// The source pages.

const KIND_ORDER: Decl['kind'][] = ['function', 'struct', 'union', 'enum', 'typedef', 'macro', 'variable', 'prototype'];
const KIND_TITLE: Record<Decl['kind'], string> = {
  function: 'Functions',
  struct: 'Structures',
  union: 'Unions',
  enum: 'Enumerations',
  typedef: 'Types',
  macro: 'Macros',
  variable: 'Globals',
  prototype: 'Declarations',
};

// Who refers to each name: functions that call it, tables that list it.
const users = new Map<Game, Map<string, Set<string>>>();

function declSection(file: SourceFile, d: Decl, level: string): string {
  const parts = [`${level} ${md(d.name)}`];
  parts.push(`\`${d.signature.replace(/`/g, "'")}\``);
  if (d.doc) parts.push(linkNames(d.doc, file.game, d.name));
  if (d.fields.length) {
    const rows = d.fields.map((f) => `| \`${f.name}\` | ${d.kind === 'enum' ? (f.type ? `\`${f.type}\`` : '') : `\`${f.type.replace(/\|/g, '\\|')}\``} | ${linkNames(f.doc, file.game, d.name).replace(/\n+/g, ' ')} |`);
    parts.push(`| ${d.kind === 'enum' ? 'Value' : 'Field'} | ${d.kind === 'enum' ? '=' : 'Declared as'} | |\n| --- | --- | --- |\n${rows.join('\n')}`);
  }
  const by = users.get(file.game)!.get(d.name);
  const index = where.get(file.game)!;
  if (d.kind !== 'prototype' && by?.size) {
    const list = [...by].sort().slice(0, 40).map((n) => (index.get(n) ? `[${md(n)}](${index.get(n)!.url})` : md(n)));
    parts.push(`Used by ${list.join(', ')}${by.size > 40 ? ` and ${by.size - 40} more` : ''}.`);
  }
  parts.push(`[Line ${d.line}](${github}/${file.path}#L${d.line})`);
  return parts.join('\n\n');
}

const documented = (d: Decl) => !!d.doc || d.fields.some((f) => f.doc);

function fileBody(file: SourceFile, level: string): string {
  const parts: string[] = [];
  if (file.doc) parts.push(linkNames(file.doc, file.game, ''));
  const seen = new Set<string>();
  for (const kind of KIND_ORDER) {
    // A prototype whose function is defined, or documented elsewhere, adds nothing.
    const list = file.decls.filter((d) => d.kind === kind && !seen.has(d.name) && !(kind === 'prototype' && where.get(file.game)!.get(d.name)?.decl !== d));
    for (const d of list) seen.add(d.name);
    // Only what has a comment, or fields with notes, gets a section; the rest
    // is one line of names, each linked to its line.
    const full = list.filter(documented);
    const bare = list.filter((d) => !documented(d));
    if (full.length) {
      parts.push(`${level} ${KIND_TITLE[kind]}`);
      for (const d of full) parts.push(declSection(file, d, level + '#'));
    }
    if (bare.length) parts.push(`${full.length ? `Also, ${KIND_TITLE[kind].toLowerCase()} without a comment` : `${KIND_TITLE[kind]}, without a comment`}: ${bare.map((d) => `[${md(d.name)}](${github}/${file.path}#L${d.line})`).join(', ')}.`);
  }
  return parts.join('\n\n');
}

function sourcePages(game: Game, files: SourceFile[]) {
  const byDir = new Map<string, SourceFile[]>();
  for (const f of files) {
    const d = dirname(f.path);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d)!.push(f);
  }
  // Every folder up to the game's src and include, so each has a page.
  for (const d of [...byDir.keys()]) for (let p = dirname(d); p.split('/').length > 2; p = dirname(p)) if (!byDir.has(p)) byDir.set(p, []);
  for (const [dir, list] of byDir) {
    const target = `${game}/source/${rel(dir)}`;
    const subdirs = [...byDir.keys()].filter((d) => dirname(d) === dir).sort();
    const guide = guideOf.get(dir);
    const head: string[] = [];
    if (guide) head.push(`The [${guide.title}](${guide.url}) guide explains this folder.`);
    if (subdirs.length) head.push(`## Folders\n\n${subdirs.map((d) => `- [${basename(d)}](/${game}/source/${rel(d)})`).join('\n')}`);
    if (split.has(dir)) {
      head.push(`## Files\n\n${list.map((f) => `- [${basename(f.path)}](${pageOf(f.path)})${f.summary ? `: ${md(f.summary)}` : ''}`).join('\n')}`);
      page(`${target}/index.md`, { title: rel(dir), description: '', source: dir }, head.join('\n\n'));
      for (const f of list) page(`${target}/${fileSlug(f.path)}.md`, { title: basename(f.path), description: f.summary.replace(/\\/g, ''), source: f.path }, fileBody(f, '##'));
    } else {
      const body = list.map((f) => `## ${md(basename(f.path))}\n\n[${f.path}](${github}/${f.path})\n\n${fileBody(f, '###')}`);
      page(`${target}/index.md`, { title: rel(dir), description: '', source: dir }, [...head, ...body].join('\n\n'));
    }
  }
}

// ---------------------------------------------------------------------------
// The prose pages: the README, INSTALL and the folder guides, without their
// first heading (the page's title) and with their repository links resolved.

// The guides: each folder README, where its page sits, and its title in the
// sidebar (empty: the README's own heading). The Lost Age's READMEs head
// themselves "The Lost Age: battle" to stay unique in the repository; on the
// site they sit under their game, in The Broken Seal's groups and names.
const GUIDES: [string, string, string][] = [
  ['games/tbs/src/field', 'tbs/world/field', ''],
  ['games/tbs/src/object', 'tbs/world/objects', ''],
  ['games/tbs/src/scene', 'tbs/world/scenes', ''],
  ['games/tbs/src/map', 'tbs/world/maps', ''],
  ['games/tbs/src/battle', 'tbs/battle/battles', ''],
  ['games/tbs/src/effect', 'tbs/battle/effects/index', ''],
  ['games/tbs/src/menu', 'tbs/menus/menus', ''],
  ['games/tbs/src/window', 'tbs/menus/windows', ''],
  ['games/tbs/src/shop', 'tbs/menus/shops', ''],
  ['games/tbs/src/game', 'tbs/game', ''],
  ['games/tbs/src/graphics', 'tbs/engine/graphics', ''],
  ['games/tbs/src/sound', 'tbs/engine/sound', ''],
  ['games/tbs/src/runtime', 'tbs/engine/runtime', ''],
  ['games/tbs/src/system', 'tbs/engine/system', ''],
  ['games/tbs/src/debug', 'tbs/engine/debug', ''],
  ['games/tla/src/field', 'tla/world/field', 'Field'],
  ['games/tla/src/scene', 'tla/world/scenes', 'Scenes'],
  ['games/tla/src/battle', 'tla/battle', 'Battles and effects'],
  ['games/tla/src/menu', 'tla/menus/menus', 'Menus and shops'],
  ['games/tla/src/window', 'tla/menus/windows', 'Windows'],
  ['games/tla/src/game', 'tla/game', 'Game rules'],
  ['games/tla/src/graphics', 'tla/engine/graphics', 'Graphics'],
  ['games/tla/src/sound', 'tla/engine/sound', 'Sound'],
  ['games/tla/src/system', 'tla/engine/system', 'System'],
  ['games/tla/src/lib', 'tla/engine/library', 'Library'],
  ['games/tla/src/debug', 'tla/engine/debug', 'Debug rooms'],
];
const guideOf = new Map<string, { url: string; title: string }>();
for (const [dir, target] of GUIDES) guideOf.set(dir, { url: `/${target.replace(/\/index$/, '')}`, title: '' });

function walkDirs(rel: string): string[] {
  if (!existsSync(join(repo, rel))) return [];
  return readdirSync(join(repo, rel), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(repo, rel, e.name, 'README.md')))
    .map((e) => `${rel}/${e.name}`);
}

// A link in a README, pointed at the site where the site has the page.
function siteLink(path: string): string {
  const clean = normalize(path).replace(/\/$/, '');
  if (clean === 'README.md') return '/';
  if (clean === 'INSTALL.md') return '/start';
  if (clean === 'games/tbs/src/MATCHING.md') return '/tbs/matching';
  const guide = guideOf.get(dirname(clean));
  if (guide && basename(clean) === 'README.md') return guide.url;
  const m = clean.match(/^games\/(tbs|tla)\/((?:src|include)(?:\/.*)?)$/);
  if (m && existsSync(join(repo, clean))) return /\.[ch]$/.test(clean) ? pageOf(clean) : `/${m[1]}/source/${m[2]}`;
  return `${github}/${clean}`;
}

function prose(source: string, target: string, description = '', after = '', named = ''): string {
  let text = readFileSync(join(repo, source), 'utf8');
  const heading = text.match(/^# (.+?)(?: \{#[\w-]+\})?\n+/);
  const title = named || (heading ? heading[1] : basename(source));
  if (heading) text = text.slice(heading[0].length);
  text = text.replace(/(!?)\[([^\]]*)\]\(([^)#\s]*)(#[^)]*)?\)/g, (all, bang: string, label: string, link: string, hash = '') => {
    if (/^[a-z]+:/.test(link) || !link) return all;
    const resolved = normalize(join(dirname(source), link));
    if (bang) return `![${label}](${github.replace('/blob/', '/raw/')}/${resolved}${hash})`;
    return `[${label}](${siteLink(resolved)}${hash})`;
  });
  // MDX would read a bare < or { as markup.
  text = text
    .split(/(```[\s\S]*?```|`[^`]*`)/)
    .map((p, i) => (i % 2 ? p : p.replace(/<(?![a-z/!])/g, '&lt;').replace(/[{}]/g, (c) => `\\${c}`)))
    .join('');
  if (!description) {
    const first = text.split('\n\n')[0].replace(/\s+/g, ' ').trim();
    description = first.length < 200 && !first.startsWith('#') && !first.startsWith('|') ? first.replace(/[`*]|\[([^\]]*)\]\([^)]*\)/g, '$1') : '';
  }
  page(target, { title, description, source }, text + after);
  return title;
}

function guides() {
  for (const [dir, target, named] of GUIDES) {
    if (!existsSync(join(repo, dir, 'README.md'))) continue;
    const game = dir.split('/')[1];
    const after = walk(dir).length ? `\n\n## Source\n\nEvery file of this folder: [${rel(dir)}](/${game}/source/${rel(dir)}).\n` : '';
    guideOf.get(dir)!.title = prose(`${dir}/README.md`, `${target}.md`, '', after, named);
  }
  prose('games/tbs/src/MATCHING.md', 'tbs/matching.md');
}

// ---------------------------------------------------------------------------
// Finding code by what the player sees: the places (each scene's summary)
// and the abilities (each effect's "Abilities:" line).

function places(files: SourceFile[]) {
  const scenes = files.filter((f) => /^games\/tbs\/src\/scene\/[^/]+\.c$/.test(f.path));
  const rows = scenes.map((f) => `| [${basename(f.path, '.c')}](${pageOf(f.path)}) | ${f.summary} |`);
  page('tbs/places.md', { title: 'Places', description: 'Every place the party can walk around in, and what happens there.' }, `Each scene overlay is one place, or a few that share it. The [Scenes](/tbs/world/scenes) guide explains how a scene runs and how to find an event in it.\n\n| Scene | What happens there |\n| --- | --- |\n${rows.join('\n')}`);
}

function abilities(files: SourceFile[]) {
  const rows: [string, string, string][] = [];
  for (const f of files.filter((f) => f.path.startsWith('games/tbs/src/effect/'))) {
    for (const d of f.decls) {
      const m = d.doc.match(/Abilities: ([^\n]*?)\.?(\n|$)/);
      if (d.kind !== 'function' || !m) continue;
      for (const a of m[1].replace(/\\/g, '').split(/;\s*|,\s*(?![^(]*\))/)) {
        const name = a.replace(/\s*\((?:scene )?kind.*$/, '').trim();
        if (name && name !== 'none') rows.push([name, d.name, `${pageOf(f.path)}#${anchor(d.name)}`]);
      }
    }
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  page('tbs/abilities.md', { title: 'Abilities', description: 'Every ability with an effect of its own, and the function that plays it.' }, `The numbers that make an ability hit are in [How an ability resolves](/tbs/battle/battles#how-an-ability-resolves).\n\n| Ability | Effect |\n| --- | --- |\n${rows.map(([a, fn, url]) => `| ${a} | [${md(fn)}](${url}) |`).join('\n')}`);
}

// ---------------------------------------------------------------------------
// Pictures: a few of the effects' sheets, copied from the tracked PNGs.

const PICTURES = ['games/tbs/src/graphics/battle_fx/rock_wall.png', 'games/tbs/src/graphics/battle_fx/flame_column.png'];

function pictures() {
  const out = join(docs, 'public/pictures');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const p of PICTURES) if (existsSync(join(repo, p))) copyFileSync(join(repo, p), join(out, basename(p)));
}

// ---------------------------------------------------------------------------

const started = Date.now();
for (const p of ['index.md', 'start.md', 'tbs/source', 'tla/source', 'tbs/places.md', 'tbs/abilities.md', 'tbs/matching.md', ...GUIDES.map(([, t]) => `${t}.md`)]) {
  rmSync(join(content, p), { recursive: true, force: true });
}

const all = new Map<Game, SourceFile[]>();
for (const game of GAMES) {
  const files = ROOTS.flatMap((r) => walk(`games/${game}/${r}`)).map((p) => readFile(p, game));
  all.set(game, files);
  // Large folders get a page per file.
  const size = new Map<string, { bytes: number; count: number }>();
  for (const f of files) {
    const s = size.get(dirname(f.path)) ?? { bytes: 0, count: 0 };
    s.bytes += f.size;
    s.count++;
    size.set(dirname(f.path), s);
  }
  for (const [d, s] of size) if (s.bytes > SPLIT_BYTES) split.add(d);
  where.set(game, new Map());
  for (const f of files) for (const d of f.decls) place(game, f, d);
  const u = new Map<string, Set<string>>();
  for (const f of files)
    for (const d of f.decls) {
      if (d.kind !== 'function' && d.kind !== 'variable') continue;
      for (const r of d.refs) {
        if (!where.get(game)!.has(r)) continue;
        if (!u.has(r)) u.set(r, new Set());
        u.get(r)!.add(d.name);
      }
    }
  users.set(game, u);
}

prose('README.md', 'index.md', 'Golden Sun rebuilt byte for byte from readable C.', '', 'Alchemy');
prose('INSTALL.md', 'start.md', 'Build The Broken Seal, check it against the cartridge, and change it.');
guides();
for (const game of GAMES) sourcePages(game, all.get(game)!);
places(all.get('tbs')!);
abilities(all.get('tbs')!);
pictures();
const count = (g: Game) => all.get(g)!.length;
console.log(`content: ${count('tbs')} + ${count('tla')} files read, ${split.size} folders split by file, in ${((Date.now() - started) / 1000).toFixed(1)} s`);
