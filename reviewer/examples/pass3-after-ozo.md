# Review findings: OzoGo444

_Updated 2026-11-10T07:38:02.819Z by claude-haiku-5-5. Status: **issues**. Ozo is digging copper and lapis in the y50 tunnel with a stone pickaxe, at (-6018,48,-2337). Lighting and the grove (6 saplings planted) moved on, but raw iron is still 0, so Phase 2 smelter work stays blocked._

Written by the spectator reviewer (reviewer/). Read by the driver thread and shown in the Bot Dashboard app. Never posted to game chat.

## [HIGH] Iron step stalls on the shaft ladder: 3 watchdog stalls in 15 min
`ozo-iron-step-ladder-stall` · stuck · confidence high · first seen 2026-11-10T07:38:02.819Z · seen in 1 run(s)

**Evidence:** Watchdog stalls on the iron step at 07:08, 07:12 and 07:22 (the last one 49 s idle at (-6018,51,-2355)), each cleared by the same L1 kick. The stuck flag (07:21:50 to 07:22:06) and 'could not ride the ladder down (1)' at 07:22:10 show it failing to move on the shaft ladder; Smeo logged ladder loops in the same column (x -6018, z -2354) at 07:24.

**Suggestion:** Find why an iron-goal ladder ride stops after the kick (the code that logs 'could not ride the ladder down') and whether only one bot can use this column at a time.

## [MED] Path searches time out 32 times in 10 min; escalation adds 7-11 s each
`ozo-path-search-timeouts` · repeated_failure · confidence med · first seen 2026-11-10T07:38:02.819Z · seen in 1 run(s)

**Evidence:** repeated_failure: 5 timeouts in the last 5 min (last on iron); 32 timeouts and 4 noPath in the last 10 min, up from 26 timeouts at the 07:21 review. The logged timeouts at 07:19:45, 07:20:06 and 07:22:30 each arrived by plan 7.5 to 10.7 s later, so the route is found, just late.

**Suggestion:** Log the search time for each nav reach call and check the search budget for iron and wood targets; the cause is not confirmed yet, so confirm it there before changing the navigator.

## [MED] Raw iron still 0 in the bag; the y50 tunnel yields copper and lapis
`ozo-iron-goal-stuck-at-shaft-foot` · no_progress · confidence high · first seen 2026-11-10T07:11:01.854Z · seen in 3 run(s)

**Evidence:** Raw iron is 0 at the 07:21 review and now. Since then raw copper went 44 to 93 and lapis 0 to 15, all from digs at y50 around (-6020,50,-2346), so the iron search runs but finds none.

**Suggestion:** Stop the y50 tunnel after its copper and lapis, move the iron search to a new band or direction, and log the band chosen so the next review can compare.

## [MED] Stone sword held while chopping oak logs; stone axe stays in the bag
`ozo-sword-held-for-everything` · wrong_tool · confidence high · first seen 2026-11-10T07:11:01.854Z · seen in 3 run(s)

**Evidence:** wrong_tool: 3 of 49 digs in the last 5 min were oak_log with stone_sword (example at (-6043,76,-2394)); the 10-min count is 10 of 62 digs, with the sword held 325 s of 600 s. The stone axe is still unused in the bag, and the wood-stock goal logged +12 logs at 07:20:14 with the sword in hand.

**Suggestion:** Find the routine that re-selects the sword after each swing, and have the log-chopping step equip the stone axe before the first dig.

## Recently resolved

- Wooden-tools step still runs in Phase 2; a wooden sword was held (`ozo-wooden-tools-step-after-early-game`) resolved 2026-11-10T07:38:02.819Z: closed by the reviewer: gone, or merged into another finding
- Detector: repeated failure (`ozo-detector-repeated_failure`) resolved 2026-11-10T07:38:02.819Z: closed by the reviewer: gone, or merged into another finding
- Path searches time out 26 times in 10 min; navigator.js:281 suspected (`ozo-navigator-path-update-lag`) resolved 2026-11-10T07:38:02.819Z: closed by the reviewer: gone, or merged into another finding
- placed-blocks.json save fails with EPERM on both bots (`ozo-placed-blocks-save-eperm`) resolved 2026-11-10T07:38:02.819Z: closed by the reviewer: gone, or merged into another finding
- Planner errors on every call; steps stay at 0 (`ozo-planner-model-errors`) resolved 2026-11-10T07:38:02.819Z: closed by the reviewer: gone, or merged into another finding
- Detector: pillar failing (`ozo-detector-pillar_failing`) resolved 2026-11-10T07:38:02.819Z: closed by the reviewer: gone, or merged into another finding
- Path to the copper tile failed 3 times in under 2 min (06:53-06:55) (`ozo-light-home-timeout-loop`) resolved 2026-11-10T07:11:01.854Z: no longer happening
- Iron search: 48-block tunnel at y16 found no raw iron, goal failed (`ozo-iron-search-no-result`) resolved 2026-11-10T07:11:01.854Z: no longer happening
