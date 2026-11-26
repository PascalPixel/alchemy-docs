import { defineConfig, defineDocs } from 'fumadocs-mdx/config';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';

export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    // Each page is compiled when it is written: the bundled build runs out of memory.
    dynamic: true,
    schema: pageSchema,
    postprocess: {
      // As text: the default is a component, which dynamic mode writes out as its tag.
      includeProcessedMarkdown: { output: 'string' },
    },
  },
  meta: {
    schema: metaSchema,
  },
});

export default defineConfig();
