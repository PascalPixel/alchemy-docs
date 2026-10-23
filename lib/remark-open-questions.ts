// Shows an open question as a note. scripts/content.ts turns the source's
// `XXX:` marks into a bold label (**Open question:**, **Picture still to
// make:**) and gives a paragraph's question a paragraph of its own; here such
// a paragraph outside a list becomes a framed note, and every label gets its
// own style.
import type { Root, RootContent, Strong } from 'mdast';
import { toString } from 'mdast-util-to-string';

const LABEL = /^(?:Open question(?: \([^)]*\))?|Picture still to make):$/;
const isLabel = (n: { type: string } | undefined): n is Strong => n?.type === 'strong' && LABEL.test(toString(n));

export function remarkOpenQuestions() {
  return (tree: Root) => {
    const visit = (node: Root | RootContent, inList = false) => {
      if (isLabel(node)) {
        node.data = { ...node.data, hName: 'span', hProperties: { className: ['open-question-label'] } };
        return;
      }
      if (!inList && node.type === 'paragraph' && isLabel(node.children[0])) node.data = { ...node.data, hName: 'div', hProperties: { className: ['open-question'] } };
      if ('children' in node) for (const c of node.children) visit(c, inList || node.type === 'list');
    };
    visit(tree);
  };
}
