# MC-Player desktop app

An Electron shell around the bot dashboard (`../dashboard/`), plus a small trigger framework that runs **headless Claude Code sessions** (`claude -p --model haiku`) in the background. Headless runs use the Claude Code CLI's own login, i.e. the subscription, not API billing. No keys are stored or read by the app.

## Run (Windows laptop)

```
cd app
npm install        # once; downloads Electron
npm start          # or double-click start-app.bat
```

Needs Node 18+ and, for the reviews, the `claude` CLI on PATH (run `claude` once to log in).

On launch the app starts `dashboard/server.js` on port 8765 (or attaches if a dashboard is already running there) and opens it in a window. The window has a tab bar across the top: **Dashboard**, **Claude reviews**, **Memory loop** and **Settings** (a dot on Settings means an update is available). Ctrl+1/2/3/4 and the App menu switch tabs too. The Memory loop tab installs and removes the Task Scheduler entries of the dream, deployer and digest jobs, runs each on demand, lets you set the code folder the live bots run from, and shows the day's digest, the ranked work orders, each bot's memory file with what the last check changed, and one line per run of every loop job. Its files stay in the app's settings folder, under `loop`.

## Install as a normal Windows app

```
cd app
npm install
npm run dist       # or double-click build-installer.bat
```

This builds `dist/Bot-Dashboard-Setup-<version>.exe` (build it on Windows: embedding the icon needs the Windows tooling). Running it installs per-user (no admin prompt), adds **Start menu** and desktop shortcuts named "Bot Dashboard" with the app icon, and launches the app. Pin it from the Start menu or the taskbar as usual. The installed app bundles the dashboard server, so it no longer needs this repo checkout; settings and reviews live in the app data folder under `%APPDATA%`. The icon is `build/icon.ico` (regenerate with `python3 build/make-icon.py`).

## Updating the installed app

The **Settings** tab has **Check for updates** (the app also checks quietly 20 seconds after start and every 6 hours; that only puts a dot on the tab). If a newer version exists, **Update and restart** downloads it, stops the dashboard server, runs the installer silently and relaunches the app. Nothing is downloaded or installed until you press it, and settings and reviews in `%APPDATA%` are kept.

How it works: `.github/workflows/release-app.yml` builds the Windows installer on GitHub Actions and publishes it as a release (`v0.1.<run number>`, with `latest.yml`) whenever `app/`, `dashboard/` or `reviewer/` change on `main` (or run it by hand from the Actions tab). The installed app uses `electron-updater` (`lib/updater.js`) to compare its version with the latest release of `wojoe-444/MC-Player` (public repo, no token needed). So an update is available a few minutes after a merge to `main`, once the workflow finishes. Running from source (`npm start`) shows "updates only work in the installed app"; there, use `git pull`. A local `build-installer.bat` build is version 0.1.0 and never touches the releases.

## Settings

`config.json` in the app's data folder (under `%APPDATA%`; the app menu has no shortcut yet, so look for the `Bot Dashboard` or `mc-player-app` folder there) (created on first change; defaults shown):

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

`npm test` (pure Node, no Electron needed): config merge, trigger scheduling, review prompt/skip logic, the claude runner, the update flow.

## Behavior reviewer

The same window has a **Behavior reviewer** section: findings per bot (from `../reviewer`, written by a Haiku 5.5 xhigh Claude Agent SDK pass over the in-bot telemetry), a **Review now** button, and **Install Task Scheduler job / Remove task** to run that review every N minutes even when this app is closed. See `../reviewer/README.md` for exactly what the task installs. Run `npm install` in `../reviewer` before `npm start` or building the installer (`build-installer.bat` does it).
