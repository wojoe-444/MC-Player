# Review findings: Smeo444

_Updated 2026-11-10T17:28:50.800Z by claude-haiku-5-5. Status: **issues**. Walking 37 to 50 blocks off the shaft on light-home and timing out; its shaft climb also stalled at y 12 to 14 around 17:23. Iron has sat at 24 since 16:47, so Phase 2 is stalled on iron._

Written by the spectator reviewer (reviewer/). Read by the driver thread and shown in the Bot Dashboard app. Never posted to game chat.

## [HIGH] Smeo's torches at x -6027 and -6029, y 67, sit two blocks apart
`smeo-grove-torch-row-two-apart` · rule_violation · confidence high · first seen 2026-11-10T16:21:01.849Z · seen in 8 run(s)

**Evidence:** torch_spacing has held since 16:36:35 (179 refreshes). Four torches are closer than the two-air rule and the count is unchanged since the 17:21 review; the nearest pair is (-6027,67,-2326) beside (-6029,67,-2326), and the flag names autopilot as the placer.

**Suggestion:** Make the autopilot torch step check the two-air rule before each place, then remove one torch from each flagged pair while the row stays lit.

## [HIGH] Light-home walks 37 to 50 blocks off the shaft and times out
`smeo-light-home-torch-stall` · repeated_failure · confidence high · first seen 2026-11-10T17:21:01.868Z · seen in 2 run(s)

**Evidence:** 11 timeouts in 5 min, last at light-home, and 'light-home failed x18' with 'time budget used up' at 17:27:53. The walks run from x -5967 to -6054, 50 blocks east and 37 west of the shaft, and the last 10 min show 1155 blocks walked and 19 placed; Ozo's light-home log names a 32-block grid radius.

**Suggestion:** Check how light-home picks its next torch cell and keep targets inside the 32-block grid; a cell it cannot reach in its budget should be dropped, not walked to and back.

## [MED] Smeo's climb stalls at y 12 to 14 in the shaft, jumping with cobblestone
`smeo-shaft-climb-stalls-y12-14` · stuck · confidence med · first seen 2026-11-10T17:28:50.800Z · seen in 1 run(s)

**Evidence:** Between 17:22:59 and 17:24:13 the log shows 8 'LADDER climb not rising' lines at y 12 to 14 (feet air, collidedH true) and three 'hurt fall -1' at (-6019,13-14,-2355). It jumped 20 to 26 times in a minute holding cobblestone and placed 0, while Ozo climbed y 10 to 25 in the same column cleanly at about 17:21.

**Suggestion:** Check the ladder and wall cells at x -6019 and -6018 for y 12 to 14, since Smeo's ladder count fell from 2 to 0 since 17:21 and the placed ladders may be off the column; have the climb step re-centre on the ladder before it jumps.

## [MED] Iron flat at 24 for 41 min; y -4 tunnels mine no iron
`smeo-iron-woodstock-rearm` · no_progress · confidence high · first seen 2026-11-10T17:11:01.830Z · seen in 3 run(s)

**Evidence:** iron_ingot 24 has not moved since 16:47 and the y -4 tunnels at 17:06, 17:08 and 17:20 each mined 0 iron; the day 34 line reads 'iron mined 0, ingots 0' at 17:25:16. Ozo's ingots are flat at 14 since 16:31 with the same zero-iron day line.

**Suggestion:** After one zero-ore tunnel, have the iron goal pick a new line or depth instead of re-running y -4, and log which goal wins each switch.

## [LOW] Telemetry: task seconds exceed the 10-min window on both bots
`smeo-telemetry-seconds-over-window` · code_fault · confidence high · first seen 2026-11-10T17:11:01.830Z · seen in 3 run(s)

**Evidence:** last10min autopilot reads 659.4 s for Smeo and 659.2 s for Ozo in a 600 s window; Smeo's held-item seconds also add to 658 s.

**Suggestion:** Check the seconds accumulator for double counting across overlapping samples before trusting last10min task times.

## Detectors the reviewer wrote

Small non-blocking checks the reviewer turns judgement into. Enabled only after replaying them on captured telemetry (fires on the bad window, quiet on normal play). Source and origin: brain/state/detectors/.

- ENABLED `custom_horizontal_shuttle` (2026-11-10T16:51:01.874Z): Long east-west walks with no digging or placing. Smeo's light-home walks 70-90 blocks out and back along y 66-67 with no digs or places, then times out (16:50:36 window: six reversals in 2.5 min). oscillating needs a 3-block area and stuck needs no movement, so neither flags it; a driver should check which target each leg heads for and why it never arrives. Fired on 2/2 bad windows, 0/8 normal.
- rejected `ladder_climb_stall` (2026-11-10T12:01:01.687Z): fires on normal play: 1 of 8 normal windows (allowed 0)

## Recently resolved

- no_tool flags bare-hand oak_leaves digs, which need no tool (`smeo-leaves-no-tool-flag`) resolved 2026-11-10T17:28:50.800Z: closed by the reviewer: gone, or merged into another finding
- Stuck about 35 s on the shaft ladder under the missing cell at 16:56 (`smeo-shaft-stuck-at-gap`) resolved 2026-11-10T17:11:01.830Z: closed by the reviewer: gone, or merged into another finding
- Light-home never arrives: long east-west legs and up-down shaft legs (`smeo-light-home-never-arrives`) resolved 2026-11-10T17:11:01.830Z: closed by the reviewer: gone, or merged into another finding
- Jumps in place on the shaft ladder at y 3-17 and fails pathing there (`smeo-ladder-climb-jump-in-place`) resolved 2026-11-10T17:01:01.847Z: closed by the reviewer: gone, or merged into another finding
- Light-home goal fails 15 times: it stands still, then walks long loops (`smeo-light-home-stands-at-home`) resolved 2026-11-10T17:01:01.847Z: closed by the reviewer: gone, or merged into another finding
- Ladder path still fails: noPath down from 81 to 6, stalls at y 12 (`smeo-nopath-loop-iron-target`) resolved 2026-11-10T16:51:01.874Z: closed by the reviewer: gone, or merged into another finding
- Iron pickaxe held while digging plain deepslate, one tier too high (`smeo-iron-pickaxe-on-deepslate`) resolved 2026-11-10T16:51:01.874Z: closed by the reviewer: gone, or merged into another finding
- No-tool flag fires on bare-hand oak leaves that harvest fine (`smeo-leaves-need-hoe-flag`) resolved 2026-11-10T16:51:01.874Z: closed by the reviewer: gone, or merged into another finding
