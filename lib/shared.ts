export const appName = 'Alchemy';
export const docsRoute = '/docs';

export const gitConfig = {
  user: 'PascalPixel',
  repo: 'alchemy',
  branch: 'main',
};

// The generated source pages, a page per folder (or per file in a large
// folder). Their sidebar is pruned to the path a reader is on (tree.ts).
const LISTS = /^\/docs\/(tbs|tla)\/source(\/|$)/;

export function isList(url: string) {
  return LISTS.test(url);
}
