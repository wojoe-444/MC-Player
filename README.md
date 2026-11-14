# MC-Player

**A primary purpose of this project is to derive great guides on how to build generic hillclimbers**: self-improving loops that get an agent or system better with nobody at the wheel. Minecraft is just a great place to learn what works. Start with [`docs/guides/hands-off-loop-guide.md`](docs/guides/hands-off-loop-guide.md): how to recreate the loop in any project, what went wrong building it, and what to study.

Mineflayer bots that play survival Minecraft (Fabric 1.21.6, LAN world) as independent players. Read `CLAUDE.md` first: it explains who the bots are and the house rules they play by.

## Layout

| Path | What it is |
|---|---|
| `join.js`, `run.js` | The bot (`join.js`) and its reconnecting supervisor (`run.js`). One codebase for every bot. |
| `brain/` | Scheduler and modules: `autopilot`, `nav`, `safety`, `combat`, `crafting`, `mining`, `build`, `chat`, `router`, `fastlane`, ... Start with `brain/INTERFACE.md` and `BRAIN.md`. |
| `bots/ozo`, `bots/smeo` | Per-bot config and starter state (see `bots/README.md`). |
| `scripts/start-bot.js` | Starts a bot from `runtime/<bot>/`. |
| `dashboard/` | Read-only live web viewer for both bots (`node dashboard/server.js`, http://localhost:8765). `web/` is the React source, `web/dist` the built copy it serves. |
| `arena/`, `eval/` | Combat arena harness and evaluations (results are not committed). |
| `plugin-eval/` | Experiments with mineflayer plugins (statemachine, pvp, collectblock). |
| `test/` | Unit tests for brain modules (`node --test test/`). |
| `tools/` | Offline helpers. |
| `docs/` | Design docs: `MEMORY-LOOP.md`, `DEPLOYER.md`, `HILLCLIMB-INSIGHTS.md`, and `guides/` (the generic hillclimber guides). |
| `vendor/` | Dependency manifest for two optional plugins (armor manager, auto-eat). |
| `legacy/minecraft-agent/` | What survives only from the older base-world bot; everything else there was identical to or older than the current code. |
| Root `*.md` | Notes: `HANDOFF.md`, `BRAIN.md`, `FEATURE-REQUESTS.md`, `XAERO.md`, `TOWER-PLAN.md`, `SURVIVAL-RESULTS.md`. Root `probe*.js`, `explore.js`, `xaero*.js`, `pov.js` are old standalone helpers. |

## Vocabulary

Short version; the full glossary is section 0 of `brain/INTERFACE.md` and the data behind it is `brain/taxonomy.json`.

- **Module** (`brain/<name>/`): one of seven kinds, declared in its `meta.json`: `reflex` (combat, breath, safety), `observer` (lag, hurt, survival, senses, dashboard), `interface` (chat, router), `planner` (autopilot, pilot), `job` (mining, excavation, build, treefarm, routines, lighting, villagers, husbandry, clearbox), `service` (nav, crafting, plugins), `policy` (mode).
- **Ladder**: primitive, skill, job, goal, planner. The autopilot builds goals out of jobs and skills, and skills out of primitives.
- **Profile** (`bots/<bot>/profile.json`): the bot's name, role (`hillclimber` or `assistant`), stance (`task` or `autonomous`), planner on/off and disabled modules. Replaces the separate `role.json`, `mode.json`, `think-off` and `disabled-modules.json` (those still work as a fallback).
- **Scheduler** and **priority bands**: one task at a time, higher priority preempts. **Reflexes** do not queue: they hold short leases on shared resources (`body`, `melee`, `hands`, `danger`) in `brain/reflexes.js`.

## Setup

```
npm install
cp bots/ozo/bot.local.env.example bots/ozo/bot.local.env   # then set MC_EMAIL
node scripts/start-bot.js ozo
```

## What is deliberately not in the repo

API keys (`brain/router/openrouter.key`, `brain/fastlane/openrouter.key`; put a key in the file or set `OPENROUTER_API_KEY`), Microsoft login caches (`auth-cache/`), `node_modules`, logs, screenshots, arena results, and everything under `brain/state/` (the bot's live memory, including `lessons.md`). All of it is listed in `.gitignore`. The repo is public, so keep it that way.
