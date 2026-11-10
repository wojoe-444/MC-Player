# Review findings: OzoGo444

_Updated 2026-11-10T17:28:50.800Z by claude-haiku-5-5. Status: **issues**. Idle at the far-west torch grid near (-6049,50,-2355) holding a torch while its torch-spacing step times out. Iron has been 14 since 16:31 and logs 16 since 16:51, so phase 2 (industry and lit areas) is stalled._

Written by the spectator reviewer (reviewer/). Read by the driver thread and shown in the Bot Dashboard app. Never posted to game chat.

## [HIGH] Torch-spacing step times out 16 times in 5 min while Ozo stands still
`ozo-torch-spacing-step-timeouts` · repeated_failure · confidence high · first seen 2026-11-10T17:11:01.830Z · seen in 2 run(s)

**Evidence:** repeated_failure is active (16 timeouts in 5 min, last at autopilot:torch-spacing); in the last minute Ozo was idle 49 of 60 s at (-6049.5, 50, -2354.5) holding a torch with 0 placed, and the bag holds 139 torches (131 at the 17:21 review). The 17:26:09 light-home log still reported 30 spawnable cells left, so the lit grid is not finishing.

**Suggestion:** Trace the torch-spacing placement loop at (-6049,50,-2355): log each target it tries and why it times out, and cap the step at a few targets per pass so it does not stand still holding torches; the same far-west area shows in smeo-light-home-torch-stall.

## [MED] Tree farm has no oak sapling, so wood-stock fails and logs stay at 16
`ozo-treefarm-no-oak-sapling` · no_progress · confidence high · first seen 2026-11-10T16:51:01.874Z · seen in 3 run(s)

**Evidence:** At 17:21:46 the TREEFARM line read trees 0, planted 0, noSapling 1, and wood-stock failed x5 after 'tree farm gave 0 logs'. oak_log has been 16 since 16:51, Ozo's bag holds only one acacia_sapling, and Smeo carries 7 oak_sapling.

**Suggestion:** Have the tree-farm step fetch an oak sapling (from a chest or a leaf dig) before wood-stock runs, and stop after a few failures rather than retrying the goal.

## [MED] Ozo's iron goal mines no ore; iron flat at 14 since 16:31
`ozo-iron-goal-nopath-no-ore` · no_progress · confidence high · first seen 2026-11-10T17:11:01.830Z · seen in 2 run(s)

**Evidence:** iron_ingot is still 14 (unchanged since 16:31), the 17:24:49 'day 34' log reads iron mined 0, ingots 0, and the iron goal hit noPath 10 times in 5 min in the 17:18:46 window. This key was closed at 17:21 but the count has not moved; Smeo's iron tunnels mined no ore either (smeo-iron-woodstock-rearm).

**Suggestion:** After one tunnel mines no iron, have the iron goal pick a new depth or line and log that choice, rather than re-running the same tunnel.

## [MED] Climbs in shaft column -6018,-2355 fail with no path from the y -4 foot
`ozo-shaft-column-climb-loop` · repeated_failure · confidence med · first seen 2026-11-10T16:11:01.817Z · seen in 9 run(s)

**Evidence:** 15 noPath in 10 min, and at 17:20:42-44 nav logged 'could not get to the foot of the ladder: no path' while also logging '0 ladders + 0 backing blocks needed' for that column, so nav's model and the world disagree. Climbs have worked since (up the shaft by 17:21:34, and y -5 to 66 in the 17:26 window), while Smeo's climb stalls at a gap near y 13 in the same column (smeo-shaft-stuck-at-gap).

**Suggestion:** Compare every cell of column -6018/-6019,-2355 from y -4 to 66 with what nav expects, and make the foot-of-ladder check name the blocking cell instead of reporting 'no path'.

## [LOW] Iron pickaxe held while digging cobbled deepslate, one tier too high
`ozo-iron-pickaxe-on-deepslate` · rule_violation · confidence med · first seen 2026-11-10T17:28:50.800Z · seen in 1 run(s)

