# brain/mining: legit strip mining (no x-ray)

`mine <ore> <amount>` runs a strip mine the way a regular player does. Written for Walter's "Legit mining module" request; follows `brain/INTERFACE.md`.
`register(api)` returns `{ name:'mining', start, stop, status, engine, state, go, resume, stop }`. Nothing mines by itself; the task only exists after Walter's command.
A job he started that was still running (not stopped, not parked, not finished) when the bot went down is continued at the next start (`autoResumeOnStart`, state `resumeOnStart`); a stopped or parked one stays parked.
His own jobs run at priority EXCAVATE+1 (ahead of the excavation, below furnace/farm/chat); the idle routine stays at EXCAVATE.

## Chat

| phrase | does |
|---|---|
| `mine diamonds 5`, `mine 10 iron`, `go mine for coal`, `mine a stack of coal`, `mine redstone x20`, `start mining lapis`, `strip mine copper 12` (risk high) | starts a job; no amount = a default per ore (diamond 5, iron/coal/copper 32, gold/lapis 16, redstone 32) |
| `mining status`, `how is the mining going` | one line: gained/target, hallway cells done, ore blocks mined |
| `stop mining`, `pause mining`, `don't mine anymore` | parks the job (progress kept) |
| `resume mining`, `keep mining` | continues the parked/saved job |
| `haul mining`, `empty the work-site chest` | finishes a haul from the work-site chest (after a stop/restart) |
| `yes` / `yes, use the wood` / `use the wood for the ladders` / `no` / `stair mine instead` | answers the shaft's wood question (bare yes/no only while it is open, 12 h) |
| `mining routine on|off` | the idle routine |
| `mine emeralds` / `mine ancient debris` / `mine quartz` | polite refusal (not strip-minable / not in the overworld) |
| general `stop` / `resume` | `scheduler.userStop()` parks it (`onUserStop:'park'`); bare `resume` wakes it |

Ores: diamond, iron, coal, gold, redstone, lapis, copper (stone and deepslate variants). `config.json` has drops, pickaxe tier, depth.

## What "legit" means here (each point has a test in `test/mining.*.test.js`)

- **No x-ray.** `sight.js` is the only place that looks at the world. A block is acted on only when it has an exposed face **and** a clear ray from the eye
  (`api.canSee`, i.e. `brain/los.js` / `bot.world.raycast`). A pocket full of ore behind a wall has exposed faces but no ray, so it is ignored. `bot.findBlocks` /
  `findBlock` are never used for ore or liquid. Block names inside the scan cube are read only to pre-filter candidates; nothing that fails the ray leaves `sight.look()`.
  Hidden ore never decides where to dig, which direction to go or which branch to take. If `bot.world.raycast` is missing the job parks and digs nothing.
- **Every dig is preceded by a line-of-sight check** (and `bot.canDigBlock`), also right before the swing, after equipping.
- **Pattern.** 1 wide, 2 high trunk (default 48 long, `pattern.trunkLength`) with a branch to the left and right at every 3rd cell (default 16 long,
  `pattern.branchLength`): hallway, two solid blocks, hallway. Every block of the strip touches a hallway, so everything in it is exposed. Order: nearest junction's branches first,
  then 3 more trunk cells. When the whole strip is dug and the target is not met the job says so; `mine <ore>` again continues from the end (via the recorded waypoint).
- **Depth.** Hallway feet level: diamond -58 (range -58..-50), redstone -58, gold -16, lapis 0, iron 16, copper 40, coal 45. If the bot is already inside the range it mines
  where it stands; otherwise it digs **stairs** (one down per step, never straight down): per step the 3 cells ahead are cleared in the order they are in view, the landing's
  floor has to be seen, solid and dry before the bot steps; a gap, lava, water or a base wall under/ahead makes it turn right (3 turns, then park).
