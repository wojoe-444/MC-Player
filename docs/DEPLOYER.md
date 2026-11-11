# Deployer

`tools/deployer.js` puts `main` on the live bots and takes it back if the bots get worse (docs/HILLCLIMB-INSIGHTS.md, item 9).
It works only on a clone made for deploying to (for example `MC-Player-live`) and on the bots' runtime folders. It never touches the world, never installs the app,
and treats each bot as its own control: a verdict compares a bot with its own hours before the deploy, never one bot with the other.

```
node tools/deployer.js deploy --code ../MC-Player-live --runtime runtime/ozo --runtime runtime/smeo
node tools/deployer.js judge  --code ../MC-Player-live --runtime runtime/ozo --runtime runtime/smeo
node tools/deployer.js status --code ../MC-Player-live
```

- **deploy**: fetches `origin/main`. Refuses if the clone has local changes ("drift", listed, never overwritten) or has diverged from main. Runs `npm test` on the candidate in a scratch worktree (use `--no-tests` or `--test-cmd`). Fast-forwards the clone, then tells the bots: a change that is only `brain/autopilot/{hallway,skills,mining,goals,plan,memory,think,watchdog}.js` hot-reloads through `brain/state/ap-cmd.js` in each `--runtime` folder; anything else needs a restart (`--restart-cmd`, otherwise `restart-needed.json` in the runtime folder for whoever supervises); changes to docs, tests and tools need nothing. A change to `package*.json` also says to run `npm install` first.
- **judge**: for the latest deploy, after 40 minutes (about two in-game days) compares weighted flags per hour (high 3, med 1, from `brain/state/telemetry/flags.jsonl`) with the same-length window before. At least 1.5x and 6 more is "worse": the clone goes back to the previous commit, that commit is marked bad (`deploy-bad.json`, not redeployed until main moves on) and the bots reload or restart. Slow signals (iron a day, deaths) are for the daily digest, not this check.
- Every action is a line in `<clone>/deploys.jsonl`; the runlog module already tags each bot's day with the commit it ran.

Both run on a schedule from the Bot Dashboard app: the Memory loop tab installs a Windows Task Scheduler entry ("MC-Player Bot Deployer", every 30 minutes) that runs `reviewer/run.js --deploy`. That wrapper judges the last deploy, then deploys, and writes the outcome to the loop's run log, ledger and work orders (`reviewer/lib/deploy.js`). A restart request (`restart-needed.json` in a bot's folder) is acted on by that bot's supervisor, `run.js`, within 15 seconds; it keeps the request as `restart-done.json`. When `package.json` changed, `npm install` runs in the clone before the bots are told (`--no-install` leaves that to a person).
