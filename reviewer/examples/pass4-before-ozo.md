# Review findings: OzoGo444

_Updated 2026-11-10T17:28:50.800Z by claude-haiku-5-5. Status: **issues**. Light grid reads 45 of 46 torches and the shaft-foot path errors have stopped, but the torch step times out 16x in 5 min. Wood flat at 16 since 16:51 and iron at 14 since 16:31, so Phase 2 is stalled._

Written by the spectator reviewer (reviewer/). Read by the driver thread and shown in the Bot Dashboard app. Never posted to game chat.

## [HIGH] Torch-spacing step times out 16x in 5 min and places no torches
`ozo-torch-step-timeouts` · repeated_failure · confidence med · first seen 2026-11-10T17:28:50.800Z · seen in 1 run(s)

**Evidence:** repeated_failure is active: 16 timeouts in 5 min, last at autopilot:torch-spacing, with 0 torches placed in the last minute. The log shows 'SLOW need() of torch-spacing took 657 ms' at 17:26:10 and 'event loop stalled 2004 ms (step light-home)' at 17:24:54; Smeo's light-home step had 11 timeouts in its own 5-min window.

**Suggestion:** Profile need() in the torch-spacing step (657 ms in one call) and find what holds the event loop for 2 s during light-home, since the timeouts sit inside that step.

## [MED] Wood flat at 16 since 16:51: tree farm planted nothing, no sapling
`ozo-treefarm-no-sapling` · no_progress · confidence med · first seen 2026-11-10T17:28:50.800Z · seen in 1 run(s)

**Evidence:** The treefarm line at 17:21:46 reads planted 0, noSapling 1, pending 10, and wood-stock then logs 'tree farm gave 0 logs' and failed x5. The bag holds one acacia sapling and no oak or birch, while Smeo holds 7 oak saplings.

**Suggestion:** Check which sapling type the treefarm step asks for; the log only says noSapling, so confirm the type before changing the supply.

## [MED] Stash step parks Ozo at shaft y 62 for about 80 s before walking
`ozo-stash-step-parks-at-shaft` · stuck · confidence high · first seen 2026-11-10T17:28:50.800Z · seen in 1 run(s)

**Evidence:** Ozo stood at (-6017,62,-2355) with no digs or places from 17:21:52 to 17:23:14 during the stash step, the same tile and step as the 16:56 stall alarm (idle 45 s). The walk to the storage room (6 chests) only starts at 17:23:18.

**Suggestion:** Find what the stash step waits on at that tile before it starts the storage walk, since the wait repeats each cycle.

## [LOW] Iron pickaxe dug cobbled deepslate once in the breath break-out
`ozo-iron-pickaxe-on-cobbled-deepslate` · rule_violation · confidence med · first seen 2026-11-10T17:28:50.800Z · seen in 1 run(s)

**Evidence:** One dig of cobbled_deepslate with iron_pickaxe held at (-6022.5,66.6,-2355.5), about 17:23:30, matching the 17:23:28 'breath head inside cobbled_deepslate ... breaking out' line. Walter's tier rule allows iron only for diamond, gold, redstone and emerald, and a stone pickaxe is in the bag.

**Suggestion:** Have the breath break-out step pick the lowest pickaxe that mines the block (stone) before it digs.

## Detectors the reviewer wrote

Small non-blocking checks the reviewer turns judgement into. Enabled only after replaying them on captured telemetry (fires on the bad window, quiet on normal play). Source and origin: brain/state/detectors/.

- ENABLED `custom_shaft_round_trip` (2026-11-10T13:11:01.881Z): Vertical out-and-back with no digs or places. Ozo's iron and light-home goals run full shaft round trips (10+ blocks up and down, twice in 2.5 min) that dig and place almost nothing. ladder_shuttle needs a ladder held and ladder_bobbing excludes shaft trips, so oscillating caught only 1 of these 5 windows. A driver should find the goal that sends the bot back up. Fired on 2/2 bad windows, 0/8 normal.
- ENABLED `custom_ladder_shuttle` (2026-11-10T11:51:01.648Z): Long ladder shuttles with no digs. Ozo held a ladder for 481 of 600 s in the last 10 min with 4 digs, and the 11:46-11:50 windows show the same shuttle; ladder_bobbing needs 4 reversals in one column and stayed quiet. A ladder held most of 2 min with almost no digs or places is a shaft trip that does no work, and a driver should find the goal that sends the bot up and down. Fired on 3/3 bad windows, 0/8 normal.
- rejected `held_churn` (2026-11-10T10:51:01.742Z): none of the nominated bad windows exist (ids must come from the "windows" list)

## Recently resolved

- Placed-block log save fails with EPERM on rename (`ozo-placed-blocks-save-eperm`) resolved 2026-11-10T17:28:50.800Z: closed by the reviewer: gone, or merged into another finding
- Ozo's shaft climb from y -4 fails with no path, looping wood and iron goals (`ozo-shaft-column-climb-loop`) resolved 2026-11-10T17:28:50.800Z: closed by the reviewer: gone, or merged into another finding
- Ozo's torch pair at x -6021 and -6023, y 66, is two blocks apart (`ozo-torch-pair-two-apart`) resolved 2026-11-10T17:28:50.800Z: closed by the reviewer: gone, or merged into another finding
- Floor fill retries a torch cell 4 times in one tick (Smeo too) (`ozo-floor-fill-retries-torch-cell`) resolved 2026-11-10T17:21:01.868Z: closed by the reviewer: gone, or merged into another finding
- Iron goal hits no-path and mines no ore; iron flat at 14 since 16:31 (`ozo-iron-goal-nopath-no-ore`) resolved 2026-11-10T17:21:01.868Z: closed by the reviewer: gone, or merged into another finding
- Torch-spacing step timed out 23 times in 5 min; Ozo's torch pair still stands (`ozo-torch-spacing-step-timeouts`) resolved 2026-11-10T17:21:01.868Z: closed by the reviewer: gone, or merged into another finding
- Leaves dug bare-handed with a hoe in the bag; grove has no oak sapling (`ozo-leaves-by-hand-no-sapling`) resolved 2026-11-10T17:21:01.868Z: closed by the reviewer: gone, or merged into another finding
- Iron flat at 14 for 30+ min; the y -4 tunnels mined no iron (`ozo-goal-thrash-no-iron`) resolved 2026-11-10T17:11:01.830Z: closed by the reviewer: gone, or merged into another finding
