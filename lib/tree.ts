import type { Folder, Item, Node, Root, Separator } from 'fumadocs-core/page-tree';
import { isIndex, isList } from './shared';

// The sidebar, shaped as Fumadocs' own docs shape theirs. scripts/content.ts
// writes the guide and each game's reference as root folders, the shape
// Doxygen gives them; here each game is a tab of its own instead (The Broken
// Seal, and The Lost Age once it has pages), and in a tab its pages are short
// lists under headings: the pages about the whole project, the game's
// systems and places, its source, and the indexes. Every folder opens where
// it is, and stays closed until a reader is in it.

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
      // A key left undefined would still be sent, so only a tab has the
      // tab switcher's name, icon and description.
      ...(node.root && { root: true, description: node.description }),
      index: node.index && item(node.index),
      children: slim(node.children),
    } satisfies Folder;
  });
}

const heading = (name: string): Separator => ({ type: 'separator', name });

function tabs(tree: Root): Node[] {
  const roots = tree.children.filter((n): n is Folder => n.type === 'folder' && !!n.root);
  const references = roots.filter((f) => f.index && isList(f.index.url));
  const guide = roots.find((f) => !references.includes(f));
  if (!guide) return tree.children;
  // A game's folder is the guide's folder whose page is the game's front
  // page (/tbs), and its reference the root folder at that page's /source.
  const games = guide.children.flatMap((node) => {
    if (node.type !== 'folder' || !node.index) return [];
    const reference = references.find((r) => r.index?.url === `${node.index!.url}/source`);
    return reference ? [{ game: node, reference }] : [];
  });
  if (!games.length) return guide.children;
  // The pages about the whole project, the introduction and building
  // Alchemy, are in every game's tab.
  const project = guide.children.filter((n) => !games.some((g) => g.game === n));
  return games.map(({ game, reference }) => {
    const front = game.index!.url;
    // The source's own guide, its README, is at /<game>/code
    // (scripts/content.ts), and opens the game's Source.
    const code = game.children.filter((n) => n.type === 'page' && n.url === `${front}/code`);
    const own = game.children.filter((n) => !code.includes(n));
    const indexes = reference.children.filter((n) => n.type === 'folder' && n.index && isIndex(n.index.url));
    const files = reference.children.filter((n) => !indexes.includes(n));
    return {
      ...game,
      root: true,
      children: [
        heading('Introduction'),
        ...project.slice(0, 1),
        game.index!,
        ...project.slice(1),
        heading('The game'),
        ...own,
        heading('Source'),
        ...code,
        ...files,
        heading('Indexes'),
        ...indexes,
      ],
    } satisfies Folder;
  });
}

// Every page is sent the same sidebar, made once.
const made = new WeakMap<Root, Root>();

export function sidebarTree(tree: Root): Root {
  let out = made.get(tree);
  // The reference lists its files, structures and index pages by name, as
  // links, which leaves their pages out of the tree: fumadocs keeps those in
  // a fallback tree, which no page needs sent.
  if (!out) made.set(tree, (out = { type: 'root', $id: tree.$id, name: tree.name, children: slim(tabs(tree)) }));
  return out;
}
