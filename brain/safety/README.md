# brain/safety: mob safety and combat

Entry point: `require('./brain/safety')` is `register(api)` per `brain/INTERFACE.md` and returns `{ name:'safety', start, stop, status, rt }`.
Uses `api.bot, say, goals, scheduler, PRIORITY, safehand, stopNav, ownerName, statePath, now, log, commands` and, when present,
`api.canSee(entity)` (shared line-of-sight helper; ANDed with our own raycast). Nothing here touches `join.js`.

## What it does
- Scans every 300 ms (`start()` begins, `stop()` clears the timer and listeners). Hostiles = `PROFILES` in `profiles.js` or any entity with
  `type === 'hostile'` (unknown ones count as melee).
- **Walking-path filter** (`reach.js`, Walter's rule): a hostile inside 24 blocks only counts when the pathfinder finds a walking path to it
  of <= 20 nodes. Uses `bot.pathfinder.getPathFromTo` (pure) and never `getPathTo`, which overwrites the pathfinder's astarContext and would
  corrupt a route another task is walking. Cached 2 s per mob (earlier if it moved > 4 blocks), max 3 searches / 150 ms per scan, 60 ms each;
  a mob not yet searched counts only inside 6 blocks. Exceptions: within 3.5 blocks, flyers (phantom, vex, ghast, blaze, bee), spiders within 10,
  skeleton/pillager/witch (line of sight instead), neutral mobs, and the mob that just hurt us. Suppressions are written to
  `brain/state/safety.log` (once per mob). Without `getPathFromTo` it falls back to straight-line distance and logs that once.
- **Warns Walter** (via `say`): "zombie approaching from north, 14 blocks." (approach = closing speed >= 0.6 blocks/s), mobs near the bot and mobs
  near Walter. Per mob type every 20 s, any warning every 4 s (creeper warnings skip the 4 s gap).
- **Modes.** Default is **fight** (Walter asked for automatic fighting). "do not fight / just retreat" switches to **warn**: back away and tell Walter.
  The mode is saved in `brain/state/safety-state.json`.
- **Melee (fight mode):** best sword (any sword beats an axe), fight a mob that comes within 5 blocks or walks at us inside 8 (never chase beyond
  7, skeletons 12), 16-block leash from where the fight began, give up on unreachable targets after 6 s, hit at the weapon's cooldown. More than
  3 mobs, no weapon, or health < 8 means retreat. Self-defence overrides warn mode when cornered. Armor already in the inventory is equipped
  before a fight (`gear.js`); it never takes armor, bows or arrows from chests.
- **Line of sight (Walter's survival-legit rule):** before every melee hit, creeper strike and bow shot the bot needs a clear raycast
  (exact voxel traversal, no squeezing through diagonal corners, fences/glass block) from its eye to the mob's hitbox (centre, head, feet,
  both sides). If blocked while in reach it walks to a standable spot near the mob with a clear line (`findVisibleSpot`, ground only, nothing
  dug or placed) and otherwise holds; after 4 s it ignores that mob for 10 s. `join.js` also guards `bot.attack`; this check runs first so
  `los.log` stays quiet.
- **Creepers** (`creeper.js`): flee when one is inside 7 blocks; run urgently when the fuse starts (entity metadata `swell_dir` / `is_ignited` and the
  `entity.creeper.primed` sound; a swelling estimate from proximity as backup). Kill from range with a **bow** when it has a bow, arrows and a
  clear line and the creeper is 8-24 blocks out (kites back first if it gets inside 8; draw 1.05 s, ballistic aim with target lead, a blocked line
  cancels the draw by switching back to the sword, so no arrow is wasted into a wall). **Sword hit-and-retreat** (`creeperStrike`) closes in, lands one
  full-strength hit, then withdraws to 5.5+ blocks before going in again (max 8 cycles, health >= 14, creeper alone, fight mode).
  **Sword strike is OFF by default** (`creeperStrike:false`) until it has been watched live; turn it on by chat ("hit creepers and back off") or
  `rt.setCreeperStrike(true)`; it is saved in the state file.
- **Health**: below 8 it never fights (exception: cornered by one adjacent melee mob, "last stand"), retreats toward Walter if he is loaded, tells Walter
  once, holds the other tasks until health >= 12, eats when hurt and no mob is within 4-6 blocks, and gives up the hold after 2 minutes without food.
  Idle eating is off (`farm.js` eats at food <= 14).

## Walter's rules
- Lava: `safehand.ensureSafeForMove()` before every `setGoal`; fallback swap without safehand; if the hand cannot be made safe the bot stands still.
- Never digs, places or activates blocks (tests make `dig`/`placeBlock` throw). Only goals, equip, eat, attack, shoot, look.
- Goals are cleared in `finally` when the safety task ends. Chat only through `say`.

## Chat commands (`api.commands.add`)
| name | canonical | tested phrases |
|---|---|---|
| `fight-mode` (high) | you can fight | you can fight, fight back, defend yourself, defend me, you can attack zombies, kill the mobs, attack mobs |
| `no-fight` | do not fight | do not fight, don't fight, dont fight, no fighting, stop fighting, just retreat, run away, never attack mobs, do not fight back |
| `creeper-strike-on` (high) | hit creepers and back off | hit creepers and back off, you can melee creepers, fight creepers with your sword |
| `creeper-strike-off` | do not melee creepers | do not melee creepers, don't hit creepers, only run from creepers, never attack creepers |
| `mob-status` | mob status | mob status, any mobs near, safety status |

## Files
`profiles.js` (mob/food tables) · `assess.js` (pure decisions, approach Tracker) · `creeper.js` (FuseTracker, `planCreeper`) · `reach.js` (path filter,
`lineOfSight`, `entityVisible`, `findVisibleSpot`) · `bow.js` (ballistics) · `gear.js` (weapon/armor choice) · `health.js` · `runtime.js` (live) · `index.js`.
Tests: `test/safety.{assess,runtime,creeper,reach,los,bow}.test.js` + `safety.combat.helpers.js`. Run `node --test test/*.test.js`.

## Libraries evaluated (1.21.6)
`mineflayer-pvp` 1.3.2 (last release 2022-07, pre-1.21 attack cooldown, no creeper logic), `mineflayer-tool` 1.2.0 (2022, about digging, i.e. block breaking:
not wanted), `mineflayer-armor-manager` 2.0.1 (2023, simple; re-implemented in `gear.js` in 40 lines to avoid a dependency), `minecrafthawkeye` 1.3.9 (2024,
bow aiming; re-implemented in `bow.js`), `mineflayer-auto-eat` (eating already exists). Mindcraft's `defendSelf`/`avoidEnemies` (read on GitHub) use
mineflayer-pvp plus an inverted `GoalFollow` to flee, and have no creeper-specific code (cowardice mode flees at 16 blocks, self-defence fights at 8);
we kept the inverted `GoalFollow` retreat and added the creeper rules. No new npm dependencies were added.

## Limits / what is not proven
- **Not live-tested.** The creeper acceptance test (no explosion damage) passes in `test/safety.creeper.test.js`, a vanilla-like simulation (creeper walks at
  4.3 b/s, stops while swelling, 30-tick fuse, power-3 falloff, bot sprints at 5.6 b/s). It must still be run live with Walter watching. Speeds and
  knockback in the simulation are assumptions.
- A creeper that is first seen inside ~4 blocks (round a corner) cannot always be escaped: the simulation shows it works at 5 blocks, not at point blank.
- Breaking line of sight with blocks/doors (placing) is not done. Sprint-hit knockback depends on the pathfinder sprinting at the moment of the hit.
- Arrows shot are not collected afterwards (no item piles rule: they are left where they land).
- No shield use, no crossbow.
- Damage with no mob nearby (fire, fall, lava) only feeds the low-health hold.

## Night / low-health rules (post-mortem of the 03:51 UTC death)
What happened (join.log, idle.log, safety.log): the tower build started at dusk, 80 blocks from shelter; "skeleton 11 blocks east" -> "Fighting skeleton"
(fight mode charged an archer in the open at night) -> 4/20; safety then only *held in place* ("Pausing my tasks") next to creepers; Walter's restart
reset the in-memory recovery latch, so at 11.6 health the tower resumed at night, a second skeleton fight followed, death. Eating itself worked
(`safety eating: low health` x3 in idle.log).

Fixes in this module:
- **Disengage at 8 health or less** (was "below 8"), and the recovery latch now survives a restart: if the first scan finds 8 < health < 12 the bot is still
  recovering (holds tasks, no re-announcement).
- **Retreat to shelter, not "hold in place"**: `shelter.js` lists beds within 48 blocks plus waypoints named house/home/shelter/furnace station/crafting
  table/mine storage/base (not farms, portals, villages) from `waypoints.json`, nearest within 90 blocks. Low health (with or without mobs near) and
  "night + open sky + mob trouble" retreat to it (`retreat:'shelter'`, `GoalNear`), then hold and eat there. No shelter known: falls back to Walter / away.
- **Archers**: never charged in the open at night; a single archer is fought only at >= 14 health (>= 16 and within 6 blocks at night in the open), several archers
  or a hurt bot retreat. Cornered self-defence still works.
- **Night shelter routine** (`night-shelter`, priority 60, on by default): at night, under open sky, with a shelter more than 8 blocks away, walk there. Quiet for 2 minutes
  after any chat from Walter and while "go anyway" is active; 5 minute cooldown. `start()` also adds `farm` to the scheduler's outdoor gate names (build, mining, treefarm
  are already there), so nothing sends the bot back out until daylight.
