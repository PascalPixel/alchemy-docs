import { docsRoute, isList } from './shared';
import { defineDocs } from 'fumadocs-mdx/macro';
import { applyMdxPreset } from 'fumadocs-mdx/config';
import { llms, loader } from 'fumadocs-core/source';
import { lucideIconsPlugin } from 'fumadocs-core/source/lucide-icons';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { z } from 'zod';
import { remarkMdxMermaid } from 'fumadocs-core/mdx-plugins';
import { onImageError, remarkRenders } from './remark-renders';
import { remarkFigures } from './remark-figures';
import { remarkCodeBreaks } from './remark-code-breaks';
import { remarkComponents } from './remark-components';

const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    // source: the repository file or folder a generated page is made from,
    // for the page's GitHub link; image: a guide page's still of its first
    // recording (lib/stills.ts), for its card and its preview image;
    // lastModified: the day its source last changed in Alchemy's history.
    schema: pageSchema.extend({ source: z.string().optional(), image: z.string().optional(), lastModified: z.string().optional() }),
    // Pictures keep their paths rather than being bundled, so the site's CSS
    // can tell a recording from an asset sheet by where it lives. The renders
    // are in the Blob store: their sizes come from its manifest. Then a
    // paragraph of pictures becomes captioned figures (remark-figures),
    // inline code gets its break points (remark-code-breaks) and Markdown
    // structure fumadocs' components (remark-components).
    mdxOptions: applyMdxPreset({ remarkImageOptions: { useImport: false, onError: onImageError }, remarkPlugins: (v) => [remarkRenders, remarkMdxMermaid, ...v, remarkFigures, remarkCodeBreaks, remarkComponents] }),
    // Each page's Markdown after those plugins, for readers that want text
    // (app/llms.txt, app/llms-full.txt, app/llms.mdx).
    postprocess: { includeProcessedMarkdown: true },
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

// The site as Markdown, for language models and other readers of text:
// llms.txt lists every page, llms-full.txt holds the guide's pages whole (the
// reference repeats the source, which is on GitHub), and every page's own
// Markdown is at its address with .md after it (vercel.json).
export const docsLlms = llms(source, {
  renderPage: async (page) => `# ${page.data.title} (${page.url})\n\n${await page.data.getText('processed')}`,
});
export const markdownUrl = (page: Page) => `${process.env.NEXT_PUBLIC_DOCS_BASE_PATH ?? ''}/llms.mdx/${[...page.slugs, 'content.md'].join('/')}`;
