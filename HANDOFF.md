> **Read CLAUDE.md first**: OzoGo444 is an independent player with its own goals, not a tool or servant (Walter's explicit instruction).

# Handoff: first-person (POV) view for the Minecraft bot

Status as of 2026-10-25. Everything lives in this folder; Walter's main Minecraft install is untouched.

## The bot (running, keep it stable)
- `join.js` = the bot. Account the alt Microsoft account (MC_EMAIL) (in-game name OzoGo444), joins the LAN world at localhost:60439 (Fabric 1.21.6).
- Login is cached in `auth-cache/` (no more device codes needed unless the cache is deleted/expires).
- It answers the Fabric handshake by hand (registry sync, `c:version`, `c:register`, `fabric:accepted_attachments_v1`, `fabric:custom_ingredient_sync`); that code is at the top of `join.js`. Do not remove it or the server kicks the bot.
- Chat is two-way: player chat/whispers are appended to `chat.log`; lines appended to `outbox.txt` are said in game by the bot (polled every 1s). Built-in commands: "walk to me", "follow me", "stay"/"stop", "inventory", "where are you". Pathfinding never digs or places blocks.
- Launch (hidden window, logs to join.log/join.err):
  `$env:SKIP_HELLO='1'; Start-Process node -ArgumentList 'join.js' -RedirectStandardOutput join.log -RedirectStandardError join.err -WindowStyle Hidden`
  Only one instance may run at a time (same account). Kill with `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? CommandLine -match 'join.js' | % { Stop-Process -Id $_.ProcessId -Force }`.

## POV viewer (partially working)
Installed in this folder: `prismarine-viewer@1.33.0`, `canvas`, `playwright-core` (uses the PC's installed Microsoft Edge, no browser download), plus `mineflayer`, `mineflayer-pathfinder`.
- `join.js` starts the viewer on http://localhost:3007 (first person) if `prismarine-viewer` loads (wrapped in try/catch so the bot works without it).
- `shot.js [name] [waitMs]` opens that page in headless Edge and saves `pov/<name>.png`. Samples: `pov/first-sample.png`, `pov/with-terrain.png`.

### What works
- The page renders and screenshots save fine. Entities draw correctly (players with name tags, mobs).

### What failed
- **No terrain/blocks are drawn** (just sky-blue background) even after the fix below.
- prismarine-viewer only bundles textures/blockstates up to 1.21.4 (`node_modules/prismarine-viewer/public/textures`, `blocksStates`), so requests for 1.21.6 returned 404. I copied the 1.21.4 files to `1.21.6` / `1.21.6.png` / `1.21.6.json` in that folder. Terrain still did not appear; one 404 remains in the page console (not yet identified).
- Server-side noise: some `move_minecart` packets fail to decode in the 1.21.6 protocol data ("Chunk size is 58 but only 40 was read"), harmless so far.

### Ideas for whoever picks this up
1. Find the remaining 404 (log `page.on('response')` in `shot.js`) and check the browser console for worker/meshing errors; the chunk-meshing worker may be rejecting 1.21.6 block ids/states vs the 1.21.4 blockstates file.
2. Try giving the viewer `viewDistance` larger, and confirm the bot has chunks (`bot.findBlocks` works, so chunks are loaded).
3. Fallbacks: a top-down map rendered from `bot.blockAt` colors into a PNG (no browser needed), or a real Fabric client for screenshots.

## UPDATE: working first-person view (`pov.js`) — use this instead of the web viewer
The prismarine-viewer web page cannot draw 1.21.6 (its meshing worker only has block data up to 1.21.4, so it falls back and scrambles blocks). `shot.js` is therefore superseded. `pov.js` does NOT need the browser, does not touch the bot process, and needs no restart of `join.js`.

How it works: it connects to the viewer socket that `join.js` already serves on :3007 (so keep the `mineflayerViewer(bot, { port: 3007, firstPerson: true, ... })` call in join.js), rebuilds the nearby chunks locally and ray-casts the image with real block textures, entities (name tags for players/mobs not behind walls) and water/plant/slab shapes. ~7 s per image.

    node pov.js [out.png] [--look north|east|south|west|up|down] [--turn DEG] [--pitch DEG] [--around] [--w 960 --h 540] [--fov 70] [--range 96] [--at X,Y,Z] [--no-hud]

- Default output: `pov/latest.png`, looking the way the bot is facing. View it by reading the PNG.
- `--around` makes a 2x2 sheet (forward, left, back, right, level).
- Prints one JSON line to stdout: bot position + facing, the block under the crosshair (`lookingAt`), entities in view.
- Limits: no light levels (caves look as bright as day), simplified mob models (coloured boxes), no particles/weather, biome tints approximated. Needs the viewer socket, so it only works while join.js is running.
- Edge case: the viewer only pushes the bot's position about once per second, so a call right after the bot moves may show where it was a moment ago.
- I swapped nothing in node_modules in the end (changes to the viewer bundle were reverted).
