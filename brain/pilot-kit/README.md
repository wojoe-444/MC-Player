# brain/pilot-kit

Small helpers for whoever drives the bot: Claude through the `ap-cmd.js` eval channel (Claude Desktop), the pilot REPL, or a model prompt.
A service-style module: it never creates scheduler tasks and never moves the bot by itself. Inspired by ideas in two open-source MCP servers, written from scratch.

## Wiring (integrator edit, one line)

Add `'pilot-kit'` to `MODULES` in `brain/index.js`. After the next restart `bot._kit` exists and the dashcam records by itself.

## What is in it

| file | what | how to call (eval channel) |
|---|---|---|
| `observe.js` | One snapshot plus only the events newer than a cursor. | `return bot._kit.observe({ since })` or `bot._kit.observeText({ since })` |
| `dashcam.js` | 10 Hz state recorder in a RAM ring buffer. Saves the last ~30 s to `brain/state/clips/` on death, a hit of 6 hp or more, health at 6 or below, or on request. | `bot._kit.dashcam.save('manual')` |
| `result.js` | One result format for any command. | `bot._kit.result.wrap(name, fn, { level })` |
| `place.js` | Place a block from whichever face works, walking closer if needed. | `await bot._kit.placeAnyFace({ pos: {x,y,z}, item: 'cobblestone' })` |
| `slice.js` | Vertical cross-section PNG, line of sight only. | `bot._kit.slice({ axis: 'auto' })` writes `brain/state/views/slice-latest.png` |
| `sight.js` | Honest line-of-sight helpers used by the others. | |

### Observation cursor

`observe({ since })` returns `{ cursor, vitals, pos, time, doing, inventory, nearby, events, dropped }`. Keep the returned `cursor` and pass it as `since` next time: you get only new events (`chat`, `task`, `park`, `damage`, `death`, `spawn`, `kicked`, `ate`) and `dropped: true` if you fell more than 400 events behind. The first call (no `since`) returns state and no events. `nearby` lists only hostile mobs, players and dropped items in line of sight within 24 blocks. Other modules can add events with `bot._kit.note(type, extra)`. Everything is plain JSON, so it works as the text output of the eval channel.

### Result envelope

```
{ ok, cmd, note, data?, error?: { code, message, hint? }, ms, level? }
```

`note` is the human line a skill returns today. Extra keys of a legacy `{ ok, note, ...extra }` result move to `data`. `error.code` is one of `NO_PATH NO_ITEM UNSAFE ABORTED TIMEOUT BAD_ARGS NOT_READY FAILED`, guessed from the message when the skill did not set one. `level` is optional (`primitive`, `skill`, `job`) so it can line up with a skill registry. `AbortError` is never swallowed. `result.line(r)` gives a one-line summary.

### Dashcam clip format v1

```
{ v:1, bot, reason, savedAt, hz, t0, t1, pos:{x,y,z},
  map:{ x0, z0, size:41, y0, palette:[block names], cells:[ paletteIndex*64 + (y - y0), or -1 ] },
  samples:[{ t, x,y,z, yaw, pit, hp, fd, h, a, m:[[name,x,y,z,id], ...] }],
  events:[{ t, type, ... }] }
```

`t` is milliseconds since `t0`. `h` is the held item, `a` is what the bot was doing (`task: step`), `m` is hostile mobs and players within 24 blocks. `map` is a top-down terrain snapshot taken when the clip is saved. Clips are written atomically (`.tmp` then rename), the newest 40 are kept. Cost: about 38 KB for 30 s, one sample every 100 ms from `physicsTick`, no rendering. Frames could be rendered from a clip afterwards by the first-person raycaster; see the evaluation in the PR description.

### No x-ray

`slice.js` and `observe.js` only report what the bot has a clear line of sight to. A buried ore stays hidden until it is exposed in view. `tools/pilot-kit-live.js` checks this against a real server.

## Tests

`node --test test/` runs the offline result tests. `tools/pilot-kit-live.js` (not in `test/` because it needs a server) runs against a throwaway server (see `.claude/skills/trial-server`): 27 checks across all five parts.
