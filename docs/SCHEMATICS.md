# Schematics

A schematic is what a bot (or a person) considers a build to be, cell by cell. It exists so the inspector can answer "is this what we meant?" block by block, so a
rebuild has a known target, and so the Bot Dashboard can show the build as a textured 3D model with a bill of materials.

## Format (v2, `brain/schematic/format.js`)
Every cell that is not `any` or `air` names **a specific block** (what the viewer draws and the bill counts) and **a role** (what the cell must do, which decides what else
is allowed there). Walter 2026-11-11: blocks have generic roles, "but I still wanted *some* specific block to be shown when rendered".
- `palette` entries: `{ role, block, props?, level?, alt?, scenery? }`; `palette[0]` is always `{ role: 'any' }`.
  - role `solid`: a full opaque cube that blocks light, is not flammable, does not fall and does not glow. `block` is always `stone`: a cell we are neutral about is drawn
    and counted as plain stone (Walter 2026-11-11), whatever stood there when it was captured; any other solid block (cobblestone, deepslate, an ore ...) passes the check.
    `F.neutral` / `F.upgrade` enforce it on every file read, so older files and bot captures follow the rule too (entries that become equal merge).
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

## Test drive a build: `tools/schematic.js world`
Turns a catalog schematic (or a raw `.schem`) into a Minecraft 1.21.6 singleplayer save you can walk around in: creative, daytime, no mobs, a superflat world with the build pasted so
its centre is at x=0, z=0. The tool writes the region files and `level.dat` itself (`brain/schematic/anvil.js`, `testworld.js`), so no game or server is needed, it takes about
a second, and it never touches an existing save (it refuses a name that exists; `--overwrite` only replaces a folder it made, marked by `.schematic-test-world`).
```
node tools/schematic.js world lithic-spire                       -> saves/Test - The Lithic Spire (grass, build on the ground, you spawn north of it facing it)
node tools/schematic.js world lithic-spire --kind void --name "Test - Spire in the void"   (build at y=64 on a small platform at spawn)
node tools/schematic.js world path/to/build.schem --name "Test - X"   (the file as it is: every block property kept)
node tools/schematic.js world path/to/deep_node.schem --surface 70 --rock path/to/deep_node_viewer.html --name "Test - Deep Node"
```
- Saves go to `%APPDATA%\.minecraft\saves` (`--saves <dir>` or `MC_SAVES_DIR` to change). Open it in **Minecraft 1.21.6** (vanilla or Fabric): Singleplayer, "Test - ...". It is a vanilla
  world (only the vanilla data pack is enabled, flat generator), so Fabric mods neither help nor get in the way; Terralith / Tectonic do not touch a flat world. Cheats are on (`/tp`, `/gamemode`).
- A catalog schematic keeps only some block properties, so `settle.js` works out the rest from the neighbours: fence / wall / pane connections, wall posts, hanging lanterns, persistent leaves.
  A raw `.schem` already has them all and keeps them. Block entities (chest contents, sign text) are not in a schematic and stay empty.
- Underground builds (`--surface N`: layer N is the first layer above the ground, e.g. 70 for Deep Node): the ground becomes deep stone up to layer N-1 and the rooms of the build are cut
  out of it. A `.schem` cannot say which air is a room and which is the rock around it; `--rock <viewer.html>` reads the rock mask the generator embeds in its viewer page. Without it the
  tool guesses (air that reaches the sides of the box is rock), which only works for rooms that are fully walled in.

## The library
- `mobfarm-forever2k27`: Smeo444's working surface mob farm from the earlier world (dark platform, cross of water channels, 2x2 drop of 22 blocks, slabs over hoppers into a
  double chest). Trimmed 2026-11-11 to the farm itself: 1,118 neutral wall cells drawn as stone (they were cobblestone, stone and three stray ores), and the terrain, chests, vines,
  crafting tables and torches that stood around it are gone. Same size and origin, and every functional cell is unchanged, so a build in progress keeps its target.
- `starter-hut`: a built-for-looks example (oak hut, fenced yard, torches), `aesthetic` mode, from `tools/schematic.js hut`.
- `lithic-spire`, `lithic-spire-earthfill`, `walled-palace`, `starter-base`, `starter-tower`, `walled-market-town`, `deep-node`, `deep-node-2` (288x84x288), `snow-glass-villa`: builds-for-looks, some big, builds-for-looks imported from Sponge `.schem` files (WorldEdit / Litematica exports) with
  `node tools/schematic.js import <file.schem> --id ... --kind ...` (`brain/schematic/sponge.js`). Aesthetic mode, every block exact; wall and fence connection flags are not
  kept (they follow from the neighbours). In `lithic-spire-earthfill` the plain stone fill under the build is scenery. Drop any other `.schem` through the same command into
  `brain/schematic/library/` to add it to the catalog.