- **Safety (without peeking).** Only cells and liquids in view are judged: never dig a cell that is liquid or within 2 of visible liquid, back off (stop the hallway and walk back
  to the junction) when lava is in view within 5 / water within 3 / liquid within 2 of the next cell, or when standing in liquid; stop when the floor ahead is missing, lava, magma
  or not in view; sand/gravel that falls into a hole is dug again (a column that never ends stops the hallway); only natural filler is dug (planks, rails, chests, spawners,
  Walter's blocks end the hallway); an ore next to visible liquid is skipped. **Floor ore** (the floor of a walkable cell) is never dug from above: it is taken from the side
  after its branch is finished (trunk floors at the end of the strip), so the walkway is not holed while it is still used.
- **Only torches are ever placed** (Walter, 2026-10-26; nothing else, no blocks to cover lava). A torch goes on the floor of the hallway cell the bot stands in, only with a clear ray to that floor
  block (`brain/lighting/torches.js`, the placer shared with the lighting module): when the block light there is below 2 (at least 3 cells after the last torch), or about every 9 cells when the server sent
  no light data. Out of torches: it asks the crafting module once (`craft 16 torch`, needs coal + sticks); if that fails mining simply goes on without. Mobs are the safety module's job; the job itself
  pauses when a hostile is **in view** within 7 blocks or health < 8 (retry every 20 s, park after 6).
- **Protected ground.** `config.protect.boxes` (Walter's base x -1100..-1020, y 100..200, z 2250..2360 + 8) is never dug and no new mine is started inside it (the job parks and asks
  where to start).

## Existing mines first

"Go mine for X" first looks for a mine: (1) an unfinished strip of its own at a fitting depth (`brain/state/mining-state.json`), (2) a waypoint named `mine ...`
(Walter's `waypoints.json` via "set waypoint mine diamond", and Xaero waypoints, read through `brain/nav/waypoints.js`), best fit first: name contains the ore (3), or any
`mine` waypoint whose y is in the ore's range (2); mines named for another ore are skipped. It walks there (long trips: `commands.dispatch("go to <waypoint>")`, the nav module takes over
and mining resumes afterwards), follows the open hallway to its end mining what is in view, and starts the pattern from there. (3) Otherwise it digs its own strip at the right depth
(stairs first) and records it as waypoint `mine <ore>` (`mine <ore> 2` for a far second one).

## Supplies and storage

- **Tools.** Needs a pickaxe of the ore's tier (coal wood, iron/copper/lapis stone, diamond/gold/redstone iron) with >= 25 uses left, and >= 120 pickaxe uses in total. Otherwise it asks
  the crafting module: `commands.dispatch(owner, "craft stone pickaxe" | "craft iron pickaxe")`; the craft task preempts the job (it fetches ingredients from chests, walks to the table), the job resumes
  afterwards from its saved progress and walks back to the mine. After 2 failed asks (or no craft task started and still short) it parks and says what is missing. It never mines ore with a
  too-weak tool. The cheapest pickaxe digs filler, shovels dirt/gravel/sand, the best pickaxe is kept for ore.
- **Storage.** With 6 or fewer free slots it calls `api.depositSmeltables({ ctx, quiet:true })` (raw metals, ores, cobble over 48, cobbled deepslate ... into the furnace input chests). If that
  returns `full` the job parks and waits for Walter. What gets deposited still counts toward the target. Things the furnace chests do not take (dirt, gravel, andesite, tuff ...) are put in
  `config.storageChests` if set (line of sight required); otherwise the job parks at 3 free slots rather than leave a pile.
- No item piles: more than 30 items within 24 blocks (after trying to pick them up) parks the job.

## Work-site chest (Walter's time economy rule)

Far from the final chests (more than `worksite.minDistance` = 60 blocks from `worksite.home`) a full bag does not send the bot walking back. A chest (from the bag, else `craft chest` through the crafting module)
is placed in the mine in the first cell of a **finished** branch next to its junction (out of the way, with a clear ray to the floor block), recorded as waypoint `worksite mining` and as a ledger in the state file
(`state.worksite`: position, contents, slots). Everything that would be hauled (the smeltable rules of `brain/smeltables.js`: raw metals, cobble over 48, cobbled deepslate ...; plus the junk and valuables list in
`config.junk`) goes in there when the bag fills; tools, food, torches, coal and the crafting reserve stay. At the end of the job (or when the chest is 90% full) it takes the contents out, calls
`api.depositSmeltables({force:true})` + the storage chests, repeats until the chest is empty and finally picks the chest up and removes the waypoint. The ledger survives a stop or a restart: `haul mining` /
`empty the work-site chest` finishes it. Chest placement, opening and breaking all need a clear ray; a chest that is gone from the ledger position is forgotten, never searched for. If no chest can be had or placed
the job falls back to the old behaviour (deposit helper). The gained count includes what is in the chest.

## Mining off the ladder shaft (Walter, 2026-10-26: "build mines off this shaft at the appropriate y")

When no mine is known and the ore lies below the shaft top (`config.shaft.top` = -1042,128,2281), the shaft is the entry (new mines may not start inside the base, y>=92): the bot walks to the top ladder, climbs down the
existing ladders and **extends the ladder down to the ore's depth** (iron y16, so about 112 ladders), one block at a time: the cell below is dug from the ladder (filler only; it is in view), what the opening shows is
checked before stepping (lava or water in view, a cave opening beside the shaft, an open void under it, no solid back wall -> stop and park; unseen caves are never followed), then a **ladder is placed on the back wall**
(taken from the existing ladders' facing) with a clear ray to that wall block and normal reach, and the bot climbs down. Only the shaft column below the top is exempt from the base protection. At the ore depth the
trunk starts straight out from the ladder (away from its wall, so the branches never touch the ladder's wall), the mine is registered as waypoint `mine iron`, and later jobs walk down the ladder to it (the walk
requires the exact depth) and mine on without placing anything.
- **Wood**: ladders (7 sticks = 3) are crafted up front through the crafting module in batches of 48 (`craft 48 ladder`). If that is more than `shaft.askAbovePlanks` (24) planks, the job parks and asks Walter
  ("about 112 ladders ... ~266 sticks = 133 planks = 34 logs. I have ... OK to use that wood?"). His answer: "yes" / "yes, use the wood" / "use the wood for the ladders" -> crafts and goes on; "no" / "stair mine instead" /
  "no ladders" -> **stair mine from the shaft bottom** (down the existing ladders, then ordinary stairs; the base protection is lifted below the bottom of the existing ladders only). The answer is kept (`state.ladder.approval`).
  If crafting fails the job parks with "wood is short" (the tree farm will be a source).
- Torches are not placed while climbing (no floor); lighting resumes in the mine.
- **Line of sight to the wall (fix 03:35)**: the ray from the ladder to the wall block below crosses the thin panel of the shaft's own ladder, which the real raycast treats as a hit, so the check said "no line of sight" at the
  first extension. Shaft placements (`torches.placeLadder` / `placeSupport`) now use a ray in which the shaft's ladders do not count as an obstacle (a real block in the way still hides the wall). The bot also steps down
  into the new cell first (a one block drop onto the floor it has seen) and hangs the ladder from inside it.
- **Blocks Walter allowed in the shaft** (cobblestone, from the digging; every one with a clear ray and logged): a *backing block* in the missing wall cell when the ladder has no wall (placed from inside the cell against the
  block under or behind the wall cell), and a *block under the lowest ladder* when a gap is open under it.
- **Cave / void / no wall before the ore depth**: no more parking. If the bot is already inside the ore's depth band (iron: y -8..40, so y26 is fine) the strip starts right there, out of the ladder (never into the wall the
  ladder hangs on); if it is outside the band, a stair mine continues from there. Water, lava and out-of-ladders still stop the job.
- **Leaving the mine** (`exit.js`): `come up` / `leave the mine` / `get out of the mine` (CHAT task), and automatically when a shaft job finishes or parks below y100. Order: (1) in the shaft column: climb the ladders directly
  (jump held on the ladder, push into the wall if it does not move), no pathfinder; (2) walk to the ladders (nav); (3) cut off: dig a 1x2 hallway at the bot's own level straight to the shaft column (every cell through the usual checks:
  filler only, nothing beside visible liquid, floor in view) and enter the ladder from the side; (4) below the lowest ladder: stairs up, else pillar up (dig the cell over the head, jump, cobblestone under the feet).

