# 🌋 Alchemy Docs

The documentation site for [Alchemy](https://github.com/PascalPixel/alchemy), the Golden Sun decompilation, built with [Fumadocs](https://fumadocs.dev).

The words live in Alchemy: its README, its front page and section pages, its folder guides and the `///` comments in its C. `scripts/content.ts` reads them from an Alchemy checkout, the C with [tree-sitter](https://tree-sitter.github.io), and writes every page in `content/docs`, with the sidebar arranged by the links between Alchemy's pages. This repository keeps the site itself, the redirects from old addresses in `vercel.json`, and the records of the pictures; the pictures themselves, the renders of the game, are in a Vercel Blob store (see below).

## Build it

With [Bun](https://bun.sh), and Alchemy checked out beside this folder:

```bash
bun install
bun run build
```

The site is in `out`. To read an Alchemy somewhere else, set `ALCHEMY=/path/to/alchemy`. `bun run dev` serves it while you edit.

## Publishing

Vercel builds the site on every push here: it clones the latest Alchemy and runs the build (`vercel.json`). Alchemy's CI starts the same build through a Vercel deploy hook, its `VERCEL_DEPLOY_HOOK` secret, once a push to its main branch passes and its measurement is accepted.

`scripts/figures.ts` puts that measurement's progress figures (`PROGRESS.png`, `PROGRESS_CHART.png`, `history.tsv`, `source.tsv`) at the site's root from Alchemy's `decomp-reports` release; Alchemy's README shows them from there. While a commit's CI is still running, the newest accepted figures are used.

## Pictures

The renders of the game, every place map, event recording, ability cast and guide picture, live in the public Vercel Blob store `alchemy-renders`, not in git: there are thousands of them and a re-render replaces most. `vercel.json` rewrites `/places`, `/abilities`, `/guides` and `/story` to the store, so each picture keeps its address on the site, and `bun run dev` takes the same routes from it. Git keeps what the build reads instead of the files: `public/places/index.tsv` and `public/abilities/index.tsv`, which say what each render shows, and `render/manifest.tsv`, which lists every picture in the store with its hash, size in bytes and dimensions. The pages ask for each picture with the start of its hash as a query (`/places/vale-storm/map-0.png?v=…`), so a re-render is a new address and the store, Vercel's CDN and every browser can keep a picture for a year. Vercel's CDN keeps an address without the query (Alchemy's README links some) for an hour, but a browser that has one may keep it for the store's year.

A rewrite rather than a redirect keeps the address the same and lets Vercel's CDN cache each picture, so a visit costs Fast Data Transfer from the cache, and Blob Data Transfer only when the cache misses. A redirect would send browsers to the store's own address, which is cheaper per gigabyte but costs every picture an extra round trip and shows a different address.

To publish a re-render, render into a folder of its own (`alchemy-devtools render`, `render/README.md`) and run, with the store's token in `.env.local` (`vercel env pull .env.local`):

```bash
bun scripts/renders.ts publish ../renders/places places --prune
```

It uploads only the pictures whose hash the manifest doesn't already have, deletes with `--prune` the ones under that prefix the folder no longer has, copies the folder's TSV records into `public/places`, and writes the manifest to `render/manifest.tsv` and to the store. `--dry-run` shows what it would do. Commit `render/manifest.tsv` and the records: the build shows a render only when the manifest lists it. After `bun run build`, `bun scripts/renders.ts check` asks the store for every render the built pages show.
