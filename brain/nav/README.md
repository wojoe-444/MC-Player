# brain/nav: navigation

Loaded by `brain/index.js` like the other module folders (`nav` is already in its `MODULES` list). It sits on top of mineflayer-pathfinder,
keeps pathfinding **non-digging and non-placing**, and fixes or adds: doors, gates and trapdoors, ladders and stairs, stuck recovery, hazards,
named waypoints merged with Xaero, long routes over the Xaero map, and Nether trips. It hooks the pathfinder itself, so it also helps every
other module that walks (`join.js` navigate/tryGoto, farm, furnace, excavation), not only `nav.goto()`.

## What it does

| area | behaviour |
|---|---|
| doors, fence gates, trapdoors | Opens only the ones the planned path goes through (not every door it walks past), when the bot is ~2.8 blocks away. Closes them again once the bot is clear of the door cell (never while it stands in the doorway). Leaves doors that were already open alone. Iron doors/trapdoors are walls (need redstone); copper doors count as hand-operable. Clicks do not turn the bot (the pathfinder re-aims every tick). A door that will not toggle after 3 tries is reported and planned around. Open doors are remembered in `brain/state/nav-state.json` and closed when the bot is next to them after a restart. Clicks need a clear line of sight (`api.canSee`, INTERFACE §10); `nav.tidy()` / "close the doors" walks back to a viewpoint with `api.ensureLineOfSight` for a door that was left open. |
| path fix | The library puts the path node of a door/gate "on top of" the block (+1 / +1.5), which the bot can never reach in the doorway. nav pulls those nodes down in place (`DoorTender.fixPath`). Moves through door cells are limited to the door's axis (never diagonally past a leaf). |
| ladders, stairs | Ladders up and down (including long descents), stairs and slabs are tested against the real physics engine. A closed trapdoor directly above a ladder is opened on the way up. Going **down** through a hatch is not planned (the physics engine bobs against the panel), so it is an honest "no path". Only ladder/vine/scaffolding count as climbable: the physics engine does not climb the other vine types. |
| hazards | Never walked through or stood on: lava, fire, soul fire, cactus, sweet berry, magma, (soul) campfire, powder snow, wither rose, pointed dripstone, cobweb, portals, sculk sensors/shriekers, turtle eggs, big dripleaf, tripwire. Extra cost next to lava (7/3), cactus (10/4), fire; pressure plates, farmland, soul sand, honey/slime cost extra. Falls are capped at **3 blocks (no fall damage)**, also into water (`infiniteLiquidDropdownDistance` off); a ladder column is not a fall. Goals inside lava/fire/cactus are refused. If the bot ends up in lava/fire anyway it climbs out the shortest safe way, then the goto ends with `hazard`. |
| stuck | Per game tick: no progress for 2.5 s (or dithering in a small area) while a path is being followed. Escalation: jump, sidestep+jump, back up (+ penalty on the blocked cell), longer back-up (+ bigger penalty), then give up with `stuck`. Every recovery move is checked first (no hazard, no hole or drop deeper than 2 in that direction), so recovery never walks into lava. |
| waypoints | `waypoints.json` + Xaero (`../../xaero.js`, read-only, all 3 dimensions) merged; Walter's own saves win over a Xaero waypoint of the same name, old `source:"xaero"` imports are only a fallback. Duplicate names ("Portal" x8) get their coordinates appended. Typos, partial names, "the". Re-read every 5 s. |
| long routes | `route.planRoute` plans a coarse route (16 block cells) on the Xaero overworld map: lava forbidden, water/steep/unexplored expensive, explored ground cheap, string-pulled. `route.travel` walks it in legs of ~72 blocks (pathfinder partial paths do the rest as chunks load), retries failed legs shorter, then by exploring the loaded world's real frontier (flood fill), then re-plans around the trouble spot. Without a map (Nether, unexplored) it explores frontiers toward the target. |
| Nether | `route.planTravel` picks portal pairs (overworld portal waypoint <-> Nether portal waypoint at ~1/8 of the coordinates) and plans walk / portal / walk. Portal hops use `api.usePortal` or `api.jobs.usePortal` if the integrator provides one; otherwise nav dispatches "go to the nether" / "leave the nether" and continues after the dimension changes. |
| natural movement | Nothing in nav writes a position or velocity (a test scans the source). Recovery moves are key presses for a few ticks. `status().motion` reports the largest per-tick step and counts teleport-like jumps (>3 blocks, not caused by a server move). |

## Chat (all go through `api.commands`)

