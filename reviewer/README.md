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
