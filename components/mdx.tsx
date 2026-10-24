import defaultMdxComponents from 'fumadocs-ui/mdx';
import { ImageZoom } from 'fumadocs-ui/components/image-zoom';
import type { MDXComponents } from 'mdx/types';
import type { ComponentProps } from 'react';
import { AnchorRedirect } from './anchor-redirect';
import { Mermaid } from './mermaid';
import { PageCard, PageCardList } from './page-cards';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Field, FieldTable } from './field-table';

const DefaultImage = defaultMdxComponents.img;

// A render of the game is pixel art (lib/remark-figures.ts sizes its figure).
const RENDER = /^\/(places|abilities|guides|story)\//;

// A picture from public/ or the renders, found under the site's base path,
// with its width and height from the build so its room is kept while it
// loads, and enlarged when tapped, with its whole alt text as the caption.
function Image({ src, width, height, alt, style, className, ...props }: ComponentProps<typeof DefaultImage>) {
  const base = process.env.NEXT_PUBLIC_DOCS_BASE_PATH ?? '';
  const path = typeof src === 'string' ? src : undefined;
  if (!path) return <DefaultImage src={src} width={width} height={height} alt={alt} style={style} className={className} {...props} />;
  const url = path.startsWith('/') ? `${base}${path}` : path;
  const w = Number(width);
  const h = Number(height);
  const render = RENDER.test(path) && !/\.svg(?:$|[?#])/.test(path);
  const image = (
    <DefaultImage
      src={url}
      alt={alt}
      width={w > 0 ? w : undefined}
      height={h > 0 ? h : undefined}
      style={style}
      className={[render && 'render', className].filter(Boolean).join(' ')}
      {...props}
    />
  );
  if (path.includes('/pictures/')) return image;
  return (
    <ImageZoom src={url} alt={alt} caption={alt} zoomInProps={{ className: render ? 'render' : undefined }}>
      {image}
    </ImageZoom>
  );
}

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    img: Image,
    AnchorRedirect,
    Mermaid,
    PageCard,
    PageCardList,
    Step,
    Steps,
    Field,
    FieldTable,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