- `go to <waypoint>` / `walk to`, `head to`, `take me to`, `travel to`, `navigate to`: near ones are risk `low` (`nav-goto`), trips over 400 blocks or into another dimension are `nav-travel` (risk `high`).
- `where is <waypoint>` / `how far is <waypoint>`: "Seaside Winter Village: 3720 blocks north (-1085, 63, -3674)." Only answers for an exact/strong waypoint match, otherwise the legacy handlers get it.
- `nearest waypoints`, `how many waypoints`, `nav status`, `close the doors`.
- Does not take: coordinates ("go to 100 64 200"), "come here", "follow me", "go to the nether", "go to bed", unknown names.
- Phrases tested: "hey can you please go to the farm", "walk to MT PAROS", "go to the portal", "go to valley" (-> "Which one: ...?"), "where is the seaside winter village", "how far is furnace station 1", "go to the zorblax" (not handled), "go to the nether" (not handled).

## Provided to the integrator (INTERFACE §9)

`handle.provides = ['nav']` and `handle.navigate(goal, label, dynamic)`: a CHAT-priority scheduler task with key `nav`, replaces an earlier nav task, stops the pathfinder when aborted, sets the same goal again on resume, says "Here." on arrival (like `join.js`) and one sentence on failure. Also on the handle (and `api.nav`): `goto(goal, {label, ms, dynamic, isAborted})` and `tryGoto(goal, label, ms)` (same result shape as `join.js` tryGoto: `{label, ok, secs, err}`), `nav`, `book` (waypoints), `plan(waypoint)`, `goToWaypoint(name)`.

## Getting there no matter what (reach.js)

