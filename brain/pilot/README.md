# brain/pilot: fast replies and free-time judgement for the fast models

Built for Walter's two complaints: "Claude's replies feel slow" and "the fast models barely do anything". It adds three things and changes no behaviour of the
deterministic code (safety, scheduler, furnace, mining all stay as they are). Nothing here restarts the bot or edits `join.js`.

## What was measured (before)

From the driver session's own transcript (`node tools/relay-baseline.js`), Monitor event -> first model output -> first write to `outbox.txt`:

| window | lines | first model output | first outbox write |
|---|---|---|---|
| 00:14-01:38 UTC 2026-10-26 | 33 | median 6 s | **median 14 s**, 10 of 33 took 28 s or more (max 154 s) |
| 01:48-02:11 UTC (long coding turns) | 32 | median 6.6 s | **median 28 s**, p90 93 s |

Where the time goes:

1. **Claude itself, ~90%.** About 6 s is model start-up per chat event; the rest is Claude investigating before it writes anything, and waiting behind its own running turn
   (the driver does coding work and chat in one session, so a line that arrives mid-task queues). Router, fast lane and the 2.5 s "Got it" ack are NOT in this path: the driver
   watches `chat.log`, which gets every line at once; the fast tiers run in parallel and only add their own (often unhelpful) reply.
2. **Plumbing, ~2 s:** `tail -F` polls once a second (0.6-1.2 s measured); `join.js` drains `chatQueue` every 1200 ms (0-1.2 s, avg 0.6 s per message); `outbox.txt` is read every 250 ms and `cmd.txt` every 500 ms.
3. **Duplicate and generic replies:** Elephant-1 deferred nearly every one of Walter's lines (`reason: none`), the fast lane refused long or conversational lines (`isComplex`), so what Walter heard was "Got it, one moment." and then, maybe 30 s later, Claude. When the fast lane did answer ("Noted, Walter! I'll grab it soon.") Claude also answered, and neither knew about the other.

## What it does now

### 1. Quick voice (`talker.js`): a specific reply in about a second
For a chat line that no command understood, a small fast model (`anthropic/claude-haiku-5.5` via OpenRouter, reasoning off, ~$0.0001 a call) writes one short reply
grounded in a state snapshot (`snapshot.js`: what the bot is doing, queue, health, food, time of day, what it carries, routines on/off) and in `brain/state/claude-notes.md`
(facts the driver keeps true). It names the actual topic, gives a view or one concrete question, and never claims or promises world actions
(`sanitize()` rejects "done", "on it", "I will go/build/...", links, slashes, bare "Got it", leaks). Statements never trigger commands: the quick voice cannot run anything.
Rejected or failed replies fall back to the router's old kind-based ack, so the worst case equals today.

- Registered as the FIRST router tier (`api.router.addTier('talker', fn, { first: true })`); orders that need slot filling (`go to 10 70 -20`, `craft 3 torches`) are skipped and still reach the fast command lane.
- The model call starts in `pilot.fallback()` **in parallel** with Elephant-1's decision call (pilot loads before router), so the reply is ready about when the router finishes.
- Measured end to end against the real endpoints (`node brain/pilot/bench-chain.js 10`): first bot line median **0.9-1.1 s**, max ~2 s, plus 0-1.2 s of `chatQueue` in the live bot (see "optional join.js change").
- Model choice (same 14 real lines): ministral-8b 1.3-4.7 s with invented plans and promises; qwen3.7-flash ~1.1 s but more promises; Haiku 5.5 ~1.0-1.3 s, grounded, fewest violations. Change it in `config.json`.
- Review loop: every outcome goes to `brain/state/talker-log.jsonl`; `tools/pilot-review.js` lists them, records good/bad verdicts and adds one-line "lessons" that appear in every prompt (Walter: Claude should review these small models now and then).

