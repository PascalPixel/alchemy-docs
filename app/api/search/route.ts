import { source } from '@/lib/source';
import { isIndex, isList } from '@/lib/shared';
import { createFromSource } from 'fumadocs-core/search/server';

export const revalidate = false;

// The guide's pages are searched in full; a reference page by its title, its
// description and its headings, which are the names it documents, so a
// symbol is found by its name and the index stays small enough to load. The
// indexes repeat those names and are found by their titles only. Placeholder
// names, an address after a prefix (Func_02000280, gData_0200521c) or a
// field's offset (unk_14), are left out: the same overlay address recurs in
// scene after scene.
const PLACEHOLDER = /_[0-9a-f]{7,8}\b|^unk_?[0-9a-f]+$/i;

export const { staticGET: GET } = createFromSource(source, {
  // https://docs.orama.com/docs/orama-js/supported-languages
  language: 'english',
  buildIndex: (page) => {
    const { structuredData } = page.data;
    return {
      title: page.data.title,
      description: page.data.description,
      url: page.url,
      id: page.url,
      structuredData: !isList(page.url)
        ? structuredData
        : { headings: isIndex(page.url) ? [] : structuredData.headings.filter((h) => !PLACEHOLDER.test(h.content)), contents: [] },
    };
  },
});
