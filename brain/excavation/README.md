# brain/excavation: carve Walter's underground room

Replaces the legacy `excavate.js` loop with a scheduler task that follows `brain/INTERFACE.md` (section 9, `provides: ['excavation']`).
`register(api)` returns `{ name:'excavation', provides:['excavation'], start, stop, status, engine, state, go, pause }`.
It is loaded automatically from the folder name; `join.js` needs **no change** (the existing `if (!BRAIN && ...)` guard already disables the legacy auto-resume).

**It never starts by itself.** Nothing is submitted at load. The task exists only after Walter says "excavate" / "resume excavation", or after a
restart while his go was still in effect (task was running and had not been stopped, paused or finished; `autoResumeOnStart` in `config.json`).
A legacy `exc-state.json` with `active:true` is *not* treated as a go. Today's state is `active:false`, so nothing digs until Walter says go.

## What it does

- Room: box x -1069..-1053, z 2299..2344, floor y136, digs y138..145 (10 blocks tall since 2026-10-26; y146-149 stay as ceiling under the hall floor at y150). 735 open columns in 90 sections of 3x3; section ids are the
  old `gx,gz` ids, so the 13 finished sections (x -1069) are kept: 77 left. Order is the old serpentine.
- **Resume**: progress in `brain/state/excavation-state.json` (via `api.statePath`). First load imports `exc-state.json` read-only (done, dug,
  skipped); after that our file wins. Saved after every section; a pause, preempt or restart never redoes a finished section.
- **Safety, checked again right before every dig** (`plan.checkCell`):
  - lava/water/bubble column/waterlogged blocks are never dug, and nothing next to liquid (all 6 neighbours); an unloaded neighbour counts as unsafe;
  - only natural filler is dug (stone, dirt, ores, deepslate, tuff, ... see `NATURAL`); stone bricks, planks, chests, dripstone, torches, anything
    Walter built is left alone and counted as `protected:<name>`. Add names via `extraDiggable` in `config.json`;
  - **hall guard**: `hallMinY` 151 and a hard `HARD_MAX_Y = 150` that config cannot raise; the dig range is also clamped to `floorY+2 .. floorY+5`
    (6 tall) and the box. Lava depots (+3 blocks) are protected boxes too;
  - sand/gravel columns skipped whole; nothing is ever placed.
- **Items**: more than 30 item entities within 24 blocks (`limits.maxGroundItems/itemRadius`) after trying to pick them up -> task parks, one chat line,
  nothing else is done. Checked at start, after every column and every section.
- **Inventory**: at 6 or fewer free slots the job calls the integrator's shared `api.depositSmeltables({ ctx })` (INTERFACE.md section 11: all smeltables, cobblestone above the
  48 reserve, line of sight, input chests from `brain/furnace-config.json`, never throws anything away). `full: true` from it (every input chest full or out of reach) pauses the
  job with one chat line. If it still cannot keep 3 free slots (e.g. full of dirt) it pauses too. Without that helper (older brain, tests) a built-in fallback puts only
  cobblestone into the configured input chests (nearest first, full/unreachable/no-line chests skipped for 10 min). Never tosses anything on the ground.
- **Yield**: `ctx.checkpoint()` between steps, abortable walks, `abort()` hook stops pathing and `bot.stopDigging()`. PRIORITY.EXCAVATE (lowest), not
  idle-only (Walter started it). Preempted -> resumes with `ctx.resumed`. Danger (hostile within 6, health < 8): retries every 20 s, parks after 6 tries.
- **Line of sight** (Walter's survival-legit rule, `los.js`): a ray test from the eye (`bot.world.raycast`, thickened ray so a diagonal corner or a one-block
  wall does not count) before every dig and before opening an input chest; if `api.canSee` exists it is used instead. Digging is layer by layer from below, so
  each block is exposed to the standing spot; a block that is not in view is reached by stepping into its column, else skipped as `no-line-of-sight` and
  never dug. A chest without a clear line is approached with the pathfinder's `GoalLookAtBlock` (when available) or from closer, else skipped for 10 min.
  If `bot.world.raycast` is missing the module cannot verify and does not act.
