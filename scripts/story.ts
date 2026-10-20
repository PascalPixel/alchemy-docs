// Builds a story index of The Broken Seal from an Alchemy checkout, so that a
// writer can name places, people and events from evidence instead of guessing.
// It reads the English catalog, the scene overlays and the game's tables, and
// writes TSV files; it changes nothing in the checkout.
//
//   bun scripts/story.ts [OUT]
//
// ALCHEMY is the checkout (default: ../alchemy beside this repository); OUT,
// or STORY_OUT, the folder the tables go to (default: build/story, ignored by
// git). PLACES is a place table to take the area names from (default:
// OUT/../places/places.tsv, a row per scene with sceneNumber and areaNames);
// without one the area names are derived here, and places.tsv is written.
//
// What it writes:
//
// - messages.tsv: every English message, its symbol and text on one line, the
//   sites that show it (file, function, speaker, the flags its path tested)
//   and their places; a message with no site says why in its note.
// - flags.tsv: every game flag the code names, with who sets, clears and tests
//   it. Flags 0x200 to 0x2ff belong to one scene and 0x300 to 0x3ff to one
//   place group, so those are keyed by their scene or group.
// - events.tsv: every scene event: its trigger and table condition, the flags
//   all it does requires, the flags it tests, sets and clears, and the
//   messages it shows.
// - places.tsv (only without a place table): each scene's area name and exits.
// - glossary.tsv: the proper nouns and game terms of the text, each with its
//   kind, its name-table message, the actor constants that name it, and the
//   messages that use it.
// - beats.tsv: a first story order of the events, by their flag dependencies.
//
// How messages are found. A scene's event sets the current message
// (MESSAGE_SET) and each "show" command shows it and moves on to the next
// (MESSAGE_PUT, Event_ShowMessage, Event_AskYesNo shows three); an event table
// row can show one message itself. Each event is followed through its
// statements with the current message's possible values, each value with the
// flags its path has tested, and through the scene's own helper functions it
// calls. The C is parsed with tree-sitter, as scripts/content.ts does, after
// the English edition's #if branches are chosen.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, type Node, Parser, type Tree } from 'web-tree-sitter';

const docs = fileURLToPath(new URL('..', import.meta.url));
const repo = process.env.ALCHEMY ?? join(docs, '../alchemy');
const out = process.argv[2] ?? process.env.STORY_OUT ?? join(docs, 'build/story');
const placesTable = process.env.PLACES ?? join(out, '../places/places.tsv');
const GAME = 'games/tbs';
const gamePath = (...p: string[]) => join(repo, GAME, ...p);
const started = Date.now();

const parser = await (async () => {
  await Parser.init();
  const p = new Parser();
  p.setLanguage(await Language.load(join(docs, 'node_modules/tree-sitter-c/tree-sitter-c.wasm')));
  return p;
})();

const hex = (n: number, width = 3) => `0x${(n >>> 0).toString(16).padStart(width, '0')}`;
const msgNo = (n: number) => String(n).padStart(5, '0');
const uniq = <T>(list: T[]) => [...new Set(list)];
const sortNum = (list: number[]) => [...list].sort((a, b) => a - b);

function tsv(name: string, header: string[], rows: (string | number)[][]) {
  const cell = (v: string | number) => String(v).replace(/[\t\r\n]+/g, ' ');
  writeFileSync(join(out, name), [header, ...rows].map((r) => r.map(cell).join('\t')).join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// The English catalog: msgctxt is the symbol ("message" when unnamed), msgid
// the number, msgstr the text with its {codes}.

type Message = { id: number; symbol: string; text: string };

function readPo(path: string): Message[] {
  const list: Message[] = [];
  const unquote = (s: string) => s.slice(1, -1).replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
  let ctxt = '';
  let id = '';
  let str = '';
  let field = '';
  const flush = () => {
    if (id !== '' && /^\d+$/.test(id)) list.push({ id: Number(id), symbol: ctxt || 'message', text: str });
    ctxt = id = str = field = '';
  };
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^msgctxt\s+(".*")\s*$/))) {
      flush();
      ctxt = unquote(m[1]);
      field = 'ctxt';
    } else if ((m = line.match(/^msgid\s+(".*")\s*$/))) {
      if (field !== 'ctxt') flush();
      id = unquote(m[1]);
      field = 'id';
    } else if ((m = line.match(/^msgstr\s+(".*")\s*$/))) {
      str = unquote(m[1]);
      field = 'str';
    } else if ((m = line.match(/^(".*")\s*$/))) {
      if (field === 'str') str += unquote(m[1]);
      else if (field === 'id') id += unquote(m[1]);
      else if (field === 'ctxt') ctxt += unquote(m[1]);
    }
  }
  flush();
  return list;
}

const messages = readPo(gamePath('text/en.po'));
const messageById = new Map(messages.map((m) => [m.id, m]));
const messageBySymbol = new Map(messages.filter((m) => m.symbol !== 'message').map((m) => [m.symbol, m.id]));
const lastMessage = Math.max(...messages.map((m) => m.id));
const oneLine = (text: string) => text.replace(/\s*\n\s*/g, ' ').replace(/ {2,}/g, ' ').trim();

// ---------------------------------------------------------------------------
// The English edition's preprocessor branches: #if, #ifdef and the rest are
// decided with the edition's macros and their lines blanked, so that the
// parser sees one program and line numbers stay those of the file.

type Defines = Map<string, string>;

function evalDirective(expr: string, defs: Defines): boolean {
  let e = expr.replace(/\bdefined\s*\(\s*(\w+)\s*\)|\bdefined\s+(\w+)/g, (_, a?: string, b?: string) => (defs.has((a ?? b)!) ? '1' : '0'));
  for (let i = 0; i < 20; i++) {
    const next = e.replace(/\b[A-Za-z_]\w*\b/g, (w) => (defs.has(w) ? `(${defs.get(w)})` : w));
    if (next === e) break;
    e = next.replace(/\bdefined\s*\(\s*(\w+)\s*\)|\bdefined\s+(\w+)/g, (_, a?: string, b?: string) => (defs.has((a ?? b)!) ? '1' : '0'));
  }
  e = e.replace(/\b[A-Za-z_]\w*\b/g, '0');
  try {
    return evalTokens(tokenize(e), undefined) !== 0;
  } catch {
    return false;
  }
}

