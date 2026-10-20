import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

// DOCS_BASE_PATH serves the site under a path, such as /alchemy on GitHub
// Pages; it is empty when the site is served from the root.
const basePath = process.env.DOCS_BASE_PATH ?? '';

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  reactStrictMode: true,
  basePath: basePath || undefined,
  // A static site has no image server: pictures are served as they are.
  images: { unoptimized: true },
  env: { NEXT_PUBLIC_DOCS_BASE_PATH: basePath },
};

export default withMDX(config);
