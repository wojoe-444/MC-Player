# brain/build: Walter's lookout tower

One small stone-brick + spruce tower (5x5 ring, 9 courses, an octagonal deck with a parapet and four torches, a ladder, a door), built
survival-legit from a temporary cobblestone pillar in the middle. Module name `build`, task name/key `build`, priority `PRIORITY.OUTING` (45),
`onUserStop: 'park'`. It never starts by itself: only Walter's command creates the task (see "Restart" for the one exception).

## Integration (the only change outside this folder)

`brain/index.js`: add `'build'` to `MODULES`:

```js
const MODULES = ['safety', 'chat', 'pilot', 'router', 'excavation', 'nav', 'treefarm', 'routines', 'crafting', 'lighting', 'mining', 'villagers', 'build', 'dashboard']
```

It uses `api.bot, scheduler, PRIORITY, say, goals, tryGoto, stopNav, safehand, canSee, ensureLineOfSight, commands, statePath, log, now`. Nothing else.

## Commands (match against the lowercased, filler-stripped text; building needs a plain request at the start of the line)

| phrase | command | risk |
|---|---|---|
| `build tower`, `build my tower`, `build the tower`, `build a tower`, `start the tower`, `start building the tower`, `lets build my tower` | `build-tower`: survey (or the saved site), then the task | high |
| `build site <x> <z>` | `build-site`: another centre (only before the first block is placed) | high |
| `build survey`, `tower survey`, `survey the tower site` | `build-survey`: read only, says the best site or why there is none | low |
| `build status`, `how is the tower going`, `tower status` | `build-status`: one line (phase, courses, blocks, site) | low |
| `resume building`, `continue the tower`, `keep building` | `build-resume`: unpark / queue | high |
| `pause building`, `stop building`, `don't build the tower` | `build-pause`: parks (comes down first) | low |

Questions and remarks ("how do I build a tower?", "walter will build a tower", "nice tower") match nothing.

## Files

| file | what |
|---|---|
| `index.js` | `register(api)`, commands, scheduler task, `needs()`, `status()`, restart handling |
| `blueprint.js` | pure: `tower(origin, {ground})` -> ordered steps `{x,y,z,block,item,face,refKind,ref,course,phase,stage,feet,stand,optional}`; whitelist; volume box |
| `survey.js` | pure apart from `bot.blockAt`: `findSite(bot, opts)` -> `{ox,oy,oz,score,flat,ground,dist,low}` or `null`; `survey()` adds the reason |
| `pillar.js` | the cobblestone pillar: `raiseOne`, `dismantle` (jump-and-place idea of excavation/pillar.js, cells saved before they are placed) |
| `engine.js` | the job: checkpoints, line of sight, danger, materials, stages, stand-down |
| `state.js` | `brain/state/build-state.json` (atomic write) |
| `config.json` | site centre `-984,2292`, radius 14, maxDy 1, protected base box, limits, timing |

Override file (optional): `brain/state/build-config.json` (`site`, `limits`, `timing` merge key by key, `protect` is appended).

## State: `brain/state/build-state.json`

`active` (Walter's go in effect), `finished`, `site` (`ox,oy,oz` + `low`: the 5x5 cells below base level), `centre`, `phase`, `pillar` (`{x,z,cells:["x,y,z"...]}`,
written **before** each pillar block is placed), `placed` (blueprint cells known to be in place), `blocks` (pieces this module put down), `skipped`, `pauseReason`.
What stands is always decided from the world (`bot.blockAt`), never from the list: nothing that exists is placed again.

## What it does, in order

1. **Survey** (`findSite`): origin O = north-west ring corner; read 11x11 columns around it. Needs: every column loaded (unknown = unsuitable), dry, natural ground
   (no player blocks), the 7x7 ground within `maxDy` (1), the **centre column at the highest level** (the pillar stands on natural ground), nothing above the ground in
   x -1..5, y oy..oy+12, z -1..5 (leaves, logs, vines, player blocks), outside the protected boxes. Score: flat, then highest, then closest to the centre.
   If the centre is not loaded the task walks there first and looks again (retries, then parks).