## Following a schematic in the loop (2026-11-11)
Walter: following a schematic should be part of the recursive loop "when appropriate. It's really only needed seldom, like when the decision has been made to build a mob farm ...
this makes verifying construction success much easier and more reliable." The answer to "is it done?" is the world compared with the schematic, cell by cell, not a routine that
reached its last line.

**When** (`brain/schematic/loop.js`, the gate; the default answer is no):
- everyday jobs (torch, chest, bridge, pillar, shaft, door, ladder, a small hut ...) never follow one, even when asked;
- the **mob farm** follows its schematic as soon as the decision to build it is made (`FOLLOW_BY_DEFAULT`; the benchmark farm `mobfarm-forever2k27` is preferred);
- anything else only when named on purpose (Walter, a work order, the bot's own plan: `explicit`) and only if it has at least `MIN_CELLS` (120) checked cells.

**What happens** (`brain/schematic/follow.js` is pure and tested; `brain/autopilot/schematicbuild.js` is the hands):
1. `bot._schematic.startJob({ kind, id?, near?|at?, reason })` picks the schematic and the spot: the anchor near the shaft that needs the least digging, never into lava, an unloaded
   chunk, a no-dig area or a block somebody else made (the ledger says who made it). The job lives in `brain/state/schematic-job.json`.
2. A pass turns the diff into work: `dig` (open space wanted, rock there), `place`, `replace`, `fluid` (a water source), `toggle` (an open trapdoor), and the ones it will not do:
   `forbidden` (a lava cell: the bots never place lava) and `drain` (water where air is wanted). Flowing water is `settle`: it follows from its source, so it is not counted wrong.
3. The work is ordered: digs outward from open space (a tunnel two cells high from the nearest open cell when nothing is reachable), placements bottom up each against a block that
   stands, torches and ladders, water last. How each block goes down follows the game's rules (`recipe`): a hopper faces away from the face you click, a trapdoor clicked on a side face
   faces that side and takes top/bottom from the click height, a wall torch hangs on the block behind it.
4. After every pass the world is read again (`verify`): percent right, cells off by kind, the first wrong cells. A cell that fails three times is marked stuck and reported, never retried
   forever. When every checked cell matches the job is `complete`, the build is registered as a room whose blueprint is the schematic (`viaSchematic`), and a farm schematic's anchors
   (kill spot, kill box, chests) are written to `brain/state/mobfarm.json` for the kill routine.

**Where the number goes**
- `brain/inspect`: a room with `viaSchematic` is inspected cell by cell (`stats.percentRight`); a torch where open air is wanted is a fault.
- `brain/outcome`: a farm whose schematic is not complete is `building`, not `overdue`, and its grace clock starts when it completes.
- journal: events `schematic` (`start`, `state` with percent, cells off and the first wrong cells); the dream reads them as facts.
- work orders (`reviewer/lib/orders.js`): a job `stuck` (25 minutes of work without one more cell right) becomes an order written in code from the event, no model asked.
- dawn brief: `state.schematicJob` (percent, state, `step: schematic-build`), so the bot's own plan can focus or hold the step.
- planner: `STATE.schematic_job` and the skill `follow_schematic` (choose | start | work | status | verify | abandon); fallback routine step `schematic-build`, which also *decides* the
  mob farm (storage room first, no farm yet) ahead of the old geometry builder. When no schematic fits near the shaft the old builder carries on as before.

**Lab**: `node tools/trial/schematic-build-lab.js` (trial server): builds a small farm-like room with commands, captures it, erases it, and has a survival bot rebuild it from the schematic alone.

**Proven and not proven** (2026-11-11): on a vanilla 1.21.6 trial server the lab rebuilt a 9x9x9 room (245 cells to dig, a sideways hopper into a chest, a slab, an open trapdoor, wall and floor torch, ladder, a water source, the tunnel
plugged from outside) from the schematic alone: 100% in 253 s, room registered, kill routine config written. Not proven: the full 2100-cell benchmark farm, a real cave site with loose gravel or water seams, a second bot, and
blocks in a pit one block wide and two deep (the bot cannot see the pit floor from its edge, so those cells end up `stuck` and become a work order; the benchmark keeps its hoppers and chests in an open chamber).
