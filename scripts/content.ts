// Builds the whole of content/docs from an Alchemy checkout, laid out as
// Doxygen lays out its HTML: the guide (Doxygen's main page and related
// pages) from Alchemy's Markdown, arranged by the links between its pages,
// and the reference from the games' C, read with tree-sitter. Everything it
// writes is ignored by git; `bun run content` rebuilds it, and `bun run build`
// runs it first.
//
// The reference has a page for every file: its brief (the first sentence of
// its /// @file comment), its includes, a summary table for each kind of
// member, the whole comment, and an entry for every function, macro, type,
// enum and global it defines, with or without a comment: its declaration,
// its /// comment, its enumerators, what it refers to and what refers to it,
// and its line on GitHub. Every structure and union has a page with its
// fields; every folder a page with its folders and files; and the indexes
// list every name by kind. Names in comments, and code names in the guide,
// link to their entries within the same game, so the two games never cross.
// A handler whose comment names the abilities that reach it shows their
// recordings (abilities/index.tsv in the render store) in its entry.
//
// Every title is Alchemy's: a Markdown page's # heading, a reference page's
// path in its game or a type's name. Every description is a first sentence
// Alchemy wrote: a page's opening sentence, a file's /// @file brief.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, normalize, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Language, type Node, Parser } from 'web-tree-sitter';
import { readFetched, readManifest, renderPath } from '../lib/renders';

const docs = fileURLToPath(new URL('..', import.meta.url));
// The Alchemy checkout it reads: ALCHEMY, or the one beside this repository.
const repo = process.env.ALCHEMY ?? join(docs, '../alchemy');
const content = join(docs, 'content/docs');
const github = 'https://github.com/PascalPixel/alchemy/blob/main';
// The renders the store holds (its manifest, which `bun scripts/renders.ts
// fetch` copies into build/renders): the pictures are not in public/, so a
// picture an index lists is shown only when the store has it.
const stored = readManifest(docs);
// The Broken Seal's maps by symbol, numbered as field/map_headers.s lists them.
const sceneIds = new Map(
  [...readFileSync(join(repo, 'games/tbs/src/field/map_headers.s'), 'utf8').matchAll(/^\tmap_header (\w*),/gm)].map((m, i) => [m[1], i] as const),
);

type Game = 'tbs' | 'tla';
// The games with pages. The Lost Age is still being decompiled: it has one
// page saying so (content/docs/tla/index.mdx) until it is done.
const GAMES: Game[] = ['tbs'];
const ROOTS = ['src', 'include'];
// A folder whose C was larger than this once had a page per file, and a
// smaller one a single page for all its files, whose old anchors still lead
// on to each member (dirPageWrite).
const SPLIT_BYTES = 200_000;
const split = new Set<string>();
const GAME_TITLE: Record<Game, string> = { tbs: 'The Broken Seal', tla: 'The Lost Age' };

const yaml = (s: string) => JSON.stringify(s);

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

