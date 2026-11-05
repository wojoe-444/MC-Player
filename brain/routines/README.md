# brain/routines: farm, replant and sleep

Takes over the driver's idle farm routine, `farm.js` harvest/store loop and `bedRoutine` from `join.js`, as scheduler routines with tests.
`register(api)` returns `{ name:'routines', provides:['routines','farm','sleep'], start, stop, status, onChat, farm, sleep, state }`.
`farm.js` itself stays loaded by `join.js` only for its 4-second auto-eat timer; nothing here calls it.

## Integrator: what to change

1. Add `'routines'` to `MODULES` in `brain/index.js` (not auto-discovered).
2. Nothing else is required: the module registers scheduler routines named `farm` and `sleep`, which **replace** the built-in ones of the same name
   (`scheduler.routine()` overwrites by name; status shows each once). Its `onChat` runs before the built-in commands, so "harvest", "store crops",
   "sleep" reach this module even though the built-ins are still registered. Please delete the built-in `harvest`, `store`, `sleep-now` commands and the
   built-in `farm`/`sleep` routine blocks when convenient: the built-in `harvest` regex would still start the old farm.js on "stop harvest".
3. `join.js`: its `bot.on('wake')` handler ("Awake.", writes `sleep-state.json`) can stay; our own copy of the clock lives in `brain/state/routines-state.json`.
   The old `routines.farm` flag / `routine-state.json` is only read once (imported); "farm routine on/off" now writes our file.

## Farm

- **Where**: every configured site (`config.json`: home farm -1067,160,2360) plus every waypoint in `waypoints.json` whose name contains "farm"
  (add farms as waypoints). The search is around each **site** (radius 48), nearest site first, walking there first; no known site = legacy
  behaviour (40 blocks around the bot).
- **What**: only fully grown crops over farmland (wheat/carrots/potatoes age 7, beetroots 3). Nothing else is dug. Replanting is the only placing.
- **Replant reliability**: after digging, the spot is recorded as pending (persisted) until the crop is verified in the world (`placeBlock` timeouts that
  actually planted are no longer failures); two tries; a stop, preempt or restart between dig and replant cannot lose a spot. Pending spots are
  retried first on the next run (even with nothing ripe), the seed is picked up from the ground if it was left there, and missing seeds are taken back
  out of the house chest (up to 16 each).
- **Storage**: the house chest at -1064,160,2326 (fallback: nearest chest/barrel within 30 blocks of the `house` waypoint). Keeps one stack (64) of
  food overall (cooked meat counts) and 16 of each seed item (also carrots and potatoes, which double as seeds); only crop items are ever stored.
  Mid-run unloading when the inventory is nearly full. If both inventory and chest are full it stops, tells Walter once, and never drops anything.
- **Routine**: off until "farm routine on" (the imported flag is currently ON). Idle-only (scheduler `idleAfterMs`), daytime only, every 45 min (Walter, 2026-10-26; was 20), every 15
  min only when food is under 8. Quiet: an idle run with nothing ripe says nothing; a manual "harvest" answers. Danger (hostile within 8, health < 8): retries
  every 30 s, gives up after 5. Yields to anything more important and resumes. Lava is never held while walking.

## Sugar cane (2026-10-26)

At every site (farm waypoints plus any waypoint named `cane` or `sugar`, `sitePattern` in `config.json`) the stalks of `caneMinHeight` (3) or more blocks are cut at the **second block**: everything
above it comes down, the bottom block stays and keeps growing. Each cut needs a clear line; the drops are picked up; the cane is stored like the other crops (house chest). Nothing else is broken
(not the sand/dirt under it, not short stalks). "Harvest done. ... Cut N sugar cane (the bottom block of each stalk stays)."

## Bamboo (2026-10-26)

