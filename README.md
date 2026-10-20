# Lighthouse

The documentation site for [Alchemy](https://github.com/PascalPixel/alchemy), the Golden Sun decompilation: its README, its folder guides and every file of both games' C, in Golden Sun's own letters.

Alchemy owns the source comments and folder guides. Lighthouse holds the Doxygen setup, theme and font tools.

## Build it

With [Doxygen](https://www.doxygen.nl) 1.18, perl and Node:

```bash
npm ci --prefix fonts
make
```

The site is in `out/site`. Alchemy should be checked out beside this folder. To choose another checkout, run `make ALCHEMY=/path/to/alchemy`.

## The letters

Weyard Sans and Weyard Mono are built on every run from the font sheets in Alchemy and are never committed. Weyard Emoji is made from [SerenityOS](https://github.com/SerenityOS/serenity)'s emoji, under its BSD 2-Clause license (`doxygen/weyard-emoji-LICENSE`).

## Publishing

The `Pages` workflow builds the site from the latest Alchemy each day and on every push here, and hands it straight to GitHub Pages.
