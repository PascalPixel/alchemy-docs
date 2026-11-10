# 🌋 Alchemy Docs

The documentation site for [Alchemy](https://github.com/PascalPixel/alchemy), [alchemy.pascalpixel.com](https://alchemy.pascalpixel.com), built with [Fumadocs](https://fumadocs.dev) on [Waku](https://waku.gg). Its pages are written from Alchemy's own READMEs and the `///` comments in its C, and its recordings of the game are kept in a Vercel Blob store.

## Build

With [Bun](https://bun.sh), and Alchemy checked out beside this folder:

```bash
bun install
bun run build
```

The site is in `dist/public`, and `bun run dev` serves it while you edit. To read an Alchemy somewhere else, set `ALCHEMY=/path/to/alchemy`. Vercel builds and publishes the site on every push here, and whenever Alchemy's main branch passes its checks.