### 2. Relay feed + latency log (`feed.js`, `latency.js`)
`brain/state/relay-feed.log` has one line per chat line the bot did not handle itself, written once the fast tiers have acted (at most 2.2 s later):

    2026-10-26T01:51:47.267Z OGWO: when your mining code comes online ... || QUICK "Mining as a fallback sounds right ..." | OWES real answer (topic: mining fallback)
    ... || QUICK "Yes, the farm routine is on ..." | COMPLETE (nothing more owed unless you have something to add)
    ... || RAN "furnace status" (its own reply is in game)
    ... || ASKED "come here" (waiting for yes/no)
    ... || ACK ONLY "generic acknowledgement" | OWES real answer
    ... || NO FAST TIER YET (pending) | OWES real answer
       ^ update || QUICK "..." | ...          (a late outcome for a line already written)
    2026-10-26T01:55:02.000Z [pilot] the bot DIED (items may be at the death spot); check inventory and surroundings

`brain/state/latency.jsonl` times every Walter line: `quickMs`, `ackMs`, `botMs` (first bot line of any kind), `outboxMs` (when the driver first appended to `outbox.txt`, watched read-only
with `fs.watch`). `node tools/relay-report.js` prints medians and lanes. This is the live version of the baseline above.

### 3. Director (`director.js`, `options.js`): free-time choices
Rules decide what is **eligible**; Elephant-1 picks one eligible option or `wait` (a rule fallback if the API is down); the choice runs through `api.commands.dispatch` (so every existing rule, confirmation and priority applies) or a tiny vetted function.
- Modes: `off`, `shadow` (logs `brain/state/pilot-log.jsonl`, never acts), **`live` (default, set 2026-10-26 because Walter wants the fast models tested in the field)**. Walter flips it in chat: `pilot shadow`, `pilot off`, `pilot live`, `pilot status`; `quick voice on|off`. Saved in `brain/state/pilot-mode.json`.
- Free-time options only run when nothing is running or queued, Walter has been quiet >= max(45 s, idle delay), health >= 12, not sleeping, no "stop/stay/wait" from Walter in the last 10 min, at least 3 min since the last pick, at most 6 an hour. Each option has its own cooldown. A pick that is not `auto` is only proposed in the feed.
- Built-in options: `wear-armor` (instant, auto: equips better armor pieces already in the bag, via `safety/gear.armorUpgrades`; Walter noticed the unworn armor), `store-crops` (auto, only when the bag is crowded with crops), `deposit-smeltables` (auto, runs `furnace deposit` when 8 or fewer slots are free, or 128+ smeltable items are carried, per Walter's "put smeltables in the auto-furnace when the inventory fills"). Mining, farming, furnace upkeep and sleep are deliberately NOT options: they already schedule themselves as scheduler routines (the mining module has its own routine now), and the bot's whimsy time is its own (CLAUDE.md), so the director never fills it.
- Other modules add their own: `api.pilot.addOption({ id, desc, canonical | run(ctx), eligible(ctx) -> true | 'reason', auto, instant, risk, cooldownMs, weight, announce })`. Eligibility is always code; the model never invents an action.
- Combat stays deterministic on purpose: the safety loop scans every 300 ms and has tested creeper rules; a model round trip (0.3-3 s) is too slow and too risky there. The fast models get the before/after roles instead: loadout (wear armor), post-fight and health notes in the feed (`health is 5/20`, `the bot DIED`, `task failed`/`parked`), and the idle choices above.
- Review: verdicts from `tools/pilot-review.js mark director <n> good|bad "why"` land in `pilot-feedback.json`; an option whose bad verdicts exceed good by 2 cools down 4x longer, by 4 12x.

## For the integrator (all in `brain/index.js` and one config; no `join.js` change is needed)
1. Add `'pilot'` to `MODULES` **before** `'router'`: `['safety', 'chat', 'pilot', 'router', ...]`. (Its `fallback()` is an observer that returns false, starts the model call early, and its `start()` registers the tier; `start()` runs after every module has registered, so `api.router` exists.) `BRAIN_DISABLE=pilot` or `brain/state/disabled-modules.json` switches it off without code changes.
2. `brain/router/index.js` has two scoped edits already made (nothing else touched): `addTier(..., { first: true })` puts a tier first, and `handle()` emits `api.events.emit('router', {...})` after logging so the feed can say RAN/ASKED/ACK. `brain/router/config.json` `ackAfterMs` is now 3400 (was 2500) so the quick voice, which can take up to ~2.8 s in a slow moment, is not beaten by the generic ack.
3. Restart once (the bot drops). First lines to check: `idle.log` shows `MODULE pilot registered` and `pilot quickVoice=true director=live model=anthropic/claude-haiku-5.5 key=ok`; say `pilot status` in game.
4. Router must be `live` for the quick voice to speak (in `shadow` it does nothing, like the other tiers).

### Optional `join.js` change (saves ~0.6 s per message on average; ask the owner of join.js)
Replace the drain interval at the `chatQueue` (currently `}, 1200)` on the `setInterval(() => { const m = chatQueue.shift(); ...` line) with a tick that sends as soon as the 1.2 s gap since the last send has passed:

    let lastChatSend = 0
    setInterval(() => { if (Date.now() - lastChatSend < 1150) return; const m = chatQueue.shift(); if (m) { lastChatSend = Date.now(); if (m.trim().startsWith('/')) { console.log('BLOCKED_SLASH', m.slice(0, 60)); return } try { bot.chat(m) } catch (e) { console.log('CHAT_ERROR', e.message) } } }, 100)

Same rate limit (one message per 1.15 s), no wait for the old fixed tick. The `cmd.txt` poll (500 ms) and `outbox.txt` poll (250 ms) can go to 150 ms / 100 ms; together under 0.4 s, not worth a risky edit alone.

## For the driver (Claude): new playbook
1. **Watch the feed instead of `chat.log`**, with a faster poll:
   `tail -n 0 -F -s 0.25 /c/Users/walte/Downloads/Minecraft-Agent/brain/state/relay-feed.log`
   (`-s 0.25` measured 0.24 s average delay vs 0.67 s for the default `tail -F`.) Until the pilot is loaded the file does not exist, so keep watching `chat.log`.
2. **Read the outcome tag.** `QUICK ... COMPLETE`: the question is answered, reply only if you can add something. `QUICK ... OWES`: Walter already got a first take; do NOT repeat it, give the substance (facts, a plan, the thing done) and reply in your first tool call whenever you can, investigate after. `RAN`/`ASKED`: the bot handled it. `ACK ONLY` / `NO FAST TIER`: Walter heard only a generic line; answer properly and fast. `[pilot]` lines are events (death, low health, failed or parked task, free-time start), not chat.
3. **Say first, then work.** On anything that needs investigation, append one honest sentence to `outbox.txt` in your first tool call ("Looking at the sleep timer now"), then do the work and send the result. The quick voice now does this for ideas and questions; you still must for orders and tasks.
4. **Keep `brain/state/claude-notes.md` true.** The quick voice states anything in it. Update "Open requests" when you take or finish something, and fix anything it got wrong (and add a line with `node tools/pilot-review.js lesson "..."`).
5. **Review now and then** (a few minutes, every hour or two of play): `node tools/pilot-review.js`, mark good/bad, and `node tools/relay-report.js` for the numbers. Skim `brain/state/pilot-log.jsonl` for what it did.

## Files
`index.js` (module, tier, commands, events) · `talker.js` (prompt, sanitize, call) · `snapshot.js` · `feed.js` · `latency.js` · `director.js` · `options.js` · `config.json` ·
`bench.js` (models on real lines) · `bench-chain.js` (end to end, real endpoints) · state: `relay-feed.log`, `latency.jsonl`, `talker-log.jsonl`, `pilot-log.jsonl`, `pilot-feedback.json`, `pilot-lessons.txt`, `pilot-mode.json`, `claude-notes.md` (all under `brain/state/`).
Tools: `tools/relay-baseline.js` (driver transcript), `tools/relay-report.js`, `tools/pilot-review.js`. Tests: `node --test test/pilot.test.js` (46).

## Limits
- Haiku 5.5 is a fast model: it sometimes agrees too readily or states a rule slightly wrong. The notes file, the lessons and the sanitizer reduce this; the review loop is how it gets corrected. Replies are labelled by behaviour, not by name: it speaks as OzoGo444.
- A line that arrives while the quick voice breaker is open (key missing, 429, 3 failures) gets today's generic ack; the feed says so.
- The director's menu is short today (armor, crops, smeltables) because the other routines already schedule themselves; it grows through `api.pilot.addOption`. A natural next step is letting it arbitrate when several idle routines are due at once (the scheduler's fixed priorities decide today); that needs a scheduler hook, which is the integrator's file.
- `latency.jsonl` can only see Claude's reply when Claude writes through `outbox.txt`.
- The last full suite run had 2-3 failures in excavation and scheduler timing tests (they changed between runs while the excavation folder was being edited, and the scheduler one passes alone); the router, fastlane, integration and pilot suites pass.

