# 🌋 Alchemy Docs

The documentation site for [Alchemy](https://github.com/PascalPixel/alchemy), the Golden Sun decompilation, built with [Fumadocs](https://fumadocs.dev).

The words live in Alchemy: its README, its folder guides and the `///` comments in its C. `scripts/content.ts` reads them from an Alchemy checkout, the C with [tree-sitter](https://tree-sitter.github.io), and writes the site's pages; the hand-written pages around them are in `content/docs`.

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
