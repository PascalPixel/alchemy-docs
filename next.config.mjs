import { readFileSync } from 'node:fs';
import { createMDX } from 'fumadocs-mdx/next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';

const withMDX = createMDX();

// DOCS_BASE_PATH serves the site under a path, such as /alchemy on GitHub
// Pages; it is empty when the site is served from the root.
const basePath = process.env.DOCS_BASE_PATH ?? '';

/** @type {(phase: string) => import('next').NextConfig} */
const config = (phase) => {
  const dev = phase === PHASE_DEVELOPMENT_SERVER;
  return {
    // The built site is static; `next dev` serves it without exporting, so
    // it can route the renders too.
    output: dev ? undefined : 'export',
    reactStrictMode: true,
    basePath: basePath || undefined,
    // A static site has no image server: pictures are served as they are.
    images: { unoptimized: true },
    env: { NEXT_PUBLIC_DOCS_BASE_PATH: basePath },
    // The renders are in the Blob store, which vercel.json routes /places,
    // /abilities, /guides and /story to on Vercel; `next dev` takes the same
    // routes from it, so pictures show while editing.
    ...(dev && {
      rewrites: async () => JSON.parse(readFileSync(new URL('./vercel.json', import.meta.url), 'utf8')).rewrites,
    }),
  };
};

export default (phase) => withMDX(config(phase));
