# Alchemy's documentation site

A trial site for Alchemy built with [Fumadocs](https://fumadocs.dev) on
Next.js, exported as static files. It shows the same project as the Doxygen
trial: the README as the home page, ☀️'s folder guides, and a reference page
for every C file of both games.

## Build and look at it

It needs [Bun](https://bun.sh) and [Doxygen](https://www.doxygen.nl)
(`brew install doxygen` on macOS, `apt install doxygen` on Linux).

```sh
cd docs
bun install
bun run build       # the pages, then the static site in out/ (a minute or two)
bun run start       # serves out/ on http://localhost:3000
bun run dev         # or work on it with live reload
```

The site is a set of static files; any static file server works, but opening
`out/index.html` straight from the disk does not, as its pages load their
scripts from `/_next/`. To serve it under a path, such as `/alchemy` on GitHub
Pages, build with `DOCS_BASE_PATH=/alchemy`.

## Where the pages come from

Nothing generated is committed: `bun run content` (which `build` and `dev`
run first) makes these from the repository each time.

- `content/docs/index.md` from the root `README.md`, and the guides under
  `content/docs/tbs/` (`world/field.md`, `battle/effects/index.md` and so on)
  from the folder READMEs of `games/tbs/src`: their text as it is, with links
  into the repository pointed at the site or at GitHub. `GUIDES` in
  `scripts/content.ts` says which README goes where.
- `content/docs/tbs/source/` and `content/docs/tla/source/`: a page for every
  folder and every `.c` and `.h` file under each game's `src` and `include`,
  with the file's description and its structs, enums, types, macros, data and
  functions. `scripts/content.ts` copies the C through `scripts/filter.ts`
  into `.doxygen/src` (the filter keeps a paragraph laid out by hand, such as
  a frame timeline, as it is written), runs Doxygen once per game
  (`doxygen/Doxyfile`, both at once) and turns its XML into the pages. A
  function is on the page of the file that holds its body.
- `content/docs/reference/tbs/` and `content/docs/reference/tla/`: every
  structure, and every name A to Z.
- `public/pictures/`: a few of the effects' PNGs, copied from
  `games/tbs/src/graphics/battle_fx`.

Written by hand: `content/docs/**/meta.json` (the sidebar's order, apart from
the source folders') and the `.mdx` pages: the games' overviews, Start here,
the guide groups, Maps, Pictures and the Reference page. The site's name and
links are in `lib/layout.shared.tsx` and `lib/shared.ts`.

## Its weight

About 4,200 pages. Every page carries its sidebar, so `lib/tree.ts` sends
each page only the source folders on its own path open; the search index
(`app/api/search/route.ts`) holds the guides in full and the source pages'
titles, descriptions and the names they define. The source and reference
pages get no social card and are left out of `llms-full.txt`. Even so the
export is about 1.6 GB (the search index 37 MB, 5 MB compressed), over
GitHub Pages' 1 GB limit for a site.

## Publishing

`.github/workflows/docs.yml` can publish the site to GitHub Pages, but only
when started by hand from the Actions tab; nothing publishes it on a push.
