import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import type { ComponentProps } from 'react';
import { AnchorRedirect } from './anchor-redirect';

const DefaultImage = defaultMdxComponents.img;

// A picture from public/, found under the site's base path.
function Image({ src, ...props }: ComponentProps<typeof DefaultImage>) {
  const base = process.env.NEXT_PUBLIC_DOCS_BASE_PATH ?? '';
  return <DefaultImage src={typeof src === 'string' && src.startsWith('/') ? `${base}${src}` : src} {...props} />;
}

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    img: Image,
    AnchorRedirect,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
