import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

// Each page-writing worker gets a 512 MB heap; Next drops --max-old-space-size from its workers.
if (process.env.IS_NEXT_WORKER !== 'true' && process.argv.includes('build')) process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --max-heap-size=512`;

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  reactStrictMode: true,
  // A static export has no image server.
  images: { unoptimized: true },
  // fumadocs-mdx's dynamic mode compiles pages with esbuild, a native program.
  serverExternalPackages: ['esbuild'],
  // search.json reads every page, which takes longer than Next's default minute.
  staticPageGenerationTimeout: 600,
  experimental: { cpus: 4 },
  webpack: (config) => {
    // fumadocs-mdx's other compiler, which is not installed.
    for (const part of ['compile', 'remark-llms', 'remark-include', 'preset']) config.resolve.alias[`@fumadocs/satteri/${part}`] = false;
    return config;
  },
};

export default withMDX(config);