- Tests: `test/safety.night.test.js`.
Not covered here: the integrator's gate decides when build/mining/treefarm wait (daylight, health >= 18, no hostile within 16); this module does not touch it except to add `farm`.

## Wall-in (emergency shelter) and far-shelter rules (05:06 incident: 41-block fall into a cave, "retreating to mine storage (89 blocks)", died at 7 hp)
- **Far shelters no longer count while hurt with mobs close**: with health <= 8 (or recovering) and a hostile within 16 blocks only a shelter within `shelterCloseMax` (30) is used; every candidate must also have a real walking path
  (`reach.pathTo`, <= 70 nodes; a timed-out search only counts under 25 blocks). Skipped shelters are logged to `safety.log`.
- **Wall-in** (`entomb.js`, `emergencyEntomb`, **default ON since 2026-10-26 15:29, when Walter approved it** (it places and digs blocks); "do not wall yourself in" turns it off, "you can wall yourself in" back on. Only an explicit choice is saved in the state file, so a changed default is never overridden by an old value).
  When on: hurt (<= 8 or recovering, or <= 14 after a fall of 12+ blocks within 90 s), a hostile within 12 (16 after a fall), no reachable shelter, >= 8 filler blocks (cobblestone, deepslate, stone, dirt, ...)
  -> stop, place blocks on the 4 sides at feet and head level plus overhead (a stepping block first when nothing solid is next to the roof cell), never into lava, only against a block it can see (`api.canSee`).
  Inside it eats (mobs outside do not stop it), holds the other tasks, and when healed (>= 12) and quiet for 5 s digs out through ONE pair of its own blocks (facing the shelter) with a pickaxe. It never digs anything it did not place.
  If the seal fails (lava beside it, no filler) it says so and does not retry for a minute. 10 minute cap on the hold.