A small patch (8 stalks, `farm.bamboo.stalks`; Walter: "put it where you like") next to the home farm. If no patch exists and there is bamboo in the bag (or in the house chest: up to 10 are taken out), 8 cells are chosen near the
field: dirt/grass/podzol/moss/coarse dirt/rooted dirt/mud/sand floor, 3 free blocks above, never on or next to farmland or crops, packed around the nearest good spot; the cells are saved in the state
(`state.farm.bamboo`, with the site) and bamboo is planted on them (clear line to the floor block, verified). Every run: missing stalks are replanted from the bag; stalks of 4 or more are cut at the
second block (everything above comes down, the base stays), with the fastest sword/axe in hand (the right tool, hand if there is none); only the patch is touched, never wild bamboo. The bamboo is stored with the other
crops (house chest or work-site chest) except 4 kept for planting; it is the stick source (2 bamboo make 1 stick) and scaffolding material. With nothing to plant with it asks once per day ("... no bamboo to plant. Put a few
in the house chest, or tell me where some grows"); with no free soil it says so once. `sugar cane` cutting now also takes the right tool first.

**Walter's own patch (03:49 UTC):** he planted bamboo himself at -1066,160,2321 (`farm.bamboo.anchor` in `config.json`, from player-pos.json). That spot is registered as the patch: every run the bot walks there if it is far, takes in every bamboo
stalk or sapling within 7 blocks (`discoverRadius`; the cells are the bottom blocks, found again each run so shoots he adds later join in), cuts stalks of 4 or more at the second block (the bottom stalk stays) with an **axe**
(`farm.bamboo.prefer`; sword/other tool only when there is no axe), and never picks cells or asks for bamboo; a gap in his patch is replanted silently when there is bamboo in the bag (or the house chest). The old "pick a free
spot yourself" logic only runs when no anchor is registered (`anchor: null`). Live (no restart): chat `bamboo patch at <x> <y> <z>` (e.g. through cmd.txt) re-registers the patch at once; it is cleared and re-found on the next run.

## Work-site chest (time-economy rule)

When the bag fills during a run, a chest is made (crafting module) and placed against a wall next to the field being worked (`worksite.js`, same helper as brain/excavation); the crops go in there
and ONE haul to the house chest happens at the end of the run (the chest is then picked up). A restart finds the chest through the ledger (`state.farm.worksite`) and finishes the haul. Without a
chest and without a way to make one, the old behaviour: straight to the house chest. Only our own chest is ever opened or broken.

## Sleep

- Night = timeOfDay 12542..23460 in the overworld; due when `bot.time.age - lastWakeAge >= 48000` (every 3rd night); "sleep" in chat forces it.
- Nearest bed head within 160 blocks; unreachable bed -> next one (up to 3); "monsters nearby" stops the attempt. No bed: says so once per day.
- In bed: after 20 s without the night skipping it pings Walter once per night; after 90 s it gets up ("going back to what I was doing": the scheduler
  resumes whatever it paused), waits 10 min, and tries once more; at most 2 attempts per night. Failures wait a minute. Stop/preempt while in bed gets out
  of bed. The `wake` event (not our own "Awake.") resets the clock, same as vanilla.

## Line of sight (Walter's survival-legit rule)

`los.js` (same helper as brain/excavation): a thickened ray test from the eye with `bot.world.raycast` before breaking a crop, placing a seed (on the farmland),
opening the house chest and using a bed. If it is not in plain view the bot repositions (`GoalLookAtBlock` when available, else closer) and otherwise gives up on
that target: a hidden crop is left (reported as "N crop(s) had no clear line"), a hidden replant stays pending, a hidden chest keeps the crops in the bag, a hidden
bed makes it try the next one. `api.canSee` is used when the integrator provides it. Without `bot.world.raycast` nothing is touched.

## Chat

`farm routine on` (high risk), `farm routine off`, `farm status | how is the farm`, `harvest crops` (high), `store crops`, `sleep | go to bed`,
`sleep status | when do we sleep next`. Negations ("don't harvest", "no more sleeping") are left to the integrator's negation handler.

## Files

Reads `routine-state.json`, `sleep-state.json` (once, import), `waypoints.json`. Writes only `brain/state/routines-state.json`.

## Tests

`node --test test/routines.test.js` (65 tests, ~18 s, helpers in `test/routines.helpers.js`): ripe/keep/store rules, harvest + replant + only-ripe, house chest
storage and keeps, timeouts-that-worked, failed replant retried later, no seed then fetched, sites and walking to them, unreachable site, quiet idle run, full
inventory unload / both full / no drops, hostile, lava in hand, preempt and stop, due() rules, sleep (bed, ping at 20 s, give-up at 90 s, attempt limit,
48000 rule, forced sleep, no bed once per day, next bed, monsters, stop in bed), driver-state import, loading through the real `brain/index.js` (routines
replaced, chat routed to this module not to the legacy ones, routine harvesting/sleeping by itself).

## Not proven live / open

`bot.findBlocks({ point })`, `bot.sleep` error texts and `bot.time.age` are mineflayer behaviour the mock only imitates. Wood-farm / sapling upkeep (Walter's idea)
is not part of this module. Bread crafting is not done (wheat is stored).
