import { docsRoute } from './shared';
import { defineDocs } from 'fumadocs-mdx/macro';
import { applyMdxPreset } from 'fumadocs-mdx/config';
import { loader } from 'fumadocs-core/source';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { z } from 'zod';

const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    // source: the repository file or folder a generated page is made from,
    // for the page's GitHub link.
    schema: pageSchema.extend({ source: z.string().optional() }),
    // Pictures keep their paths in public/ rather than being bundled, so the
    // site's CSS can tell a recording from an asset sheet by where it lives.
    mdxOptions: applyMdxPreset({ remarkImageOptions: { useImport: false } }),
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
