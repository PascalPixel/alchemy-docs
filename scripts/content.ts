// Builds the whole of content/docs from an Alchemy checkout: the home page
// from the README, the front page, section pages and folder guides from their
// Markdown, the sidebar from the links between them, and the source pages
// from the games' C, read with tree-sitter. Everything it writes is ignored by
// git; `bun run content` rebuilds it, and `bun run build` runs it first.
//
// A source page is a folder of one game: its files, each with its summary
// (the file's /// @file comment) and every function, macro, type, struct and
// global it declares, with their /// comments, fields and values, who calls
// them, and a link to their line on GitHub. A large folder (the scenes, the
// effect parts) gets a page per file instead. A file with no /// comment has
// no page or section of its own, only its name in its folder's file list.
// Names in comments link to their declaration within the same game, so the
// two games never cross. A handler whose comment names the abilities that
// reach it shows their recordings from public/abilities under its section.
//
// Every title is Alchemy's: a Markdown page's # heading, a source page's path
// in its game. Every description is a first sentence Alchemy wrote: a page's
// opening sentence, a file's /// @file summary.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, normalize, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Language, type Node, Parser } from 'web-tree-sitter';

const docs = fileURLToPath(new URL('..', import.meta.url));
// The Alchemy checkout it reads: ALCHEMY, or the one beside this repository.
const repo = process.env.ALCHEMY ?? join(docs, '../alchemy');
const content = join(docs, 'content/docs');
const github = 'https://github.com/PascalPixel/alchemy/blob/main';
// The Broken Seal's scenes by symbol, numbered as field/scenes.s lists them.
const sceneIds = new Map(
  [...readFileSync(join(repo, 'games/tbs/src/field/scenes.s'), 'utf8').matchAll(/^\tscene (\w*),/gm)].map((m, i) => [m[1], i] as const),
);

type Game = 'tbs' | 'tla';
// The games with pages. The Lost Age is still being decompiled: it has one
// page saying so (content/docs/tla/index.mdx) until it is done.
const GAMES: Game[] = ['tbs'];
const ROOTS = ['src', 'include'];
// A folder whose C is larger than this gets a page per file.
const SPLIT_BYTES = 200_000;

const yaml = (s: string) => JSON.stringify(s);

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

