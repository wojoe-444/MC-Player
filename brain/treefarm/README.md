# brain/treefarm: chop trees, replant, put the wood away

`register(api)` returns `{ name:'treefarm', provides:['treefarm'], start, stop, status, onChat, engine, state, sitesFn }`.
Uses `api.canSee` / `api.ensureLineOfSight`, `api.gotoNear` (nav), the scheduler, `api.depositSmeltables`, `api.safehand`. Writes only `brain/state/treefarm-state.json`.

## Integrator: what to change

1. Add `'treefarm'` to `MODULES` in `brain/index.js`, **before `'routines'`**:
   `['safety', 'chat', 'router', 'excavation', 'nav', 'treefarm', 'routines', 'crafting', 'mining', 'villagers', 'dashboard']`
   (the routines module's `farm status` / `farm routine on` phrases would otherwise swallow "tree farm status"; mine are `tree status` / `tree routine on`, which work in any order).
2. Nothing in `join.js`. A broken module is skipped by `brain/index.js` like the others.
3. The idle routine `treefarm` is registered **on by default** (`defaultEnabled: true`, idle-only, priority FARM). `scheduler.setEnabled('treefarm', false)` or "tree routine off" turns it off. It only ever works known tree farm sites (below); with none known it asks Walter once a day and does nothing.

## What it does

- **Which trees**: natural, full-grown trees only: a log cluster standing on soil with at least 4 logs and natural (non-persistent) leaves next to it. Log cabins, houses, stripped logs and 3-log saplings are never touched. Species: oak, spruce, birch, jungle, acacia, dark oak, cherry, pale oak (mangrove is left alone).
- **Chopping a whole tree**: lowest log first, always from a spot with a clear ray (`api.canSee`; `ensureLineOfSight` walks to a viewpoint on the ground, never digs through leaves or walls). Tall trees: from the ground it cuts what is in reach, steps into the trunk column, and builds a **dirt pillar** under its feet (jump + place) a block at a time, cutting the logs above its head as it rises. Afterwards it digs the pillar away from the top, falling one block each time, and picks the dirt up again. Only blocks it placed itself (recorded in the state file) are ever dug as pillar. Stop, preemption (Walter chatting) or danger while up on the pillar: it comes down first (bounded to 8 s), then the abort goes through. A pillar found in the state at the start of the next run is taken down first.
  **The whole tree goes** (so the leaves can decay: leaves only decay when no log of any tree is within 6 blocks): the flood fill follows every connected log (26 neighbours, so diagonal limbs, branches, 2x2 trunks; up to 400 logs, 12 blocks around). A log hidden behind the tree's **own natural leaves** is uncovered by breaking the one leaf a crosshair would hit first (in reach, in view; the leaf drops sticks/saplings/apples; never anything but natural leaves of the tree, never a wall). A branch beyond arm's reach from the trunk column gets its own pillar in a free ground cell next to it (up to 5 columns per tree; the pillar dirt is picked up between columns). What cannot be done (no dirt, a log shut in behind walls, no standing place) is counted and told: "N log(s) were out of reach".
  **Canopy by hand** (Walter: do not wait for the leaves to decay, stay and break them): once the last log is gone the bot waits half a second for the leaf `distance` values to update and then breaks every natural leaf of the tree that is **doomed** (`distance` 7, i.e. no log of any tree holds it; a neighbouring tree's crown that still has logs is never touched), nearest first, each one only when it is in reach and the crosshair hits it first (line of sight; it walks to a viewpoint on the ground when needed). High canopy is reached from a pillar in the old trunk column (same machinery as the logs; leaves in the way of the jump are broken too), then the pillar is dug away and the dirt picked up. Tool (config `leafTools`, in order): hoe, shears, bare hand (never the axe). A hoe or the bare hand let the leaves drop saplings, sticks and apples; shears only give the leaf block (those are picked up too and put into the wood chest, never kept). Drops are collected every 12 leaves and at the end (radius of the canopy), so no item piles. Leaves it cannot reach (no dirt, no standing place) are left to decay. Replanting happens after the canopy is cleared. `clearLeaves:false` switches this off.
  **Fallback after the felling**: every felled tree is also remembered (state `decay`); 2 minutes later (`decayWaitMs`) the idle routine is due again, walks back, and picks up whatever decaying leaves dropped (up to 3 visits, never later than 25 minutes after the felling), then the usual unload runs.
  Climbing blocks: dirt, cobblestone, netherrack, cobbled deepslate, andesite, diorite, granite or tuff from the bag; if there are none it fetches up to what it needs from the wood chests, and if there is still none it cuts what it can reach and says "no dirt to climb with".
- **Replanting**: a sapling of the same species on every trunk base (a 2x2 dark oak gets four). The spot is stored as pending until the sapling is verified in the world, so a stop or restart cannot lose it; a missing sapling is taken from the wood chests (same species first); with none anywhere the spot stays pending and the summary says so.
- **Spruce first** (Walter: "we need spruce in the tree farm most of all", `config.json` `preferSpecies`, set it to null for none): at a tree farm site every felled tree is replanted with spruce whatever grew there, and groves are planted with spruce (taken from the wood chests if the bag has none; other saplings only as a fallback). In the woods ("chop trees" away from a site) a tree is replanted with its own species. Spare spruce saplings are kept up to 16 in the bag, other species 8.
- **Drops**: logs, saplings, sticks, apples near the tree are walked to and picked up; nothing is left lying around. Saplings and apples from decayed leaves are collected on the next visit to a site.
- **Putting wood away** (nothing is ever thrown away):
  - logs above `keepLogs` (config; 120 at the moment, was 32) in the bag go through `api.depositSmeltables({ force:true })` (furnace input chests, that helper's rules);
  - what that leaves, spare saplings (keeps 8 per species) and sticks (keeps 16) go to the wood chests in `config.json` `storage` (default: the stash chest at -1059,151,2326, then -1064,162,2326);
  - inventory nearly full mid-run: unload; if neither the furnace chests nor the wood chests have room it stops, says so and drops nothing.
- **Work-site chest** (Walter's time-economy rule, FEATURE-REQUESTS "Time economy"): if the bag has a `chest` item and the final chests are more than 40 blocks away, a full bag is emptied into a chest placed (line of sight) 2-5 blocks from the trees instead of walking back. At the end of the job one haul takes everything out to the final chests and the chest is picked up again. The ledger is in the state file; a restart finishes the haul on the next run (the routine counts as due while a work site exists). Walter OK'd temporary chests near the tree farm. With no chest in the bag and a job that far away, the run asks the crafting module for one once (`api.commands.dispatch(owner, 'make a chest')`: its own scheduler task, ingredients and crafting table are its business), returns `retry` (20 s) so that task can run, and continues when it is back; if no chest comes of it the job goes ahead without (`worksite.craft: false` turns the request off). The dispatch text is "make a chest" on purpose: the built-in tool-set `craft` command would swallow "craft ...". Not proven live with the real crafting module.
- **Schedule** (Walter): the idle routine does its regular run about every 45 minutes (`intervalMinutes`, in daytime and only when idle; "chop trees" / "get N logs" never wait for it and a manual run restarts the clock). Follow-up visits in between (take down a leftover pillar, haul a work-site chest, pick up drops where a felled tree stood) chop nothing and do not restart the clock.
- **Safety**: hostile within 8 blocks or health < 8 pauses the run and retries (30 s, 5 times); lava is never in hand while walking; no commands, no teleport, a night coming up ends an idle run after the current tree.

## Empty sites

A known site with no logs and no saplings within 14 blocks of its centre gets a grove planted by the idle routine (walks there, up to 9 saplings 4 apart, quiet, at most every 6 hours per site). The site at -1017,150,2349 is the waypoint `tree farm` in `waypoints.json`.

## Tree farm sites

The idle routine only works **sites**: `config.json` `sites`, sites Walter marks (`tree farm here`, a planted grove: saved in the state file) and every waypoint in `waypoints.json` whose name contains `tree farm`, `wood farm`, `lumber` or `grove`. Radius 40 around each site.
There is **no tree farm near the base yet**: Walter's save has no planted saplings within 300 blocks of -1059/2341 (only natural spruce/birch/cherry/oak woods; the chests hold 64 spruce saplings and 36 spruce logs). `plant a grove` starts one.

## Chat (all through `api.commands`, also `onChat`)

| say | does |
|---|---|
| `chop trees`, `cut down 5 trees`, `get wood`, `get 40 logs`, `gather some lumber`, `fell a tree` (risk high) | manual run, chat priority: sites first, then the woods around me (radius 40); 8 trees by default, `N trees` or `N logs` (stops when N are in the bag) |
| `tree status`, `how is the tree farm` | one-line status |
| `tree routine on` / `tree routine off` | idle routine switch (scheduler flag) |
| `tree farm here` (high) | marks where I stand as a tree farm site |
| `forget tree farm` | clears marked sites (waypoints stay) |
| `plant a grove`, `plant some trees`, `start a tree farm` (high) | plants up to 9 saplings on a grid 4 apart (7 free blocks above), registers it as a site |
| `stop chopping` | cancels the run |

Negations ("don't chop trees") and questions ("how many trees are there") are left to the other modules.

## Config (`config.json`)

`reach`, `minLogs`, `minLeaves`, `maxTreesManual/Idle`, `intervalMinutes` (45), `dayEnd`, `keepLogs/Saplings/Sticks`, `maxPillar`, `scaffold`, `storage`, `takeFromChests` (set false to stop it taking saplings/dirt out of chests), `worksite`, `grove`, `sitePattern`, `sites`.
**Taking items out of Walter's chests**: replant saplings and climbing dirt come from the wood chests. Walter said this is OK (2026-10-26); `takeFromChests: false` would switch it off.

## Tests

`node --test test/treefarm.test.js test/treefarm.clear.test.js test/treefarm.canopy.test.js test/treefarm.schedule.test.js` (61 tests, ~85 s, helpers in `test/treefarm.helpers.js`: mock bot with jump/fall physics, trees, items that fall, the real `brain/los.js`). Covers tree recognition (houses, stripped, small, persistent leaves), short and 16-tall trees, 2x2 dark oak, no dirt / dirt from a chest, line of sight, replant (timeouts, no sapling, from chest), deposit rules and full chests, danger, abort and crash on the pillar, only-own-blocks descent, lava in hand, idle site rules/quiet/night/due, grove, work-site chest (far, near, recovery), chat phrases, and loading through the real `brain/index.js`.

## Not proven live

The jump-and-place timing (`pillarUp`: polls the position every 25 ms and places when the feet are 1.0 above the start), real item pickup, `bot.dig` on chests/logs and leaf-blocked line of sight are mineflayer/server behaviour the mock only imitates: watch the first tall tree. Leaves are never broken, so a log hidden behind leaves is left (counted as "out of reach").
