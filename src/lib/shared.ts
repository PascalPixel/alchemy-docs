import { createGetUrl } from 'fumadocs-core/source';

export const appName = 'Alchemy';
export const docsRoute = '/docs';
export const docsImageRoute = '/og/docs';
export const siteUrl = 'https://alchemy.pascalpixel.com';

// fill this with your actual GitHub info, for example:
export const gitConfig = {
  user: 'PascalPixel',
  repo: 'alchemy',
  branch: 'main',
};

const getImageUrl = createGetUrl(docsImageRoute);

export function getPageImageUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'image.png'];

  return { segments, url: getImageUrl(segments, page.locale) };
}
