// Turns a paragraph of pictures into figures with visible captions. The alt
// text of a picture explains it in full, but a reader never sees alt text, so
// each figure shows a short caption: the text a page already wrote under the
// picture (`![Mind Read](...)\` then `Mind Read`), else the alt text's first
// sentence, shortened. A picture whose alt only repeats the paragraph above it
// (a place's event GIF under the line that names the event) gets none. The
// full alt text stays on the image and is the caption when it is enlarged.
//
// It also gives every picture a height: an SVG with a width and a viewBox but
// no height came out of remark-image as height NaN, which left no room for it
// while it loaded.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Image, Paragraph, PhrasingContent, Root, RootContent } from 'mdast';
import { toString } from 'mdast-util-to-string';

// The longest caption shown in full, in characters; a longer first sentence
// is cut at a word and ends with an ellipsis.
const CAPTION_MAX = 110;

// A sentence ends at a full stop, question or exclamation mark followed by a
// space and a capital, a quote or a code name; not after an abbreviation.
const SENTENCE_END = /(?<=(?<!\b(?:Mt|Mr|Mrs|Ms|Dr|St|e\.g|i\.e|vs))[.!?])\s+(?=[A-Z0-9`"'*])/;

export function captionOf(alt: string): string {
  const first = alt.trim().split(SENTENCE_END)[0].replace(/[.:]$/, '');
  if (first.length <= CAPTION_MAX) return first;
  const cut = first.slice(0, CAPTION_MAX);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), CAPTION_MAX / 2)).replace(/[,;:]$/, '')}…`;
}

const blank = (n: PhrasingContent) => n.type === 'text' && !n.value.trim();
const words = (s: string) => s.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

// The size an SVG declares: its width and height, or its width and the
// viewBox's proportions.
function svgSize(url: string): { width: number; height: number } | undefined {
  const file = join(process.cwd(), 'public', decodeURI(url.split(/[?#]/)[0]));
  if (!url.startsWith('/') || !existsSync(file)) return undefined;
  const head = readFileSync(file, 'utf8').match(/<svg\b[^>]*>/)?.[0] ?? '';
  const attr = (name: string) => Number.parseFloat(head.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? '');
  const box = head.match(/\sviewBox="([^"]*)"/)?.[1].trim().split(/[\s,]+/).map(Number);
  const width = attr('width') || box?.[2];
  const height = attr('height') || (width && box ? (width * box[3]) / box[2] : NaN);
  return width && height ? { width, height: Math.round(height) } : undefined;
}

// A render of the game (a recording, a place's map, a guide's take-apart
// picture) is pixel art, scaled by whole steps where the column allows: a
// 240-pixel GBA screen is shown three times over on a wide column (up to
// SCALED_MAX), and as wide as the column on a phone. Any other picture is
// shown at its own width, or the column's if that is narrower.
const RENDER = /^\/(places|abilities|guides|story)\//;
const SCALED_MAX = 720;
export const isRender = (url: string) => RENDER.test(url) && !/\.svg(?:$|[?#])/.test(url);
const shownWidth = (url: string, width: number) => (isRender(url) ? width * Math.max(1, Math.min(3, Math.floor(SCALED_MAX / width))) : width);

// The width a figure takes, from its picture's size: set on the figure, so
// the room is there before the picture loads.
function sized(image: Image): number | undefined {
  const props = (image.data?.hProperties ?? {}) as Record<string, unknown>;
  if (!(Number(props.width) > 0 && Number(props.height) > 0) && /\.svg(?:$|[?#])/.test(image.url)) {
    const size = svgSize(image.url);
    if (size) {
      image.data ??= {};
      image.data.hProperties = { ...props, width: String(size.width), height: String(size.height) };
    }
  }
  const width = Number((image.data?.hProperties as Record<string, unknown> | undefined)?.width);
  // The games' own picture files are drawn at twice their size by the CSS.
  return width > 0 && !image.url.includes('/pictures/') ? shownWidth(image.url, width) : undefined;
}

type Figure = { image: Image; caption: PhrasingContent[] };

// A paragraph's figures, when it holds nothing but pictures, each optionally
// followed by a line break and the caption the page wrote for it.
function figuresOf(p: Paragraph): Figure[] | undefined {
  const kids = p.children;
  const out: Figure[] = [];
  let i = 0;
  while (i < kids.length) {
    const k = kids[i];
    if (blank(k)) {
      i++;
      continue;
    }
    if (k.type !== 'image') return undefined;
    const fig: Figure = { image: k, caption: [] };
    i++;
    if (kids[i]?.type === 'break') {
      i++;
      while (i < kids.length && kids[i].type !== 'image' && kids[i].type !== 'break') fig.caption.push(kids[i++]);
      if (kids[i]?.type === 'break') i++;
    }
    out.push(fig);
  }
  return out.length ? out : undefined;
}

export function remarkFigures() {
  return (tree: Root) => {
    const visit = (parent: { children: RootContent[] }) => {
      let before = '';
      for (const node of parent.children) {
        if (node.type === 'paragraph') {
          const figs = figuresOf(node);
          if (figs) {
            node.data = { ...node.data, hName: 'div', hProperties: { className: ['figures'] } };
            node.children = figs.map(({ image, caption }) => {
              const width = sized(image);
              let text = caption;
              const alt = image.alt ?? '';
              if (!text.length && alt && !(before && words(alt).startsWith(words(before)))) text = [{ type: 'text', value: captionOf(alt) }];
              const children: PhrasingContent[] = [image];
              if (text.length) children.push({ type: 'figcaption', data: { hName: 'figcaption' }, children: text } as never);
              return { type: 'figure', data: { hName: 'figure', hProperties: width ? { style: `width: min(100%, ${width}px)` } : {} }, children } as never;
            });
          }
          before = figs ? '' : toString(node);
          continue;
        }
        before = '';
        if (node.type === 'blockquote' || node.type === 'list' || node.type === 'listItem') visit(node as { children: RootContent[] });
      }
    };
    visit(tree);
  };
}