2. **Materials** (`needs()`): for what is still to be built: stone_bricks 118, spruce_log 36, spruce_planks 52, spruce_door 1, ladder 10, torch 4, cobblestone (foundation + highest
   pillar height + 2 + 6 spare = 18 on flat ground), a pickaxe. Missing: the task parks with `Tower: need 12 x spruce_planks, 6 x ladder.` (one `say`).
   Bed / chest / crafting table / one wall torch are optional: only what is in the bag, skipped silently otherwise.
3. **Foundation**: cobblestone on 5x5 cells whose ground is below base level, farthest first, each from the neighbouring cell (a one-block pit cannot be seen into from two blocks away).
4. **Pillar + courses**: stand in the centre, raise the pillar one block at a time (feet at oy+c for course c), place the ring around, the floor at course 4, the deck at 9, parapet and
   torches from feet oy+10 (10 pillar blocks, cap 11).
5. **Dismantle**: always, also on any pause/abort/error: dig the block under the feet from the top (pickaxe equipped first), items stay in the shaft under the bot.
6. **Ladder** bottom-up while climbing, deck centre fill, floor centre fill, furnishing, then the **door from outside** (the last piece; the bot ends at (2,0,5)).

## Rules it keeps

* Before every placement: `api.canSee(referenceBlock)` and eye-to-face distance <= 4.5; otherwise the piece is deferred, then skipped (never placed). Pillar steps never move the bot;
  ground steps may walk to a viewpoint (`ensureLineOfSight`, never digs or places).
* Only whitelisted pieces (stone_bricks, spruce_log, spruce_planks, spruce_door, ladder, torch, cobblestone, any bed, chest, crafting_table), only cells inside the blueprint volume
  (x -1..5, y oy-2..oy+12, z -1..5). Somebody else's block in a cell is never touched (reported as `blocked`).
* Only the recorded pillar cobblestone is ever dug (cell in `state.pillar.cells`, in the pillar column, holding cobblestone).
* `safehand.ensureSafeForMove()` before every walk; never walks while on the pillar; talks only through `say` (start, pause, finish).
* Pauses (`retry`, 20 s, 6 times, then `park`) when health < 8 or a hostile within 6 blocks is in view; it comes down first.

## Restart / crash

The pillar cells are on disk. A new process: `start()` finds recorded pillar cells and submits a task that takes them down first (bot on top: dig down; bot on the floor: from the side,
what is in view and reach, highest first). With `state.active` still true (Walter's go was in effect and not stopped) it then carries on (`autoResumeOnStart`); otherwise it only comes down
and waits for "resume building". Blocks above reach that cannot be seen are reported (`park`), never guessed at.

## Deviations from the design, and limits

* The door goes in **last** (after ladder, fills and furnishing) instead of before the ladder, so the pathfinder never has to open a door during the job; until then the 2-high gap is open.
* Interior cells below base level also get the foundation; the centre column may not be lower than base level (sites on a plain slope are rejected, hilltops are fine).
* "Clear ray" is `api.canSee(refBlock)` as specified. The outer deck ring is placed against the outward face of the inner ring from the middle: the block is seen (from above), the face
  clicked points away from the bot. A strict "face visible" rule would make the octagon impossible from a pillar in the middle.
* Coming down from 10 blocks takes about 10 x (dig + 120 ms); the scheduler detaches a task that ignores an abort for 15 s, so keep a stone pickaxe or better in the bag.
* `findSite` returns the site or `null`; the reason lives in `survey()` (`{site, reason, counts, scanned}`).

## Tests

`node --test test/build.*.test.js` (blueprint, survey, engine, safety/scheduler, module). `test/build.helpers.js` is the offline world (place, dig, jump, ladders, ray casting,
breadth-first walker) on top of `test/mock-bot.js`.