## Driving power (added 2026-10-26)

**Model**: `deepseek/deepseek-v4.1-flash` (fallback `anthropic/claude-haiku-5.5` via OpenRouter `models`), chosen by `node brain/pilot/bench-drive.js <models...>` (24 labelled cases: 12 orders, 8 statements, 4 priority phrasings).
Commands 17-18/20, 0 false triggers, priority wording 3-4/4, median 0.35-0.5 s (0.64 s end to end through the router on real lines), $0.02/$1.00 per M tokens. Haiku 5.5: 17-18/20, 1.0 s. deepseek-v4-pro 16/20 0.9 s; gemini-3.1-flash-lite 15/20 0.8 s; qwen3.7-flash 13/20; the rest worse or erroring. Swap the model in `config.json`.

**Commands**: the prompt now lists the registered command set (same catalog as the router, plus the saved waypoints and `mine <ore> <amount>`); the model may return `{"command": "..."}` for a direct order. The command goes through the same gates as the fast command lane:
`slots.validate` (closed list or valid slot form; I added `mine <ore> [n]` there, high risk), numbers and names must appear in the line, `looksLikeOrder` (a statement, idea or question never becomes a command, not even a "Did you mean" question), then the router's tier rule: low-risk runs, anything high-risk (mining, building, chopping, crafting, excavating, furnace start) is only ASKED ("Did you mean ...? yes/no"). Nothing destructive runs without Walter's answer. When it runs, the command speaks for itself; anything the model cannot do is a reply plus `OWES` in the feed, i.e. Claude.

