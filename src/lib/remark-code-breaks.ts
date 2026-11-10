// Lets a long code name in running text or a table break where a reader
// would split it: after an underscore, a slash, a dot or an arrow
// (`BattleAnim_` | `ProcessPendingGraphicsTransfer`, `games/` | `tbs/`).
// Each inline code span gets a <wbr> at those places; the CSS then lets a
// piece still too long for its line break anywhere (overflow-wrap: anywhere),
// which a browser does only when no <wbr> fits; a short one stays whole.
// Code blocks are left alone.
//
// A name of a kind the reader meets everywhere also gets an emoji in front
// (CODE_EMOJI), drawn by the CSS from data-emoji so copying the name copies
// only the name.
import type { InlineCode, Root } from 'mdast';
import type { ElementContent } from 'hast';

// The kinds of name that get an emoji, first match wins: game flags, music,
// sounds and the four sequences.
const CODE_EMOJI: [RegExp, string][] = [
  [/^FLAG_[A-Z0-9_]+$/, '🚩'],
  [/^MUS_[A-Z0-9_]+$/, '🎵'],
  [/^SE_[A-Z0-9_]+$/, '📣'],
  [/^SEQUENCE_BATTLE$/, '⚔️'],
  [/^SEQUENCE_DICE$/, '🎲'],
  [/^SEQUENCE_SLOTS$/, '🎰'],
  [/^FieldSequence_Run$/, '🏡'],
];

// A code span up to this long with no space in it is never broken.
const SHORT = 12;
// A file's extension stays with its name (`battle_calc.` | `c` is no break).
const BREAK_AFTER = /(?<=[^_/.\s][_/]|->)(?=[^_/.\s])|(?<=[^_/.\s]\.)(?=[^_/.\s])(?![A-Za-z]{1,3}$)/;

export function remarkCodeBreaks() {
  return (tree: Root) => {
    const visit = (node: { type: string; children?: unknown[] }) => {
      if (node.type === 'inlineCode') {
        const code = node as InlineCode;
        const emoji = CODE_EMOJI.find(([pattern]) => pattern.test(code.value))?.[1];
        if (emoji) code.data = { ...code.data, hProperties: { ...code.data?.hProperties, 'data-emoji': emoji } };
        // A short name or value (`0x1fb`, `item.h`) is never broken.
        if (code.value.length <= SHORT && !/\s/.test(code.value)) {
          code.data = { ...code.data, hProperties: { ...code.data?.hProperties, className: ['nowrap'] } };
          return;
        }
        const pieces = code.value.split(BREAK_AFTER);
        if (pieces.length > 1) {
          const children: ElementContent[] = pieces.flatMap((p, i) => (i ? [{ type: 'element', tagName: 'wbr', properties: {}, children: [] }, { type: 'text', value: p }] : [{ type: 'text', value: p }]));
          code.data = { ...code.data, hChildren: children };
        }
        return;
      }
      for (const c of node.children ?? []) visit(c as typeof node);
    };
    visit(tree);
  };
}
