# Review findings: Smeo444

_Updated 2026-11-10T07:38:02.819Z by claude-haiku-5-5. Status: **issues**. Smeo is idle on a discard step at the shaft top (-6017,65,-2354), cobblestone in hand, after its 07:21 alarm. Stone pickaxes are back in the bag after restock and tool-kit, but there is still no raw iron, so Phase 2 smelting has nothing to smelt._

Written by the spectator reviewer (reviewer/). Read by the driver thread and shown in the Bot Dashboard app. Never posted to game chat.

## [HIGH] Surface restock trips jam in the shaft: 16 noPath in 5 min
`smeo-light-home-goal-stalls` · repeated_failure · confidence high · first seen 2026-11-10T07:11:01.854Z · seen in 3 run(s)

**Evidence:** repeated_failure: 16 noPath in the last 5 min, last on restock (same count as the 07:21 review). At 07:24:00 the surface go-to took 217 s, then ladder loop warnings at x -6018, z -2354 (y 52-63) at 07:24:12, 07:24:18 and 07:24:26; restock still took 70 items at 07:24:59, and the 07:26:12 alarm shows 45 s idle on a discard step at the shaft top.

**Suggestion:** Cap restock and light-home retries after two noPath results at one tile, give the surface trip its own path budget, and check whether the ladder at x -6018, z -2354 can take only one bot at a time (Ozo's iron stalls are in that column).

## [HIGH] Digs run with cobblestone in hand: 39 of 81 dropped nothing in 10 min
`smeo-sword-held-while-digging` · wrong_tool · confidence high · first seen 2026-11-10T06:51:01.373Z · seen in 5 run(s)

**Evidence:** cannot_harvest: cobblestone at (-6019,62,-2355) was dug with cobblestone in hand at 07:23:48 and dropped nothing. In the last 10 min cobblestone was the held item for 407 s and the stone sword for 176 s; the bag had no stone pickaxe at the 07:21 review, and two are back after the 07:24 restock, but cobblestone was still in hand at 07:26.

**Suggestion:** After a place or pillar step, equip the stone pickaxe before the next dig, and have the dig routine check the held tool before each dig; the nav pillar steps are where cobblestone stays in hand.

## [MED] Surface go-to hits StepTimeout after a 217 s walk (goSurface)
`smeo-gosurface-steptimeout` · code_fault · confidence high · first seen 2026-11-10T07:38:02.819Z · seen in 1 run(s)

**Evidence:** 07:24:00.346 'nav reach: autopilot arrived via manual after 217s', then at 07:24:00.347 'autopilot LOOP_ERR StepTimeout: step time budget used up'. Top frames: S.check (brain/autopilot/skills.js:36:167) and S.goto (skills.js:190:7), called from M.goSurface (brain/autopilot/plan.js:1565:15); the step errors out even though the walk arrived.

**Suggestion:** Check the step time budget that goSurface passes to goto in brain/autopilot/plan.js against long shaft walks, so a walk that has arrived is not reported as a StepTimeout.

## [MED] Wooden-tools step runs in Phase 2 and crafts a wooden sword
`smeo-wooden-tools-step-after-early-game` · rule_violation · confidence high · first seen 2026-11-10T07:38:02.819Z · seen in 1 run(s)

**Evidence:** GOAL step wooden-tools at 07:25:21 on Smeo, and a wooden_sword is in the bag at 07:26 (none at the 07:21 review), with stone pickaxes and a stone axe already in the bag. Ozo ran the same step at 07:15:33 (previous review), so the step list is shared by both bots.

**Suggestion:** Remove wooden-tools from the tool-kit step list now that stone tools exist, and stash the wooden sword in a chest rather than carrying it.

## [LOW] Stone pickaxe craft times out waiting for updateSlot (20 s)
`smeo-craft-stone-pickaxe-updateslot` · code_fault · confidence med · first seen 2026-11-10T07:38:02.819Z · seen in 1 run(s)

**Evidence:** 07:25:20.511 'autopilot CRAFT_FAIL stone_pickaxe: Error: Event updateSlot:0 did not fire within timeout of 20000ms' in the tool-kit step; the tool-kit step reports pickaxes 2 a second later.

**Suggestion:** Check the craft wait for updateSlot in the tool-kit step, so a 20 s timeout re-checks the bag or retries instead of stalling.

## Recently resolved

- Stair at (-6013,66,-2335) never confirmed closed, near the shaft (`smeo-staircase-near-shaft`) resolved 2026-11-10T07:38:02.819Z: closed by the reviewer: gone, or merged into another finding
- Telemetry task split counts more time than the 10-min window (`smeo-task-tag-blank`) resolved 2026-11-10T07:38:02.819Z: closed by the reviewer: gone, or merged into another finding
- Cobblestone fillers placed in open air on the surface, 4 in 10 min (`smeo-pillar-column-beside-shaft`) resolved 2026-11-10T07:21:01.529Z: no longer happening
- Goals log 'failed' right after reporting nothing left to do (`smeo-shelter-goal-failed-when-complete`) resolved 2026-11-10T07:11:01.854Z: not seen in the last runs
- Detector: pillar failing (`smeo-detector-pillar_failing`) resolved 2026-11-10T07:11:01.854Z: no longer happening
- Smeo cannot path back to the shaft at night: 19 noPath in 5 min (`smeo-no-path-to-shaft-at-night`) resolved 2026-11-10T07:11:01.854Z: no longer happening
- Detector: repeated failure (`smeo-detector-repeated_failure`) resolved 2026-11-10T07:01:16.146Z: no longer happening
- Iron run thrashes: tunnel stalls, goals walk Smeo up and down the shaft (`smeo-iron-run-thrash`) resolved 2026-11-10T07:01:16.146Z: no longer happening