// The URL of every page written, for the redirects' check.
const pagesWritten = new Set<string>();
// Every page's text, whether from a Markdown file or the C's comments, says
// its open questions in words (openQuestions) and its games by name
// (gameNames); its title keeps what the source wrote.
function page(path: string, front: Record<string, string>, body: string) {
  if (front.description) front = { ...front, description: gameNames(front.description) };
  body = gameNames(openQuestions(body));
  pagesWritten.add(`/${path.replace(/^\([^/)]*\)\//, '').replace(/\.mdx?$/, '').replace(/(^|\/)index$/, '')}`.replace(/(.)\/$/, '$1'));
  const head = Object.entries(front)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${yaml(v)}`)
    .join('\n');
  write(join(content, path), `---\n${head}\n---\n\n${body.trim()}\n`);
}

// Text from the source, safe in Markdown outside code: the characters MDX
// and Markdown would read as syntax are escaped, code spans kept as written.
// A name the code uses, written bare in a comment: anything with an
// underscore (KALAY_TO_WORLD_MAP, MapId_Kalay, Map_TakeWarp), a global
// and the fields it is read through (gSaveBlock.mapId), a message
// (MsgKalayWelcomeInPeace) or a file name (kalay_interiors.c). Prose shows it
// as code, which linkNames links; codeDeclared catches the other names the
// code declares once every file is read.
const CODE_NAME = /(?<![\w`\\])((?:[a-z][a-z0-9_]*\.(?:c|h|s|S|tsv|po|png|md)|[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*[A-Za-z0-9]|g[A-Z][A-Za-z0-9]*(?:(?:\.|->)[a-z][A-Za-z0-9]*)*|Msg[A-Z][A-Za-z0-9]*)(?:\(\))?)(?![\w`])/g;
function md(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .split(CODE_NAME)
            .map((piece, j) => (j % 2 ? `\`${piece}\`` : piece.replace(/[\\<>{}[\]*_#|~]/g, (c) => `\\${c}`)))
            .join(''),
    )
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
  lines: number; // how many lines of source it spans
  anon?: boolean; // an enum with no tag or typedef name: Doxygen's "anonymous enum"
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
    // Laid out: columns (a run of spaces inside a line), deep indentation or
    // box drawing. Prose indented two spaces continues the list item above it.
    const laidOut = !/^\s*- /.test(para[0]) && para.some((l) => /\S {2,}\S/.test(l.trim()) || /^ {4,}\S/.test(l) || /[│┌└├┐┘┤─]/.test(l));
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

// clang-format reads its switches only as plain comments, so a table's ///
// comment sits above its `// clang-format off`.
const isFormatSwitch = (n: Node | null) => !!n && n.type === 'comment' && /^\/\/ clang-format (off|on)\s*$/.test(n.text);

// The /// lines directly above a node, with no blank line between.
function docAbove(node: Node): string {
  const lines: string[] = [];
  let row = node.startPosition.row;
  for (let c = node.previousNamedSibling; (isDoc(c) || isFormatSwitch(c)) && c!.endPosition.row === row - 1; c = c!.previousNamedSibling) {
    if (/^\/\/\/\s*@file/.test(c!.text)) break;
    if (isDoc(c)) lines.unshift(c!.text);
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

// A header guard: `#define X` with no value inside the file's own `#ifndef X`,
// whatever X is called (ALCHEMY_BATTLE_H, BATTLE_H, GUARD_EVENT_H).
function isGuard(node: Node, name: string): boolean {
  const ifndef = node.parent;
  return (
    node.type === 'preproc_def' &&
    !node.childForFieldName('value') &&
    ifndef?.type === 'preproc_ifdef' &&
    ifndef.parent?.type === 'translation_unit' &&
    ifndef.text.startsWith('#ifndef') &&
    ifndef.childForFieldName('name')?.text === name
  );
}

// The file being read as written, before readFile blanks its attributes.
let written = '';
const asWritten = (n: Node, end = n.endIndex) => written.slice(n.startIndex, end);

function declsOf(parent: Node, out: Decl[]) {
  for (const node of parent.namedChildren) {
    if (!node) continue;
    // tree-sitter can't parse an #ifdef that splits a function's header and
    // wraps what follows in an ERROR node; the declarations inside are whole.
    if (/^preproc_(if|ifdef|else|elif)$/.test(node.type) || node.type === 'ERROR') {
      declsOf(node, out);
      continue;
    }
    const line = node.startPosition.row + 1;
    const refs = new Set<string>();
    const add = (d: Omit<Decl, 'line' | 'refs' | 'fields' | 'lines'> & { fields?: Field[] }) => {
      if (!d.name && !d.anon) return;
      identifiers(node, refs);
      refs.delete(d.name);
      out.push({ fields: [], ...d, line, refs, lines: node.endPosition.row - node.startPosition.row + 1 });
    };
    const doc = [docAbove(node), docAfter(node)].filter(Boolean).join('\n\n');
    if (node.type === 'function_definition') {
      const body = node.childForFieldName('body');
      const signature = oneLine(asWritten(node, body?.startIndex));
      add({ kind: 'function', name: declaredName(node.childForFieldName('declarator')), signature, doc });
    } else if (node.type === 'preproc_def' || node.type === 'preproc_function_def') {
      const name = node.childForFieldName('name')?.text ?? '';
      if (/^ALCHEMY_\w+_H$/.test(name) || isGuard(node, name)) continue;
      // tree-sitter reads a ///< note on the #define's line as part of its value.
      const [first, note] = node.text.split('\n')[0].split(/\s*(?=\/\/\/<)/);
      add({ kind: 'macro', name, signature: first.replace(/\\$/, '').trim(), doc: [docAbove(node), note ? docText([note]) : '', docAfter(node)].filter(Boolean).join('\n\n') });
    } else if (node.type === 'type_definition' || node.type === 'struct_specifier' || node.type === 'union_specifier' || node.type === 'enum_specifier' || node.type === 'declaration') {
      const spec = node.type.endsWith('_specifier') ? node : node.childForFieldName('type');
      const body = spec?.childForFieldName('body') ?? null;
      if (spec && body && /^(struct|union|enum)_specifier$/.test(spec.type)) {
        const kind = spec.type.split('_')[0] as 'struct' | 'union' | 'enum';
        const tag = spec.childForFieldName('name')?.text ?? '';
        const alias = node.type === 'type_definition' ? declaredName(node.childForFieldName('declarator')) : '';
        const name = tag || alias;
        const fields = fieldsOf(body);
        // An enum with no name is still documented, as Doxygen's anonymous
        // enum: its enumerators are names the code uses.
        const members = fields.slice(0, 4).map((f) => f.name);
        if (name || kind === 'enum') add({ kind, name, anon: !name, signature: name ? `${kind} ${name}` : `${kind} { ${members.join(', ')}${fields.length > 4 ? ', …' : ''} }`, doc, fields });
        // A variable declared with its type (`static const struct { … }
        // sTable[] = { … };`): its own entry, holding the fields of a type
        // that has no name.
        const declarator = node.type === 'declaration' ? node.childForFieldName('declarator') : null;
        if (declarator && declaredName(declarator)) {
          const before = oneLine(asWritten(node, body.startIndex));
          const after = oneLine(written.slice(body.endIndex, declarator.endIndex)).replace(/\s*=[\s\S]*$/, '');
          add({ kind: 'variable', name: declaredName(declarator), signature: `${before} { … }${after.startsWith(' ') ? '' : ' '}${after}`.replace(/\s+/g, ' ').trim(), doc, fields: name ? [] : fields });
        }
        continue;
      }
      if (node.type === 'type_definition') {
        add({ kind: 'typedef', name: declaredName(node.childForFieldName('declarator')), signature: oneLine(asWritten(node)), doc });
      } else if (node.type === 'declaration') {
        const d = node.childForFieldName('declarator');
        const isFunction = !!d && (d.type === 'function_declarator' || d.descendantsOfType('function_declarator').length > 0) && !node.text.includes('=');
        const text = oneLine(asWritten(node).replace(/=[\s\S]*$/, '').replace(/;\s*$/, ''));
        add({ kind: isFunction ? 'prototype' : 'variable', name: declaredName(d), signature: text, doc });
      }
    }
  }
}

// tree-sitter loses a function whose body holds an #ifdef that splits a
// statement (`#ifdef BUGFIX` around an `if (...) {` line), and every
// declaration after it in the file. Inside a function body, a conditional
// keeps its first branch: the directives and the other branches are blanked
// in place, so offsets and lines stay as written.
function firstBranches(text: string): string {
  const lines = text.split('\n');
  let depth = 0;
  let comment = false;
  const stack: { body: boolean; blank: boolean }[] = [];
  const blanking = () => stack.some((s) => s.blank);
  const blank = (i: number) => (lines[i] = lines[i].replace(/[^\n]/g, ' '));
  for (let i = 0; i < lines.length; i++) {
    const directive = lines[i].match(/^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b/)?.[1];
    if (directive) {
      if (directive.startsWith('if')) stack.push({ body: depth > 0 || blanking(), blank: false });
      const top = stack[stack.length - 1];
      if (top?.body) {
        if (directive === 'elif' || directive === 'else') top.blank = true;
        blank(i);
      }
      if (directive === 'endif') stack.pop();
      continue;
    }
    if (blanking()) {
      blank(i);
      continue;
    }
    // The braces outside comments, strings and character constants.
    let code = lines[i];
    if (comment) code = code.includes('*/') ? code.slice(code.indexOf('*/') + 2) : '';
    comment = false;
    code = code.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\/\*.*?\*\//g, '');
    if (code.includes('/*')) {
      comment = true;
      code = code.slice(0, code.indexOf('/*'));
    }
    code = code.replace(/\/\/.*$/, '');
    for (const c of code) depth += c === '{' ? 1 : c === '}' ? -1 : 0;
  }
  return lines.join('\n');
}

function readFile(path: string, game: Game): SourceFile {
  const text = readFileSync(join(repo, path), 'utf8');
  // tree-sitter reads `static void UNUSED Name(void)` as a declaration of
  // UNUSED and a function named void, so the attribute is blanked, in place,
  // outside comments and #define lines; signatures are cut from the file as
  // written.
  written = text;
  const tree = parser.parse(firstBranches(text).replace(/^(?!\s*#)([^/\n]*?)\bUNUSED\b/gm, (_, before: string) => before + '      '))!;
  const root = tree.rootNode;
  // The file's summary: its /// @file block, which a header may hold inside
  // its guard.
  let doc = '';
  const top = root.namedChildren.flatMap((c) => (c?.type === 'preproc_ifdef' ? [c, ...c.namedChildren] : [c]));
  for (const c of top) {
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
//
// The site has two parts, as Doxygen's output has: the guide (its main page
// and related pages, from Alchemy's Markdown) and the reference, made from
// the C alone. Every file of a game has its own page in the reference, at its
// path under /<game>/source; every folder has a page listing its folders and
// files; every structure and union has a page of its own under
// /<game>/source/structs; and the indexes list every member by kind and
// name. Every declaration has an entry, with or without a comment, so a name
// in a comment always links to a page of the site.

const rel = (path: string) => path.replace(/^games\/(tbs|tla)\//, '');
const fileSlug = (path: string) => basename(path).replace(/\.([ch])$/, '-$1');
const anchor = (name: string) => name.toLowerCase().replace(/[^a-z0-9_-]/g, '');
// A heading's id as github-slugger, which fumadocs uses, makes it.
const headingSlug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replace(/ /g, '-');
// A name as words joined by hyphens, for a URL: BattleWork is battle-work.
const kebab = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();

// The guide's pages are written under a folder group, which fumadocs leaves
// out of their URLs, so the guide is one sidebar tab and the reference
// another while every page keeps its address.
const GUIDE = '(guide)';

const gameOf = (path: string) => path.split('/')[1] as Game;
const reference = (game: Game) => `/${game}/source`;
const dirPage = (dir: string) => `${reference(gameOf(dir))}/${rel(dir)}`;
const pageOf = (path: string) => `${dirPage(dirname(path))}/${fileSlug(path)}`;

// The headings of a file or structure page, whose ids no member may take.
const SECTIONS = {
  struct: ['Data Structures', ''],
  union: ['Data Structures', ''],
  macro: ['Macros', 'Macro Definition Documentation'],
  typedef: ['Typedefs', 'Typedef Documentation'],
  enum: ['Enumerations', 'Enumeration Type Documentation'],
  function: ['Functions', 'Function Documentation'],
  prototype: ['Functions', 'Function Documentation'],
  variable: ['Variables', 'Variable Documentation'],
} as const satisfies Record<Decl['kind'], readonly [string, string]>;
const RESERVED = new Set([...Object.values(SECTIONS).flat(), 'Detailed Description', 'Data Fields', 'Field Documentation', 'Includes'].filter(Boolean).map(headingSlug));

// A declaration's place within its file: one entry for every name of a kind,
// gathering a name declared again under an edition's #if or as a prototype
// beside its definition.
const memberKey = (d: Decl) => `${SECTIONS[d.kind][0]}\t${d.anon ? `@${d.line}` : d.name}`;
const ids = new Map<SourceFile, Map<string, string>>();
function idsOf(file: SourceFile): Map<string, string> {
  let out = ids.get(file);
  if (out) return out;
  out = new Map();
  const used = new Set(RESERVED);
  for (const d of file.decls) {
    const key = memberKey(d);
    if (out.has(key) || d.kind === 'struct' || d.kind === 'union') continue;
    const base = d.anon ? `enum-${d.line}` : anchor(d.name) || `line-${d.line}`;
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    out.set(key, id);
  }
  ids.set(file, out);
  return out;
}

// Every structure and union's page, by its declaration.
const structPages = new Map<Decl, string>();
function placeStructs(game: Game, files: SourceFile[]) {
  // Each name's first declaration takes its name; another type of the same
  // name (a map's own struct Object) takes its file's as well.
  // The letters' folders (structs/a) are taken.
  const used = new Set<string>([...'abcdefghijklmnopqrstuvwxyz', 'other']);
  const slugs = new Map<Decl, string>();
  const all = files.flatMap((f) => f.decls.filter((d) => (d.kind === 'struct' || d.kind === 'union') && d.name).map((d) => ({ f, d, base: kebab(d.name) || `line-${d.line}` })));
  for (const { d, base } of all)
    if (!used.has(base)) {
      used.add(base);
      slugs.set(d, base);
    }
  for (const { f, d, base } of all) {
    if (slugs.has(d)) continue;
    const own = `${base}-${kebab(basename(f.path).replace(/\.\w+$/, ''))}`;
    let slug = own;
    for (let n = 2; used.has(slug); n++) slug = `${own}-${n}`;
    used.add(slug);
    slugs.set(d, slug);
  }
  for (const [d, slug] of slugs) structPages.set(d, `${reference(game)}/structs/${slug}`);
}

function urlOf(file: SourceFile, d: Decl): string {
  return structPages.get(d) ?? `${pageOf(file.path)}#${idsOf(file).get(memberKey(d))}`;
}

// A declaration that defines what it names: everything but a prototype and
// an extern variable, which declare what another file defines.
const isDefinition = (d: Decl) => d.kind !== 'prototype' && !(d.kind === 'variable' && /\bextern\b/.test(d.signature));

// Every name's entry, per game: its definition with a comment, else any
// definition, else its first declaration. Links to a name go there.
type Placement = { url: string; decl: Decl; file: SourceFile };
const where = new Map<Game, Map<string, Placement>>();
function place(game: Game, file: SourceFile, d: Decl) {
  if (d.anon) return;
  const index = where.get(game)!;
  const known = index.get(d.name);
  const rank = (x: Decl) => (x.doc ? 2 : 0) + (isDefinition(x) ? 1 : 0);
  if (!known || rank(d) > rank(known.decl)) index.set(d.name, { url: urlOf(file, d), decl: d, file });
}
// Every enumerator, at its enum's entry.
const enumerators = new Map<Game, Map<string, Placement>>();
function placeEnumerators(game: Game, file: SourceFile, d: Decl) {
  if (d.kind !== 'enum') return;
  const index = enumerators.get(game)!;
  for (const f of d.fields) if (!index.has(f.name)) index.set(f.name, { url: urlOf(file, d), decl: d, file });
}
const lookup = (game: Game, name: string) => where.get(game)!.get(name) ?? enumerators.get(game)!.get(name);

// The names a game declares that md() could not know while the files were
// read, written bare in a comment, shown as code once the index has them: a
// CamelCase name with no underscore (ObjectVectorView, a function or a type), an
// upper-case macro with none (UNUSED), and a map by the name
// field/map_headers.s gives it (KalayTunnelTreasureRoom).
function codeDeclared(text: string, game: Game): string {
  const index = where.get(game)!;
  const known = (name: string) => name.length > 3 && (index.has(name) || (sceneIds.has(name) && index.has(`MapId_${name}`))) && ((/[a-z0-9][A-Z]/.test(name) && /[a-z]/.test(name)) || /^[A-Z][A-Z0-9]+$/.test(name));
  return text
    .split(/(```[\s\S]*?```|`[^`]*`|\]\([^)]*\))/)
    .map((part, i) => (i % 2 ? part : part.replace(/(?<![\w`\\.])([A-Za-z][A-Za-z0-9]*)((?:(?:\.|-\\?>)[a-z][A-Za-z0-9]*)*)(\(\))?(?![\w`])/g, (all, name: string, chain: string, call = '') => (known(name) ? `\`${name}${chain.replace(/\\/g, '')}${call}\`` : all))))
    .join('');
}

// Alchemy's Markdown with the code names it writes bare shown as code, as
// md() and codeDeclared show a comment's: outside code, link targets,
// pictures, HTML and headings, a name with an underscore, a file name or a
// name the game declares.
function codeProse(text: string, game: Game): string {
  return text
    .split(/(```[\s\S]*?```|`[^`]*`|!\[[^\]]*\]\([^)]*\)|\]\([^)]*\)|<[^>\n]*>|^#[^\n]*$)/m)
    .map((part, i) =>
      i % 2
        ? part
        : codeDeclared(
            part.replace(/(?<![\w`\\/.-])((?:[a-z][a-z0-9_]*\.(?:c|h|s|S|tsv|po|png|md)|[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*[A-Za-z0-9])(?:\(\))?)(?![\w`/])/g, '`$1`'),
            game,
          ),
    )
    .join('');
}

// The entry a code span names: `Name`, `Name()`, `gName.field`, a
// structure's field on its structure's page (`BattleWork.enemyIds`), and a
// file by a name or path that only one file ends with (`encounter.c`,
// `game/units.c`), as Doxygen links a file's name.
const filesOf = new Map<Game, SourceFile[]>();
function codeTarget(span: string, game: Game, self: string): { url: string } | undefined {
  const file = span.match(/^`([\w./-]+\.[ch])`$/)?.[1];
  if (file) {
    const hits = (filesOf.get(game) ?? []).filter((f) => f.path.endsWith(`/${file}`));
    return hits.length === 1 && file !== self ? { url: pageOf(hits[0].path) } : undefined;
  }
  const m = span.match(/^`(\w+)(?:(?:\.|->)(\w+))?(?:(?:\.|->)\w+)*(?:\(\))?`$/);
  if (!m || m[1] === self) return undefined;
  const hit = lookup(game, m[1]) ?? (sceneIds.has(m[1]) ? where.get(game)!.get(`MapId_${m[1]}`) : undefined);
  if (hit && m[2] && structPages.get(hit.decl) === hit.url && hit.decl.fields.some((f) => f.name.split(', ')[0] === m[2])) return { ...hit, url: `${hit.url}#${anchor(m[2])}` };
  return hit;
}

// Names in comments that a game declares become links to them.
function linkNames(text: string, game: Game, self: string): string {
  return text
    .split(/(```[\s\S]*?```|`[^`]*`|\]\([^)]*\))/)
    .map((part, i) => {
      if (i % 2) {
        const hit = codeTarget(part, game, self);
        return hit ? `[${part}](${hit.url})` : part;
      }
      return part.replace(/\b([A-Za-z_][A-Za-z0-9_]*)(\\_[A-Za-z0-9_\\]+)*\b/g, (word) => {
        const name = word.replace(/\\_/g, '_');
        const hit = name !== self && name.length > 3 && /[A-Z_]/.test(name.slice(1)) ? lookup(game, name) : undefined;
        return hit ? `[${word}](${hit.url})` : word;
      });
    })
    .join('');
}

// The code names in a guide page become links into the reference, as
// Doxygen links the names in its related pages: a code span by itself, not
// one inside a link's text or a heading.
function linkProse(text: string, game: Game): string {
  return text
    .split(/(```[\s\S]*?```|!?\[(?:[^\]`]|`[^`]*`)*\]\([^)]*\)|^#[^\n]*$|`[^`\n]*`)/m)
    .map((part, i) => {
      if (!(i % 2) || !part.startsWith('`')) return part;
      const hit = codeTarget(part, game, '');
      return hit ? `[${part}](${hit.url})` : part;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// The reference.

// Who refers to each name: functions that call it, tables that list it.
const users = new Map<Game, Map<string, Set<string>>>();
// The files each file includes, and is included by.
const includes = new Map<SourceFile, { file?: SourceFile; as: string }[]>();
const includedBy = new Map<SourceFile, SourceFile[]>();

// ---------------------------------------------------------------------------
// The recordings beside the code that plays them. A handler's comment names
// every ability that reaches it in its reach line (`Abilities: Gaia, Mother
// Gaia (BATTLE_ANIM_GAIA); none (BATTLE_ANIM_X).`, the form battle_anim/README.md
// sets), and the store's abilities/index.tsv holds the casts recorded from the
// game by ability id. A name is matched against abilities.tsv's ability column
// and, where several rows share it, to the rows whose effect word in
// ability_anims.tsv dispatches to the group's effect: kind in bits 0 to 11, bit 15
// for a summon's scene, bit 14 for the effects dispatched by id range, the
// casting impacts among them at kind 100 and up. A field Psynergy group is
// matched by abilities.tsv's type column. A recording made in a field scene (its
// index row names the scene) shows beside the field handler, and one made in
// battle beside the battle effect's handler.

const recordings = (() => {
  let rows: Row[] = [];
  return {
    get: () => rows,
    load: () => {
      const [head, ...lines] = readFetched(docs, 'abilities/index.tsv').trim().split('\n');
      const keys = head.split('\t');
      rows = lines.map((l) => Object.fromEntries(l.split('\t').map((v, i) => [keys[i], v]))).filter((r) => r.file && stored.has(`abilities/${r.file}`));
    },
  };
})();
const placedRecordings = new Map<number, string[]>(); // ability id: the declarations showing it
const handlerOf = new Map<number, string>(); // ability id: the first handler its reach line names
const reachProblems: string[] = [];

// The enum each reach-line prefix names, and whether an ability row reaches
// one of its values.
const REACH: [string, string, (value: number, act: Row, word: number) => boolean][] = [
  ['BATTLE_ANIM_', 'BattleAnimId', (v, _, w) => !(w & 0xc000) && (w & 0xfff) === v],
  ['SUMMON_ANIM_', 'SummonAnimId', (v, _, w) => !!(w & 0x8000) && (w & 0xfff) === v],
  ['CASTING_IMPACT_', 'CastingImpact', (v, _, w) => (w & 0xc000) === 0x4000 && (w & 0xfff) === v + 100],
  ['FIELD_PSYNERGY_', 'FieldPsynergy', (v, act) => int(act.type) === v],
];

let abilityRows: { acts: Row[]; words: number[] } | undefined;
function reachedIds(d: Decl, at: string): { ids: number[]; field: number[] } {
  // The comment as md() left it: the effect names shown as code, the
  // characters Markdown reads escaped. The line is read as written.
  const para = d.doc
    .split(/\n\n/)
    .map((p) => p.replace(/`/g, '').replace(/\\([\\<>{}[\]*_#|~])/g, '$1').replace(/\s*\n\s*/g, ' '))
    .find((p) => p.startsWith('Abilities: '));
  if (!para) return { ids: [], field: [] };
  abilityRows ??= { acts: tsv('games/tbs/src/game/abilities.tsv'), words: tsv('games/tbs/src/battle/ability_anims.tsv').map((r) => int(r.effect)) };
  const { acts, words } = abilityRows;
  const ids: number[] = [];
  const field: number[] = [];
  const body = para.replace(/^Abilities: /, '').replace(/\.$/, '');
  if (para.slice(para.lastIndexOf(')') + 1) !== '.') reachProblems.push(`${at}: the reach line does not end in “).”: ${para}`);
  for (const group of body.split('; ')) {
    const m = group.match(/^(.+) \(([A-Z][A-Z0-9_]*)\)$/);
    if (!m) {
      reachProblems.push(`${at}: a group that is not “names (EFFECT)”: ${group}`);
      continue;
    }
    const [, names, effect] = m;
    const kind = REACH.find(([prefix]) => effect.startsWith(prefix));
    const value = kind && enumOf(kind[1]).find((e) => e.name === effect)?.value;
    if (!kind || value === undefined) {
      reachProblems.push(`${at}: ${effect} is no member of a reach-line enum`);
      continue;
    }
    if (names === 'none') continue;
    for (const name of names.split(', ')) {
      const rows = acts.flatMap((a, id) => (a.ability === name ? [id] : []));
      const hit = rows.filter((id) => kind[2](value, acts[id], words[id] ?? 0));
      if (!rows.length) reachProblems.push(`${at}: “${name}” is no ability in abilities.tsv (${effect})`);
      else if (!hit.length) reachProblems.push(`${at}: no row of “${name}” (${rows.join(', ')}) reaches ${effect}`);
      (kind[0] === 'FIELD_PSYNERGY_' ? field : ids).push(...hit);
    }
  }
  return { ids, field };
}

// The recordings a declaration's reach line names, in its order, each
// captioned by the ability's name.
function recordingsOf(file: SourceFile, d: Decl): string {
  if (where.get(file.game)!.get(d.name)?.decl !== d) return '';
  const { ids, field } = reachedIds(d, `${file.path}:${d.line} ${d.name}`);
  for (const id of [...ids, ...field]) if (!handlerOf.has(id)) handlerOf.set(id, urlOf(file, d));
  const shown: string[] = [];
  const cast = (id: number, inField: boolean) => recordings.get().find((x) => int(x.ability) === id && !!x.scene === inField);
  for (const [id, inField] of [...ids.map((i) => [i, false] as const), ...field.map((i) => [i, true] as const)]) {
    const r = cast(id, inField);
    if (!r) continue;
    placedRecordings.set(id, [...(placedRecordings.get(id) ?? []), urlOf(file, d)]);
    shown.push(`![${md(r.name)}](/abilities/${r.file})\\\n${md(r.name)}`);
  }
  return shown.join('\n\n');
}

// A comment's brief, as Doxygen takes it: the first sentence of its first
// paragraph, unless that paragraph is laid out as code.
function brief(doc: string): string {
  const para = doc.split(/\n\n/)[0] ?? '';
  if (!para || para.startsWith('```')) return '';
  return para
    .replace(/\s*\n\s*/g, ' ')
    .split(/(?<=(?<!\b(?:Mt|Mr|Mrs|Ms|Dr|St|e\.g|i\.e|vs))[.!?])\s+(?=[^a-z])/)[0]
    .trim();
}
// Text inside a table's cell, which a pipe would end.
const cell = (s: string) => s.replace(/\n+/g, ' ').replace(/(?<!\\)\|/g, '\\|');
const code = (s: string) => (s.trim() ? `\`${s.trim().replace(/`/g, "'")}\`` : '');
const heading = (level: string, title: string, id: string) => `${level} ${title} [#${id.replace(/_/g, '\\_')}]`;
const listOf = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const github_line = (file: SourceFile, line: number) => `${github}/${file.path}#L${line}`;

// A declaration's signature split around its name, for a summary row.
function aroundName(signature: string, name: string): [string, string] {
  const at = name ? signature.search(new RegExp(`\\b${name}\\b`)) : -1;
  return at < 0 ? [signature, ''] : [signature.slice(0, at), signature.slice(at + name.length)];
}

// The longest a summary row shows of a macro's value or an enum's members;
// the member's entry shows all of it.
const ROW_TAIL = 60;
const clip = (s: string) => (s.length > ROW_TAIL ? `${s.slice(0, ROW_TAIL).trimEnd()} …` : s);

// A summary row: the declaration, its name linked to its entry, and its brief.
function summaryRow(file: SourceFile, d: Decl, url: string, doc: string): string {
  const name = d.anon ? '' : d.name;
  let [before, after] = aroundName(d.signature, name);
  if (d.kind === 'enum') {
    const names = d.fields.map((f) => f.name);
    before = 'enum';
    after = names.length ? `{ ${clip(names.join(', '))} }` : '';
  }
  if (d.kind === 'macro') after = clip(after);
  const label = d.anon ? `[anonymous enum](${url})` : `[${code(d.name)}](${url})`;
  return `| ${cell(code(before))} | ${cell(`${label}${after.trim() ? ` ${code(after)}` : ''}`)} | ${cell(linkNames(brief(doc), file.game, name))} |`;
}

// "References" and "Referenced by", as Doxygen lists them under a member:
// the functions and globals it uses, and the functions and tables that use
// it. A long list stops at REF_LIMIT.
const REF_LIMIT = 50;
function refList(names: string[], game: Game): string {
  const linked = names
    .sort((a, b) => a.localeCompare(b, 'en'))
    .slice(0, REF_LIMIT)
    .map((n) => {
      const hit = lookup(game, n);
      const label = code(hit && (hit.decl.kind === 'function' || hit.decl.kind === 'prototype') ? `${n}()` : n);
      return hit ? `[${label}](${hit.url})` : label;
    });
  if (names.length > REF_LIMIT) linked.push(`${names.length - REF_LIMIT} more`);
  return `${listOf(linked)}.`;
}
function relations(file: SourceFile, decls: Decl[], self: string): string[] {
  const out: string[] = [];
  const game = file.game;
  if (decls.some((d) => d.kind === 'function' || (d.kind === 'variable' && isDefinition(d)))) {
    const used = new Set<string>();
    for (const d of decls)
      for (const r of d.refs) {
        const hit = r !== self && where.get(game)!.get(r);
        if (hit && /^(function|prototype|variable)$/.test(hit.decl.kind)) used.add(r);
      }
    if (used.size) out.push(`References ${refList([...used], game)}`);
  }
  const by = self && users.get(game)!.get(self);
  if (by && by.size) out.push(`Referenced by ${refList([...by], game)}`);
  return out;
}

const definedAt = (file: SourceFile, decls: Decl[]) => {
  const lines = [...new Set(decls.map((d) => d.line))].map((l) => `[${l}](${github_line(file, l)})`);
  return `Definition at line${lines.length > 1 ? 's' : ''} ${listOf(lines)} of file ${code(basename(file.path))}.`;
};

// A table of an enum's enumerators or a type's fields.
function memberTable(file: SourceFile, d: Decl, self: string): string {
  if (!d.fields.length) return '';
  if (d.kind === 'enum') {
    const rows = d.fields.map((f) => `| ${code(f.name)} | ${cell(code(f.type))} | ${cell(linkNames(f.doc, file.game, self))} |`);
    return `| Enumerator | Value | Description |\n| --- | --- | --- |\n${rows.join('\n')}`;
  }
  const rows = d.fields.map((f) => `| ${cell(code(f.type))} | ${cell(linkNames(f.doc, file.game, self))} |`);
  return `| Field | Description |\n| --- | --- |\n${rows.join('\n')}`;
}

// A member's entry, as Doxygen documents one: its declarations as written,
// its comment, its recordings, its enumerators or fields, what it refers to
// and what refers to it, and its line on GitHub.
function memberEntry(file: SourceFile, decls: Decl[], id: string): string {
  const d = decls[0];
  const self = d.anon ? '' : d.name;
  const parts = [heading('###', d.anon ? 'anonymous enum' : md(d.name), id)];
  for (const s of [...new Set(decls.map((x) => (d.kind === 'enum' && !d.anon ? `enum ${d.name}` : x.signature)))]) parts.push(code(s));
  for (const doc of [...new Set(decls.map((x) => x.doc).filter(Boolean))]) parts.push(linkNames(doc, file.game, self));
  for (const x of decls) {
    const cast = x.kind === 'function' ? recordingsOf(file, x) : '';
    if (cast) parts.push(cast);
  }
  const table = memberTable(file, decls.find((x) => x.fields.length) ?? d, self);
  if (table) parts.push(table);
  parts.push(...relations(file, decls, self));
  parts.push(definedAt(file, decls));
  return parts.join('\n\n');
}

// A file's members, by the summary section and name each takes.
function membersOf(file: SourceFile): Map<string, Decl[]> {
  const out = new Map<string, Decl[]>();
  for (const d of file.decls) {
    const key = memberKey(d);
    out.set(key, [...(out.get(key) ?? []), d]);
  }
  return out;
}

// Whether a file's page holds a member's entry: when the file defines it, or
// is the only place that declares it.
function hasEntry(file: SourceFile, decls: Decl[]): boolean {
  const d = decls[0];
  if (d.kind === 'struct' || d.kind === 'union') return false;
  return d.anon || decls.some(isDefinition) || where.get(file.game)!.get(d.name)?.file === file;
}

// Where a member's row links: its entry on this page, its structure's page,
// or the entry of the file that defines it.
function rowTarget(file: SourceFile, decls: Decl[]): { url: string; doc: string } {
  const d = decls[0];
  const own = decls.find((x) => x.doc)?.doc ?? '';
  if (structPages.has(d)) return { url: structPages.get(d)!, doc: d.doc };
  if (hasEntry(file, decls)) return { url: `#${idsOf(file).get(memberKey(d))}`, doc: own || (where.get(file.game)!.get(d.name)?.decl.doc ?? '') };
  const there = where.get(file.game)!.get(d.name)!;
  return { url: there.url, doc: own || there.decl.doc };
}

const SUMMARY_ORDER = ['Data Structures', 'Macros', 'Typedefs', 'Enumerations', 'Functions', 'Variables'];
const ENTRY_ORDER: Decl['kind'][] = ['macro', 'typedef', 'enum', 'function', 'variable'];

// A file's page, laid out as Doxygen lays out a file: its brief, what it
// includes and what includes it, a summary table for each kind of member,
// the file's whole comment, and an entry for every member it defines.
function filePage(file: SourceFile) {
  const parts: string[] = [];
  const game = file.game;
  if (file.summary) parts.push(`${linkNames(file.summary, game, '')}${file.doc.length > file.summary.length + 2 ? ' [More…](#detailed-description)' : ''}`);
  const inc = includes.get(file) ?? [];
  if (inc.length) parts.push(inc.map((x) => `- ${x.file ? `[${code(`#include "${x.as}"`)}](${pageOf(x.file.path)})` : code(`#include "${x.as}"`)}`).join('\n'));
  const by = includedBy.get(file) ?? [];
  if (by.length) parts.push(`Included by ${refFiles(by)}.`);
  const members = [...membersOf(file).values()];
  for (const title of SUMMARY_ORDER) {
    const rows = members.filter((m) => SECTIONS[m[0].kind][0] === title).map((m) => {
      const t = rowTarget(file, m);
      return summaryRow(file, m[0], t.url, t.doc);
    });
    if (!rows.length) continue;
    parts.push(heading('##', title, headingSlug(title)), `| | Name | Description |\n| --- | --- | --- |\n${rows.join('\n')}`);
  }
  if (file.doc) parts.push(heading('##', 'Detailed Description', 'detailed-description'), linkNames(file.doc, game, ''));
  for (const kind of ENTRY_ORDER) {
    const title = SECTIONS[kind][1];
    const entries = members.filter((m) => SECTIONS[m[0].kind][1] === title && hasEntry(file, m));
    if (!entries.length) continue;
    parts.push(heading('##', title, headingSlug(title)));
    for (const m of entries) parts.push(memberEntry(file, m, idsOf(file).get(memberKey(m[0]))!));
  }
  page(`${pageOf(file.path).slice(1)}.md`, { title: rel(file.path), description: plainText(file.summary), source: file.path }, parts.join('\n\n'));
}

const refFiles = (files: SourceFile[]) => listOf([...files.slice(0, REF_LIMIT).map((f) => `[${code(basename(f.path))}](${pageOf(f.path)})`), ...(files.length > REF_LIMIT ? [`${files.length - REF_LIMIT} more`] : [])]);
// A summary as a page's description: the Markdown gone.
const plainText = (s: string) => s.replace(/\\(.)/g, '$1').replace(/`/g, '');

// A structure's or union's page, as Doxygen's: its brief, the file that
// declares it, a summary of its fields, its whole comment, and an entry for
// every field.
function structPage(file: SourceFile, d: Decl) {
  const url = structPages.get(d)!;
  const game = file.game;
  const parts: string[] = [];
  const b = brief(d.doc);
  if (b) parts.push(`${linkNames(b, game, d.name)}${d.doc.length > b.length + 2 ? ' [More…](#detailed-description)' : ''}`);
  parts.push(`Declared in [${code(basename(file.path))}](${pageOf(file.path)}).`);
  const used = new Set(RESERVED);
  const fieldIds = d.fields.map((f) => {
    const base = anchor(f.name.split(', ')[0]) || 'field';
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  });
  if (d.fields.length) {
    const rows = d.fields.map((f, i) => {
      const [before, after] = aroundName(f.type, f.name.split(', ')[0]);
      return `| ${cell(code(before))} | ${cell(`[${code(f.name)}](#${fieldIds[i]})${after.trim() ? ` ${code(after)}` : ''}`)} | ${cell(linkNames(brief(f.doc), game, d.name))} |`;
    });
    parts.push(heading('##', 'Data Fields', 'data-fields'), `| | Name | Description |\n| --- | --- | --- |\n${rows.join('\n')}`);
  }
  parts.push(heading('##', 'Detailed Description', 'detailed-description'));
  if (d.doc) parts.push(linkNames(d.doc, game, d.name));
  parts.push(code(d.signature), ...relations(file, [d], d.name), definedAt(file, [d]));
  if (d.fields.length) {
    parts.push(heading('##', 'Field Documentation', 'field-documentation'));
    d.fields.forEach((f, i) => parts.push([heading('###', md(f.name), fieldIds[i]), code(f.type), linkNames(f.doc, game, d.name)].filter(Boolean).join('\n\n')));
  }
  page(`${url.slice(1)}.md`, { title: `${d.kind} ${d.name}`, description: plainText(b), source: file.path }, parts.join('\n\n'));
}

// A folder's page: the guide that explains it, its folders and its files,
// each with its brief. A folder that once showed its files' members on its
// own page sends a link to one of them (#battle_runencounter) on to its new
// place.
function dirPageWrite(dir: string, dirs: string[], files: SourceFile[], guide: Placed | undefined, oldAnchors: Record<string, string>) {
  const parts: string[] = [];
  if (guide) parts.push(`Guide: [${headingOf(guide.key) ?? basename(dirname(guide.key))}](${guide.url})`);
  if (dirs.length) parts.push(heading('##', 'Directories', 'directories'), dirs.map((d) => `- [${code(`${basename(d)}/`)}](${dirPage(d)})`).join('\n'));
  if (files.length) parts.push(heading('##', 'Files', 'files'), `| File | Description |\n| --- | --- |\n${files.map((f) => `| [${code(basename(f.path))}](${pageOf(f.path)}) | ${cell(linkNames(f.summary, f.game, ''))} |`).join('\n')}`);
  if (Object.keys(oldAnchors).length) parts.push(`<AnchorRedirect map={${JSON.stringify(oldAnchors)}} />`);
  page(`${dirPage(dir).slice(1)}/index.mdx`, { title: rel(dir), description: '', source: dir }, parts.join('\n\n'));
}

// The indexes, as Doxygen's: Data Structures, Data Fields and File Members
// (all, functions, variables, typedefs, enumerations, enumerators, macros),
// each name with the pages it has an entry on. An index longer than
// INDEX_SPLIT names has a page for each first letter.
const INDEX_SPLIT = 600;
type IndexEntry = { key: string; name: string; links: string[]; brief?: string };
const letterOf = (name: string) => (/^[a-z]/i.test(name) ? name[0].toUpperCase() : '_');
const letterSlug = (letter: string) => (letter === '_' ? 'other' : letter.toLowerCase());
const letterTitle = (letter: string) => (letter === '_' ? 'Other' : letter);

function indexLines(entries: IndexEntry[]): string {
  return entries.map((e) => `- ${e.name}${e.brief !== undefined ? (e.brief ? `: ${e.brief}` : '') : ` : ${e.links.join(', ')}`}`).join('\n');
}

// Writes one index at url: one page, with a section for each letter, or a
// folder with a page for each letter. Returns the sidebar entry for it.
function indexPages(url: string, title: string, what: string, entries: IndexEntry[], lead = '') {
  entries.sort((a, b) => a.key.localeCompare(b.key, 'en', { sensitivity: 'base' }) || (a.key < b.key ? -1 : 1));
  const plain = (e: IndexEntry) => e.key;
  const letters = new Map<string, IndexEntry[]>();
  for (const e of entries) letters.set(letterOf(plain(e)), [...(letters.get(letterOf(plain(e))) ?? []), e]);
  // Names that open with a letter first, then the rest, as Doxygen orders them.
  const other = letters.get('_');
  if (other) {
    letters.delete('_');
    letters.set('_', other);
  }
  const description = `${what}.`;
  if (entries.length <= INDEX_SPLIT) {
    const body = [...letters].map(([l, es]) => `${heading('##', letterTitle(l), letterSlug(l))}\n\n${indexLines(es)}`);
    page(`${url.slice(1)}.md`, { title, description }, [lead, ...body].filter(Boolean).join('\n\n'));
    return;
  }
  const links = [...letters.keys()].map((l) => `[${letterTitle(l)}](${url}/${letterSlug(l)})`);
  page(`${url.slice(1)}/index.md`, { title, description }, [lead, `${entries.length} names, by their first letter: ${links.join(' · ')}.`].filter(Boolean).join('\n\n'));
  for (const [l, es] of letters) page(`${url.slice(1)}/${letterSlug(l)}.md`, { title: `${title}: ${letterTitle(l)}`, description: `${what}, from ${letterTitle(l)}.` }, `${links.join(' · ')}\n\n${indexLines(es)}`);
  write(join(content, url.slice(1), 'meta.json'), JSON.stringify({ title, pages: [...letters.keys()].map((l) => `[${letterTitle(l)}](${url}/${letterSlug(l)})`) }, null, 2) + '\n');
}

function referencePages(game: Game, files: SourceFile[], guides: Map<string, Placed>) {
  const root = reference(game);
  const byDir = new Map<string, SourceFile[]>();
  for (const f of files) byDir.set(dirname(f.path), [...(byDir.get(dirname(f.path)) ?? []), f]);
  // Every folder up to the game's src and include, so each has a page.
  for (const d of [...byDir.keys()]) for (let p = dirname(d); p.split('/').length > 2; p = dirname(p)) if (!byDir.has(p)) byDir.set(p, []);
  const subdirsOf = (dir: string) => [...byDir.keys()].filter((d) => dirname(d) === dir).sort();
  const meta = (url: string, data: object) => write(join(content, url.slice(1), 'meta.json'), JSON.stringify(data, null, 2) + '\n');

  // The folders and files. A folder's guide is the folder README of its top
  // folder (src/battle and include/unit/battle are Battles').
  for (const [dir, list] of byDir) {
    list.sort((a, b) => (a.path < b.path ? -1 : 1));
    const top = rel(dir).match(/^(?:src|include(?:\/unit)?)\/([^/]+)/)?.[1];
    const guide = top ? guides.get(`games/${game}/src/${top}/README.md`) : undefined;
    // The anchors of a folder that showed its files' members on its own page,
    // before every file had a page.
    const old: Record<string, string> = {};
    if (!split.has(dir))
      for (const f of list) {
        old[anchor(basename(f.path))] ??= pageOf(f.path);
        for (const d of f.decls) if (!d.anon) old[anchor(d.name)] ??= urlOf(f, d);
      }
    const subdirs = subdirsOf(dir);
    dirPageWrite(dir, subdirs, list, guide, old);
    for (const f of list) filePage(f);
    meta(dirPage(dir), { title: basename(dir), pages: [...subdirs.map((d) => basename(d)), ...list.map((f) => `[${basename(f.path)}](${pageOf(f.path)})`)] });
  }

  // Structures and unions: an index of them all, and in the sidebar a folder
  // for each first letter, whose page lists that letter's, so a structure's
  // page is sent the few beside it rather than all of them.
  const structs: { file: SourceFile; d: Decl }[] = [];
  for (const f of files) for (const d of f.decls) if (structPages.has(d)) structs.push({ file: f, d });
  for (const { file, d } of structs) structPage(file, d);
  structs.sort((a, b) => a.d.name.localeCompare(b.d.name, 'en', { sensitivity: 'base' }));
  const structEntry = ({ d }: { d: Decl }) => ({ key: d.name, name: `[${code(d.name)}](${structPages.get(d)})`, links: [], brief: linkNames(brief(d.doc), game, d.name) });
  indexPages(`${root}/structs`, 'Data Structures', `Every structure and union of ${GAME_TITLE[game]}, with its brief`, structs.map(structEntry));
  const byLetter = new Map<string, typeof structs>();
  for (const s of structs) byLetter.set(letterOf(s.d.name), [...(byLetter.get(letterOf(s.d.name)) ?? []), s]);
  const letters = [...byLetter.keys()].sort((a, b) => (a === '_' ? 1 : b === '_' ? -1 : a < b ? -1 : 1));
  for (const l of letters) {
    const url = `${root}/structs/${letterSlug(l)}`;
    page(`${url.slice(1)}/index.md`, { title: `Data Structures: ${letterTitle(l)}`, description: `The structures and unions of ${GAME_TITLE[game]} from ${letterTitle(l)}, with their briefs.` }, indexLines(byLetter.get(l)!.map(structEntry)));
    meta(url, { title: letterTitle(l), pages: byLetter.get(l)!.map(({ d }) => `[${d.name}](${structPages.get(d)})`) });
  }
  meta(`${root}/structs`, { title: 'Data Structures', pages: letters.map(letterSlug) });

  // Data Fields: every field name, with the structures that have it.
  const fields = new Map<string, string[]>();
  for (const { d } of structs) {
    const used = new Set(RESERVED);
    for (const f of d.fields) {
      const base = anchor(f.name.split(', ')[0]) || 'field';
      let id = base;
      for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
      used.add(id);
      for (const n of f.name.split(', ')) fields.set(n, [...(fields.get(n) ?? []), `[${code(d.name)}](${structPages.get(d)}#${id})`]);
    }
  }
  indexPages(
    `${root}/fields`,
    'Data Fields',
    `Every field of ${GAME_TITLE[game]}'s structures and unions, with the types that have it`,
    [...fields].map(([n, links]) => ({ key: n, name: code(n), links })),
  );

  // File Members, by kind: each name with the files it has an entry in.
  type Kind = 'all' | 'functions' | 'variables' | 'typedefs' | 'enums' | 'enumerators' | 'macros';
  const members = new Map<Kind, Map<string, string[]>>();
  const add = (kind: Kind, name: string, link: string) => {
    for (const k of [kind, 'all'] as Kind[]) {
      const m = members.get(k) ?? new Map<string, string[]>();
      m.set(name, [...(m.get(name) ?? []), link]);
      members.set(k, m);
    }
  };
  const KIND_OF: Partial<Record<Decl['kind'], Kind>> = { function: 'functions', prototype: 'functions', variable: 'variables', typedef: 'typedefs', enum: 'enums', macro: 'macros' };
  for (const f of files)
    for (const decls of membersOf(f).values()) {
      const d = decls[0];
      if (!hasEntry(f, decls)) continue;
      const link = `[${code(basename(f.path))}](${urlOf(f, d)})`;
      if (!d.anon && KIND_OF[d.kind]) add(KIND_OF[d.kind]!, code(d.kind === 'function' || d.kind === 'prototype' ? `${d.name}()` : d.name), link);
      if (d.kind === 'enum') for (const x of d.fields) add('enumerators', code(x.name), link);
    }
  const KINDS: [Kind, string, string][] = [
    ['all', 'All', 'Every name the files declare'],
    ['functions', 'Functions', 'Every function'],
    ['variables', 'Variables', 'Every global and table'],
    ['typedefs', 'Typedefs', 'Every typedef'],
    ['enums', 'Enumerations', 'Every named enum'],
    ['enumerators', 'Enumerators', 'Every enumerator'],
    ['macros', 'Macros', 'Every macro'],
  ];
  for (const [kind, title, what] of KINDS) indexPages(`${root}/globals/${kind}`, title, `${what} of ${GAME_TITLE[game]}, with the files it is in`, [...(members.get(kind) ?? [])].map(([name, links]) => ({ key: name.replace(/[`()]/g, ''), name, links })));
  page(`${root.slice(1)}/globals/index.md`, { title: 'File Members', description: `Every name the files of ${GAME_TITLE[game]} declare, by kind.` }, KINDS.map(([kind, title]) => `- [${title}](${root}/globals/${kind}): ${members.get(kind)?.size ?? 0} names`).join('\n'));
  meta(`${root}/globals`, { title: 'File Members', pages: KINDS.map(([kind]) => kind) });

  // The File List: every folder and file as a tree, each file with its brief.
  const tree = (dir: string, depth: number): string[] => {
    const pad = '  '.repeat(depth);
    return [
      `${pad}- [${code(`${basename(dir)}/`)}](${dirPage(dir)})`,
      ...subdirsOf(dir).flatMap((d) => tree(d, depth + 1)),
      ...(byDir.get(dir) ?? []).map((f) => `${pad}  - [${code(basename(f.path))}](${pageOf(f.path)})${f.summary ? `: ${linkNames(f.summary, game, '')}` : ''}`),
    ];
  };
  const tops = ROOTS.map((r) => `games/${game}/${r}`).filter((d) => byDir.has(d));
  // The page this was, the source's own guide, now in the guide: a link to
  // one of its headings goes on to it.
  const sourceGuide = guides.get(`games/${game}/src`);
  const readme = join(repo, `games/${game}/src/README.md`);
  const moved: Record<string, string> = {};
  if (sourceGuide && existsSync(readme)) for (const m of readFileSync(readme, 'utf8').matchAll(/^#{2,6} (.+?)(?: \{#[\w-]+\})?$/gm)) moved[headingSlug(m[1].replace(/[`*]/g, ''))] = `${sourceGuide.url}#${headingSlug(m[1].replace(/[`*]/g, ''))}`;
  page(
    `${root.slice(1)}/index.mdx`,
    { title: 'File List', description: `Every folder and file of ${GAME_TITLE[game]}'s source, with each file's brief.` },
    [
      sourceGuide ? `[${headingOf(`${sourceGuide.key}/README.md`) ?? 'The source'}](${sourceGuide.url}) explains how the folders divide the program.` : '',
      tops.flatMap((d) => tree(d, 0)).join('\n'),
      Object.keys(moved).length ? `<AnchorRedirect map={${JSON.stringify(moved)}} />` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
  );
  meta(root, {
    title: 'Reference',
    description: `${GAME_TITLE[game]}'s files, structures and members`,
    root: true,
    pagesIndex: 'index',
    pages: [`[File List](${root})`, ...tops.map((d) => basename(d)), 'structs', 'fields', 'globals'],
  });
}

// A folder guide's files in the reference, as a Doxygen group page lists its
// members: the folders of the guide's code (src/battle, include/battle,
// include/unit/battle), each with its files and their briefs.
function guideFiles(key: string, files: SourceFile[]): string {
  const [, game, , name] = key.split('/');
  const parts: string[] = [];
  for (const r of ['src', 'include', 'include/unit']) {
    const dir = `games/${game}/${r}/${name}`;
    const list = files.filter((f) => f.path.startsWith(`${dir}/`)).sort((a, b) => (a.path < b.path ? -1 : 1));
    if (!list.length) continue;
    parts.push(`[${code(`${r}/${name}/`)}](${dirPage(dir)})`, `| File | Description |\n| --- | --- |\n${list.map((f) => `| [${code(f.path.slice(dir.length + 1))}](${pageOf(f.path)}) | ${cell(linkNames(f.summary, f.game, ''))} |`).join('\n')}`);
  }
  return parts.length ? [heading('##', 'Source files', 'source-files'), ...parts].join('\n\n') : '';
}

// ---------------------------------------------------------------------------
// The prose pages: the README, INSTALL, the front page, the section pages and
// the folder guides, without their first heading (the page's title) and with
// their repository links resolved.

// The site's arrangement comes from Alchemy's own links. README.md is the
// root; it places the games' front pages, INSTALL.md and each game's
// MATCHING.md. A game's front page places its section pages (the other
// Markdown files beside it), its places and the guide to its source. Both
// order what they place by their last link to each: a front page tells the
// game's story, mentioning its pages as it goes, and ends with the list of
// them. A section page places the folder READMEs it links, in the order it
// first links them, the first placement winning; each folder README ends with
// its folders' files in the reference (guideFiles). Every other link is a
// cross-reference. The arrangement is the guide; the reference stays out of
// it. A page is titled by its # heading and described by its first sentence
// (prose()).
//
// A page's URL is its parent's and then the section page's name or the
// folder's (/tbs/battle/battle_anim), except for the few that have fixed URLs.
const SITE = 'https://alchemy.pascalpixel.com';
// Site settings: the pages with fixed URLs, by what links to them. A game's
// places are its map list, and the guide to its source is its src
// folder's README (the reference, the source itself, is at /tbs/source).
// The glossary is a page of the game's own, placed while its file exists,
// but fixed so that the folder guides it links stay under the section pages
// that explain them.
const FIXED: [string, string][] = [
  ['README.md', '/'],
  ['INSTALL.md', '/start'],
  ['games/tbs/src/MATCHING.md', '/tbs/matching'],
  ['games/tbs/glossary.md', '/tbs/glossary'],
  ['games/tbs/src/field/map_headers.s', '/tbs/places'],
  // The Unused page, which unusedPage() writes from the source's comments; a
  // README links it by its address on the site.
  ['games/tbs/unused', '/tbs/unused'],
  ['games/tbs/src', '/tbs/code'],
];
// The root's sidebar label: the README's own heading is the site's name.
const ROOT_LABEL = 'Introduction';

type Placed = { key: string; url: string; children: Placed[]; parent?: Placed; kind: 'root' | 'game' | 'section' | 'guide' | 'fixed' };
const placed = new Map<string, Placed>();
const redirects: { source: string; destination: string }[] = JSON.parse(readFileSync(join(docs, 'vercel.json'), 'utf8')).redirects ?? [];

// What a link in an Alchemy Markdown file points at: a repository path, as
// the arrangement names it, or nothing for a link elsewhere. A link to the
// site itself is read back to the page it shows.
function linkTarget(from: string, href: string): string | undefined {
  let link = href.replace(/#.*$/, '');
  if (link.startsWith(`${SITE}/`) || link === SITE) {
    let path = link.slice(SITE.length).replace(/\/$/, '') || '/';
    path = redirects.find((r) => r.source === path)?.destination.replace(/#.*$/, '') ?? path;
    const fixed = FIXED.find(([, url]) => url === path);
    if (fixed) return fixed[0];
    const m = path.match(/^\/(\w+)(?:\/(\w+))?$/);
    if (m && existsSync(join(repo, `games/${m[1]}/${m[2] ?? 'README'}.md`))) return `games/${m[1]}/${m[2] ?? 'README'}.md`;
    const node = [...placed.values()].find((p) => p.url === path);
    return node?.key;
  }
  if (!link || /^[a-z]+:/.test(link) || link.startsWith('/')) return undefined;
  const clean = normalize(join(dirname(from), link)).replace(/\/$/, '');
  return clean.replace(/^(games\/\w+\/src)\/README\.md$/, '$1');
}

// What a file links, each once, in the order of its first link to each or
// of its last.
function linksOf(file: string, order: 'first' | 'last' = 'first'): string[] {
  const text = readFileSync(join(repo, file), 'utf8').replace(/```[\s\S]*?```/g, '');
  const out: string[] = [];
  for (const m of text.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) {
    const t = linkTarget(file, m[1]);
    if (!t) continue;
    if (out.includes(t) && order === 'last') out.splice(out.indexOf(t), 1);
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

const isFrontPage = (k: string) => GAMES.some((g) => k === `games/${g}/README.md`);
const sectionPages = (game: Game) => readdirSync(join(repo, 'games', game)).filter((f) => f.endsWith('.md') && f !== 'README.md').map((f) => `games/${game}/${f}`);
const guideReadmes = (game: Game) => readdirSync(join(repo, 'games', game, 'src'), { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(repo, 'games', game, 'src', e.name, 'README.md'))).map((e) => `games/${game}/src/${e.name}/README.md`);
const fixedUrl = (k: string) => FIXED.find(([key]) => key === k)?.[1];
const notes: string[] = [];

function arrange(): Placed {
  const root: Placed = { key: 'README.md', url: '/', children: [], kind: 'root' };
  placed.set(root.key, root);
  const add = (parent: Placed, key: string, kind: Placed['kind'], url: string) => {
    const node: Placed = { key, url, children: [], parent, kind };
    parent.children.push(node);
    placed.set(key, node);
    return node;
  };
  // What the root places: the front pages, INSTALL.md and MATCHING.md.
  const rootWants = [...GAMES.map((g) => `games/${g}/README.md`), 'INSTALL.md', ...GAMES.map((g) => `games/${g}/src/MATCHING.md`)];
  const rootLinks = linksOf('README.md', 'last').filter((k) => rootWants.includes(k));
  for (const k of rootWants) if (!rootLinks.includes(k) && existsSync(join(repo, k))) notes.push(`README.md doesn't link ${k}: placed after its links`);
  for (const k of [...rootLinks, ...rootWants.filter((k) => !rootLinks.includes(k) && existsSync(join(repo, k)))]) {
    add(root, k, isFrontPage(k) ? 'game' : 'fixed', fixedUrl(k) ?? `/${k.split('/')[1]}`);
  }
  // What each front page places: its section pages, places and source.
  for (const game of root.children.filter((n) => n.kind === 'game')) {
    const g = game.key.split('/')[1] as Game;
    const wants = [...sectionPages(g), `games/${g}/src/field/map_headers.s`, `games/${g}/unused`, `games/${g}/src`];
    const links = linksOf(game.key, 'last').filter((k) => wants.includes(k));
    for (const k of wants) if (!links.includes(k) && (fixedUrl(k) || existsSync(join(repo, k)))) notes.push(`${game.key} doesn't link ${k}: placed after its links`);
    for (const k of [...links, ...wants.filter((k) => !links.includes(k) && (fixedUrl(k) || existsSync(join(repo, k))))]) {
      if (fixedUrl(k)) add(game, k, 'fixed', fixedUrl(k)!);
      else add(game, k, 'section', `${game.url}/${basename(k, '.md')}`);
    }
    // What each section page places, in the front page's order: the folder
    // READMEs it links that no section page before it placed.
    const guides = guideReadmes(g);
    for (const section of game.children.filter((n) => n.kind === 'section'))
      for (const k of linksOf(section.key)) if (guides.includes(k) && !placed.has(k)) add(section, k, 'guide', `${section.url}/${basename(dirname(k))}`);
  }
  return root;
}

// The derived tree, as the build prints it.
function printTree(node: Placed, depth = 0): string[] {
  const title = node.kind === 'root' ? ROOT_LABEL : (headingOf(node.key) ?? headingOf(`${node.key}/README.md`) ?? (node.key.endsWith('map_headers.s') ? 'Places' : node.key.endsWith('/unused') ? 'Unused' : node.key));
  return [`${'  '.repeat(depth)}${title}  ${node.url}`, ...node.children.flatMap((c) => printTree(c, depth + 1))];
}
function headingOf(key: string): string | undefined {
  const file = join(repo, key);
  if (!existsSync(file) || !statSync(file).isFile() || !key.endsWith('.md')) return undefined;
  const h = readFileSync(file, 'utf8').match(/^# (.+?)(?: \{#[\w-]+\})?\n/)?.[1];
  return h === undefined ? undefined : siteTitle(key, h);
}

// A page's title on the site: the front page is the guide's Introduction,
// and a game's page is titled by its name alone, without the source's emoji.
function siteTitle(key: string, heading: string): string {
  if (key === 'README.md') return ROOT_LABEL;
  return heading.replace(/^(?:☀️|⚓️|☀|⚓|🌋)\s*/u, '');
}

// The page a link in a README goes to: the arranged page, the reference's
// page for C and the folders that hold it, and GitHub for anything else.
function siteLink(path: string): string {
  const clean = normalize(path).replace(/\/$/, '').replace(/^(games\/\w+\/src)\/README\.md$/, '$1');
  const node = placed.get(clean);
  if (node) return node.url;
  const m = clean.match(/^games\/(tbs|tla)\/((?:src|include)(?:\/.*)?)$/);
  if (m && GAMES.includes(m[1] as Game) && existsSync(join(repo, clean))) {
    if (/\.[ch]$/.test(clean)) return pageOf(clean);
    if (statSync(join(repo, clean)).isDirectory() && walk(clean).length) return `/${m[1]}/source/${m[2]}`;
  }
  return `${github}/${clean}`;
}

// A page's description: the first sentence of its opening paragraph, past
// any picture above it, as plain text. A page that opens with a heading, a
// table or a list has none.
function firstSentence(text: string): string {
  for (const block of text.split(/\n\s*\n/)) {
    const b = block.trim();
    if (!b || /^(!\[[^\]]*\]\([^)]*\)\s*)+$/.test(b)) continue;
    if (/^(#|\||```|[-*+] |\d+\. |<|>)/.test(b)) return '';
    const plain = b
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[`*]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    // A sentence runs on past an abbreviation's full stop (Mt. Aleph, e.g.).
    return plain.split(/(?<=(?<!\b(?:Mt|Mr|Mrs|Ms|Dr|St|e\.g|i\.e|vs))[.!?])\s+(?=[^a-z])/)[0];
  }
  return '';
}

// Writes a Markdown file of Alchemy's as the page at target, titled by its
// # heading and described by its first sentence.
function prose(source: string, target: string, extra = '') {
  let text = readFileSync(join(repo, source), 'utf8');
  const heading = text.match(/^# (.+?)(?: \{#[\w-]+\})?\n+/);
  const title = heading ? siteTitle(source, heading[1]) : basename(source);
  if (heading) text = text.slice(heading[0].length);
  // The pages are Markdown, which drops raw HTML: an <img> becomes an image,
  // and the site's own files are served from its root.
  text = text.replace(/<img\s+([^>]*?)\/?>/g, (all, attrs: string) => {
    const src = attrs.match(/src="([^"]*)"/)?.[1];
    if (!src) return all;
    const alt = attrs.match(/alt="([^"]*)"/)?.[1] ?? '';
    return `![${alt}](${src.replace(/^https:\/\/alchemy\.pascalpixel\.com\//, '/')})`;
  });
  const description = firstSentence(text);
  text = linkProse(codeProse(text, 'tbs'), 'tbs');
  // A Markdown image of the site's own is served from its root too, so the
  // build reads it from public/ rather than from the live site.
  text = text.replace(/(!\[[^\]]*\]\()https:\/\/alchemy\.pascalpixel\.com\//g, '$1/');
  text = text.replace(/(!?)\[([^\]]*)\]\(([^)#\s]*)(#[^)]*)?\)/g, (all, bang: string, label: string, link: string, hash = '') => {
    // A link to the site itself stays on the site, past any redirect.
    if (!bang && link.startsWith(`${SITE}/`)) {
      const path = link.slice(SITE.length).replace(/(.)\/$/, '$1');
      const to = redirects.find((r) => r.source === path)?.destination;
      return `[${label}](${to ?? `${path}${hash}`})`;
    }
    if (/^[a-z]+:/.test(link) || link.startsWith('/') || !link) return all;
    const resolved = normalize(join(dirname(source), link));
    if (bang) return `![${label}](${picture(resolved) ?? `${github.replace('/blob/', '/raw/')}/${resolved}`}${hash})`;
    return `[${pathLabel(label, resolved)}](${siteLink(resolved)}${hash})`;
  });
  // MDX would read a bare < or { as markup. A bare relative path in code
  // (`../window/screens/targets.c`) loses its ../, which means
  // nothing on the site.
  text = text
    .split(/(```[\s\S]*?```|`[^`]*`)/)
    .map((p, i) => (i % 2 ? p.replace(/^`(?:\.\.\/)+([\w./-]+)`$/, '`$1`') : p.replace(/<(?![a-z/!])/g, '&lt;').replace(/[{}]/g, (c) => `\\${c}`)))
    .join('');
  page(target, { title, description, source }, extra ? `${text.trimEnd()}\n\n${extra}` : text);
}

// A link whose text is the relative path it links (`../window`,
// `../game/enemies.tsv`) reads on the site as the page it goes to: a guide's
// title, a file's name, or a folder's path inside the game without its ../.
function pathLabel(label: string, resolved: string): string {
  const m = label.match(/^(`?)((?:\.\.\/)+)([^`]*)\1$/);
  if (!m) return label;
  const heading = headingOf(resolved) ?? headingOf(`${resolved}/README.md`);
  if (heading) return heading;
  return `\`${/\.\w+$/.test(m[3]) ? basename(m[3]) : m[3].replace(/\/$/, '')}\``;
}

// The source marks what isn't known with `XXX:` (and H4's `XXX (no evidence):`
// and `XXX (picture):`). A reader would take the mark for an unfinished
// editor's note, so a page says it in words, as a bold label: a paragraph's
// question, from its mark to the paragraph's end, becomes a paragraph of its
// own after the sentences before it, which lib/remark-open-questions.ts shows
// as a note; a mark in a list item or a table, or a second one in the same
// question, becomes the label alone. A `- XXX (picture):` item is the
// worklist's picture still to make, not a question for a reader: the page
// leaves it out, with its continuation lines, and a list or an `Open
// questions:` line it leaves empty. Code is left as written.
const XXX_MARK = /\bXXX(?: \(([a-z ]+)\))?:/;
const XXX_LABEL: Record<string, string> = { '': 'Open question', 'no evidence': 'Open question (no evidence in reach)', picture: 'Picture still to make' };
const xxxLabel = (kind = '') => `**${XXX_LABEL[kind] ?? `Open question (${kind})`}:**`;
// A list item, with the lines indented under it, that is a picture still to make.
function dropPictures(segment: string): string {
  const lines = segment.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)[-*+] XXX \(picture\):/);
    if (!m) {
      out.push(lines[i]);
      continue;
    }
    while (i + 1 < lines.length && lines[i + 1].trim() && lines[i + 1].search(/\S/) > m[1].length) i++;
  }
  // A heading or an `Open questions:` line whose list is gone goes with it.
  return out
    .join('\n')
    .replace(/^(?:#{2,6} [^\n]*[Oo]pen questions[^\n]*|(?:\/\/\/ )?Open questions:)\n(?:[ \t]*\n)*(?=#{1,6} |$(?![\s\S]))/gm, '');
}
// The source writes the games as ☀️ and ⚓️; a reader who arrives at a page
// cold doesn't know them, so the text says the game's name. Beside the name
// itself (☀️ **The Broken Seal**, **The Broken Seal** (☀️, build `tbs`)) the
// mark goes; between a determiner and the noun it describes it loses its
// article (no Broken Seal code, the six Broken Seal editions); anywhere else
// it is the title (nothing in The Broken Seal calls it). Code and page titles
// keep the marks.
const GAME_MARKS: [RegExp, string][] = [
  [/☀️?/, 'The Broken Seal'],
  [/⚓️?/, 'The Lost Age'],
];
const DETERMINERS = new Set(['a', 'an', 'the', 'no', 'any', 'every', 'each', 'all', 'both', 'some', 'its', 'their', 'this', 'that', 'these', 'those', 'one', 'two', 'three', 'four', 'five', 'six', 'twelve', 'other']);
function gameNames(text: string): string {
  if (!/[☀⚓]/.test(text)) return text;
  return text
    .split(/(```[\s\S]*?```|`[^`]*`)/)
    .map((part, i) => {
      if (i % 2) return part;
      for (const [mark, name] of GAME_MARKS) {
        const m = mark.source;
        const bare = name.replace(/^The /, '');
        part = part
          .replace(new RegExp(`${m} ?(?=[*\\[ ]*(?:Golden Sun: )?${name})`, 'g'), '')
          .replace(new RegExp(`(${name}\\**) \\(${m}(?:, |\\))`, 'g'), (_, before: string, offset: number, all: string) => `${before}${all[offset + _.length - 1] === ')' ? '' : ' ('}`)
          .replace(new RegExp(`(\\b[A-Za-z]+) ${m}(?=[ -][A-Za-z])`, 'g'), (all, word: string) => (DETERMINERS.has(word.toLowerCase()) ? `${word} ${bare}` : all))
          .replace(new RegExp(m, 'g'), name);
      }
      return part;
    })
    .join('');
}
function openQuestions(text: string): string {
  // A comment that points to another's mark (`see the XXX there`) means its question.
  const labels = (s: string) =>
    s
      .split(/(`[^`]*`)/)
      .map((p, i) => (i % 2 ? p : p.replace(new RegExp(XXX_MARK.source, 'g'), (_, kind?: string) => xxxLabel(kind)).replace(/\bXXX\b(?!:| \()/g, 'open question')))
      .join('');
  return text
    .split(/(```[\s\S]*?```)/)
    .map((segment, i) =>
      i % 2
        ? segment
        : dropPictures(segment)
            .split(/(\n[ \t]*\n)/)
            .map((block, j) => {
              if (j % 2 || !block.includes('XXX')) return block;
              // Only a paragraph is split: not a heading, list, table, quote or picture.
              if (/^\s*(#|[-*+] |\d+\. |\||>|<|!\[)/.test(block) || /^\s/.test(block)) return labels(block);
              const parts = block.split(/(`[^`]*`)/);
              let at = -1;
              for (let k = 0, offset = 0; k < parts.length && at < 0; offset += parts[k].length, k++) {
                const found = k % 2 ? -1 : parts[k].search(XXX_MARK);
                if (found >= 0) at = offset + found;
              }
              if (at < 0) return labels(block);
              const before = block.slice(0, at).trimEnd();
              const question = labels(block.slice(at));
              return before ? `${before}\n\n${question}` : question;
            })
            .join(''),
    )
    .join('');
}

// Where an arranged page's file goes: its URL as a path under the guide's
// folder group, a folder with an index for every page that holds others (and
// for the places, which places() fills).
const fileOf = (node: Placed) => `${GUIDE}/${node.children.length || node.kind === 'root' || /\/field\/maps\.s$/.test(node.key) ? `${node.url.slice(1) || '.'}/index.md`.replace(/^\.\//, '') : `${node.url.slice(1)}.md`}`;
const folderOf = (node: Placed) => dirname(fileOf(node));
const relativeTo = (from: string, to: string) => relative(from === '.' ? '' : from, to) || '.';

// Writes every arranged page from its Markdown, except the places, which
// places() writes. A folder guide ends with its folders' files in the
// reference (guideFiles).
function arrangedPages(root: Placed, files: Map<Game, SourceFile[]>) {
  const walkTree = (n: Placed): Placed[] => [n, ...n.children.flatMap(walkTree)];
  for (const node of walkTree(root)) {
    const source = /^games\/\w+\/src$/.test(node.key) ? `${node.key}/README.md` : node.key;
    if (!source.endsWith('.md') || !existsSync(join(repo, source))) continue;
    const extra = node.kind === 'guide' ? guideFiles(node.key, files.get(node.key.split('/')[1] as Game) ?? []) : '';
    prose(source, fileOf(node), extra);
  }
}

// The sidebar: the guide's tab, a meta.json for every folder the arrangement
// made, listing its children in order; and each game's reference, which
// referencePages() lays out, as a tab of its own.
function arrangedSidebar(root: Placed) {
  const meta = (folder: string, data: object) => write(join(content, folder, 'meta.json'), JSON.stringify(data, null, 2) + '\n');
  const pagesOf = (node: Placed) => node.children.map((c) => relativeTo(folderOf(node), fileOf(c).replace(/(\/index)?\.md$/, '')));
  meta('.', { pages: [GUIDE, ...GAMES.map((g) => reference(g).slice(1))] });
  meta(GUIDE, { title: 'Guide', description: 'How the games work, system by system and place by place', root: true, pagesIndex: 'index', pages: [`[${ROOT_LABEL}](/)`, ...pagesOf(root)] });
  const walkTree = (n: Placed): Placed[] => [n, ...n.children.flatMap(walkTree)];
  for (const node of walkTree(root)) {
    if (node.kind === 'game') meta(folderOf(node), { defaultOpen: true, pages: pagesOf(node) });
    if (node.kind === 'section' && node.children.length) meta(folderOf(node), { pages: pagesOf(node) });
  }
}

// The checks the build fails on: every folder README of a game with pages
// sits under one of that game's section pages, and every redirect leads to a
// page the build writes, which no redirect leaves from.
function checkArrangement() {
  const failures: string[] = [];
  for (const game of GAMES)
    for (const k of guideReadmes(game)) {
      const node = placed.get(k);
      if (!node) failures.push(`${k} is placed nowhere: no section page of ${game} links it`);
      else if (node.parent?.kind !== 'section' || !node.parent.key.startsWith(`games/${game}/`)) failures.push(`${k} sits under ${node.parent?.key}, not a section page of ${game}`);
    }
  for (const r of redirects) {
    const to = r.destination.replace(/#.*$/, '');
    // A redirect between renders (an old folder name) leads into the store.
    const render = renderPath(to)?.replace(/:path\*$/, '');
    if (render !== undefined) {
      if (![...stored.keys()].some((p) => p.startsWith(render))) failures.push(`the redirect from ${r.source} leads to ${r.destination}, which the store doesn't hold`);
      continue;
    }
    // A folder's redirect (/tbs/source/src/scene/:path*) leads into the
    // folder that holds its pages now, and hides none of the pages written.
    if (to.endsWith('/:path*')) {
      const from = r.source.replace(/\/:path\*$/, '/');
      const into = to.replace(/\/:path\*$/, '');
      if (!pagesWritten.has(into)) failures.push(`the redirect from ${r.source} leads into ${into}, which the build doesn't write`);
      for (const p of pagesWritten) if (p.startsWith(from)) failures.push(`the redirect from ${r.source} hides ${p}, a page the build writes`);
      continue;
    }
    if (!/^https?:/.test(to) && !pagesWritten.has(to)) failures.push(`the redirect from ${r.source} leads to ${r.destination}, which the build doesn't write`);
    if (pagesWritten.has(r.source)) failures.push(`the redirect from ${r.source} hides a page the build writes`);
    if (redirects.some((s) => s.source === to)) failures.push(`the redirect from ${r.source} leads to another redirect, ${to}`);
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Finding code by what the player sees: the places, by each map overlay's summary.

// The renders, by scene number: the store's places/index.tsv lists every map,
// entrance shot and recording with the scene it was made in and the way the
// place was drawn (cursed, cured, or a story moment and the flags it set), so
// a scene renamed since keeps its renders.
type Render = { number: number; scene: string; area: string; variant: string; kind: string; event: string; messages: string; file: string };
let placeRows: Render[] | undefined;
function placeRenders(): Render[] {
  if (!placeRows) {
    const [head, ...lines] = readFetched(docs, 'places/index.tsv').trim().split('\n').map((l) => l.split('\t'));
    const col = (name: string) => head.indexOf(name);
    placeRows = lines.map((r) => ({ number: +r[col('number')], scene: r[col('scene')], area: r[col('area')] ?? '', variant: r[col('variant')] ?? '', kind: r[col('kind')], event: r[col('event')], messages: r[col('messages')] ?? '', file: r[col('file')] }) as Render);
  }
  return placeRows;
}

function places(files: SourceFile[]) {
  const scenes = files.filter((f) => /^games\/tbs\/src\/map\/[^/]+\.c$/.test(f.path));
  const pages = placePages(scenes);
  const rows = scenes.map((f) => {
    const here = pages.filter((p) => p.file === f).map((p) => `[${p.title}](/tbs/places/${p.slug})`);
    return `| [\`${basename(f.path)}\`](${pageOf(f.path)}) | ${here.join(', ')} | ${f.summary} |`;
  });
  page(`${GUIDE}/tbs/places/index.md`, { title: 'Places', description: 'Every place the party can walk around in, and what happens there.' }, `Each map overlay holds one place, or a few that share it, and each place has a page of its own with its map and its events. The [Maps](${siteLink('games/tbs/src/map/README.md')}) guide explains how a map runs and how to find an event in it.\n\n| Overlay | Places | What happens there |\n| --- | --- | --- |\n${rows.join('\n')}`);
  write(join(content, GUIDE, 'tbs/places/meta.json'), JSON.stringify({ title: 'Places', pages: pages.map((p) => p.slug) }, null, 2) + '\n');
}

// The English catalog's messages by symbol, each as the pages the player
// reads: line breaks as spaces, the names it prints in place of their codes
// ({actor_name:n} is character n - 1, {protagonist_name} Isaac by default)
// and its other codes gone; and each number's symbol.
function catalog() {
  const characters = [...text('games/tbs/include/game/character_ids.h').matchAll(/^#define ([A-Z]+) (\d)\b/gm)].map((m) => m[1][0] + m[1].slice(1).toLowerCase());
  const pages = new Map<string, string[]>();
  const symbol = new Map<number, string>();
  for (const m of text('games/tbs/text/en.po').matchAll(/msgctxt "(\w+)"\nmsgid "(\d+)"\nmsgstr ((?:"(?:[^"\\]|\\.)*"\n?)+)/g)) {
    if (m[1] === 'message') continue;
    const raw = [...m[3].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]).join('').replace(/\\n/g, ' ').replace(/\\(.)/g, '$1');
    const shown = raw
      .split(/\{(?:page_break|end_wait|end_now)\}/)
      .map((page) =>
        page
          .replace(/\{actor_name:(\d+)\}/g, (_, n: string) => characters[Number(n) - 1] ?? '')
          .replace(/\{protagonist_name\}/g, characters[0] ?? '')
          .replace(/\{possessive_suffix\}/g, "'s")
          .replace(/\{em_dash\}/g, '—')
          .replace(/\{[^}]*\}/g, '')
          .replace(/\s+/g, ' ')
          .trim(),
      )
      .filter(Boolean);
    pages.set(m[1], shown);
    symbol.set(Number(m[2]), m[1]);
  }
  return { pages, symbol };
}

// What the player reads first in an event, as a short quoted passage: its
// first two pages, each message a paragraph of its own, and an ellipsis
// where the message goes on.
function passage(symbols: string[], pages: Map<string, string[]>): string {
  const out: string[] = [];
  let left = 2;
  for (const s of symbols) {
    const shown = pages.get(s) ?? [];
    if (!left || !shown.length) continue;
    const taken = shown.slice(0, left);
    left -= taken.length;
    // The site sets a blockquote in quotation marks of its own.
    out.push(`> ${md(taken.join(' '))}${taken.length < shown.length ? ' …' : ''}`);
  }
  return out.join('\n>\n');
}

// The rows of a map overlay's event tables that show a message, by the
// message's symbol: each row's table, line, kind and trigger as written,
// with the rows a macro of the file writes (lunpa.c's TALK and MIND_READ);
// and the tables its event getter returns for a map it names
// (`if (mapId == (s32)&MapId_BilibinBarricade) { return gBilibinEvents3; }`).
type MessageRow = { table: string; line: number; control: string; trigger: string };
function messageRows(path: string): { rows: Map<string, MessageRow[]>; tablesOf: Map<string, Set<string>> } {
  const source = readFileSync(join(repo, path), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (c) => c.replace(/[^\n]/g, ' '));
  const splitTop = (s: string) => {
    const parts = [''];
    let depth = 0;
    for (const c of s.replace(/\\\n/g, ' ')) {
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (c === ',' && depth === 0) parts.push('');
      else parts[parts.length - 1] += c;
    }
    return parts.map((p) => oneLine(p).replace(/^\(\s*([\s\S]*?)\s*\)$/, '$1')).filter(Boolean);
  };
  const tables = [...source.matchAll(/struct MapEvent\s+(\w+)\s*\[\s*\]\s*=\s*\{/g)].map((m) => ({ name: m[1], start: m.index!, end: source.indexOf('\n};', m.index!) }));
  const rows = new Map<string, MessageRow[]>();
  const add = (parts: string[], at: number) => {
    const msg = parts.length === 4 && /^(MAP_EVENT_|COORD_EVENT_|BG_EVENT\(|PSYNERGY|USE_ITEM|0x[0-9a-f]+$|\d+$)/i.test(parts[0]) ? parts[3].match(/\b(Msg\w+)\b/) : null;
    if (!msg) return;
    const table = tables.find((t) => t.start < at && at < t.end)?.name ?? '';
    rows.set(msg[1], [...(rows.get(msg[1]) ?? []), { table, line: source.slice(0, at).split('\n').length, control: parts[0], trigger: parts[1] }]);
  };
  for (const m of source.matchAll(/\{([^{}]*)\}/g)) add(splitTop(m[1]), m.index!);
  for (const d of source.matchAll(/^#define (\w+)\(([\w\s,]*)\)((?:[^\n]*\\\n)*[^\n]*)/gm)) {
    const body = d[3].replace(/\\\n/g, ' ').trim().match(/^\{([^{}]*)\}$/);
    if (!body) continue;
    const params = d[2].split(',').map((p) => p.trim());
    const shape = splitTop(body[1]);
    for (const call of source.matchAll(new RegExp(`(?<!#define )\\b${d[1]}\\s*\\(`, 'g'))) {
      let depth = 0;
      let end = call.index! + call[0].length - 1;
      for (; end < source.length; end++) {
        if (source[end] === '(') depth++;
        else if (source[end] === ')' && --depth === 0) break;
      }
      const args = splitTop(source.slice(call.index! + call[0].length, end));
      add(shape.map((part) => part.replace(/\b\w+\b/g, (w) => (params.includes(w) ? (args[params.indexOf(w)] ?? w) : w))), call.index!);
    }
  }
  const tablesOf = new Map<string, Set<string>>();
  for (const getter of source.matchAll(/struct MapEvent\s*\*\s*\w+\s*\(\s*void\s*\)\s*\{/g)) {
    const start = getter.index! + getter[0].length;
    const body = source.slice(start, source.indexOf('\n}', start));
    for (const m of body.matchAll(/\bif\s*\(/g)) {
      let depth = 1;
      let i = m.index! + m[0].length;
      for (; i < body.length && depth; i++) depth += body[i] === '(' ? 1 : body[i] === ')' ? -1 : 0;
      const condition = body.slice(m.index! + m[0].length, i - 1);
      const table = body.slice(i).match(/^\s*\{?\s*return\s+(\w+)\s*;/)?.[1];
      if (!table || condition.includes('!=')) continue;
      for (const s of condition.matchAll(/MapId_(\w+)/g)) tablesOf.set(s[1], new Set([...(tablesOf.get(s[1]) ?? []), table]));
    }
  }
  return { rows, tablesOf };
}

// What a search row searches, by its BgEventTarget (control bits 8..4):
// "a bookcase", "a spot".
function searched(row: MessageRow | undefined): string {
  const value = row && /^(0x[0-9a-f]+|\d+)$/i.test(row.control) ? Number(row.control) : undefined;
  const target = row?.control.match(/^BG_EVENT\(\s*(\w+)\s*\)$/)?.[1] ?? (value !== undefined && (value & 0xf) === 3 ? enumOf('BgEventTarget').find((e) => e.value === ((value >> 4) & 0x1f))?.name : undefined);
  const thing = !target || target === 'BG_EVENT_SILENT' ? 'spot' : target.replace(/^BG_EVENT_/, '').toLowerCase().replace(/_/g, ' ');
  return `${/^[aeiou]/.test(thing) ? 'an' : 'a'} ${thing}`;
}

// The story index scripts/story.ts writes to build/story, which `bun run
// content` makes first: every map event with the maps it plays in, its
// trigger and the messages it shows (events.tsv), and a first story order of
// them by the flags they need and set (beats.tsv). An event takes the order of
// its earliest beat; one with no beat follows the event before it in its file.
type StoryEvent = { file: string; scenes: number[]; event: string; trigger: string; messages: number[]; order: number; index: number };
function storyEvents(): StoryEvent[] {
  const dir = join(docs, 'build/story');
  if (!existsSync(join(dir, 'events.tsv')) || !existsSync(join(dir, 'beats.tsv'))) {
    console.error('content: build/story has no events.tsv or beats.tsv; bun scripts/story.ts writes them');
    process.exit(1);
  }
  const read = (name: string) => {
    const [head, ...lines] = readFileSync(join(dir, name), 'utf8').replace(/\n+$/, '').split('\n').map((l) => l.split('\t'));
    return lines.map((r) => Object.fromEntries(head.map((k, i) => [k, r[i] ?? ''])) as Row);
  };
  const first = new Map<string, number>();
  for (const b of read('beats.tsv')) {
    const key = `${b.file}\t${b.event}`;
    if (!first.has(key) || Number(b.order) < first.get(key)!) first.set(key, Number(b.order));
  }
  let last = 0;
  return read('events.tsv').map((e, index) => {
    const order = first.get(`${e.file}\t${e.event}`);
    if (order !== undefined) last = order;
    return { file: e.file, scenes: e.scenes.split(', ').map((s) => parseInt(s, 10)), event: e.event, trigger: e.trigger, messages: e.messages ? e.messages.split(', ').map(Number) : [], order: order ?? last + 0.5, index };
  });
}

// A sentence of a comment as plain words: its first sentence, the
// parentheses that hold code names left out, up to any colon.
function plainSentence(text: string): string {
  const s = text
    .replace(/\s*\([^()]*[`_][^()]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=(?<!\b(?:Mt|Mr|Mrs|Ms|Dr|St))[.!?])\s/)[0]
    .split(/[:;]\s/)[0];
  return s.replace(/[.!?]$/, '').trim();
}

// Who speaks, for a heading: the actor's comment's first words when they
// describe someone ("A young man with brown hair", "The tourist the guides
// are missing"), else the actor's name as words, its enum's shared prefix
// left out (LOCALID_SECOND_GUIDE is the second guide).
type ActorInfo = { doc: string; prefix: string };
function actorHeading(name: string, info: ActorInfo | undefined): string {
  let s = plainSentence((info?.doc ?? '').split(/\s*★/)[0]);
  if (/^["“]/.test(s)) s = '';
  if (s.length > 60) {
    const commas = [...s.matchAll(/, /g)].map((m) => m.index!);
    const at = commas.find((i) => s.slice(0, i).split(' ').length >= 3);
    if (at !== undefined) s = s.slice(0, at);
  }
  if (!s || /[`_]/.test(s)) {
    const words = name.slice(info?.prefix.length ?? 0).replace(/^(?:LOCALID|OBJ_EVENT)_/, '').toLowerCase().split('_').filter(Boolean);
    const phrase = words.map((w) => (properNoun(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');
    s = properNoun(words[0] ?? '') ? phrase : `the ${phrase}`;
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Every actor an enum names, with its comment and the prefix its enum's
// members share, by file and name.
function actorIndex(files: SourceFile[]) {
  const byFile = new Map<string, Map<string, ActorInfo>>();
  for (const f of files)
    for (const d of f.decls) {
      if (d.kind !== 'enum' || d.fields.length < 2) continue;
      const tokens = d.fields.map((x) => x.name.split('_'));
      let n = 0;
      while (tokens.every((t) => t.length > n + 1 && t[n] === tokens[0][n])) n++;
      const prefix = n ? `${tokens[0].slice(0, n).join('_')}_` : '';
      const own = byFile.get(f.path) ?? new Map<string, ActorInfo>();
      for (const x of d.fields) own.set(x.name, { doc: x.doc, prefix });
      byFile.set(f.path, own);
    }
  return (path: string, name: string) => byFile.get(path)?.get(name) ?? [...byFile.values()].find((m) => m.has(name))?.get(name);
}

// A place's own part of its overlay's opening comment: the list item or
// paragraph that opens by naming it, as "- Kalay (`MapId_Kalay`), a
// town…" or "The Bilibin Treasury (`BilibinTreasury`) is…", with the
// indented paragraphs that continue it; else the one for its title or its
// area name.
function placeBlock(doc: string, scene: string, names: string[]): string | undefined {
  const lines = doc.split('\n');
  const blocks: string[][] = [];
  lines.forEach((l, i) => {
    if (/^- /.test(l) || ((i === 0 || !lines[i - 1].trim()) && /^\S/.test(l))) blocks.push([l]);
    else blocks[blocks.length - 1]?.push(l);
  });
  const texts = blocks.map((b) => b.join('\n').trim());
  const head = (t: string) => t.replace(/^- /, '').replace(/^The /, '').replace(/\\/g, '');
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bySymbol = new RegExp(`^[^(\\n]{1,60}\\(\`?(?:MapId_)?${scene}\`?[\\s),]`);
  const found = texts.find((t) => bySymbol.test(head(t))) ?? names.map((n) => texts.find((t) => new RegExp(`^${esc(n)} \\(`).test(head(t)))).find(Boolean);
  return found
    ?.replace(/^- /, '')
    .replace(/\n {2}/g, '\n')
    .trim();
}

// A place's subtitle: its own part's first sentence in plain words, with no
// code names in it.
function placeSentence(text: string | undefined): string {
  if (!text) return '';
  // Game text the comment quotes in backticks (`McCoy's Hidden Treasury`) is
  // words, not code: code names hold no spaces.
  const s = plainSentence(text.replace(/^\s*- /, '').replace(/`([^`]*)`/g, (span, inner: string) => (inner.includes(' ') ? `“${inner}”` : span)));
  if (/[`_]/.test(s)) return '';
  return `${s.replace(/\\(.)/g, '$1')}.`;
}

// A page for each place, each map its overlay's warp tables are for: the
// part of the overlay's opening comment about it, or the whole comment when
// the overlay is one place or names none; the place's maps as the game draws
// them, where the renders have them, at each story moment they were drawn
// at; and its events in story order, each headed by what happens, with its
// recording, the first lines the player reads and the code that plays it.
// The pages follow the map numbers, which run in story order.
type Place = { file: SourceFile; scene: string; id: number; slug: string; title: string };
function placePages(scenes: SourceFile[]): Place[] {
  const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  const words = (s: string) => s.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/([0-9])([A-Z])/g, '$1 $2');
  const out: Place[] = [];
  for (const f of scenes) {
    const own = [...new Set([...readFileSync(join(repo, f.path), 'utf8').matchAll(/MAP_WARPS\((\w+)\)/g)].map((m) => m[1]))];
    for (const s of own) {
      const id = sceneIds.get(s);
      if (id !== undefined) out.push({ file: f, scene: s, id, slug: kebab(s), title: words(s) });
    }
  }
  out.sort((a, b) => a.id - b.id);
  const renders = placeRenders();
  const words2 = catalog();
  const story = storyEvents();
  const actor = actorIndex(scenes);
  const index2 = where.get('tbs')!;
  const rowsOfFile = new Map<string, ReturnType<typeof messageRows>>();
  for (const p of out) {
    const path = p.file.path.replace(/^games\/tbs\/src\//, '');
    const mine = renders.filter((r) => r.number === p.id && stored.has(`places/${r.file}`));
    const area = renders.find((r) => r.number === p.id && r.area)?.area ?? '';
    const alone = out.filter((q) => q.file === p.file).length === 1;
    const block = alone ? undefined : placeBlock(p.file.doc, p.scene, [p.title, area]);
    const body: string[] = [linkNames(block ?? p.file.doc, 'tbs', '')];
    // The world map has no map render of its own: it is the whole world laid
    // flat, which the front page shows.
    if (p.scene === 'WorldMap') body.push('![The whole world map of The Broken Seal, laid out flat](/story/world.png)');
    // Its maps, a place drawn more than one way (Kolima Forest before and
    // after Tret lifts the curse, Vale on the stormy night as each rock falls)
    // once for each way, captioned with the moment: as the game first draws
    // it, then the moments in the order their flags pile up.
    const maps = mine.filter((r) => r.kind === 'map').map((r) => ({ ...r, moment: moment(r.variant, r.scene) }));
    maps.sort((a, b) => a.moment.order - b.moment.order || (a.moment.caption < b.moment.caption ? -1 : a.moment.caption > b.moment.caption ? 1 : 0) || a.file.localeCompare(b.file, 'en', { numeric: true }));
    for (const m of maps) {
      const alt = `The whole of ${p.title}${m.moment.caption ? `, ${m.moment.caption},` : ''} as the game draws it`;
      const caption = m.moment.caption ? md(m.moment.caption.charAt(0).toUpperCase() + m.moment.caption.slice(1)) : '';
      body.push(`![${md(alt)}](/places/${m.file})${caption ? `\\\n${caption}` : ''}`);
    }

    // Its events: those the story index finds playing in this map, but for
    // the setting up on entry and the callbacks that show nothing.
    const events = story.filter((e) => e.file === path && e.scenes.includes(p.id) && !/^entry\b/.test(e.trigger) && !(/^callback\b/.test(e.trigger) && !e.messages.length));
    // An event's recordings, by the names it was recorded under: its own
    // name, else, from renders made before the rows were named, its table and
    // index (`gValeStorm_Events[26]`) or a function's name since renamed,
    // matched by the first message it showed.
    const aliases = new Map<string, string[]>();
    for (const n of new Set(mine.filter((r) => r.kind === 'event-gif' || r.kind === 'event-segment').map((r) => r.event))) {
      if (events.some((e) => e.event === n)) continue;
      const first = Number(mine.find((r) => r.event === n && r.messages)?.messages.split(',')[0]);
      const owner = events.find((e) => (words2.symbol.get(first) && e.event === words2.symbol.get(first)) || e.messages[0] === first);
      if (owner) aliases.set(owner.event, [...(aliases.get(owner.event) ?? []), n]);
    }
    const recording = (name: string) => {
      const names = [name, ...(aliases.get(name) ?? [])];
      const whole = names.flatMap((n) => mine.filter((r) => r.event === n && r.kind === 'event-gif').map((r) => r.file).sort());
      if (whole.length) return whole.slice(0, 1);
      return names.map((n) => mine.filter((r) => r.event === n && r.kind === 'event-segment').map((r) => r.file).sort()).find((l) => l.length) ?? [];
    };
    if (!rowsOfFile.has(p.file.path)) rowsOfFile.set(p.file.path, messageRows(p.file.path));
    const file = rowsOfFile.get(p.file.path)!;
    // A message's rows in the place's own tables: the ones its getter returns
    // for it, else the ones named after it (gValeStorm_Events), else all.
    const rowsOf = (symbol: string) => {
      const all = file.rows.get(symbol) ?? [];
      const own = file.tablesOf.get(p.scene);
      return [own ? all.filter((r) => own.has(r.table)) : [], all.filter((r) => r.table.includes(p.scene)), all].find((l) => l.length) ?? [];
    };

    // The sections: one for each event function, headed by its comment's
    // first sentence; one for each person whose table rows show a message,
    // headed by who they are, with the rows of a person an event function
    // already talks for added to its section; one for each kind of thing
    // searched.
    type Item = { label: string; gifs: string[]; quote: string; prose: string };
    // Each event is a section headed by its own name, the one thing about it
    // that is unique and searchable: an EventScript_ function, or the message a
    // table row shows. heading is the sentence that says what it is, shown
    // under the name.
    type Section = { name: string; heading: string; unused: boolean; order: number; items: Item[]; link: string; symbols: string[] };
    const sections: Section[] = [];
    const actorOf = (trigger: string) => trigger.match(/^(?:talk|[\w ]+? on) (\w+)=/)?.[1] ?? trigger.match(/^(?:talk|[\w ]+? on) (\d+)$/)?.[1];
    const labelOf = (trigger: string) => {
      const ability = trigger.match(/^([\w ]+?) on /)?.[1];
      return ability ? ability.replace(/\b[a-z]/g, (c) => c.toUpperCase()) : '';
    };
    const symbolsOf = (e: StoryEvent) => e.messages.map((n) => words2.symbol.get(n)).filter((s): s is string => !!s);
    const fn = (name: string) => p.file.decls.find((d) => d.kind === 'function' && d.name === name);
    // An event function's heading: its comment's first sentence, a map's
    // symbol in it as the map's page title, without the parentheses that
    // hold code names, and short of a colon or semicolon (`Searching the well
    // in Kalay: the party peers in, and it is very clean.`), a quotation, or
    // the clause that names code. When only a colon cut it, the rest opens
    // the prose; when more did, the prose gives the whole sentence.
    const wordsIn = (t: string) => t.replace(/^(?:In|On|At) [^,]{3,60}(?:, |$)/, '').split(' ').filter(Boolean).length;
    const headingOf = (doc: string) => {
      const unused = /^Unused:\s*/.test(doc);
      const text = doc.replace(/^Unused:\s*/, '');
      const first = text.split(/(?<=(?<!\b(?:Mt|Mr|Mrs|Ms|Dr|St))[.!?])\s/)[0];
      const after = text.slice(first.length).trim();
      const plain = first
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[.!?]$/, '');
      let heading = plain.replace(/`([A-Z][A-Za-z0-9]*)`/g, (m, n: string) => (sceneIds.has(n) ? words(n) : m)).replace(/\s*\([^()]*\)/g, '');
      let rest = '';
      let colon = heading.search(/[:;]\s/);
      // Before the colon may be only where and when (`In Imil, until Saturos
      // is beaten at Mercury Lighthouse: the freezing young man sneezes…`):
      // then what happens is after it.
      const setting = (t: string) => t.split(', ').every((c) => /^(?:in|on|at|until|once|after|before|while|when|during|from|for|then)\b/i.test(c));
      let onlyColon = false;
      if (colon > 0 && setting(heading.slice(0, colon))) {
        heading = heading.slice(colon + 1).trim();
        colon = heading.search(/[:;]\s/);
      }
      if (colon > 0 && wordsIn(heading.slice(0, colon)) >= 2) {
        rest = heading.slice(colon + 1).trim();
        heading = heading.slice(0, colon);
        onlyColon = true;
      }
      const quote = heading.search(/\s\(?["“]/);
      if (quote > 0 && wordsIn(heading.slice(0, quote)) >= 3) heading = heading.slice(0, quote);
      const cutAtCode = () => {
        const code = heading.indexOf('`');
        if (code < 0) return;
        const before = heading.slice(0, code);
        const at = Math.max(before.lastIndexOf(', '), before.lastIndexOf(' ('));
        if (at > 0 && wordsIn(before.slice(0, at)) >= 3) heading = before.slice(0, at);
      };
      cutAtCode();
      // What is left names code only through a preposition (`at the door of
      // VALE_STORM_TO_VALE_INTERIORS_SHOPS_SOUTH`): the phrase goes.
      heading = heading.replace(/ (?:of|to|from|at|by|in|into|onto|with|for|on) `[^`]+`(?:'s)?/g, '');
      cutAtCode();
      heading = heading.replace(/,? ?`[^`]+`,?/g, '');
      heading = heading.replace(/[,;:]$/, '').trim();
      const whole = heading === plain || (onlyColon && `${heading}${plain.slice(heading.length, heading.length + 2)}${rest}` === plain);
      const prose = (whole ? [rest && rest.charAt(0).toUpperCase() + rest.slice(1) + '.', after] : [first.trim(), after]).filter(Boolean).join(' ');
      return { unused, heading: heading.charAt(0).toUpperCase() + heading.slice(1), prose };
    };
    const sectionFor = (d: Decl, order: number, messages: string[]) => {
      const h = headingOf(d.doc);
      const s: Section = { name: d.name, heading: h.heading, unused: h.unused, order, items: [], link: `[\`${basename(p.file.path)}\`, line ${d.line}](${index2.get(d.name)?.url ?? `${github}/${p.file.path}#L${d.line}`})`, symbols: messages.slice(0, 1) };
      const quote = passage(messages, words2.pages);
      const gifs = recording(d.name);
      const prose = linkNames(h.prose, 'tbs', d.name);
      if (quote || gifs.length || prose) s.items.push({ label: '', gifs, quote, prose });
      sections.push(s);
      return s;
    };
    const ordered = [...events].sort((a, b) => a.order - b.order || a.index - b.index);
    for (const e of ordered.filter((e) => !e.event.startsWith('Msg'))) {
      const d = fn(e.event);
      if (!d?.doc) {
        console.log(`  ${p.slug}: ${e.event} has no comment to head it`);
        continue;
      }
      sectionFor(d, e.order, symbolsOf(e));
    }
    // A row that shows a message rather than calling an event function is
    // headed by the message's name; who says it, or what is searched, is its
    // sentence, with the ability that reaches it (Mind Read) after.
    for (const e of ordered.filter((e) => e.event.startsWith('Msg'))) {
      const rows = rowsOf(e.event);
      const who = actorOf(e.trigger);
      // A message that rows for several actors show (the rocks that cannot be
      // moved) is one section, the first that shows it.
      if (sections.some((x) => x.name === e.event || x.symbols.includes(e.event))) continue;
      const about = who
        ? /^\d+$/.test(who)
          ? `Someone in ${p.title}`
          : actorHeading(who, actor(p.file.path, who))
        : /^search /.test(e.trigger)
          ? `Searching ${searched(rows[0])}`
          : (console.log(`  ${p.slug}: ${e.event} (${e.trigger}) has nothing to head it`), '');
      if (!about) continue;
      const label = labelOf(e.trigger);
      const row = rows[0];
      sections.push({
        name: e.event,
        heading: label ? `${about}, by ${label}` : about,
        unused: false,
        order: e.order,
        items: [{ label: '', gifs: recording(e.event), quote: passage([e.event], words2.pages), prose: '' }],
        link: row ? `[\`${row.table}\`](${github}/${p.file.path}#L${row.line})` : `[${basename(p.file.path)}](${pageOf(p.file.path)})`,
        symbols: [e.event],
      });
    }
    // Events the game never plays: functions whose comment opens with
    // "Unused:" and names this place (or any, when the overlay is this place
    // alone), which the story index cannot reach.
    const named = new RegExp(`\\b${p.scene}\\b|\\b${p.title}\\b`);
    for (const d of p.file.decls)
      if (d.kind === 'function' && /^Unused:/.test(d.doc) && !events.some((e) => e.event === d.name) && (alone || named.test(d.doc))) sectionFor(d, Infinity, []);

    // A clause most headings open with ("In Vale on the stormy night, "), the
    // place as the comments name it, says nothing on the place's own page.
    const openings = new Map<string, number>();
    for (const s of sections) {
      const m = s.heading.match(/^((?:In|On|At) [^,]{3,60}, )/);
      if (m) openings.set(m[1], (openings.get(m[1]) ?? 0) + 1);
    }
    for (const [opening, n] of openings)
      if (n >= 3)
        for (const s of sections)
          if (s.heading.startsWith(opening) && s.heading.length > opening.length + 10) {
            const rest = s.heading.slice(opening.length);
            s.heading = rest.charAt(0).toUpperCase() + rest.slice(1);
          }
    if (sections.length) {
      body.push('## Events');
      for (const s of [...sections].sort((a, b) => a.order - b.order)) {
        const sentence = /[.!?]$/.test(s.heading) ? s.heading : `${s.heading}.`;
        const parts = [`### \`${s.name}\`${s.unused ? ' (unused)' : ''}`, sentence];
        const alt = s.heading.replace(/[`[\]\\]/g, '');
        for (const item of s.items) {
          if (item.label) parts.push(`*${item.label}*`);
          for (const g of item.gifs) parts.push(`![${alt}${item.label ? `, ${item.label}` : ''}, as it plays](/places/${g})`);
          if (item.quote) parts.push(item.quote);
          if (item.prose) parts.push(item.prose);
        }
        parts.push(`<small>In ${s.link}</small>`);
        body.push(parts.join('\n\n'));
      }
    }
    body.push(`Its code is in [\`${basename(p.file.path)}\`](${pageOf(p.file.path)}).`);
    const description = placeSentence(block ?? (alone ? p.file.doc : undefined)) || (area && area !== p.title ? placeSentence(placeBlock(p.file.doc, '\0', [area])) : '');
    page(`${GUIDE}/tbs/places/${p.slug}.md`, { title: p.title, description, source: p.file.path }, body.join('\n\n'));
  }
  return out;
}

// A map's story moment, from its index row's variant: a way the place looks
// (`cursed`, `cured`), or the moment's name and the flags it set
// (`vale-storm-saw-river-rescue: FLAG_VALE_STORM_SENT_TO_PLAZA, ...`). The
// caption is the name read as English: the words it shares with the scene's
// own name dropped, a verb turned into "after ...", proper nouns capitalized
// as the game's text writes them (`after the river rescue`, `after Garet
// joined`, `after the first switch was flipped`). order is how many flags
// the moment had set, so the moments follow the story.
const STATES = new Set(['cursed', 'cured']);
const ACTIVE = new Set(['fell', 'joined', 'left', 'came', 'spoke', 'reached', 'met', 'heard', 'entered', 'opened', 'decided', 'escaped', 'rejoined', 'reported', 'agreed', 'returned', 'seek']);
const PASSIVE = new Set(['bagged', 'moved', 'cleared', 'uncovered', 'flipped', 'lowered', 'defeated', 'beaten', 'caught', 'rescued', 'saved', 'placed', 'pushed', 'sunk', 'jailed', 'carried', 'told', 'activated', 'hidden', 'approached', 'read', 'repelled', 'confronted', 'seen', 'shown', 'asked', 'rewarded', 'greeted', 'reopened', 'trapped', 'held', 'given', 'explained', 'witnessed', 'planned']);
const PERFECT = new Set(['fallen']);
const ADJECTIVES = new Set(['open', 'over', 'shining', 'in', 'one', 'on']);
// A moment named for the nth time something happened (the mine's second
// drain, Bane's last escape).
const ORDINALS = new Set(['first', 'second', 'third', 'fourth', 'last']);
const EVENTS = new Set(['drain', 'escape', 'path']);
let proper: { words: Set<string>; pairs: Set<string> } | undefined;
function names() {
  if (!proper) {
    // A word the catalog writes capitalized inside a sentence and never in
    // lower case, the playable characters, whom it mostly prints by code, and
    // the pairs it writes capitalized together (Venus Lighthouse).
    const all = [...text('games/tbs/text/en.po').matchAll(/msgstr ((?:"(?:[^"\\]|\\.)*"\n?)+)/g)].map((m) => m[1].replace(/"\n?"/g, '').replace(/\{[^}]*\}/g, ' ')).join(' ');
    const lower = new Set([...all.matchAll(/\b([a-z]+)\b/g)].map((m) => m[1]));
    const words = new Set([...all.matchAll(/[a-z,] ([A-Z][a-z]+)\b/g)].map((m) => m[1].toLowerCase()).filter((w) => !lower.has(w)));
    for (const m of text('games/tbs/include/game/character_ids.h').matchAll(/^#define ([A-Z]+) \d+\b/gm)) words.add(m[1].toLowerCase());
    const pairs = new Set([...all.matchAll(/\b(?=([A-Z][a-z]+\.? [A-Z][a-z]+)\b)/g)].map((m) => m[1].replace('.', '').toLowerCase()));
    proper = { words, pairs };
  }
  return proper;
}
const properNoun = (word: string) => names().words.has(word);
function moment(variant: string, scene: string): { caption: string; order: number } {
  if (!variant) return { caption: '', order: -1 };
  const [name, flags = ''] = variant.split(/: (.*)/);
  const order = flags.split(';')[0].split(',').filter((f) => f.trim()).length;
  if (STATES.has(name)) return { caption: name, order };
  const verb = (w: string) => ACTIVE.has(w) || PASSIVE.has(w) || PERFECT.has(w) || ADJECTIVES.has(w);
  // The words the moment shares with the scene's name (vale-storm-garet-joined
  // in vale-storm) say nothing on its page, unless the last of them is who
  // acts (tret-defeated in tret-tree). A single letter names one of a pair
  // (pillar A, pillar B).
  let words = name.split('-');
  const own = scene.split('_')[0].split('-');
  let shared = 0;
  while (shared < own.length && shared < words.length - 1 && words[shared] === own[shared]) shared++;
  if (shared && verb(words[shared]) && !words.slice(shared + 1).some(verb)) shared--;
  words = words.slice(shared);
  const cap = (w: string, i: number, ws: string[]) =>
    properNoun(w) || (i > 0 && names().pairs.has(`${ws[i - 1]} ${w}`) && properNoun(ws[i - 1])) || w.length === 1 ? w.charAt(0).toUpperCase() + w.slice(1) : w;
  const phrase = (ws: string[]) => ws.map(cap).join(' ').replace(/(^|[^e]) party\b/, '$1 the party').trim();
  const the = (ws: string[]) => (ws.length && properNoun(ws[0]) ? phrase(ws) : `the ${phrase(ws)}`);
  const at = words.findIndex((w, i) => i > 0 && verb(w));
  const last = words.length - 1;
  let caption: string;
  if (words[0] === 'saw') caption = `after ${the(words.slice(1))}`;
  else if (words[0] === 'party') caption = `after the ${phrase(words)}`;
  else if (words[0] === 'at') caption = `at ${the(words.slice(1))}`;
  else if (EVENTS.has(words[last]) && ORDINALS.has(words[last - 1])) {
    const who = words.slice(0, last - 1);
    caption = `after ${who.length === 1 && properNoun(who[0]) ? `${phrase(who)}'s` : 'the'} ${words[last - 1]} ${words[last]}`;
  } else if (at > 0) {
    const subject = words.slice(0, at);
    const rest = words.slice(at);
    const plural = /[^s]s$/.test(subject[subject.length - 1]) && !properNoun(subject[subject.length - 1]);
    const be = PERFECT.has(rest[0]) ? 'had' : plural ? 'were' : 'was';
    caption = ACTIVE.has(rest[0]) ? `after ${the(subject)} ${phrase(rest)}` : `after ${the(subject)} ${be} ${phrase(rest)}`;
  } else if (ACTIVE.has(words[0])) caption = `after the party ${phrase(words)}`;
  else if (words.length === 1 && words[0].endsWith('ing')) caption = `while ${words[0]}`;
  else caption = words.length === 1 && words[0] === 'storm' ? 'during the storm' : `with ${the(words)}`;
  return { caption, order };
}

// ---------------------------------------------------------------------------
// Alchemy's tables and enums, as the recordings and the places read them.

type Row = Record<string, string>;

function tsv(path: string): Row[] {
  const file = join(repo, path);
  if (!existsSync(file)) return [];
  const [head, ...lines] = readFileSync(file, 'utf8').replace(/\n+$/, '').split('\n');
  const keys = head.split('\t').map((k) => k.split(':')[0]);
  return lines.map((l) => Object.fromEntries(l.split('\t').map((v, i) => [keys[i], v])));
}

const int = (v: string | undefined) => Number(v ?? 0) || 0;
const text = (path: string) => (existsSync(join(repo, path)) ? readFileSync(join(repo, path), 'utf8') : '');

// An enum's members and their values, from the parsed C.
function enumOf(name: string) {
  const d = where.get('tbs')!.get(name)?.decl;
  const out: { name: string; value: number; doc: string }[] = [];
  if (!d || d.kind !== 'enum') return out;
  let next = 0;
  for (const f of d.fields) {
    const given = f.type ? Number(f.type) : NaN;
    const value = Number.isNaN(given) ? (out.find((e) => e.name === f.type)?.value ?? next) : given;
    out.push({ name: f.name, value, doc: f.doc });
    next = value + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The Unused page: what the game keeps but never reaches, each thing in a
// section of its own made from its own comment. The source marks it in four
// ways: a comment that says `Unused:` above a declaration, inside a table (a
// row no lookup reaches) or in a file's summary (a map nothing leads to); a
// function declared UNUSED; and a name that carries Unused after its prefix.
// The sections are grouped by the folder guide that explains their code, in
// the guide's order, and each follows the source's order. The page opens
// with the glossary's entry for the word, and the first recording of an
// unused event.

function unusedPage(files: SourceFile[], root: Placed) {
  const node = placed.get('games/tbs/unused');
  if (!node) return;
  const index = where.get('tbs')!;
  type Item = { name: string; folder: string; text: string; link: string; gif?: string };
  const items: Item[] = [];
  const seen = new Set<string>();
  const folderOf2 = (path: string) => path.match(/^games\/tbs\/(?:src|include(?:\/unit)?)\/([^/.]+)\//)?.[1] ?? '';
  const lineLink = (f: SourceFile, line: number) => `<small>In [\`${basename(f.path)}\`, line ${line}](${github}/${f.path}#L${line})</small>`;
  const add = (f: SourceFile, name: string, text: string, link: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    items.push({ name, folder: folderOf2(f.path), text: linkNames(text, 'tbs', name.replace(/,.*$/, '')), link });
  };
  const declItem = (f: SourceFile, d: Decl) => {
    const at = index.get(d.name);
    add(at?.file ?? f, d.name, d.doc, `<small>In [\`${basename((at?.file ?? f).path)}\`, line ${(at?.decl ?? d).line}](${at?.url ?? urlOf(f, d)})</small>`);
  };
  for (const f of files) {
    const lines = readFileSync(join(repo, f.path), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*\/\//.test(lines[i])) continue;
      let j = i;
      while (j + 1 < lines.length && /^\s*\/\//.test(lines[j + 1])) j++;
      const block = lines.slice(i, j + 1);
      const start = i + 1;
      i = j;
      if (!block.some((l) => /\bUnused:/.test(l))) continue;
      if (block.some((l) => /^\s*\/\/\/\s*@file/.test(l))) {
        const para = f.doc.split(/\n\n/).find((x) => /\bUnused:/.test(x));
        if (para) add(f, basename(f.path), para, `<small>In [\`${basename(f.path)}\`](${pageOf(f.path)})</small>`);
        continue;
      }
      const owner = f.decls.find((d) => !d.anon && d.line === j + 2 && d.doc);
      if (owner) {
        declItem(f, owner);
        continue;
      }
      const around = f.decls.filter((d) => !d.anon && d.line <= start && start < d.line + d.lines).pop();
      const text = codeDeclared(md(block.map((l) => l.replace(/^\s*\/\/\/?<?\s?/, '')).join('\n')), 'tbs');
      add(f, around ? `${around.name}, line ${start}` : `${basename(f.path)}, line ${start}`, text, lineLink(f, start));
    }
  }
  for (const f of files)
    for (const d of f.decls) {
      if (d.anon || index.get(d.name)?.decl !== d) continue;
      if ((d.kind === 'function' && /\bUNUSED\b/.test(d.signature)) || /(?:^|_)Unused[A-Z]/.test(d.name)) declItem(f, d);
    }

  // An unused event's recording, made in its map: an event that is unused
  // as a whole, not one that plays but for a branch.
  const renders = placeRenders();
  for (const it of items) if (/^Unused:/.test(it.text) || /(?:^|_)Unused[A-Z]/.test(it.name)) it.gif = renders.find((r) => r.kind === 'event-gif' && r.event === it.name && stored.has(`places/${r.file}`))?.file;

  // The folders in the guide's order.
  const walkTree = (n: Placed): Placed[] => [n, ...n.children.flatMap(walkTree)];
  const order = walkTree(root).map((n) => n.key);
  const guide = (folder: string) => `games/tbs/src/${folder}/README.md`;
  const rank = (folder: string) => (order.includes(guide(folder)) ? order.indexOf(guide(folder)) : order.length);
  const folders = [...new Set(items.map((it) => it.folder))].sort((a, b) => rank(a) - rank(b));

  // The opening: the glossary's entry, but for its pointer here.
  const glossary = readFileSync(join(repo, 'games/tbs/glossary.md'), 'utf8');
  const entry = (glossary.match(/\n### Unused\n\n([\s\S]*?)(?=\n### |\n## |(?![\s\S]))/)?.[1] ?? '')
    .replace(/\s*\[[^\]]*\]\([^)]*unused[^)]*\) collects them\./i, '')
    .trim();
  const opening = items.find((it) => it.gif);
  const body: string[] = [];
  if (opening) body.push(`![\`${opening.name}\`, which the game never plays, as it would play](/places/${opening.gif})`);
  if (entry) body.push(`${linkProse(codeProse(entry, 'tbs'), 'tbs')} ([Glossary](${siteLink('games/tbs/glossary.md')}#unused))`);
  for (const folder of folders) {
    const title = headingOf(guide(folder));
    body.push(`## ${title ? `[${title}](${siteLink(guide(folder))})` : `\`${folder}\``}`);
    for (const it of items.filter((x) => x.folder === folder)) {
      const name = it.name.includes(', line ') ? `\`${it.name.replace(/, line .*$/, '')}\`, line ${it.name.replace(/^.*, line /, '')}` : `\`${it.name}\``;
      const parts = [`### ${name}`];
      if (it.gif && it !== opening) parts.push(`![\`${it.name}\`, as it would play](/places/${it.gif})`);
      if (it.text) parts.push(it.text);
      parts.push(it.link);
      body.push(parts.join('\n\n'));
    }
  }
  page(fileOf(node), { title: 'Unused', description: firstSentence(entry) }, body.join('\n\n'));
}

// ---------------------------------------------------------------------------
// Pictures a README links by relative path: an asset of the games, such as an
// effect's sheet, served from public/pictures at its path in the repository.
// Only files git tracks under a game's src or include are copied, so nothing
// from roms/ or out/ can reach the site.

const tracked = new Set(
  execFileSync('git', ['-C', repo, 'ls-files', '-z', '--', 'games'], { encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\0')
    .filter((p) => /^games\/[^/]+\/(src|include)\//.test(p)),
);
const PICTURES = join(docs, 'public/pictures');
rmSync(PICTURES, { recursive: true, force: true });

function picture(path: string): string | undefined {
  if (!tracked.has(path) || !/\.(png|gif|jpe?g|webp|svg)$/i.test(path)) return undefined;
  const to = path.replace(/^games\//, '');
  mkdirSync(dirname(join(PICTURES, to)), { recursive: true });
  copyFileSync(join(repo, path), join(PICTURES, to));
  return `/pictures/${to}`;
}

// ---------------------------------------------------------------------------

const started = Date.now();
// Everything under content/docs is made here.
rmSync(content, { recursive: true, force: true });

const all = new Map<Game, SourceFile[]>();
for (const game of GAMES) {
  const files = ROOTS.flatMap((r) => walk(`games/${game}/${r}`)).map((p) => readFile(p, game));
  all.set(game, files);
  filesOf.set(game, files);
  // The folders that once had a page per file, for the old anchors of the
  // others (dirPageWrite).
  const size = new Map<string, number>();
  for (const f of files) size.set(dirname(f.path), (size.get(dirname(f.path)) ?? 0) + f.size);
  for (const [d, s] of size) if (s > SPLIT_BYTES) split.add(d);
  // A definition with no comment takes the comment of the declaration that
  // has one (a function's prototype in its header, a table's extern), as
  // Doxygen joins a declaration's and a definition's documentation.
  const byName = new Map<string, Decl[]>();
  for (const f of files) for (const d of f.decls) if (!d.anon) byName.set(d.name, [...(byName.get(d.name) ?? []), d]);
  for (const decls of byName.values()) {
    const defs = decls.filter(isDefinition);
    const doc = decls.find((d) => !isDefinition(d) && d.doc)?.doc;
    if (doc && defs.length === 1 && !defs[0].doc && /^(function|variable)$/.test(defs[0].kind)) defs[0].doc = doc;
  }
  placeStructs(game, files);
  where.set(game, new Map());
  enumerators.set(game, new Map());
  for (const f of files) for (const d of f.decls) place(game, f, d);
  for (const f of files) for (const d of f.decls) placeEnumerators(game, f, d);
  for (const f of files) {
    f.doc = codeDeclared(f.doc, game);
    f.summary = codeDeclared(f.summary, game);
    for (const d of f.decls) {
      d.doc = codeDeclared(d.doc, game);
      for (const x of d.fields) x.doc = codeDeclared(x.doc, game);
    }
  }
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
  // The includes, found as the compilers find them: beside the file, then in
  // the folders the Makefile's INCLUDES name.
  const byPath = new Map(files.map((f) => [f.path, f]));
  const makefile = text('Makefile');
  const searched = [`games/${game}/include`, ...(makefile.match(/addprefix -Igames\/\$\(GAME\)\/include\/,([\w ]+)\)/)?.[1].trim().split(/\s+/) ?? []).map((d) => `games/${game}/include/${d}`)];
  for (const f of files) {
    const found: { file?: SourceFile; as: string }[] = [];
    for (const m of readFileSync(join(repo, f.path), 'utf8').matchAll(/^\s*#\s*include\s+["<]([^">]+)[">]/gm)) {
      const hit = [dirname(f.path), ...searched].map((d) => byPath.get(normalize(join(d, m[1])))).find(Boolean);
      if (!found.some((x) => x.as === m[1])) found.push({ file: hit, as: m[1] });
    }
    includes.set(f, found);
    for (const h of found) if (h.file) includedBy.set(h.file, [...(includedBy.get(h.file) ?? []), f]);
  }
}

// The arrangement, from Alchemy's links; the game's front page is its README
// in the source, so the story it tells stays with the code it explains.
const site = arrange();
console.log(`arrangement:\n${printTree(site).map((l) => `  ${l}`).join('\n')}`);
for (const n of notes) console.log(`  ${n}`);
arrangedPages(site, all);
recordings.load();
for (const game of GAMES) referencePages(game, all.get(game)!, placed);
// What the reach lines leave out: recordings no line names, and names or
// groups that match no row.
const orphans = recordings.get().filter((r) => !placedRecordings.has(int(r.ability)));
console.log(`recordings: ${placedRecordings.size} of ${recordings.get().length} beside their handlers`);
for (const r of orphans) console.log(`  no reach line names ${r.name} (${r.ability}, ${r.file})`);
for (const [id, at] of placedRecordings) if (at.length > 1) console.log(`  ability ${id} is shown ${at.length} times: ${at.join(', ')}`);
for (const p of reachProblems) console.log(`  ${p}`);
places(all.get('tbs')!);
unusedPage(all.get('tbs')!, site);
arrangedSidebar(site);
const failures = checkArrangement();
for (const f of failures) console.error(`content: ${f}`);
if (failures.length) process.exit(1);
console.log(`content: ${all.get('tbs')!.length} files read, ${pagesWritten.size} pages written, in ${((Date.now() - started) / 1000).toFixed(1)} s`);
