// Turns plain Markdown structure into fumadocs' components, so Alchemy's
// Markdown stays as GitHub shows it and the site decides how it looks:
//
// - a guide page's list of pages, each item a link to a page and what it
//   holds ("- [World](/tbs/world): the field engine, ..."), becomes cards
//   (components/page-cards.tsx);
// - a guide page's numbered list at the top level, things done in order
//   ("Then, for a field map: 1. ... 2. ..."), becomes Steps;
// - a structure's Data Fields table becomes a TypeTable.
import type { List, ListItem, Paragraph, PhrasingContent, Root, Table, TableCell } from 'mdast';
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
    return jsx('Field', { name: toString(link), type: `${toString(type)}${after.map(toString).join('').trim()}`, ...(href && { href }) }, about.children as never);
  });
  tree.children[at + 1] = jsx('FieldTable', {}, fields);
}

export function remarkComponents() {
  return (tree: Root, file: VFile) => {
    if (isGuide(file)) {
      cards(tree);
      steps(tree);
    } else typeTable(tree);
  };
}
