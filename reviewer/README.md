# Spectator reviewer

Walter notices things in a minute of spectating that the text logs never show: jumping up and down, a sword in hand against a tree, pacing, standing around, stray blocks.
This folder is a second pair of eyes that does the same, every 10 minutes, for both bots.

```
bot (brain/telemetry)  ->  deterministic detectors  ->  summary.json / flags.jsonl / REVIEW-ALERTS.md   (every 15 s, no model)
                                       |
reviewer/run.js  (Windows Task Scheduler, every 10 min)  ->  Claude Agent SDK, claude-haiku-5-5, effort xhigh, own system prompt, no tools
                                       |
<bot folder>/REVIEW-FINDINGS.md  +  brain/state/review/findings.json  ->  driver thread, Bot Dashboard app, dashboard /api/findings
```

Findings are never sent to game chat.

## 1. Telemetry in the bot (`brain/telemetry/`)

An observer module, loaded by `brain/index.js`. Every 250 ms it keeps a sample (position, onGround, held item, task, whether the bot is busy sleeping/eating/in a container/digging) in a 15-minute ring, plus events: jumps, dig starts with the held item,
placements (and whether the sky was open above), pathfinder failures, aborted digs, failed tasks. Every 15 s `detectors.js` runs over the ring:

| flag | meaning |
|---|---|
| `jumping` | 20+ jumps/min on one spot (high) or 40+ while travelling (med); quiet while a pillar is working |
| `pillar_failing` | jumping on the spot looking down: a held item that cannot be placed (sword, tool, empty hand), or several jumps with no height gained (Smeo444 2026-11-10) |
| `wrong_tool` / `no_tool` / `cannot_harvest` | the held item is not whitelisted for the block being dug. The whitelist is derived from minecraft-data (`material`, `hardness`, `harvestTools`): axes for logs/planks, pickaxes for stone and ores, shovels for dirt/sand/gravel, hoes or shears for leaves, shears for wool, swords or shears for cobweb, anything for instant-break blocks. `cannot_harvest` = the block drops nothing with that item |
| `oscillating`, `stuck` | pacing in a few blocks; pathfinder active with no progress |
| `idle` | standing still with no sign of work: no dig/place, pickup, container, eating, sleeping or autopilot step change. 75 s (med) / 3 min (high) when no task or step can be identified, 2 / 5 min when one is named. Reseeding a farm, tidying or any low-movement work that digs, places or picks up never counts |
| `ladder_bobbing` | 4+ turns of 2+ blocks up and down the same ladder column within 2.5 min with nothing dug or placed (a shaft trip down and back is not bobbing) |
| `staircase`, `surface_blocks` | a new staircase dug; filler blocks placed in the open air |
| `torch_spacing` | a torch placed adjacent to, or on a line less than torch-air-air-torch from, another torch at the same height (Walter 2026-11-10). Flag only: when tidying, keep enough torches that the area stays lit |
| `repeated_failure` | 5+ noPath/timeout/aborted dig/failed task in 5 min |
| `lava_in_hand` | walking with a lava bucket selected |
| `armor_equipped` | **high, immediate.** Any armor in a head/chest/legs/feet slot (armor is banned, Walter 2026-11-10), except diamond/netherite with Mending, or names listed under `armorFarmDrops` in `brain/state/telemetry/rules.json` (for mob-farm drops once a farm exists). Raised ~0.3 s after the slot changes, not at the next 15 s pass |
| `armor_carried` | armor pieces in the bag (not worn), same exceptions; med. The 05:16Z review found four iron pieces carried that `armor_equipped` could not see |
| `tool_tier` | 3+ digs in 5 min with a higher tier than the block needs while a lower suitable tool is in the bag (stone is the default; iron only for diamond/gold/redstone/emerald; diamond only for obsidian) |
| `farmland_trampled` | farmland next to the bot turned back to dirt right after the bot jumped, dropped or hopped onto it (vanilla: any landing after a fall over half a block, a jump is ~1.25). Telemetry notices the `blockUpdate` farmland to dirt within 4 blocks of the feet, drops it if the ledger says the bot dug, hoed or built on that cell, and files a `trample` event. med for one in 10 min, high for 3. The cause is in `brain/nav` (`movements.js` landing cost, `farmland.js` jump guard). Walter 2026-11-11 |
| `chat_spam` | the same line 3x in a minute (high); 3 lines less than 1 s apart or 10+ lines a minute (med). Relies on the server echoing the bot's own chat |

