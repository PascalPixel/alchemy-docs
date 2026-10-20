import type { Folder, Item, Node, Root } from 'fumadocs-core/page-tree';
import { isList } from './shared';

// The sidebar a page is sent. The whole tree has a node for each of the
// games' four thousand files, and every page carries its sidebar, so in the
// source and reference lists a page gets only the folders on its own path
// open, with every file in them; every other folder there is closed, shown
// as a link to its index page, and a long list of folders beside the path is
// left out (the path's own folder pages list them). The guides stay whole.
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
const item = (page: Item, name = page.name): Item => ({ type: 'page', $id: page.$id, name, url: page.url });

function prune(nodes: Node[], url: string): Node[] {
  const onPath = nodes.find((n) => n.type === 'folder' && urlsOf(n).has(url));
  const folders = nodes.filter((n) => n.type === 'folder').length;
  const out: Node[] = [];
  for (const node of nodes) {
    // prune only opens folders on the page's own path, so every file listed
    // here sits beside the page or in one of its folders.
    if (node.type === 'page') out.push(item(node));
    else if (node.type === 'separator') out.push(node);
    else if (node === onPath) {
      out.push({ ...node, $ref: undefined, index: node.index && item(node.index), defaultOpen: true, children: prune(node.children, url) });
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
  return { ...tree, children: prune(tree.children, url) };
}
