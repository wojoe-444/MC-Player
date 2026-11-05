# Per-bot config

Both bots run the same code (`join.js`, `run.js`, `brain/` at the repo root). Only config and state differ.

| Bot | In-game name | Role | Viewer port |
|---|---|---|---|
| `ozo` | OzoGo444 | independent survival player (hillclimb) | 3007 |
| `smeo` | Smeo444 | personal assistant on a fixed routine (birch tree farm, base upkeep) | 3008 |

Each `bots/<bot>/` holds:

- `bot.json`: display name, viewer port, extra env vars (Smeo sets `MC_FRESH_MCA_TOKEN=1`, which makes `join.js` drop its cached Minecraft token at start and fetch a fresh one from the cached Xbox tokens).
- `bot.local.env.example`: copy to `bot.local.env` (gitignored) and set `MC_EMAIL`, the Microsoft account the bot signs in with. Optional `MC_PORT` for the LAN port.
- `profile.json`: who the bot is (name, role, stance, planner on/off, steps, disabled modules). `scripts/start-bot.js` copies it to `brain/state/profile.json` of the runtime folder the first time; after that the bot owns that copy (the stance switch writes to it). A runtime folder that still has the old `role.json` / `mode.json` / `disabled-modules.json` and no profile keeps using them.
- `seed/`: starter files (`zone.json`, `site.json`, `safety-tuning.json`, ...) copied into the runtime folder on first start and never overwritten after that.

## Running

```
npm install
node scripts/start-bot.js ozo      # or smeo
```

The bot's cwd is `runtime/<bot>/` (gitignored): logs, `auth-cache/` (Microsoft login), `brain/state/`, chat files, waypoints. To keep using a folder where a bot already runs, set `BOT_RUNTIME_DIR` to it. The first sign-in prompts for a Microsoft device-code login in the console.

The dashboard reads the same folders: `node dashboard/server.js` (override with `BOT_OZO_DIR`, `BOT_SMEO_DIR`, `BOT_CODE_DIR`).

Seed defaults (set 2026-11-05 from the live driver's overrides): the planner is off (no model credit; flip `planner.enabled` to turn it on) and `disabledModules` lists treefarm, excavation, build, villagers, mining, routines and dashboard (the old treefarm once dug around the tree farm). Remove a name from that list to enable the module for that bot.
