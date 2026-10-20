import { source } from '@/lib/source';
import { isList } from '@/lib/shared';
import { createFromSource } from 'fumadocs-core/search/server';

export const revalidate = false;

// The prose pages are searched in full; a source page by its title, its
// description and its headings, which are the names it defines, so the
// index stays small enough to load. The A to Z lists repeat those names and
// are found by their titles only. Placeholder names, an address after a
// prefix (Func_02000280, gData_0200521c), are left out: the same overlay
// address recurs in scene after scene.
const PLACEHOLDER = /_[0-9a-f]{7,8}\b/i;

export const { staticGET: GET } = createFromSource(source, {
  // https://docs.orama.com/docs/orama-js/supported-languages
  language: 'english',
  buildIndex: (page) => {
    const { structuredData } = page.data;
    const names = page.url.startsWith('/docs/reference/');
    return {
      title: page.data.title,
      description: page.data.description,
      url: page.url,
      id: page.url,
      structuredData: !isList(page.url)
        ? structuredData
        : { headings: names ? [] : structuredData.headings.filter((h) => !PLACEHOLDER.test(h.content)), contents: [] },
    };
  },
});
