# brain/combat: tick-based combat reflex layer (ported from the arena benchmark)

`reflex.js` = `arena/combat_v3.js` with the best-on-both-benchmarks defaults baked in. `threat.js` = swappable threat assessment (line of sight, reachability; glass blocks arrows and mobs).

```js
const reflex = require('./brain/combat/reflex')
const combat = reflex.create(bot, { yieldIdle: true /* leave controls to navigation when nothing can hurt us */, idleSprint: false },
                             { routeDir: () => unitVectorToNextWaypointOrNull /* optional */ })
// each tick of your own loop: if (combat.engaged()) bot.pathfinder.stop() else resume the goal
combat.stop()  // clears controls and drops the shield
```

Defaults (see `DEFAULTS`): sprint-hit with 10-tick swings (no crit jumps), shield up vs skeletons with line of sight, kite from 5 mobs, encirclement escape from 6 mobs (swarm-only: it fights like plain fastswing until a real pack forms), wall-aware steering, glass blocks line of sight, `organize` on entry (armor, shield off-hand, sword in hand, bow/food in hotbar), eating and creeper rules as in the arena. `fireTrap` is OFF.

Rules for Walter's world: never digs/places, never chats, no slash commands. Keep the bot away from lava buckets in hand (this layer only swaps to sword/bow/food/shield). Integrate at SAFETY priority; hand movement back to navigation with `yieldIdle` + `engaged()`.

Numbers and the full story: `arena/RESULTS.md`. Not tested live in the base world yet; benchmark runs are superflat arena and the obstacle course only.

## Benchmark numbers for these defaults
Walled arena W7: 36.1s mean survival (fastswing 13.7s, 2.6x). Obstacle course difficulty 1: 63% mean progress, 2 of 6 finished. Alternatives: `openMin: 14` (kite/escape only with open space around) trades arena survival (22s) for course progress (83%, 3 of 6 finished); plain fastswing + wallAware + glassBlocksLos gets 13.7s / 89%.
