# Renders

`backdrop.png` is the battle background the docs' ability casts are recorded
over: a 256x120 picture, the size of the game's own backdrops, which
`alchemy-devtools render psynergy --backdrop` loads in place of the battle's
background so the game draws, scrolls and blends it itself.

```sh
alchemy-devtools render psynergy --all --backdrop ../alchemy-docs/render/backdrop.png --out ../alchemy-docs/public/abilities
```

Run it from an Alchemy checkout with a built `out/tbs-en`, with devtools built
`--features render` (it needs libmgba). The ROM never leaves that checkout.
