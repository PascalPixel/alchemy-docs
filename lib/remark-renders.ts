// Gives every render a page shows its size and its content-keyed address.
// The pictures are in the Blob store, not public/, so the size fumadocs'
// remark-image would read from the file comes from render/manifest.tsv, and
// the address gains the picture's hash (lib/renders.ts). A render the manifest
// doesn't list fails the build, as a missing file in public/ did.
import type { Image, Root } from 'mdast';
import { readManifest, renderPath, renderRedirects, versioned } from './renders';

export function remarkRenders() {
  const manifest = readManifest(process.cwd());
  const current = renderRedirects(process.cwd());
  return (tree: Root) => {
    const visit = (node: { type: string; children?: unknown[]; data?: Image['data'] } & Partial<Image>) => {
      if (node.type === 'image' && node.url) {
        const old = renderPath(decodeURI(node.url));
        const path = old && current(old);
        if (path) {
          const e = manifest.get(path);
          if (!e) throw new Error(`[renders] /${path} is not in render/manifest.tsv`);
          node.url = versioned(path, e);
          node.data ??= {};
          node.data.hProperties = { ...node.data.hProperties, src: node.url, width: String(e.width), height: String(e.height) };
        }
      }
      for (const c of node.children ?? []) visit(c as typeof node);
    };
    visit(tree as never);
  };
}

// remark-image's error for a render, whose file is not in public/ by design.
export function onImageError(e: Error) {
  if (/Failed obtain image size for \/(places|abilities|guides|story)\//.test(e.message)) return;
  throw e;
}
