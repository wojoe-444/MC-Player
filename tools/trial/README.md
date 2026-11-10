# tools/trial

## pillar-look-lab.js

Measures the client-side half of the pillar-refusal hypothesis (insights doc, Haiku check 1): mineflayer 4.39's `bot.placeBlock` awaits a
non-forced `lookAt` before it writes `block_place`, and that wait can be up to 21 ticks, long enough for the feet to drop back into the
target cell. A vanilla server refuses a block whose cell still overlaps the player, judged from the last position packet it received.

For each run it jumps the way `brain/nav/reach.js` pillar() does and records the yaw the head had to turn, the ticks from the call to the
`block_place` packet, the last position the client had sent, and whether that position is still inside the target cell ("would refuse").

    npm i --no-save flying-squid@1.12.0     # a JS server to join; not a repo dependency
    node tools/trial/pillar-look-lab.js --runs 30 --port 25612 --out /tmp/pillar-lab.jsonl

Variants: A current timing + `placeBlock`; B `forceLook: true`; C place as soon as the feet clear +1.0; D both.
Scenarios: `first` (random head yaw, first block of a climb), `later` (head already at the face yaw), `sidestep` (offset moved 0.3).

Result of one run of 30 per cell (2026-11-10, flying-squid 1.21.4 superflat, seed 12345):

| scenario | variant | runs | packet sent | mean yaw to turn (rad) | mean ticks call->packet | max ticks | would refuse |
|---|---|---|---|---|---|---|---|
| first | A | 30 | 30 | 1.51 | 10.57 | 21 | 19/30 |
| first | B | 30 | 30 | 1.62 | 0 | 0 | 0/30 |
| first | C | 30 | 30 | 1.73 | 12 | 21 | 17/30 |
| first | D | 30 | 30 | 1.61 | 0 | 0 | 0/30 |
| later | A | 30 | 30 | 0.17 | 1.67 | 9 | 1/30 |
| later | B | 30 | 30 | 0.14 | 0 | 0 | 0/30 |
| later | C | 30 | 30 | 0.16 | 1.57 | 5 | 0/30 |
| later | D | 30 | 30 | 0.12 | 0 | 0 | 0/30 |
| sidestep | A | 30 | 30 | 1.5 | 10.5 | 21 | 22/30 |
| sidestep | B | 30 | 30 | 1.42 | 0 | 0 | 0/30 |
| sidestep | C | 30 | 30 | 1.64 | 11.4 | 21 | 14/30 |
| sidestep | D | 30 | 30 | 1.57 | 0 | 0 | 0/30 |

Limits: the refusal is computed from the vanilla overlap rule, not observed (flying-squid accepts everything), and the start yaw and in-cell
offset are modelled. The vanilla half needs the `trial-server` skill (Mojang jar) and should confirm real refusal rates per variant.

## Results on the real 1.21.6 server (2026-11-10)
- pillar-look-lab.js --vanilla: 360 of 360 observed server refusals match the model `lastSentY < cell.y + 1`; forced look removes the wait.
- tick-sprint-lab.js: `/tick sprint 60000t` gives about 300x server ticks, bot speed in real time is unchanged. Not a way to compress runs.
- ladder-lab.js (30-block shaft, 10 up + 10 down): 2.38 blocks/s up, 3.0 down, 0 reversals, 0 server corrections, 0.1 stalled samples. A clean shaft is not the problem.
- packet-gate-lab.js (5 min, real join.js, iron/diamond tools and armor in the bag, log-only gate): 23 tool_tier events, 0 armor, 0 lava.
  All tool_tier events come from `S.equipFor` in brain/autopilot/skills.js (picks the fastest tool, i.e. the highest tier, not the minimum).
  The armor path in plan.js:267 is guarded by NO_ARMOR and did not fire; asking "put on your armor" in chat produced no armor packet.