- Not done: letting the retreat pathfinder itself dig/place (it would change the shared Movements for every module). Entombing covers the same need without touching them.

## Narrow ground / bridges (05:05 incident: safety took over on the y26 mining bridge and the bot fell about 40 blocks)
- `shelter.dropExposure` calls ground narrow when 4+ of the 8 neighbouring cells (or both cells on one axis) have no floor within 4 blocks below and are not walls. Refreshed every 2 s with the sky check.
- On narrow ground the safety task **does not run**: flee/retreat is replaced by standing still ("Narrow ground: staying put instead of running."), melee never chases (it still hits what reaches it), no creeper strike runs.
  With wall-in allowed it walls in on the spot instead (it places a stepping block beside the bridge, then the side, then the roof).
- While the safety task runs, `bot.pathfinder.movements.maxDropDown` is capped at 4 (a 3-block fall in the library's floor-to-floor counting) and restored afterwards, whatever the other modules left there.

## Survival job (2026-10-26 17:00-17:40: three deaths in the mine; Walter: "deaths mean you need to get better at gameplay")
- **Prep before descent (hard reflex)** (`loadout.js`, `index.js` descent guard): `scheduler.addPreStart` hook on the `mining` task. Right before it runs it equips carried armor, asks the crafting module for what can be crafted
  (`craft 16 torch`, sword, pickaxe) and checks sword / pickaxe / torches / food. A missing must-have makes the task sit out 45 s (`retry`) and say what it lacks; after 4 rounds it goes anyway and says so (no deadlock, no
  questions to Walter). Wanted for a cave trip: sword, pickaxe, 16 torches, 64 filler blocks, 12 food, 2 armor pieces; deaths raise the bar (`safety-tuning.json`). Not auto-fetched: cobblestone, food, armor (never raids chests).
  The pilot can call `api.safety.preflight('cave')` itself (`{ ok, missing, fixed }`); `api.safety.loadout.check(kind)` is read-only. Chat: `check my gear`, `pack up`.
- **Early retreat (hard reflex)**: disengage below 10 health (9.5 and lower), rest until 14; **12 when underground and unprepared** (no armor / no torches / under 12 filler / under 4 food). Eating starts at 16 with mobs about.
  A restart while still hurt (10-14) keeps the hold. `api.safety.standGround(ms)`: hold a position (shaft bottom, ladder): fights what reaches it, never chases or runs from numbers, still retreats at low health.
- **Light as it goes** (`light.js`, uses `brain/lighting/torches.js`): underground, block light <= 4, no torch within 6, 8+ blocks since the last one, not digging, nothing hostile within 12, no lava in hand -> one torch under the feet
  (line of sight to the floor block, held item restored). `api.safety.lightHere({ force })` for the pilot. Torches placed show in `status().torchesPlaced`.
- **Fight back**: creeper hit-and-retreat is ON (back off 5.5+ blocks, then hit; a death while striking turns it off by itself); archers (up to 2, health >= 10, >= 14 at night in the open) are closed on in a zig-zag
  (GoalNearXZ points alternating 40 degrees left/right every 0.6 s) instead of fled from; zombies/spiders fought inside 5 blocks (8 when walking at us).
- **Wall-in fixes** (`entomb.js`): only faces the eye can see are clicked (eye on the outer side of the face plane, clear ray) so the 17:18 "block is still air" refusals are gone; feet-level sides first, then head level; sculk vein / lichen /
  vines / torches in a target cell are dug out first (instant); every placement waits for the block to appear (retry once); only one seal runs at a time; the roof is closed afterwards by jumping and placing on top of a head-level block
  (`closeRoof`, after the bot is already safe from walkers); cells over a void (a bridge) are skipped. Trigger needs 14+ filler blocks.
- **Post-mortems** (`deaths.js`): on every death a `[safety]` block goes to `brain/state/lessons.md` (cause from the death message, position, light, underground, health trail, what it was doing, what it carried, lessons, adjustments) and
  `brain/state/safety-tuning.json` is updated (requirements, `maxArchers`, `archerHealthPlus`, `noCreeperStrike`, `creeperRangePlus`, `minFightHealthPlus`); the tuning is applied at the next start. One chat line after the respawn. The three mine deaths
  of today were written up by hand (same file) and seeded into the tuning (torches 16, filler 64, armor 2, food 12, sword 1).
- Not done: clearing the ~37 mobs at the shaft bottom by itself (that is the mining/pilot job: light the bottom first with `lightHere`, then `standGround`, fight from the ladder); armor/bow acquisition; breaking line of sight; a real jump test (physics are simulated in tests).
