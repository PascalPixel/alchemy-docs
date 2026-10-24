import type { Folder, Item, Node, Root } from 'fumadocs-core/page-tree';
import { isList } from './shared';

// The sidebar a page is sent. The site has two tabs, the guide and each
// game's reference, which are root folders: a page is sent its own tab's
// tree, and of every other tab only the folder and its index, which is all
// the tab switcher needs. The reference has a node for each of the games'
// thousands of files, structures and index pages, and every page carries its
// sidebar, so there a page gets only the folders on its own path open, with
// every item in them; every other folder there is closed, shown as a link to
// its index page, and a long list of folders beside the path is left out (the
// path's own folder pages list them). The guide stays whole.
const LONG = 40;

const urls = new WeakMap<Folder, Set<string>>();

function urlsOf(folder: Folder): Set<string> {
  let set = urls.get(folder);
  if (!set) {
    set = new Set();
    if (folder.index) set.add(folder.index.url);
    for (const node of folder.children) {
      if (node.type === 'page') set.add(node.url);
      else if (node.type === 'folder') for (const u of urlsOf(node)) set.add(u);
    }
    urls.set(folder, set);
  }
  return set;
}

// Only what the sidebar draws.
const item = (page: Item, name = page.name): Item => ({ type: 'page', $id: page.$id, name, url: page.url, icon: page.icon });

function prune(nodes: Node[], url: string): Node[] {
  const onPath = nodes.find((n) => n.type === 'folder' && urlsOf(n).has(url));
  const folders = nodes.filter((n) => n.type === 'folder').length;
  const out: Node[] = [];
  for (const node of nodes) {
    // prune only opens folders on the page's own path, so every item listed
    // here sits beside the page or in one of its folders.
    if (node.type === 'page') out.push(item(node));
    else if (node.type === 'separator') out.push(node);
    else if (node === onPath) {
      out.push({ ...node, $ref: undefined, index: node.index && item(node.index), defaultOpen: true, children: prune(node.children, url) });
    } else if (node.root) {
      out.push({ ...node, $ref: undefined, index: node.index && item(node.index), children: [] });
    } else if (node.index && isList(node.index.url)) {
      if (!(onPath && folders > LONG && isList(url))) out.push(item(node.index, node.name));
    } else {
      out.push({ ...node, $ref: undefined, index: node.index && item(node.index), children: prune(node.children, url) });
    }
  }
  return out;
}

export function treeFor(tree: Root, slug: string[] | undefined): Root {
  const url = '/' + (slug ?? []).join('/');
  // The reference lists its files, structures and index pages by name, as
  // links, which leaves their pages out of the tree: fumadocs keeps those in
  // a fallback tree, which no page needs sent.
  return { ...tree, fallback: undefined, children: prune(tree.children, url) };
}
