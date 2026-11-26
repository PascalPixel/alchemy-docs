// A paragraph of pictures becomes figures with captions a reader can see: the
// line a page wrote under the picture, else the first sentence of its alt
// text. A picture whose alt only repeats the paragraph above it gets none.
import type { Image, Paragraph, PhrasingContent, Root, RootContent } from 'mdast';

const CAPTION_MAX = 110;
const SENTENCE_END = /(?<=(?<!\b(?:Mt|Mr|Mrs|Ms|Dr|St|e\.g|i\.e|vs))[.!?])\s+(?=[A-Z0-9`"'*])/;

function captionOf(alt: string): string {
  const first = alt.trim().split(SENTENCE_END)[0].replace(/[.:]$/, '');
  if (first.length <= CAPTION_MAX) return first;
  const cut = first.slice(0, CAPTION_MAX);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), CAPTION_MAX / 2)).replace(/[,;:]$/, '')}…`;
}

const textOf = (node: unknown): string => {
  const n = node as { value?: string; children?: unknown[] };
  return n.value ?? n.children?.map(textOf).join('') ?? '';
};
const words = (s: string) => s.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

type Figure = { image: Image; caption: PhrasingContent[] };

// The paragraph's pictures, when it holds nothing else but a line under each.
function figuresOf(p: Paragraph): Figure[] | undefined {
  const kids = p.children.filter((k) => k.type !== 'text' || k.value.trim());
  const out: Figure[] = [];
  for (let i = 0; i < kids.length; ) {
    const image = kids[i++];
    if (image.type !== 'image') return undefined;
    const caption: PhrasingContent[] = [];
    if (kids[i]?.type === 'break') {
      i++;
      while (i < kids.length && kids[i].type !== 'image' && kids[i].type !== 'break') caption.push(kids[i++]);
      if (kids[i]?.type === 'break') i++;
    }
    out.push({ image, caption });
  }
  return out.length ? out : undefined;
}

export function remarkFigures() {
  return (tree: Root) => {
    const visit = (parent: { children: RootContent[] }) => {
      let before = '';
      for (const node of parent.children) {
        const figs = node.type === 'paragraph' ? figuresOf(node) : undefined;
        if (figs) {
          node.data = { hName: 'div', hProperties: { className: ['figures'] } };
          (node as { children: unknown[] }).children = figs.map(({ image, caption }) => {
            // The figure takes the picture's shown width, and the picture fills it.
            const props = (image.data?.hProperties ?? {}) as Record<string, unknown>;
            const { style, ...rest } = props;
            if (image.data) image.data.hProperties = rest as typeof image.data.hProperties;
            const alt = image.alt ?? '';
            if (!caption.length && alt && !(before && words(alt).startsWith(words(before)))) caption = [{ type: 'text', value: captionOf(alt) }];
            const children: unknown[] = [image];
            if (caption.length) children.push({ type: 'figcaption', data: { hName: 'figcaption' }, children: caption });
            return { type: 'figure', data: { hName: 'figure', hProperties: style ? { style } : {} }, children };
          });
        }
        before = node.type === 'paragraph' && !figs ? textOf(node) : '';
        if (node.type === 'blockquote' || node.type === 'list' || node.type === 'listItem') visit(node as { children: RootContent[] });
      }
    };
    visit(tree);
  };
}
