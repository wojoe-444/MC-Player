# The brain (scheduler + furnace upkeep + module loader)

Status 2026-10-26 00:45 UTC. LIVE since the 00:29 restart (patched join.js applied; originals in backup/). Modules can be switched off with env BRAIN_DISABLE=chat or brain/state/disabled-modules.json. Everything is tested offline
(`node --test "test/*.test.js"`, 91 tests) and smoke-tested against the patched `join.js` with stubbed mineflayer
(`node tools/patch-join.js && node tools/smoke-join.js && node tools/smoke-join.js broken`).

## What it does
- `brain/scheduler.js`: one task at a time, priority safety 100 > sleep 80 > eat 70 > chat tasks 50 > farm 40 > furnace 30 > excavation 10.
  A higher-priority task preempts the running one, which is paused and later resumes with the same state. Idle-only tasks (farm routine,
  furnace upkeep) wait until Walter has been quiet for 15 seconds (default; "idle delay 30 seconds" changes it, and it is remembered) and yield the moment he types. "stop/stay" parks background tasks
  (furnace, excavation) until he says "resume"; chat tasks are cancelled. A task that ignores an abort for 15 s is detached.
- `brain/safehand.js`: Walter's lava rule. A 100 ms guard puts any selected lava bucket away (and stops movement first); lava may only be held
  inside `lavaMoment()`; every furnace move calls `ensureSafeForMove()`.
- `brain/furnace.js` + `furnace-config.json`: read chests, take empty buckets only from output chests of units whose fuel chest is below 4
  (more from other outputs if short), fill at the cauldron depots (only `lava_cauldron` blocks), put lava in fuel chests up to 6, put cobblestone
  above 48 in input chests, warn (30 min gap) when an output chest is over 80% full, depots are dry, or no empty buckets exist. Never digs/places.
- `brain/index.js`: wires sleep (wraps the driver's `bedRoutine`, same 48000-tick rule), the driver's idle farm routine (still controlled by
  `routine-state.json`), excavation (only started by Walter), navigation (`navigate()` becomes a scheduler task so safety can interrupt and
  resume it), harvest/index/inspect/craft/portal/tests as chat tasks, negation ("don't follow me"), `unhandled.log`, the module loader
  (`safety`, `chat`, `excavation`, `nav`, `dashboard`; a broken module is logged and skipped) and `idle.log`.
- New chat commands: `start furnace upkeep` (go: enables the routine and does a first pass), `run furnace upkeep once`, `stop furnace upkeep`,
  `furnace status`, `furnace plan` (read-only walk), `furnace verify` (config vs loaded blocks), `what are you doing` (queue), `resume`.

## Switching it on (batch with the next restart, agree with the coordinator first)
1. `node tools/patch-join.js` builds `next/join.js` and `next/farm.js` and prints the diff (9 small anchored edits + 1 line in farm.js).
   It aborts if the driver changed the code around an anchor. Re-run it right before applying; the driver edits `join.js` often.
2. `node tools/smoke-join.js` must print `SMOKE OK`.
3. At the restart: `node tools/patch-join.js --apply` (backs the originals up to `backup/<time>/`), then restart `run.js`.
   `NO_BRAIN=1` starts the bot with the brain off; a brain that fails to load falls back to the legacy behaviour automatically.
4. After the restart, nothing runs on its own except sleep (as before) and the farm routine if `routine-state.json` has it on.
   Furnace upkeep stays off until Walter says go. Suggested order: `furnace verify`, `furnace plan`, then Walter says "start furnace upkeep".
   The first pass should happen while Walter is watching: filling buckets from cauldrons has only been tested against a mock.

## Not verified against the real game yet
- `activateBlock` with an empty bucket on a `lava_cauldron` (1.21.6) giving a lava bucket; the code waits 2.5 s for the inventory update and
  stops a depot after 3 misses.
- Chest coordinates come from `stations.json`/`furnace-scan.txt` (S1 input chest at -1043,132,2273 was never read; its slot count is unknown).
- The bot reaching the depot (y136) from station 2 and back without digging.

## Not done
- "Stand still near Walter" as the lowest idle task.
- The old `brain/mobs.js` and `brain/nlu.js` drafts are superseded by `brain/safety/` and the chat thread's module; delete `brain/mobs.js`,
  `brain/nlu.js`, `test/mobs.test.js` when convenient (the safety thread says mobs.js is now a shim).
- `brain/chat/` has no `index.js` yet, so nothing registers from it.

## Plugins the driver suggested (checked on npm, 2026-10-26)
None adopted. `mineflayer-statemachine` (last release 2023) is a behaviour-state tool without our abort/resume/priority needs; `mineflayer-pvp`
(2022) and `mineflayer-tool` (2022) are stale; `mineflayer-armor-manager` (2023) and `mineflayer-auto-eat` (5.0.3, Aug 2025) are plausible for the
safety/eat side but not needed for the scheduler or furnace work; `mineflayer-collectblock` (Jan 2025) belongs to an excavation/farming module.
None of them was tested against 1.21.6 here. Mindcraft/Voyager ideas (skill library, memory) are out of scope for the scheduler.

## Known interactions
- `farm.js` auto-eats at food <= 14 and leaves food in hand; the patch adds `bot.noAutoEat`, which the brain sets while a SAFETY task runs.
- Walking limits kept: no digging/placing, max drop 3.
- The patched `join.js` sends all chat (and `cmd.txt` lines) through `BRAIN.route`; `cmd.txt` lines do not reset Walter's quiet timer.

## Live notes (2026-10-26)
- First furnace pass was blocked at night: creepers/skeletons around station 1 kept starting safety tasks and the survey restarted each time.
  Fix (in the files, loads at the next restart): a task bumped by a SAFETY task waits 20 s before resuming, and furnace work waits until no
  safety task has run for 60 s. Furnace upkeep is currently switched OFF; say "start furnace upkeep" after the restart.
- S1 input chest (-1043,132,2273) is out of reach for the pathfinder; cobblestone goes to the S2 input chests. Reading order is output chest
  first, then fuel/input chests from where the bot stands (arm's reach), because path search straight to the elevated chests times out.
- Modules from other threads not yet loaded by `brain/index.js`: `routines`, `crafting` (add to MODULES in brain/index.js when they are handed over).
