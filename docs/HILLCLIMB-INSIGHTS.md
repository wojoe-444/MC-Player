# Hillclimbing the bots smarter: ranked insights

2026-11-10. Repo copy of the project doc of the same name, approved by Walter for execution with one change: the second bot is not used as a control group.

## The short version

The bots are not short of fixes. They are short of a way to know whether a fix worked without Walter watching. The repo took 194 commits in six days, and the same four problems (pillar, armor, torches, tools) kept coming back. Four moves change that, in this order:

1. **Turn every flagged incident into a replayable scenario on the trial server**, so a fix is proven against the server before it reaches a live bot, and stays proven.
2. **Give the bot one body.** Pillar exists in five separate implementations and only one received the six recent fixes. One motor layer for place, dig, equip, climb and pillar, with the duplicates deleted.
3. **Enforce rules where packets leave the bot, from one rules file.** The no-armor rule took five PRs because it was enforced at call sites, and there are 72 equip call sites in 32 files.
4. **Compare each bot with itself, by commit.** Tag every day's numbers with the commit the bot ran, so a change shows as a before and after on the same bot. Walter ruled out using the second bot as a control group.

There is also one specific finding worth testing today: the pillar failures are probably caused by a hidden head-turn wait inside mineflayer's `placeBlock`, not by server timing. Details are in the next section.

Everything here is read from the code and the commit history on 2026-11-10. Nothing was run in game, and claims that still need a test are marked as such.

## What the repo's own history says

The commit log shows repeat fixes to the same behaviour, each tuned to one logged incident. That is the pattern to break.

