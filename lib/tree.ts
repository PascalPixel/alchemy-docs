import type { Folder, Item, Node, Root } from 'fumadocs-core/page-tree';
import { isList } from './shared';

// The sidebar: one tree. scripts/content.ts writes the guide and each game's
// reference as root folders, the shape Doxygen gives them; here each game's
// reference goes into that game's folder of the guide, under a Source
// heading after the game's own pages, so a reader finds a file beside the
// systems it belongs to and every folder opens where it is. Once a second
// game has pages, each game's folder is a tab of its own (The Broken Seal,
// The Lost Age), and the pages about both, the introduction and building
// Alchemy, are in every tab.

// Only what the sidebar draws, as every page carries the whole tree: a page
// needs no $id, which fumadocs reads only of folders.
const item = (page: Item, name = page.name): Item => ({ type: 'page', name, url: page.url, icon: page.icon });

function slim(nodes: Node[]): Node[] {
  return nodes.map((node) => {
    if (node.type === 'page') return item(node);
    if (node.type === 'separator') return node;
    return {
      type: 'folder',
      $id: node.$id,
      name: node.name,
      icon: node.icon,
      // The tab switcher shows a tab's name, icon and description; a key
      // left undefined would still be sent, so only a tab has them.
      ...(node.root && { root: true, description: node.description }),
      defaultOpen: node.defaultOpen,
      index: node.index && item(node.index),
      children: slim(node.children),
    } satisfies Folder;
  });
}

function merged(tree: Root): Node[] {
  const roots = tree.children.filter((n): n is Folder => n.type === 'folder' && !!n.root);
  const references = roots.filter((f) => f.index && isList(f.index.url));
  const guide = roots.find((f) => !references.includes(f));
  if (!guide) return tree.children;
  // A game's folder is the one whose page is the game's front page (/tbs),
  // and its reference the root folder at that page's /source.
  const games = new Set<Node>();
  const graft = (nodes: Node[]): Node[] =>
    nodes.map((node) => {
      if (node.type !== 'folder') return node;
      const reference = node.index && references.find((r) => r.index?.url === `${node.index!.url}/source`);
      const children = graft(node.children);
      if (!reference) return { ...node, children };
      const game: Folder = { ...node, children: [...children, { type: 'separator', name: 'Source' }, ...reference.children] };
      games.add(game);
      return game;
    });
  const nodes = graft(guide.children);
  if (games.size < 2) return nodes;
  // A tab per game: the pages before the games, the game's front page and
  // its own pages, then the pages after the games.
  const first = nodes.findIndex((n) => games.has(n));
  const last = nodes.findLastIndex((n) => games.has(n));
  const before = nodes.slice(0, first).filter((n) => !games.has(n));
  const after = nodes.slice(last + 1).filter((n) => !games.has(n));
  return nodes
    .filter((n): n is Folder => games.has(n))
    .map((game) => ({ ...game, root: true, defaultOpen: undefined, children: [...before, ...(game.index ? [game.index] : []), ...game.children, ...after] }));
}

// Every page is sent the same sidebar, made once.
const made = new WeakMap<Root, Root>();

export function sidebarTree(tree: Root): Root {
  let out = made.get(tree);
  // The reference lists its files, structures and index pages by name, as
  // links, which leaves their pages out of the tree: fumadocs keeps those in
  // a fallback tree, which no page needs sent.
  if (!out) made.set(tree, (out = { type: 'root', $id: tree.$id, name: tree.name, children: slim(merged(tree)) }));
  return out;
}
