# Review findings: Smeo444

_Updated 2026-11-10T17:28:50.800Z by claude-haiku-5-5. Status: **issues**. Walked about 90 blocks out and back on the light-home torch goal, which failed 18 times and ran out of time at 17:27:53, then moved to wood-stock. Iron has been 24 since 16:47, so phase 2 is stalled on iron and lighting._

Written by the spectator reviewer (reviewer/). Read by the driver thread and shown in the Bot Dashboard app. Never posted to game chat.

## [HIGH] Four torches on Smeo's y 67 row sit two blocks apart, unfixed 50+ min
`smeo-grove-torch-row-two-apart` · rule_violation · confidence high · first seen 2026-11-10T16:21:01.849Z · seen in 8 run(s)

**Evidence:** torch_spacing has been active since 16:36:35 (179 refreshes, last 17:25:55), with (-6027,67,-2326) two blocks from (-6029,67,-2326); the count fell from 5 at 17:11 to 4 but the pairs stand. Treefarm TORCH placements at 17:05:06 and 17:05:22 (x -6019 and -6015) each sat two blocks from the x -6017 torch, and Ozo's similar pair at y 66 has cleared since the 17:21 review.

**Suggestion:** Remove one torch of each flagged pair where the row stays lit, and have the treefarm TORCH placer and the torch-spacing step skip any cell within 2 blocks of a torch on the same row.

## [HIGH] Light-home torch goal walks about 90 blocks out and back, then fails
`smeo-light-home-torch-stall` · repeated_failure · confidence high · first seen 2026-11-10T17:21:01.868Z · seen in 2 run(s)

**Evidence:** light-home failed x18 and ran out of its time budget at 17:27:53; the 17:27:55 window walked 433 blocks in 2.5 min with 1 placed and 8 timeouts, between x -5967 and x -6054. Ozo's light-home log uses a 32-block grid, yet this walk runs about 90 blocks, and Ozo's torch-spacing step times out in the same far-west area (ozo-torch-spacing-step-timeouts).

**Suggestion:** Log the torch target chosen when light-home starts, and drop any target beyond the 32-block grid radius so the step places a torch or moves on.

## [MED] Smeo's climb stalls at a missing ladder cell near y 13 in column -6018,-2355
`smeo-shaft-stuck-at-gap` · repeated_failure · confidence high · first seen 2026-11-10T17:01:01.847Z · seen in 2 run(s)

**Evidence:** From 17:22:44 to 17:24:07 the climb logged 'climb not rising' 11 times at y 12.5-13.3 (feet in air, collided sideways), with four short falls, 20-26 jumps a minute holding cobblestone and none placed, and the oscillating flag caught 16-18 blocks walked in 30 s inside a 2.4-3.5 block box. It got past y 14 by 17:24:35; the same cell is the likely reason Ozo's climbs fail in this column (ozo-shaft-column-climb-loop).

**Suggestion:** Check the ladder cells at x -6018/-6019, z -2355, y 11 to 15, place any missing ladder, and have the climb stop its jump-and-place retries once 'climb not rising' repeats.

## [MED] Iron flat at 24 for about 40 min; goals thrash between wood and iron
`smeo-iron-woodstock-rearm` · no_progress · confidence med · first seen 2026-11-10T17:11:01.830Z · seen in 3 run(s)

**Evidence:** iron_ingot is unchanged at 24 since 16:47 (same as the 17:21 review), and the 17:23:01 THRASH alarm logged 3 goal switches in 2 min (grove, wood-stock, iron) with no item gain at (-6018,14,-2355). The 17:22:38 mine tunnel also mined 0 iron (nofloor), the same zero-ore result as Ozo's iron goal (ozo-iron-goal-nopath-no-ore).

**Suggestion:** After one zero-ore tunnel, have the iron goal pick a new depth or line, and log which goal wins each switch so the grove, wood-stock and iron thrash can be read.

## [LOW] Telemetry: task and held-item seconds exceed the 10-min window on both bots
`smeo-telemetry-seconds-over-window` · code_fault · confidence high · first seen 2026-11-10T17:11:01.830Z · seen in 3 run(s)

**Evidence:** last10min autopilot reads 659.4 s on Smeo and 659.2 s on Ozo in a 600 s window, and Smeo's held-item seconds add to about 658 s, so the 10-min counters double count.

**Suggestion:** Check the seconds accumulator for overlap across samples before trusting last10min task or held-item times.

## [LOW] no_tool flags bare-hand oak_leaves digs, which need no tool
`smeo-leaves-no-tool-flag` · other · confidence med · first seen 2026-11-10T17:21:01.868Z · seen in 1 run(s)

**Evidence:** 53 digs in 5 min were flagged no_tool, 46 of them oak_leaves dug bare-handed while a stone hoe sits in the bag; the example reads need 'hoe' with harvestOk true.

**Suggestion:** Take oak_leaves off the no_tool whitelist since leaves break by hand, or if a hoe is wanted for speed, select it before the tree-farm leaf digs.

## Detectors the reviewer wrote

Small non-blocking checks the reviewer turns judgement into. Enabled only after replaying them on captured telemetry (fires on the bad window, quiet on normal play). Source and origin: brain/state/detectors/.

- ENABLED `custom_horizontal_shuttle` (2026-11-10T16:51:01.874Z): Long east-west walks with no digging or placing. Smeo's light-home walks 70-90 blocks out and back along y 66-67 with no digs or places, then times out (16:50:36 window: six reversals in 2.5 min). oscillating needs a 3-block area and stuck needs no movement, so neither flags it; a driver should check which target each leg heads for and why it never arrives. Fired on 2/2 bad windows, 0/8 normal.
- rejected `ladder_climb_stall` (2026-11-10T12:01:01.687Z): fires on normal play: 1 of 8 normal windows (allowed 0)

## Recently resolved

- Light-home never arrives: long east-west legs and up-down shaft legs (`smeo-light-home-never-arrives`) resolved 2026-11-10T17:11:01.830Z: closed by the reviewer: gone, or merged into another finding
- Jumps in place on the shaft ladder at y 3-17 and fails pathing there (`smeo-ladder-climb-jump-in-place`) resolved 2026-11-10T17:01:01.847Z: closed by the reviewer: gone, or merged into another finding
- Light-home goal fails 15 times: it stands still, then walks long loops (`smeo-light-home-stands-at-home`) resolved 2026-11-10T17:01:01.847Z: closed by the reviewer: gone, or merged into another finding
- Ladder path still fails: noPath down from 81 to 6, stalls at y 12 (`smeo-nopath-loop-iron-target`) resolved 2026-11-10T16:51:01.874Z: closed by the reviewer: gone, or merged into another finding
- Iron pickaxe held while digging plain deepslate, one tier too high (`smeo-iron-pickaxe-on-deepslate`) resolved 2026-11-10T16:51:01.874Z: closed by the reviewer: gone, or merged into another finding
- No-tool flag fires on bare-hand oak leaves that harvest fine (`smeo-leaves-need-hoe-flag`) resolved 2026-11-10T16:51:01.874Z: closed by the reviewer: gone, or merged into another finding
- 13 oak saplings still unplanted; grove has not run since 16:20 (`smeo-grove-goal-stalls-unplanted`) resolved 2026-11-10T16:41:01.868Z: closed by the reviewer: gone, or merged into another finding
- Light-home still times out (6 in 5 min); its step blocked the loop 1.8 s (`smeo-light-home-goal-loops`) resolved 2026-11-10T16:21:01.849Z: closed by the reviewer: gone, or merged into another finding
