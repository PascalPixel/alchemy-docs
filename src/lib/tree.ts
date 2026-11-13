import type { Folder, Item, Node, Root, Separator } from 'fumadocs-core/page-tree';
import { createElement } from 'react';
import { TreeIcon, type TreeIconKind } from '@/components/tree-icon';
import { isList } from './shared';

// The sidebar, shaped as Fumadocs' own docs shape theirs: a few tabs, and in
// each a short list under headings. scripts/content.ts writes the guide and
// each game's reference as root folders; here a game's pages become three
// tabs. Guide holds the pages about the project and the game's four
// divisions, every page in view under its division's heading. Places holds
// the rooms, a folder for each town or dungeon in the order the story
// reaches it. Source holds the files and structures. A page is in one tab
// only, as fumadocs finds the open page by its address alone.
//
// With one game the tabs are the whole switcher. With two, each game is a
// root folder holding its tabs, which are root folders of a type of their
// own (`root: 'tab'`): fumadocs draws the two as one control, the game above
// its tabs, and flips a page to the same page of the other game where that
// game has it.

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
      ...(node.root && { root: node.root, description: node.description }),
      index: node.index && item(node.index),
      children: slim(node.children),
    } satisfies Folder;
  });
}

const heading = (name: string): Separator => ({ type: 'separator', name });
// The type of a game's tabs when the games are roots themselves.
const TAB = 'tab';
// What the switcher says under each game's name, by its front page.
const GAME_NOTE: Record<string, string> = { '/tbs': 'The first game', '/tla': 'Its sequel' };

// Every item has an icon. The guide's pages are named theirs in
// scripts/content.ts; the places and the source give each item without one
// the icon of its kind, drawn in the browser (src/components/tree-icon.tsx).
function withIcons(nodes: Node[], kind: (node: Item | Folder, depth: number) => TreeIconKind, depth = 0): Node[] {
  return nodes.map((node) => {
    if (node.type === 'separator') return node;
    const icon = node.icon ?? createElement(TreeIcon, { kind: kind(node, depth) });
    return node.type === 'folder' ? { ...node, icon, children: withIcons(node.children, kind, depth + 1) } : { ...node, icon };
  });
}
// A place is a town or dungeon, a folder of rooms, or a single room of its own.
const placeKind = (node: Item | Folder, depth: number): TreeIconKind => (node.type === 'folder' || depth === 0 ? 'place' : 'room');
// The source's pages are named for their files (motion-c, battle-h) or are
// structures; the list of files leads it.
function sourceKind(node: Item | Folder): TreeIconKind {
  if (node.type === 'folder') return 'folder';
  if (node.url.endsWith('-c')) return 'c';
  if (node.url.endsWith('-h')) return 'h';
  if (/\/structs\//.test(node.url)) return 'structure';
  return 'list';
}

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
    // A game whose source has no pages yet has no Source tab.
    return [{ game: node, reference }];
  });
  if (!games.length) return guide.children;
  // The pages about the whole project: the welcome page.
  const project = guide.children.filter((n) => !games.some((g) => g.game === n));
  // A game's tabs are roots of their own type inside the game's root.
  const root = games.length > 1 ? TAB : true;
  const made = games.map(({ game, reference }, at) => {
    const front = game.index!.url;
    const isAt = (n: Node, url: string) => (n.type === 'page' ? n.url : n.type === 'folder' ? n.index?.url : undefined) === url;
    // The source's own guide, its README, is at /<game>/code
    // (scripts/content.ts), and opens the Source tab.
    const code = game.children.filter((n) => isAt(n, `${front}/code`));
    const places = game.children.find((n): n is Folder => n.type === 'folder' && isAt(n, `${front}/places`));
    // A division is a folder with a page of its own and its folders' guides
    // inside; what is left are the pages every division shares.
    const divisions = game.children.filter((n): n is Folder => n.type === 'folder' && n !== places && !!n.index);
    const shared = game.children.filter((n) => n !== places && !code.includes(n) && !divisions.includes(n as Folder));
    const guideTab: Folder = {
      ...guide,
      $id: `${game.$id}:guide`,
      root,
      // The tab, and the game in the switcher, open at the game's front
      // page, which is also in the list below.
      index: game.index,
      name: 'Guide',
      description: 'How the game works, division by division',
      children: [
        // The project's pages only once, in the first game's tab.
        ...(at === 0 ? project.slice(0, 1) : []),
        // Under the game's name in the switcher, its front page is the
        // introduction to its guide.
        { ...game.index!, name: 'Introduction' },
        ...(at === 0 ? project.slice(1) : []),
        ...divisions.flatMap((d) => [heading(String(d.name)), { ...d.index!, name: 'Overview' }, ...d.children]),
        ...(shared.length ? [heading('Reference'), ...shared] : []),
      ],
    };
    const placesTab: Folder[] = places ? [{ ...places, root, description: 'Every town and dungeon, room by room', children: withIcons(places.children, placeKind) }] : [];
    const sourceTab: Folder[] = reference
      ? [{ ...reference, root, name: 'Source', description: 'The files and structures, with their comments', children: [...code, ...withIcons(reference.children, sourceKind)] }]
      : [];
    return { game, tabs: [guideTab, ...placesTab, ...sourceTab] };
  });
  if (made.length === 1) return made[0].tabs;
  return made.map(
    ({ game, tabs }): Folder => ({
      type: 'folder',
      $id: `${game.$id}:game`,
      root: true,
      name: game.name,
      icon: game.icon ?? game.index?.icon,
      description: GAME_NOTE[game.index!.url],
      children: tabs,
    }),
  );
}

// Every page is sent the same sidebar, made once.
const made = new WeakMap<Root, Root>();

export function sidebarTree(tree: Root): Root {
  let out = made.get(tree);
  // The reference lists its files and structures by name, as links, which
  // leaves their pages out of the tree: fumadocs keeps those in a fallback
  // tree, which no page needs sent.
  if (!out) made.set(tree, (out = { type: 'root', $id: tree.$id, name: tree.name, children: slim(tabs(tree)) }));
  return out;
}