- **Lava rule**: every walk goes through `safehand.ensureSafeForMove()`; the hand is stowed at start and end.
- Out of reach: steps into that column and retries once before skipping. Unreachable section: retried once at the end, never marked done, listed in chat.
- Pickaxes: picks the fastest tool; below 60 durability crafts up to 8 stone pickaxes at a crafting table (needs cobble + planks/sticks), otherwise parks.
- Room not loaded: walks to `config.entry` (-1061,136,2323) first.

## Layers, the pillar, and when it is "finished" (2026-10-26)

- **Bands** (`config.json` `bands`, each with its own done list in the state): `base` y138-141 (the old `done` list, so the 55-62 finished sections are never redone), `ceiling` y142
  (dug from the floor, reach 5.1), `high` y143-145 (needs the pillar). Per section: base, ceiling, high. A band with nothing left to dig is simply marked done (no walking, no pillar).
- **Pillar** (`pillar.js`, Walter allowed temporary blocks): in an open column of the section (already dug up to head room) it builds up to 4 cobblestone blocks under its own feet by
  jump-and-place (feet at y140), digs y143-145 from the top (no walking off the pillar; a block out of reach/sight is skipped), then takes the pillar down again. Rules: needs >= 6
  cobblestone (else the band is skipped and reported, sweeps retry it later), never above 4 blocks, every placement needs a clear line to the block it goes on, no pillar when the column
  is not open or a hostile / low health shows up (it comes down first, in `finally`, also when stopped or preempted). Recorded cells are saved while it stands: a pillar left by a crash or
  restart is removed (only those recorded blocks, from the side) before anything else. The right tool (best pickaxe) is equipped before every pillar block is dug.
- **"Finished" is only true when the world says so.** The old job set it when its work queue was empty, and the queue was built from a partial view of the room (right after a restart only the
  chunks around the bot are loaded: 12 sections instead of 90). Now: a scan counts unloaded columns; a partial scan is waited out (15 s), then the bot walks into the room, then the job
  retries later (3 tries) and finally parks; it never carries on with half a room. At the end, verification sweeps dig whatever diggable block is still there (a missed ceiling block, a dig
  error), and `finished` needs 0 diggable blocks left in a complete scan. Otherwise it says "not finished: N block(s) are still uncut, e.g. x,y,z" and `resume excavation` sweeps again.
- **`excavation status` looks at the world**, not the flag: it corrects a stale `finished` in either direction and says when it cannot see the whole room.
- Overrides without code changes: `brain/state/excavation-config.json` (merged over `config.json`; `limits` and `pillar` merge key by key), e.g. `{ "digTo": 141 }` for the old 6-high room.

## Work-site chest and pickaxes (2026-10-26)

