# Review findings: OzoGo444

_Updated 2026-11-10T07:28:01.586Z by claude-haiku-5-5. Status: **issues**. Ozo is digging copper and lapis near (-6018,48,-2337) with a stone pickaxe out. Raw copper rose from 44 to 93 since the 07:21 review, but raw iron is still 0, so Phase 2 is stalled at the iron and smelter step._

Written by the spectator reviewer (reviewer/). Read by the driver thread and shown in the Bot Dashboard app. Never posted to game chat.

## [HIGH] Detector: stuck
`ozo-detector-stuck` · stuck · confidence med · first seen 2026-11-10T07:28:01.586Z · seen in 1 run(s) · detector only

**Evidence:** trying to move (pathfinder/controls active 100% of 20s) but did not leave a 0.0-block spot

**Suggestion:** Raised by the in-bot detector; the model did not comment on it. Watch the bot and check the flagged window.

## [HIGH] Iron still 0 after 49 more copper; the y50 digs keep hitting copper
`ozo-iron-goal-stuck-at-shaft-foot` · no_progress · confidence high · first seen 2026-11-10T07:11:01.854Z · seen in 3 run(s)

**Evidence:** Raw iron has been 0 at every review since 07:15, while raw copper went 44 to 93 (+49 since 07:21) and lapis 0 to 15. The iron step then stalled 49 s at the shaft foot (07:22:10, 'could not ride the ladder down') and logged 'iron failed x1' at 07:22:12; the same foot tile is in the Smeo finding.

**Suggestion:** Have the iron step count ore by type and move to a new band or direction after two tunnels with no iron, instead of re-digging the y50 tunnel; check why the mine goal's main output is copper and lapis.

## [HIGH] Detector: repeated failure
`ozo-detector-repeated_failure` · repeated_failure · confidence med · first seen 2026-11-10T07:21:01.529Z · seen in 1 run(s) · detector only

**Evidence:** 26x timeout in 5 min (last: :wood-stock)

**Suggestion:** Raised by the in-bot detector; the model did not comment on it. Watch the bot and check the flagged window.

## [MED] wood-stock cut a surface tree, against the trees-above-ground rule
`ozo-wood-stock-cuts-surface-trunk` · rule_violation · confidence med · first seen 2026-11-10T07:28:01.586Z · seen in 1 run(s)

**Evidence:** Between 07:19:35 and 07:20:14 the wood-stock goal took logs from one surface tree (oak_log digs at x -6040 to -6043, z -2392 to -2394, y 67 to 76), ending at '+12 logs, now 26'. The grove goal planted 6 saplings at 07:22:35, but that does not undo the cut tree the rule protects.

**Suggestion:** Make wood-stock take logs only from trees it planted or from the grove, and leave natural surface trees standing; check the target choice in the wood-stock step.

## [MED] Path searches time out 32 times in 10 min before the escalation walk works
`ozo-navigator-path-update-lag` · repeated_failure · confidence high · first seen 2026-11-10T07:11:01.854Z · seen in 3 run(s)

**Evidence:** 32 timeouts and 4 noPath in the last 10 min (26 timeouts at the 07:21 review), and the repeated_failure flag is still active (5 timeouts in 5 min). In the idle log each failed search (07:19:45, 07:20:06, 07:20:15, 07:22:30) was followed by an escalation that arrived 7.5 to 12.6 s later.

**Suggestion:** Log the search time and goal distance for each timeout in nav reach, and start the escalation route at once rather than waiting out the search budget.

## [MED] Oak logs chopped with the stone sword while the stone axe rides in the bag
`ozo-sword-held-for-everything` · wrong_tool · confidence high · first seen 2026-11-10T07:11:01.854Z · seen in 3 run(s)

**Evidence:** stone_sword is the held item for 325 of the last 600 s; 10 of 62 digs in the last 10 min were oak_log with it, and the 5-min flag counts 3 of 49. The last minute is clean (stone_pickaxe held 67 s, 0 wrong-tool digs), and the pillar_failing flag from 07:19:50 is gone.

**Suggestion:** Find what re-selects the sword after a fight or the wood step (check the combat reflex, which logged 'combat reflex on' at 07:21:51), and have the log-chop step equip the stone axe before the first dig.

## [LOW] Planner model errors on every call; steps stay at 0
`ozo-planner-model-errors` · code_fault · confidence high · first seen 2026-11-10T04:43:23.832Z · seen in 17 run(s)

**Evidence:** plannerSummary still shows model-error 380 and no-plan 369 with steps 0, unchanged at the 07:11, 07:21 and 07:28 reviews.

**Suggestion:** Confirm the model key and router hook load in Ozo's pilot config; steps should rise above 0 once the planner gets a reply.

## Recently resolved

- placed-blocks.json save fails with EPERM on both bots (`ozo-placed-blocks-save-eperm`) resolved 2026-11-10T07:28:01.586Z: not seen in the last runs
- Wooden-tools step still runs in Phase 2; a wooden sword was held (`ozo-wooden-tools-step-after-early-game`) resolved 2026-11-10T07:28:01.586Z: closed by the reviewer: gone, or merged into another finding
- Detector: pillar failing (`ozo-detector-pillar_failing`) resolved 2026-11-10T07:28:01.586Z: closed by the reviewer: gone, or merged into another finding
- Path to the copper tile failed 3 times in under 2 min (06:53-06:55) (`ozo-light-home-timeout-loop`) resolved 2026-11-10T07:11:01.854Z: no longer happening
- Iron search: 48-block tunnel at y16 found no raw iron, goal failed (`ozo-iron-search-no-result`) resolved 2026-11-10T07:11:01.854Z: no longer happening
- Detector: cannot harvest (`ozo-detector-cannot_harvest`) resolved 2026-11-10T07:11:01.854Z: no longer happening
- Ozo has no ladder to climb back up; the shaft column is one ladder short (`ozo-no-ladder-to-leave-shaft`) resolved 2026-11-10T06:51:01.373Z: no longer happening
- Iron run stalls at the shaft base: 0 iron, jumping in place at y47 (`ozo-iron-step-no-iron`) resolved 2026-11-10T06:51:01.373Z: no longer happening