## Idle routine (mining as the fallback when nothing else is due)

Walter wants mining in the bot's own rotation. `scheduler.routine({ name:'mining', idleOnly:true, defaultEnabled:true, priority: EXCAVATE })`, so it only runs after the quiet time, yields the moment Walter types
and is lower than farm, furnace, sleep, eating and safety. It starts a normal mining job on its own when ALL hold: overworld, health >= 14, food >= 12, cooldown over (10 min after a finished run; 30 min doubling up to
4 h after a run that parked), not held, and some ore is below its stock target (`config.routine.wants`: coal 128, iron 128, diamond 16, redstone 64, lapis 32, gold 32, copper 64; stock = bag + `chest-index.json`,
counting raw and smelted forms). Routines exist to keep the bot busy (Walter), so stocks are not a gate: it picks the ore with the biggest relative gap (with every stock full: the relatively lowest one) that the pickaxes in the bag can mine and a **known mine** exists for (own unfinished strip, or a `mine ...` waypoint). It does **not**
dig a brand-new mine by itself (`routine.allowNewMine`: false); instead it says once every 12 h that it would like to and how to give it one ("mine iron 10" once, or a waypoint called "mine iron").
One line when it starts ("Nothing else to do, so I am going mining for 5 diamond ..."), parks say themselves at most every 6 h. `stop mining` (or the general stop) holds the routine for 2 h; any manual `mine ...` /
`resume mining` clears the hold; `mining routine off|on` switches it (scheduler flag). Dashboard: `status().routine`.

