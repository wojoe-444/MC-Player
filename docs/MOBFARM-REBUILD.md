# Chicago mob farm: rebuild plan (2026-11-11)

Why: the farm has made nothing. Root cause is a Peaceful world (see memory `mobfarm-peaceful-root-cause`); behind it, the farm only gets about 0.7% of the world's
spawn chances. This is the plan to raise that share, ready for the moment spawning works. Numbers come from `tools/spawn-census.js` and the real save
(`Earth24kTrickyTrials`), model = vanilla 1.21 natural spawning: chance of a cell per attempt = (8 - skylight)/8 / (256 * (surface + 1 - minY + 1)), one attempt per eligible chunk
per tick, cells within 24 blocks (3D) of any player never count, chunks eligible while a player is within 128 blocks.

## What the numbers say
- Around the farm (198 eligible chunks) 26,100 dark spawnable cells exist, 60% of the chance mass in deep caves (y < 0). The farm's 164 pads are 0.71% of it.
- **Siting does not rescue it.** A grid search over dry, flat sites within about 220 blocks, each with the best parking spot for the bots, tops out at 2.6% at a 600-pad farm, no better than
  the same farm built in place. The cave mass is everywhere. So: no relocation; keep the shaft, kill level and chest where they are.
- **Size is the lever.** Pads are the farm's chance mass: 164 pads = 0.7%, 365 pads (R = 13) = 1.6%, about 600 pads (two decks) = 2.5%, like the benchmark farm `mobfarm-forever2k27`
  (about 620 open cells over two decks, 4 hoppers, 64 trapdoors, 22 block drop to a double chest; `docs/SCHEMATICS.md`).
- **Bots must not stand within 24 blocks of the pads.** Within 24 the pads under them stop counting (share 0%). The shaft top, home, tree farm and surface idling are all that close.
  Work below about y 35 is fine: it is more than 24 below a y 59 deck. When a bot idles or sleeps, park it at least 30 blocks from the nearest pad (3D), and not in a cave.
- Expect tens of kills per hour at best with the mob cap shared with the caves, not hundreds. Torching caves does not pay: 26,000 cells, and new dark cells appear as it digs.

## Steps (for the bot thread)
1. Repair the 17 cells that differ from the current design (`bot._schematic.diff` or `node tools/schematic.js diff --save <World> <design.json>`): holes in the drop-shaft wall at
   (-6031|-6029, 43..51, -2355), (-6030,35,-2353), (-6030,44,-2354), (-6019,61,-2355) and two missing torches at (-6026|-6023, 37, -2355). The design is `tools/schematic.js design`.
2. Enlarge the diamond room from R = 9 to R = 13 on the same platform y 59 (brain/mobfarm/geometry.js DEFAULTS.R; trench tips T grow with it, water tips stay at the ends).
   This digs about 370 blocks of rock inside the agreed room job; roof stays rock so skylight is 0 and no light source enters.
3. Add a second deck 3 blocks above (y 62), same plan, draining through its own trench into the same drop column, as the benchmark does. Needs a geometry change (levels).
4. Inspect with brain/inspect (now cell by cell against the schematic) and run the census on the saved world: farm share must read above 2%.
5. Keep the outcome check on: it will say `producing` once spawning works, and `blocked` while the world is Peaceful.

## Not decided
Walter's difficulty change. The bots cannot change it (no slash commands).
