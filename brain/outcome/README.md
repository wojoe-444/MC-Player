# brain/outcome: does a build do what it is for?

Walter, 2026-11-11: the underground mob farm was built, inspected with 0 faults and made nothing for a day. The world was on **Peaceful** (`level.dat` `Difficulty: 0`),
so no hostile mob could spawn anywhere. Every part of the improvement loop compared the farm with its *design*; none compared it with its *purpose*.

```
registered build  ->  counts the time it could have worked (bot online, inside 128 blocks) and its output  ->  verdict (expect.js)
     -> brain/state/outcome.json, [outcome] line in lessons.md, journal event `outcome` (salient)
     -> planner state `outcome_problems`, roadmap 2.8.mobfarm (not done while blocked/overdue), reviewer evidence `buildOutcomes`
     -> reviewer/lib/orders.js candidate `outcome-<build>` (kind `human` when only a person can change it) -> the dream opens the order in code, no model asked
```

States: `warming` (grace, 3 h for the mob farm, 8 h tree farm, 24 h pens), `producing`, `overdue` (past grace with no or a quarter of the bar's output),
`blocked` (a precondition is false: Peaceful, doMobSpawning off). `bot.game.difficulty` is what the bot can read from its login packet; the game rule cannot be read
by a regular player, so `mobSpawning` stays unknown unless a build learns it another way.

A broken build is journaled again every 6 h, because the work-order loop only reads the last 24 h and an order whose problem is absent for 12 h is closed as quiet.

## Adding a build kind

1. a spec in `expect.js` `SPECS` (label, unit, grace hours, the least per hour that counts as working) and optional `GATES` (preconditions the bot can read)
2. a `get()` for its cumulative output in `builds()` in `index.js` (a counter that already exists is better than a new one)

## The other half: spawn competition

Even on Easy this farm gets about 0.35% of the spawn chances: `tools/spawn-census.js --save <World> --x -6030 --y 59 --z -2355 [--player x,y,z]` reads the
save's block light and counts every dark, spawnable cell within range. 164 pads against 51,430 others (75% deep caves), and 0% while a bot is within 24 blocks of the pads.
The bots cannot see this (it needs the rock), so it is a tool for people and agents, not a sense.