Output, all under the bot folder: `brain/state/telemetry/summary.json` (counters for 1 and 10 min, active flags, last 90 s of positions), `flags.jsonl` (one line per new flag with a 1 Hz excerpt), and `REVIEW-ALERTS.md` (active medium/high flags, readable, refreshed within 15 s).
Tests: `node --test test/telemetry.test.js`.

## 2. The reviewer (`reviewer/`)

`node run.js` collects, per bot, the telemetry summary, new flag windows, a planner-failure summary (`think-log.jsonl`), and tails of `idle.log`, `lessons.md`, `join.log`, `hurt.json` (sent as `hurtLifetimeTotals`: history, never evidence of now), and sends both bots to **one** Haiku call
with the system prompt in `lib/prompt.js` (what a spectator notices, what is normal, how to judge, answer schema). The answer is structured JSON; findings keep a stable `key`, so a problem is tracked across runs (first seen, runs seen, resolved when it stops).
High-severity detector flags the model did not cover are added anyway, and if Claude is unreachable the detector findings are still published. It skips the model call when nothing changed since the last pass or a bot is offline.

* Auth: the Claude Code login on the computer (your subscription). `ANTHROPIC_API_KEY` is removed from the SDK's environment so it cannot bill the API. If it says "not logged in", run `claude` once in a terminal.
* `--dry-run` prints the exact prompt and evidence without calling the model; `--force` reviews even if nothing changed; `--model`, `--effort`, `--ozo DIR`, `--smeo DIR`.
* Bot folders default to the Bot Dashboard app's settings (`%APPDATA%\Bot Dashboard\config.json`), then `BOT_OZO_DIR` / `BOT_SMEO_DIR`, then `~/Downloads/Minecraft-Survival` and `Minecraft-Smeo`.
* Its own state (log, lock, launcher) lives in `~/.mc-player/reviewer/`.

## 3. Detectors the reviewer writes (judgement -> routine code)

The pillaring, wrong-tool and torch-spacing flags above were written by hand as the first examples. From now on the reviewer adds its own: when it judges a pattern bad and none of `existingDetectors` covers it, it proposes a small **flag-only** check (`proposedDetectors` in its answer: name, why, JavaScript `function detect(samples, events, now, H)`, and the captured windows that show the pattern). These never stop or alter the bot; they only raise a flag like any other.

1. The bot keeps raw 150 s slices of its telemetry (`brain/state/telemetry/windows/`, 8 normal and 6 flagged, newest kept) so a new check can be tried on real play.
2. `lib/proposals.js` screens the source (size, banned words), compiles it in the same sandbox the bot uses (`brain/telemetry/sandbox.js`: a fresh `vm` context with only JS builtins, JSON in and out, 150 ms timeout, no code generation from strings), and **replays it over the windows**: it must fire on the nominated bad window(s), and on at most 10% of the normal ones (at least 3 normal windows are needed). A failing proposal is rejected with the reason.
3. A passing one is written to `<bot>/brain/state/detectors/<name>.js` (header with origin and validation result), `manifest.json` (sha256, version, origin: model, time, why, windows it was validated on) and `log.jsonl` (full source for every proposal, enabled or rejected). Max 12 custom detectors.
4. The bot's telemetry module hot-loads the manifest within 15 s, refuses a file whose hash does not match, caps severity at `med`, and mutes a detector that throws, times out or fires on nearly every pass. Its flags show as `custom_<name>` in `REVIEW-ALERTS.md`, the summary and the dashboard, and in the next review the model sees what happened to its proposals.

Disable one by setting `"enabled": false` in `manifest.json`, or delete its entry. The reviewer's `REVIEW-FINDINGS.md` lists enabled and rejected proposals.

## 4. Task Scheduler (what it installs)

