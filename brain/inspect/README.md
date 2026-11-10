# brain/inspect: the bot looking at what it built

Walter, 2026-11-10: the underground mob farm was built, logged "done" and never made a kill. It was wrong in several ways that a human sees in under a second.
Nothing in the bot looked at its own work. Telemetry sees the bot's body, the Haiku reviewer sees telemetry text, the build routine ends when its phase list ends.
This module is the missing sense: **a structural self-inspection of the bot's own builds, from the blocks it has loaded, compared with the design and with what the
build is for.** It is an observer (never moves the bot, never touches a block).

```
registry room (mobfarm)  ->  rebuild the design (brain/mobfarm/geometry.js)  ->  read the box + margin from bot.blockAt (only when every chunk is loaded)
        -> checks (mobfarm.js)  ->  brain/state/inspect/<room>.json + .md (findings, light map, cutaways), summary.json, a [inspect] line in lessons.md
                                            |                    |                       |                        |
                              planner state build_problems   roadmap 2.8.mobfarm   Haiku reviewer evidence   mob-farm-repair step / mob_farm repair
```

## What it checks (brain/inspect/mobfarm.js)

| finding | sev | meaning |
|---|---|---|
| `stray-light` | fault | a light source inside the spawning room (fix: take it out) |
| `platform-lit` | fault/warn | share of spawnable pads with block light above 0, and which source lights how many (monsters spawn only at block light 0) |
| `blocked` | fault | a cell the design needs open is solid or wet |
| `platform-leak` | fault | an open cell in the shell of the spawning room |
| `pocket-leak`, `slit-wide`, `no-sight` | fault | the landing pocket is not sealed, the slit is more than one block high, the bot cannot see the landing cell from the kill spot |
| `killspot-exposed` | fault | an open cell in the wall of the kill corridor next to the kill spot |
| `water-missing`, `water-still`, `water-levels`, `column-wet` | fault/warn | the trench against the levels the design settles to; a source block in the middle; liquid in the drop column |
| `piece-missing`, `piece-wrong` | fault | chest and hopper (the hopper must face down) |
| `pad-floor` | fault | pads without a solid floor and two air cells |
| `column-open`, `corridor-leak`, `chamber-leak`, `torch-missing`, `plug-open` | warn | the drop crosses old tunnels, other openings in the shell, corridor torches the design lists that are absent, the plug not in place |
| `corridor-filled` | note | the plugged corridor is filled beyond the plug |

A cell that is not in the grid is **unknown, never air**: a half-loaded box produces no false faults.

## The picture

`<room>.md` carries what a human takes in at a glance, as text: a **block-light map** of the spawning room (`.` = dark enough to spawn on, a digit = the light level,
`!` = a flagged cell) and **two cutaways** through the farm (along its axis through the drop column, and across the trench). A room that should be all dots with a
cone of digits in it is visible to a model that has never been told what a torch is; the Haiku reviewer gets these in its evidence (`buildInspections`).

## Who reads it (the loop)

Until now nothing in `brain/` read any review output: `REVIEW-FINDINGS.md` went to the dashboard and to whichever driver thread looked. Now:

* **planner state**: `build_problems` (faults, a pointer to the report, the repair that can help) and `reviewer_notes` (open high/medium findings of the Haiku reviewer, if fresh) are in every STATE the think-brain sees; the system prompt says a build that fails its inspection is not done.
* **lessons.md**: a line `[inspect] <room>: N fault(s)...` when the set of faults changes (the planner reads recent lessons).
* **roadmap**: `2.8.mobfarm` is done only while the inspection has no fault.
* **reviewer**: `buildInspections` in the evidence, with the light map and cutaways when something is wrong; the prompt says it is the one view of the built world.
* **repair**: `mob_farm {action: repair}` (think-brain) and the fallback step `mob-farm-repair` (the planner is off on both live bots) take out a light source inside the spawning room: open the plug, walk in, break it in view, close the plug, re-inspect. Anything else (a leak in the rock, a wide slit) is reported, not patched blind.
* **build routine**: `mobfarmbuild` inspects the farm the moment its last phase ends and notes the result.

## Adding a build type

A build gets a sense by providing (1) a pure `layoutOf...(room)` that rebuilds its design from the registry record, (2) a `check(L, grid)` returning findings (`{id, sev, zone, msg, cells, fix?}`), (3) a case in `rooms()` and `inspectRoom()` in `index.js`. The grid, the light spread and the renderer are shared. Next candidates: storage room, tree farm, animal pens, the shaft itself (ladder column, no gaps).

## Tests

`test/inspect.mobfarm.test.js` runs the inspection on the REAL farm (`test/fixtures/mobfarm-live-2026-11-10.json`, blocks read from the LAN world's region file) and on a perfect farm in all four directions, broken one way at a time.
