# Per-bot config

Both bots run the same code (`join.js`, `run.js`, `brain/` at the repo root). Only config and state differ.

| Bot | In-game name | Role | Viewer port |
|---|---|---|---|
| `ozo` | OzoGo444 | independent survival player (hillclimb) | 3007 |
| `smeo` | Smeo444 | personal assistant on a fixed routine (birch tree farm, base upkeep) | 3008 |

Each `bots/<bot>/` holds:

- `bot.json`: display name, viewer port, extra env vars (Smeo sets `MC_FRESH_MCA_TOKEN=1`, which makes `join.js` drop its cached Minecraft token at start and fetch a fresh one from the cached Xbox tokens).
- `bot.local.env.example`: copy to `bot.local.env` (gitignored) and set `MC_EMAIL`, the Microsoft account the bot signs in with. Optional `MC_PORT` for the LAN port.
- `seed/`: starter files (`brain/state/role.json`, `zone.json`, `site.json`, `safety-tuning.json`, ...) copied into the runtime folder on first start and never overwritten after that.

## Running

```
npm install
node scripts/start-bot.js ozo      # or smeo
```

The bot's cwd is `runtime/<bot>/` (gitignored): logs, `auth-cache/` (Microsoft login), `brain/state/`, chat files, waypoints. To keep using a folder where a bot already runs, set `BOT_RUNTIME_DIR` to it. The first sign-in prompts for a Microsoft device-code login in the console.

The dashboard reads the same folders: `node dashboard/server.js` (override with `BOT_OZO_DIR`, `BOT_SMEO_DIR`, `BOT_CODE_DIR`).
