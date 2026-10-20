import { createGetUrl } from 'fumadocs-core/source';

export const appName = 'Alchemy';
export const docsRoute = '/docs';
export const docsImageRoute = '/og/docs';
export const docsContentRoute = '/llms.mdx/docs';

export const gitConfig = {
  user: 'PascalPixel',
  repo: 'alchemy',
  branch: 'main',
};

const getContentUrl = createGetUrl(docsContentRoute);

export function getPageMarkdownUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'content.md'];

  return { segments, url: getContentUrl(segments, page.locale) };
}

const getImageUrl = createGetUrl(docsImageRoute);

export function getPageImageUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'image.png'];

  return { segments, url: getImageUrl(segments, page.locale) };
}

// The generated lists: a page per source folder and file, and the reference
// lists. They are left out of llms-full.txt and get no social card.
const LISTS = /^\/docs\/(tbs\/source|tla\/source|reference\/(tbs|tla))(\/|$)/;

export function isList(url: string) {
  return LISTS.test(url);
}