`node run.js --install-task [--minutes 10]`, or the **Install Task Scheduler job** button in the Bot Dashboard app (App > Claude reviews). It creates exactly one task, **MC-Player Bot Reviewer**, for the current user:
every N minutes, only while that user is logged in, limited rights (no admin, no stored password), no window. The task runs `wscript.exe //B //Nologo %USERPROFILE%\.mc-player\reviewer\launch-reviewer.vbs`, a three-line script that starts `node reviewer\run.js --once` hidden.
Remove it with `node run.js --uninstall-task` or the **Remove task** button. Nothing else is installed or changed.

Setup once: `cd reviewer && npm install`.

## 5. The dawn brief (`lib/brief.js`, docs/MEMORY-LOOP.md job 3)

The same Task Scheduler entry answers the bots' brief requests before it reviews. A bot with the brief on (`planner.brief` in its profile; default on for the hillclimber) writes `brain/state/memory/brief-request.json` at an in-game dawn, at most once an hour, and after a respawn. `lib/brief.js` answers each fresh, unanswered request with one call (same model and effort as the review, no tools, JSON schema) and writes `brief-answer.json` beside it, plus one line in `brief-history.jsonl`. The bot checks the answer in code before any of it counts (`brain/memory/brief.js`): real step names only, no hold on a survival step or on free time, the memory caps.

```
node run.js --brief-only        answer waiting requests and stop
node run.js --brief-dry-run     print the prompts that would be sent
node run.js --no-brief          a review pass without the briefs
```