**Priority directives** (`directives.js`, `focus.js`): when Walter changes or frames priorities ("drop everything and finish the tower", "when you get a chance", "just this once", "forget the farm for an hour"), the model fills `directive {focus, urgency now|soon|background, persist until_done|minutes|once|until_told, minutes, then, avoid[]}`. It is stored with his exact wording (`brain/state/pilot-directives.jsonl`, active ones in the prompt as `STATE.directives`, so "how long should you stick with X?" is answered from his own framing), mapped to a scheduler task name (tower->build, iron->mining, wood->treefarm, farm, furnace, excavation, lighting, villager-upkeep) and sent to `scheduler.focus({task, priority 65|60|45, until 'done'|ms, note: his wording, suppress: [avoid], resumePrevious, maxMs})` (INTERFACE.md section 12). A foreground (`now`/`soon`) directive also holds the director's free time. It ends by itself on expiry, on the matching task finishing, or when replaced. A feed line `[pilot] directive: ...` tells the driver. No matching task = only free time is held.

**Director**: new options `chop-wood` (`chop trees`) and `mine-iron` (`mine iron 16`), high risk, so they only run on their own if listed in `config.json` `director.autoHigh` (Walter's prior go); otherwise they are proposed in the feed. Existing: `wear-armor`, `deposit-smeltables`, `store-crops`.

## Manual driver (added 2026-10-26): `manual: <goal>`

For one-off jobs no routine covers. Walter (owner only) says `manual: dig out the three stone blocks next to the door` (also `manual mode ...`, or the driver writes it to `cmd.txt`; other code calls `api.pilot.manual.start(goal, source)`). The fast model then drives ONE primitive per turn, sees the result, and repeats, within 25 steps / 4 minutes, as a scheduler task (`manual`, chat priority: cancelled by "stop", pre-empted by safety, one at a time). Every step is appended to `brain/state/manual-log.jsonl`; start/end notes go to the relay feed.
Primitives: `goto` (never digs; 100 blocks max, safehand first), `look`, `dig`, `place`, `equip`, `chest take|put`, `jump`, `wait`, `say`, `command` (low-risk registered commands only), `done`. Model: `config.json` `manual.model` (default = the talker model, deepseek-v4.1-flash; try `deepseek/deepseek-v4-pro` for harder jobs).
Fair play is enforced in the primitives, not the prompt: the observation is built from rays (never findBlocks), so hidden ore is not visible; dig/place/chest need `api.canSee` line of sight and 4.5-block reach; nothing is dug or placed inside the protected base box (`brain/mining/config.json` `protect.boxes`), next to water/lava, or on bedrock, containers, furnaces, beds, doors, spawners, portals, obsidian; no lava/fire/TNT/buckets held or placed; no tossing items; a chest only moves items the goal names; high-risk commands are refused (ask Walter). Stop = abort at once (task abort, nav stop, dig stop, controls cleared).
Not included on purpose: crafting (the crafting module is its own task and would queue behind this one; the model can `command` a low-risk one or finish with `done`), toss, free walking steps.

## Drops, recovery and chained priorities (added 2026-10-26)
- `collect drops | pick up items` (low risk, `collect.js`): deterministic sweep of every dropped item within 48 blocks, nearest first, walking onto each with nav (2 tries per item, skips items in/next to lava, stops for hostiles / full bag / 4 min / "stop"), reports the count. `recover your gear | get your stuff`: goes to the recorded death spot (`brain/state/pilot-death.json`, written on the death event) in legs of at most 100 blocks, then sweeps. After a respawn it runs by itself when it is daytime, no hostile within 24 blocks, same dimension and the spot is within 300 blocks and under 4 minutes old; otherwise it says where it died and waits for "recover your gear". The manual driver has a `collect_drops` primitive that calls the same sweep inline.
- Chained priorities: "tower first, then the iron mine" -> directive `{focus:'the tower', after:[{focus:'the iron mine', command:'mine iron 16'}]}` -> `scheduler.focus({task:'build', ..., then:[{task:'mining', priority, until:'done', note, focus, command:'mine iron 16'}]})`. Chained commands are validated against the real catalog first; an invalid one is dropped.

## Manual mode is a session (changed 2026-10-26 after Walter's complaint)
`manual: <goal>` starts a SESSION that lasts until Walter says `manual off` (also `stop manual`, `manual done`, `done with manual mode`, `resume routines`). Finishing a goal ("done") does not end it; the bot stays where it is and waits for the next instruction (`manual: ...`, or `next ...` / `now ...` / `then ...` / `continue ...` while the session is on; a new goal replaces the one in progress). While it is on: the `manual` scheduler task holds the slot at priority 49 (below Walter's own chat orders, above routines) AND a `scheduler.focus({task:'manual', priority:48, suppress:[farm, furnace, mining, treefarm, lighting, villager-upkeep, excavation, build, nav-tidy, outing, store-crops, craft, ...routines]})` keeps background tasks paused; sleep and safety are never suppressed. A plain `stop` ends the current goal only (hold stays, task re-submitted, bot says so). A preemption by something higher pauses the goal and resumes it from where the bot is. Limits: 400 steps / 45 min per goal, 6 h per session, auto-release after 3 h without an instruction (it says so). Ending only releases the hold and cancels the task: nothing walks anywhere. `api.events` emits `manual` {event:'start'|'end', pos:[x,y,z]} so the scheduler / tasks can resume from the bot's current position.

## Auto-repair when a job parks (added 2026-10-26)
A job that parks for any reason except safety / Walter's own stop / "needs Walter's go" starts a quiet manual session by itself: goal `"<module> parked: <reason>; resolve it and resume <module>"`. Triggers: `api.events 'park' {module, reason, pos}` (modules emit it) or, as a fallback, the scheduler's `task parked` event (`parkReason`); the two reports of one park within 5 s are merged. Limits: not while a manual session is already on; at most 2 attempts per module per hour; 30 min cooldown after a failed one; 120 steps / 15 min; `auto fix`-style switch via `sw.autoPark` / config `autoPark.enabled:false`. The model gets an AUTO-REPAIR rule: fix it, then `done {summary, resolved:true}`, or `resolved:false` with exactly what is needed. The `say` primitive is silent in an auto session; Walter hears only the done summary (success or blocked) or, when it ran out of budget, one line "X is still parked (...) ... It needs you". On success the pilot ends the session itself (the one exception to "only Walter ends manual mode"), releases the hold and resumes the job: `scheduler.resumeParked(module)`, else the `resume <module>` command. If Walter types `manual: ...` meanwhile he takes the session over and it no longer ends itself. Every start / success / failure is a `[pilot]` feed line.