function preprocess(text: string, base: Defines): { text: string; defs: Defines } {
  const defs = new Map(base);
  const lines = text.split('\n');
  const kept: string[] = [];
  const stack: { active: boolean; taken: boolean }[] = [];
  const active = () => stack.every((s) => s.active);
  for (let i = 0; i < lines.length; i++) {
    const startLine = i;
    if (!/^\s*#/.test(lines[i])) {
      kept.push(active() ? lines[i] : '');
      continue;
    }
    let full = lines[i];
    while (full.endsWith('\\') && i + 1 < lines.length) full = full.slice(0, -1) + ' ' + lines[++i];
    const raw = lines.slice(startLine, i + 1);
    const m = full.match(/^\s*#\s*(\w*)(.*)$/)!;
    const directive = m[1];
    const rest = m[2].replace(/\/\*.*?\*\//g, ' ').replace(/\/\/.*$/, '').trim();
    const blank = () => raw.forEach(() => kept.push(''));
    const top = stack[stack.length - 1];
    switch (directive) {
      case 'if':
      case 'ifdef':
      case 'ifndef': {
        const parent = active();
        const name = rest.split(/\s+/)[0];
        const v = parent && (directive === 'if' ? evalDirective(rest, defs) : directive === 'ifdef' ? defs.has(name) : !defs.has(name));
        stack.push({ active: v, taken: v });
        blank();
        break;
      }
      case 'elif':
        if (top) {
          if (top.taken) top.active = false;
          else {
            const v = stack.slice(0, -1).every((s) => s.active) && evalDirective(rest, defs);
            top.active = v;
            top.taken = v;
          }
        }
        blank();
        break;
      case 'else':
        if (top) {
          top.active = !top.taken;
          top.taken = true;
        }
        blank();
        break;
      case 'endif':
        stack.pop();
        blank();
        break;
      case 'define':
        if (active()) {
          const d = rest.match(/^(\w+)(\([^)]*\))?\s*(.*)$/);
          if (d) defs.set(d[1], d[2] ? '' : d[3]);
          raw.forEach((l) => kept.push(l));
        } else blank();
        break;
      case 'undef':
        if (active()) defs.delete(rest.split(/\s+/)[0]);
        blank();
        break;
      default:
        if (active()) raw.forEach((l) => kept.push(l));
        else blank();
    }
  }
  return { text: kept.join('\n'), defs };
}

// The English edition's macros, from the headers that choose them.
const englishDefines: Defines = (() => {
  let defs: Defines = new Map([['TBS_EDITION_EN', '1']]);
  for (const h of ['include/game/edition.h', 'include/version.h']) {
    if (existsSync(gamePath(h))) defs = preprocess(readFileSync(gamePath(h), 'utf8'), defs).defs;
  }
  return defs;
})();

const treesKept: Tree[] = [];
const parsed = new Map<string, Node>();

// Attributes are blanked, line breaks kept: the parser reads UNUSED before a
// definition as a type, and an __attribute__ between a declarator and its
// initializer as an error that swallows the tables after it.
function blankAttributes(text: string): string {
  let result = text.replace(/\bUNUSED\b/g, '      ').replace(/\b(?:asm|__asm__)\s*(?:volatile\s*|__volatile__\s*)?\(\s*"[^"\n]*"\s*\)/g, (s) => s.replace(/[^\n]/g, ' '));
  for (let at = result.indexOf('__attribute__'); at >= 0; at = result.indexOf('__attribute__', at + 1)) {
    let i = at + '__attribute__'.length;
    while (/\s/.test(result[i] ?? '')) i++;
    if (result[i] !== '(') continue;
    let depth = 0;
    let end = i;
    for (; end < result.length; end++) {
      if (result[end] === '(') depth++;
      else if (result[end] === ')' && --depth === 0) break;
    }
    result = result.slice(0, at) + result.slice(at, end + 1).replace(/[^\n]/g, ' ') + result.slice(end + 1);
  }
  return result;
}

// A C file of the game, its English branches chosen, parsed.
function parseC(rel: string): Node {
  const hit = parsed.get(rel);
  if (hit) return hit;
  const text = blankAttributes(preprocess(readFileSync(join(repo, rel), 'utf8'), englishDefines).text);
  const tree = parser.parse(text)!;
  treesKept.push(tree);
  parsed.set(rel, tree.rootNode);
  return tree.rootNode;
}

// ---------------------------------------------------------------------------
// Constant expressions: macros expanded, enumerators, message symbols and
// scene ids resolved, then evaluated as C would.

const TOKEN = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|0[xX][0-9a-fA-F]+[uUlL]*|\d+[uUlL]*|[A-Za-z_]\w*|##|#|<<=?|>>=?|<=|>=|==|!=|&&|\|\||->|\+\+|--|\.\.\.|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|[-+*/%&|^~!<>?:(),.[\]{};=]/g;

function tokenize(text: string): string[] {
  const toks: string[] = [];
  for (const m of text.matchAll(TOKEN)) if (!/^\s|^\/[/*]/.test(m[0])) toks.push(m[0]);
  return toks;
}

const isIdent = (t: string | undefined) => !!t && /^[A-Za-z_]\w*$/.test(t);
const TYPE_WORDS = new Set(['s8', 'u8', 's16', 'u16', 's32', 'u32', 's64', 'u64', 'vu8', 'vu16', 'vu32', 'vs8', 'vs16', 'vs32', 'int', 'unsigned', 'signed', 'char', 'short', 'long', 'void', 'const', 'volatile', 'struct', 'union', 'enum', 'bool8', 'bool16', 'bool32', 'size_t', 'uintptr_t', 'intptr_t', 'f32']);

type Macro = { params?: string[]; body: string[] };

let sceneIdByName = new Map<string, number>();

// Names that need no header: message symbols (their number, as the
// generated msg_ids.h makes them) and scene ids (their row of the scene table).
function builtinValue(name: string): number | undefined {
  const msg = messageBySymbol.get(name) ?? messageBySymbol.get(name.replace(/^TEXT_MESSAGE_NUMBER_/, ''));
  if (msg !== undefined) return msg;
  if (name === 'MsgEnd' || name === 'TEXT_MESSAGE_NUMBER_MsgEnd') return messages.length;
  const scene = name.startsWith('SceneId_') ? sceneIdByName.get(name.slice(8)) : undefined;
  return scene;
}

class Scope {
  macros = new Map<string, Macro>();
  values = new Map<string, number>();
  types = new Set<string>();
  cache = new Map<string, number | undefined>();
  constructor(readonly parent?: Scope) {}
  macro(n: string): Macro | undefined {
    return this.macros.get(n) ?? this.parent?.macro(n);
  }
  value(n: string): number | undefined {
    const v = this.values.get(n);
    if (v !== undefined) return v;
    return this.parent ? this.parent.value(n) : builtinValue(n);
  }
  isType(n: string): boolean {
    return this.types.has(n) || (this.parent ? this.parent.isType(n) : TYPE_WORDS.has(n));
  }
}

const BUILTIN_MACROS = new Map<string, Macro>([['MSGNO', { params: ['name'], body: ['TEXT_MESSAGE_NUMBER_', '##', 'name'] }]]);

function expand(toks: string[], scope: Scope, hide: Set<string> = new Set(), depth = 0): string[] {
  if (depth > 40) return toks;
  const result: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const m = isIdent(t) && !hide.has(t) ? (scope.macro(t) ?? BUILTIN_MACROS.get(t)) : undefined;
    if (!m) {
      result.push(t);
      continue;
    }
    if (!m.params) {
      result.push(...expand(m.body, scope, new Set([...hide, t]), depth + 1));
      continue;
    }
    if (toks[i + 1] !== '(') {
      result.push(t);
      continue;
    }
    let args: string[][] = [[]];
    let level = 0;
    let j = i + 1;
    for (; j < toks.length; j++) {
      const u = toks[j];
      if (u === '(') {
        if (level++ > 0) args[args.length - 1].push(u);
      } else if (u === ')') {
        if (--level === 0) break;
        args[args.length - 1].push(u);
      } else if (u === ',' && level === 1) args.push([]);
      else args[args.length - 1].push(u);
    }
    if (m.params.length === 0) args = [];
    const variadic = m.params[m.params.length - 1] === '...';
    const argOf = (name: string): string[] | undefined => {
      if (variadic && name === '__VA_ARGS__') return args.slice(m.params!.length - 1).flatMap((a, k) => (k ? [',', ...a] : a));
      const k = m.params!.indexOf(name);
      return k >= 0 ? (args[k] ?? []) : undefined;
    };
    const body: string[] = [];
    for (let k = 0; k < m.body.length; k++) {
      const b = m.body[k];
      if (b === '#' && argOf(m.body[k + 1] ?? '')) {
        body.push(`"${argOf(m.body[++k])!.join(' ')}"`);
        continue;
      }
      const a = argOf(b);
      if (a) body.push(...(m.body[k - 1] === '##' || m.body[k + 1] === '##' ? a : expand(a, scope, hide, depth + 1)));
      else body.push(b);
    }
    const pasted: string[] = [];
    for (let k = 0; k < body.length; k++) {
      if (body[k] === '##') pasted.push((pasted.pop() ?? '') + (body[++k] ?? ''));
      else pasted.push(body[k]);
    }
    result.push(...expand(pasted, scope, new Set([...hide, t]), depth + 1));
    i = j;
  }
  return result;
}

class EvalError extends Error {}

function evalTokens(toks: string[], scope: Scope | undefined): number {
  let i = 0;
  const fail = (): never => {
    throw new EvalError(toks.join(' '));
  };
  const PREC: Record<string, number> = { '*': 10, '/': 10, '%': 10, '+': 9, '-': 9, '<<': 8, '>>': 8, '<': 7, '<=': 7, '>': 7, '>=': 7, '==': 6, '!=': 6, '&': 5, '^': 4, '|': 3, '&&': 2, '||': 1 };
  const apply = (op: string, a: number, b: number): number => {
    switch (op) {
      case '*': return a * b;
      case '/': return b === 0 ? fail() : Math.trunc(a / b);
      case '%': return b === 0 ? fail() : a % b;
      case '+': return a + b;
      case '-': return a - b;
      case '<<': return a << b;
      case '>>': return a >> b;
      case '<': return +(a < b);
      case '<=': return +(a <= b);
      case '>': return +(a > b);
      case '>=': return +(a >= b);
      case '==': return +(a === b);
      case '!=': return +(a !== b);
      case '&': return a & b;
      case '^': return a ^ b;
      case '|': return a | b;
      case '&&': return +(!!a && !!b);
      default: return +(!!a || !!b);
    }
  };
  const isTypeStart = (t: string | undefined) => !!t && (scope ? scope.isType(t) : TYPE_WORDS.has(t));
  const cast = (type: string[], v: number): number => {
    if (type.includes('*')) return v;
    const t = type.filter((w) => w !== 'const' && w !== 'volatile').join(' ');
    if (t === 'u8' || t === 'unsigned char') return v & 0xff;
    if (t === 's8' || t === 'char' || t === 'signed char') return (v << 24) >> 24;
    if (t === 'u16' || t === 'unsigned short') return v & 0xffff;
    if (t === 's16' || t === 'short') return (v << 16) >> 16;
    if (t === 'u32' || t === 'unsigned' || t === 'unsigned int') return v >>> 0;
    if (t === 's32' || t === 'int') return v | 0;
    return v;
  };
  function unary(): number {
    const t = toks[i];
    if (t === '-') return i++, -unary();
    if (t === '+') return i++, unary();
    if (t === '~') return i++, ~unary();
    if (t === '!') return i++, +!unary();
    if (t === '&') return i++, unary(); // the address of a scene id is its number
    if (t === '(' && isTypeStart(toks[i + 1])) {
      let j = i + 1;
      while (j < toks.length && toks[j] !== ')') j++;
      const type = toks.slice(i + 1, j);
      i = j + 1;
      return cast(type, unary());
    }
    return primary();
  }
  function primary(): number {
    const t = toks[i++];
    if (t === undefined) return fail();
    if (t === '(') {
      const v = ternary();
      if (toks[i++] !== ')') fail();
      return v;
    }
    if (/^0[xX]/.test(t)) return parseInt(t.replace(/[uUlL]+$/, ''), 16);
    if (/^0\d/.test(t)) return parseInt(t.replace(/[uUlL]+$/, ''), 8);
    if (/^\d/.test(t)) return parseInt(t.replace(/[uUlL]+$/, ''), 10);
    if (/^'/.test(t)) return t.length === 3 ? t.charCodeAt(1) : fail();
    if (isIdent(t)) {
      const v = scope?.value(t);
      return v === undefined ? fail() : v;
    }
    return fail();
  }
  function binary(min: number): number {
    let left = unary();
    for (;;) {
      const op = toks[i];
      const p = PREC[op];
      if (p === undefined || p < min) return left;
      i++;
      left = apply(op, left, binary(p + 1));
    }
  }
  function ternary(): number {
    const c = binary(1);
    if (toks[i] !== '?') return c;
    i++;
    const a = ternary();
    if (toks[i++] !== ':') fail();
    const b = ternary();
    return c ? a : b;
  }
  const v = ternary();
  if (i !== toks.length) fail();
  return v;
}

function constEval(text: string, scope: Scope): number | undefined {
  if (scope.cache.has(text)) return scope.cache.get(text);
  let v: number | undefined;
  try {
    v = evalTokens(expand(tokenize(text), scope), scope);
  } catch {
    v = undefined;
  }
  scope.cache.set(text, v);
  return v;
}

// An initializer element can stand for several words (SCENE_EXIT_IF writes
// two): expanded, split at its top-level commas, each word evaluated.
function evalWords(text: string, scope: Scope): (number | undefined)[] {
  return splitTop(expand(tokenize(text), scope)).map((p) => {
    try {
      return evalTokens(p, scope);
    } catch {
      return undefined;
    }
  });
}

// The constants a parsed file declares: macros, enumerators and typedef
// names. Enumerators that use names from elsewhere are retried until nothing
// more resolves.
const pendingEnums: { scope: Scope; name: string; text: string | null; prev: { name: string } | null }[] = [];

function collectConstants(root: Node, scope: Scope) {
  for (const n of root.descendantsOfType(['preproc_def', 'preproc_function_def', 'enum_specifier', 'type_definition'])) {
    if (!n) continue;
    if (n.type === 'preproc_def' || n.type === 'preproc_function_def') {
      const name = n.childForFieldName('name')?.text ?? '';
      if (!name || scope.macros.has(name)) continue;
      const params = n.type === 'preproc_function_def' ? (n.childForFieldName('parameters')?.text.replace(/^\(|\)$/g, '').split(',').map((s) => s.trim()).filter(Boolean) ?? []) : undefined;
      scope.macros.set(name, { params, body: tokenize(n.childForFieldName('value')?.text ?? '') });
    } else if (n.type === 'enum_specifier') {
      let prev: { name: string } | null = null;
      for (const e of n.childForFieldName('body')?.namedChildren ?? []) {
        if (!e || e.type !== 'enumerator') continue;
        const name = e.childForFieldName('name')!.text;
        pendingEnums.push({ scope, name, text: e.childForFieldName('value')?.text ?? null, prev });
        prev = { name };
      }
    } else {
      const d = n.childForFieldName('declarator');
      const name = declaredName(d);
      if (name) scope.types.add(name);
    }
  }
}

function resolveEnums() {
  for (let pass = 0; pass < 8 && pendingEnums.length; pass++) {
    let progress = false;
    for (let k = 0; k < pendingEnums.length; k++) {
      const e = pendingEnums[k];
      let v: number | undefined;
      if (e.text !== null) v = constEval(e.text, e.scope);
      else if (!e.prev) v = 0;
      else {
        const p = e.scope.values.get(e.prev.name);
        v = p === undefined ? undefined : p + 1;
      }
      if (v === undefined) continue;
      if (!e.scope.values.has(e.name)) e.scope.values.set(e.name, v);
      for (let s: Scope | undefined = e.scope; s; s = s.parent) s.cache.clear();
      pendingEnums.splice(k--, 1);
      progress = true;
    }
    if (!progress) break;
  }
  pendingEnums.length = 0;
}

function declaredName(d: Node | null): string {
  while (d) {
    if (d.type === 'identifier' || d.type === 'field_identifier' || d.type === 'type_identifier') return d.text;
    d = d.childForFieldName('declarator') ?? d.namedChildren.find((c) => c && /declarator|identifier/.test(c.type)) ?? null;
  }
  return '';
}

function walkFiles(rel: string, test: (name: string) => boolean, into: string[] = []): string[] {
  const abs = join(repo, rel);
  if (!existsSync(abs)) return into;
  for (const e of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) walkFiles(r, test, into);
    else if (test(e.name)) into.push(r);
  }
  return into;
}

// ---------------------------------------------------------------------------
// The scene table, the overlays' files and the place names.

type SceneRow = { id: number; name: string; overlay: number; group: number; kind: number; map: number; file: string };

const scenes: SceneRow[] = [];
for (const line of readFileSync(gamePath('src/field/scenes.s'), 'utf8').split('\n')) {
  const m = line.match(/^\s*scene\s+(\w*)\s*,\s*(\w+)\s*,\s*(\w+)\s*,\s*(\w+)\s*,\s*(\w+)/);
  if (m) scenes.push({ id: scenes.length, name: m[1], overlay: Number(m[2]), group: Number(m[3]), kind: Number(m[4]), map: Number(m[5]), file: '' });
}
sceneIdByName = new Map(scenes.filter((s) => s.name).map((s) => [s.name, s.id]));

// Each overlay's own C file: the first object of its rows in objects.tsv
// that is neither its entry nor its import table.
const overlayFile = new Map<number, string>();
for (const line of readFileSync(gamePath('objects.tsv'), 'utf8').split('\n').slice(1)) {
  const [image, place, object, , editions] = line.split('\t');
  if (!/^[0-9a-f]+$/.test(image ?? '') || place !== 'text' || !object || /\/(entry|import)\//.test(object)) continue;
  if (editions && !editions.split(/\s+/).includes('en')) continue;
  const overlay = parseInt(image, 16);
  if (!overlayFile.has(overlay) && existsSync(join(repo, `${object}.c`))) overlayFile.set(overlay, `${object}.c`);
}
for (const s of scenes) s.file = overlayFile.get(s.overlay) ?? '';
const scenesOfFile = new Map<string, number[]>();
for (const s of scenes) if (s.file) scenesOfFile.set(s.file, [...(scenesOfFile.get(s.file) ?? []), s.id]);
const sceneLabel = (id: number) => `${id}${scenes[id]?.name ? ` ${scenes[id].name}` : ''}`;
const shortFile = (f: string) => f.replace(/^games\/tbs\/src\//, '');

// Area names, as Scene_GetAreaNameIndex resolves them: the first rule of
// gScene_AreaNameRules for the scene (or its group) and the entrance (-1 for
// any), added to MsgDebugEntryName.
type AreaNames = { byEntrance: [number, string][]; fallback: string; messages: number[] };

function deriveAreas(): Map<number, AreaNames> {
  const asmDefs = new Map<string, number>();
  const ed = gamePath('include/game/ed_asm.h');
  if (existsSync(ed)) {
    // The English block's .set lines win; its nested .if blocks are its own.
    let depth = 0;
    let inEnglish = false;
    for (const line of readFileSync(ed, 'utf8').split('\n')) {
      if (/^\s*\.if/.test(line)) {
        if (inEnglish) depth++;
        else if (/^\s*\.ifdef\s+TBS_EDITION_EN\b/.test(line)) inEnglish = true;
      } else if (inEnglish && /^\s*\.endif/.test(line)) {
        if (depth) depth--;
        else inEnglish = false;
      }
      const set = line.match(/^\s*\.set\s+(\w+)\s*,\s*(\w+)/);
      if (set && (inEnglish || !asmDefs.has(set[1]))) asmDefs.set(set[1], Number(set[2]));
    }
  }
  type Rule = { scene: boolean; id: number; entrance: number; index: number };
  const rules: Rule[] = [];
  let inTable = false;
  const stack: boolean[] = [];
  for (const line of readFileSync(gamePath('src/object/scene_rules.s'), 'utf8').split('\n')) {
    if (/^gScene_AreaNameRules:/.test(line)) inTable = true;
    else if (inTable && /^\w+:|^\s*\.global/.test(line)) inTable = false;
    if (!inTable) continue;
    const cond = line.match(/^\s*\.if\s+(\w+)/);
    if (cond) stack.push((asmDefs.get(cond[1]) ?? 0) !== 0);
    else if (/^\s*\.else/.test(line)) stack.push(!stack.pop());
    else if (/^\s*\.endif/.test(line)) stack.pop();
    if (!stack.every(Boolean)) continue;
    const m = line.match(/^\s*(scene|group)_name\s+(\w+)\s*,\s*(-?\w+)\s*,\s*(\w+)/);
    if (!m) continue;
    const id = m[1] === 'scene' ? sceneIdByName.get(m[2]) : Number(m[2]);
    if (id !== undefined) rules.push({ scene: m[1] === 'scene', id, entrance: Number(m[3]), index: Number(m[4]) });
  }
  const base = messageBySymbol.get('MsgDebugEntryName') ?? 0;
  const nameOf = (scene: SceneRow, entrance: number) => {
    const r = rules.find((r) => (r.scene ? r.id === scene.id : r.id === scene.group) && (r.entrance === -1 || r.entrance === entrance));
    return r ? base + r.index : base;
  };
  const areas = new Map<number, AreaNames>();
  for (const s of scenes) {
    const specific = uniq(rules.filter((r) => (r.scene ? r.id === s.id : r.id === s.group) && r.entrance !== -1).map((r) => r.entrance));
    const fallbackMsg = nameOf(s, -2);
    const byEntrance: [number, string][] = specific.map((e) => [e, oneLine(messageById.get(nameOf(s, e))?.text ?? '')] as [number, string]).filter(([e]) => nameOf(s, e) !== fallbackMsg);
    areas.set(s.id, { byEntrance, fallback: oneLine(messageById.get(fallbackMsg)?.text ?? ''), messages: uniq([...specific.map((e) => nameOf(s, e)), fallbackMsg]) });
  }
  return areas;
}

// The other place table, when there is one: its first section has a row per
// scene, sceneNumber and areaNames ("19=Babi's Palace; *=Vale").
function readPlaceTable(path: string): Map<number, AreaNames> | undefined {
  if (!existsSync(path)) return undefined;
  const lines = readFileSync(path, 'utf8').split('\n');
  const header = lines[0]?.split('\t') ?? [];
  const col = (n: string) => header.indexOf(n);
  if (col('sceneNumber') < 0 || col('areaNames') < 0) return undefined;
  const areas = new Map<number, AreaNames>();
  for (const line of lines.slice(1)) {
    const f = line.split('\t');
    if (f.length !== header.length || !/^\d+$/.test(f[col('sceneNumber')])) break;
    const names = f[col('areaNames')];
    const msgs = (f[col('areaMessage')] ?? '').match(/\d{5}/g)?.map(Number) ?? [];
    const byEntrance: [number, string][] = [];
    let fallback = names;
    if (/=/.test(names)) {
      fallback = '';
      for (const part of names.split(/;\s*/)) {
        const [keys, name] = part.split('=');
        if (keys.trim() === '*') fallback = name.trim();
        else for (const k of keys.split(',')) byEntrance.push([Number(k), name.trim()]);
      }
    }
    areas.set(Number(f[col('sceneNumber')]), { byEntrance, fallback, messages: msgs });
  }
  return areas.size ? areas : undefined;
}

