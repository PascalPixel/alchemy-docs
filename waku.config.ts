import { readFileSync } from 'node:fs';
import { defineConfig } from 'waku/config';
import { fumadocsMdx } from 'fumadocs-mdx/vite';
import tailwindcss from '@tailwindcss/vite';

// The renders are in the Blob store, which vercel.json routes /places,
// /abilities, /guides and /story to on Vercel; `waku dev` takes the same
// routes from it, so pictures show while editing.
const { rewrites } = JSON.parse(readFileSync(new URL('./vercel.json', import.meta.url), 'utf8')) as { rewrites: { source: string; destination: string }[] };
const proxy = Object.fromEntries(
  rewrites
    .filter((r) => r.destination.startsWith('https:'))
    .map((r) => {
      const prefix = r.source.replace(/\/:path\*$/, '');
      const target = new URL(r.destination.replace(/\/:path\*$/, ''));
      return [prefix, { target: target.origin, changeOrigin: true, rewrite: (p: string) => target.pathname + p.slice(prefix.length) }];
    }),
);

export default defineConfig({
  // Every page is written at build, so the site is the folder dist/public,
  // which Vercel serves with vercel.json's routes; on Vercel, Waku would
  // otherwise choose its Vercel adapter, whose output replaces those routes.
  unstable_adapter: 'waku/adapters/node',
  vite: {
    resolve: {
      tsconfigPaths: true,
      dedupe: ['waku'],
    },
    server: { proxy },
    // The preview images' renderer (src/lib/og.tsx) reads its font and its
    // WASM from beside its own files, so it is loaded from node_modules.
    environments: {
      rsc: { resolve: { external: ['@vercel/og'] } },
      ssr: { resolve: { external: ['@vercel/og'] } },
    },
    plugins: [tailwindcss(), fumadocsMdx()],
  },
});
