# Scenario suite baseline (2026-11-10)

Run: `node tools/scenarios/run.js pillar --runs 30 --bots TrialA,TrialB,TrialC,TrialD` against a vanilla 1.21.6 flat trial server (offline mode, four bots in separate regions).
Code: motor layer from PR #238 (`brain/motor`), plus a `legacy` variant that replays the old reach.js timing with plain `bot.placeBlock`.

| scenario | runs | pass | rate (95% Wilson) | notes |
| --- | ---: | ---: | --- | --- |
| pillar-yaw0 / 90 / 180 / 270 | 30 each | 30 each | 100% (89-100%) | 1x1 stone shaft, one block, head turned to each side |
| pillar-offcenter | 30 | 30 | 100% (89-100%) | feet 0.19 off the cell centre, diagonal yaw |
| pillar-climb6 | 30 | 30 | 100% (89-100%) | six blocks in a row |
| pillar-hand-swap | 30 | 30 | 100% (89-100%) | a sword is selected 5 ticks in; see caveat |
| pillar-legacy-yaw0 / 90 / 180 | 30 each | 30 each | 100% (89-100%) | the BEFORE picture (old timing, non-forced look) |

## What this does and does not say

- The motor does not regress on a real server: 240 of 240 runs. The lower bound of each cell is 89%, so this rules out a rate below about 90% but cannot show a difference between 95% and 100%.
- The legacy timing also passes on the flat vanilla world. So the live pillar failures are NOT reproduced by "flat ground, quiet server, 1x1 shaft". The remaining suspects are what this bench lacks: server lag (a tick behind), real terrain around the shaft, other layers touching the hand mid-jump, torches or water in the feet cell. Add each as a scenario when a snapshot shows it.
- `pillar-hand-swap` always passed with 0 refusals. The swap may land before the jump rather than during it, so treat the Held proof as unit-tested (test/motor.test.js), not field-proven here.
- Not built yet from the doc's twelve: ladder 30 down/up (tools/trial/ladder-lab.js measures it), craft after a bag desync, torch a 30-block tunnel, every-tool-tier dig, an autopilot minute with armor in the bag, bed on respawn, stash to the storage room, dig beside water and lava. The harness takes any of them as `{name, items, build, start, act}` in tools/scenarios/scenarios.js.
