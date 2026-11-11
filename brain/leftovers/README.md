# brain/leftovers: the mess a bot leaves behind, found without anyone pointing at it

Walter, 2026-11-11 (screenshot at -6007,72,-2361): cobble and dirt scaffolding pillars that were never taken down, and trees cut only part of the way up whose remaining logs
kept whole canopies alive ("the recursive loop should have caught both of these before me"). This observer is the loop's eyes for both. It never moves the bot and never touches a block.

## What it looks for (every 2 minutes, around the bot, loaded chunks only)

| kind | how it is recognised | reported when |
|---|---|---|
| **scaffold** | a cell the provenance ledger (`brain/ledger`) says one of our bots **placed**, a filler block (cobblestone, dirt, stone, andesite, diorite, granite, tuff, netherrack, deepslate, sandstone, blackstone...), **still exactly that block**, in **no named space** (shaft, room, farm, pen), **open to the sky** (no natural rock within 8 above; our own stacked blocks are not cover), and last placed more than 10 minutes ago. Face-connected cells form a cluster: `pillar` (3+ high, at most 2x2), `tower` (3+ high, wider), `stray` (shorter). A cluster that touches planks, doors, glass, fences, slabs, stairs... is a wall, not scaffolding, and is dropped. | the cluster has been in view for 5 minutes |
| **tree** | a connected group of natural logs (26 neighbours, one species, mangrove and stripped logs excluded) in which **no log stands on solid ground**: the trunk is gone from the soil up. Needs no ledger (a living tree always has a log on soil); the ledger only adds who cut next to it. A log a bot placed is a build, and a tree running into unloaded chunks is not guessed at. It also counts the leaves within 2 blocks of the logs: what the remnant keeps alive. | in view for 5 minutes (a felling or a climb in progress is not reported) |

## What it does with a finding

* **telemetry**: an event `leftover` per cluster per scan, so the detector flags `leftover_scaffold` (med for one cluster; high for a pillar 4+ high, 3 clusters, or 45 minutes standing) and `leftover_trees` (med for one tree; high for 2 trees or about 40 leaves) show up in the live alerts and the Haiku reviewer's evidence (`brain/telemetry/detectors.js` `leftoverFlags`).
* **journal**: an event `leftover` (`what`, `id`, `kind`, `pos`, `n`, `h`, `leaves`, `species`, `block`, `by`, `via`, `standingMin`), salient the first time a cluster is reported, again every 3 hours while it stands. The rollup keeps the latest report of each cluster id under `rollup.leftovers.{scaffold,trees}.ids`.
* **work orders**: `reviewer/lib/orders.js` turns that rollup into the orders `leftover-scaffold` (one pillar or tower, or 4+ loose blocks; 1.5 lost minutes per block) and `leftover-trees` (any half-felled tree; 10 minutes each). Like the farmland trample order they carry their own problem statement and are opened by the dream without asking a model.
* **state**: `brain/state/leftovers.json` (clusters with their cells or logs) and `bot._leftovers = { scaffold(), trees(), scan(), last() }`.

## What takes them away (the sources, not only the alarm)

* **Scaffold**: the `tidy` step in `brain/autopilot/plan.js`. It now reads `bot._leftovers.scaffold()` as well as its own placed list, treats a column as a unit (a block qualifies when what sits on it is passable or is itself on the list, so a whole pillar comes down top first in one visit; before, only blocks with nothing on top qualified and each pass took one block per pillar), recomputes between rounds, lets proven pillars inside the home box go (the shelter's own cells still never do), and says in its note which blocks it could not reach. **Limit**: it digs from the ground beside the column, so a column more than about 6 blocks tall keeps its top (and is left whole, nothing is dug out from under it); the detector keeps flagging it.
* **Trees**: `S.chopTree` (`brain/autopilot/skills.js`) used to stop at `want + 2` logs and skip every log more than 6 above the bot, so a tree was cut from the bottom and the rest stayed. It now fells the whole connected tree it can reach from the ground and then hands what is left to `engine.finishRemnant` (`brain/treefarm/engine.js`) before replanting anything: the same pillar, hidden-leaf clearing, canopy-by-hand and descent as a whole felling. The `tidy` step also calls `finishRemnant` on any remnant the detector finds (within 70 blocks of home, daytime, a failed one is left alone for 90 minutes). `finishRemnant` only works on logs that stand on nothing, so a living tree is never started on from here; Walter's "keep natural trees" rule is about not felling living ones.

## Not proven

Tested offline (`test/leftovers.test.js`, `test/treefarm.remnant.test.js`): the pure detectors, the module on a fake bot with the real ledger and telemetry, the flags, the rollup and orders, the tidy column order, the engine finishing a half-felled tree on the mock bench with a pillar, and `S.chopTree` handing over. Not yet seen live: the module needs both bots restarted from MC-Player-live; the ledger covers placements only from its first run (older scaffolding is invisible to the scaffold detector, though the tree detector sees any remnant). After a restart check `brain/state/leftovers.json`.
