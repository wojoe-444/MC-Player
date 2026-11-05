# brain/dashboard

Read-only status page for the bot. Plain Node, no new dependencies.

- URL: **http://127.0.0.1:3010/** (loopback only; if 3010 is busy it tries 3011..3014; the real port is in `status.modules.dashboard.port` and the brain log). Override with env `BOT_DASHBOARD_PORT` (`-1` disables it). 3007 stays the prismarine viewer.
- Shows: position, facing, health, food, dimension, game time, held item (red warning if it is a lava bucket), inventory totals, running task + queue + parked tasks + routines + scheduler history, recent chat, last POV image (`pov/latest.png`), station and chest status (`stations.json`, `chest-index.json`, with a filter box), furnace status, module statuses and the brain log. Refreshes every 2 s; shows "disconnected" while the bot restarts and recovers on its own.
- Endpoints: `/` page, `/api/status` (or `/status.json`) JSON snapshot, `/pov/latest.png`, `/healthz`. GET/HEAD only (POST etc. get 405), requests whose Host header is not localhost/127.0.0.1/[::1] get 403.
- Files written: only `api.statePath('dashboard-status.json')` (the same snapshot, every 5 s, atomic). No chat, no movement, no other ports.

## Interface (v1)

`require('./dashboard')` is `register(api)` and returns `{ name:'dashboard', start, stop, status }`. `start()` binds the port (async, never throws; a failure is logged and the bot is unaffected), `stop()` closes the server, the timer and the chat listener. `status()` returns `{ url, port }`.

Data comes from, in order of preference:
- `api.bot` for position, vitals, held item and inventory (read directly, so it works even if `status.all().bot` is thin);
- `api.status.all()`: `scheduler`, `furnace`, `modules`, `chatTail`, `logTail` (and `bot`, merged underneath the live values). `chatTail` / `logTail` entries may be strings or `{t, user|from, text|msg}`;
- fallbacks: scheduler from `api.scheduler.status()`, chat from `api.events` `'chat'` events, then from the tail of `chat.log`.
Every source is optional; a missing or throwing one just leaves that section empty.

## Integrator notes

- No change to `join.js` is needed beyond what `brain/index.js` already does for modules. If you want bot replies to show in the chat panel, include them in `status.all().chatTail` (the page colours entries whose `user`/`from` is the bot name or `bot`).
- `node --test test/` does not work on Node 24 (it treats `test/` as a module); use `node --test` or `node --test test/*.test.js`.
- The POV image is only as fresh as the last `node pov.js` run; the page shows its age. Nothing here runs `pov.js`.

## Trying it without the bot

    node brain/dashboard/mock.js 3011      # then open http://127.0.0.1:3011/

The mock uses a scratch copy under %TEMP% (copies of `stations.json` and one of the `pov/*.png` images, generated chest index and chat) and animates position, health and food. `node --test test/*.test.js` runs `test/dashboard.test.js` (9 tests: contract, snapshot content, routing, read-only/Host guard, lava flag, missing bot/files, chat fallbacks, status.json, port fallback).

## Chat phrases tested

None; this module has no chat commands.
