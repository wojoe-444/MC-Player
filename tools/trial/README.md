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
