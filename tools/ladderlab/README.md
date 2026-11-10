# Ladder lab

An offline test bench for everything the bots do on ladders: climbing, descending, mounting from the ground, stepping off, and **finishing an incomplete
ladder with the fewest blocks**. No Minecraft server and no login: it is the real `mineflayer-pathfinder` planner and executor and the real
`prismarine-physics` engine over a voxel world made of real `prismarine-block` blocks, in virtual time (50 ms per tick). It reuses the sim in
`test/nav.helpers.js` and adds an inventory, `bot.placeBlock` and `bot.dig` with the vanilla rules that matter on a ladder
(`world.js`: reach 4.5, a clear line to the face, a ladder needs a full solid block behind it and a side face, nothing is placed into the player's own
body, digs take ticks and return drops).

```
node tools/ladderlab/run.js                 # every scenario
node tools/ladderlab/run.js tower           # scenarios whose name contains "tower"
node tools/ladderlab/run.js --plain         # baseline: the navigator with ladder work switched off
node tools/ladderlab/run.js --json          # full metrics per scenario
node --test test/ladders.test.js            # the same scenarios plus unit tests and a randomized-gap fuzz
```

## Scenarios (`scenarios.js`)

Ground is stone at y=63; the ladder column is (5, 0) on a wall at z=-1. Each fixture says what it is for in `note`.

| group | fixtures | pass means |
|---|---|---|
| ladder in stone | `shaft-up`, `shaft-down`, `jump-onto-1-shaft`, `shaft-gap-2` | arrives; for climbs, no more than 1 block of travel against the direction of the trip |
| ladder free in the air | `tower-up`, `tower-down`, `tower-from-side`, `open-sides-gap` | same |
| open to one or both sides | `side-gaps-left/right/both`, `ledge-down-side`, `exit-side` | same |
| jump up onto / step off | `jump-onto-1`, `bottom-gap-1`, `bottom-gap-2`, `exit-side`, `down-gap-2` | same |
| incomplete (gap at top, middle, bottom, open wall) | `top-short-1..3`, `mid-gap-1`, `mid-gap-3-spare`, `wall-open-1`, `wall-open-tall` | arrives with **no more blocks placed than `optimal`** (ladders and backing blocks both count), without bobbing |
| not enough material | `short-of-ladders` | does **not** arrive, places nothing, does not bob: an honest refusal |

`optimal` is worked out by hand in the fixture, not by the code under test: every column cell from the one above the floor cell up to the one below the exit
level needs a ladder (the first is a jump away from the ground), and a cell whose wall is open needs one more block to hang on. A bot standing on a rung
cannot jump, and the 0.4 block of momentum at the top of a rung does not reach a ledge.

Metrics per run: `arrived`, `ticks`, `placed` (all blocks), `backtrack` (blocks of vertical travel against the direction of the trip, which is what bobbing
is), `left` (inventory at the end), `err`.

## Adding a scenario

```js
add({ name: 'my-case', kind: 'complete', start: [5.5, 64, 3.5], goal: [5, 76, -1], inv: { ladder: 4 }, optimal: 2,
      build: s => tower(s, 76, { skip: [70, 71] }), note: 'what this is for' })
```

`tower(s, T, { skip, from })` is a ladder on a free standing stone tower with its top at standing level `T`; `shaft(s, T, { skip, from, open })` is a closed
1x1 shaft in stone; `s.set / s.fill / s.clear` edit any block. Run it with `node tools/ladderlab/run.js my-case`.

## What it found

The live bots rode a ladder up, fell off its end, slid down and rode up again (the telemetry flagged a bot cycling between y50 and y63 in one column).
Reproduced here as `top-short-1` (19 swings, never arrives). Cause: the library's `getMoveUp` lets a path rise from a climbable cell into the empty cell
above the top rung; nothing holds the bot there. `brain/nav/movements.js` now drops that move, so a ladder that does not reach is a plain "no path"; then
`brain/nav/ladders.js` finishes it by hand when the bag has ladders, and `stuck.js` has a `ladder-loop` backstop for any other way into the same cycle.

## Limits

It is a model: prismarine-physics is not the Java client (steps onto ledges while on a rung, fast falls and server-side ladder checks are as faithful as
that engine), crafting is not modelled (the inventory is given), and a placement is a call, not a packet round trip. Run the real thing before trusting a
change that passes here.
