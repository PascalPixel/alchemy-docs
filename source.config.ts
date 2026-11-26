import { applyMdxPreset, defineConfig, defineDocs } from 'fumadocs-mdx/config';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { remarkMdxMermaid } from 'fumadocs-core/mdx-plugins';
import type { Root, RootContent } from 'mdast';
import { readManifest } from './scripts/store';

// The renders are in the Blob store, which refuses a request for every picture's size: the sizes come from its manifest.
// A render is pixel art, shown at a whole multiple of its size: a 240-pixel screen three times over, or as wide as a phone.
function remarkRenderSizes() {
  const manifest = readManifest(process.cwd());
  return (tree: Root) => {
    const visit = (node: Root | RootContent) => {
      const e = node.type === 'image' ? manifest.get(decodeURI(new URL(node.url, 'file:').pathname.slice(1))) : undefined;
      if (e) {
        const shown = e.width * Math.max(1, Math.min(3, Math.floor(720 / e.width)));
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, width: String(e.width), height: String(e.height), className: ['render'], style: `width:min(100%,${shown}px)` } };
      }
      if ('children' in node) node.children.forEach(visit);
    };
    visit(tree);
  };
}

export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    // Each page is compiled when it is written: the bundled build runs out of memory.
    dynamic: true,
    // lead: 'body' when the page's text opens with its description, which is then not shown twice.
    schema: pageSchema.extend({ lead: pageSchema.shape.icon }),
    mdxOptions: applyMdxPreset({ remarkImageOptions: { external: false }, remarkPlugins: [remarkRenderSizes, remarkMdxMermaid] }),
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
