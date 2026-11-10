# Review findings: Smeo444

_Updated 2026-11-10T07:28:01.586Z by claude-haiku-5-5. Status: **issues**. Smeo is idle at the shaft top (-6018,65,-2354) holding cobblestone after a 45 s discard stall. Pickaxes came back at the 07:25 restock, but 39 of 81 digs in 10 min dropped nothing, so Phase 2 is not moving._

Written by the spectator reviewer (reviewer/). Read by the driver thread and shown in the Bot Dashboard app. Never posted to game chat.

## [HIGH] Stone digs drop nothing: cobblestone in hand, or no pickaxe in the bag
`smeo-cobblestone-held-while-digging` · wrong_tool · confidence high · first seen 2026-11-10T07:28:01.586Z · seen in 1 run(s)

**Evidence:** 39 of 81 digs in the last 10 min dropped nothing, and cobblestone was the held item for 407 of 600 s; the 07:23:48 example had no pickaxe in the bag (have=false). The pillar routine logs cobblestone in hand (six 'nav pillar ok' lines, 07:23:11 to 07:24:00), and after the 2 stone pickaxes came back at 07:25:21 the bot still holds cobblestone and made no digs in the last minute.

**Suggestion:** After a pillar or place step, re-select the stone pickaxe before the next dig, and have the dig step run tool-kit or refuse stone digs when no pickaxe is in the bag; check the exit of the nav pillar routine.

## [HIGH] Restock and light-home stall on noPath at the shaft foot for minutes
`smeo-light-home-goal-stalls` · repeated_failure · confidence high · first seen 2026-11-10T07:11:01.854Z · seen in 3 run(s)

**Evidence:** 16 noPath in the last 5 min (goal restock), 17 each in the 07:16:46 to 07:17:17 light-home windows, and a 217 s restock walk that ended with a StepTimeout at 07:24:00. Ozo stalled on the same foot tile (y51, z -2354.5) at 07:22:10 for 49 s, so the spot is shared.

**Suggestion:** Cap restock and light-home retries after two noPath results at one tile, and check the blocks at the shaft foot (x -6018 to -6019, y50-51, z -2354/-2355) for a torch, ladder or the other bot standing in the 1-wide path.

## [MED] Smeo pillars a second climb column two blocks from the ladder shaft
`smeo-second-pillar-column-by-shaft` · other · confidence med · first seen 2026-11-10T07:28:01.586Z · seen in 1 run(s)

**Evidence:** Six 'nav pillar ok' lines from 07:23:11 to 07:24:00 place cobblestone in a column at x -6020, z -2355, y 55 to 61, two blocks from the ladder at -6018,-2354. The ladder logged 3 up/down legs in that column at 07:24:12 to 07:24:26, and the bot used the shaft only at 07:24:31.

**Suggestion:** Check whether the 07:24 ladder loop pushed the climb into pillaring, fix the ladder route, and remove the extra column so the area keeps one shaft.

## [LOW] Wooden-tools step ran in Phase 2 and left a wooden sword in the bag
`smeo-wooden-tools-step-in-phase-2` · rule_violation · confidence high · first seen 2026-11-10T07:28:01.586Z · seen in 1 run(s)

**Evidence:** 'GOAL step wooden-tools' ran at 07:25:21 after tool-kit had 2 stone pickaxes, and wooden_sword went from 0 to 1 in the bag since the 07:21 review. Ozo logged the same step at 07:15:33 from the same tool-kit goal.

**Suggestion:** Remove the wooden-tools step from the tool-kit step list for both bots, since stone is the default tool now.

## [LOW] Stair at (-6013,66,-2335) never confirmed closed; not checked since 06:50
`smeo-staircase-near-shaft` · rule_violation · confidence med · first seen 2026-11-10T05:41:04.595Z · seen in 9 run(s)

**Evidence:** close-stairs logged it as 'partly closed (6 blocks)' at 06:50:19 (previous review), and no later line confirms it closed; it sits about 20 blocks from the shaft, inside the 250-block no-stairs rule. No staircase flag fires now, so this is unchanged.

**Suggestion:** Check that stair in person, close or remove it, and find which route step dug it.

## [LOW] Telemetry task split counts more time than the 10-min window
`smeo-task-tag-blank` · code_fault · confidence high · first seen 2026-11-10T05:51:01.424Z · seen in 7 run(s)

**Evidence:** secondsByTask '(none)' is 657.7 s of the last 10 min (a 600 s window), while the stall lines name task=autopilot.

**Suggestion:** Count each sample once in the task split and match it to the scheduler task name.

## Recently resolved

- Stone digs have no pickaxe: sword in hand, both pickaxes gone (`smeo-sword-held-while-digging`) resolved 2026-11-10T07:28:01.586Z: closed by the reviewer: gone, or merged into another finding
- Cobblestone fillers placed in open air on the surface, 4 in 10 min (`smeo-pillar-column-beside-shaft`) resolved 2026-11-10T07:21:01.529Z: no longer happening
- Goals log 'failed' right after reporting nothing left to do (`smeo-shelter-goal-failed-when-complete`) resolved 2026-11-10T07:11:01.854Z: not seen in the last runs
- Detector: pillar failing (`smeo-detector-pillar_failing`) resolved 2026-11-10T07:11:01.854Z: no longer happening
- Smeo cannot path back to the shaft at night: 19 noPath in 5 min (`smeo-no-path-to-shaft-at-night`) resolved 2026-11-10T07:11:01.854Z: no longer happening
- Detector: repeated failure (`smeo-detector-repeated_failure`) resolved 2026-11-10T07:01:16.146Z: no longer happening
- Iron run thrashes: tunnel stalls, goals walk Smeo up and down the shaft (`smeo-iron-run-thrash`) resolved 2026-11-10T07:01:16.146Z: no longer happening
- Nav stuck escalation aims at the tile Smeo is already standing on (`smeo-nav-stuck-targets-own-tile`) resolved 2026-11-10T06:51:01.373Z: no longer happening