- **Work-site chest** (Walter's time-economy rule, `worksite.js`, identical copy in brain/routines): when the bag fills, the job no longer walks to the furnaces each time. A chest is made
  (`craft chest` through the crafting module) and placed with a clear line against the west wall of the room next to the entry (`config.json` `worksite.cell`, searched along that edge),
  the stashable things go in there (natural filler, ores and drops: everything except tools, food, torches, the 48-cobblestone reserve and 16 coal), and **one haul** to the furnaces
  (`api.depositSmeltables`, forced) happens when the job's work is over or when the chest is nearly full. The chest is then picked up (right tool first). What the furnaces cannot take (dirt, ...)
  stays in the chest, the chest stays, Walter is told once, and the next job reuses it. The ledger (`state.worksite`) survives a restart, so an interrupted haul is finished by the next run.
  Only the chest from the ledger is ever opened or broken. The chest column stays part of the room (its blocks are dug) but is never a standing spot or pillar column. If there is no chest
  in the bag and the crafting module cannot make one, nothing changes: straight to the furnaces as before. No chest is made when there is nothing to stash. (A `worksite excavation`
  waypoint is not written: waypoints.json is the driver's file; the position is in `status().modules.excavation.worksite`.)
- **Pickaxes**: when they are nearly worn out, `api.crafting.craft(ctx, 'stone_pickaxe', n, { chests: false, tableRadius: 96 })` is used (it re-checks the bag at every step; the old
  `recipesFor(..., table)` call returned nothing when the bag lacked 2 sticks + 3 cobblestone at that moment). `getCrafting` is looked up lazily (crafting loads after this module). If it is
  missing or throws, the old table path runs; if no materials, it pauses with the reason. The crafting module is also what makes the chest.

## Dig speed (Walter: digging straight down looked slow)

Every dig of the module goes through `tools.dig`: (1) it waits until the feet are on the ground (up to 1 s) because breaking a block while airborne is about 5x slower (after the block under the
feet is gone the bot falls for a moment; the old loop started the next dig before it had landed), (2) the best pickaxe is equipped first (also for the pillar teardown), (3) the dig is timed against
what the block should take with that tool (`block.digTime(tool, ..., notOnGround)`). Slow digs (over twice the expected time) and every `pillar-down` dig are logged (`dig cobblestone at x,y,z
(pillar-down): N ms, expected ~M ms, onGround=..., held=...`) and `status().modules.excavation.digStats` has count / total / slow / airborne / slowest, so the cause can be read off after a run.
Aim: the server's break time does not depend on where the ray hits, only on tool, ground, water and effects, so the default is unchanged (`bot.dig(block, true)`); `pillar.aimOffset` in the config
(e.g. 0.2) makes the dig-down aim at a point beside the block centre as an experiment to compare against the logged times.

## Chat (all go through `api.commands`)

| phrase | does |
|---|---|
| `excavate`, `ok excavate`, `resume excavation`, `continue/start/begin the excavation`, `keep digging` (risk high) | go: resumes a parked task or queues it, continues from saved progress (never from scratch) |
| `pause excavation`, `stop digging`, `stop the excavation` | cancels/parks, `active` off |
| `excavation status`, `how is the excavation going`, `how far along is the digging` | one line from saved state |
| `excavation plan`, `excavation preview` | read-only: sections left, block tally, hazards counted |
| general `stop` / `resume` | `scheduler.userStop()` parks it; a bare `resume` also wakes it (every self-pause re-checks its condition on wake) |

Unaffected: `don't dig`, `no more digging` (integrator's negation handler cancels the task).

## Files

Reads: `brain/furnace-config.json`, `exc-state.json` (once, read-only). Writes: only `brain/state/excavation-state.json` (+ `.tmp`). The legacy
`excavate.js` must not run at the same time (it would dig with the same state); with the brain loaded it is not started.

## Tests (offline)

`node --test test/excavation.test.js` (82 tests, ~75 s) with `test/excavation.helpers.js` (mock bot extended with dig, drops, crafting). Covers the
real `room-map.txt` (735 columns / 90 sections / legacy ids match, full carve of the map ends with nothing outside y138-141), legacy import, lava/water/
waterlogged/appearing-lava, hall and tampered config, non-natural blocks, gravity, reach, item pile (exact 30, far items, pickup, pile mid-run), cobble dump
(nearest first, full chest, unreachable, nothing possible, junk-only), lava bucket in hand, hostile/low health, pickaxe crafting, preempt and stop/resume
with no cell dug twice, never-auto-start, phrases, and loading through the real `brain/index.js` chat router.

## First live run: what the mock cannot prove

Not run against the real server (Walter said no restarts / no digging). Watch on the first go: item entity name (`item`), `bot.canDigBlock`/`bot.stopDigging`
on this mineflayer, double-chest `inventoryStart` for the capacity check, and whether the S1 input chest (-1043,132,2273) is reachable (the old scan timed out
on it; the dump just skips it for 10 min if so). Say `excavation plan` first: it only reads.
