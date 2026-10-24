// Turns plain Markdown structure into fumadocs' components, so Alchemy's
// Markdown stays as GitHub shows it and the site decides how it looks:
//
// - a guide page's list of pages, each item a link to a page and what it
//   holds ("- [World](/tbs/world): the field engine, ..."), becomes cards
//   (components/page-cards.tsx);
// - a guide page's numbered list at the top level, things done in order
//   ("Then, for a field map: 1. ... 2. ..."), becomes Steps;
// - a GitHub alert (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`,
// - a folder guide's closing reference sections (Words used here,
//   Evidence, Source files) become Accordions, closed, so the page reads as
//   prose and recordings;
//   `[!CAUTION]`) becomes a Callout, on any page;
// - a structure's Data Fields table becomes a TypeTable.
import type { List, ListItem, Paragraph, PhrasingContent, Root, RootContent, Table, TableCell } from 'mdast';
import type { MdxJsxAttribute, MdxJsxFlowElement } from 'mdast-util-mdx-jsx';
import { toString } from 'mdast-util-to-string';
import type { VFile } from 'vfile';

const jsx = (name: string, attributes: Record<string, string>, children: MdxJsxFlowElement['children']): MdxJsxFlowElement => ({
  type: 'mdxJsxFlowElement',
  name,
  attributes: Object.entries(attributes).map(([k, v]): MdxJsxAttribute => ({ type: 'mdxJsxAttribute', name: k, value: v })),
  children,
});

const isGuide = (file: VFile) => /[\\/]\(guide\)[\\/]/.test(file.path);

// An item that is a link to a guide page, then a colon and what it holds.
function pageItem(item: ListItem): { href: string; title: string; about: PhrasingContent[] } | undefined {
  const para = item.children[0];
  if (item.children.length !== 1 || para?.type !== 'paragraph') return undefined;
  const [link, ...rest] = (para as Paragraph).children;
  if (link?.type !== 'link' || !link.url.startsWith('/') || /[#?]/.test(link.url) || link.url.startsWith('/tbs/source')) return undefined;
  const first = rest[0];
  if (rest.length && (first.type !== 'text' || !/^:\s/.test(first.value))) return undefined;
  if (first?.type === 'text') {
    const value = first.value.replace(/^:\s+/, '');
    rest[0] = { ...first, value: value.charAt(0).toUpperCase() + value.slice(1) };
  }
  return { href: link.url, title: toString(link), about: rest };
}

// A list numbered from 1, not inside anything else.
function steps(tree: Root) {
  tree.children = tree.children.map((node) => {
    if (node.type !== 'list' || !node.ordered || (node.start ?? 1) !== 1 || node.children.length < 2) return node;
    return jsx('Steps', {}, (node as List).children.map((item) => jsx('Step', {}, item.children)));
  });
}

function cards(tree: Root) {
  tree.children = tree.children.map((node) => {
    if (node.type !== 'list' || node.ordered || node.children.length < 2) return node;
    const items = (node as List).children.map(pageItem);
    if (items.some((i) => !i)) return node;
    return jsx(
      'PageCardList',
      {},
      items.map((i) => jsx('PageCard', { href: i!.href, title: i!.title }, i!.about as never)),
    );
  });
}

// A folder guide's closing reference sections. Evidence is also matched by
// its older heading, Evidence and open questions.
const REFERENCE = /^(Words used here|Evidence( and open questions)?|Source files)$/;

// Each reference section, from its ## heading to the next, becomes an
// Accordion titled and anchored as the heading was, closed until opened or
// linked to; neighbouring ones share one Accordions.
function accordions(tree: Root) {
  const out: RootContent[] = [];
  let group: MdxJsxFlowElement | undefined;
  let open: MdxJsxFlowElement | undefined;
  for (const node of tree.children) {
    if (node.type === 'heading' && node.depth <= 2) {
      open = undefined;
      const title = toString(node);
      if (node.depth === 2 && REFERENCE.test(title)) {
        const id = String(node.data?.hProperties?.id ?? '');
        open = jsx('Accordion', { title, ...(id && { id }) }, []);
        if (!group) out.push((group = jsx('Accordions', {}, [])));
        group.children.push(open);
        continue;
      }
      group = undefined;
    }
    if (open) open.children.push(node as never);
    else out.push(node);
  }
  tree.children = out;
}

// GitHub's alert types, as fumadocs' Callout types and titles.
const ALERTS: Record<string, [type: string, title: string]> = {
  NOTE: ['info', 'Note'],
  TIP: ['idea', 'Tip'],
  IMPORTANT: ['info', 'Important'],
  WARNING: ['warn', 'Warning'],
  CAUTION: ['error', 'Caution'],
};
const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i;

// A quote whose first line is an alert's mark, anywhere on a page.
function callouts(node: Root | RootContent) {
  if (!('children' in node)) return;
  node.children = node.children.map((child: RootContent) => {
    callouts(child);
    if (child.type !== 'blockquote') return child;
    const first = child.children[0];
    const text = first?.type === 'paragraph' && first.children[0]?.type === 'text' ? first.children[0] : undefined;
    const m = text?.value.match(ALERT);
    if (!text || !m) return child;
    text.value = text.value.slice(m[0].length);
    if (!text.value) (first as Paragraph).children.shift();
    const [type, title] = ALERTS[m[1].toUpperCase()];
    return jsx('Callout', { type, title }, (first as Paragraph).children.length ? child.children : child.children.slice(1));
  }) as never;
}

// The Data Fields table of a structure's page (scripts/content.ts): a column
// of types, one of names linking to their entries, and one of descriptions.
// Each row becomes a Field of a FieldTable (components/field-table.tsx); an
// array's size, written after the name, joins its type.
function typeTable(tree: Root) {
  const at = tree.children.findIndex((n) => n.type === 'heading' && n.data?.hProperties?.id === 'data-fields');
  const table = tree.children[at + 1];
  if (at < 0 || table?.type !== 'table') return;
  const fields = (table as Table).children.slice(1).map((row) => {
    const [type, name, about] = row.children as TableCell[];
    const [link, ...after] = name.children;
    const href = link?.type === 'link' ? link.url : '';
    return jsx('Field', { name: toString(link), type: `${toString(type)}${after.map((n) => toString(n)).join('').trim()}`, ...(href && { href }) }, about.children as never);
  });
  tree.children[at + 1] = jsx('FieldTable', {}, fields);
}

export function remarkComponents() {
  return (tree: Root, file: VFile) => {
    callouts(tree);
    if (isGuide(file)) {
      cards(tree);
      steps(tree);
      accordions(tree);
    } else typeTable(tree);
  };
}