## mobfarm-lab.js and mobfarm-build-lab.js (mob farm, ROADMAP Phase 2 item 8; design in brain/mobfarm/README.md)

Both need the vanilla trial server (`node .claude/skills/trial-server/scripts/server.js start --minutes 60`, op'd TrialA).

* `mobfarm-lab.js` builds the farm shape from `brain/mobfarm/geometry.js` with `/fill` and checks it in vanilla physics: water settles (hole and column dry, last cell beside
  the hole at level 1), zombies put on the pads wash into the hole, landing HP at the configured drop, the bot kills landed mobs through the slit, drops reach the chest.
  `--drop N --zombies N --secs N`.
* `mobfarm-build-lab.js` runs the real build routine (`brain/autopilot/mobfarmbuild.js`, with the real skills and ladder registry code) as a survival bot in solid stone
  and then works the finished farm with zombies and the existing kill routine. About 10 minutes for the build. `--from chamber|platform|column|fit|water` resumes on the
  world the last run left (same phase names as the routine), `--zombies N --secs N` for the test at the end.

Result of the last full run (2026-11-10, flat world, stone block, shaft 40 deep): built in 630 s, 379 platform cells + 22 column + chamber, nothing dug outside the plan,
trench fully wet, column dry, no crafting table left behind, health 20 all the way; zombies fell into the pocket and the kill routine hit them through the slit.

## lightup-lab.js (light-up task for the mob farm; design in brain/lightup/README.md)

    node .claude/skills/trial-server/scripts/server.js start --minutes 60
    node tools/trial/lightup-lab.js [--zombies 6] [--creepers 0] [--static 0 [--static-first]] [--abort-hp H] [--no-check] [--sample 90] [--out result.json]

Builds a stone block with a sealed farm platform, a rest corridor, four chambers with tunnels, a staircase down to a lower chamber, a sealed pocket and two existing
torches, runs the real `brain/autopilot/lightup.js` as a survival bot with the real combat reflex, and judges light with the SERVER (datapack predicate `lab:dark`,
light 0, written to `.trial-server/world/datapacks/lab/` by hand: `pack_format` 80, `data/lab/predicate/dark.json` = `location_check` with `light: {light: {min: 0, max: 0}}`,
then `/reload`; the lab does the `/reload`, you create the pack once). Needs the world folder to exist (start the server once). Exit 0 means: no death, torch spacing kept, nothing
lit on the platform, sampled cells the model called dark were dark in vanilla before, lit ones are lit after.

Results (2026-11-10, flat world, stone block): 764 dark spots (30 more in a sealed pocket) lit with 9 torches, 63 to 121 s per run, 0 deaths. The mobs were killed by the
combat reflex, not by the task; the dance branches (postpone, fall back) are exercised by the frozen-creeper run, the fall back itself by one earlier run.

| zombies | creepers | frozen creeper at a spot | min health | postponed | dark left | vanilla: sampled lit cells still dark | platform dark after |
|---|---|---|---|---|---|---|---|
| 6 | 0 | 0 | 17 | 0 | 0 | 0 of 90 | 25 of 25 |
| 10 | 3 | 0 | 13.2 | 0 | 0 | 0 of 90 | 25 of 25 |
| 0 | 0 | 2 (route spots) | 20 | 0 | 0 | 0 of 90 | 25 of 25 |
| 0 | 0 | 1 (the first spot) | 20 | 1 (done last) | 0 | 0 of 90 | 25 of 25 |
| 10 | 2 | 0 (`--abort-hp 19`, health regenerated before the check) | 17 | 3 | 0 | not checked | not checked |

Before each run, 90 of 90 sampled model-dark cells were dark in vanilla too (the scan does not invent spots); the 30 cells of the sealed pocket stayed dark (control).
Two lab geometry mistakes found on the way (a stair whose steps are 2 high cannot be walked off; `/fill` is capped at 32768 blocks) are fixed in the lab.