const derivedAreas = deriveAreas();
const tableAreas = readPlaceTable(placesTable);
const areas = tableAreas ?? derivedAreas;
const areaText = (a: AreaNames | undefined) => (a ? uniq([...a.byEntrance.map(([, n]) => n), a.fallback].filter(Boolean)).join(' / ') : '');
const placeOfScenes = (ids: number[]) => uniq(sortNum(ids).flatMap((id) => areaText(areas.get(id)).split(' / ')).filter(Boolean)).join(' / ');
let areaMismatches: string[] = [];
if (tableAreas) {
  for (const s of scenes) {
    const a = areaText(tableAreas.get(s.id));
    const b = areaText(derivedAreas.get(s.id));
    if (a !== b) areaMismatches.push(`${sceneLabel(s.id)}: table "${a}", derived "${b}"`);
  }
}

// ---------------------------------------------------------------------------
// The game's global constants: every header under include, except the scene
// unit headers, which each belong to their scene.

const globalScope = new Scope();
for (const h of walkFiles(`${GAME}/include`, (n) => n.endsWith('.h'))) {
  if (h.includes('/include/unit/scene/')) continue;
  collectConstants(parseC(h), globalScope);
}
resolveEnums();

// Character names, from character_ids.h (ISAAC 0 to PIERS 7): actors 0 to 7
// are the party's characters, and {actor_name:n} is character n - 1's name
// (UnitGetFar(argument - 1) in the window's decoder).
const characters: string[] = [];
{
  const ids = gamePath('include/game/character_ids.h');
  if (existsSync(ids)) {
    for (const m of readFileSync(ids, 'utf8').matchAll(/^#define ([A-Z]+) (\d)\b/gm)) characters[Number(m[2])] = m[1][0] + m[1].slice(1).toLowerCase();
  }
}

// Flag names and notes from flags.h: each FLAG_ macro's value, its ///
// comment and the // heading of its section.
type FlagDoc = { names: string[]; doc: string; section: string };
const flagDocs = new Map<number, FlagDoc>();
{
  let section = '';
  let block: string[] = [];
  let doc: string[] = [];
  for (const line of readFileSync(gamePath('include/flags.h'), 'utf8').split('\n')) {
    const d = line.match(/^\s*\/\/\/(?!<)\s?(.*)$/);
    if (d) {
      if (!/^@file/.test(d[1])) doc.push(d[1]);
      continue;
    }
    const s = line.match(/^\s*\/\/\s?(.*)$/);
    if (s) {
      block.push(s[1].trim());
      doc = [];
      continue;
    }
    // A one-line // comment heads a section ("// Altin"); a longer one is a
    // note that ends the section before it.
    if (block.length) section = block.length === 1 ? block[0] : '';
    block = [];
    const m = line.match(/^#define (FLAG_\w+)(\([^)]*\))?\s+(.*?)\s*(?:\/\/\/<\s*(.*))?$/);
    if (m && !m[2]) {
      const v = constEval(m[1], globalScope);
      if (v !== undefined) {
        const f = flagDocs.get(v) ?? { names: [], doc: '', section };
        f.names.push(m[1]);
        f.doc = [f.doc, ...doc, m[4] ?? ''].filter(Boolean).join(' ');
        flagDocs.set(v, f);
      }
    }
    doc = [];
  }
}

// ---------------------------------------------------------------------------
// The scenes' code: each scene overlay with the common headers it includes,
// its constants, functions and tables.

type Fn = { name: string; file: string; body: Node; params: string[]; line: number };
type Table = { name: string; type: string; file: string; init: Node; line: number };
type TU = { file: string; scope: Scope; fns: Map<string, Fn>; tables: Map<string, Table>; scenes: number[]; entry: string[] };

const localFlagNames = new Map<string, Map<number, string>>();
let globalFlagNamesCache: Map<number, string> | undefined;
const ENTRY_SLOTS = ['initialize', 'entrances', 'exits', 'placements', 'events', 'regions'];

function functionsOf(root: Node, file: string, into: Map<string, Fn>) {
  for (const n of root.namedChildren) {
    if (!n || n.type !== 'function_definition') continue;
    const d = n.childForFieldName('declarator');
    const name = declaredName(d);
    const body = n.childForFieldName('body');
    if (!name || !body || into.has(name)) continue;
    const fd = d?.type === 'function_declarator' ? d : (d?.descendantsOfType('function_declarator')[0] ?? null);
    const params = (fd?.childForFieldName('parameters')?.namedChildren ?? []).filter((p) => p?.type === 'parameter_declaration').map((p) => declaredName(p!.childForFieldName('declarator'))).filter(Boolean);
    into.set(name, { name, file, body, params, line: n.startPosition.row + 1 });
  }
}

function tablesOf(root: Node, file: string, into: Map<string, Table>) {
  for (const n of root.namedChildren) {
    if (!n || n.type !== 'declaration') continue;
    for (const d of n.namedChildren) {
      if (!d || d.type !== 'init_declarator') continue;
      const init = d.childForFieldName('value');
      if (!init || init.type !== 'initializer_list') continue;
      const name = declaredName(d.childForFieldName('declarator'));
      if (name) into.set(name, { name, type: n.childForFieldName('type')?.text ?? '', file, init, line: n.startPosition.row + 1 });
    }
  }
}

function buildTU(file: string): TU {
  const scope = new Scope(globalScope);
  const fns = new Map<string, Fn>();
  const tables = new Map<string, Table>();
  const seen = new Set<string>();
  const visit = (rel: string) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const root = parseC(rel);
    collectConstants(root, scope);
    functionsOf(root, rel, fns);
    tablesOf(root, rel, tables);
    for (const inc of root.descendantsOfType('preproc_include')) {
      const p = inc?.childForFieldName('path');
      if (!p || p.type !== 'string_literal') continue;
      const target = join(dirname(rel), p.text.slice(1, -1));
      if (target.startsWith(`${GAME}/src/scene/`) && existsSync(join(repo, target))) visit(target);
    }
  };
  visit(file);
  const unit = `${GAME}/include/unit/scene/${basename(file, '.c')}.h`;
  if (existsSync(join(repo, unit))) collectConstants(parseC(unit), scope);
  const entryPath = gamePath('src/scene/entry', `${basename(file, '.c')}.s`);
  const entry = existsSync(entryPath) ? [...readFileSync(entryPath, 'utf8').matchAll(/^\s*overlay_veneer\s+(\w+)/gm)].map((m) => m[1]) : [];
  return { file, scope, fns, tables, scenes: scenesOfFile.get(file) ?? [], entry };
}

const sceneFiles = walkFiles(`${GAME}/src/scene`, (n) => n.endsWith('.c')).filter((f) => dirname(f) === `${GAME}/src/scene`);
const tus = sceneFiles.map(buildTU);
resolveEnums();

// ---------------------------------------------------------------------------
// Following an event: the abstract state is the path's flag literals, the
// current message's possible values (each with the literals of its own path)
// and the locals' values.

type Lit = { k: string; pos: boolean }; // k: "f<number>" a flag, "s<number>" the scene
type Val = { t: 'num'; n: number; tag: string } | { t: 'entry'; off: number } | { t: 'unknown' };
type MVal = { v: Val; cond: Lit[] };
type State = { pc: Lit[]; msg: MVal[]; env: Map<string, Val[]> };
type Show = { n: number; tag: string; fn: string; file: string; speaker: string; how: string; cond: Lit[] };
type FlagOp = { op: 'set' | 'clear' | 'test'; n: number; written: string; tag: string; fn: string; file: string; sense: string; cond: Lit[] };
type Result = { shows: Show[]; ops: FlagOp[]; unresolved: { fn: string; file: string; line: number; why: string }[]; dynamicFlags: number };
type Frame = {
  tu: TU;
  fn: Fn;
  ptext: Map<string, string>;
  stack: string[];
  returns: State[];
  breaks: State[][];
  res: Result;
  sense: Map<number, string>;
  onReturn?: (value: Node | null, st: State) => void;
};

const UNKNOWN: Val = { t: 'unknown' };
const SET_MESSAGE = new Set(['Engine_EventSetMessage', 'MESSAGE_SET', 'Event_SetMessage', 'Event_SetMessageId']);
const SHOW_MESSAGE = new Set(['Engine_EventShowMessage', 'Event_ShowMessage', 'MESSAGE_PUT', 'Engine_EventOpenMessage', 'Event_OpenMessage', 'MESSAGE_OPEN', 'Engine_EventShowMessageAndWait', 'Event_ShowMessageAndWait', 'FieldEvent_ShowMessageAndWait', 'UiText_OpenMessageAtObject', 'Event_ShowSpeakerMessage']);
const ASK_MESSAGE = new Set(['Engine_EventAskYesNo', 'Event_AskYesNo', 'FieldEvent_AskYesNoAndShowResponse']);
const TWO_MESSAGES = new Set(['Engine_EventShowTwoMessagesAndWait', 'Event_ShowTwoMessagesAndWait', 'Battle_ShowPairedUnitWorkAndWait']);
const DIRECT_MESSAGE = new Set(['Engine_MessageShowCentered', 'Message_ShowCentered', 'UiText_ShowCenteredMessage', 'UiText_ShowPositionedMessageAndWait', 'UiText_ShowPositionedMessageAndWaitFar']);
const FLAG_SET = new Set(['GameFlag_Set', 'FLAG_SET', 'Engine_GameFlagSet', 'FieldEvent_GameFlagSet', 'GameFlag_SetBitFar', 'GameFlag_SetBit']);
const FLAG_CLEAR = new Set(['GameFlag_Clear', 'Engine_GameFlagClear', 'FieldEvent_GameFlagClear', 'GameFlag_ClearBitFar', 'GameFlag_ClearBit']);
const FLAG_TEST = new Set(['GameFlag_IsSet', 'FLAG_CHECK', 'Engine_GameFlagIsSet', 'FieldEvent_GameFlagIsSet', 'GameFlag_TestFar', 'GameFlag_Test']);
const MAX_VALUES = 48;

const litKey = (l: Lit) => `${l.pos ? '+' : '-'}${l.k}`;
const contradicts = (a: Lit, b: Lit) => (a.k === b.k && a.pos !== b.pos) || (a.pos && b.pos && a.k[0] === 's' && b.k[0] === 's' && a.k !== b.k);
const valKey = (v: Val) => (v.t === 'num' ? `n${v.n}@${v.tag}` : v.t === 'entry' ? `e${v.off}` : 'u');
const condKey = (c: Lit[]) => c.map(litKey).sort().join(',');

function clone(st: State): State {
  return { pc: [...st.pc], msg: st.msg.map((m) => ({ v: m.v, cond: [...m.cond] })), env: new Map(st.env) };
}

// Adds a branch's literals; null when the path cannot be taken.
function assume(st: State, lits: Lit[]): State | null {
  for (const l of lits) {
    if (st.pc.some((p) => contradicts(p, l))) return null;
    if (!st.pc.some((p) => litKey(p) === litKey(l))) st.pc.push(l);
    st.msg = st.msg.filter((m) => !m.cond.some((c) => contradicts(c, l)));
    for (const m of st.msg) if (!m.cond.some((c) => litKey(c) === litKey(l))) m.cond.push(l);
  }
  return st;
}

// Message values that differ only in one flag's two senses are one value;
// a value whose condition holds a weaker one's is that value.
function simplify(list: MVal[]): MVal[] {
  let vals = list;
  for (let changed = true; changed; ) {
    changed = false;
    const byKey = new Map<string, MVal>();
    for (const m of vals) byKey.set(`${valKey(m.v)}|${condKey(m.cond)}`, m);
    vals = [...byKey.values()];
    outer: for (let a = 0; a < vals.length; a++) {
      for (let b = a + 1; b < vals.length; b++) {
        const x = vals[a];
        const y = vals[b];
        if (valKey(x.v) !== valKey(y.v) || x.cond.length !== y.cond.length) continue;
        const onlyX = x.cond.filter((c) => !y.cond.some((d) => litKey(c) === litKey(d)));
        if (onlyX.length !== 1) continue;
        const onlyY = y.cond.filter((c) => !x.cond.some((d) => litKey(c) === litKey(d)));
        if (onlyY.length === 1 && onlyY[0].k === onlyX[0].k) {
          vals.splice(b, 1);
          vals[a] = { v: x.v, cond: x.cond.filter((c) => c.k !== onlyX[0].k) };
          changed = true;
          break outer;
        }
      }
    }
  }
  const weaker = (x: MVal, y: MVal) => valKey(x.v) === valKey(y.v) && x.cond.length < y.cond.length && x.cond.every((c) => y.cond.some((d) => litKey(c) === litKey(d)));
  vals = vals.filter((y) => !vals.some((x) => x !== y && weaker(x, y)));
  return vals.slice(0, MAX_VALUES);
}

function merge(states: (State | null)[]): State | null {
  const live = states.filter((s): s is State => !!s);
  if (!live.length) return null;
  if (live.length === 1) return live[0];
  const pc = live[0].pc.filter((l) => live.every((s) => s.pc.some((p) => litKey(p) === litKey(l))));
  const msg = simplify(live.flatMap((s) => s.msg));
  const env = new Map<string, Val[]>();
  for (const s of live) {
    for (const [k, vs] of s.env) {
      const all = [...(env.get(k) ?? []), ...vs];
      const seen = new Set<string>();
      env.set(k, all.filter((v) => !seen.has(valKey(v)) && seen.add(valKey(v))).slice(0, 16));
    }
  }
  return { pc, msg, env };
}

const strip = (n: Node | null): Node | null => {
  while (n && n.type === 'parenthesized_expression') n = n.namedChildren.find((c) => c && c.type !== 'comment') ?? null;
  return n;
};
const args = (call: Node) => (call.childForFieldName('arguments')?.namedChildren ?? []).filter((c): c is Node => !!c && c.type !== 'comment');
const callName = (call: Node) => {
  const f = call.childForFieldName('function');
  return f?.type === 'identifier' ? f.text : '';
};

// A message or flag value: the locals and the current message where the
// expression uses them, else the constant it evaluates to.
function absEval(node: Node | null, st: State, fr: Frame): Val[] {
  node = strip(node);
  if (!node) return [UNKNOWN];
  if (node.type === 'cast_expression') return absEval(node.childForFieldName('value'), st, fr);
  if (node.type === 'identifier' && st.env.has(node.text)) return st.env.get(node.text)!;
  if (node.type === 'field_expression' && node.childForFieldName('field')?.text === 'message') return st.msg.map((m) => m.v);
  if (node.type === 'binary_expression') {
    const op = node.childForFieldName('operator')?.text;
    const usesState = node.descendantsOfType(['identifier', 'field_identifier']).some((i) => i && (st.env.has(i.text) || i.text === 'message'));
    if (usesState && (op === '+' || op === '-')) {
      const sign = op === '+' ? 1 : -1;
      const left = absEval(node.childForFieldName('left'), st, fr);
      const right = absEval(node.childForFieldName('right'), st, fr);
      const outVals: Val[] = [];
      for (const l of left)
        for (const r of right) {
          if (l.t === 'num' && r.t === 'num') outVals.push({ t: 'num', n: l.n + sign * r.n, tag: l.tag });
          else if (l.t === 'entry' && r.t === 'num') outVals.push({ t: 'entry', off: l.off + sign * r.n });
          else if (sign > 0 && l.t === 'num' && r.t === 'entry') outVals.push({ t: 'entry', off: r.off + l.n });
          else outVals.push(UNKNOWN);
        }
      return outVals.slice(0, 16);
    }
    if (usesState) return [UNKNOWN];
  }
  const n = constEval(node.text, fr.tu.scope);
  return n === undefined ? [UNKNOWN] : [{ t: 'num', n, tag: fr.fn.name }];
}

const shiftVal = (v: Val, d: number): Val => (v.t === 'num' ? { ...v, n: v.n + d } : v.t === 'entry' ? { t: 'entry', off: v.off + d } : v);

function shift(st: State, by: Val[]) {
  const next: MVal[] = [];
  for (const m of st.msg) for (const d of by) next.push({ v: d.t === 'num' ? shiftVal(m.v, d.n) : UNKNOWN, cond: m.cond });
  st.msg = simplify(next);
}

// Who speaks: the actor argument as written, a parameter replaced by its
// caller's argument, the window bits dropped; actors 0 to 7 are characters.
function speakerOf(node: Node | undefined, st: State, fr: Frame): string {
  if (!node) return '';
  if (node.type === 'identifier' && st.env.has(node.text)) {
    const nums = st.env.get(node.text)!.filter((v) => v.t === 'num');
    if (nums.length === 1 && nums[0].t === 'num') {
      const n = nums[0].n < 0 ? nums[0].n : nums[0].n & 0xfff;
      return actorLabel(String(n), n);
    }
  }
  const text = node.text.replace(/\b[A-Za-z_]\w*\b/g, (w) => fr.ptext.get(w) ?? w);
  const parts = text.split('|').map((p) => p.trim().replace(/^\(|\)$/g, '').trim()).filter((p) => p && !/^SPEAKER_/.test(p));
  const written = parts.join(' | ');
  const v = constEval(written, fr.tu.scope);
  return actorLabel(written, v === undefined ? undefined : v < 0 ? v : v & 0xfff);
}

function actorLabel(written: string, v: number | undefined): string {
  if (v === undefined) return written;
  if (/^(0x[0-9a-f]+|-?\d+)$/i.test(written)) return v === 0 ? '0 leader' : v > 0 && v < 8 && characters[v] ? `${v} ${characters[v]}` : String(v);
  return `${written}=${v}`;
}

function record(st: State, fr: Frame, offset: number, how: string, speaker: string, at: Node) {
  for (const m of st.msg) {
    if (m.v.t === 'num') {
      const n = m.v.n + offset;
      if (n >= 0 && n <= lastMessage) fr.res.shows.push({ n, tag: m.v.tag, fn: fr.fn.name, file: fr.fn.file, speaker, how, cond: m.cond });
      else fr.res.unresolved.push({ fn: fr.fn.name, file: fr.fn.file, line: at.startPosition.row + 1, why: `message ${n} out of range` });
    } else fr.res.unresolved.push({ fn: fr.fn.name, file: fr.fn.file, line: at.startPosition.row + 1, why: m.v.t === 'entry' ? 'the message set before the event' : 'a message the analysis cannot compute' });
  }
}

function flagOp(op: FlagOp['op'], arg: Node | undefined, st: State, fr: Frame) {
  if (!arg) return;
  for (const v of absEval(arg, st, fr)) {
    if (v.t !== 'num') {
      fr.res.dynamicFlags++;
      continue;
    }
    const n = v.n & 0xffff;
    fr.res.ops.push({ op, n, written: /^[A-Z_][A-Z0-9_]*$/.test(arg.text) ? arg.text : '', tag: v.tag, fn: fr.fn.name, file: fr.fn.file, sense: op === 'test' ? (fr.sense.get(n) ?? '?') : '', cond: [...st.pc] });
  }
}

// The literals a condition gives its true and false branches, and the sense
// in which it tests each flag.
function conditionLits(node: Node | null, st: State, fr: Frame): { t: Lit[]; f: Lit[] } {
  node = strip(node);
  const none = { t: [], f: [] };
  if (!node) return none;
  if (node.type === 'unary_expression' && node.childForFieldName('operator')?.text === '!') {
    const inner = conditionLits(node.childForFieldName('argument'), st, fr);
    return { t: inner.f, f: inner.t };
  }
  // A scene test. The parser knows no typedefs, so it reads
  // `scene == (s32)&SceneId_X` as `(scene == (s32)) & SceneId_X`: the
  // comparison is matched in the text.
  const text = node.text.replace(/\s+/g, ' ');
  const scene = text.match(/^(?:[\w.>-]*\bscene\b)\s*(==|!=)\s*((?:\(\s*\w+\s*\)\s*)?&?\s*SceneId_\w+)$/) ?? text.match(/^((?:\(\s*\w+\s*\)\s*)?&?\s*SceneId_\w+)\s*(==|!=)\s*(?:[\w.>-]*\bscene\b)$/);
  if (scene) {
    const [op, side] = scene[1].startsWith('=') || scene[1].startsWith('!') ? [scene[1], scene[2]] : [scene[2], scene[1]];
    const id = constEval(side, fr.tu.scope);
    if (id !== undefined) {
      const t = [{ k: `s${id}`, pos: true }];
      const f = [{ k: `s${id}`, pos: false }];
      return op === '==' ? { t, f } : { t: f, f: t };
    }
  }
  if (node.type === 'binary_expression') {
    const op = node.childForFieldName('operator')?.text;
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    if (op === '&&') {
      const a = conditionLits(left, st, fr);
      const b = conditionLits(right, st, fr);
      return { t: [...a.t, ...b.t], f: [] };
    }
    if (op === '||') {
      const a = conditionLits(left, st, fr);
      const b = conditionLits(right, st, fr);
      return { t: [], f: [...a.f, ...b.f] };
    }
    if (op === '==' || op === '!=') {
      const flip = (x: { t: Lit[]; f: Lit[] }) => (op === '==' ? { t: x.f, f: x.t } : x);
      for (const [a, b] of [[left, right], [right, left]] as [Node | null, Node | null][]) {
        if (!a || !b) continue;
        if (/SceneId_\w+/.test(a.text) && /scene/i.test(b.text)) {
          const id = constEval(a.text, fr.tu.scope);
          if (id !== undefined) {
            const t = [{ k: `s${id}`, pos: true }];
            const f = [{ k: `s${id}`, pos: false }];
            return op === '==' ? { t, f } : { t: f, f: t };
          }
        }
        if (constEval(a.text, fr.tu.scope) === 0) return flip(conditionLits(b, st, fr));
      }
      return none;
    }
    return none;
  }
  if (node.type === 'call_expression' && FLAG_TEST.has(callName(node))) {
    const vals = absEval(args(node)[0], st, fr);
    if (vals.length === 1 && vals[0].t === 'num') {
      const k = `f${vals[0].n & 0xffff}`;
      return { t: [{ k, pos: true }], f: [{ k, pos: false }] };
    }
  }
  return none;
}

function senses(lits: { t: Lit[]; f: Lit[] }): Map<number, string> {
  const m = new Map<number, string>();
  for (const l of lits.f) if (l.k[0] === 'f') m.set(Number(l.k.slice(1)), l.pos ? 'clear' : 'set');
  for (const l of lits.t) if (l.k[0] === 'f') m.set(Number(l.k.slice(1)), l.pos ? 'set' : 'clear');
  return m;
}

// Runs a condition: its calls first, then the two branch states.
function branch(cond: Node | null, st: State, fr: Frame): { t: State | null; f: State | null } {
  const lits = conditionLits(cond, st, fr);
  fr.sense = senses(lits);
  evalExpr(cond, st, fr);
  fr.sense = new Map();
  return { t: assume(clone(st), lits.t), f: assume(clone(st), lits.f) };
}

function evalExpr(node: Node | null, st: State, fr: Frame): void {
  if (!node) return;
  switch (node.type) {
    case 'call_expression':
      return evalCall(node, st, fr);
    case 'update_expression': {
      const arg = strip(node.childForFieldName('argument'));
      const d = node.text.includes('++') ? 1 : -1;
      if (arg?.type === 'field_expression' && arg.childForFieldName('field')?.text === 'message') shift(st, [{ t: 'num', n: d, tag: '' }]);
      else if (arg?.type === 'identifier' && st.env.has(arg.text)) st.env.set(arg.text, st.env.get(arg.text)!.map((v) => shiftVal(v, d)));
      else evalExpr(arg, st, fr);
      return;
    }
    case 'assignment_expression': {
      const left = strip(node.childForFieldName('left'));
      const right = node.childForFieldName('right');
      const op = node.childForFieldName('operator')?.text ?? '=';
      evalExpr(right, st, fr);
      const value = absEval(right, st, fr);
      if (left?.type === 'field_expression' && left.childForFieldName('field')?.text === 'message') {
        if (op === '=') st.msg = value.map((v) => ({ v, cond: [...st.pc] }));
        else if (op === '+=') shift(st, value);
        else if (op === '-=') shift(st, value.map((v) => (v.t === 'num' ? { ...v, n: -v.n } : UNKNOWN)));
        else st.msg = [{ v: UNKNOWN, cond: [...st.pc] }];
      } else if (left?.type === 'identifier' && st.env.has(left.text)) {
        const old = st.env.get(left.text)!;
        if (op === '=') st.env.set(left.text, value);
        else if (op === '+=' || op === '-=') {
          const s = op === '+=' ? 1 : -1;
          st.env.set(left.text, old.flatMap((o) => value.map((v) => (v.t === 'num' && o.t !== 'unknown' ? shiftVal(o, s * v.n) : UNKNOWN))).slice(0, 16));
        } else st.env.set(left.text, [UNKNOWN]);
      } else evalExpr(left, st, fr);
      return;
    }
    case 'conditional_expression': {
      const b = branch(node.childForFieldName('condition'), st, fr);
      if (b.t) evalExpr(node.childForFieldName('consequence'), b.t, fr);
      if (b.f) evalExpr(node.childForFieldName('alternative'), b.f, fr);
      const m = merge([b.t, b.f]);
      if (m) Object.assign(st, m);
      return;
    }
    default:
      for (const c of node.namedChildren) if (c) evalExpr(c, st, fr);
  }
}

function evalCall(node: Node, st: State, fr: Frame) {
  const name = callName(node);
  const a = args(node);
  if (!name) evalExpr(node.childForFieldName('function'), st, fr);
  for (const x of a) evalExpr(x, st, fr);
  if (SET_MESSAGE.has(name)) {
    st.msg = absEval(a[0], st, fr).map((v) => ({ v, cond: [...st.pc] }));
  } else if (SHOW_MESSAGE.has(name)) {
    record(st, fr, 0, 'show', speakerOf(a[0], st, fr), node);
    shift(st, [{ t: 'num', n: 1, tag: '' }]);
  } else if (ASK_MESSAGE.has(name)) {
    const speaker = speakerOf(a[0], st, fr);
    record(st, fr, 0, 'question', speaker, node);
    record(st, fr, 1, 'yes', speaker, node);
    record(st, fr, 2, 'no', speaker, node);
    shift(st, [{ t: 'num', n: 3, tag: '' }]);
  } else if (TWO_MESSAGES.has(name)) {
    record(st, fr, 0, 'show', speakerOf(a[0], st, fr), node);
    record(st, fr, 1, 'show', speakerOf(a[5], st, fr), node);
    shift(st, [{ t: 'num', n: 2, tag: '' }]);
  } else if (DIRECT_MESSAGE.has(name)) {
    const saved = st.msg;
    st.msg = absEval(a[0], st, fr).map((v) => ({ v, cond: [...st.pc] }));
    record(st, fr, 0, 'centered', '', node);
    st.msg = saved;
  } else if (name === 'Event_SkipMessages') {
    shift(st, absEval(a[0], st, fr));
  } else if (FLAG_SET.has(name)) flagOp('set', a[0], st, fr);
  else if (FLAG_CLEAR.has(name)) flagOp('clear', a[0], st, fr);
  else if (FLAG_TEST.has(name)) flagOp('test', a[0], st, fr);
  else {
    const callee = fr.tu.fns.get(name);
    if (!callee || fr.stack.includes(name) || fr.stack.length > 12) return;
    const env = new Map<string, Val[]>();
    const ptext = new Map<string, string>();
    callee.params.forEach((p, k) => {
      env.set(p, a[k] ? absEval(a[k], st, fr) : [UNKNOWN]);
      ptext.set(p, a[k] ? a[k].text.replace(/\b[A-Za-z_]\w*\b/g, (w) => fr.ptext.get(w) ?? w) : p);
    });
    const sub: Frame = { ...fr, fn: callee, ptext, stack: [...fr.stack, name], returns: [], breaks: [], sense: new Map() };
    const entry: State = { pc: [...st.pc], msg: st.msg.map((m) => ({ v: m.v, cond: [...m.cond] })), env };
    const end = merge([...sub.returns, execStmt(callee.body, entry, sub)]);
    if (end) {
      st.pc = end.pc;
      st.msg = end.msg;
    }
  }
}

function execBlock(nodes: Node[], st: State | null, fr: Frame): State | null {
  for (const n of nodes) {
    if (!st) return null;
    st = execStmt(n, st, fr);
  }
  return st;
}

function execStmt(node: Node | null, st: State, fr: Frame): State | null {
  if (!node) return st;
  const named = node.namedChildren.filter((c): c is Node => !!c && c.type !== 'comment');
  switch (node.type) {
    case 'compound_statement':
      return execBlock(named, st, fr);
    case 'expression_statement':
      for (const c of named) evalExpr(c, st, fr);
      return st;
    case 'declaration':
      for (const d of named) {
        if (d.type === 'init_declarator') {
          const value = d.childForFieldName('value');
          evalExpr(value, st, fr);
          st.env.set(declaredName(d.childForFieldName('declarator')), value && value.type !== 'initializer_list' ? absEval(value, st, fr) : [UNKNOWN]);
        } else if (/declarator$|^identifier$/.test(d.type)) st.env.set(declaredName(d), [UNKNOWN]);
      }
      return st;
    case 'if_statement': {
      const b = branch(node.childForFieldName('condition'), st, fr);
      const t = b.t ? execStmt(node.childForFieldName('consequence'), b.t, fr) : null;
      const alt = node.childForFieldName('alternative');
      const elseBody = alt?.type === 'else_clause' ? (alt.namedChildren.find((c) => c && c.type !== 'comment') ?? null) : alt;
      const f = !b.f ? null : elseBody ? execStmt(elseBody, b.f, fr) : b.f;
      return merge([t, f]);
    }
    case 'while_statement':
    case 'for_statement': {
      if (node.type === 'for_statement') {
        const init = node.childForFieldName('initializer');
        if (init?.type === 'declaration') execStmt(init, st, fr);
        else evalExpr(init, st, fr);
      }
      const cond = node.childForFieldName('condition');
      const b = cond ? branch(cond, st, fr) : { t: st, f: null };
      fr.breaks.push([]);
      const body = b.t ? execStmt(node.childForFieldName('body'), clone(b.t), fr) : null;
      if (body && node.type === 'for_statement') evalExpr(node.childForFieldName('update'), body, fr);
      const broke = fr.breaks.pop()!;
      const exit = cond ? merge([b.f, body ? assume(clone(body), conditionLits(cond, body, fr).f) : null]) : null;
      return merge([exit, ...broke]);
    }
    case 'do_statement': {
      fr.breaks.push([]);
      const body = execStmt(node.childForFieldName('body'), st, fr);
      const broke = fr.breaks.pop()!;
      if (!body) return merge(broke);
      const b = branch(node.childForFieldName('condition'), body, fr);
      return merge([b.f, ...broke]);
    }
    case 'switch_statement': {
      evalExpr(node.childForFieldName('condition'), st, fr);
      const cases = (node.childForFieldName('body')?.namedChildren ?? []).filter((c): c is Node => !!c && c.type === 'case_statement');
      const outs: (State | null)[] = [];
      let fall: State | null = null;
      let hasDefault = false;
      for (const c of cases) {
        const value = c.childForFieldName('value');
        if (!value) hasDefault = true;
        fr.breaks.push([]);
        const body = c.namedChildren.filter((x): x is Node => !!x && x !== value && x.type !== 'comment' && !(value && x.id === value.id));
        fall = execBlock(body, merge([clone(st), fall]), fr);
        outs.push(...fr.breaks.pop()!);
      }
      outs.push(fall);
      if (!hasDefault) outs.push(st);
      return merge(outs);
    }
    case 'return_statement':
      for (const c of named) evalExpr(c, st, fr);
      fr.onReturn?.(named[0] ?? null, st);
      fr.returns.push(st);
      return null;
    case 'break_statement':
      fr.breaks[fr.breaks.length - 1]?.push(st);
      return null;
    case 'continue_statement':
      return null;
    case 'labeled_statement':
      return execBlock(named.filter((c) => c.type !== 'statement_identifier'), st, fr);
    default:
      return st;
  }
}

function newResult(): Result {
  return { shows: [], ops: [], unresolved: [], dynamicFlags: 0 };
}

function run(tu: TU, fn: Fn, res: Result, onReturn?: Frame['onReturn']): State | null {
  const fr: Frame = { tu, fn, ptext: new Map(), stack: [fn.name], returns: [], breaks: [], res, sense: new Map(), onReturn };
  const env = new Map<string, Val[]>(fn.params.map((p) => [p, [UNKNOWN]]));
  const end = execStmt(fn.body, { pc: [], msg: [{ v: { t: 'entry', off: 0 }, cond: [] }], env }, fr);
  return merge([...fr.returns, end]);
}

// ---------------------------------------------------------------------------
// The scene tables: which scenes and flags choose each table (from the
// entry getters), and each event row's trigger, condition and value.

type Row = {
  tu: TU;
  table: string;
  index: number;
  trigger: string; // what starts it, as the player meets it
  kind: number;
  own: Lit[]; // its own condition
  lits: Lit[]; // its own condition, the table's and the earlier rows' failed ones
  handler?: string;
  message?: number;
  find?: string;
  scenes: number[];
};

const KIND_NAMES = ['talk', 'exit', 'touch', 'search', 'item', 'psynergy', 'raised'];
const ability = (text: string) => text.match(/ABILITY_(\w+)/)?.[1]?.toLowerCase().replace(/_/g, ' ') ?? '';

function conditionLit(v: number | undefined): Lit[] {
  if (v === undefined) return [];
  const c = v & 0xffff;
  if (c === 0xffff) return [];
  return [{ k: `f${c & 0xfff}`, pos: (c & 0x1000) !== 0 }];
}

type TableUse = { slot: string; scenes: number[]; lits: Lit[] }[];

function tableUses(tu: TU): Map<string, TableUse> {
  const uses = new Map<string, TableUse>();
  tu.entry.forEach((name, slot) => {
    const fn = slot ? tu.fns.get(name) : undefined;
    if (!fn) return;
    run(tu, fn, newResult(), (value, st) => {
      if (!value) return;
      for (const id of uniq([value, ...value.descendantsOfType('identifier')].map((x) => x?.text ?? ''))) {
        if (!tu.tables.has(id)) continue;
        const scenesHere = tu.scenes.filter((s) => st.pc.every((l) => l.k[0] !== 's' || (l.pos ? l.k === `s${s}` : l.k !== `s${s}`)));
        const list = uses.get(id) ?? [];
        list.push({ slot: ENTRY_SLOTS[slot], scenes: scenesHere, lits: st.pc.filter((l) => l.k[0] === 'f') });
        uses.set(id, list);
      }
    });
  });
  return uses;
}

const rowElems = (n: Node) => n.namedChildren.filter((c): c is Node => !!c && c.type !== 'comment');

// Splits tokens at their top-level commas.
function splitTop(toks: string[]): string[][] {
  const parts: string[][] = [[]];
  let level = 0;
  for (const t of toks) {
    if (t === '(' || t === '[' || t === '{') level++;
    if (t === ')' || t === ']' || t === '}') level--;
    if (t === ',' && level === 0) parts.push([]);
    else parts[parts.length - 1].push(t);
  }
  return parts.filter((p) => p.length);
}

// One macro of a token list replaced by its body, its arguments as written.
function expandOnce(toks: string[], scope: Scope): string[] {
  const m = scope.macro(toks[0]);
  if (!m) return toks;
  if (!m.params) return [...m.body, ...toks.slice(1)];
  if (toks[1] !== '(') return toks;
  let level = 0;
  let end = 1;
  for (; end < toks.length; end++) {
    if (toks[end] === '(') level++;
    else if (toks[end] === ')' && --level === 0) break;
  }
  const args = splitTop(toks.slice(2, end));
  const body: string[] = [];
  for (let k = 0; k < m.body.length; k++) {
    const i = m.params.indexOf(m.body[k]);
    if (m.body[k] === '#' && m.params.includes(m.body[k + 1] ?? '')) body.push(`"${(args[m.params.indexOf(m.body[++k])] ?? []).join(' ')}"`);
    else if (i >= 0) body.push(...(args[i] ?? []));
    else body.push(m.body[k]);
  }
  const pasted: string[] = [];
  for (let k = 0; k < body.length; k++) {
    if (body[k] === '##') pasted.push((pasted.pop() ?? '') + (body[++k] ?? ''));
    else pasted.push(body[k]);
  }
  return [...pasted, ...toks.slice(end + 1)];
}

// A table's rows, each as its elements' text: braced rows as written, and
// the rows a macro writes (TALK(actor, value), or a list of rows) expanded
// one macro at a time until they are braced.
function tableRowTexts(init: Node, scope: Scope): string[][] {
  const rows: string[][] = [];
  const visit = (toks: string[], depth: number) => {
    for (const item of splitTop(toks)) {
      if (item[0] === '{' && item[item.length - 1] === '}') rows.push(splitTop(item.slice(1, -1)).map((e) => e.join(' ').replace(/^\(\s*([\s\S]*?)\s*\)$/, '$1')));
      else if (depth < 8 && isIdent(item[0]) && scope.macro(item[0])) visit(expandOnce(item, scope), depth + 1);
    }
  };
  for (const e of rowElems(init)) visit(tokenize(e.text), 0);
  return rows;
}

function eventRows(tu: TU, uses: Map<string, TableUse>): Row[] {
  const rows: Row[] = [];
  for (const t of tu.tables.values()) {
    if (!/SceneEvent/.test(t.type)) continue;
    const use = uses.get(t.name) ?? [{ slot: 'events', scenes: tu.scenes, lits: [] }];
    const tableScenes = uniq(use.flatMap((u) => u.scenes));
    const tableLits = use[0].lits.filter((l) => use.every((u) => u.lits.some((m) => litKey(m) === litKey(l))));
    const earlier: { key: string; lits: Lit[] }[] = [];
    tableRowTexts(t.init, tu.scope).forEach((e, index) => {
      if (e.length < 4) return;
      const control = constEval(e[0], tu.scope);
      const trigger = constEval(e[1], tu.scope);
      if (control === undefined) return;
      const kind = control & 0xf;
      const own = conditionLit(constEval(e[2], tu.scope));
      const key = `${control >>> 0}:${trigger}`;
      // A row is reached only when the earlier rows for the same trigger did
      // not hold (Scene_FindEvent takes the first); a search ignores them.
      const failed = kind === 3 ? [] : earlier.filter((x) => x.key === key).flatMap((x) => (x.lits.length === 1 ? [{ k: x.lits[0].k, pos: !x.lits[0].pos }] : []));
      earlier.push({ key, lits: own });
      const handler = (e[3].match(/\b[A-Za-z_]\w*\b/g) ?? []).find((n) => tu.fns.has(n));
      const value = handler ? undefined : constEval(e[3], tu.scope);
      const triggerText = /^[A-Z_][A-Z0-9_]*$/.test(e[1]) ? `${e[1]}=${trigger}` : String(trigger ?? e[1]);
      let describe = KIND_NAMES[kind] ?? `kind ${kind}`;
      if (kind === 5) describe = `${ability(e[0]) || 'psynergy'}${control & 0x10 ? ' on' : ''}`;
      if (kind === 4) describe = `use ${e[0].match(/ITEM_(\w+)/)?.[1]?.toLowerCase().replace(/_/g, ' ') ?? 'item'}${control & 0x10 ? ' on' : ''}`;
      const row: Row = { tu, table: t.name, index, trigger: `${describe} ${triggerText}`, kind, own, lits: [...own, ...failed, ...tableLits], scenes: tableScenes, handler };
      if (value !== undefined && value !== 0 && kind !== 1) {
        if (kind === 3) {
          const what = (value >>> 20) & 0xf;
          if (what === 4) row.message = value & 0xffff;
          else row.find = ['', 'item', 'coins', 'Psynergy Stone', '', 'mimic'][what] ?? '';
        } else if (value < 0x10000) row.message = value;
      }
      rows.push(row);
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Running every scene's events.

type Root = { tu: TU; fn: Fn; kinds: string[]; rows: Row[]; scenes: number[]; res: Result };
type Ref = { file: string; where: string; n: number; indexed: boolean };

const roots: Root[] = [];
const tableRows: Row[] = [];
const flagSites: { n: number; scenes: number[]; global: boolean; op: 'set' | 'clear' | 'test'; site: string; sense: string; written: string }[] = [];
const refs: Ref[] = [];
const exitsOfScene = new Map<number, string[]>();

// Message symbols a function or table names, wherever they go: the sites of
// the messages the analysis cannot follow to a show command.
function messageRefs(root: Node, file: string, where: (n: Node) => string, scope: Scope) {
  for (const id of root.descendantsOfType('identifier')) {
    if (!id || !messageBySymbol.has(id.text)) continue;
    let cur: Node = id;
    let indexed = false;
    for (let p = cur.parent; p; p = p.parent) {
      if (p.type === 'call_expression' && callName(p) === 'MSGNO') {
        cur = p;
        continue;
      }
      if (!['binary_expression', 'parenthesized_expression', 'cast_expression'].includes(p.type)) break;
      if (p.type === 'binary_expression' && !['+', '-'].includes(p.childForFieldName('operator')?.text ?? '')) break;
      if (constEval(p.text, scope) === undefined) {
        indexed = true;
        break;
      }
      cur = p;
    }
    const n = constEval(cur.text, scope) ?? messageBySymbol.get(id.text)!;
    refs.push({ file, where: where(id), n, indexed });
  }
}

function enclosingFunction(n: Node): string {
  for (let p: Node | null = n; p; p = p.parent) {
    if (p.type === 'function_definition') return declaredName(p.childForFieldName('declarator'));
    if (p.type === 'declaration' && !p.parent?.type.includes('compound')) return declaredName(p.descendantsOfType('init_declarator')[0]?.childForFieldName('declarator') ?? null);
  }
  return '';
}

for (const tu of tus) {
  const uses = tableUses(tu);
  const rows = eventRows(tu, uses);
  tableRows.push(...rows.filter((r) => r.message !== undefined || r.find));

  // Which functions start something: the entry veneers, the event tables'
  // scripts, the functions handed on as callbacks or listed in data, and the
  // ones nothing calls.
  const kinds = new Map<string, string[]>();
  const add = (fn: string, k: string) => kinds.set(fn, uniq([...(kinds.get(fn) ?? []), k]));
  tu.entry.forEach((fn, k) => add(fn, `entry ${ENTRY_SLOTS[k] ?? k}`));
  for (const r of rows) if (r.handler) add(r.handler, r.trigger);
  const called = new Set<string>();
  for (const fn of tu.fns.values()) {
    for (const id of fn.body.descendantsOfType('identifier')) {
      if (!id || !tu.fns.has(id.text) || id.text === fn.name) continue;
      const p = id.parent;
      if (p?.type === 'call_expression' && p.childForFieldName('function')?.id === id.id) called.add(id.text);
      else add(id.text, `callback from ${fn.name}`);
    }
  }
  for (const t of tu.tables.values()) {
    if (/SceneEvent/.test(t.type)) continue;
    for (const id of t.init.descendantsOfType('identifier')) if (id && tu.fns.has(id.text)) add(id.text, `listed in ${t.name}`);
  }
  for (const fn of tu.fns.values()) if (!kinds.has(fn.name) && !called.has(fn.name)) add(fn.name, 'not called');

  const rowsOf = new Map<string, Row[]>();
  for (const r of rows) if (r.handler) rowsOf.set(r.handler, [...(rowsOf.get(r.handler) ?? []), r]);
  for (const [name, k] of [...kinds].sort((a, b) => (tu.fns.get(a[0])?.line ?? 0) - (tu.fns.get(b[0])?.line ?? 0) || (a[0] < b[0] ? -1 : 1))) {
    const fn = tu.fns.get(name);
    if (!fn) continue;
    const res = newResult();
    run(tu, fn, res);
    const rs = rowsOf.get(name) ?? [];
    roots.push({ tu, fn, kinds: k, rows: rs, scenes: rs.length ? uniq(rs.flatMap((r) => r.scenes)) : tu.scenes, res });
  }

  // Flags the tables test: event and placement conditions, exits and
  // entrances that need a flag, and the chests that set theirs.
  const file = shortFile(tu.file);
  for (const r of rows) {
    for (const l of r.own) {
      const n = Number(l.k.slice(1));
      const site = `${file}:${r.table}[${r.trigger}]`;
      flagSites.push({ n, scenes: r.scenes, global: false, op: 'test', site, sense: l.pos ? 'set' : 'clear', written: '' });
      if (r.kind === 3 && r.find) flagSites.push({ n, scenes: r.scenes, global: false, op: 'set', site: `${site} when found`, sense: '', written: '' });
    }
  }
  for (const t of tu.tables.values()) {
    const use = uses.get(t.name);
    const tScenes = use ? uniq(use.flatMap((u) => u.scenes)) : tu.scenes;
    if (/ScenePlacement/.test(t.type)) {
      tableRowTexts(t.init, tu.scope).forEach((e, i) => {
        if (e.length < 2) return;
        for (const l of conditionLit(constEval(e[1], tu.scope))) {
          const n = Number(l.k.slice(1));
          if (n < 48 && !l.pos) continue;
          flagSites.push({ n, scenes: tScenes, global: false, op: 'test', site: `${file}:${t.name}[actor ${8 + i}]`, sense: l.pos ? 'set' : 'clear', written: '' });
        }
      });
    } else if (/SceneEntrance/.test(t.type)) {
      tableRowTexts(t.init, tu.scope).forEach((e) => {
        const flag = e.length > 1 ? constEval(e[1], tu.scope) : undefined;
        if (flag !== undefined && flag !== -1 && (flag & 0xffff) !== 0xffff) flagSites.push({ n: flag & 0xffff, scenes: tScenes, global: false, op: 'test', site: `${file}:${t.name}[entrance ${e[0]}]`, sense: 'set', written: '' });
      });
    } else if (use?.some((u) => u.slot === 'exits')) {
      // An exit table: a header word per scene, then its exits.
      const words = rowElems(t.init).flatMap((e) => evalWords(e.text, tu.scope));
      let scene = -1;
      for (let i = 0; i < words.length; i++) {
        const w = (words[i] ?? 0) >>> 0;
        if ((w & ~0xfff) === 0) {
          scene = w === 0x1ff ? -1 : w;
          continue;
        }
        const flag = w & 0x10000000 ? (words[++i] ?? 0) : 0;
        const target = w & 0xfff;
        const kind = (w >>> 20) & 0xff;
        const entrance = (w >>> 12) & 0xff;
        if (scene < 0) continue;
        const list = exitsOfScene.get(scene) ?? [];
        list.push(`exit ${kind === 0xff ? 'any' : kind} to ${sceneLabel(target)} entrance ${entrance}${flag ? ` while ${flagLabel(flag, tu)} clear` : ''}`);
        exitsOfScene.set(scene, list);
        if (flag) flagSites.push({ n: flag & 0xffff, scenes: [scene], global: false, op: 'test', site: `${file}:${t.name}[exit ${kind}]`, sense: 'clear', written: '' });
      }
    }
  }
  for (const f of uniq([...tu.fns.values()].map((x) => x.file))) {
    messageRefs(parseC(f), shortFile(f), (n) => enclosingFunction(n), tu.scope);
  }
}

// The rest of the game's C: messages its functions and tables name, and the
// flags they set, clear and test by number.
const otherFiles = walkFiles(`${GAME}/src`, (n) => /\.[ch]$/.test(n)).filter((f) => !f.startsWith(`${GAME}/src/scene/`));
for (const f of otherFiles) {
  const root = parseC(f);
  const scope = new Scope(globalScope);
  collectConstants(root, scope);
  for (const inc of root.descendantsOfType('preproc_include')) {
    const p = inc?.childForFieldName('path');
    if (p?.type !== 'string_literal') continue;
    const target = join(dirname(f), p.text.slice(1, -1));
    if (target.startsWith(`${GAME}/src/`) && existsSync(join(repo, target)) && target.endsWith('.h')) collectConstants(parseC(target), scope);
  }
  resolveEnums();
  messageRefs(root, shortFile(f), (n) => enclosingFunction(n), scope);
  for (const call of root.descendantsOfType('call_expression')) {
    if (!call) continue;
    const name = callName(call);
    const op = FLAG_SET.has(name) ? 'set' : FLAG_CLEAR.has(name) ? 'clear' : FLAG_TEST.has(name) ? 'test' : null;
    const arg = op ? args(call)[0] : undefined;
    if (!op || !arg) continue;
    const n = constEval(arg.text, scope);
    if (n === undefined) continue;
    let sense = '';
    if (op === 'test') {
      const p = call.parent;
      const negated = (p?.type === 'unary_expression' && p.text.startsWith('!')) || (p?.type === 'binary_expression' && p.childForFieldName('operator')?.text === '==' && constEval((p.childForFieldName('right')?.id === call.id ? p.childForFieldName('left') : p.childForFieldName('right'))?.text ?? '', scope) === 0);
      sense = negated ? 'clear' : p?.type === 'parenthesized_expression' || p?.type === 'binary_expression' ? 'set' : '?';
    }
    flagSites.push({ n: n & 0xffff, scenes: [], global: true, op, site: `${shortFile(f)}:${enclosingFunction(call)}`, sense, written: /^[A-Z_][A-Z0-9_]*$/.test(arg.text) ? arg.text : '' });
  }
}

// ---------------------------------------------------------------------------
// Flags: their keys, names and labels. A scene flag (0x200 to 0x2ff) is one
// per scene and a place flag (0x300 to 0x3ff) one per place group, so they
// are keyed by those; the rest are the game's.

function flagKeys(n: number, sceneIds: number[], global = false): string[] {
  if (global || n < 0x200 || n >= 0x400) return [hex(n)];
  if (n < 0x300) return uniq(sceneIds.map((s) => `${hex(n)}@${scenes[s]?.name || `scene${s}`}`));
  return uniq(sceneIds.map((s) => `${hex(n)}@group${scenes[s]?.group}`));
}

function flagLabel(n: number, tu?: TU): string {
  const global = flagDocs.get(n)?.names[0];
  if (global && (n < 0x200 || n >= 0x400 || /^FLAG_SCENE_TEMP_/.test(global))) return global;
  if (tu) {
    let local = localFlagNames.get(tu.file);
    if (!local) {
      local = new Map();
      for (const [name] of tu.scope.macros) {
        if (!/^FLAG_/.test(name) || tu.scope.macros.get(name)!.params) continue;
        const v = constEval(name, tu.scope);
        if (v !== undefined && !local.has(v) && flagDocs.get(v)?.names[0] !== name) local.set(v, name);
      }
      for (const [name, v] of tu.scope.values) if (/^FLAG_/.test(name) && !local.has(v)) local.set(v, name);
      localFlagNames.set(tu.file, local);
    }
    if (local.has(n)) return local.get(n)!;
  }
  return global ?? (n < 0x200 || n >= 0x400 ? globalFlagNames().get(n) : undefined) ?? hex(n);
}

// FLAG_ names the shared headers declare outside flags.h, as field_scene.h
// does FLAG_PARTY_LEFT_VALE.
function globalFlagNames(): Map<number, string> {
  if (globalFlagNamesCache) return globalFlagNamesCache;
  const names = new Map<number, string>();
  for (const [name, v] of globalScope.values) if (/^FLAG_/.test(name) && !names.has(v)) names.set(v, name);
  for (const [name, m] of globalScope.macros) {
    if (!/^FLAG_/.test(name) || m.params) continue;
    const v = constEval(name, globalScope);
    if (v !== undefined && !names.has(v)) names.set(v, name);
  }
  return (globalFlagNamesCache = names);
}

const litLabel = (l: Lit, tu?: TU) => (l.k[0] === 's' ? `${l.pos ? '' : 'not '}scene ${sceneLabel(Number(l.k.slice(1)))}` : `${flagLabel(Number(l.k.slice(1)), tu)} ${l.pos ? 'set' : 'clear'}`);
const condText = (lits: Lit[], tu?: TU) => lits.map((l) => litLabel(l, tu)).join(' and ');

// The scenes a site runs in: the event's, narrowed by the scene tests on its
// path.
const narrow = (ids: number[], cond: Lit[]) => {
  const pos = cond.filter((l) => l.k[0] === 's' && l.pos).map((l) => Number(l.k.slice(1)));
  const neg = cond.filter((l) => l.k[0] === 's' && !l.pos).map((l) => Number(l.k.slice(1)));
  const r = ids.filter((s) => (!pos.length || pos.includes(s)) && !neg.includes(s));
  return r.length ? r : ids;
};

const fnLabel = (tag: string, fn: string) => (tag && tag !== fn ? `${tag}>${fn}` : fn);

for (const r of roots) {
  for (const o of r.res.ops) {
    flagSites.push({ n: o.n, scenes: narrow(r.scenes, o.cond), global: false, op: o.op, site: `${shortFile(r.tu.fns.get(o.tag)?.file ?? o.file)}:${fnLabel(o.tag, o.fn)}`, sense: o.sense, written: o.written });
  }
}

// ---------------------------------------------------------------------------
// Writing the tables.

mkdirSync(out, { recursive: true });

// messages.tsv
type Site = { text: string; scenes: number[] };
const sitesOf = new Map<number, Site[]>();
const addSite = (n: number, s: Site) => {
  const list = sitesOf.get(n) ?? [];
  if (!list.some((x) => x.text === s.text)) list.push(s);
  sitesOf.set(n, list);
};
for (const r of roots) {
  for (const s of r.res.shows) {
    const c = s.cond.length ? ` [${condText(s.cond, r.tu)}]` : '';
    const file = shortFile(r.tu.fns.get(s.tag)?.file ?? s.file);
    addSite(s.n, { text: `${file}:${fnLabel(s.tag, s.fn)}(${s.speaker})${s.how !== 'show' ? ` ${s.how}` : ''}${c}`, scenes: narrow(r.scenes, s.cond) });
  }
}
for (const r of tableRows) {
  if (r.message === undefined) continue;
  const c = r.lits.length ? ` [${condText(r.lits, r.tu)}]` : '';
  addSite(r.message, { text: `${shortFile(r.tu.file)}:${r.table}[${r.trigger}]${c}`, scenes: r.scenes });
}
const shown = new Set(sitesOf.keys());
const refsOf = new Map<number, Ref[]>();
{
  const seen = new Set<string>();
  for (const r of refs) {
    const key = `${r.file}:${r.where}:${r.n}:${r.indexed}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refsOf.set(r.n, [...(refsOf.get(r.n) ?? []), r]);
  }
}

// Why a message has no site: its nearest named message before it, and how
// the code reaches that one.
const named = messages.filter((m) => m.symbol !== 'message');
const indexedBy = new Map<number, string[]>();
for (const r of refs) if (r.indexed) indexedBy.set(r.n, uniq([...(indexedBy.get(r.n) ?? []), `${r.file}:${r.where}`]));
const baseOf = (n: number) => {
  let lo = 0;
  let hi = named.length - 1;
  let best: Message | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (named[mid].id <= n) {
      best = named[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
};

const reasons = new Map<string, number>();
const messageRows: (string | number)[][] = [];
for (const m of messages) {
  const sites = sitesOf.get(m.id) ?? [];
  let note = '';
  let siteText = sites.map((s) => s.text).sort().join('; ');
  let places = placeOfScenes(sites.flatMap((s) => s.scenes));
  if (!sites.length) {
    const rs = (refsOf.get(m.id) ?? []).filter((r) => !r.indexed);
    const base = baseOf(m.id);
    let reason: string;
    if (rs.length) {
      siteText = uniq(rs.map((r) => `${r.file}:${r.where} ref`)).sort().join('; ');
      const scenesOfRefs = uniq(rs.flatMap((r) => scenesOfFile.get(`${GAME}/src/${r.file}`) ?? []));
      places = placeOfScenes(scenesOfRefs);
      reason = rs.every((r) => !r.file.startsWith('scene/')) ? 'named by code outside the scenes (the main program or a menu overlay), which shows it itself' : 'named in a scene, but not followed to a show command';
    } else if (indexedBy.has(m.id) || (base && base.id !== m.id && indexedBy.has(base.id))) {
      // A name table and the like: the code adds a computed index.
      const first = indexedBy.has(m.id) ? m : base!;
      reason = 'in a table the code indexes by a computed number';
      note = `${first.symbol} + ${m.id - first.id}, indexed by ${indexedBy.get(first.id)!.slice(0, 3).join(', ')}`;
    } else if (base && base.id !== m.id && shown.has(base.id)) {
      reason = 'after a shown message, reached by a count the analysis cannot follow (or never)';
      note = `${base.symbol} + ${m.id - base.id}`;
    } else if (base && base.id !== m.id && refsOf.has(base.id)) {
      reason = 'after a message code outside the scenes names';
      note = `${base.symbol} + ${m.id - base.id}`;
    } else if (m.symbol !== 'message') {
      reason = 'named, but no C names it';
    } else {
      reason = 'after a named message that no C names either';
      if (base) note = `${base.symbol} + ${m.id - base.id}`;
    }
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    note = note ? `${reason}: ${note}` : reason;
  }
  messageRows.push([msgNo(m.id), m.symbol, oneLine(m.text), siteText, places, note]);
}
tsv('messages.tsv', ['number', 'symbol', 'text', 'sites', 'places', 'note'], messageRows);

// flags.tsv
type FlagRow = { key: string; n: number; names: Set<string>; set: Set<string>; clear: Set<string>; test: Set<string> };
const flagRows = new Map<string, FlagRow>();
for (const s of flagSites) {
  for (const key of flagKeys(s.n, s.scenes.length ? s.scenes : [], s.global || !s.scenes.length)) {
    const row = flagRows.get(key) ?? { key, n: s.n, names: new Set(), set: new Set(), clear: new Set(), test: new Set() };
    if (s.written) row.names.add(s.written);
    row[s.op].add(s.op === 'test' ? `${s.site}:${s.sense || '?'}` : s.site);
    flagRows.set(key, row);
  }
}
const flagList = [...flagRows.values()].sort((a, b) => a.n - b.n || (a.key < b.key ? -1 : 1));
tsv(
  'flags.tsv',
  ['flag', 'number', 'names', 'note', 'set by', 'cleared by', 'tested by'],
  flagList.map((r) => {
    const doc = flagDocs.get(r.n);
    const global = r.n < 0x200 || r.n >= 0x400;
    const names = uniq([...(global || /^FLAG_SCENE_TEMP/.test(doc?.names[0] ?? '') ? (doc?.names ?? []) : []), ...r.names]);
    return [r.key, hex(r.n), names.join(', '), global && doc ? [doc.section, doc.doc].filter(Boolean).join(': ') : '', [...r.set].sort().join('; '), [...r.clear].sort().join('; '), [...r.test].sort().join('; ')];
  }),
);

// events.tsv
type EventRow = {
  file: string;
  tu: TU;
  scenes: number[];
  event: string;
  trigger: string;
  condition: string;
  rowLits: Lit[];
  tests: string[];
  sets: string[];
  clears: string[];
  messages: number[];
  effects: { cond: Lit[]; n?: number; set?: number; clear?: number }[];
  line: number;
};
const events: EventRow[] = [];
const isGetter = (r: Root) => r.kinds.every((k) => /^entry (entrances|exits|placements|events|regions)$/.test(k));
const common = (lists: Lit[][]) => (lists.length ? lists[0].filter((l) => lists.every((x) => x.some((y) => litKey(y) === litKey(l)))) : []);
for (const r of roots) {
  if (isGetter(r)) continue;
  const res = r.res;
  const isEvent = r.rows.length > 0 || r.kinds.includes('entry initialize');
  if (!isEvent && !res.shows.length && !res.ops.length) continue;
  const label = (o: FlagOp) => flagLabel(o.n, r.tu) + (o.op === 'test' ? `:${o.sense || '?'}` : '');
  events.push({
    file: shortFile(r.fn.file),
    tu: r.tu,
    scenes: r.scenes,
    event: r.fn.name,
    trigger: r.kinds.join('; '),
    condition: r.rows.map((x) => (x.lits.length ? `${x.trigger}: ${condText(x.lits, r.tu)}` : '')).filter(Boolean).join(' | '),
    rowLits: r.rows.length ? common(r.rows.map((x) => x.lits)) : [],
    tests: uniq(res.ops.filter((o) => o.op === 'test').map(label)),
    sets: uniq(res.ops.filter((o) => o.op === 'set').map(label)),
    clears: uniq(res.ops.filter((o) => o.op === 'clear').map(label)),
    messages: uniq(res.shows.map((s) => s.n)),
    effects: [...res.shows.map((s) => ({ cond: s.cond, n: s.n })), ...res.ops.filter((o) => o.op !== 'test').map((o) => (o.op === 'set' ? { cond: o.cond, set: o.n } : { cond: o.cond, clear: o.n }))],
    line: r.fn.line,
  });
}
for (const t of tableRows) {
  if (t.message === undefined) continue;
  events.push({
    file: shortFile(t.tu.file),
    tu: t.tu,
    scenes: t.scenes,
    event: `${t.table}[${t.index}]`,
    trigger: t.trigger,
    condition: condText(t.lits, t.tu),
    rowLits: t.lits,
    tests: t.lits.filter((l) => l.k[0] === 'f').map((l) => `${flagLabel(Number(l.k.slice(1)), t.tu)}:${l.pos ? 'set' : 'clear'}`),
    sets: [],
    clears: [],
    messages: [t.message],
    effects: [{ cond: [], n: t.message }],
    line: t.tu.tables.get(t.table)!.line + t.index,
  });
}
events.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.event < b.event ? -1 : 1)));
const sceneList = (ids: number[]) => sortNum(ids).map(sceneLabel).join(', ');
tsv(
  'events.tsv',
  ['file', 'scenes', 'place', 'event', 'trigger', 'condition', 'requires', 'tests', 'sets', 'clears', 'messages'],
  events.map((e) => {
    // What everything the event shows or changes needs: the tests on all its
    // paths that hold for each of them.
    const needs = e.effects.length ? common(e.effects.map((x) => x.cond)) : [];
    const where = narrow(e.scenes, needs);
    return [e.file, sceneList(where), placeOfScenes(where), e.event, e.trigger, e.condition, condText(needs.filter((l) => l.k[0] === 'f'), e.tu), e.tests.join(', '), e.sets.join(', '), e.clears.join(', '), e.messages.map(msgNo).join(', ')];
  }),
);

// places.tsv, when no place table was given.
if (!tableAreas) {
  tsv(
    'places.tsv',
    ['scene', 'name', 'file', 'group', 'area name', 'area messages', 'exits'],
    scenes.map((s) => {
      const a = derivedAreas.get(s.id);
      const names = a ? [...a.byEntrance.map(([e, n]) => `${e}=${n}`), a.byEntrance.length ? `*=${a.fallback}` : a.fallback].join('; ') : '';
      return [s.id, s.name, s.file ? shortFile(s.file) : '', s.group, names, (a?.messages ?? []).map(msgNo).join(', '), (exitsOfScene.get(s.id) ?? []).join('; ')];
    }),
  );
}

// ---------------------------------------------------------------------------
// glossary.tsv: the capitalised names of the text (a word that is
// capitalised where no sentence starts, and the runs of such words), the
// names of the game's name tables, and the words of the place names that the
// text also writes in lower case ("barricade").

const NAME_TABLES: [string, string][] = [
  ['MsgCharacterName', 'character'],
  ['MsgItemPlainName', 'item'],
  ['MsgItemName', 'item'],
  ['MsgEnemyName', 'enemy'],
  ['MsgAbilityName', 'ability'],
  ['MsgDjinnName', 'djinni'],
  ['MsgClassName', 'class'],
];
const plain = (text: string) =>
  text
    .replace(/\{actor_name:(\d+)\}/g, (_, n: string) => ` ${characters[Number(n) - 1] ?? ''} `)
    .replace(/\{possessive_suffix\}/g, "'s")
    .replace(/\{page_break\}|\{end_wait\}|\{end_now\}/g, ' ¶ ')
    .replace(/\{em_dash\}/g, ' — ')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const nameKinds = new Map<string, Set<string>>();
const definedIn = new Map<string, Set<number>>();
const tableMessage = new Set<number>();
const addName = (name: string, kind: string, id: number) => {
  if (!name || !/[A-Za-z]/.test(name)) return;
  nameKinds.set(name, new Set([...(nameKinds.get(name) ?? []), kind]));
  definedIn.set(name, new Set([...(definedIn.get(name) ?? []), id]));
  tableMessage.add(id);
};
for (const [symbol, kind] of NAME_TABLES) {
  const start = messageBySymbol.get(symbol);
  if (start === undefined) continue;
  const end = named.find((m) => m.id > start)?.id ?? start + 1;
  for (let id = start; id < end; id++) addName(plain(messageById.get(id)?.text ?? '').replace(/ ¶$/, ''), kind, id);
}
for (const a of derivedAreas.values()) for (const id of a.messages) addName(oneLine(messageById.get(id)?.text ?? ''), 'place', id);
characters.forEach((c) => c && nameKinds.set(c, new Set([...(nameKinds.get(c) ?? []), 'character'])));

const ARTICLES = new Set(['The', 'A', 'An']);
const ABBREVIATIONS = new Set(['Mt', 'Mr', 'Mrs', 'Ms', 'Dr', 'St']);
const NOT_NAMES = new Set(['I', "I'm", "I'll", "I've", "I'd", 'OK', 'Ok']);
const WORD = /[A-Za-z0-9][A-Za-z0-9'’-]*[A-Za-z0-9]|[A-Za-z0-9]|\.{3}|…|¶|—|[.!?:;,"“”()]/g;
type Occ = { msg: number; initial: boolean; inSentence: boolean };
const occurrences = new Map<string, Occ[]>();
const lowerWords = new Map<string, Set<number>>();
const textOf = new Map<number, string>();
const note = (term: string, o: Occ) => occurrences.set(term, [...(occurrences.get(term) ?? []), o]);
const stem = (w: string) => w.replace(/['’]s$|['’]$/, '');
const isCap = (w: string | undefined) => !!w && /^[A-Z]/.test(w) && /[a-z]/.test(w) && !NOT_NAMES.has(w);

for (const m of messages) {
  if (tableMessage.has(m.id)) continue;
  const text = plain(m.text);
  textOf.set(m.id, text);
  const toks = [...text.matchAll(WORD)].map((x) => x[0]);
  let initial = true;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (/^[.!?¶…:"“”]$|^\.{3}$/.test(t)) {
      if (!(t === '.' && ABBREVIATIONS.has(toks[i - 1] ?? ''))) initial = true;
      continue;
    }
    if (!/^[A-Za-z0-9]/.test(t)) continue;
    if (/^[a-z]/.test(t)) lowerWords.set(t.toLowerCase(), new Set([...(lowerWords.get(t.toLowerCase()) ?? []), m.id]));
    if (!isCap(t)) {
      initial = false;
      continue;
    }
    // A run of capitalised words, joined by "of" or an abbreviation's stop.
    const run: string[] = [t];
    let j = i + 1;
    for (;;) {
      if (toks[j] === '.' && ABBREVIATIONS.has(run[run.length - 1]) && isCap(toks[j + 1])) {
        run[run.length - 1] += '.';
        run.push(toks[j + 1]);
        j += 2;
      } else if (isCap(toks[j])) {
        run.push(toks[j]);
        j++;
      } else if (toks[j] === 'of' && isCap(toks[j + 1])) {
        run.push('of', toks[j + 1]);
        j += 2;
      } else break;
    }
    run[run.length - 1] = stem(run[run.length - 1]);
    // A leading article is not part of the name ("The Gang of Three").
    let lead = initial;
    if (run.length > 1 && ARTICLES.has(run[0])) {
      run.shift();
      lead = false;
    }
    initial = lead;
    // Whether a word goes on into its sentence, as a name does ("Jill gave")
    // and an exclamation does not ("Cripes!").
    const goesOn = /^[A-Za-z0-9]/.test(toks[j] ?? '');
    for (let k = 0; k < run.length; k++) if (run[k] !== 'of') note(stem(run[k].replace(/\.$/, '')), { msg: m.id, initial: initial && k === 0, inSentence: k < run.length - 1 || goesOn });
    if (run.length > 1) note(run.join(' ').replace(/['’]s(?= )/g, "'s"), { msg: m.id, initial, inSentence: goesOn });
    initial = false;
    i = j - 1;
  }
}

// People the scenes name: the actor constants the code makes speak or be
// talked to (JILL, ACTOR_LORD_MCCOY), read as words ("Jill", "Lord McCoy").
const actorNames = new Map<string, Set<string>>(); // lower-case phrase → file:CONSTANT
const addActor = (file: string, ident: string) => {
  const phrase = ident.replace(/^ACTOR_/, '').replace(/_\d+$/, '').replace(/_/g, ' ').toLowerCase();
  if (phrase.length < 3) return;
  actorNames.set(phrase, new Set([...(actorNames.get(phrase) ?? []), `${file}:${ident}`]));
};
for (const r of roots) for (const sh of r.res.shows) for (const m of sh.speaker.matchAll(/\b([A-Z][A-Z0-9_]*)=/g)) addActor(shortFile(r.tu.file), m[1]);
for (const r of tableRows) for (const m of r.trigger.matchAll(/\b([A-Z][A-Z0-9_]*)=/g)) if (r.kind === 0 || r.kind === 5) addActor(shortFile(r.tu.file), m[1]);

// A single word is a name when an actor constant or a name table names it,
// when the text capitalises it where no sentence starts more often than it
// writes it in lower case, or when the text never writes it in lower case and
// it goes on into a sentence. A run is a name when its first word is one or
// the run stands mid-sentence; a sentence's leading common words ("But
// Isaac") are dropped from it. Interjections ("Hmm", a letter three times)
// are not names.
const INTERJECTIONS = new Set(['Hmm', 'Hm', 'Huh', 'Heh', 'Hah', 'Ha', 'Eh', 'Uh', 'Um', 'Ah', 'Aw', 'Oh', 'Ow', 'Ugh', 'Whoa', 'Wow', 'Yay', 'Phew', 'Shh', 'Psst', 'Hey', 'Yo', 'Er', 'Erm', 'Ooh', 'Hmph', 'Gah', 'Bah', 'Argh', 'Arg', 'Eek', 'Yikes', 'Gulp', 'Sigh', 'Tsk', 'Oops', 'Ahem', 'Grr', 'Ack', 'Hya', 'Hyah', 'Yah', 'Haa', 'Hoo', 'Huff', 'Pant', 'Wha', 'Whew', 'Yeah', 'Yep', 'Nope', 'Okay', 'Hello', 'Hi', 'Bye', 'Goodbye', 'Thanks', 'Ok']);
const interjection = (w: string) => INTERJECTIONS.has(w) || /(.)\1\1/i.test(w) || !/[aeiouy]/i.test(w) || /^([a-z]{1,3})-\1/i.test(w) || /['’](d|ll|re|ve|m)$/i.test(w);
const isNameWord = (w: string) => {
  if (nameKinds.has(w) || actorNames.has(w.toLowerCase())) return true;
  const occ = occurrences.get(w) ?? [];
  const lower = lowerWords.get(w.toLowerCase())?.size ?? 0;
  if (occ.filter((o) => !o.initial).length > lower) return true;
  return lower === 0 && w.length > 2 && !interjection(w) && occ.some((o) => o.inSentence);
};
const kindOf = (term: string) => {
  const k = [...(nameKinds.get(term) ?? [])];
  if (actorNames.has(term.toLowerCase())) k.push('person');
  return (k.length ? k : ['name']).join(', ');
};
const terms = new Map<string, string>(); // term → kind
for (const [whole, occ] of occurrences) {
  // A run's leading common words ("But Isaac") are not part of the name.
  const parts = whole.split(' ');
  if (occ.every((o) => o.initial)) while (parts.length > 1 && !isNameWord(parts[0]) && lowerWords.has(parts[0].toLowerCase())) parts.shift();
  const term = parts.join(' ');
  const words = parts.filter((w) => w !== 'of');
  if (/^\d/.test(term) || terms.has(term)) continue;
  if (words.length === 1) {
    if (isNameWord(term)) terms.set(term, kindOf(term));
  } else if (occ.some((o) => !o.initial) || isNameWord(words[0])) {
    terms.set(term, kindOf(term));
  } else if (isNameWord(words[1] ?? '')) {
    const rest = term.split(' ').slice(1).join(' ');
    if (rest.split(' ').length > 1 && !terms.has(rest)) terms.set(rest, kindOf(rest));
  }
}
for (const name of nameKinds.keys()) if (!terms.has(name)) terms.set(name, kindOf(name));
for (const id of uniq([...derivedAreas.values()].flatMap((a) => a.messages))) {
  for (const w of oneLine(messageById.get(id)?.text ?? '').split(/[\s']+/)) {
    const lw = w.toLowerCase().replace(/[^a-z]/g, '');
    if (lw.length > 3 && lowerWords.has(lw) && !terms.has(lw)) terms.set(lw, 'place word');
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const glossaryRows: (string | number)[][] = [];
for (const [term, kind] of [...terms].sort((a, b) => a[0].localeCompare(b[0], 'en', { sensitivity: 'base' }) || (a[0] < b[0] ? -1 : 1))) {
  const lower = kind === 'place word';
  const re = new RegExp(`(?<![A-Za-z0-9])${escapeRe(term)}${lower ? '(?:s|es)?' : "(?:['’]s)?"}(?![A-Za-z0-9])`, lower ? 'i' : '');
  const first = term.split(/[\s'’]/)[0].toLowerCase();
  const candidates = lower ? [...textOf.keys()] : [...textOf.keys()].filter((id) => textOf.get(id)!.toLowerCase().includes(first));
  const found = candidates.filter((id) => re.test(textOf.get(id)!));
  const defined = sortNum([...(definedIn.get(term) ?? [])]);
  if (!found.length && !defined.length) continue;
  glossaryRows.push([term, kind, defined.map(msgNo).join(', '), [...(actorNames.get(term.toLowerCase()) ?? [])].sort().join(', '), found.length ? msgNo(found[0]) : '', found.length, found.map(msgNo).join(', ')]);
}
tsv('glossary.tsv', ['term', 'kind', 'name message', 'actors', 'first message', 'count', 'messages'], glossaryRows);

// ---------------------------------------------------------------------------
// beats.tsv: the events in a first story order. An event's variants (its
// messages and flag changes grouped by the story flags their paths tested)
// are the beats. A beat that needs a flag set comes after the beats that can
// first set it; one that needs it clear comes before them. Only the party and
// Djinn flags (below 0x100) and the story flags (0x800 to 0xdff) order beats,
// as the scene README divides the flags: a scene flag lasts one visit and a
// place flag one stay, so neither says what happened earlier in the story.
// Where the "before" orders of clear flags close a cycle with other orders
// they are dropped, since an event that sets a flag in one answer and needs
// it clear in another is read as one beat; a cycle left after that is broken
// at its earliest beat.

const ordersStory = (n: number) => n < 0x100 || (n >= 0x800 && n < 0xe00);
type Beat = { id: number; e: EventRow; scenes: number[]; requires: Lit[]; sets: number[]; clears: number[]; messages: number[] };
const beats: Beat[] = [];
for (const e of events) {
  const groups = new Map<string, { cond: Lit[]; conds: Lit[][]; messages: number[]; sets: number[]; clears: number[] }>();
  for (const f of e.effects) {
    const cond = f.cond.filter((l) => l.k[0] === 'f' && ordersStory(Number(l.k.slice(1))));
    const key = condKey(cond);
    const g = groups.get(key) ?? { cond, conds: [], messages: [], sets: [], clears: [] };
    g.conds.push(f.cond);
    if (f.n !== undefined) g.messages.push(f.n);
    if (f.set !== undefined) g.sets.push(f.set);
    if (f.clear !== undefined) g.clears.push(f.clear);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    if (!g.messages.length && !g.sets.length && !g.clears.length) continue;
    const requires = e.rowLits.filter((l) => l.k[0] === 'f' && ordersStory(Number(l.k.slice(1))));
    for (const l of g.cond) if (!requires.some((x) => litKey(x) === litKey(l))) requires.push(l);
    beats.push({ id: beats.length, e, scenes: narrow(e.scenes, common(g.conds)), requires, sets: uniq(g.sets), clears: uniq(g.clears), messages: uniq(g.messages) });
  }
}
const setters = new Map<string, number[]>();
for (const b of beats) for (const n of b.sets.filter(ordersStory)) for (const k of flagKeys(n, b.scenes)) setters.set(k, [...(setters.get(k) ?? []), b.id]);

// The orders: from a beat to one that must come after it, strong (a flag
// that must be set) or weak (a flag that must still be clear). A beat that
// needs the flag set cannot be the one that first sets it, and a beat that
// sets the flag itself while needing it clear is an alternative to the other
// setters, not before them.
type Order = { from: number; to: number; weak: boolean; live: boolean };
const orders: Order[] = [];
const needs = (b: Beat, n: number, pos: boolean) => b.requires.some((l) => l.k === `f${n}` && l.pos === pos);
for (const b of beats) {
  for (const l of b.requires) {
    const n = Number(l.k.slice(1));
    for (const k of flagKeys(n, b.scenes)) {
      for (const s of setters.get(k) ?? []) {
        if (s === b.id) continue;
        if (l.pos && !needs(beats[s], n, true)) orders.push({ from: s, to: b.id, weak: false, live: true });
        else if (!l.pos && !b.sets.includes(n)) orders.push({ from: b.id, to: s, weak: true, live: true });
      }
    }
  }
}

// Tarjan's strongly connected components over the live orders.
function components(): number[] {
  const next = new Map<number, number[]>();
  for (const o of orders) if (o.live) next.set(o.from, [...(next.get(o.from) ?? []), o.to]);
  const index = new Array<number>(beats.length).fill(-1);
  const low = new Array<number>(beats.length).fill(0);
  const comp = new Array<number>(beats.length).fill(-1);
  const onStack = new Array<boolean>(beats.length).fill(false);
  const stack: number[] = [];
  let counter = 0;
  let comps = 0;
  for (let root = 0; root < beats.length; root++) {
    if (index[root] >= 0) continue;
    // Iterative depth-first search: (node, position in its successors).
    const work: [number, number][] = [[root, 0]];
    index[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = true;
    while (work.length) {
      const top = work[work.length - 1];
      const [v, i] = top;
      const succ = next.get(v) ?? [];
      if (i < succ.length) {
        top[1]++;
        const w = succ[i];
        if (index[w] < 0) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = true;
          work.push([w, 0]);
        } else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
        continue;
      }
      work.pop();
      if (work.length) low[work[work.length - 1][0]] = Math.min(low[work[work.length - 1][0]], low[v]);
      if (low[v] === index[v]) {
        for (;;) {
          const w = stack.pop()!;
          onStack[w] = false;
          comp[w] = comps;
          if (w === v) break;
        }
        comps++;
      }
    }
  }
  return comp;
}
let dropped = 0;
for (let pass = 0; pass < 20; pass++) {
  const comp = components();
  const weakInCycle = orders.filter((o) => o.live && o.weak && comp[o.from] === comp[o.to]);
  if (!weakInCycle.length) break;
  for (const o of weakInCycle) o.live = false;
  dropped += weakInCycle.length;
}
const finalComp = components();
const cycleSize = new Map<number, number>();
for (const c of finalComp) cycleSize.set(c, (cycleSize.get(c) ?? 0) + 1);
const beatsInCycles = finalComp.filter((c) => (cycleSize.get(c) ?? 0) > 1).length;

const before = new Map<number, Set<number>>(); // b → the beats that must come before it
for (const o of orders) if (o.live) before.set(o.to, new Set([...(before.get(o.to) ?? []), o.from]));
const firstMessage = (b: Beat) => (b.messages.length ? b.messages[0] : Infinity);
const cmp = (a: Beat, b: Beat) => {
  const x = Math.min(...a.scenes, 9999) - Math.min(...b.scenes, 9999);
  if (x) return x;
  const y = firstMessage(a) - firstMessage(b);
  if (y) return y;
  const p = `${a.e.file}:${a.e.event}`;
  const q = `${b.e.file}:${b.e.event}`;
  return p < q ? -1 : p > q ? 1 : a.id - b.id;
};
const waiting = new Map(beats.map((b) => [b.id, new Set(before.get(b.id) ?? [])]));
const placed: Beat[] = [];
let forced = 0;
const left = new Set(beats.map((b) => b.id));
while (left.size) {
  let ready = [...left].filter((id) => waiting.get(id)!.size === 0).map((id) => beats[id]);
  if (!ready.length) {
    // A cycle: the earliest of the beats waiting on the fewest goes first.
    const fewest = Math.min(...[...left].map((id) => waiting.get(id)!.size));
    ready = [...left].filter((id) => waiting.get(id)!.size === fewest).map((id) => beats[id]);
    forced++;
  }
  ready.sort(cmp);
  const next = ready[0];
  placed.push(next);
  left.delete(next.id);
  for (const id of left) waiting.get(id)!.delete(next.id);
}
tsv(
  'beats.tsv',
  ['order', 'place', 'file', 'scenes', 'event', 'trigger', 'requires', 'sets', 'clears', 'first message', 'first text', 'messages'],
  placed.map((b, i) => {
    const tu = b.e.tu;
    const first = b.messages[0];
    return [i + 1, placeOfScenes(b.scenes), b.e.file, sceneList(b.scenes), b.e.event, b.e.trigger, condText(b.requires, tu), b.sets.map((n) => flagLabel(n, tu)).join(', '), b.clears.map((n) => flagLabel(n, tu)).join(', '), first !== undefined ? msgNo(first) : '', first !== undefined ? oneLine(messageById.get(first)?.text ?? '') : '', b.messages.map(msgNo).join(', ')];
  }),
);

// ---------------------------------------------------------------------------
// What it found, and what it could not.

const unresolved = roots.flatMap((r) => r.res.unresolved);
const unresolvedWhy = new Map<string, number>();
for (const u of unresolved) unresolvedWhy.set(u.why, (unresolvedWhy.get(u.why) ?? 0) + 1);
const sited = messages.filter((m) => sitesOf.has(m.id)).length;
console.log(`story: ${messages.length} messages, ${sited} shown by a scene site; ${flagList.length} flags; ${events.length} events; ${glossaryRows.length} glossary terms; ${placed.length} beats (${orders.length} orders, ${dropped} weak ones dropped from cycles, ${beatsInCycles} beats left in cycles, ${forced} placed by breaking one); in ${((Date.now() - started) / 1000).toFixed(1)} s`);
console.log(`  area names: ${tableAreas ? `from ${relative(process.cwd(), placesTable)}` : 'derived'}${tableAreas ? `, ${areaMismatches.length} scenes differ from the derived names` : ''}`);
for (const m of areaMismatches.slice(0, 10)) console.log(`    ${m}`);
console.log('  messages with no scene site:');
for (const [why, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`    ${n}\t${why}`);
console.log('  show commands whose message could not be computed:');
for (const [why, n] of [...unresolvedWhy].sort((a, b) => b[1] - a[1])) console.log(`    ${n}\t${why}`);
console.log(`  flag operations on a computed number the analysis cannot resolve: ${roots.reduce((s, r) => s + r.res.dynamicFlags, 0)}`);
console.log(`  written to ${out}`);
