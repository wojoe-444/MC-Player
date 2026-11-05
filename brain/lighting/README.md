# brain/lighting: torches in the dark spots the bot actually walks

Walter authorized (2026-10-26) block placing for **torches** (this module), plus a **work-site chest** and **shaft ladders** (brain/mining, through the same line-of-sight placer in `torches.js`; nothing else is ever placed), to light poorly lit places on the routes the bot uses. Rules this module keeps (tests in `test/lighting.test.js`,
`test/mining.torches.test.js`):

- **Line of sight**: a torch only goes on a block the bot can see (`api.canSee` / raycast) and reach (4.5), after `api.ensureLineOfSight` walked to a viewpoint; otherwise the spot is skipped and not retried for an hour.
  Without `bot.world.raycast` nothing is placed.
- **Only plain floors**: solid full blocks with air above; never farmland, paths, water, lava, glass, slabs, stairs, leaves, containers, rails, doors ...; a plain neighbour within 2 is used instead.
- **Routes the bot uses**: a throttled `move` listener (every 2 s, on the ground, overworld) records the cells it stands on (`brain/state/lighting-state.json`, max 3000 cells, least used forgotten). Only route cells
  inside `config.areas` (Walter's base x -1100..-1020, y 100..200, z 2250..2360, +8) with block light below `placeBelow` (2) count as dark spots. Mining torches its own hallways (`brain/mining`).
- **Every placement is logged** (`TORCH at x,y,z ...` in brain.log, plus the last 300 in the state file). A torch covers route cells within 8 blocks for an hour; at most 6 torches per pass; one chat line per pass.
- **Torch supply**: with none in the bag it asks the crafting module (`craft 16 torch`, at most every 2 h); if that fails it says "no torches" at most every 6 h.
- **Idle routine** `lighting` (idle-only, on by default, 2 min interval, 10 min cooldown) and chat: `light up | place torches | fix the lighting` (risk high, runs now), `lighting status | how many torches have you placed`,
  `lighting routine on|off`.
- Never moves with lava selected (`safehand.ensureSafeForMove()` before each walk), stows the hand first, ctx checkpoints between spots, no timers (the listener is removed in `stop()`).

## For the integrator

Add `'lighting'` to `MODULES` in `brain/index.js` (after `'crafting'`). Nothing else; `torches.js` is also required by `brain/mining`. Light levels come from `bot.blockAt(p).light` (block light);
cells without light data are never judged dark.