// The URL of every page written, for the redirects' check.
const pagesWritten = new Set<string>();
function page(path: string, front: Record<string, string>, body: string) {
  pagesWritten.add(`/${path.replace(/\.mdx?$/, '').replace(/(^|\/)index$/, '')}`.replace(/(.)\/$/, '$1'));
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
  lines: number; // how many lines of source it spans
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
      if (!d.name) return;
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
        add({ kind, name: tag || alias, signature: `${kind} ${tag || alias}`, doc, fields: fieldsOf(body) });
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

const rel = (path: string) => path.replace(/^games\/(tbs|tla)\//, '');
const fileSlug = (path: string) => basename(path).replace(/\.([ch])$/, '-$1');
const anchor = (name: string) => name.toLowerCase().replace(/[^a-z0-9_-]/g, '');

const split = new Set<string>(); // folders with a page per file
// Files that show no /// comment: no page or section, only a name on their
// folder's page, so a link to one goes to its code on GitHub.
const pageless = new Set<string>();
function pageOf(path: string): string {
  if (pageless.has(path)) return `${github}/${path}`;
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

// ---------------------------------------------------------------------------
// The recordings beside the code that plays them. A handler's comment names
// every ability that reaches it in its reach line (`Abilities: Gaia, Mother
// Gaia (BATTLE_FX_GAIA); none (BATTLE_FX_X).`, the form effect/README.md
// sets), and public/abilities/index.tsv holds the casts recorded from the
// game by ability id. A name is matched against actions.tsv's ability column
// and, where several rows share it, to the rows whose effect word in
// actflags.tsv dispatches to the group's effect: kind in bits 0 to 11, bit 15
// for a summon's scene, bit 14 for the effects dispatched by id range, the
// casting impacts among them at kind 100 and up. A field Psynergy group is
// matched by actions.tsv's type column. A recording made in a field scene (its
// index row names the scene) shows beside the field handler, and one made in
// battle beside the battle effect's handler.

const recordings = (() => {
  let rows: Row[] = [];
  return {
    get: () => rows,
    load: () => {
      const index = join(docs, 'public/abilities/index.tsv');
      if (!existsSync(index)) return;
      const [head, ...lines] = readFileSync(index, 'utf8').trim().split('\n');
      const keys = head.split('\t');
      rows = lines.map((l) => Object.fromEntries(l.split('\t').map((v, i) => [keys[i], v]))).filter((r) => r.file && existsSync(join(docs, 'public/abilities', r.file)));
    },
  };
})();
const placedRecordings = new Map<number, string[]>(); // ability id: the declarations showing it
const handlerOf = new Map<number, string>(); // ability id: the first handler its reach line names
const reachProblems: string[] = [];

// The enum each reach-line prefix names, and whether an ability row reaches
// one of its values.
const REACH: [string, string, (value: number, act: Row, word: number) => boolean][] = [
  ['BATTLE_FX_', 'BattleFxKind', (v, _, w) => !(w & 0xc000) && (w & 0xfff) === v],
  ['SCENE_EFFECT_', 'SceneEffectKind', (v, _, w) => !!(w & 0x8000) && (w & 0xfff) === v],
  ['CASTING_IMPACT_', 'CastingImpact', (v, _, w) => (w & 0xc000) === 0x4000 && (w & 0xfff) === v + 100],
  ['FIELD_KIND_', 'FieldKind', (v, act) => int(act.type) === v],
];

let abilityRows: { acts: Row[]; words: number[] } | undefined;
function reachedIds(d: Decl, at: string): { ids: number[]; field: number[] } {
  const para = d.doc
    .split(/\n\n/)
    .map((p) => p.replace(/\\([\\<>{}[\]*_#|~])/g, '$1').replace(/\s*\n\s*/g, ' '))
    .find((p) => p.startsWith('Abilities: '));
  if (!para) return { ids: [], field: [] };
  abilityRows ??= { acts: tsv('games/tbs/src/game/actions.tsv'), words: tsv('games/tbs/src/battle/actflags.tsv').map((r) => int(r.effect)) };
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
      if (!rows.length) reachProblems.push(`${at}: “${name}” is no ability in actions.tsv (${effect})`);
      else if (!hit.length) reachProblems.push(`${at}: no row of “${name}” (${rows.join(', ')}) reaches ${effect}`);
      (kind[0] === 'FIELD_KIND_' ? field : ids).push(...hit);
    }
  }
  return { ids, field };
}

// The recordings a declaration's reach line names, in its order, each
// captioned by the ability's name.
function recordingsOf(file: SourceFile, d: Decl): string {
  if (where.get(file.game)!.get(d.name)?.decl !== d) return '';
  const { ids, field } = reachedIds(d, `${file.path}:${d.line} ${d.name}`);
  for (const id of [...ids, ...field]) if (!handlerOf.has(id)) handlerOf.set(id, `${pageOf(file.path)}#${anchor(d.name)}`);
  const shown: string[] = [];
  const cast = (id: number, inField: boolean) => recordings.get().find((x) => int(x.ability) === id && !!x.scene === inField);
  for (const [id, inField] of [...ids.map((i) => [i, false] as const), ...field.map((i) => [i, true] as const)]) {
    const r = cast(id, inField);
    if (!r) continue;
    placedRecordings.set(id, [...(placedRecordings.get(id) ?? []), `${pageOf(file.path)}#${anchor(d.name)}`]);
    shown.push(`![${md(r.name)}](/abilities/${r.file})\\\n${md(r.name)}`);
  }
  return shown.join('\n\n');
}

function declSection(file: SourceFile, d: Decl, level: string): string {
  const parts = [`${level} ${md(d.name)}`];
  parts.push(`\`${d.signature.replace(/`/g, "'")}\``);
  if (d.doc) parts.push(linkNames(d.doc, file.game, d.name));
  const cast = recordingsOf(file, d);
  if (cast) parts.push(cast);
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

// A file's declarations by kind: those with a comment, or fields with notes,
// and the rest.
function kindsOf(file: SourceFile) {
  const seen = new Set<string>();
  return KIND_ORDER.map((kind) => {
    // A prototype whose function is defined, or documented elsewhere, adds nothing.
    const list = file.decls.filter((d) => d.kind === kind && !seen.has(d.name) && !(kind === 'prototype' && where.get(file.game)!.get(d.name)?.decl !== d));
    for (const d of list) seen.add(d.name);
    return { kind, full: list.filter(documented), bare: list.filter((d) => !documented(d)) };
  });
}

// What a file's page or section shows: its summary, then each kind's
// declarations, the names with no comment first, each linked to its line,
// then a section for each one with a comment.
function fileBody(file: SourceFile, level: string): string {
  const parts: string[] = [];
  if (file.doc) parts.push(linkNames(file.doc, file.game, ''));
  for (const { kind, full, bare } of kindsOf(file)) {
    if (!full.length && !bare.length) continue;
    parts.push(`${level} ${KIND_TITLE[kind]}`);
    if (bare.length) parts.push(bare.map((d) => `[\`${d.name}\`](${github}/${file.path}#L${d.line})`).join(', '));
    for (const d of full) parts.push(declSection(file, d, level + '#'));
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
  // A page is titled by its path in the game (src/battle, include/battle,
  // src/battle/battle/transition.c), which no other page shares.
  for (const [dir, list] of byDir) {
    const target = `${game}/source/${rel(dir)}`;
    const subdirs = [...byDir.keys()].filter((d) => dirname(d) === dir).sort();
    const own = list.filter((f) => !pageless.has(f.path));
    const head: string[] = [];
    if (subdirs.length) head.push(`## Folders\n\n${subdirs.map((d) => `- [${basename(d)}](/${game}/source/${rel(d)})`).join('\n')}`);
    // Every file by name, each linked to its page, or its section below, or,
    // with no /// comment, its code; a file page's summary beside its name.
    const link = (f: SourceFile) => (pageless.has(f.path) || split.has(dir) ? pageOf(f.path) : `#${anchor(basename(f.path))}`);
    const summary = (f: SourceFile) => (split.has(dir) && !pageless.has(f.path) && f.summary ? `: ${md(f.summary)}` : '');
    if (list.length) head.push(`## Files\n\n${list.map((f) => `- [${md(basename(f.path))}](${link(f)})${summary(f)}`).join('\n')}`);
    if (split.has(dir)) {
      page(`${target}/index.md`, { title: rel(dir), description: '', source: dir }, head.join('\n\n'));
      for (const f of own) page(`${target}/${fileSlug(f.path)}.md`, { title: rel(f.path), description: f.summary.replace(/\\/g, ''), source: f.path }, fileBody(f, '##'));
    } else {
      const body = own.map((f) => `## ${md(basename(f.path))}\n\n[${f.path}](${github}/${f.path})\n\n${fileBody(f, '###')}`);
      page(`${target}/index.md`, { title: rel(dir), description: '', source: dir }, [...head, ...body].join('\n\n'));
    }
  }
}

// ---------------------------------------------------------------------------
// The prose pages: the README, INSTALL, the front page, the section pages and
// the folder guides, without their first heading (the page's title) and with
// their repository links resolved.

// The site's arrangement comes from Alchemy's own links. README.md is the
// root; it places the games' front pages, INSTALL.md and each game's
// MATCHING.md. A game's front page places its section pages (the other
// Markdown files beside it), its places and its source. Both order what they
// place by their last link to each: a front page tells the game's story,
// mentioning its pages as it goes, and ends with the list of them. A section
// page places the folder READMEs it links, in the order it first links them,
// the first placement winning, and each folder README becomes the parent of
// its folder's source pages. Every other link is a cross-reference. A page is
// titled by its # heading and described by its first sentence (prose()).
//
// A page's URL is its parent's and then the section page's name or the
// folder's (/tbs/battle/effect), except for the few that have fixed URLs.
const SITE = 'https://alchemy.pascalpixel.com';
// Site settings: the pages with fixed URLs, by what links to them. A game's
// places are its scene list and its source its src folder.
const FIXED: [string, string][] = [
  ['README.md', '/'],
  ['INSTALL.md', '/start'],
  ['games/tbs/src/MATCHING.md', '/tbs/matching'],
  ['games/tbs/src/field/scenes.s', '/tbs/places'],
  ['games/tbs/src', '/tbs/source'],
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
    const wants = [...sectionPages(g), `games/${g}/src/field/scenes.s`, `games/${g}/src`];
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
  const title = node.kind === 'root' ? ROOT_LABEL : (headingOf(node.key) ?? headingOf(`${node.key}/README.md`) ?? (node.key.endsWith('scenes.s') ? 'Places' : node.key));
  return [`${'  '.repeat(depth)}${title}  ${node.url}`, ...node.children.flatMap((c) => printTree(c, depth + 1))];
}
function headingOf(key: string): string | undefined {
  const file = join(repo, key);
  if (!existsSync(file) || !statSync(file).isFile() || !key.endsWith('.md')) return undefined;
  return readFileSync(file, 'utf8').match(/^# (.+?)(?: \{#[\w-]+\})?\n/)?.[1];
}

// The page a link in a README goes to: the arranged page, a source page for
// C and the folders that hold it, and GitHub for anything else.
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
function prose(source: string, target: string) {
  let text = readFileSync(join(repo, source), 'utf8');
  const heading = text.match(/^# (.+?)(?: \{#[\w-]+\})?\n+/);
  const title = heading ? heading[1] : basename(source);
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
    return `[${label}](${siteLink(resolved)}${hash})`;
  });
  // MDX would read a bare < or { as markup.
  text = text
    .split(/(```[\s\S]*?```|`[^`]*`)/)
    .map((p, i) => (i % 2 ? p : p.replace(/<(?![a-z/!])/g, '&lt;').replace(/[{}]/g, (c) => `\\${c}`)))
    .join('');
  page(target, { title, description, source }, text);
}

// Where an arranged page's file goes: its URL as a path, a folder with an
// index for every page that holds others.
const fileOf = (node: Placed) => (node.kind === 'fixed' && !node.children.length && !/^games\/\w+\/src(\/field\/scenes\.s)?$/.test(node.key) ? `${node.url.slice(1)}.md` : `${node.url.slice(1) || '.'}/index.md`.replace(/^\.\//, ''));
const folderOf = (node: Placed) => dirname(fileOf(node));
const relativeTo = (from: string, to: string) => relative(from === '.' ? '' : from, to) || '.';

// Writes every arranged page from its Markdown, except the places and the
// source index, which places() and sourcePages() write.
function arrangedPages(root: Placed) {
  const walkTree = (n: Placed): Placed[] => [n, ...n.children.flatMap(walkTree)];
  for (const node of walkTree(root)) if (node.key.endsWith('.md')) prose(node.key, fileOf(node));
}

// The sidebar: a meta.json for every folder the arrangement made, listing its
// children in order. A folder README lists its folder's source pages
// (src/field, include/field and include/unit/field), which stay where their
// URLs put them.
function arrangedSidebar(root: Placed) {
  const meta = (folder: string, data: object) => write(join(content, folder, 'meta.json'), JSON.stringify(data, null, 2) + '\n');
  const pagesOf = (node: Placed) => node.children.map((c) => relativeTo(folderOf(node), fileOf(c).replace(/(\/index)?\.md$/, '')));
  meta('.', { pages: [`[${ROOT_LABEL}](/)`, ...pagesOf(root)] });
  const walkTree = (n: Placed): Placed[] => [n, ...n.children.flatMap(walkTree)];
  for (const node of walkTree(root)) {
    if (node.kind === 'game') meta(folderOf(node), { defaultOpen: true, pages: pagesOf(node) });
    if (node.kind === 'section') meta(folderOf(node), { pages: pagesOf(node) });
    if (node.kind === 'guide') {
      const [, game, , name] = node.key.split('/');
      const sources = ['src', 'include', 'include/unit'].map((r) => `${game}/source/${r}/${name}`).filter((f) => existsSync(join(content, f, 'index.md')));
      meta(folderOf(node), { pages: sources.map((f) => relativeTo(folderOf(node), f)) });
    }
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
    if (!/^https?:/.test(to) && !pagesWritten.has(to)) failures.push(`the redirect from ${r.source} leads to ${r.destination}, which the build doesn't write`);
    if (pagesWritten.has(r.source)) failures.push(`the redirect from ${r.source} hides a page the build writes`);
    if (redirects.some((s) => s.source === to)) failures.push(`the redirect from ${r.source} leads to another redirect, ${to}`);
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Finding code by what the player sees: the places, by each scene's summary.

function places(files: SourceFile[]) {
  const scenes = files.filter((f) => /^games\/tbs\/src\/scene\/[^/]+\.c$/.test(f.path));
  const pages = placePages(scenes);
  const rows = scenes.map((f) => {
    const here = pages.filter((p) => p.file === f).map((p) => `[${p.title}](/tbs/places/${p.slug})`);
    return `| [${basename(f.path, '.c')}](${pageOf(f.path)}) | ${here.join(', ')} | ${f.summary} |`;
  });
  page('tbs/places/index.md', { title: 'Places', description: 'Every place the party can walk around in, and what happens there.' }, `Each scene overlay is one place, or a few that share it, and each place has a page of its own with its map and its events. The [Scenes](${siteLink('games/tbs/src/scene/README.md')}) guide explains how a scene runs and how to find an event in it.\n\n| Scene | Places | What happens there |\n| --- | --- | --- |\n${rows.join('\n')}`);
  write(join(content, 'tbs/places/meta.json'), JSON.stringify({ title: 'Places', pages: pages.map((p) => p.slug) }, null, 2) + '\n');
}

// The English catalog's messages as the player first reads them, by symbol,
// and each number's symbol: the first page, its line breaks as spaces, the
// names it prints in place of their codes ({actor_name:n} is character n - 1,
// {protagonist_name} Isaac by default) and its other codes gone.
function firstPages() {
  const characters = [...text('games/tbs/include/game/character_ids.h').matchAll(/^#define ([A-Z]+) (\d)\b/gm)].map((m) => m[1][0] + m[1].slice(1).toLowerCase());
  const words = new Map<string, string>();
  const symbol = new Map<number, string>();
  for (const m of text('games/tbs/text/en.po').matchAll(/msgctxt "(\w+)"\nmsgid "(\d+)"\nmsgstr ((?:"(?:[^"\\]|\\.)*"\n?)+)/g)) {
    if (m[1] === 'message') continue;
    const raw = [...m[3].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]).join('').replace(/\\n/g, ' ').replace(/\\(.)/g, '$1');
    const pages = raw.split(/\{(?:page_break|end_wait|end_now)\}/).map((page) =>
      page
        .replace(/\{actor_name:(\d+)\}/g, (_, n: string) => characters[Number(n) - 1] ?? '')
        .replace(/\{protagonist_name\}/g, characters[0] ?? '')
        .replace(/\{possessive_suffix\}/g, "'s")
        .replace(/\{em_dash\}/g, '—')
        .replace(/\{[^}]*\}/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    );
    // A first page that stops mid-sentence says the message goes on.
    const shown = pages.filter(Boolean);
    words.set(m[1], (shown[0] ?? '') + (shown.length > 1 && !/[.!?…"')]$/.test(shown[0]) ? ' …' : ''));
    symbol.set(Number(m[2]), m[1]);
  }
  return { words, symbol };
}

// The rows of a scene overlay's event tables that show a message, by the
// message's symbol: each row's table, line, kind and trigger as written,
// with the rows a macro of the file writes (lunpa.c's TALK and MIND_READ);
// and the tables its event getter returns for a scene it names
// (`if (scene == (s32)&SceneId_BilibinBarricade) { return gBilibinEvents3; }`).
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
  const tables = [...source.matchAll(/struct SceneEvent\s+(\w+)\s*\[\s*\]\s*=\s*\{/g)].map((m) => ({ name: m[1], start: m.index!, end: source.indexOf('\n};', m.index!) }));
  const rows = new Map<string, MessageRow[]>();
  const add = (parts: string[], at: number) => {
    const msg = parts.length === 4 && /^(EVENT_|SEARCH\(|PSYNERGY|TOUCH_|USE_ITEM|0x[0-9a-f]+$|\d+$)/i.test(parts[0]) ? parts[3].match(/\b(Msg\w+)\b/) : null;
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
  for (const getter of source.matchAll(/struct SceneEvent\s*\*\s*\w+\s*\(\s*void\s*\)\s*\{/g)) {
    const start = getter.index! + getter[0].length;
    const body = source.slice(start, source.indexOf('\n}', start));
    for (const m of body.matchAll(/\bif\s*\(/g)) {
      let depth = 1;
      let i = m.index! + m[0].length;
      for (; i < body.length && depth; i++) depth += body[i] === '(' ? 1 : body[i] === ')' ? -1 : 0;
      const condition = body.slice(m.index! + m[0].length, i - 1);
      const table = body.slice(i).match(/^\s*\{?\s*return\s+(\w+)\s*;/)?.[1];
      if (!table || condition.includes('!=')) continue;
      for (const s of condition.matchAll(/SceneId_(\w+)/g)) tablesOf.set(s[1], new Set([...(tablesOf.get(s[1]) ?? []), table]));
    }
  }
  return { rows, tablesOf };
}

// What the player does to start an event table row, from its kind and
// trigger as written: `{EVENT_TALK, ACTOR_DORA, ...}` is talking to
// ACTOR_DORA, `PSYNERGY_ON_ACTOR(ABILITY_MIND_READ)` casting Mind Read on its
// actor, and a search names what it searches, by its SearchTarget (control
// bits 8..4).
function rowTrigger(row: MessageRow): { verb: string; target: string } | undefined {
  const title = (w: string) => w.toLowerCase().replace(/_/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
  const target = /^\d+$/.test(row.trigger) ? row.trigger : `\`${row.trigger}\``;
  const value = /^(0x[0-9a-f]+|\d+)$/i.test(row.control) ? Number(row.control) : undefined;
  const search = row.control.match(/^SEARCH\(\s*(\w+)\s*\)$/)?.[1] ?? (value !== undefined && (value & 0xf) === 3 ? enumOf('SearchTarget').find((e) => e.value === ((value >> 4) & 0x1f))?.name : undefined);
  if (search) {
    const thing = search === 'SEARCH_UNNAMED' ? 'spot' : search.replace(/^SEARCH_/, '').toLowerCase().replace(/_/g, ' ');
    return { verb: `searching ${/^[aeiou]/.test(thing) ? 'an' : 'a'} ${thing}`, target: '' };
  }
  if (row.control === 'EVENT_TALK' || (value !== undefined && (value & 0xf) === 0)) return { verb: 'talking to', target };
  const ability = row.control.match(/^PSYNERGY(?:_PHASE)?_ON_ACTOR\(\s*ABILITY_(\w+)/)?.[1];
  if (ability) return { verb: `casting ${title(ability)} on`, target };
  return undefined;
}

// The triggers of an event's rows as one phrase: "talking to `ACTOR_DORA`",
// "talking to any of actors 11 to 18", "searching a bookcase". Actors that
// follow one another (`ACTOR_FIRST_ROCK` to `ACTOR_FIRST_ROCK + 7`) are a run.
function triggerPhrase(rows: MessageRow[]): string {
  const orList = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`);
  const byVerb = new Map<string, string[]>();
  for (const t of rows.map(rowTrigger)) if (t) byVerb.set(t.verb, [...new Set([...(byVerb.get(t.verb) ?? []), t.target])]);
  return orList(
    [...byVerb].map(([verb, targets]) => {
      // Each target as a base and a count after it: `X + 2` is X and 2, an
      // actor number its number after none.
      const bases = new Map<string, number[]>();
      const others: string[] = [];
      for (const t of targets.filter(Boolean)) {
        const m = t.match(/^(?:`(\w+)(?: \+ (\d+))?`|(\d+))$/);
        if (!m) others.push(t);
        else bases.set(m[3] !== undefined ? '' : m[1], [...(bases.get(m[3] !== undefined ? '' : m[1]) ?? []), Number(m[3] ?? m[2] ?? 0)]);
      }
      const all = [...others];
      let runs = 0;
      for (const [base, counts] of bases) {
        const name = (n: number) => (base ? `\`${base}${n ? ` + ${n}` : ''}\`` : String(n));
        const sorted = [...new Set(counts)].sort((a, b) => a - b);
        const parts: string[] = [];
        for (let i = 0; i < sorted.length; ) {
          let j = i;
          while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
          if (j - i >= 2) {
            parts.push(`${name(sorted[i])} to ${name(sorted[j])}`);
            runs++;
          } else for (let k = i; k <= j; k++) parts.push(name(sorted[k]));
          i = j + 1;
        }
        all.push(base ? orList(parts) : `${sorted.length > 1 ? 'actors' : 'actor'} ${orList(parts)}`);
      }
      return all.length ? `${verb} ${runs && all.length === 1 && !/ or /.test(all[0]) ? 'any of ' : ''}${orList(all)}` : verb;
    }),
  );
}

// A page for each place: the paragraph its overlay's opening comment gives it
// (`- SceneName (scene N), ...`), or the whole comment when the overlay holds
// one place; the place's maps as the game draws them, where public/places
// has them; and the events whose comments name it, each with its recording.
// The pages follow the scene numbers, which run in story order.
type Place = { file: SourceFile; scene: string; id: number; slug: string; title: string };
function placePages(scenes: SourceFile[]): Place[] {
  const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  const words = (s: string) => s.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/([0-9])([A-Z])/g, '$1 $2');
  const out: (Place & { text: string; whole?: boolean })[] = [];
  for (const f of scenes) {
    const bullets = [...f.doc.matchAll(/^- (\w+) \(scene (\d+)\),?\s*([\s\S]*?)(?=\n- \w+ \(scene \d+\)|\n\n|(?![\s\S]))/gm)];
    if (bullets.length) {
      for (const b of bullets) out.push({ file: f, scene: b[1], id: +b[2], slug: kebab(b[1]), title: words(b[1]), text: `\`${b[1]}\` (scene ${b[2]}), ${b[3].replace(/\n\s*/g, ' ')}` });
      continue;
    }
    // An overlay whose comment lists no places: a page for each scene its
    // exit tables are for, each with the whole comment.
    const own = [...new Set([...readFileSync(join(repo, f.path), 'utf8').matchAll(/SCENE_EXITS\((\w+)\)/g)].map((m) => m[1]))];
    for (const s of own) {
      const id = sceneIds.get(s);
      if (id !== undefined) out.push({ file: f, scene: s, id, slug: kebab(s), title: words(s), text: f.doc, whole: true });
    }
  }
  out.sort((a, b) => a.id - b.id);
  // The renders, by scene number: public/places/index.tsv lists every map,
  // entrance shot and recording with the scene it was made in and the way the
  // place was drawn (cursed, cured), so a scene renamed since keeps its renders.
  const pub = join(docs, 'public/places');
  type Render = { number: number; variant: string; kind: string; event: string; messages: string; file: string };
  const renders = existsSync(join(pub, 'index.tsv'))
    ? readFileSync(join(pub, 'index.tsv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split('\t'))
        .map((r) => ({ number: +r[1], variant: r[3], kind: r[4], event: r[6], messages: r[13], file: r[14] }) as Render)
    : [];
  const catalogPages = firstPages();
  const rowsOfFile = new Map<string, ReturnType<typeof messageRows>>();
  for (const p of out) {
    const mine = renders.filter((r) => r.number === p.id && existsSync(join(pub, r.file)));
    const body: string[] = [];
    // A place that shares its overlay opens with what the overlay's comment
    // says of them all (their doors, their area name).
    const alone = out.filter((q) => q.file === p.file).length === 1;
    if (!alone && !p.whole) body.push(p.file.doc.split('\n\n')[0].replace(/\s*[^.:]*:\s*$/, ''));
    body.push(p.text);
    // The world map has no map render of its own: it is the whole world laid
    // flat, which the front page shows.
    if (p.scene === 'WorldMap') body.push('![The whole world map of The Broken Seal, laid out flat](/story/world.png)');
    // Its maps, a place drawn more than one way (Kolima Forest before and
    // after Tret lifts the curse) once for each way.
    for (const m of mine.filter((r) => r.kind === 'map').sort((a, b) => (a.variant < b.variant ? 1 : -1) || (a.file < b.file ? -1 : 1)))
      body.push(`![The whole of ${p.title}${m.variant ? `, ${m.variant},` : ''} as the game draws it](/places/${m.file})`);
    // Its events: the functions whose comments name the place, or every
    // documented function when the overlay holds this place alone, and every
    // event recorded there, by the name it was recorded under.
    const named = new RegExp(`\\b${p.scene}\\b`);
    // An event's recording: the GIF of the whole event, the first of the
    // names it was recorded under that has one, else, from renders made
    // before there was one, the GIFs of its pieces between messages.
    const recording = (names: string[]) => {
      const whole = names.flatMap((n) => mine.filter((r) => r.event === n && r.kind === 'event-gif').map((r) => r.file).sort());
      if (whole.length) return whole.slice(0, 1);
      const pieces = names.map((n) => mine.filter((r) => r.event === n && r.kind === 'event-segment').map((r) => r.file).sort()).find((l) => l.length);
      return pieces ?? [];
    };
    const recordedNames = [...new Set(mine.filter((r) => r.kind === 'event-gif' || r.kind === 'event-segment').map((r) => r.event))];
    const events = p.file.decls.filter((d) => d.kind === 'function' && d.doc && ((alone ? /^Event_|_Event|Event[A-Z]/.test(d.name) : named.test(d.doc)) || recordedNames.includes(d.name)));
    const unmatched = recordedNames.filter((n) => !events.some((d) => d.name === n));
    // The events with no function of their own are table rows that show a
    // message, recorded under the message's symbol or, before the rows were
    // named, as their table and index (`gValeStorm_Events[26]`) with the
    // messages they showed. The rest are functions renamed since.
    const shown = new Map<string, string[]>();
    const renamed: string[] = [];
    for (const n of unmatched) {
      const first = mine.find((r) => r.event === n && r.messages)?.messages.split(',')[0];
      const symbol = catalogPages.words.has(n) ? n : /^\w+\[\d+\]$/.test(n) && first ? catalogPages.symbol.get(Number(first)) : undefined;
      if (symbol) shown.set(symbol, [...(shown.get(symbol) ?? []), n]);
      else renamed.push(n);
    }
    if (!rowsOfFile.has(p.file.path)) rowsOfFile.set(p.file.path, messageRows(p.file.path));
    const messageEvents = [...shown]
      .map(([symbol, names]) => {
        // The rows of the place's own tables: the ones its getter returns for
        // it, else the ones named after it (gValeStorm_Events), else all.
        const file = rowsOfFile.get(p.file.path)!;
        const all = file.rows.get(symbol) ?? [];
        const own = file.tablesOf.get(p.scene);
        const here = [own ? all.filter((r) => own.has(r.table)) : [], all.filter((r) => r.table.includes(p.scene))].find((l) => l.length) ?? [];
        return { symbol, names: [...names].sort((a, b) => +(b === symbol) - +(a === symbol)), rows: here.length ? here : all };
      })
      .sort((a, b) => (a.rows[0]?.line ?? Infinity) - (b.rows[0]?.line ?? Infinity) || (a.symbol < b.symbol ? -1 : 1));
    if (events.length || unmatched.length) {
      body.push('## Events');
      for (const d of events) {
        // An event the game never plays opens its comment with "Unused:";
        // its heading says so, and the page gives the comment's reasons whole.
        // A first sentence runs on past an abbreviation's full stop (Mt. Aleph).
        const unused = /^Unused:\s*/.test(d.doc);
        const doc = d.doc.replace(/^Unused:\s*/, '');
        const text = unused ? doc.charAt(0).toUpperCase() + doc.slice(1) : doc.split(/(?<=(?<!\b(?:Mt|Mr|Mrs|Ms|Dr|St))[.!?])\s/)[0].replace(/\n/g, ' ');
        body.push(`### \`${d.name}\`${unused ? ' (unused)' : ''}\n\n${text} [Read the code](${pageOf(p.file.path)}#${anchor(d.name)}).`);
        for (const f of recording([d.name])) body.push(`![${d.name} as it plays](/places/${f})`);
      }
      // A message event is headed by what the player first reads, the
      // message's first page, with its symbol; then what the player does to
      // see it, from its rows in the code.
      for (const e of messageEvents) {
        const words = catalogPages.words.get(e.symbol) ?? '';
        const how = triggerPhrase(e.rows);
        const said = [how ? `${how.charAt(0).toUpperCase()}${how.slice(1)} shows it.` : '', e.rows.length ? `[Read the code](${github}/${p.file.path}#L${e.rows[0].line}).` : ''].filter(Boolean).join(' ');
        body.push(`### ${words ? `“${md(words)}” ` : ''}\`${e.symbol}\`${said ? `\n\n${said}` : ''}`);
        for (const f of recording(e.names)) body.push(`![${e.symbol} as it plays](/places/${f})`);
      }
      // Recordings of events whose functions have since been renamed.
      for (const n of renamed) {
        body.push(`### \`${n}\``);
        for (const f of recording([n])) body.push(`![${n} as it plays](/places/${f})`);
      }
    }
    body.push(`Its code is in [${basename(p.file.path)}](${pageOf(p.file.path)}).`);
    page(`tbs/places/${p.slug}.md`, { title: p.title, description: `${basename(p.file.path)}, scene ${p.id}.`, source: p.file.path }, body.join('\n\n'));
  }
  return out;
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
// The abilities' old pages: each one redirects to the handler that plays it
// (vercel.json), and the page that once held them all keeps its anchors
// (#flare) working from a frozen list, sending any other visit to the battle
// README's chapter on how an ability resolves.

function abilityAnchors() {
  const [, ...rows] = readFileSync(join(docs, 'redirects/ability-anchors.tsv'), 'utf8').trim().split('\n');
  const map = Object.fromEntries(rows.map((r) => r.split('\t')));
  const chapter = `${siteLink('games/tbs/src/battle/README.md')}#how-an-ability-resolves`;
  page('tbs/abilities/index.mdx', { title: 'Abilities' }, `<AnchorRedirect map={${JSON.stringify(map)}} fallback={${JSON.stringify(chapter)}} />\n\n[How an ability resolves](${chapter})`);
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
  // A file has a page, or a section on its folder's, only when it shows a
  // /// comment: its summary, or a declaration's or a field's.
  for (const f of files) if (!f.doc && kindsOf(f).every((k) => !k.full.length)) pageless.add(f.path);
}

// The arrangement, from Alchemy's links; the game's front page is its README
// in the source, so the story it tells stays with the code it explains.
const site = arrange();
console.log(`arrangement:\n${printTree(site).map((l) => `  ${l}`).join('\n')}`);
for (const n of notes) console.log(`  ${n}`);
arrangedPages(site);
recordings.load();
for (const game of GAMES) sourcePages(game, all.get(game)!);
// What the reach lines leave out: recordings no line names, and names or
// groups that match no row.
const orphans = recordings.get().filter((r) => !placedRecordings.has(int(r.ability)));
console.log(`recordings: ${placedRecordings.size} of ${recordings.get().length} beside their handlers`);
for (const r of orphans) console.log(`  no reach line names ${r.name} (${r.ability}, ${r.file})`);
for (const [id, at] of placedRecordings) if (at.length > 1) console.log(`  ability ${id} is shown ${at.length} times: ${at.join(', ')}`);
for (const p of reachProblems) console.log(`  ${p}`);
// The source tree's page, or, until Alchemy has its README, the game's two
// folders.
for (const game of GAMES) {
  const readme = `games/${game}/src/README.md`;
  if (existsSync(join(repo, readme))) prose(readme, `${game}/source/index.md`);
  else page(`${game}/source/index.md`, { title: `games/${game}`, source: `games/${game}` }, `## Folders\n\n${ROOTS.map((r) => `- [${r}](/${game}/source/${r})`).join('\n')}`);
}
places(all.get('tbs')!);
abilityAnchors();
arrangedSidebar(site);
const failures = checkArrangement();
for (const f of failures) console.error(`content: ${f}`);
if (failures.length) process.exit(1);
console.log(`content: ${all.get('tbs')!.length} files read, ${split.size} folders split by file, in ${((Date.now() - started) / 1000).toFixed(1)} s`);
