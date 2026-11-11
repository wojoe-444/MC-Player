# Schematics

A schematic is what a bot (or a person) considers a build to be, cell by cell, but as generic as the build allows. It exists so the inspector can answer "is this
what we meant?" block by block, so a rebuild has a known target, and so the Bot Dashboard can show the build as the Bases page's metal cast.

## Format (v1, `brain/schematic/format.js`)
- `palette` of roles: `any` (not checked), `air`, `solid` (a full opaque cube that blocks light, is not flammable, does not fall and does not glow: cobblestone, stone,
  deepslate ... all fit), `water` / `lava` with the level that matters, `block` (exact block, only the properties that matter: slab type, trapdoor half and open, hopper facing).
- `rle` over cells, x fastest, then z, then y. `counts` and `sources` per palette entry keep what the captured world really used (the legend's "was: cobblestone 926").
- Capture keeps open cells, special blocks and the shell of solid cells touching open space; everything else, and anything unreadable, is `any`.
  `seeds` (connectivity) and `masks` (boxes) isolate a build that stands among trees or a neighbour's chests.

## Who uses it
- `brain/schematic` (bot module): `bot._schematic.capture({id, room|box, seeds, masks})`, `.diff(id, at?)`, `.list()`; think skill `save_schematic`. Saves to the bot's
  `brain/state/schematics` (shared copies in `bot-shared/schematics`). `library/` holds the shipped ones.
- `brain/inspect/exact.js`: the cell-by-cell check against a build's registered schematic, run with the other inspector checks.
- `tools/schematic.js`: capture / show / diff / design / hoppers against a world save (the region files), for people and agents.
- Dashboard page "Schematics": `dashboard/schematiccast.js`, `/api/schematics`, `/api/schematics/:id`. The open space and pieces are drawn; walls are the legend.

## The library
`mobfarm-forever2k27`: Smeo444's working surface mob farm from the earlier world (dark platform, cross of water channels, 2x2 drop of 22 blocks, slabs over hoppers into a double chest).
