# Schematics

A schematic is what a bot (or a person) considers a build to be, cell by cell. It exists so the inspector can answer "is this what we meant?" block by block, so a
rebuild has a known target, and so the Bot Dashboard can show the build as a textured 3D model with a bill of materials.

## Format (v2, `brain/schematic/format.js`)
Every cell that is not `any` or `air` names **a specific block** (what the viewer draws and the bill counts) and **a role** (what the cell must do, which decides what else
is allowed there). Walter 2026-11-11: blocks have generic roles, "but I still wanted *some* specific block to be shown when rendered".
- `palette` entries: `{ role, block, props?, level?, alt?, scenery? }`; `palette[0]` is always `{ role: 'any' }`.
  - role `solid`: a full opaque cube that blocks light, is not flammable, does not fall and does not glow. `block` is the one shown (cobblestone); any other solid block
    passes the check (stone, deepslate ...).
  - role `block`: exactly this block and these properties (slab type, trapdoor half and open, hopper facing, stairs facing), or one of `alt`.
  - role `water` / `lava` (with the level), role `air` (open), role `any` (not checked, not drawn).
  - `scenery: true`: the natural world around the build (terrain, trees), kept for the picture. Drawn when "Show surroundings" is on, never checked.
- `mode`: `functional` (a farm, a mine: walls are role `solid`, only the shell of rock touching open space is kept) or `aesthetic` (a house, a statue: every block is exact, air
  is not kept, `masks` limit what counts). Pick `aesthetic` when the look is the point.
- `rle` over cells, x fastest, then z, then y. `counts` per palette entry. Format 1 files (roles only, `sources` counts) are upgraded on read (`F.upgrade`): each wall
  entry gets its most common source block. `node tools/schematic.js migrate old.json` rewrites a file; re-capture from the world to get the real block of every cell.
- Capture: open cells, special blocks, the shell, then `surround` cells (default 2) of natural world as scenery. `seeds` (connectivity) and `masks` (boxes) isolate a build
  that stands among trees or a neighbour's chests.

## Who uses it
- `brain/schematic` (bot module): `bot._schematic.capture({id, room|box, seeds, masks, mode, surround, name})`, `.diff(id, at?)`, `.list()`; think skill `save_schematic`
  (`mode: "aesthetic"` for builds made for looks). Saves to `bot-shared/schematics` (or the bot's `brain/state/schematics`). `library/` holds the shipped ones.
- `brain/inspect/exact.js`: the cell-by-cell check against a build's registered schematic. Roles decide what matches, scenery and `any` are never checked.
- `brain/schematic/bom.js`: the bill of materials (one row per block, all facings together) and the raw materials (cobblestone to mine, logs to chop, smelting operations).
- `tools/schematic.js`: capture / show / migrate / diff / design / hut / hoppers against a world save (the region files), for people and agents.
- Dashboard page "Schematics" (`dashboard/schematiccast.js`, `/api/schematics`, `/api/schematics/:id`, `dashboard/web/src/lib/schematic/` and `components/SchematicView.tsx`):
  build picker, Isometric / Front / Top, layer slicer (up to layer, single layer, arrow keys), ghost hidden blocks, surroundings, auto-rotate, raw materials, a bill of
  materials you click to isolate a block type, orbit / pan / zoom, hover to inspect (block, position, properties, and what else the role allows). Blocks are drawn from
  original procedurally painted 16x16 tiles (`appearance.ts`), no game assets; colours follow the dashboard theme.

## The library
- `mobfarm-forever2k27`: Smeo444's working surface mob farm from the earlier world (dark platform, cross of water channels, 2x2 drop of 22 blocks, slabs over hoppers into a
  double chest). Captured from the save with each wall cell naming its block (cobblestone 926, stone 189, ores).
- `starter-hut`: a built-for-looks example (oak hut, fenced yard, torches), `aesthetic` mode, from `tools/schematic.js hut`.
- `lithic-spire`, `lithic-spire-earthfill`, `walled-palace`, `starter-base`, `starter-tower`, `walled-market-town`, `deep-node`, `deep-node-2` (288x84x288), `snow-glass-villa`: builds-for-looks, some big, builds-for-looks imported from Sponge `.schem` files (WorldEdit / Litematica exports) with
  `node tools/schematic.js import <file.schem> --id ... --kind ...` (`brain/schematic/sponge.js`). Aesthetic mode, every block exact; wall and fence connection flags are not
  kept (they follow from the neighbours). In `lithic-spire-earthfill` the plain stone fill under the build is scenery. Drop any other `.schem` through the same command into
  `brain/schematic/library/` to add it to the catalog.
