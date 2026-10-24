import { docsRoute, isList } from './shared';
import { defineDocs } from 'fumadocs-mdx/macro';
import { applyMdxPreset } from 'fumadocs-mdx/config';
import { loader } from 'fumadocs-core/source';
import { lucideIconsPlugin } from 'fumadocs-core/source/lucide-icons';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { z } from 'zod';
import { remarkMdxMermaid } from 'fumadocs-core/mdx-plugins';
import { onImageError, remarkRenders } from './remark-renders';
import { remarkFigures } from './remark-figures';
import { remarkCodeBreaks } from './remark-code-breaks';
import { remarkOpenQuestions } from './remark-open-questions';
import { remarkComponents } from './remark-components';

const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    // source: the repository file or folder a generated page is made from,
    // for the page's GitHub link; image: a guide page's still of its first
    // recording (lib/stills.ts), for its card and its preview image.
    schema: pageSchema.extend({ source: z.string().optional(), image: z.string().optional() }),
    // Pictures keep their paths rather than being bundled, so the site's CSS
    // can tell a recording from an asset sheet by where it lives. The renders
    // are in the Blob store: their sizes come from its manifest. Then a
    // paragraph of pictures becomes captioned figures (remark-figures),
    // inline code gets its break points (remark-code-breaks), an open question
    // its note (remark-open-questions) and Markdown structure fumadocs'
    // components (remark-components).
    mdxOptions: applyMdxPreset({ remarkImageOptions: { useImport: false, onError: onImageError }, remarkPlugins: (v) => [remarkRenders, remarkMdxMermaid, ...v, remarkFigures, remarkCodeBreaks, remarkOpenQuestions, remarkComponents] }),
  },
  meta: {
    schema: metaSchema,
  },
});

export const source = loader({
  baseUrl: docsRoute,
  source: docs.toFumadocsSource(),
  // The icons scripts/content.ts names for the top pages are lucide's.
  plugins: [lucideIconsPlugin()],
});

// The pages with a preview image of their own (app/og): the guide's, and each
// reference's front page, whose image every page of that reference shares.
type Page = (typeof source)['$inferPage'];
const ownImage = (page: Page) => !isList(page.url) || page.slugs.length === 2;
export const ogPages = () => source.getPages().filter(ownImage);
export function ogImage(page: Page): string {
  const slugs = ownImage(page) ? page.slugs : page.slugs.slice(0, 2);
  return `/og/${[...slugs, 'image.png'].join('/')}`;
}
