# brain/lightup: light the dark spots that compete with the mob farm

Walter, 2026-11-10: part of running a mob farm is scanning for where hostile mobs can spawn around it and lighting those places up. The new underground farm
(`brain/mobfarm`) had not logged a kill because every dark cave in spawn range takes mobs from the same cap. Lighting a space with mobs in it is a task of its own:
sometimes the right move is not a fight but to rush in, light it, and get out, then let despawn do the rest.

## The one scan through blocks

This task is the single exception to the no-x-ray rule (Walter, 2026-11-10, "survival-acceptable even if players can't do it"): `plan.scan` lists the dark spawnable
cells in the loaded chunks around the farm, wherever they are, in sight or not. The list is used only to choose where to walk. Everything else stays as before:
the walk is the normal pathfinder (nothing dug, `dig: false`), a torch goes down only when the floor block is in view and within reach (`S.canSee`, then the
vanilla server checks reach), and the farm's own platform and kill chamber are never lit.

## Files

| file | what |
|---|---|
| `plan.js` | pure: `scan` (dark spawn spots), `flood` (the light of one torch), `connected` (what the bot can reach), `plan` (fewest torch cells that light every spot), `route`. Tested on synthetic grids in `test/lightup.plan.test.js`. |
| `world.js` | adapts a bot to the `world` interface of `plan.js` (block data of loaded chunks, light from `brain/autopilot/light.js`). |
| `../autopilot/lightup.js` | the run: scan, plan, walk, place, fall back. Think-brain skill `light_up`, fallback routine step `mob-farm-light`, `G.lightUp`. |

## What counts as a dark spawn spot

An open cell with an open cell above it, on a full solid block monsters spawn on, with block light 0 (since 1.18 monsters spawn at block light 0; the server's per-block
light that mineflayer reports is scrambled on this build, so light is flooded from the visible light sources like `brain/autopilot/light.js` does everywhere else).
Cells under open sky are left out unless asked for (`surface: true`): by day they never spawn anything. Sealed pockets (no air path from the bot, a long drop counts as a
way) are counted and reported but not lit, because reaching them would mean digging, which this job does not include.

## Choosing torches

Greedy set cover over candidate cells: the torch cell whose light (flooded exactly like the game: 14, minus one per cell, stopped by opaque blocks) reaches the most
still-dark spots goes first. Rules:

* **Spacing**: never closer than torch, air, air, torch (some axis differs by 3 or more), counting the torches already standing and the ones chosen. Same rule as `S.torchCrowded`.
* **Keep the platform dark**: a candidate whose light would reach the diamond room (`keepDark`) is rejected. The platform, the drop column and the kill chamber are also
  excluded from the scan, so they are never "fixed".
* Spots a torch cannot reach under those rules are reported as `leftover`, not forced.

## The run (the dance)

1. Guards: health 14+, not asleep, not on the surface at night, 3+ torches (it crafts from coal and sticks when it can; otherwise it says `no torches`).
2. Up to 3 passes of scan, plan, route (nearest next, so the bot is in and out of a cave once), at most 20 torches and 8 minutes per run.
3. Per spot: if a creeper is within 9 of it, 3+ hostiles are around it, or one stands on it, the spot is postponed once and another goes first; if only such spots are left the
   bot falls back to the safe spot (the farm's `rest` corridor, or where the run began), waits 8 s and goes in anyway. Otherwise it walks to within reach, makes sure it can see the floor
   block, places the torch (`S.placeAgainst`: forced look, spacing re-checked, no placing while a mob is in sword reach), and checks the torch is really there.
4. After each spot, with 2+ mobs within 10 or a creeper within 8, it waits out the combat reflex and falls back if they are still there. Health under 9 ends the run with a fall back.
5. Fighting is the combat reflex's job (`brain/combat`), not this task's. Lit spots stop spawning; mobs already inside despawn once the bot is more than 32 blocks away, which the rest
   corridor (22 to 30 blocks from the pads) is built for.
6. Saved in `st.lightUp` (last run, total torches placed, the last 120 torch cells, next run time: 90 min after a clean run, 20 after progress, 45 after nothing).

## Using it

* think-brain: `light_up {action: run|scan|status, radius?, max?}`. Run it after the farm is built, when the farm has not logged kills for a while, and after exploring caves near it.
  `scan` only counts (no walking).
* fallback routine: step `mob-farm-light` (after `mob-farm-build`), when `brain/state/mobfarm.json` has a platform.
* `G.lightUp.run(opts)`: `r` (48), `dy` (40), `maxTorches` (20), `ms`, `minHealth` (14), `abortHealth` (9), `passes` (3), `surface`.

## Checked in vanilla 1.21.6

`tools/trial/lightup-lab.js` (see `tools/trial/README.md`): a stone block with a sealed platform, four chambers, tunnels, a staircase to a lower chamber, a sealed pocket and two existing
torches; the bot is a survival player with a stone sword and the real combat reflex. Light is judged by the server's own light through a datapack predicate, not by the client's model.

## Known limits

* Spawn pressure also comes from outside the loaded chunks; the scan sees only what the client holds (render distance).
* Cells with a one-high ceiling (spiders) and 3-high spots (endermen) are not counted; slimes in swamp chunks and cave spiders from spawners are out of scope.
* Spots with no path or no view are skipped for the run (no digging, no bridging, no pillaring). Many such spots show up as `leftover` or in the failure notes.
* The surface at night is not lit by default (`surface: true` to include it); the torch-spacing and tree-farm tasks already cover the base.
