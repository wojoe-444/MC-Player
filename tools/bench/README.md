# Speedrun bench

Small bounded test arenas on a **vanilla 1.21.6 server in offline mode** (the Mojang jar the trial-server skill uses). One bot, the real `join.js` + `brain/`, plays the
first hour from a fresh start; the world is then reset by copying the identical starting snapshot. The point is to measure "first hour of progress" (ROADMAP phase 1 to
early phase 3) and hillclimb it faster than a live-world session allows.

```
node tools/bench/bench.js list
node tools/bench/bench.js make plains-1            # once per arena (about 2 to 8 minutes, a seed search), then it is a folder copy
node tools/bench/bench.js run plains-1 --minutes 60 --label "baseline"
node tools/bench/bench.js run forest-1 --minutes 10 --code ../MC-Player-other-checkout    # score another checkout's brain
node tools/bench/bench.js score <run id>           # re-score a finished run after a scoring change
node dashboard/server.js                           # Test arenas page: arena maps, run table, per-run milestones and path
```

Needs Java, Node 18+, the jar (`.claude/skills/trial-server/scripts/server.js setup` downloads and sha1-checks it; or `BENCH_JAR`). Only one trial server runs at a time (shared
registry with the trial-server skill). Ports 25620 (game) and 25621 (RCON), `BENCH_SERVER_PORT` to move them. Everything lives in `.bench/` (git-ignored, rebuildable).

## How an arena is made (`arenas.json`)

* **Biome.** A datapack in `world/datapacks` replaces the `minecraft:normal` world preset with an overworld whose biome source is `minecraft:fixed`: vanilla terrain noise, vanilla
  features, but every column is one biome (plains, forest, taiga, desert, snowy plains, ...). Leave `biome` out for a natural mixed-biome seed.
* **Seed search.** Terrain shape comes from the seed alone, so `make` generates a 192x192 area per seed, ranks every 128x128 window (land share, tree cover, relief, read from the
  chunk heightmaps in the region files) against the arena's `want`, and takes the first seed with a window that fits (`--tries N`, default 8; else the best one). The chosen seed, centre and spawn
  are written back to `arenas.json`, so the arena is the same on any machine.
* **Bounds.** World border 128x128 around the window, spawn on the nearest dry flat 5x5 without trees, `spawnRadius 0`, clear weather fixed, time 0 (dawn), mob spawning on.
* **Snapshot.** The window is pre-generated, forceloads removed, saved to `.bench/snapshots/<arena>/world` with `meta.json` (block counts of the window) and `preview.json` (top-down map for the dashboard).
  The datapack travels inside the snapshot world.

## How a run works

1. **Reset**: copy the snapshot world into `.bench/runs/<id>/server/world` (about a second).
2. Start the server, `/tick freeze` (the world waits), start the bot in `.bench/runs/<id>/bot` (a copy of `join.js`, `run.js`, `brain/`, `vendor/`, the ozo profile and seed files **minus** the
   live-world zone and death memory; the work zone is the arena). `offline-preload.js` forces host, port, name and offline auth on `mineflayer.createBot`; nothing else is changed.
   The bot is **not op**: no cheats, same as the live world.
3. When the bot stands at the spawn: `time set 0`, `/tick unfreeze`, clock starts.
4. Every 3 s over RCON (no second player in the world): position, health, food, whole inventory, deaths (a `deathCount` scoreboard objective), world time. `samples.jsonl`.
5. Stop: bot process tree killed (only the PID started here), server stopped cleanly (world saved), then the server's own files are read: `stats/<uuid>.json` (mined, crafted, picked up, killed, used) and
   the region files again, diffed against the snapshot's block counts (what the bot **placed**: tables, furnaces, chests, beds, torches, doors, ...).
6. `result.json` and one line in `.bench/results.jsonl`.

## Score (`lib/score.js`)

* **Points**: weighted milestones, phase 1 (log, table, wooden pickaxe, cobblestone, stone pickaxe, stone sword, furnace, coal, torch, food, bed = 15), phase 2 (raw iron, iron ingot, bucket, iron pickaxe, shield = 15), phase 3 (chest, diamond = 7).
  A milestone counts when the item is first seen in the bag (time recorded), or crafted per the stats, or its block was placed. Points at 10/20/30/45/60 minutes are kept (`pointsAt`).
* **Per player-hour**: points, deaths, stall seconds (30 s stretches within 1.5 blocks and no change in the bag; `stallDaySeconds` leaves out the night, where sheltering is not a stall), items picked up, blocks mined, items crafted, blocks walked.
* **Structures**: what the run added to the arena, from the saved world, not from the bot's report.

## Differences from the live world

* Vanilla server, **no Fabric mods** (no Serene Seasons, Xaero, or other mods in the live world); no Microsoft login, offline UUID; the bot's name is `OzoBench`.
* 128x128 border: the bot cannot travel, trade for distance, or find a village, cave system or ore far away. Underground inside the border is real (caves and ores generate normally under the window), but small.
* One forced biome: no rivers, beaches or biome edges; animals and mobs are those of that biome. Terrain noise is vanilla, so a "plains" arena may be hilly if the seed is.
* Difficulty `normal` by default (`--difficulty hard` to match). World time starts at dawn; the first night is at about 10 real minutes (`/tick` does not change that, see below).
* The server runs on the same laptop as everything else at below-normal priority with a view distance of 8; a heavily loaded machine lags the server and the bot together.
* Runs from one snapshot are **not identical**: mob spawns, random ticks and the bot's own timing differ. Treat one run as one sample, repeat for a comparison.

## /tick sprint

The bot's walking, digging and crafting are driven by its own 20 Hz client loop and by real-time waits in the brain, so a faster server does not make it faster: see `tools/trial/README.md`
(`/tick sprint` gave about 300x server ticks, bot speed in real time unchanged) and the measurement at the bottom of this file.

## First results (2026-11-11, baseline brain at main `64e479b`, planner off, normal difficulty, one 60-minute run per arena)

Same terrain in both arenas (seed 4106, centre -32,32, 95% land); only the forced biome differs.

| arena | points (of 38) | deaths | stalled | milestones (first in the bag) | notes |
|---|---|---|---|---|---|
| plains-1 | 12, all by minute 8 | 23, all at night (13 in night 1 from 12:42, 10 from 55:00) | 46% (16 minutes motionless at 5 HP, from 39:00) | log 0:24, table 0:42, wooden pickaxe 0:45, cobblestone 1:22, furnace 2:43, stone pickaxe 4:17, stone sword 5:20, torch 6:44, food 8:14 | no bed, coal or iron; 480 items picked up, 239 blocks mined |
| forest-1 | 13 | 2 (one by day at 23:60, one at 51:03) | 44% | log 0:27, wooden pickaxe 1:06, table 1:09, cobblestone 1:52, stone pickaxe 2:40, stone sword 2:58, furnace 3:04, food 4:19, torch 5:23, coal 11:39 | dug to y 23 by minute 42; 140+ cobblestone and 36 torches by minute 18; no bed, no iron; 790 items picked up, 785 blocks mined |

Reading: phase 1 is quick in both (stone tools within 3 to 5 minutes), then nothing. Plains falls into a night-time death loop (it respawns at the arena spawn with an empty bag); the forest bot mostly survives but
idles for about 44% of the hour and still never reaches a bed or iron. `points` is flat for the last 50 minutes in both.

One 11-minute run in plains was cut short because the bot supervisor (`run.js`) was killed from outside (exit code -1, cause unknown, not reproduced in the two full runs since); the bench now restarts a dead supervisor (up to 5 times, noted in `result.json`).
