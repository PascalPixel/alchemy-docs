# 🌋 Alchemy Docs

The documentation site for [Alchemy](https://github.com/PascalPixel/alchemy), the Golden Sun decompilation, built with [Fumadocs](https://fumadocs.dev).

The words live in Alchemy: its README, its front page and section pages, its folder guides and the `///` comments in its C. `scripts/content.ts` reads them from an Alchemy checkout, the C with [tree-sitter](https://tree-sitter.github.io), and writes every page in `content/docs`, laid out as [Doxygen](https://www.doxygen.nl) lays out its HTML, in two sidebar tabs. The guide is Doxygen's main page and related pages: the README, the games' front and section pages, the folder guides and the places, arranged by the links between Alchemy's pages. The reference is what Doxygen makes of the C: the file list, a page for every folder, file, structure and union, an entry for every declaration whether it has a `///` comment or not, and indexes of every name by kind. This repository keeps the site itself; the renders of the game and the records that say what each shows are in a Vercel Blob store (see below). It keeps no list of old addresses: pages are renamed as the source is understood, and an address the site no longer has goes to the nearest page above it that exists (`app/not-found.tsx`).

## Build it

With [Bun](https://bun.sh), and Alchemy checked out beside this folder:

```bash
bun install
bun run build
```

The site is in `out`. To read an Alchemy somewhere else, set `ALCHEMY=/path/to/alchemy`. `bun run dev` serves it while you edit.

## Publishing

Vercel builds the site on every push here: it clones the latest Alchemy, its history without its old files, and runs the build (`vercel.json`); a page's last-updated date is the day its Alchemy source last changed in that history. Alchemy's CI starts the same build through a Vercel deploy hook, its `VERCEL_DEPLOY_HOOK` secret, once a push to its main branch passes and its measurement is accepted.

`scripts/figures.ts` puts that measurement's progress figures (`PROGRESS.png`, `PROGRESS_CHART.png`, `history.tsv`, `source.tsv`) at the site's root from Alchemy's report archive (the `decomp-reports` release and its numbered successors); Alchemy's README shows them from there. While a commit's CI is still running, the newest accepted figures are used.

## Pictures

The renders of the game, every place map, event recording, ability cast and guide picture, live in the public Vercel Blob store `alchemy-renders`, not in git: there are thousands of them and a re-render replaces most. `vercel.json` rewrites `/places`, `/abilities`, `/guides` and `/story` to the store, so each picture keeps its address on the site, and `bun run dev` takes the same routes from it. Beside the pictures the store keeps what the build reads about them: `places/index.tsv` and `abilities/index.tsv`, which say what each render shows (with the renderer's other records, such as `places/skipped.tsv`), and `renders-manifest.tsv`, which lists every picture with its hash, size in bytes and dimensions. `bun run build` first fetches the manifest and the two indexes from the store's public address into `build/renders` (`bun scripts/renders.ts fetch`), so a build needs no token. The pages ask for each picture with the start of its hash as a query (`/places/vale-storm/map-0.png?v=…`), so a re-render is a new address and the store, Vercel's CDN and every browser can keep a picture for a year. Vercel's CDN keeps an address without the query (Alchemy's README links some) for an hour, but a browser that has one may keep it for the store's year.

A rewrite rather than a redirect keeps the address the same and lets Vercel's CDN cache each picture, so a visit costs Fast Data Transfer from the cache, and Blob Data Transfer only when the cache misses. A redirect would send browsers to the store's own address, which is cheaper per gigabyte but costs every picture an extra round trip and shows a different address.

To publish a re-render, render into a folder of its own (`alchemy-devtools render`, `render/README.md`) and run, with the store's token in `.env.local` (`vercel env pull .env.local`):

```bash
bun scripts/renders.ts publish ../renders/places places --prune
```

It uploads only the pictures whose hash the manifest doesn't already have, deletes with `--prune` the ones under that prefix the folder no longer has, uploads the folder's TSV records beside its pictures, and writes the manifest to the store, keeping a copy of each in `build/renders`. `--dry-run` shows what it would do. Nothing is committed: the next build fetches the records and the manifest, and shows a render only when the manifest lists it. After `bun run build`, `bun scripts/renders.ts check` asks the store for every render the built pages show.

To take particular pictures down, list their store paths one a line (`places/vale-storm/map-0.png`) and run `bun scripts/renders.ts delete LISTFILE`: it deletes each from the store and from the manifest and writes the manifest back as publish does, refusing the whole list if any path is not in the manifest; `--dry-run` shows what it would delete.

A guide page's card and preview image show a still of its first recording: `bun run content` fetches only the start of each such recording from the store and keeps its first frame in `public/stills` (`lib/stills.ts`), a few kilobytes where the recording is megabytes.