| Signal in the repo | Count | What it means |
| --- | --- | --- |
| Commits on `main`, 2026-11-04 to 11-09 | 194 | About 32 a day, so nobody can review or regression-test by hand |
| Commits naming pillar | 13 | Six of the last 20 PRs (#169, #170, #177, #181, #183, #188) patch one function in `brain/nav/reach.js` |
| Separate pillar implementations | 5 | `nav/reach.js`, `build/pillar.js`, `excavation/pillar.js`, `mining/exit.js`, `treefarm/engine.js`. The last one still places at +1.0, the exact condition #169 found gets refused |
| Commits naming armor | 10 | "Armor first" (#152) on 11-07, "no armor" on 11-10. The reversal took #172, #173, #188, #190 plus a detector in #189 |
| `bot.equip(` call sites | 72 in 32 files | Why a rule at call sites keeps leaking. `skills.js` also replaces `bot.equip` with its own wrapper |
| `setControlState` call sites | 73 in 21 files | Many loops can press the bot's keys at once. There are also 51 `setInterval` timers in 26 files |
| Empty `catch {}` blocks | 397 of 1,143 | A refused action usually looks the same as a successful one to the caller |
| Test workflow in CI | 0 | About 75 test files exist, but `npm test` is a stub and the only workflow builds the dashboard app |
| Tests that run against a real server | 0 | Every test uses `test/mock-bot.js`, which has no physics and no server. All four recurring bugs live in that gap |

### A likely root cause for the pillar failures (untested)

The pillar code logs the jump state, then calls `bot.placeBlock`. In mineflayer 4.39, `placeBlock` first awaits `bot.lookAt(centre of the block face)` without force. A non-forced look turns the head at 3 radians per second, 0.15 per tick, and only resolves when the yaw has arrived. A half turn takes 21 ticks.

Looking straight down at the block under your own feet, the yaw to the face centre is close to random, because the horizontal offset is nearly zero. So the place packet leaves between 0 and 21 ticks after the log line. A jump keeps the feet above +1.0 for only six ticks (ticks 3 to 8), and the current code starts the place at tick 5 or 6. That leaves two or three ticks of slack, about 17 to 26 degrees of turn.

This explains three things the logs could not:

- **Same logged state, different outcome.** The comment in `reach.js` says the same jump state placed 21 times and was refused 3 times, and concludes it is server timing. The log is written before the hidden wait, so it cannot see the difference.
- **The retry in #188 works.** By the second jump the head has finished turning, so the look returns at once.
- **The earlier fixes made it worse.** #169, #170 and #183 each moved the place later in the jump, which shrank the slack for the real cause.

It predicts that refusals cluster on the first block of a climb and after any sideways step. To check: log the position when the `block_place` packet is written, not when `placeBlock` is called. The likely fix is `bot._placeBlockWithOptions(ref, face, { forceLook: true, swingArm: 'right' })` and placing from tick 3. The same hidden wait sits behind all 25 `bot.placeBlock` calls in the repo, including torches and bridging.

## Ranked insights

Ranked by how much of Walter's time and how many repeat fixes each one removes per unit of work. Sections below expand the ones marked with a section name.

| Rank | Insight | Which pain it removes | Smallest first step |
| --- | --- | --- | --- |
| 1 | Every flagged incident becomes a server-run scenario that must pass before deploy (Eval) | Walter noticing bugs, fixes that regress | On any high flag, save the blocks within 12 of the bot, the bag and the current step to a file |
| 2 | One motor layer, five verbs, duplicates deleted (Architecture, below) | Pillar and jump loops, inventory drift | Point the four other pillars at the `reach.js` one |
| 3 | Rules enforced at the packet boundary from one rules file (Invariants) | Armor bypass, wrong tool tier, rule reversals costing five PRs | Wrap `bot._client.write` in log-only mode and list every armor click and over-tier dig by call site |
| 4 | Before and after by commit on the same bot (Eval) | Not knowing if a change helped | Tag each day's stats row with the commit the bot ran |
| 5 | Judge by what the server did, log at the wire (Architecture, below) | Fixes aimed at the wrong cause | Stamp position and held item when dig, place and click packets are written |
| 6 | One owner for the body, and steps that commit (Architecture, below) | Ladder bobbing, jump loops | Log every step change with Y level and count A, B, A, B runs |
| 7 | Failures carry a reason instead of vanishing (Types) | Silent retries, loops nobody can explain | Count refusals by reason in telemetry |
| 8 | Merge and deploy without hands (Autonomy) | Rebuilding the app, copying code to bot folders | Run the existing tests in CI |

### Architecture: one body

**One motor layer.** The bot has about a dozen things it physically does: look, walk, jump, place, dig, equip, click a slot, open a container, climb, pillar, bridge, attack. Each is implemented several times today, and each copy has its own timing bugs. A single `act` module should own these verbs. Each verb returns only after the server has confirmed the result, or returns a typed refusal. Everything above it (mining, tree farm, build, autopilot) calls verbs and never touches `bot.placeBlock`, `bot.dig`, `bot.equip` or `setControlState` directly.

This is where the bot's competence compounds. A pillar fix then fixes every pillar. It is also the only place where server timing knowledge needs to live.

**Judge by the server, not by mineflayer.** Mineflayer is a client model that guesses. Inventory drift (#159, #168, #177, #178) and refused placements are the same bug class: the code believed the client model. Motor verbs should treat an action as done only when the server's own update arrives, and telemetry should record what was sent on the wire. The pillar finding above is what this looks like in practice: the truth was one layer below the log line.

**One owner for the body.** With 73 `setControlState` calls and 51 timers, two loops can hold the jump key or fight over direction. A lease fixes this: a task asks the motor layer for the body, gets a token, and key presses without the current token are dropped and logged with both call sites. Jump loops where nothing is being placed are probably this, and the log would say which two modules were involved.

**Steps that commit.** The autopilot now has roughly 50 steps, each with a `need()` test, a budget in milliseconds and a cooldown, picked again from the top after each one. Ladder bobbing is the expected failure of that design: one step needs the bot at the bottom, another needs it at the top, and each one's work re-arms the other. A new detector will see it but not stop it. The fix is structural: a step that involves travel holds a commitment until its postcondition or a typed failure, and the planner prices the trip (a step that needs the surface waits until there are several surface jobs). To confirm, log step transitions with Y level for one day.

## Invariant enforcement

A rule enforced where code calls an action will leak, because there are too many callers. A rule enforced where packets leave the bot cannot leak, because there is one exit.

**The armor rule is still bypassable after #190.** The gate sits on `bot.equip`. Armor can also go on through `bot.clickWindow` with a shift-click, `bot.moveSlotItem`, a raw `window_click` packet (already written by hand in `reach.js` and `skills.js`), a right-click with armor in hand (`use_item`), and the vendored `mineflayer-armor-manager` plugin. None of these are known to fire today. Each is one stray code path away, which is how #188 was bypassed by a timer in `join.js`.

**The exit is `bot._client.write`.** Every action the bot takes is one of a few packet types. A gate there covers every module, every plugin, every timer and every piece of code a model writes later.

| Rule | Packet to check | Check |
| --- | --- | --- |
| No armor | `window_click`, `use_item` | Would the result put an item in slots 5 to 8, unless the rules file allows it |
| Minimum tool tier | `block_dig` | Held item tier against the block's need |
| Torch spacing, no stray surface blocks | `block_place` | Held item and target cell against nearby torches and open sky |
| Lava bucket never carried | position packets, `held_item_slot` | Lava bucket selected while position changes |
| Line of sight | `use_entity`, `block_dig`, `block_place` | Raycast from eye to target |
| Chat rate, no repeats | `chat_message` | Timestamps and last lines |

**Three layers, not one.** Prevent at the packet gate. Repair from state: if an armor slot is ever filled, take it off, whatever the cause. Detect with the existing telemetry flag. Today there is prevention at one call site and detection, with nothing in between.

**Run the gate in log-only mode first.** Each blocked packet records the call stack. After a day, that log is the complete list of stray code paths, found without Walter. Then switch to enforcing. A call site that is blocked many times a minute is itself a loop and should raise a flag.

**Prefer fixing to refusing.** For tool tier, the motor layer's `dig` verb should pick the tool, so no module chooses one. The gate then only catches strays. A refusal should come back as a typed result, because a thrown error inside one of the 397 empty catches becomes a silent retry loop.

**Rules as data, in one file.** The armor rule reversed in three days and the roadmap says it will flip again once Mending gear exists. Rules live today in `CLAUDE.md`, `ROADMAP.md`, the planner prompt, detector config and code comments. One `rules.json` should feed the gate, the detectors, the planner's prompt text and the docs. A rule change then costs one line and one PR. These stay the agreed rules of play from `CLAUDE.md`. The gate holds the bot to what it agreed to, and does not touch its free time or its choices.

**Test the rule, not the code path.** On the trial server, give a bot armor and iron tools, call module entry points at random for ten minutes, and assert that no forbidden packet left. This catches stray paths that nobody thought to write a test for.

## Eval and simulation loops

The pieces exist (mock tests, the trial server, the arena harness, per-day stats, telemetry windows) but nothing connects them, so no change is ever proven before it runs on a live bot. Three tiers, each gating the next:

| Tier | Runs on | Answers | State today |
| --- | --- | --- | --- |
| 0. Unit tests | Mock bot, seconds | Did the logic break | About 75 files, not run in CI |
| 1. Scenarios | Trial server, real physics, about a minute | Does the body do the thing against a real server | Skill and harness exist, no suite |
| 2. Live | The live bots, before and after a change | Is the bot better at Minecraft | Per-day stats exist (#155), not compared by commit |

### Incident to scenario, automatically

This is the highest-leverage item in the doc. The offline ladder harness in progress is one instance of it. The general form:

1. A high flag fires. The bot saves a snapshot: blocks within 12, its position and yaw, the bag by slot, the held slot, the running step, time of day, nearby mobs.
2. A script rebuilds that snapshot on the trial server with `/fill`, `/setblock`, `/give` and `/tp`.
3. The fail test is the detector that fired. The pass test is the step's own goal plus that detector staying quiet. The 10-minute reviewer can draft the pass test, which is a better use of it than prose findings.
4. The scenario joins the suite. The fixing thread must show it failing before the fix and passing after.
5. Every later PR runs the whole suite.

The telemetry module already keeps 150-second windows for validating detectors. This extends the same idea from validating detectors to validating behaviour.

### Gate on rates, not single runs

The server-timing bugs are probabilistic. The pillar comment records 3 refusals in 24 attempts. A single passing run proves nothing about a 12% failure, and a single failing log invites a fix tuned to that one trace. Each scenario should run 20 to 30 times and report a rate. A fix counts when the rate moves from 12% to 0 in 30.

### Parallel, not fast

Mineflayer's physics runs on a 50 ms real-time clock, so speeding up the server will probably not speed up the bot (worth one check with `/tick sprint`). Run many offline bots at once instead, each in its own 48-block cell of one flat trial world. Thirty runs of a 60-second scenario then take about a minute.

### Seed scenarios

Twelve scenarios would cover the last 20 PRs: pillar out of a 1x1 shaft from each of four facings and off-centre; pillar with a wall torch in the feet cell; ladder down 30 and up 30; craft at a table after a forced bag desync; torch a 30-block tunnel; dig mixed dirt, stone and logs with every tool tier in the bag; one autopilot minute with armor in the bag; remake the bed on respawn; stash to the storage room; dig next to water and lava.

### Give the hill a height

- **Competence ratios for the body.** For each motor verb, measure success rate and speed against what vanilla allows: ladder climb against 2.35 blocks a second, blocks mined a minute against dig-time tables, pillar blocks a minute against one per jump. A ratio near 1.0 means that verb is done. This says where the body is weakest without anyone watching.
- **Roadmap items as tests.** Phase 2 has 14 prose items. Each can be a predicate the bot checks against its own registry daily (laddered shaft recorded, storage room exists, spare bed at the mine). Phase progress becomes a number that moves on its own.
- **Before and after on the same bot.** Each day's numbers carry the commit the bot ran. Fast signals (flags an hour, refused actions, idle minutes) show within two in-game days, about 40 real minutes, whether a change made that bot worse than its own previous days. Slow signals (iron a day, deaths) confirm over a week. A change that makes the fast signals worse reverts itself.

## Autonomy: taking Walter out of the loop

Walter currently does five jobs the system could do: noticing bugs, describing them to a thread, approving merges, rebuilding the app, and getting code onto the live bots. Each has a specific replacement.

| Walter's job today | Replacement | What still needs him |
| --- | --- | --- |
| Noticing a bug while spectating | Detector flag, snapshot, scenario (Eval section) | Taste: things that are legal but ugly |
| Describing it to a thread | The snapshot and failing scenario are the bug report | Nothing |
| Approving merges | Merge on green: unit tests, scenario suite, rule fuzz | Changes to the rules themselves |
| Rebuilding the app | See below | One opt-in decision |
| Copying code to the bot folders and restarting | A deployer that pulls `main`, hot-reloads the bots and records the commit | Nothing |

**The app needs rebuilding because too much is baked into it.** The release workflow rebuilds the installer whenever `dashboard/` or `reviewer/` changes, and the main window only loads the dashboard URL. If the app ran the dashboard and reviewer from the repo clone on disk, only changes to the Electron shell would need an installer, which should be rare. Separately, `app/lib/updater.js` deliberately sets `autoDownload = false`. Turning on download and install at quit removes the last click. That changes software on Walter's computer, so it is his call.

**Run tests in CI first.** This is the cheapest item in the doc. The unit tests exist and the root `npm test` is a stub. One workflow that runs `node --test` on every PR catches logic regressions before anything else is built.

**The deployer is small.** The bots already hot-reload brain parts (`ap.reload()`). A scheduled task, like the reviewer's, can pull `main` into each bot's folder, reload, and write the commit hash into the day's stats. The live bots running from folders that are not the repo clone is itself a source of drift and should end.

**Walter's taste should be entered once.** His notes (torch spacing, one laddered shaft, no stray surface blocks, hotbar order) each arrived as chat, then became code in several places. The intake rule should be: every preference becomes one rules-file entry, one detector and one scenario in the same PR. If a preference cannot be written as a check, that is the moment to ask him one question, not after three wrong fixes.

**Report by exception, once a day.** One digest: phase progress, the weakest competence ratios, what was promoted, what reverted itself, and at most one question that needs his taste. Detector alerts go to the fixing loop, not to him.

**The bot can own part of this.** `CLAUDE.md` describes the bot as a player with its own goals, and `reflect.js` already has it reading its own death patterns. Letting the bot nominate scenarios from its own failures fits that role. Its free-time slot should be excluded from idle metrics, so the hillclimb never optimises its whimsy away.

## What to stop doing

Each of these feels like progress and is the reason the same bugs return.

- **Stop shipping a fix from one log trace.** No behaviour PR without a scenario that failed before and passes at a measured rate after. This rule alone would have stopped five of the six pillar PRs.
- **Stop answering a behaviour bug with only a detector.** #187 added a ladder-bobbing flag. The bot still bobs, and now it is reported. A detector is the fail test of a scenario, not a fix.
- **Stop tuning timers and budgets by feel.** #143, #146, #149, #165 and #184 each change a number (ticks before dusk, cooldown seconds, a six-minute budget) with nothing measured before or after. Leave numbers alone until a scenario rate or the before-and-after numbers can show a difference.
- **Stop adding steps to `plan.js`.** It is 147 KB with about 47 ordered steps. Every new step adds interactions with all the others. New capability should be a motor verb or a registry entity, with the planner choosing among them.
- **Stop enforcing rules inside modules.** #172 and #173 each taught one module about armor. The next module will not know.
- **Stop writing motor code inside feature modules.** No new jump, place, dig or equip sequences outside the motor layer.
- **Stop using code comments as the regression memory.** There are about 160 comments carrying incident times and dates. They explain a fix to the next reader but protect nothing. The incident belongs in a scenario.
- **Stop trusting the mock for physical behaviour.** The mock bot encodes the same beliefs about the server as the code under test, so both are wrong together.
- **Stop empty catches on actions.** A swallowed refusal is how a bot jumps in place holding a sword.
- **Stop routing alerts to Walter.** If he is the one who reads `REVIEW-ALERTS.md`, the loop still runs through him.
- **Do not rewrite.** None of this needs a new framework. Wrap the exits first (packet gate, motor verbs), then move callers over one module at a time.

## Are stronger type primitives needed?

Yes, a small set, at the motor and gate boundary only. A TypeScript migration of 30,000 lines is not worth it. The code has no types at all today: no `@ts-check`, no JSDoc typedefs, no lint config, and 64 places that `JSON.parse` a state file with no validation.

Types matter more here than on a human team. The authors are fresh threads with no memory of the last incident. A comment saying "budget is in milliseconds" can be missed. A type cannot.

| Primitive | What it replaces today | Bug class it removes | Needed |
| --- | --- | --- | --- |
| `Outcome`: ok, or refused with a reason, who refused (server, rule, precondition) and whether a retry can help | `true`, `false`, `'explore'`, `'fail'`, thrown errors, 397 empty catches | Silent retry loops. Planner cannot tell "no path" from "server said no" | Now |
| `Held` proof: a token only the motor `equip` verb can mint after the server confirms the hand, void on any slot change | Checking `bot.heldItem` by name at some call sites | Jumping in place with a sword (#177), wrong tool in hand | Now |
| `Cell` (whole block), `Pos` (feet, fractional), `Eye` | 250 `new Vec3`, `[x, y, z]` arrays in state (50 index sites), string keys, 64 hand-written `Math.floor` on Y | Off-by-one and feet-versus-block errors in shafts, ladders and placement | Now |
| `Permit`: a job-scoped licence to dig or place in a region, passed to the motor verb and checked at the gate | `force: true`, per-module no-dig lists, the agreed-job rule living in prose | Stray surface blocks, digging the house, rule 3 being unenforceable | Now |
| `Ticks`, `Ms`, `DayTime` as distinct number types | Step budgets in ms next to daylight in ticks, 148 raw numeric waits | Unit mix-ups, timing that only works at 20 TPS | Soon, cheap |
| `BodyLease`: the token for control keys | 73 direct `setControlState` calls | Two loops fighting over jump or direction | With the motor layer |
| `ItemQuery`, resolved at the moment of use | Holding an `Item` object across awaits | Acting on an item that left the bag (the phantom dirt in `skills.js`) | With the motor layer |
| Schemas for `Rule`, `Shaft`, `StorageRoom`, `Camp`, `Home`, validated on load, with a version | 54 state files read raw | A malformed or old registry file silently changing behaviour. The roadmap adds more registries (travel and nether networks) | Before the travel network |

**How to adopt without a migration.** New motor, gate and rules files start with `// @ts-check` and JSDoc typedefs, and CI runs `tsc --noEmit` on those folders only. Because modules hot-reload and some code is model-written, the same shapes are also checked at runtime where data crosses a boundary: state files, the planner's chosen action, and reviewer-written detectors.

**What not to type.** `plan.js` and the feature engines. They should shrink as callers move to motor verbs, and typing them first would freeze the wrong design.

The two that pay back fastest are `Outcome` and `Permit`. `Outcome` makes failure countable, which every eval in this doc depends on. `Permit` turns Walter's rule 3 from prose into something the gate can check.

## Would Haiku subagents improve these recommendations?

Yes for evidence, no for judgement. The ranking of the top three would not change. What would change is how much of this doc is measured instead of inferred, and the order of ranks 4 to 8.

This doc rests on four kinds of claim, and only the first is solid:

- **Counts from the code** (call sites, catches, commits). Solid, but shallow. They count names, not behaviour.
- **One hypothesis from reading mineflayer's source** (the pillar look wait). Untested in game.
- **Inferred causes** (ladder bobbing from step alternation, jump loops from key conflicts). Plausible, unverified.
- **Assumptions about the live setup** (which folders the bots run from, whether the model planner is on). Taken from notes up to two weeks old.

Haiku agents are well suited to closing these gaps, because each check is narrow, mechanical and independent.

| # | Check | Type | What it would settle |
| --- | --- | --- | --- |
| 1 | Pillar on the trial server, 30 runs each of four variants: current code, `forceLook: true`, place from tick 3, both. Record refusal rate, yaw change at the call, ticks from call to packet | In game | Whether the look wait is the root cause |
| 2 | Read the existing pillar logs: do refusals fall on the first block of a climb or after a sideways step | Live logs | Same question, with no new run |
| 3 | Does `/tick sprint` speed up a mineflayer bot's actions | In game | Fast versus parallel scenario design |
| 4 | Ladder up and down 30 blocks, 20 runs: speed against 2.35 blocks a second, reversals | In game | Whether bobbing is a body bug or a planner bug |
| 5 | Step transitions with Y level over the last 24 hours: count A, B, A, B runs and name the pairs | Live logs | The cause of ladder bobbing |
| 6 | Packet gate in log-only mode with armor and iron tools in the bag, module entry points called at random | In game | The full list of stray armor and tool paths |
| 7 | Every direct actuator call by file and line, and whether its result is checked against the server | Code census | Size and order of the motor-layer migration |
| 8 | Line-by-line differences between the five pillars and between the ladder code paths | Code census | Which copies carry which old bugs |
| 9 | Classify the 397 empty catches: wraps an action, or harmless cleanup | Code census | Where `Outcome` matters first |
| 10 | Classify all 194 commits: new capability, repeat fix, number tweak, rule change, tooling. Mark symptoms that came back | History | The real repeat-fix rate, which this doc estimates from titles only |
| 11 | Every place a rule is stated (docs, planner prompt, comments, detector config) and where they disagree | Code census | Contents of the rules file. One conflict is already visible: the planner's `equip_gear` tool still says "Wears the best armor you have" |
| 12 | Every numeric wait, budget and cooldown with its inferred unit | Code census | Whether `Ticks` and `Ms` types are worth it |
| 13 | Flags an hour by type and day, and for each bug whether a detector or Walter saw it first | Live logs | How much noticing the detectors already do |
| 14 | Share of autopilot steps chosen by the model planner versus the routine list | Live logs | Whether "think first" is still true in practice |
| 15 | Do the live bot folders match `main` | Live setup | Deployer priority |
| 16 | One sceptical reader per ranked insight, looking for counter-evidence in the repo, such as how much of a motor layer `skills.js` already is | Review | Errors in this doc |

Checks 1 to 6 need the trial server or the bot folders on Walter's laptop. Checks 7 to 12 and 16 need only the repo. Checks 2 and 5 are the cheapest and settle the two biggest open questions.

## Suggested order of work

Each step is useful alone and makes the next one cheaper. The first four are a day's work in total and need no design decisions.

1. **Test the pillar hypothesis** from the existing logs (Haiku check 2), then on the trial server (check 1). If it holds, one option change fixes pillar and likely several placement oddities.
2. **Run the unit tests in CI** on every PR.
3. **Packet gate in log-only mode** on both live bots for one day. Read the list of stray paths.
4. **Tag per-day stats with the commit** each bot ran, and log step transitions with Y level.
5. **Snapshot on high flag**, and a script that rebuilds a snapshot on the trial server. Fold the ladder harness into this as its first scenario.
6. **Seed the suite** with the twelve scenarios, run 30 times each in parallel. Record today's rates as the baseline.
7. **Motor layer, pillar and place first.** Start from the `S.*` helpers in `skills.js`, which are already a partial shared layer for the autopilot. Move the other four pillars onto it and delete them. Add `Outcome` and the `Held` proof here.
8. **Rules file and enforcing gate.** Armor, tool tier and torch spacing move out of modules. Add `Permit` for dig and place.
9. **Deployer.** Merge on green, hot-reload the bots, and revert if the fast signals get worse than the same bot's previous days.
10. **Body lease and step commitment**, guided by what step 4 logged.
11. **Roadmap predicates and the daily digest.** From here Walter reads one message a day.
