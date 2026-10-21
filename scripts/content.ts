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
import { basename, dirname, join, normalize } from 'node:path';
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
// matched by actions.tsv's type column, and shows no recording: the casts are
// recorded in battle, which its battle effect's handler plays.

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
function reachedIds(d: Decl, at: string): number[] {
  const para = d.doc
    .split(/\n\n/)
    .map((p) => p.replace(/\\([\\<>{}[\]*_#|~])/g, '$1').replace(/\s*\n\s*/g, ' '))
    .find((p) => p.startsWith('Abilities: '));
  if (!para) return [];
  abilityRows ??= { acts: tsv('games/tbs/src/game/actions.tsv'), words: tsv('games/tbs/src/battle/actflags.tsv').map((r) => int(r.effect)) };
  const { acts, words } = abilityRows;
  const ids: number[] = [];
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
      if (kind[0] !== 'FIELD_KIND_') ids.push(...hit);
    }
  }
  return ids;
}

// The recordings a declaration's reach line names, in its order, each
// captioned by the ability's name.
function recordingsOf(file: SourceFile, d: Decl): string {
  if (where.get(file.game)!.get(d.name)?.decl !== d) return '';
  const ids = reachedIds(d, `${file.path}:${d.line} ${d.name}`);
  const shown: string[] = [];
  for (const id of ids) {
    const r = recordings.get().find((x) => int(x.ability) === id);
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

// The guides: each folder README and where its page sits. The Lost Age's
// READMEs head themselves "The Lost Age: battle" to stay unique in the
// repository; on the site they would sit under their game.
const GUIDES: [string, string][] = [
  ['games/tbs/src/field', 'tbs/world/field'],
  ['games/tbs/src/object', 'tbs/world/objects'],
  ['games/tbs/src/scene', 'tbs/world/scenes'],
  ['games/tbs/src/map', 'tbs/world/maps'],
  ['games/tbs/src/battle', 'tbs/battle/battles'],
  ['games/tbs/src/effect', 'tbs/battle/effects/index'],
  ['games/tbs/src/menu', 'tbs/menus/menus'],
  ['games/tbs/src/window', 'tbs/menus/windows'],
  ['games/tbs/src/shop', 'tbs/menus/shops'],
  ['games/tbs/src/game', 'tbs/game'],
  ['games/tbs/src/graphics', 'tbs/engine/graphics'],
  ['games/tbs/src/sound', 'tbs/engine/sound'],
  ['games/tbs/src/runtime', 'tbs/engine/runtime'],
  ['games/tbs/src/system', 'tbs/engine/system'],
  ['games/tbs/src/debug', 'tbs/engine/debug'],
];
// The section pages: each one a page in the game's folder, beside its README.
const SECTIONS: [string, string][] = [
  ['games/tbs/world.md', 'tbs/world/index'],
  ['games/tbs/battle.md', 'tbs/battle/index'],
  ['games/tbs/menus.md', 'tbs/menus/index'],
  ['games/tbs/engine.md', 'tbs/engine/index'],
];
// The source tree's own page, at /tbs/source: how the code is laid out.
const SOURCE_README = 'games/tbs/src/README.md';

const guideOf = new Map<string, string>();
for (const [dir, target] of GUIDES) guideOf.set(dir, `/${target.replace(/\/index$/, '')}`);

// A link in a README, pointed at the site where the site has the page.
function siteLink(path: string): string {
  const clean = normalize(path).replace(/\/$/, '');
  if (clean === 'README.md') return '/';
  if (clean === 'INSTALL.md') return '/start';
  if (clean === 'games/tbs/README.md') return '/tbs';
  if (clean === 'games/tbs/src/MATCHING.md') return '/tbs/matching';
  if (clean === SOURCE_README) return '/tbs/source';
  for (const [file, target] of SECTIONS) if (clean === file) return `/${target.replace(/\/index$/, '')}`;
  const guide = guideOf.get(dirname(clean));
  if (guide && basename(clean) === 'README.md') return guide;
  const m = clean.match(/^games\/(tbs|tla)\/((?:src|include)(?:\/.*)?)$/);
  // The source pages show C and the folders that hold it; anything else is
  // read on GitHub.
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
    if (/^[a-z]+:/.test(link) || link.startsWith('/') || !link) return all;
    const resolved = normalize(join(dirname(source), link));
    if (bang) return `![${label}](${github.replace('/blob/', '/raw/')}/${resolved}${hash})`;
    return `[${label}](${siteLink(resolved)}${hash})`;
  });
  // MDX would read a bare < or { as markup.
  text = text
    .split(/(```[\s\S]*?```|`[^`]*`)/)
    .map((p, i) => (i % 2 ? p : p.replace(/<(?![a-z/!])/g, '&lt;').replace(/[{}]/g, (c) => `\\${c}`)))
    .join('');
  page(target, { title, description, source }, text);
}

function guides() {
  for (const [dir, target] of GUIDES) if (existsSync(join(repo, dir, 'README.md'))) prose(`${dir}/README.md`, `${target}.md`);
  prose('games/tbs/src/MATCHING.md', 'tbs/matching.md');
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
  page('tbs/places/index.md', { title: 'Places', description: 'Every place the party can walk around in, and what happens there.' }, `Each scene overlay is one place, or a few that share it, and each place has a page of its own with its map and its events. The [Scenes](/tbs/world/scenes) guide explains how a scene runs and how to find an event in it.\n\n| Scene | Places | What happens there |\n| --- | --- | --- |\n${rows.join('\n')}`);
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
// The abilities: a page for each named row of the ability table, explaining
// what the battle does with each of its values and which effect draws it, and
// an index of them all by kind. Everything comes from Alchemy: the values from
// actions.tsv and the tables beside it, the descriptions from en.po, and what
// the values mean from the enums, the effect handler table and the formulas'
// own tables.

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
const list = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const hex = (n: number, digits: number) => `0x${n.toString(16).padStart(digits, '0')}`;

// The English catalog: every message by number, as plain text, and the
// number each named message (MsgAbilityName and the rest) starts at.
function catalog(path: string) {
  const byId = new Map<number, string>();
  const first = new Map<string, number>();
  for (const m of text(path).matchAll(/msgctxt "(\w+)"\nmsgid "(\d+)"\nmsgstr ((?:"(?:[^"\\]|\\.)*"\n?)+)/g)) {
    const raw = [...m[3].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]).join('');
    byId.set(Number(m[2]), raw.replace(/\\n/g, ' ').replace(/\\(.)/g, '$1').replace(/\{[^}]*\}/g, '').replace(/\s+/g, ' ').trim());
    if (m[1] !== 'message') first.set(m[1], Number(m[2]));
  }
  return { byId, first };
}

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

const ELEMENTS = ['Venus', 'Mercury', 'Mars', 'Jupiter'];
const elementOf = (e: number) => ELEMENTS[e] ?? 'none';

// The kinds, the low four bits of an ability's flags, in the order the index
// shows them; each picks the formula BattleTargetExec applies to a target, and
// `share` names the table its amount falls off by with distance.
const KINDS = [
  { kind: 5, slug: 'damage', title: 'Damage from power', share: 'gHpDmgTable5' },
  { kind: 3, slug: 'attacks', title: 'Attacks with added power', share: '' },
  { kind: 4, slug: 'multiplied-attacks', title: 'Multiplied attacks', share: '' },
  { kind: 6, slug: 'unleashed-damage', title: 'Unleashed damage', share: 'gHpDmgTable6' },
  { kind: 8, slug: 'summons', title: 'Summons', share: 'gHpDmgTable8' },
  { kind: 2, slug: 'effects', title: 'Effects', share: 'gHpDmgTable' },
  { kind: 10, slug: 'pp-damage', title: 'PP damage', share: 'gPpLossTable' },
  { kind: 1, slug: 'hp-healing', title: 'HP healing', share: 'gHpRecoveryTable' },
  { kind: 11, slug: 'pp-healing', title: 'PP healing', share: 'gPpRecoveryTable' },
  { kind: 7, slug: 'effect-only', title: 'Effect only', share: '' },
  { kind: 9, slug: 'no-power', title: 'No power in battle', share: '' },
  { kind: 0, slug: 'no-ability', title: 'No ability', share: '' },
  { kind: -1, slug: 'other-kinds', title: 'Other kinds', share: '' },
];

// What each added effect does, as BattleTargetExec and the battle plan apply
// it (keyed by its AbilityEffect name less ABILITY_EFFECT_), and what more a
// reader needs to know about how long it lasts.
const STAGE = 'A stage is an eighth of the stat, from half the stat at the lowest, −4, to one and a half times at the highest, +4, and the change lasts up to seven turns, ending sooner if a roll at the end of a turn says so.';
const RESIST = 'A Resistance stage adds 20 to the resistance to every element, from −4 to +4 stages, for up to seven turns.';
const STATUS = 'It lasts up to seven turns and may end sooner at the end of a turn.';
const EFFECT_TEXT: Record<string, [string, string?]> = {
  CURE_POISON: ['cures poison'],
  RESTORE: ['cures delusion, stun, sleep, a Psynergy seal and the Grim Reaper’s count, though not poison or a haunting'],
  REVIVE: ['revives a downed target with all its HP'],
  ATTACK_UP_2: ['raises the target’s Attack by two stages', STAGE],
  ATTACK_UP: ['raises the target’s Attack by one stage', STAGE],
  ATTACK_DOWN_2: ['lowers the target’s Attack by two stages', STAGE],
  ATTACK_DOWN: ['lowers the target’s Attack by one stage', STAGE],
  DEFENSE_UP_2: ['raises the target’s Defense by two stages', STAGE],
  DEFENSE_UP: ['raises the target’s Defense by one stage', STAGE],
  DEFENSE_DOWN_2: ['lowers the target’s Defense by two stages', STAGE],
  DEFENSE_DOWN: ['lowers the target’s Defense by one stage', STAGE],
  RESISTANCE_UP_2: ['raises the target’s Resistance by two stages', RESIST],
  RESISTANCE_UP: ['raises the target’s Resistance by one stage', RESIST],
  RESISTANCE_DOWN_2: ['lowers the target’s Resistance by two stages', RESIST],
  RESISTANCE_DOWN: ['lowers the target’s Resistance by one stage', RESIST],
  POISON: ['poisons the target', 'It does nothing to a target that is already poisoned.'],
  DEADLY_POISON: ['gives the target deadly poison', 'It does nothing to a target that already has it.'],
  DELUSION: ['deludes the target', STATUS],
  CONFUSION: ['confuses the target', STATUS],
  CHARM: ['charms the target', STATUS],
  STUN: ['stuns the target', STATUS],
  SLEEP: ['puts the target to sleep', `${STATUS} Damage wakes a sleeper one time in four, unless it fell asleep this turn.`],
  SEAL: ['seals the target’s Psynergy', STATUS],
  SEAL_2_TURNS: ['seals the target’s Psynergy for two turns that never end early'],
  HAUNT: ['haunts the target', 'One time in four, the evil spirit then takes a share of the haunted unit’s HP after it acts.'],
  INSTANT_DEATH: ['knocks the target out at once, in place of any damage'],
  CURSE: ['sets the Grim Reaper counting down seven turns to the target’s death', 'Each later curse brings it a turn closer.'],
  REGENERATE: ['gives the target Regenerate', 'It lasts up to seven turns.'],
  REFLECT: ['gives the target Reflect', 'It lasts up to seven turns.'],
  DRAIN_HP: ['gives the damage dealt back to the user as HP'],
  DRAIN_HALF_HP: ['gives half the damage dealt back to the user as HP'],
  DRAIN_PP: ['turns the damage into PP damage and gives the PP taken to the user', 'It misses a target with no PP.'],
  PSY_LEECH: ['gives the user a tenth of the damage as PP, as far as the target has PP and the user has room'],
  BREAK: ['undoes every raised stat stage on the target'],
  LEAVE_ONE_HP: ['brings the target down to 1 HP whenever its blow would leave more'],
  HALVE_DEFENSE: ['makes the blow count only half the target’s Defense'],
  THREATEN: ['does nothing beyond its message'],
  DEFEND: ['makes the target guard, halving the damage it takes'],
  TOTAL_DEFENSE: ['makes the target guard totally, cutting the damage it takes to a tenth'],
  FLEE: ['makes the user flee'],
  CALL_ALLY: ['calls another enemy of its kind into the battle, which for Speed Surge is the enemy splitting in two', 'It needs room among the enemy sprites and a free unit id.'],
  CALL_HELP: ['calls a random member of the enemy’s group into an empty place', 'It needs room among the enemy sprites and a free unit id.'],
  GROUND: ['makes the target lose its next action', 'It holds only a target that still has an action waiting this turn.'],
  CHALLENGE: ['challenges the target, which will not flee; on the party, no one may run'],
  SELF_DESTRUCT: ['takes the user out of the battle'],
  REVIVE_HALF: ['revives a downed target with half its HP'],
  REVIVE_80: ['revives a downed target with 80% of its HP'],
  AGILITY_DOWN: ['sets the target’s Agility stage to the lowest, −4', 'It lasts up to five turns.'],
  AGILITY_UP: ['doubles the target’s Agility', 'It lasts up to five turns.'],
  HEAL_HP_60: ['heals 60% of the target’s maximum HP'],
  HEAL_HP_30: ['heals 30% of the target’s maximum HP'],
  HEAL_PP_7: ['restores 7% of the target’s maximum PP'],
  CURE_ALL: ['cures every ailment'],
  ACT_TWICE: ['lets the target act twice in the next turn'],
};
// Effects the battle plan rolls for every target before any is hit: extra
// blows (chance in 256, blows added) and critical hits (1 in N).
const BLOWS: Record<string, [number, number]> = {
  DOUBLE_BLOW_1_IN_8: [32, 1],
  DOUBLE_BLOW_1_IN_4: [64, 1],
  DOUBLE_BLOW_60: [153, 1],
  TRIPLE_BLOW_1_IN_8: [32, 2],
  TRIPLE_BLOW_1_IN_4: [64, 2],
  TRIPLE_BLOW_60: [153, 2],
};
const CRITICALS: Record<string, number> = { CRITICAL_1_IN_64: 64, CRITICAL_1_IN_32: 32, CRITICAL_1_IN_16: 16, CRITICAL_1_IN_8: 8, CRITICAL_1_IN_4: 4 };
// How actstat.tsv stages an outcome (enum BattlePlanStaging).
const STAGED: Record<string, string> = {
  PLAN_SHOW_MESSAGES: 'its messages alone, with no animation',
  PLAN_SHOW_ATTACK: 'an attack, the user running up to strike',
  PLAN_SHOW_CAST: 'a cast',
  PLAN_SHOW_ITEM: 'an item',
  PLAN_SHOW_SUMMON: 'one of the larger summons, with the user hidden',
  PLAN_SHOW_DJINNI: 'a Djinni with no attack',
  PLAN_SHOW_FLEE: 'a unit running away',
  PLAN_SHOW_ENEMY_CAST: 'an enemy’s cast',
  PLAN_SHOW_FULL_SCREEN: 'an effect that takes the whole screen',
};

type Ability = {
  id: number;
  name: string;
  slug: string;
  url: string;
  act: Row;
  fxRow: Row;
  kind: number;
  element: number;
  effect: number;
  mode: number;
  range: number;
  pp: number;
  power: number;
  type: number;
  fx: number;
  fxFlags: number;
  status: number;
  description: string;
  group: (typeof KINDS)[number];
};

function abilities(files: SourceFile[]) {
  const g = where.get('tbs')!;
  // A name of the C, linked to its declaration where the site has it.
  const code = (name: string, label = name) => {
    const hit = g.get(name);
    return hit ? `[\`${label}\`](${hit.url})` : `\`${label}\``;
  };
  // An enum member, linked to its enum.
  const member = (enumName: string, name: string) => code(enumName, name);

  const words = catalog('games/tbs/text/en.po');
  const message = (first: string, n: number) => {
    const base = words.first.get(first);
    const s = base === undefined ? '' : (words.byId.get(base + n) ?? '');
    return s === '?' ? '' : s;
  };
  const named = (s?: string) => !!s && !/^(\?+|=|\(no name message\))$/.test(s);

  const acts = tsv('games/tbs/src/game/actions.tsv');
  const fxRows = tsv('games/tbs/src/battle/actflags.tsv');
  const statRows = tsv('games/tbs/src/battle/actstat.tsv');
  const classes = tsv('games/tbs/src/game/classes.tsv');
  const items = tsv('games/tbs/src/game/items.tsv');
  const djinnRows = tsv('games/tbs/src/game/djinn.tsv');
  const summonRows = tsv('games/tbs/src/game/summons.tsv');
  const enemyRows = tsv('games/tbs/src/game/enemies.tsv');

  const values = (name: string) => new Map(enumOf(name).map((e) => [e.name, e.value]));
  const effects = new Map(enumOf('AbilityEffect').map((e) => [e.value, e]));
  const effectValue = values('AbilityEffect');
  const fieldKinds = new Map(enumOf('FieldKind').map((e) => [e.value, e]));
  const stagings = new Map(enumOf('BattlePlanStaging').map((e) => [e.value, e]));
  const impacts = new Map(enumOf('CastingImpact').map((e) => [e.value, e]));
  const idNames = new Map(enumOf('AbilityId').map((e) => [e.value, e.name]));
  const idOf = (name: string, fallback: number) => [...idNames].find(([, n]) => n === name)?.[0] ?? fallback;
  const ATTACK = idOf('ABILITY_ATTACK', 1);
  const REVIVES = new Set(['REVIVE', 'REVIVE_HALF', 'REVIVE_80'].map((n) => effectValue.get(`ABILITY_EFFECT_${n}`)));
  const DRAINS = new Set(['DRAIN_HP', 'DRAIN_PP', 'DRAIN_HALF_HP', 'PSY_LEECH'].map((n) => effectValue.get(`ABILITY_EFFECT_${n}`)));

  // The C read as text: the functions that name each ability id, by the
  // definition each mention falls in (a function starts at the left margin),
  // and the ability numbers the battle defines for itself.
  const idUsers = new Map<string, Set<string>>();
  const defined = new Map<string, number>();
  for (const f of files) {
    if (!f.path.endsWith('.c')) continue;
    let fn = '';
    for (const line of readFileSync(join(repo, f.path), 'utf8').split('\n')) {
      const head = line.match(/^(?!typedef|struct|enum|union|static const|#|\/)[A-Za-z_][\w \t*]*?\b([A-Za-z_]\w*)\s*\([^;]*$/);
      if (head) fn = head[1];
      const def = line.match(/^#define (ABILITY_[A-Z_]+) (\d+)/);
      if (def) defined.set(def[1], Number(def[2]));
      else if (fn) for (const m of line.matchAll(/\bABILITY_[A-Z][A-Z_]*\b/g)) idUsers.set(m[0], (idUsers.get(m[0]) ?? new Set()).add(fn));
    }
  }
  const PSY_DRAIN = defined.get('ABILITY_PSY_DRAIN') ?? -1;
  const ANNIHILATION = defined.get('ABILITY_ANNIHILATION') ?? -1;

  // The effect kinds: the handler table for ordinary kinds, the scene
  // dispatcher's switch for the summons' scenes.
  const fxKind = values('BattleFxKind');
  const handlers = new Map<number, string>();
  for (const m of text('games/tbs/src/effect/effect_table.c').matchAll(/\[(BATTLE_FX_\w+) - 1\]\s*=\s*(\w+)/g)) if (fxKind.has(m[1])) handlers.set(fxKind.get(m[1])!, m[2]);
  const sceneKind = values('SceneEffectKind');
  const scenes = new Map<number, string>();
  for (const m of text('games/tbs/src/effect/parts/dispatch.c').matchAll(/case (SCENE_EFFECT_\w+):\s*(\w+)\(effect\);/g)) if (sceneKind.has(m[1])) scenes.set(sceneKind.get(m[1])!, m[2]);
  // An effect word: kind in bits 0 to 11, variant in 12 and 13, bit 14 for
  // BattleFx_DispatchByIdRange, bit 15 for BattleFx_RunSceneEffect.
  const drawing = (word: number) => {
    const kind = word & 0xfff;
    const variant = (word >> 12) & 3;
    if (word & 0x8000) return { key: `scene ${kind}`, kind, variant, how: 'scene', fn: scenes.get(kind) ?? '' };
    if (word & 0x4000) {
      if (kind >= 100 && kind <= 135) return { key: `impact ${kind}`, kind, variant, how: 'impact', fn: 'BattleFx_RunCastingImpact' };
      if (kind > 199) return { key: `range ${kind}`, kind, variant, how: 'ring', fn: 'BattleFx_RunRingAndSparkScene' };
      return { key: `range ${kind}`, kind, variant, how: 'beam', fn: 'BattleFx_RunBeamSequence' };
    }
    if (kind === 0) return { key: '', kind, variant, how: 'none', fn: '' };
    return { key: `kind ${kind}`, kind, variant, how: 'table', fn: handlers.get(kind) ?? '' };
  };

  // The base chance of each added effect, from BattleFx_GetBaseSuccessRate: a
  // positive rate is adjusted by the elements and luck, a negative one fixed.
  const baseRate = new Map<number, number>();
  let otherRate = -100;
  {
    const c = text('games/tbs/src/game/game/battle_calc.c');
    const start = c.indexOf('s32 BattleFx_GetBaseSuccessRate(');
    let pending: string[] = [];
    for (const line of (start < 0 ? '' : c.slice(start, c.indexOf('\n}\n', start))).split('\n')) {
      const k = line.match(/case (ABILITY_EFFECT_\w+) - 8:/);
      if (k) pending.push(k[1]);
      else if (/default:/.test(line)) pending.push('default');
      else {
        const r = line.match(/return (\d+);/) ?? line.match(/fixedChance = (\d+);/);
        if (!r || !pending.length) continue;
        const rate = line.includes('return') ? Number(r[1]) : -Number(r[1]);
        for (const p of pending) {
          if (p === 'default') otherRate = rate;
          else if (effectValue.has(p)) baseRate.set(effectValue.get(p)!, rate);
        }
        pending = [];
      }
    }
  }
  const rateOf = (effect: number) => baseRate.get(effect) ?? otherRate;

  // The shares by distance from the aimed target (battle_calc.s).
  const shares = new Map<string, number[]>();
  for (const m of text('games/tbs/src/battle/battle_calc.s').matchAll(/^(g\w+):\n\t\.(?:4)?byte ([\d, ]+)/gm)) shares.set(m[1], m[2].split(',').map((n) => Number(n.trim())));
  const falling = (table: string) => {
    const t = shares.get(table) ?? [];
    return t.length > 1 ? `${list(t.slice(1).map((n) => `${n}%`))} from one to ${t.length - 1} places away` : '';
  };

  // How each row is reached: the classes that teach it, the items that cast
  // or teach it, the weapons that unleash it, the Djinni and summon it is,
  // and the enemies that choose it.
  const push = <K, V>(map: Map<K, V[]>, k: K, v: V) => map.set(k, [...(map.get(k) ?? []), v]);
  const taught = new Set<number>();
  for (const c of classes) for (let i = 0; i < 16; i++) if (int(c[`ability${i}`])) taught.add(int(c[`ability${i}`]));
  const usedFrom = new Map<number, { name: string; use: number; id: number }[]>();
  const wornFrom = new Map<number, string[]>();
  const unleashedBy = new Map<number, { name: string; chance: number }[]>();
  items.forEach((it, id) => {
    if (!named(it.item)) return;
    const action = int(it.action_id);
    if (action && int(it.use_type) === 3) push(wornFrom, action, it.item);
    else if (action) push(usedFrom, action, { name: it.item, use: int(it.use_type), id });
    if (int(it.unleash_action)) push(unleashedBy, int(it.unleash_action), { name: it.item, chance: int(it.unleash_chance) * 5 });
  });
  const djinniOf = new Map<number, { name: string; row: number }>();
  djinnRows.forEach((d, row) => named(d.djinni) && djinniOf.set(int(d.ability), { name: d.djinni, row }));
  const summonOf = new Map<number, number[]>();
  for (const s of summonRows) summonOf.set(int(s.ability), [0, 1, 2, 3].map((e) => int(s[`djinn${e}`])));
  const enemiesWith = new Map<number, string[]>();
  for (const e of enemyRows) {
    if (!named(e.enemy)) continue;
    for (let i = 0; i < 8; i++) {
      const a = int(e[`action${i}`]);
      if (a && !(enemiesWith.get(a) ?? []).includes(e.enemy)) push(enemiesWith, a, e.enemy);
    }
  }

  // The casts rendered from the game (alchemy-devtools render psynergy), by
  // ability id (public/abilities/index.tsv).
  const casts = new Map<number, Row>();
  const castIndex = join(docs, 'public/abilities/index.tsv');
  if (existsSync(castIndex)) {
    const [head, ...lines] = readFileSync(castIndex, 'utf8').trim().split('\n');
    const keys = head.split('\t');
    for (const l of lines) {
      const row = Object.fromEntries(l.split('\t').map((v, i) => [keys[i], v]));
      if (row.file) casts.set(int(row.ability), row);
    }
  }

  // The named rows. A name several rows share gets its id in its address.
  const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/ +/g, '-');
  const nameCount = new Map<string, number>();
  for (const r of acts) if (named(r.ability)) nameCount.set(slugOf(r.ability), (nameCount.get(slugOf(r.ability)) ?? 0) + 1);
  const all: Ability[] = [];
  acts.forEach((act, id) => {
    if (!named(act.ability)) return;
    const base = slugOf(act.ability);
    const slug = nameCount.get(base)! > 1 ? `${base}-${id}` : base;
    const kind = int(act.flags) & 15;
    const fxRow = fxRows[id] ?? {};
    let description = message('MsgAbilityDescription', id);
    // An item's ability with no description of its own: the item's line.
    const used = usedFrom.get(id) ?? [];
    if (!description && used.length === 1) description = message('MsgItemPlainName', used[0].id);
    all.push({
      id,
      name: act.ability,
      slug,
      url: `/tbs/abilities/${slug}`,
      act,
      fxRow,
      kind,
      element: int(act.element),
      effect: int(act.effect),
      mode: int(act.target_mode),
      range: int(act.range),
      pp: int(act.pp_cost),
      power: int(act.power),
      type: int(act.type),
      fx: int(fxRow.effect),
      fxFlags: int(fxRow.flags),
      status: int(statRows[id]?.status),
      description,
      group: KINDS.find((k) => k.kind === kind) ?? KINDS[KINDS.length - 1],
    });
  });
  const nameLink = (a: Ability) => `[${md(a.name)}](${a.url})`;
  const order = (x: Ability, y: Ability) => x.element - y.element || x.id - y.id;

  // ---- Sentences shared by the pages and the index.

  const sides = (a: Ability) => (a.mode === 2 ? ['ally', 'allies'] : ['foe', 'foes']);
  const targetsShort = (a: Ability) => {
    if (a.mode === 4) return 'the user';
    if (a.mode === 0) return 'none chosen';
    if (a.mode !== 1 && a.mode !== 2) return `mode ${a.mode}`;
    const [one, many] = sides(a);
    if (a.range === 255) return `all ${many}`;
    if (a.range <= 1) return `1 ${one}`;
    return `up to ${2 * a.range - 1} ${many}`;
  };
  const targetsLong = (a: Ability) => {
    if (a.mode === 4) return 'acts on the user alone';
    if (a.mode === 0) return 'chooses no target';
    const [one, many] = sides(a);
    if (a.range === 255) return `reaches every ${one}`;
    if (a.range <= 1) return `aims at one ${one}`;
    const n = a.range - 1;
    return `aims at one ${one} and also reaches ${n === 1 ? `the ${one}` : `the ${n} ${many}`} on each side of it`;
  };
  const does = (a: Ability) => {
    const p = a.power;
    switch (a.kind) {
      case 5:
        return p ? `deals damage from its power of ${p}` : 'has a power of 0, so it deals no damage';
      case 6:
        return p ? `unleashes damage from its power of ${p}` : 'has a power of 0, so it deals no damage';
      case 3:
        return p ? `strikes a blow from the user’s Attack with ${p} power added` : 'strikes a blow from the user’s Attack';
      case 4:
        return `strikes a blow ${p / 10} times as strong as a plain attack`;
      case 8:
        return `deals damage from its power of ${p}${summonOf.has(a.id) ? ' and its targets’ maximum HP' : ''}`;
      case 2:
        return p ? `deals damage from its power of ${p} only where its effect lands` : 'does nothing but its effect';
      case 10:
        return `takes PP with a power of ${p}`;
      case 1:
        return p ? `heals HP with a power of ${p}` : 'heals no HP by its power';
      case 11:
        return p ? `restores PP with a power of ${p}` : 'restores no PP by its power';
      case 7:
        return 'applies no power, so its effect is all it does';
      case 9:
        return 'applies no power in battle';
      case 0:
        return 'applies nothing';
      default:
        return `has kind ${a.kind}, which applies no power`;
    }
  };
  const an = (s: string) => (/^[aeiou]/i.test(s) ? `an ${s}` : `a ${s}`);
  const category = (a: Ability) => {
    const e = a.element < 4 ? `${ELEMENTS[a.element]} ` : '';
    const none = a.element < 4 ? '' : ' with no element';
    if (a.id === ATTACK) return 'the plain attack';
    if (a.pp > 0 || a.id === PSY_DRAIN) return `${e}Psynergy${none}`;
    const dj = djinniOf.get(a.id);
    if (dj) return `what the ${elementOf(Math.floor(dj.row / 20))} Djinni ${md(dj.name)} does when unleashed`;
    if (summonOf.has(a.id)) return `${an(`${e}summon`)}${none}`;
    const used = usedFrom.get(a.id);
    if (used) return `what ${used.length > 1 ? 'the items' : 'the item'} ${list(used.map((u) => md(u.name)))} ${used.length > 1 ? 'do' : 'does'} when used`;
    if (unleashedBy.has(a.id)) return `${an(`${e}weapon unleash`)}${none}`;
    if (enemiesWith.has(a.id)) return `${an(`${e}enemy ability`)}${none}`;
    return `an ability${none}`;
  };
  const effectName = (a: Ability) => effects.get(a.effect)?.name.replace(/^ABILITY_EFFECT_/, '') ?? '';

  // ---- The page of one ability.

  function reached(a: Ability): string[] {
    const out: string[] = [];
    if (a.id === 0) out.push(`Ability 0 also stands for no ability at all: an item whose \`action_id\` is 0 makes its user defend instead, and a 0 in a class’s list of abilities is an empty place.`);
    if (a.id === ATTACK)
      out.push(`The Attack command plans this row, unless the attacker’s weapon unleashes (${code('RollWeaponUnleash')}); a plain attack strikes with the weapon’s element (${code('Item_GetEquippedElement')}) rather than this row’s.`);
    if (taught.has(a.id))
      out.push(`Classes teach it: it is in the lists of abilities by level that ${code('ClassDefinition')} reads from \`classes.tsv\`, and a character casts it from the Psynergy menu, whose command (\`CMD_PSYNERGY\`) carries this row’s number to ${code('BattleCommand_BuildPlan')}.`);
    const worn = wornFrom.get(a.id);
    if (worn) out.push(`Equipping ${list(worn.map((n) => `the ${md(n)}`))} teaches it for as long as ${worn.length > 1 ? 'one is' : 'it is'} worn (\`use_type\` 3 in \`items.tsv\`).`);
    const used = usedFrom.get(a.id);
    if (used) {
      const cost = (u: { name: string; use: number }) => ['', `the ${md(u.name)} is used up`, `the ${md(u.name)} may break, one time in eight`, '', `the ${md(u.name)} leaves an Empty Bottle`][u.use] ?? '';
      const costs = used.map(cost).filter(Boolean);
      out.push(`Using ${list(used.map((u) => `the ${md(u.name)}`))} in battle plans this row, the item’s \`action_id\` in \`items.tsv\`${costs.length ? `, and ${list(costs)}` : ''}.${a.element < 4 && a.power && [1, 2, 5, 6, 8, 10, 11].includes(a.kind) ? ' Cast from an item, it counts the user’s element power as 100.' : ''}`);
    }
    const weapons = unleashedBy.get(a.id);
    if (weapons) {
      const chances = [...new Set(weapons.map((w) => w.chance))];
      out.push(`${list(weapons.map((w) => `the ${md(w.name)}`)).replace(/^t/, 'T')} ${weapons.length > 1 ? 'unleash' : 'unleashes'} it in place of an attack, ${chances.length === 1 ? `${chances[0]}%` : 'a set share'} of the time plus whatever the equipment adds (${code('RollWeaponUnleash')}).`);
    }
    const dj = djinniOf.get(a.id);
    if (dj) {
      const E = elementOf(Math.floor(dj.row / 20));
      out.push(`Unleashing the Djinni ${md(dj.name)} plans it: row ${dj.row} of \`djinn.tsv\`, the ${E} Djinni number ${dj.row % 20}, names this row as its ability, and the Djinni then goes on standby.${a.element < 4 && a.mode === 1 ? ` Striking an enemy whose resistance to ${elementOf(a.element)} is its lowest may also earn the Djinn bonus, more coins and experience and a better chance of its item if it falls: the chance is the user’s ${elementOf(a.element)} power less the target’s ${elementOf(a.element)} resistance, plus 30, in percent (${code('BattleTargetExec')}).` : ''}`);
    }
    const cost = summonOf.get(a.id);
    if (cost) {
      const need = cost.map((n, e) => (n ? `${n} ${ELEMENTS[e]} ${n > 1 ? 'Djinn' : 'Djinni'}` : '')).filter(Boolean);
      out.push(`The Summon command plans it once ${list(need)} ${cost.reduce((s, n) => s + n, 0) > 1 ? 'are' : 'is'} on standby (\`summons.tsv\`), and marks ${cost.reduce((s, n) => s + n, 0) > 1 ? 'those Djinn' : 'that Djinni'} as used.`);
    }
    const foes = enemiesWith.get(a.id);
    if (foes) {
      const shown = foes.length <= 8 ? ` (${list(foes.map(md))})` : '';
      out.push(`${foes.length > 1 ? `${foes.length} enemies have` : 'One enemy has'} it among the eight actions of ${foes.length > 1 ? 'their rows' : 'its row'} in \`enemies.tsv\`${shown}, and ${foes.length > 1 ? 'choose' : 'chooses'} it by ${foes.length > 1 ? 'their' : 'its'} action strategy (${code('BattleCommand_SelectAutomatic')}).`);
    }
    const idName = idNames.get(a.id);
    if (idName) {
      const fns = [...(idUsers.get(idName) ?? [])].sort();
      out.push(`The code calls this row \`${idName}\` (${code('AbilityId')})${fns.length ? `, which ${list([...fns.slice(0, 8).map((f) => code(f)), ...(fns.length > 8 ? [`${fns.length - 8} more functions`] : [])])} ${fns.length > 1 ? 'test' : 'tests'} for` : ''}.`);
    }
    return out;
  }

  function targetsDetail(a: Ability): string {
    const s: string[] = [];
    const [one, many] = sides(a);
    if (a.mode === 0) s.push(`Its target mode is 0 (${code('TARGET_MODE_NONE')}), so no one is chosen: ${code('BattleCommand_BuildPlan')} keeps the single unit its command names as the one target.`);
    else if (a.mode === 4) s.push(`Its target mode is 4 (${code('TARGET_MODE_SELF')}), which allows the user alone, so the plan’s one target is the unit using it.`);
    else if (a.mode === 1 || a.mode === 2) {
      s.push(a.mode === 1 ? `Its target mode is 1 (${code('TARGET_MODE_FOES')}), the other side from the user: the enemies when a party member uses it, the party when an enemy does.` : `Its target mode is 2 (${code('TARGET_MODE_ALLIES')}), the user’s own side.`);
      if (a.range === 255) s.push(`Its range is 255 (${code('ABILITY_RANGE_ALL')}), which takes every ${one} on that side, each counted as if it were the one aimed at.`);
      else if (a.range <= 1) s.push(`Its range is ${a.range}, which takes the aimed ${one} alone.`);
      else s.push(`Its range is ${a.range}: the plan walks from ${a.range - 1} ${a.range > 2 ? 'places' : 'place'} before the aimed ${one} to ${a.range - 1} after it on that side, so it hits up to ${2 * a.range - 1} ${many}, and each target remembers how far it stands from the aimed one.`);
      s.push(REVIVES.has(a.effect) ? 'Downed units are kept, because its effect revives them.' : 'Downed units are passed over, and if no one is left the user defends instead.');
    } else s.push(`Its target mode is ${a.mode}, which no code tests.`);
    return s.join(' ');
  }

  function amountDetail(a: Ability): string[] {
    const p = a.power;
    const E = elementOf(a.element);
    const share = (table: string) => {
      if (a.mode !== 1 && a.mode !== 2) return '';
      if (a.range === 255) return 'Every target counts as aimed at, so each takes the full amount.';
      if (a.range <= 1) return '';
      const t = shares.get(table);
      if (!t) return '';
      const far = Math.min(a.range - 1, t.length - 1);
      const steps = t.slice(1, far + 1).map((n, i) => `${['one place', 'two places', 'three places', 'four places', 'five places'][i]} away ${n}%`);
      return `A target away from the aimed one takes a share (${code(table)}): ${list(steps)}.`;
    };
    const element = (half: boolean) =>
      a.element > 3
        ? 'It has no element, so the element changes nothing.'
        : half
          ? `The element moves the blow by a quarter of a percent for each point the user’s ${E} power is above the target’s ${E} resistance, and the same for each point below it, from half to one and a half times (${code('Battle_GetElementMultiplier')} at half strength).`
          : `The element multiplier compares the user’s ${E} power with the target’s ${E} resistance: it is 1 when they are equal and moves by half a percent for each point between them, from 0 to 2 (${code('Battle_GetElementMultiplier')}).`;
    const guard = 'A target that is defending takes half, and one behind Total Defense a tenth.';
    const powerCalc = code('Battle_CalcPsynergyPower', 'BattlePowerCalc');
    const atkCalc = code('Battle_CalcAttackDamage', 'BattleAtkCalc');
    const recovery = code('Battle_CalcRecovery', 'BattleRecoveryCalc');
    const kindName = (k: string) => member('AbilityKind', k);
    const nothing = `Its power is 0, so ${code('BattleTargetExec')} skips the amount altogether.`;
    const halve = effectName(a) === 'HALVE_DEFENSE' ? ' (only half of it, for this effect)' : '';
    const blowEnd = `A random 0 to 3 is added; ${guard.charAt(0).toLowerCase()}${guard.slice(1, -1)}, but every blow does at least 1.${(a.mode === 1 || a.mode === 2) && a.range > 1 ? ' A blow does not fall off with distance: every target takes it in full.' : ''}`;
    if (effectName(a) === 'DRAIN_PP' && a.kind !== 10)
      return [`Its kind is ${a.kind}${a.kind === 2 ? ` (${kindName('ABILITY_KIND_EFFECT')})` : ''}, but where its effect lands on a target that has PP, the effect turns it into PP damage, kind 10 (${kindName('ABILITY_KIND_PP_DAMAGE')}): ${powerCalc} multiplies the power, ${p}, by the element multiplier, and the target loses that much PP, never more than it has. ${element(false)} ${share('gPpLossTable')} ${guard} A target with no PP, or one the effect fails on, loses nothing.`];
    switch (a.kind) {
      case 5:
        if (!p) return [`Its kind is 5 (${kindName('ABILITY_KIND_DAMAGE')}), damage from power. ${nothing}`];
        return [`Its kind is 5 (${kindName('ABILITY_KIND_DAMAGE')}), damage from power. For each target, ${powerCalc} multiplies the power, ${p}, by the element multiplier. ${element(false)} ${share('gHpDmgTable5')} A random 0 to 3 is added. ${guard}`];
      case 6:
        if (!p) return [`Its kind is 6 (${kindName('ABILITY_KIND_UNLEASHED_DAMAGE')}), unleashed damage. ${nothing}`];
        return [`Its kind is 6 (${kindName('ABILITY_KIND_UNLEASHED_DAMAGE')}), unleashed damage, which works like damage from power but falls off faster, and an enemy using it is announced as unleashing it. For each target, ${powerCalc} multiplies the power, ${p}, by the element multiplier. ${element(false)} ${share('gHpDmgTable6')} A random 0 to 3 is added. ${guard}`];
      case 8: {
        const cost = summonOf.get(a.id);
        const djinn = cost ? cost.reduce((s, n) => s + n, 0) : 0;
        const extra = cost
          ? `Summoned, it first adds ${djinn * 3}% of each target’s maximum HP to its power of ${p}, ${djinn > 1 ? `3% for each of the ${djinn} Djinn it uses` : '3% for the one Djinni it uses'}, and ${powerCalc} multiplies the sum by the element multiplier.`
          : `Only the Summon command adds a share of the target’s maximum HP, so used any other way it deals its power of ${p} times the element multiplier (${powerCalc}).`;
        return [`Its kind is 8 (${kindName('ABILITY_KIND_SUMMON')}), summon damage. ${extra} ${element(false)} ${share('gHpDmgTable8')} A random 0 to 3 is added. ${guard}`];
      }
      case 3: {
        const lines = [`Its kind is 3 (${kindName('ABILITY_KIND_ATTACK')}), an attack with added power. For each target, ${atkCalc} takes the user’s Attack less the target’s Defense${halve}, never below 0, adds twice the power${p ? `, ${2 * p}` : ', here 0'}, and halves the sum. ${element(true)} ${blowEnd}`];
        if (a.id === ATTACK)
          lines.push('A plain attack also rolls for a critical hit, one chance in 32 or better with equipment that adds to the unleash rate, which adds a quarter and then the target’s level ÷ 5 + 6. It misses one time in 32, and more often when the attacker is deluded, but never misses a target that cannot move.');
        return lines;
      }
      case 4:
        return [`Its kind is 4 (${kindName('ABILITY_KIND_ATTACK_MULTIPLIED')}), a multiplied attack. For each target, ${atkCalc} works out a plain blow with no added power, half the user’s Attack less the target’s Defense${halve}, and the battle multiplies it by the power, ${p}, and divides by 10, so it strikes ${p / 10} times as hard. ${element(true)} ${blowEnd}`];
      case 2:
        if (!p) return [`Its kind is 2 (${kindName('ABILITY_KIND_EFFECT')}), an effect ability: its power counts only where its effect lands, and its power is 0, so the effect is all it does. Where the effect fails, the battle says it had no effect.`];
        return [`Its kind is 2 (${kindName('ABILITY_KIND_EFFECT')}), an effect ability: its power counts only where its effect lands. There, ${powerCalc} multiplies the power, ${p}, by the element multiplier. ${element(false)} ${share('gHpDmgTable')} ${guard} Where the effect fails, the target takes nothing and the battle says it had no effect.`];
      case 10:
        if (!p) return [`Its kind is 10 (${kindName('ABILITY_KIND_PP_DAMAGE')}), PP damage. ${nothing}`];
        return [`Its kind is 10 (${kindName('ABILITY_KIND_PP_DAMAGE')}), PP damage: each target loses PP rather than HP. ${powerCalc} multiplies the power, ${p}, by the element multiplier. ${element(false)} ${share('gPpLossTable')} ${guard}`];
      case 1:
      case 11: {
        const what = a.kind === 1 ? 'HP' : 'PP';
        const name = a.kind === 1 ? 'ABILITY_KIND_HEAL_HP' : 'ABILITY_KIND_HEAL_PP';
        if (!p) return [`Its kind is ${a.kind} (${kindName(name)}), ${what} healing. ${nothing}${a.effect ? ' Its effect does the healing instead.' : ''}`];
        const scale =
          a.element > 3
            ? `It has no element, so it heals as if that power were 100: exactly ${p}.`
            : `The healer’s ${E} power divides by 100, so a healer with 100 ${E} power heals exactly ${p}, and the most it can be is twice that. Cast from an item, the power counts as 100.`;
        return [`Its kind is ${a.kind} (${kindName(name)}), ${what} healing. For each target, ${recovery} multiplies the power, ${p}, by the healer’s power in the element divided by 100. ${scale} ${share(a.kind === 1 ? 'gHpRecoveryTable' : 'gPpRecoveryTable')} ${a.kind === 1 ? 'A random 0 to 3 is added, and no' : 'No'} target is healed past its maximum ${what}.`];
      }
      case 7:
        return [`Its kind is 7, which applies no power: ${code('BattleTargetExec')} skips the amount for kinds 0, 7 and 9, so its effect is all it does.`];
      case 9:
        return [`Its kind is 9, which applies no power in battle: ${code('BattleTargetExec')} skips the amount for kinds 0, 7 and 9. The same kind marks the field Psynergy, the items that raise a stat outside battle, Defend, Flee and the enemies’ commands (${code('AbilityKind')}).`];
      case 0:
        return [`Its kind is 0, no ability: ${code('BattleTargetExec')} applies nothing for it.`];
      default:
        return [`Its kind is ${a.kind}, which ${code('BattleTargetExec')} applies no power for.`];
    }
  }

  function effectDetail(a: Ability): string[] {
    if (!a.effect) return [];
    const e = effects.get(a.effect);
    const key = effectName(a);
    const label = e ? member('AbilityEffect', e.name) : `effect ${a.effect}`;
    const out: string[] = [];
    const blows = BLOWS[key];
    const critical = CRITICALS[key];
    const hitCheck = code('BattleFx_RollSuccess', 'BattleHitCheck');
    if (blows) {
      out.push(`Its effect is ${a.effect} (${label}), extra blows. When the action is planned, ${code('BattleCommand_BuildPlan')} makes one roll for the whole action: ${blows[0]} chances in 256 that every target is struck ${blows[1] === 1 ? 'twice' : 'three times'}, the damage multiplied by ${blows[1] + 1}. The roll also raises the effect’s variant by ${blows[1] === 1 ? 'one' : 'two'}, so the animation plays the extra ${blows[1] === 1 ? 'blow' : 'blows'}.`);
      return out;
    }
    if (critical) {
      out.push(`Its effect is ${a.effect} (${label}), a chance of a critical hit. When the action is planned, ${code('BattleCommand_BuildPlan')} rolls once, one chance in ${critical}, for a critical hit on every target, which adds half the damage again and then the target’s level ÷ 5 + 6.`);
      return out;
    }
    const [does, more] = EFFECT_TEXT[key] ?? [];
    if (!does) {
      out.push(e ? `Its effect is ${a.effect} (${label}), which no code in the battle reads, so it adds nothing.` : `Its effect is ${a.effect}, a number ${code('AbilityEffect')} gives no name: no code in the battle reads it, so it adds nothing.`);
      return out;
    }
    out.push(`Its effect is ${a.effect} (${label}): it ${does}.${more ? ` ${more}` : ''}`);
    const command = { DEFEND: 'CMD_DEFEND', TOTAL_DEFENSE: 'CMD_DEFEND2', FLEE: 'CMD_FLEE' }[key];
    if (command && enemiesWith.has(a.id)) {
      out.push(`An enemy that chooses it never plans this row: ${code('BattleCommand_SelectAutomatic')} turns an ability with this effect into the command \`${command}\`, aimed at the enemy itself.${djinniOf.has(a.id) || taught.has(a.id) || usedFrom.has(a.id) ? ' Used any other way, the effect is applied to each target as below.' : ''}`);
      if (!djinniOf.has(a.id) && !taught.has(a.id) && !usedFrom.has(a.id)) return out;
    }
    const rate = rateOf(a.effect);
    const chance: string[] = [];
    if (a.id === ANNIHILATION)
      chance.push(`Its effect is rolled when the action is planned rather than when it hits, at the full chance whatever the distance, so that the animation can show whether it landed: the plan raises the variant to 1 when it does.`);
    if (rate > 0) {
      const lead = a.element < 4 ? `adds three points for each ${elementOf(a.element)} level the user has above the target, ` : '';
      chance.push(`It takes hold at a base chance of ${rate}%: ${hitCheck} ${lead}takes off three for every two points of the target’s Luck, and adds 25 if the target is weak to it.`);
    } else if (rate < 0 && rate !== -100) chance.push(`It takes hold at a fixed ${-rate}%, which neither the elements nor Luck change (${hitCheck}).`);
    else chance.push(`It always takes hold, unless there is nothing for it to do (${hitCheck}).`);
    if (a.id !== ANNIHILATION && (a.mode === 1 || a.mode === 2) && a.range > 1 && a.range < 255 && rate > 0) {
      const t = shares.get('gHitTable') ?? [];
      const far = Math.min(a.range - 1, t.length - 1);
      if (far > 0) chance.push(`A target away from the aimed one has less of that chance (${code('gHitTable')}): ${list(t.slice(1, far + 1).map((n, i) => `${n}% of it ${['one place', 'two places', 'three places', 'four places', 'five places'][i]} away`))}.`);
    }
    if (!REVIVES.has(a.effect) && !DRAINS.has(a.effect)) chance.push('It needs a target that is still standing once the damage is done.');
    out.push(chance.join(' '));
    return out;
  }

  function useDetail(a: Ability): string {
    const flags = int(a.act.flags);
    const bits = [7, 6, 5, 4, 3, 2, 1, 0].filter((b) => flags & (1 << b));
    const battle = !!(flags & 0x80);
    const field = !!(flags & 0x40) || a.type > 0;
    const s = [
      `Its flags byte is ${a.act.flags} in hexadecimal${bits.length ? `, with bit${bits.length > 1 ? 's' : ''} ${list(bits.map(String))} set` : ''}. Bit 7 (0x80) makes it usable in battle, where the menus otherwise grey it out; bit 6 (0x40) makes it usable from the menus outside battle; and the low four bits hold its kind, ${a.kind}. ${battle && flags & 0x40 ? 'Here both are set.' : !battle && !(flags & 0x40) ? 'Here both are clear.' : `Here bit 7 is ${battle ? 'set' : 'clear'} and bit 6 is ${flags & 0x40 ? 'set' : 'clear'}.`}`,
    ];
    if (a.type) {
      const f = fieldKinds.get(a.type);
      const title = f ? f.name.replace(/^FIELD_KIND_/, '').toLowerCase().replace(/(^|_)([a-z])/g, (_, sep, c) => `${sep ? ' ' : ''}${c.toUpperCase()}`) : '';
      s.push(`Its type is ${a.type}, the field Psynergy it works as${f ? `: ${title} (${member('FieldKind', f.name)})` : ''}. The field’s Psynergy code branches on it, and the menus count any type but 0 as usable outside battle, as they do bit 6.`);
    }
    const shown = battle && field ? 'MsgUsableAnywhere' : field ? 'MsgUsableInField' : battle ? 'MsgUsableInBattle' : '';
    if (shown && message(shown, 0) && (a.pp > 0 || taught.has(a.id) || wornFrom.has(a.id))) s.push(`So a character’s status screen says “${md(message(shown, 0))}” beside it.`);
    if (a.pp > 0)
      s.push(`It costs ${a.pp} PP. A character’s cast pays them only when it goes ahead: with fewer PP left, or with Psynergy sealed, the cast fails and costs nothing (${code('BattleCommand_BuildPlan')}). Costing PP is also what makes the battle treat it as Psynergy (${code('Ability_IsPsynergy')}), which decides how its cast is staged.`);
    else if (a.id === PSY_DRAIN) s.push(`It costs no PP, yet the battle counts it as Psynergy all the same: ${code('Ability_IsPsynergy')} names it.`);
    return s.join(' ');
  }

  function drawingDetail(a: Ability): string[] {
    const d = drawing(a.fx);
    const out: string[] = [];
    const word = a.fxRow.effect ?? '0';
    const fn = d.fn && g.get(d.fn);
    if (d.how === 'none') {
      if (a.id === ATTACK)
        out.push(`A plain attack does not take its effect from this row: ${code('BattleCommand_BuildPlan')} chooses it by the attacker, effect 1 for Isaac, Garet and Jenna and 4 for Ivan and Mia, an enemy’s from its class (${code('BattleClass_GetAttackEffect')}), each with bit 14 set. So every plain attack is drawn by ${code('BattleFx_RunBeamSequence')}, and a critical hit by ${code('BattleFx_RunRingAndSparkScene')}.`);
      else out.push(`Its effect word in \`actflags.tsv\` is 0: no effect kind, so nothing is drawn over the battle for it.`);
    } else {
      if (fn) out.push(`${code(d.fn)} draws it.${fn.decl.doc ? `\n\n${linkNames(fn.decl.doc, 'tbs', d.fn)}` : ''}`);
      const parts = `Its effect word in \`actflags.tsv\` is ${word}, a halfword of 16 bits read in parts: the low twelve bits are the effect kind, ${d.kind}, and bits 12 and 13 the variant, ${d.variant}, the strength the effect draws.`;
      if (d.how === 'table') out.push(`${parts} ${code('BattleFx_RunTableEffect')} looks the kind up in ${code('gBattleFx_EffectHandlers')}, the table of ordinary effects.`);
      else if (d.how === 'scene') out.push(`${parts} Bit 15 (0x8000) is set, so ${code('BattleFx_RunSceneEffect')} plays it as one of the large scenes, scene kind ${d.kind}.`);
      else {
        const impact = impacts.get(d.kind - 100);
        const range = d.how === 'impact' ? `the casting impacts, kinds 100 to 135, and kind ${d.kind} is impact ${d.kind - 100}${impact ? `, ${member('CastingImpact', impact.name)}${impact.doc ? `, whose own animation over the target the code describes as “${impact.doc.replace(/\n+/g, ' ')}”` : ''}` : ''}` : d.how === 'ring' ? 'the ring and spark scenes, kinds 200 and up' : 'the beam sequences, kinds 136 to 199 and every kind below 100';
        out.push(`${parts} Bit 14 (0x4000) is set, so ${code('BattleFx_DispatchByIdRange')} plays it instead of the table of ordinary effects. Its kind falls among ${range}.`);
      }
      // A handler that only hands its effect to a shared runner: the
      // runner's comment says how the animation is built.
      if (fn && fn.decl.lines <= 4) {
        const runner = [...fn.decl.refs].find((r) => r !== d.fn && /^BattleFx_/.test(r) && g.get(r)?.decl.kind === 'function' && g.get(r)!.decl.doc);
        if (runner) out.push(`It hands the work to the shared runner ${code(runner)}:\n\n${linkNames(g.get(runner)!.decl.doc, 'tbs', runner)}`);
      }
      const sharing = all.filter((b) => b !== a && drawing(b.fx).key === d.key);
      if (sharing.length) out.push(`The same effect draws ${list(sharing.map((b) => `${nameLink(b)}${d.how === 'impact' ? '' : ` (variant ${drawing(b.fx).variant})`}`))}.`);
    }
    if (a.fxFlags) {
      const views = [a.fxFlags & 4 ? `the camera takes the other side’s view (${code('STAGING_VIEW_ACROSS')})` : '', a.fxFlags & 8 ? `the camera turns right round (${code('STAGING_VIEW_REVERSED')})` : ''].filter(Boolean);
      out.push(`Its staging flags in \`actflags.tsv\`, ${a.fxRow.flags}, are the upper half of the word the battle reads: ${views.length ? list(views) : 'bits no code here names'}.`);
    }
    if (a.status) {
      const st = stagings.get(a.status);
      out.push(`\`actstat.tsv\` stages it as ${st && STAGED[st.name] ? `${STAGED[st.name]} (${member('BattlePlanStaging', st.name)})` : `outcome ${a.status}`}.`);
    }
    return out;
  }

  function rowTable(a: Ability): string {
    const d = drawing(a.fx);
    const r = a.act;
    const st = stagings.get(a.status);
    const rows: [string, string, string][] = [
      ['`target_mode`', r.target_mode, { 0: 'no target chosen', 1: 'the foes', 2: 'the allies', 4: 'the user' }[a.mode] ?? 'not tested by the code'],
      ['`flags`', r.flags, `${int(r.flags) & 0x80 ? 'usable in battle' : 'not usable in battle'}, ${int(r.flags) & 0x40 ? 'usable from the menus outside battle' : 'bit 6 clear'}, kind ${a.kind}`],
      ['`element`', r.element, elementOf(a.element)],
      ['`effect`', r.effect, a.effect ? (effects.get(a.effect)?.name ?? 'not named') : 'none'],
      ['`icon`', r.icon, 'the icon the menus draw'],
      ['`range`', r.range, a.range === 255 ? 'the whole side' : a.range > 1 ? `the aimed unit and ${a.range - 1} on each side` : 'the aimed unit'],
      ['`pp_cost`', r.pp_cost, 'PP a cast pays'],
      ['`power`', r.power, 'what the kind applies'],
      ['`type`', r.type, a.type ? (fieldKinds.get(a.type)?.name ?? 'a field Psynergy') : 'no field Psynergy'],
      ['`effect` in `actflags.tsv`', a.fxRow.effect ?? '', d.how === 'none' ? 'no effect' : `kind ${d.kind}, variant ${d.variant}${d.how === 'scene' ? ', a scene' : d.how === 'table' ? '' : ', by id range'}`],
      ['`flags` in `actflags.tsv`', a.fxRow.flags ?? '', a.fxFlags ? 'camera staging' : 'none'],
      ['`status` in `actstat.tsv`', String(a.status), a.status ? (st?.name ?? 'an outcome') : 'staged by its kind'],
    ];
    return `| Column | Value | Meaning |\n| --- | --- | --- |\n${rows.map(([c, v, m]) => `| ${c} | ${v} | ${m} |`).join('\n')}`;
  }

  // The sidebar's folders: one per kind, and in a kind of more than 30
  // abilities with more than one element, one per element inside it.
  const elementSlug = (e: number) => (e < 4 ? ELEMENTS[e].toLowerCase() : 'no-element');
  const elementTitle = (e: number) => (e < 4 ? ELEMENTS[e] : 'No element');
  const groups = KINDS.map((k) => ({ ...k, list: all.filter((a) => a.group === k).sort(order) }))
    .filter((k) => k.list.length)
    .map((k) => ({ ...k, split: k.list.length > 30 && new Set(k.list.map((a) => a.element)).size > 1 }));
  const folderOf = (a: Ability) => {
    const k = groups.find((x) => x.slug === a.group.slug)!;
    return k.split ? `(${k.slug})/(${k.slug}-${elementSlug(a.element)})` : `(${k.slug})`;
  };

  for (const a of all) {
    const parts: string[] = [];
    const cast = casts.get(a.id);
    if (cast) {
      const who = cast.caster && cast.target ? `${cast.caster} casts ${a.name} at ${cast.target}` : a.name;
      parts.push(`![${who}](/abilities/${basename(cast.file)})\n\n${md(who)}, recorded from the game with a plain backdrop behind the battle.`);
    }
    const twins = all.filter((b) => b !== a && b.name === a.name);
    let intro = `${md(a.name)} is ${category(a)}${a.pp ? `, costing ${a.pp} PP` : ''}. It ${targetsLong(a)}, and ${does(a)}.`;
    const ef = EFFECT_TEXT[effectName(a)];
    if (a.effect && ef) intro += ` Its effect ${ef[0]}.`;
    if (twins.length) intro += ` It is ability ${a.id}; ${twins.length > 1 ? 'rows' : 'row'} ${list(twins.map((b) => `[${b.id}](${b.url})`))} ${twins.length > 1 ? 'have' : 'has'} the same name.`;
    parts.push(intro);
    const how = reached(a);
    if (how.length) parts.push(how.join(' '));
    const tidy = (s: string) => s.replace(/ {2,}/g, ' ').trim();
    parts.push(`## Targets\n\n${tidy(targetsDetail(a))}`);
    parts.push(`## What it does to each target\n\n${amountDetail(a).map(tidy).join('\n\n')}\n\n[How an ability resolves](/tbs/battle/battles#how-an-ability-resolves) follows the whole calculation, from the command to the damage.`);
    const effect = effectDetail(a);
    if (effect.length) parts.push(`## Its added effect\n\n${effect.map(tidy).join('\n\n')}`);
    parts.push(`## Where it can be used\n\n${tidy(useDetail(a))}`);
    parts.push(`## The animation\n\n${drawingDetail(a).join('\n\n')}`);
    parts.push(`## Its row\n\nAbility ${a.id} is row ${a.id} of the ability table, \`games/tbs/src/game/actions.tsv\` (${code('BattleAct')}), and the same row of \`actflags.tsv\` and \`actstat.tsv\` in \`games/tbs/src/battle\` says how it is staged.\n\n${rowTable(a)}`);
    page(`tbs/abilities/${folderOf(a)}/${a.slug}.md`, { title: a.name, description: a.description, source: 'games/tbs/src/game/actions.tsv' }, parts.join('\n\n'));
  }

  // ---- The index, and the sidebar: a closed folder for each kind, which
  // opens on its own pages.

  const pct = (table: string) => falling(table);
  const INTRO: Record<number, string> = {
    5: `Each target takes the power times the element multiplier, which compares the user’s power in the element with the target’s resistance to it (${code('Battle_CalcPsynergyPower', 'BattlePowerCalc')}). Targets beside the aimed one take less: ${pct('gHpDmgTable5')}.`,
    3: `A blow from the user’s Attack against the target’s Defense, with twice the power added and the element at half strength (${code('Battle_CalcAttackDamage', 'BattleAtkCalc')}). Every target takes the full blow, wherever it stands. The plain Attack is one of these.`,
    4: `A plain blow with no added power, multiplied by the power and divided by 10, so a power of 18 strikes 1.8 times as hard.`,
    6: `Damage from power, as above, which falls off faster with distance: ${pct('gHpDmgTable6')}. An enemy using one is announced as unleashing it.`,
    8: `Damage from the power plus 3% of each target’s maximum HP for every Djinni the summon uses, falling off ${pct('gHpDmgTable8')}.`,
    2: `The effect is the point. Any power is damage dealt only where the effect lands, falling off ${pct('gHpDmgTable')}.`,
    10: `Damage to PP instead of HP, falling off ${pct('gPpLossTable')}.`,
    1: `Healing from the power times the healer’s power in the element divided by 100, so an item, which counts that power as 100, heals exactly its power. Allies beside the aimed one get ${pct('gHpRecoveryTable')}.`,
    11: `Healing of PP, worked out as HP healing is and falling off ${pct('gPpRecoveryTable')}.`,
    7: 'No power is applied: the effect is all they do.',
    9: `No power is applied in battle. The field Psynergy, the items that raise a stat outside battle, Defend, Flee and the enemies’ commands are all this kind (${code('AbilityKind')}).`,
    0: 'Kind 0 is no ability: nothing is applied.',
    [-1]: 'Kinds no other ability has.',
  };
  const fnCell = (a: Ability) => {
    const d = drawing(a.fx);
    if (d.how === 'none') return a.id === ATTACK ? code('BattleFx_RunBeamSequence') : '';
    return `${d.fn ? code(d.fn) : ''}${d.how === 'impact' ? ` (impact ${d.kind - 100})` : ''}`;
  };
  const table = (list: Ability[]) =>
    `| Id | Ability | Element | PP | Power | Targets | Effect |\n| --- | --- | --- | --- | --- | --- | --- |\n${list.map((a) => `| ${a.id} | ${nameLink(a)} | ${elementOf(a.element)} | ${a.pp || ''} | ${a.power || ''} | ${targetsShort(a)} | ${fnCell(a)} |`).join('\n')}`;
  const elementsOf = (list: Ability[]) => [...new Set(list.map((a) => a.element))].sort((x, y) => x - y);
  const tables = groups.map((k) => {
    const head = `## ${k.title} [#${k.slug}]\n\n${k.kind >= 0 ? `Kind ${k.kind}. ` : ''}${INTRO[k.kind] ?? ''}`;
    if (!k.split) return `${head}\n\n${table(k.list)}`;
    return [head, ...elementsOf(k.list).map((e) => `### ${elementTitle(e)} [#${k.slug}-${elementSlug(e)}]\n\n${table(k.list.filter((a) => a.element === e))}`)].join('\n\n');
  });
  // The old single page's anchors (#flare) lead to the pages now.
  const old: Record<string, string> = {};
  for (const a of [...all].sort((x, y) => x.id - y.id)) {
    const key = a.name.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-');
    if (casts.has(a.id) && !(key in old)) old[key] = a.url;
  }
  page(
    'tbs/abilities/index.mdx',
    { title: 'Abilities', description: 'Every ability in the game, grouped by how the battle works out what it does to each target.', source: 'games/tbs/src/game/actions.tsv' },
    `<AnchorRedirect map={${JSON.stringify(old)}} />\n\nEverything a unit does on its turn is an ability: Psynergy, a Djinni’s unleash, a summon, an item used in battle, a weapon’s unleash and every enemy attack. Each one is a row of the ability table, \`games/tbs/src/game/actions.tsv\`, and its row number is its ability id. The id finds its name and description in the game’s text, and the same row of \`games/tbs/src/battle/actflags.tsv\` picks the effect that draws it.\n\nEach row also has a kind, which decides how the battle works out what the ability does to each target: whether it deals damage from its own power, adds to a weapon attack, heals HP or PP, or only causes an effect. The tables below are grouped by kind, and [how an ability resolves](/tbs/battle/battles#how-an-ability-resolves) follows the calculation from the command to the damage. The tables give each ability’s PP cost, its power, and how many it reaches: the aimed unit and, for a range above 1, the units beside it.\n\n${tables.join('\n\n')}`,
  );
  write(join(content, 'tbs/abilities/meta.json'), JSON.stringify({ title: 'Abilities', pages: groups.map((k) => `(${k.slug})`) }, null, 2) + '\n');
  // A name several rows share is listed with its id.
  const entry = (a: Ability) => (all.some((b) => b !== a && b.name === a.name) ? `[${a.name} (${a.id})](${a.url})` : a.slug);
  const folder = (path: string, title: string, anchor: string, pages: string[]) =>
    write(join(content, `tbs/abilities/${path}/meta.json`), JSON.stringify({ title, pagesIndex: `[${title}](/tbs/abilities#${anchor})`, pages }, null, 2) + '\n');
  for (const k of groups) {
    if (k.split) {
      const elements = elementsOf(k.list);
      folder(`(${k.slug})`, k.title, k.slug, elements.map((e) => `(${k.slug}-${elementSlug(e)})`));
      for (const e of elements) folder(`(${k.slug})/(${k.slug}-${elementSlug(e)})`, elementTitle(e), `${k.slug}-${elementSlug(e)}`, k.list.filter((a) => a.element === e).map(entry));
      continue;
    }
    // A smaller kind is one folder, with a separator between its elements.
    const pages: string[] = [];
    let last = -1;
    for (const a of k.list) {
      if (k.list.length > 12 && elementsOf(k.list).length > 1 && a.element !== last) pages.push(`---${elementTitle(a.element)}---`);
      last = a.element;
      pages.push(entry(a));
    }
    folder(`(${k.slug})`, k.title, k.slug, pages);
  }
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
for (const p of ['index.md', 'tbs/index.md', 'start.md', 'tbs/source', 'tla/source', 'tbs/places.md', 'tbs/places', 'tbs/abilities.md', 'tbs/abilities', 'tbs/matching.md', ...GUIDES.map(([, t]) => `${t}.md`), ...SECTIONS.map(([, t]) => `${t}.md`)]) {
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
  // A file has a page, or a section on its folder's, only when it shows a
  // /// comment: its summary, or a declaration's or a field's.
  for (const f of files) if (!f.doc && kindsOf(f).every((k) => !k.full.length)) pageless.add(f.path);
}

prose('README.md', 'index.md');
// The game's front page is its README in the source, so the story it tells
// stays with the code it explains.
prose('games/tbs/README.md', 'tbs/index.md');
prose('INSTALL.md', 'start.md');
guides();
for (const [file, target] of SECTIONS) prose(file, `${target}.md`);
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
if (existsSync(join(repo, SOURCE_README))) prose(SOURCE_README, 'tbs/source/index.md');
else page('tbs/source/index.md', { title: 'games/tbs', source: 'games/tbs' }, `## Folders\n\n${ROOTS.map((r) => `- [${r}](/tbs/source/${r})`).join('\n')}`);
places(all.get('tbs')!);
abilities(all.get('tbs')!);
pictures();
console.log(`content: ${all.get('tbs')!.length} files read, ${split.size} folders split by file, in ${((Date.now() - started) / 1000).toFixed(1)} s`);