## Files

Reads: `brain/nav/waypoints.js` + `xaero.js` (read only), `waypoints.json`. Writes: `brain/state/mining-state.json` (+ `.tmp`) and **`waypoints.json`** (one entry per new mine, atomic
read-modify-write, `source:"mining"`; the one exception to INTERFACE.md rule 7, because that is where "set waypoint" and the nav module look; `config.recordWaypoint:false` or an injected
`api.waypoints.{list,add}` replaces it).

## For the integrator (Improve alt bot reliability and skills)

1. `'mining'` is in `MODULES`; also add `'lighting'` (see `brain/lighting/README.md`). No change to `join.js`.
2. Optional: in the `negation()` handler add `else if (/\bmin(e|ing)\b/.test(what)) scheduler.cancel('mining')`; "don't mine ..." is also handled by this module's own stop phrase.
3. The module relies on `api.canSee`, `api.depositSmeltables`, `api.commands.dispatch`, `api.scheduler.status()`, `api.statePath`. All exist in the current `brain/index.js`.
4. `BRAIN_DISABLE=mining` or `brain/state/disabled-modules.json` switches it off.

## Tests (offline)

`node --test test/mining.test.js test/mining.integration.test.js test/mining.torches.test.js test/mining.routine.test.js test/mining.worksite.test.js test/mining.shaft.test.js test/lighting.test.js` (helpers: `test/mining.helpers.js`: a rock world with real walkability search for `tryGoto`, a raycast that sees
through air/liquid only, gravity, and an independent line-of-sight audit that fails any dig/open without a ray; the integration test runs through the real `brain/index.js` with the
real crafting module). Covers parsing, geometry (3-apart, 2 solid between), sight (pocket ore, wall ore, lava, fail-closed), the strip (exact set of dug cells, exposed ore mined, hidden ore
never touched, `findBlocks` banned), floor ore, lava/water/gap/gravel/obstacle stops, base protection, stairs (one down, floor seen, turns at a hidden shaft), tools/crafting, deposit/full
chests, waypoints (existing, Xaero, nav trip, recording), preempt/resume, stop/resume, state.

## Phrases tested

mine diamonds 5 | mine 10 diamonds | go mine for iron | mine me 5 iron | start mining diamonds | mine a stack of coal | mine redstone x20 | mine lapis lazuli 10 | strip mine iron 12 |
go mine for a few diamonds | hey can you mine diamonds 1 please | mining status | stop mining | don't mine anymore | resume mining | mine emeralds 4 | (not claimed) mine is bigger than craft

## Ladders are sacred (Walter's screenshot, 2026-10-26 11:28)

The first live strip started straight into the wall the ladders hang on, so the bottom ladders dropped ("you sort of dug a hallway where the ladder used to be"). Now: a block that a ladder
hangs on (`sight.supportsLadder`) is never dug, by the hallway, by an ore dig or by the exit tunnel; a ladder cell is never part of a hallway (`ladder-column`, except the exit's final step into the
ladder); at the shaft bottom the wall behind the ladder is not a candidate direction; if no side works at the lowest rung, the bot climbs up to `shaft.maxRungs` (8) rungs and tries the sides there.
Walling in (cobblestone plugs at voids and gaps) is fine, per Walter.