Every call now runs with ambient memory shut out (`settings: { autoMemoryEnabled: false }`, and `CLAUDE_*MEMORY*` variables removed from the child's environment), so a job judges from its prompt alone.

## 6. The dream job and work orders (`lib/dream.js`, `lib/orders.js`, docs/MEMORY-LOOP.md job 4)

`node run.js --dream` checks each bot's memory against its journal and hands what memory cannot fix to the work orders. It has its own Task Scheduler entry, "MC-Player Bot Dream", every 2 hours, installed and removed from the Memory loop tab of the Bot Dashboard app (or `--install-task --dream`, `--uninstall-task --dream`).

- Up to five short calls per bot (Haiku 5.5 at xhigh, no tools): correct, cut, demote, fill gaps, hand off. A call is skipped when code can see it has nothing to do, and the whole dream is skipped when the journal has no new events.
- Code builds numbered facts from `brain/state/journal/` and checks every answer: a change must cite a fact that exists, the caps of `brain/memory/store.js` hold, at most four corrections, three cuts, two additions and four new orders per dream, and a line the dream changed rests for 12 hours.
- It writes only the Policies and Traps sections of `brain/state/memory/global.md` and notes, through the same store the bot uses. "Now" and "My own projects and wishes" are the bot's.
- Each dream leaves `memory/dream/last.json` and a dated `.md` report. The bot's next brief shows what changed and why (`memory.lastCheck`).
- A bot with a journal and no memory folder (the assistant) gets the hand-off step only.

Work orders live in the loop folder, beside the app's settings (`%APPDATA%/Bot Dashboard/loop`, or `~/.mc-player/loop` when the app has never run; `--loop DIR` or `LOOP_DIR` override it):

| File | What |
| --- | --- |
| `work-orders/<key>.json` | one problem: title, problem, where to look, numbers per bot, cost in lost minutes over 24 h, linked findings, history |
| `WORK-ORDERS.md` | the open orders, most costly first (`node run.js --orders` prints it) |
| `ledger.jsonl` | one line per event in an order's life |
| `decisions.json` | candidates judged "not a bug", so they are not asked again for a day |
| `runs/<job>.jsonl` | one line per run of the review, brief and dream jobs, shown in the app |
| `dream/<bot>.json` | when each bot was last dreamed and which lines are resting |

`node run.js --dream-dry-run` prints the candidates and every prompt without calling a model. `--dream --force` dreams even when the journal has nothing new.

`node run.js --deploy` (entry "MC-Player Bot Deployer", every 30 minutes) and `node run.js --digest` (entry "MC-Player Bot Digest", checked hourly, one page a day after 07:00) are the other two loop jobs, installed from the same tab. Neither calls a model. The deployer wrapper (`lib/deploy.js`) calls `tools/deployer.js` of the clone the bots run from (`--code DIR`, the app's setting, or `~/Downloads/MC-Player-live`): judge first, deploy only when the last deploy has its verdict, and pass deploys and verdicts on to the work orders by PR number. The digest (`lib/digest.js`) writes `digest/<date>.md` in the loop folder.

A finding now closes with a reason (`lib/findings.js`, `closeReason`): fixed by a named PR, went quiet after the bot moved to a named commit, closed by the reviewer, or went quiet with no code change in between.

## 7. The fixer (`lib/fixer.js`, docs/MEMORY-LOOP.md job 5)

`node run.js --fix` takes the most costly open work order to a pull request. Task Scheduler entry "MC-Player Bot Fixer", every 3 hours, installed from the app's Memory loop tab (`--install-task --fix`).

- `--only KEY` takes that order (also a parked one). `--fix-mode merge|pr|local` (default: the app's setting, else merge). `--fix-dry-run` prints the order and the prompt.
- Working copy: `<loop dir>/fixer/MC-Player`, cloned from the public repo, reset to `origin/main` on a new branch `fix/<key>-<MMDD-HHmm>` each run. It borrows `node_modules` from the code folder the live bots run from (a junction on Windows), else runs `npm ci`.
- The session is `runAgent` in `lib/claude.js`: built-in Read, Glob, Grep, Edit, Write, plus `run_node`, `run_tests` and `git` (read only) served in process. No Bash. A `PreToolUse` hook asks `gateFor()` before every call: reads stay in the working copy and the evidence folder, writes stay in `ALLOWED` minus `PROTECTED`, existing tests are read only. The commands it runs get an environment without anything that looks like a credential.
- `check()` decides, not the session: the diff is inside the remit, there is a new test, it fails on a worktree of `origin/main` and passes with the change, `node scripts/run-tests.js` passes (files that fail on `origin/main` too are listed as `redOnMain`, not counted), nothing from this computer (home path, address, key) is in the diff. One repair session on a failed check. A session that ends in prose gets one no-tool call (`FORM`) that reads the answer form off its report.
- `runAgent` sets the time limit of its own tools itself (35 min, on the server and as `MCP_TOOL_TIMEOUT`): an inherited 60 s limit cut every suite run off in the first trial.
- `publish()` uses `git push` and `gh pr create` / `gh pr merge --squash`. No `gh`, no login or a refused push leaves a `ready` event on the order; the next run publishes it without a new session.
- The order's history carries it: `attempt` (with what was tried), `ready`, `pr`, then the deployer's `deploy` and `verdict`. Two failed attempts park the order. `progress()` reads that history; `pick()` skips orders that wait.
- Files: `<loop dir>/fixer/state.json` (last run, whether GitHub was reachable), `fixer/evidence/<key>/`, `fixer/sessions/` (the last 30 session logs: every tool call, the answer, the checks), `fix.lock`.
- Tests: `test/fixer.test.js` drives it with a real git repository standing in for GitHub and a function standing in for the session.

## Prompt tuning (2026-11-10)
The first live run (OzoGo444 and Smeo444, 04:43Z) mostly restated detector flags under `<bot>-detector-<kind>` keys, rated six things high, read lifetime hurt totals as live evidence and an old window as the present, and said nothing about armor or progress. `lib/prompt.js` now orders attention (rules, loops and stalls, progress, mess, code faults in logs), lists the rules in force and the roadmap phases, asks for one finding per root cause with at most 2 high and 5 total, and says what not to trust. The model also gets `previousReview` (last summary and bag) and the bag and worn armor in `telemetrySummary.now`, so it can judge progress. `examples/replay-before.json` and `replay-after.json` are the old and new prompt run on the same reconstructed 04:48Z input.

### Prompt pass 3 (2026-11-10, replayed on the real 07:26Z input of both bots)
Found by reading 21 live runs (04:29Z to 07:21Z) and replaying the then-current prompt (`examples/pass3-before-*.md`, after: `pass3-after-*.md`):
* **A dead planner log was read as a live fault for 17 runs.** Ozo's `think-log.jsonl` was last written on 2026-11-04 by a planner that is switched off (`think-off`), and the reviewer kept reporting "380 model errors, steps 0". `collect.js` now sends `plannerSummary` with the counts only when the planner is on and the log is under 30 min old (`plannerRunning`); otherwise it sends a one-line statement, and the prompt says that is never a finding.
* **Every active high flag the model did not cover added its own HIGH "Detector: ..." entry** (Ozo had 3 HIGH, 2 of them copies of flags the model's findings already explained, e.g. `repeated_failure` explained by a path-search finding of kind `code_fault`). Findings now carry `explainsFlags` (the flag kinds they account for); `findings.js` counts a flag as covered by same kind or by `explainsFlags`.
* **Detector proposals for bots that cannot validate them.** A bot with fewer than 3 normal windows now gets `detectorProposals: "closed..."` and no window digests (they were about a third of the prompt); the model was proposing the same "parked on one tile" detector under new names three times, each rejected. The prompt also says: no near-copies of idle/stuck/oscillating/repeated_failure, read `detectorEvents` first.
* **Bag changes**: tools that left the bag right after restock/stash/discard goals were reported as lost ("both pickaxes gone"); the prompt now says those were stored in a chest and only a death loses a bag.
* **Stack traces and repeated error lines in the log are code the model can see** (`StepTimeout ... at S.goto (skills.js:190:7)`, `CRAFT_FAIL ...`): quote the frame, one finding per distinct error.
* Telemetry counters that cannot be right become at most one low `Telemetry: ...` finding; a LOW finding unchanged for 5 runs is resolved (`previousOpenFindings` now carries `seenRuns`).
* Severity is defined once (the old text defined it twice, two ways), the summary limit once; the evidence is sent as compact JSON (the pretty-printed prompt was 185 KB, now about 83 KB for the same input).

### Prompt pass 4 (2026-11-10, from 56 live runs per bot between 08:01Z and 17:11Z on v0.1.9)
Pass 3 worked (no planner false alarm, no "Detector:" duplicates; the bots' reviewer even wrote and enabled three detectors). What was left, measured on `history.jsonl`:
* **Keys were renamed every run.** 101 distinct keys for Ozo and 110 for Smeo in 56 runs, 67 and 82 of them alive for 2 runs or fewer; one torch cause carried 18 keys, so every run showed a new finding "seen in 1 run" and the first-seen time reset. The prompt now says keys are identity (reuse the exact key from `previousOpenFindings`, then `recentlyResolved`; never name a key after the numbers), `recentlyResolved` (last 10: key, title, resolvedAt) is now part of the evidence, and `findings.merge` restores first-seen and run count when a resolved key returns.
* **A telemetry counter bug was reported for 10 hours under 11 keys.** `counters()` rounded each 0.25 s step to 0.1 s, so `secondsByTask` and `secondsByHeldItem` came out 7 to 14 percent over the window (measured on the captured windows). The reviewer was right; fixed at the source (`brain/telemetry/detectors.js`, takes effect when the bots restart) with a test, instead of teaching the prompt to ignore it.
* **Resets were flagged as rule violations.** The loop breaker's `/tp`, `/spawnpoint` and `/give` (logged as "PLAN loop breaker: ... reset level N") is Walter's reset process; one run rated it HIGH. The prompt now says logged resets are not violations (the loop is the finding; repeated resets within the hour are one med finding) and unlogged teleports still are.
* Cross-bot duplicates (same shaft gap or torch row under both bots at the same time): an explicit check step. A proposed detector named a window id that did not exist and was rejected unseen: ids must be copied from `windows[].id`.
Replay on the 17:25Z input (`examples/pass4-*.md`, same model, same state): with main's prompt 5 of 9 findings were new keys "seen in 1 run" (4 of the 4 Ozo findings were renamed copies of ones it had just closed); with pass 4, 3 of 12 (the genuinely new ones). Run time and cost unchanged. A second replay on each result kept every key in both versions, so the gain shows up when state and data change between runs, not on a repeat.

### Evidence from the built world (2026-11-10, after the mob farm)
The reviewer saw telemetry text only, so it could not notice a torch inside a spawn room, an open slit or a drop through old tunnels, and the farm logged zero kills. `brain/inspect` (see its README) now compares the bot's own builds with their design from the blocks, and `collect.js` sends it as `buildInspections` (faults, warnings, and for a failing build the block-light map and two cutaways as text). The bot also reads its own inspection and the reviewer's open high/medium findings (`build_problems`, `reviewer_notes` in the planner state), so findings no longer wait for a human or a driver thread to carry them.