**Evidence:** The 17:24:47 window at 73 s (about 17:26:00, at (-6022.5, 66.6, -2355.5)) shows iron_pickaxe as the held item with cobbled_deepslate as the block being dug; the tool_tier flag is not active, so it looks brief.

**Suggestion:** Have the cobbled-deepslate dig select the stone pickaxe first, since iron is only for diamond, gold, redstone and emerald.

## [LOW] Placed-block log save fails with EPERM on rename
`ozo-placed-blocks-save-eperm` · code_fault · confidence med · first seen 2026-11-10T17:21:01.868Z · seen in 1 run(s)

**Evidence:** At 17:17:38 the autopilot PLACED save failed: renaming placed-blocks.json.OzoGo444.tmp to placed-blocks.json returned EPERM (operation not permitted), and no retry line follows in the tail.

**Suggestion:** Inspect the placed-blocks save in the autopilot PLACED path: retry the rename after a short delay or write the file in place, and check whether another process holds placed-blocks.json.

## Detectors the reviewer wrote

Small non-blocking checks the reviewer turns judgement into. Enabled only after replaying them on captured telemetry (fires on the bad window, quiet on normal play). Source and origin: brain/state/detectors/.

- ENABLED `custom_shaft_round_trip` (2026-11-10T13:11:01.881Z): Vertical out-and-back with no digs or places. Ozo's iron and light-home goals run full shaft round trips (10+ blocks up and down, twice in 2.5 min) that dig and place almost nothing. ladder_shuttle needs a ladder held and ladder_bobbing excludes shaft trips, so oscillating caught only 1 of these 5 windows. A driver should find the goal that sends the bot back up. Fired on 2/2 bad windows, 0/8 normal.
- ENABLED `custom_ladder_shuttle` (2026-11-10T11:51:01.648Z): Long ladder shuttles with no digs. Ozo held a ladder for 481 of 600 s in the last 10 min with 4 digs, and the 11:46-11:50 windows show the same shuttle; ladder_bobbing needs 4 reversals in one column and stayed quiet. A ladder held most of 2 min with almost no digs or places is a shaft trip that does no work, and a driver should find the goal that sends the bot up and down. Fired on 3/3 bad windows, 0/8 normal.
- rejected `held_churn` (2026-11-10T10:51:01.742Z): none of the nominated bad windows exist (ids must come from the "windows" list)

## Recently resolved

- Ozo's torch pair at x -6021 and -6023, y 66, is two blocks apart (`ozo-torch-pair-two-apart`) resolved 2026-11-10T17:28:50.800Z: closed by the reviewer: gone, or merged into another finding
- Floor fill retries a torch cell 4 times in one tick (Smeo too) (`ozo-floor-fill-retries-torch-cell`) resolved 2026-11-10T17:21:01.868Z: closed by the reviewer: gone, or merged into another finding
- Leaves dug bare-handed with a hoe in the bag; grove has no oak sapling (`ozo-leaves-by-hand-no-sapling`) resolved 2026-11-10T17:21:01.868Z: closed by the reviewer: gone, or merged into another finding
- Iron flat at 14 for 30+ min; the y -4 tunnels mined no iron (`ozo-goal-thrash-no-iron`) resolved 2026-11-10T17:11:01.830Z: closed by the reviewer: gone, or merged into another finding
- Stone axe used on oak leaves while a stone hoe is in the bag (`ozo-axe-on-leaves-hoe-in-bag`) resolved 2026-11-10T17:11:01.830Z: closed by the reviewer: gone, or merged into another finding
- Torch 2 blocks from another at (-6021,66,-2330), unfixed for 12 minutes (`ozo-treefarm-torch-too-close`) resolved 2026-11-10T17:01:01.847Z: closed by the reviewer: gone, or merged into another finding
- Pillar and oscillation flags fire on ladder climbs, not on pillaring (`ozo-ladder-ride-trips-pillar-oscillating`) resolved 2026-11-10T16:51:01.874Z: closed by the reviewer: gone, or merged into another finding
- Telemetry: task and held-item seconds add up to more than the window (`ozo-telemetry-seconds-exceed-window`) resolved 2026-11-10T16:41:01.868Z: closed by the reviewer: gone, or merged into another finding
