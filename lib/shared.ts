export const appName = 'Alchemy';
export const docsRoute = '/';

export const gitConfig = {
  user: 'PascalPixel',
  repo: 'alchemy',
  branch: 'main',
};

// The generated source pages, a page per folder (or per file in a large
// folder), and the abilities, a page each in a folder per kind. Their sidebar
// is pruned to the path a reader is on (tree.ts): a kind's folder off the
// path is a link to its table on the abilities page.
const LISTS = /^\/(tbs|tla)\/(source|abilities)(\/|#|$)/;

export function isList(url: string) {
  return LISTS.test(url);
}
