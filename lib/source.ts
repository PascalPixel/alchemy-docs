import { docsRoute } from './shared';
import { defineDocs } from 'fumadocs-mdx/macro';
import { applyMdxPreset } from 'fumadocs-mdx/config';
import { loader } from 'fumadocs-core/source';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { z } from 'zod';
import { remarkMdxMermaid } from 'fumadocs-core/mdx-plugins';
import { onImageError, remarkRenders } from './remark-renders';

const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    // source: the repository file or folder a generated page is made from,
    // for the page's GitHub link.
    schema: pageSchema.extend({ source: z.string().optional() }),
    // Pictures keep their paths rather than being bundled, so the site's CSS
    // can tell a recording from an asset sheet by where it lives. The renders
    // are in the Blob store: their sizes come from its manifest.
    mdxOptions: applyMdxPreset({ remarkImageOptions: { useImport: false, onError: onImageError }, remarkPlugins: (v) => [remarkRenders, remarkMdxMermaid, ...v] }),
  },
  meta: {
    schema: metaSchema,
  },
});

export const source = loader({
  baseUrl: docsRoute,
  source: docs.toFumadocsSource(),
  plugins: [],
});