Walter: "there is no such thing as 'I can't get there'. You can tear down a wall and rebuild it after you get to the other side." `nav.goto()` (and so `api.nav.goto`, `api.tryGoto` in join.js, the autopilot's `S.goto`, `navigate()`, `gotoNear` / `approachBlock`) no longer returns "no path". When the plain attempt fails (`no path`, `path search timed out`, `stuck`, `timeout`, `hazard`, `arrival check failed`) it escalates in `reach.js` until the bot is there, is stopped, or `maxMs` (8 min) / `maxStall` (5 rounds without getting closer) run out. Nothing is said in chat about failing paths; the story goes to the log (`reach: ...`) and `nav.status().reach`.

| level | what it does |
|---|---|
| 0 | the old attempt (`Navigator.gotoOnce`): doors, hazards, stuck recovery, ladders |
| 1 | the same pathfinder with `canDig`, `allow1by1towers`, scaffolding blocks and parkour on (`Navigator.enterDigMode()`, same hazard / door / fall rules, dig and place cost 3 so it prefers walking). Walls, rock, gaps, cliffs, locked or iron doors. Thinks 5 s, growing to 15 s per round |
| 2 | by hand (`Reach.manual`): picks the cheapest of the 12 one-block moves (4 directions x up/level/down), digs what is in the way (block must be in reach and in view; if something else is in the ray that gets dug first), places a block under a gap, pillars up (jump and place), digs a stair down. Walks with key presses. Lava or lava next to a dug cell: that move is not taken. Fall cap 3. No blocks in the bag: it digs a few natural ones within arm's reach |
| 3 | no progress for 2 rounds: walks 10-34 blocks to the side of the line to the target (by hand), then plans again from there |

**Never broken** (`PROTECTED` in reach.js): chests, barrels, furnaces, crafting tables, hoppers, beds, anvils, enchanting tables, redstone parts, signs, banners, candles, lanterns, ladders, scaffolding, bedrock, obsidian, spawners, portals, farmland. **Never dug**: a block something hangs on (the wall behind a ladder, torch, lever, sign; Walter's mining-ladder rule), and any block next to lava.

**Put back** (`Breaches`): while a go-to escalates, every block that goes from solid to air within 7 blocks of the bot is checked. Inside the base zone (`baseCenter` -1059,2341, `baseRadius` 80, in `config.json` -> `reach`) everything that is not plain ground is remembered; elsewhere only things that look built (planks, bricks, glass, fences, doors, slabs, stairs, concrete ...). When the go-to ends the bot seals them in the order it broke them: from the far side (it steps through the opening, one cell past the breach, and places the block it got from the drop or an equivalent from the bag). Breaches it could not reach (>48 blocks away, interrupted) stay in `brain/state/nav-state.json` -> `breaches`; `api.nav.rebuildPending()` closes them. Natural tunnels are left as tunnels.

**Stops at once** on `nav.stop()`, a stop command, a new go-to, or when another module changes the pathfinder goal while the bot steers by hand. Pauses (up to 15 s at a time) only for real danger: in lava, or health <= 6 with a hostile within 6.

Options on `nav.goto(goal, opts)`: `escalate: false` (one plain attempt: item pickup, route legs, viewpoints, closing doors), `startAtDig: true` (skip the plain attempt), `maxMs`. Config (`config.json` -> `reach`): `maxMs`, `maxStall`, `thinkBase`, `thinkMax`, `planMs*`, `baseCenter`, `baseRadius`. `"escalate": false` at the top level of config.json switches the whole thing off. Tests: `node --test test/nav.reach.test.js` (real pathfinder and physics over a fake world with stateful dig / place).

## Reaching a block to use it (chests, furnaces, cauldrons)

`nav.approachBlock(pos, {label, reach, ms, isAborted})` -> `{ok, err, stand, via}` and the drop-in `nav.gotoNear({pos, ctx, label, ms})` -> boolean (same arguments as `brain/util.js` `gotoNear`; on the handle and `api.nav`).
It lists the cells where the bot can really stand (solid floor, two free cells, no hazard, slab-aware floor height) with the block inside arm's reach (eye to the nearest point of the block, 4.2) and a clear view, then paths to the nearest one with a `GoalCompositeAny`. A block with no such cell fails at once with "no spot within reach with a clear view of it".
Why: Walter's furnace chests are on the wall of a tall hall, 4-5 blocks above the floor; `GoalNear(chest, 3)` has no standable cell inside its sphere, so the pathfinder searches the whole connected base and times out ("Took to long to decide path to goal!"), and the old fallback ("within 4.6 of the block centre, measured from the feet") rejects a chest that is well within reach from the floor. Tested on blocks read from the real save (`test/fixtures/furnace-station1.json`, `-station2.json`, `test/nav.station.test.js`): every output/fuel/input chest of both stations is usable from the hall floor, 0.2-0.8 s each.
To use it from `brain/index.js`: `const gotoNear = (o) => (api.nav && api.nav.gotoNear ? api.nav.gotoNear(o) : util.gotoNear({ bot, goals, tryGoto, stop: stopNav, ...o }))`.

## Ladders (the iron-mine shaft)

Two library behaviours made the shaft at -1042,27..128,2281 unusable (live bug, bot stuck at its bottom): the library lifts every ladder path node onto the top of the ladder block (y + 1) and aims it 0.2 blocks into the plate, so the first node is 2 blocks up and, from the side of the block under the ladder, the bot steers into the corner next to the plate and never jumps on. `DoorTender.fixLadders` puts ascending ladder nodes back into their cells and aims the entry node at the cell centre. And the stuck monitor took a long vertical climb for "dithering" and gave up at level 5 (dithering now needs a small vertical extent too). Tested on the real blocks (`test/fixtures/shaft-bottom.json`, `test/nav.ladder.test.js`); a 90-rung climb has no stuck episode. Without nav loaded, a two-step go-to works around it: first `go to -1042 26 2284` (in front of the ladder), then `go to -1042 128 2281`.

**Descending a ladder** (Walter: "you just have to do nothing and you will descend"): the pathfinder held forward + sprint for the whole descent. `DescentAssist` (`climb.js`) releases every control state (never sneak) while the bot is in a ladder/vine cell and the next path node is below it, and hands control back at the bottom. 4 facings, real shaft: no key held on the rungs, a slide (|vy| <= 0.25) instead of a fall, same speed as doing nothing. Mining's own `shaft.slideDown` already does the same; its deliberate sneak on the *lowest* rung (hold still while the next cell is checked) is the only sneak left.

## Arrival messages ("Here.")

Live bug: "go to x z" that had to wait behind routines still printed "Here.". Cause: `join.js` says "Here." on EVERY `goal_reached`, whoever set the goal, so a routine's arrival announced the go-to's. With nav attached (`silenceHere`, default on) that listener is skipped for every goal (all other `goal_reached` listeners still run; undone in `stop()`), and nav's `navigate()` announces arrivals itself, only after checking the bot's real position against the goal:
- go-to has to wait behind another task: "Waiting for <task> to finish, then heading to <place>." then "On my way." when it starts
- arrived (position satisfies the goal): "Here."
- the pathfinder said done but the position does not satisfy the goal: "I stopped short of <place>, still N blocks away."
- idle bot: no extra chatter. Optional clean-up in `join.js` (not required): `bot.on('goal_reached', () => { if (!quietNav && !BRAIN) say('Here.') })`.

## The Nether: the safe network log

Walter's rule: in the Nether the bot travels **only along logged, verified segments, never by algorithmic pathfinding**, and asks before exploring anything new. Log: `brain/state/nether-network.json` (`nether.js`); walking and recording: `nether-walk.js`; wiring/commands: `nether-trip.js`.
- **Nodes**: Walter's Xaero Nether portals (verified, seeded at start), places of interest, junctions where a walked route starts/ends. **Hazards**: seeded with the 12 lava blocks around the arrival portal (-129,61,288); every recorded route is scanned for lava/fire/magma within 2 blocks and for ledges (drop > 3) beside it.
- **Segments**: a walked line, a vertex every ~2 blocks with the y it was walked at. Logged automatically when **Walter** walks in the Nether (his entity, on the ground, >= 12 blocks; flying/teleports are not logged; "stop logging my nether walks" / "log my nether walks"). Verified when Walter walked it; the bot's own exploration track is usable for the way back and becomes verified after a second clean walk.
- **Travel**: "go to <Nether place>" (or any trip with a Nether leg) walks: straight live-checked step to the nearest logged node (<= 8 blocks) -> the shortest chain of usable segments -> short step to the place. `SegmentWalker` follows the logged vertices with plain key presses (no path search); every step checks what is ahead and stops for lava/fire, a hole or ledge, a wall, being pushed off the line (2.4 blocks), or being stuck, then marks that segment **blocked** until Walter says "nether route ok".
- **No logged route**: nothing is walked (a trip from the overworld is not even started), Walter is asked once. "explore the nether route" approves one exploration (short pathfinder legs, `netherOk`, recorded as an unverified segment); "no" drops it.
- **Guard**: `nav.goto` / `navigate` / `route.travel` in the Nether refuse goals farther than 8 blocks from the bot (also "follow me"), unless the walk is an approved exploration. Raw pathfinder goals set by other modules directly are not intercepted (the portal stepping in `join.js` uses small local moves).
- Chat: "nether network" (status), "explore the nether route", "no", "nether route ok", "stop logging my nether walks". Status is in `status().nether`. Not tested against the real Nether (synthetic worlds only); the network starts with portals and no segments, so the first trips will ask until Walter has walked some routes.

## Files

`index.js` (entry, commands, trips) · `navigator.js` (goto, attach/detach, status) · `movements.js` (planner config) · `doors.js` · `stuck.js` · `hazards.js` · `waypoints.js` · `route.js` · `blocks.js` · `nether.js` / `nether-walk.js` / `nether-trip.js` (the Nether network). Optional `config.json` (`xaeroWorld`, `maxFall`, `directMax`, `legLen`, `quietGoals`, `longTripBlocks`, `netherShortcutMin`).
Writes only `brain/state/nav-state.json` (open doors) and `brain/state/nether-network.json` (the Nether log). Reads `waypoints.json` and `%APPDATA%\.minecraft\xaero` (read-only).

## For the integrator / join.js

- Nothing is required in `join.js`. Optional clean-ups once nav is live: remove `tendDoors()` and the 2 s stuck watchdog from `join.js` (they do the same job; both running is harmless: nav opens first, join only closes doors it opened itself).
- "Here." after every internal leg: `join.js` says "Here." on every `goal_reached`. nav keeps its own goals quiet by delivering their `goal_reached` only to itself (`quietGoals`, a patch of `bot.emit` that is removed again in `stop()`). If `join.js` instead skips goals with `goal.navQuiet === true`, set `"quietGoals": false` in `config.json`.
- To let a Nether trip run in one go, pass the driver's portal job on the api: `api.usePortal = (wantDim) => jobs.usePortal(wantDim)` (or `api.jobs`). Without it the trip hands over to the "go to the nether" command and resumes after the switch.
- Nether routes over unloaded chunks use the frontier explorer; they were tested against synthetic tunnels and lava, **not against the real Nether**. First live Nether trip: watch it.

## Tests

`node --test test/nav.*.test.js`. The helpers (`test/nav.helpers.js`) run the **real** mineflayer-pathfinder planner/executor and the **real** prismarine-physics engine over a fake block world (real `prismarine-block` blocks, doors that toggle, "server" refusing locked doors, chunk window around the bot, desynced "invisible" blocks), in virtual game time, so no server and no restart are needed.
Not covered offline: real server latency for door state updates (the tender waits up to 4 ticks and then retries, spaced 5 ticks apart), real chunk loading speed, mobs.
