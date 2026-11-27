// Alchemy's comments as clang-format leaves them, read line by line.
//
// Every comment is a `//` line comment: a comment of several lines is a run
// of `//` lines, its paragraphs parted by a bare `//`, and laid-out text keeps
// its indentation after the `// `. A note after code is `code; // note`, and
// its continuation lines are `//` lines indented to the note's column. A few
// block comments remain (inside multi-line macros, or with code after them on
// their line), and are read too. `// clang-format off` and `on` are switches,
// not comments.
//
// clang-format also lines up the comment of the next row of a table with the
// note above it, so a run of `//` lines at a note's column is that note's
// continuation unless the row right after it is code with no note of its own:
// then the run is that row's comment, as it was before clang-format moved it.

export type CommentRow =
  | { kind: 'blank' | 'switch' }
  | { kind: 'code'; note: number } // note: where a `//` note starts, or -1
  | { kind: 'comment' | 'continuation'; at: number } // at: where the `//` starts
  | { kind: 'block'; start: number; end: number }; // the rows of a block comment on lines of its own

const TAB = 4;
// A position's column as shown, tabs at four.
const column = (line: string, at: number) => {
  let c = 0;
  for (let i = 0; i < at; i++) c = line[i] === '\t' ? c + TAB - (c % TAB) : c + 1;
  return c;
};

const SWITCH = /^\s*\/[/*] clang-format (off|on)\s*(\*\/)?\s*$/;

// Where a line's `//` comment starts outside strings and character constants,
// and whether the line ends inside a block comment, given that it starts in one.
function scan(line: string, inBlock: boolean): { slash: number; inBlock: boolean; blocks: boolean } {
  let blocks = inBlock;
  for (let i = 0; i < line.length; i++) {
    if (inBlock) {
      if (line.startsWith('*/', i)) {
        inBlock = false;
        i++;
      }
      continue;
    }
    const c = line[i];
    if (c === '"' || c === "'") {
      for (i++; i < line.length && line[i] !== c; i++) if (line[i] === '\\') i++;
    } else if (line.startsWith('//', i)) return { slash: i, inBlock: false, blocks };
    else if (line.startsWith('/*', i)) {
      inBlock = true;
      blocks = true;
      i++;
    }
  }
  return { slash: -1, inBlock, blocks };
}

export function rowsOf(text: string): CommentRow[] {
  const lines = text.split('\n');
  const rows: CommentRow[] = [];
  let inBlock = false;
  let blockStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const wasInBlock = inBlock;
    const s = scan(line, inBlock);
    inBlock = s.inBlock;
    if (wasInBlock && blockStart < 0) {
      // The rest of a block comment that starts after code.
      rows.push({ kind: 'code', note: -1 });
      continue;
    }
    if (wasInBlock || (/^\s*\/\*/.test(line) && !SWITCH.test(line))) {
      // A block comment on lines of its own, when nothing follows its end.
      if (!wasInBlock) blockStart = i;
      if (inBlock) {
        rows.push({ kind: 'block', start: blockStart, end: -1 });
        continue;
      }
      const after = line.slice(line.lastIndexOf('*/') + 2);
      if (!after.trim()) {
        for (let j = blockStart; j <= i; j++) rows[j] = { kind: 'block', start: blockStart, end: i };
        blockStart = -1;
        continue;
      }
      for (let j = blockStart; j < i; j++) rows[j] = { kind: 'code', note: -1 };
      blockStart = -1;
      rows.push({ kind: 'code', note: s.slash });
      continue;
    }
    if (!line.trim()) rows.push({ kind: 'blank' });
    else if (SWITCH.test(line)) rows.push({ kind: 'switch' });
    else if (s.slash >= 0 && !line.slice(0, s.slash).trim()) rows.push({ kind: 'comment', at: s.slash });
    else rows.push({ kind: 'code', note: s.slash });
  }
  // The runs at a note's column.
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.kind !== 'code' || r.note < 0) continue;
    const col = column(lines[i], r.note);
    let j = i + 1;
    for (; j < rows.length; j++) {
      const n = rows[j];
      if (n.kind !== 'comment' || column(lines[j], n.at) !== col) break;
    }
    if (j === i + 1) continue;
    const next = rows[j];
    const owned = next?.kind === 'code' && next.note < 0 && !/^\s*[})]/.test(lines[j]);
    if (!owned) for (let k = i + 1; k < j; k++) rows[k] = { kind: 'continuation', at: (rows[k] as { at: number }).at };
  }
  return rows;
}

// A comment's lines as written, without its marks: a `//` line's text after
// `// `, so that a line indented further is still indented; a block
// comment's without `/*` and `*/`, and the indentation its later lines share,
// tabs or spaces. Inside a macro, the backslashes that continue its lines are
// not the comment's.
export function commentLines(text: string): string[] {
  if (/^\s*\/\//.test(text)) return text.split('\n').map((l) => l.replace(/^\s*\/\/ ?/, '').trimEnd());
  const inner = text
    .replace(/[ \t]*\\$/gm, '')
    .replace(/^\s*\/\*[ \t]?/, '')
    .replace(/\s*\*\/\s*$/, '');
  const lines = inner.split('\n');
  const shared = Math.min(...lines.slice(1).filter((l) => l.trim()).map((l) => l.match(/^[ \t]*/)![0].length));
  return lines.map((l, i) => (i ? l.slice(Math.min(shared, l.match(/^[ \t]*/)![0].length)) : l));
}

// The comment that ends on the row above `row`, past any clang-format
// switches: its first row and its text as written. A note's continuation is
// not a comment above anything.
export function commentAbove(lines: string[], rows: CommentRow[], row: number): { start: number; text: string } | null {
  let end = row - 1;
  while (end >= 0 && rows[end].kind === 'switch') end--;
  const r = rows[end];
  if (!r) return null;
  if (r.kind === 'block') return r.end === end ? { start: r.start, text: lines.slice(r.start, end + 1).join('\n') } : null;
  if (r.kind !== 'comment') return null;
  let start = end;
  while (start > 0 && rows[start - 1].kind === 'comment') start--;
  return { start, text: lines.slice(start, end + 1).join('\n') };
}

// The note after code on a row, with its continuation lines, as one comment's
// text; '' when the row has none.
export function noteOn(lines: string[], rows: CommentRow[], row: number): string {
  const r = rows[row];
  if (r?.kind !== 'code' || r.note < 0) return '';
  const out = [lines[row].slice(r.note)];
  for (let i = row + 1; rows[i]?.kind === 'continuation'; i++) out.push(lines[i]);
  return out.join('\n');
}

// The text with its comments blanked, in place, so offsets and lines stay
// as written.
export function blankComments(text: string): string {
  return text.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => (m[0] === '/' ? m.replace(/[^\n]/g, ' ') : m));
}
