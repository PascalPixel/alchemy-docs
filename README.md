# Alchemy Docs

The documentation site for [Alchemy](https://github.com/PascalPixel/alchemy), the Golden Sun decompilation: its README, its folder guides and every file of both games' C, in Golden Sun's own letters.

Alchemy owns the source comments and folder guides. Alchemy Docs holds the Doxygen setup, theme and font tools.

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

Alchemy's successful `CI` workflow triggers this repository's `Pages` workflow with the exact source commit, successful run ID and generator commit pinned in Alchemy's `.github/docs.ref`. There is no schedule. Pushes and pull requests here check the site without deploying it.

This repository owns the Pages deployment at https://pascalpixel.github.io/alchemy-docs/. The workflow checks the source run, generator pin and current Alchemy main before deploying. A failed or superseded build leaves the previous site online. Progress images come from Alchemy's immutable `decomp-reports` release; `versions.tsv` on the site identifies both revisions.

To publish a theme change, update Alchemy's generator pin and run its normal verified landing. Alchemy stores `ALCHEMY_DOCS_TOKEN`, a fine-grained GitHub token restricted to this repository with Actions read and write permission; the token can trigger this workflow but cannot write source or deploy Pages directly. Configure Pages here to use GitHub Actions.

Generated game fonts are served by this site. Splitting the publishing repository does not establish permission to redistribute them or guarantee isolation from a copyright complaint.
