# Combat arena: what we built and what we learned

Everything lives in `Minecraft-Agent/arena/`. Live scoreboard: `node arena/dashboard.js` then http://localhost:8765.
Run it all: `node arena/harness.js` (needs the arena LAN world with cheats on; same Microsoft login as the base bot, so the base bot must be off).

## The system
- **Harness** (`harness.js`): one bot, reset by command (creative, clear, kit, time, kill mobs, survival), scripted mob waves, job queue (`queue/*.json`), sequential tests against an incumbent (stop on p<0.05 win / clear loss), results in `results/trials.jsonl`, per-run flight recorder in `results/traces/`.
- **Combat layer** (`combat_v3.js`, ported to `brain/combat/reflex.js`): runs every physics tick, no LLM in the loop. Threat detection is a separate swappable file (`threat.js`, line-of-sight and reachability aware).
- **Score**: one number per run from four measures (log survival, log kills/min, -log damage/s, log kills per damage), weighted by their first principal component, frozen per eval, minus 0.05 per HP of damage taken from creeper blasts. Course evals score progress % + finish bonus - damage.
- **Brain x eval** are separate dimensions on the dashboard; brains never run on an eval get a clearly marked estimate.

## Evals
| Eval | What | Benchmark result |
|---|---|---|
| Original waves | wave every 10s, growing | fastswing ~89s |
| H7 (open arena) | steady pressure: 14 mobs at 2s then 4 every 2s, ceiling 50 | fastswing 14s |
| W7 (walled arena) | same, inside a 60x100 terracotta barrier | fastswing 16s |
| Course difficulty 1 | white block to red block, 28 mobs spread evenly, Score = progress | fastswing 75% (stalls at the glass tower, survives) |

## What improved things (in order of impact)
1. **No crit-jump, sprint-hit instead** (v5a): 85s vs 40s on the original eval; swings/s 0.49 -> 0.83, damage/s halved.
2. **10-tick swings** (fastswing, v5b): small, significant on the composite (p=0.013).
3. **Shield up whenever a skeleton has line of sight** (v3a): arrow damage 30+ HP -> ~8 per run.
4. **Kite**: keep facing and hitting the nearest target but steer away from the pack with back/strafe keys once 3+ mobs are close: H7 14s -> 20s (p=0.031).
5. **Encirclement escape** (sprint through the open sector when mobs hold 3 of 4 quadrants): 20s -> 30s. Proactive variant (2 quadrants, 3 mobs, 1s cooldown, 1.5s burst, 14-block look-out): 67s in the open arena (4.7x fastswing).
6. **Organize on fight entry**: shield to off-hand, sword in hand, armor on, bow/food in hotbar. Without it a scrambled inventory meant the shield was never raised in 5 of 6 runs.
7. **Wall awareness** (headings blocked within 7 blocks penalised, jump only at one-block steps): deaths within 3 blocks of the wall 12/14 -> 1/10. Survival effect small in the arena, expected to matter more in real terrain.
8. **Glass blocks line of sight** for threat detection: mobs behind glass cannot shoot or reach, so they must not hold the bot in combat.

## What did not help (don't redo)
Eating more or "smart" eating (HP stays full until the swarm arrives, then damage outpaces any potato), fire trap, creeper shield-only-when-alone, creeper flee, push-away evade (before adjacency), weakest-target-first, rear-target-first, gap-aware kite, no-bow (tied), aggro-only bow, hold ground, no strafe, no back-step, 8-tick swings, melee shield.

## Surprises from transfer
- The open-arena champion (proactive escape) is **worst on the course** (12% progress): escapes pull the bot off the route into side rooms.
- Plain fastswing is best on the course (75%) but worst in the arena (16s).
- Walls pin the bot: the open-arena champion drops from 67s to 40s inside the barrier, and 12 of 14 deaths are within 3 blocks of the wall.
- **Best on both (final pick)**: fastswing + kite from 5 mobs + encirclement escape from 6 mobs + wall-aware + glass line of sight + organize. Walled arena 36.1s mean (fastswing 13.7s), course difficulty 1: 63% mean progress, 2 of 6 finished.
  Alternatives (8 runs W7 / 6 runs course): kite3+escape 33.7s / 61%; `openMin 14` (kite/escape only with open space) 22.1s / 83%, 3 of 6 finished; plain fastswing+wall+glass 13.7s / 89%. Kiting brains die in the course's top corridor (~31%): the whole pack converges there and kiting drags it along; fighting at the chokepoint works better.

## Known issues
- Course navigation (fixed 2026-10-27): the glass tower needed explicit moves (walk into the roof hole, sink with sneak, walk out along the chamber floor). No-mobs runs now finish 3/3 in 50-65s. Surviving runs on difficulty 1 are slow (100-240s), so the course cap is 240s.
- Course route-pull (`routeWeight`) was tested and did not beat the plain brain.
- Single-run screens mislead badly (the arena's first 122s crowd-evade run was luck). Trust only multi-run verdicts.

## Rules for the live bot
This layer never digs or places blocks (the fire trap is off and needs flint), never chats, never uses slash commands. Arena commands (`/give`, `/tp`, `/summon`) are harness-only.
