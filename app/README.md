# MC-Player desktop app

An Electron shell around the bot dashboard (`../dashboard/`), plus a small trigger framework that runs **headless Claude Code sessions** (`claude -p --model haiku`) in the background. Headless runs use the Claude Code CLI's own login, i.e. the subscription, not API billing. No keys are stored or read by the app.

## Run (Windows laptop)

```
cd app
npm install        # once; downloads Electron
npm start          # or double-click start-app.bat
```

Needs Node 18+ and, for the reviews, the `claude` CLI on PATH (run `claude` once to log in).

On launch the app starts `dashboard/server.js` on port 8765 (or attaches if a dashboard is already running there) and opens it in a window. **App > Claude reviews** (Ctrl+2) opens the trigger panel.

## Settings

`%APPDATA%/mc-player-app/config.json` (created on first change; defaults shown):

```json
{
  "dashboard": { "port": 8765, "ozoDir": "~/Downloads/Minecraft-Survival", "smeoDir": "~/Downloads/Minecraft-Smeo", "codeDir": "~/Downloads/Minecraft-Survival" },
  "claude": { "command": "claude", "model": "haiku", "timeoutMs": 180000 },
  "triggers": { "review": { "enabled": true, "intervalMin": 5 } }
}
```

Enable/disable, interval and "Run now" are also in the reviews panel. Reviews are saved as Markdown next to the config, in `reviews/`.

## Triggers

`lib/triggers.js` runs registered triggers on an interval and keeps their status; `main.js` registers them. A trigger is `{ id, title, run(ctx) }` and reads its `enabled` / `intervalMin` from `config.triggers[id]`.

- **review** (`lib/review.js`, on by default, every 5 min): collects tails of each bot's `idle.log`, `join.log`, `lessons.md`, `hurt.json` and `think-log.jsonl`, asks Haiku for a short status / problems / next-steps review, and stores it. It skips the run when the logs have not grown since the last review, never overlaps itself, and can only use Read/Glob/Grep, so it is read-only.

To add a "drive the bots" trigger: write `lib/<name>.js` returning a trigger, reuse `collectBotEvidence()` and `runClaude()` (give it more `allowedTools`, or have it write to a bot's `cmd.txt`), and register it in `main.js`.

## Tests

`npm test` (pure Node, no Electron needed): config merge, trigger scheduling, review prompt/skip logic, the claude runner.
