import { createGetUrl } from 'fumadocs-core/source';

export const appName = 'Alchemy';
export const docsRoute = '/';
export const docsImageRoute = '/og';
export const docsContentRoute = '/llms.mdx';

export const gitConfig = {
  user: 'PascalPixel',
  repo: 'alchemy',
  branch: 'main',
};

// Where the site is published, for the preview images (src/lib/og.tsx) a link
// from elsewhere finds.
export const siteUrl = 'https://alchemy.pascalpixel.com';

const getContentUrl = createGetUrl(docsContentRoute);

export function getPageMarkdownUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'content.md'];

  return { segments, url: getContentUrl(segments, page.locale) };
}

// The reference: a page per file, folder and structure, and the indexes. Its
// table of contents shows only a page's sections, and search finds its pages
// by their titles and the names they document.
const LISTS = /^\/(tbs|tla)\/source(\/|#|$)/;
// The reference's indexes, which only repeat the names other pages document.
const INDEXES = /^\/(tbs|tla)\/source\/(structs(\/([a-z]|other))?\/?$|fields(\/|$)|globals(\/|$))/;

export function isList(url: string) {
  return LISTS.test(url);
}

export function isIndex(url: string) {
  return INDEXES.test(url);
}
