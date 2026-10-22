export const appName = 'Alchemy';
export const docsRoute = '/';

export const gitConfig = {
  user: 'PascalPixel',
  repo: 'alchemy',
  branch: 'main',
};

// The reference: a page per file, folder and structure, and the indexes. Its
// sidebar is pruned to the path a reader is on (tree.ts), its table of
// contents shows only a page's sections, and search finds its pages by their
// titles and the names they document.
const LISTS = /^\/(tbs|tla)\/source(\/|#|$)/;
// The reference's indexes, which only repeat the names other pages document.
const INDEXES = /^\/(tbs|tla)\/source\/(structs(\/([a-z]|other))?\/?$|fields(\/|$)|globals(\/|$))/;

export function isList(url: string) {
  return LISTS.test(url);
}

export function isIndex(url: string) {
  return INDEXES.test(url);
}

// Where the browser remembers a reader's choice of raw colours over the GBA
// screen's (components/colour-toggle.tsx).
export const COLOURS_KEY = 'alchemy-colours';
