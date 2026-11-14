# Hands-off hillclimbing loops: a guide to recreating this project's self-improving loop anywhere

2026-11-11. Written for Walter, from what MC-Player actually built, broke and fixed, not from theory. Sources: `docs/MEMORY-LOOP.md`, `docs/DEPLOYER.md`, `docs/HILLCLIMB-INSIGHTS.md`, the merged PRs #281 to #332, and the project memory.

**How to read this.** Part 1 is the build guide: what the loop is, why the blog post alone does not get you there, the pieces, the rules, what went wrong, and a recipe you can hand to Claude in any project. Part 2 answers "what do I study?" and gives you the vocabulary. If you only have ten minutes, read "The idea in one page", "What went wrong", and "The short answer" in Part 2.

---

# Part 1. How to build the loop

## The idea in one page

You want a system that gets better while you are away. That needs two separate loops, and people usually build only one.

- **The memory loop** changes what the actor *knows*. The actor (here, a Minecraft bot) writes down what happened, a nightly-style job checks its notes against that record and corrects them, and the next session starts by reading the corrected notes.
- **The code loop** changes what the actor *is*. When a problem is one that notes cannot fix (a step that stalls 300 times is a bug, not a lesson), a ticket is opened, an agent writes a fix with a test, the fix is shipped, and the result is judged against the actor's own earlier performance. A bad result is rolled back.

Both loops start and end at the same place: the actor playing. In this project's dashboard picture, the actor sits at the left, and each loop goes out from it and comes back in as "today's plan" (memory loop) or "new code" (code loop).

The stages, in plain words:

| Stage | Plain meaning | Reads | Writes | Uses a model? |
| --- | --- | --- | --- | --- |
| **Journal** | A diary the program keeps of everything it does, one line per event, in one searchable place | the logs it already makes | one file per day plus a rollup | No |
| **Memory** | A small notebook with a hard size limit | its own journal | policies, traps, wishes | Written by the actor and the dream |
| **Dawn brief** | The start-of-day plan: the actor reads its notebook and the latest findings and decides focus, what to pause, and what to do with free time | memory, journal, findings | `brief.json` | Yes, one short call |
| **Detectors** | Cheap always-on alarms ("it is pillaring wrong", "it stood still") | live telemetry | flags | No |
| **Review** | A model looks at the flags and the recent record and says what looks wrong | telemetry, flags | findings | Yes |
| **Dream** | A job that checks the notebook against the journal, deletes what is wrong, and opens tickets for what only code can fix | memory, journal, findings | corrected memory, work orders | Yes, several small calls |
| **Work order** | A ticket with a stable key, a cost in lost minutes, and a life story | journal | `work-orders/<key>.json`, ledger | The model only says "is this a bug?" |
| **Fixer** | A fresh agent session that takes the costliest ticket to a pull request, with a test that fails before and passes after | work order, evidence | a PR | Yes, one session |
| **Deployer** | Puts the merged change on the live system, waits, judges, and reverts if worse | `main` | deploy log, verdict | No |
| **Digest** | One page a day for the human, with at most one question | everything | a page | No |
| **Audit** | A second, stronger reviewer that checks the whole chain is actually closing | run records, job status | a verdict | Yes, no tools |

## Why pasting the blog link was not enough

The Anthropic article ("The components of agent memory", https://www.anthropic.com/research/components-of-agent-memory) is about **memory**: four layers (transcripts, notes, representations, injected context) and a background process called dreaming that moves knowledge up through the layers and checks it against the record. It is a good picture. It is not a build plan, and the distance between the two is where the time went. The gaps, each of which this project hit:

1. **The article describes one loop; you need two.** It explains how an agent's notes improve. It does not cover what to do when the problem is a bug in the agent's own code. In this project the dream's most valuable output was not a better note but a work order. The code loop (fixer, deployer, verdict, revert) is the part the article leaves out, and it is what removes the human from the bug-report business.
2. **A memory with no reader is a diary.** The model planner had been off on both bots since 2026-11-04, so nothing in the game read `lessons.md` or `strategy.md`. The first design decision was not "how do we write memory" but "who reads it at the start of a session, and what do they do differently". Here the answer was the dawn brief and a picker that obeys it, within limits.
3. **A transcript has to be searchable before dreaming can check anything.** The raw material was a 256 MB log, an 8.8 MB log, and a notes file that was 91% watchdog alarm lines. The journal (one JSON line per event, daily rollups, salience tags set by code) had to exist first.
4. **Results for one model do not transfer to yours.** The article's good results came from stronger models, and some had to be told outright to read memory first and to test a rule before keeping it. Walter's rule was that every scheduled job runs a small, cheap model so the loop can run often. That changes the design: jobs are narrow (the dream is five short calls, not one long session), and **code does every check that code can do**.
5. **Nothing in the article ships, judges or reverts.** Deploy, verdict and rollback are release engineering. They had to be built, and then they broke in ways the article could not warn about (see "What went wrong").
6. **A design is not an installation.** Seven stages on a schedule means seven things registered on a real machine with real credentials (a scheduler entry per job, a GitHub login for the fixer, an app update so the live code has the new modules). A loop with one uninstalled stage looks fine and does nothing.
7. **Someone has to watch the watchers.** Without an explicit check on the whole chain, a broken stage is silent. That became the Loop Audit.
8. **Who owns what is a design decision.** Several writers on one file lost facts in the article's own experiment (41 of 57 kept, against 57 of 57 for one writer). Here the bot owns its wishes, the dream owns corrections to policies, Walter owns the rules file, and a store refuses writes outside your lane.
9. **Autonomy needs a budget and a floor.** Hands-off does not mean unbounded. Every stage here has a cap (see the caps table), and some things no job may ever touch (the rules file, the free-time slot, `CLAUDE.md`).

The practical consequence: do not give Claude the article and say "build this". Give it the stages, the rules, the caps and the pre-flight checklist below, and ask it to build one stage at a time with a smoke test each. A starter prompt is at the end of Part 1.

## The primitives

These are the reusable parts. Each has a plain definition, the rule that makes it work, and the form it took here.

### 1. The journal (the record)
- **What.** An append-only event log, one line per event, with a daily rollup (per step: runs, successes, failures, stalled minutes; flags by kind; deaths; items gained; which commit was running).
- **Rule.** Built by code from logs that already exist, with no model. Tags that mark important events (a death, a first-time event, a blocked action, anything a person said) are set by code. Keep 30 days.
- **Why it matters.** Every later stage treats it as ground truth. If you cannot answer "how often did X happen this week, and did the last fix change it" with a lookup, you cannot close the loop.
- **Here.** `brain/journal`, `tools/journal.js`.

### 2. Memory (the notebook)
- **What.** A small folder: one short main file read at every session start, a few topic notes, a record of each change.
- **Rules.** Hard size caps enforced in code (a write that would pass a cap is refused, so the writer has to cut first). One owner per section. Never store what the actor can see for itself (its bag, position, nearby chests). Every policy carries three parts: the rule, how we know it is true, and how to check it still is. Every write is a commit, so it can be undone.
- **Here.** `global.md` capped at 60 lines, at most 10 notes of 150 lines, every policy as `rule | how I know | check`. `brain/memory`.

### 3. The reader (session start)
- **What.** The moment the actor loads memory and acts on it. Without this, none of the rest matters.
- **Rules.** Make it a decision the actor can disagree with, inside limits that code enforces: a hold cannot pause a survival step, at most three holds of at most three in-game days, step names must be real, a brief expires after three hours. If the job is not installed or fails, the actor plays exactly as it did before, so the loop is never a single point of failure.
- **Here.** The dawn brief (`reviewer/lib/brief.js`, `brain/autopilot/whimsy.js`). The bot asks for a brief at dawn (at most hourly) and after a respawn (at most every 10 minutes); the laptop answers; the bot checks and applies it.

### 4. Detectors (cheap alarms)
- **What.** Small deterministic checks that run all the time with no model: pillaring wrong, wrong tool, torch spacing, idle stall, chat spam, armor carried, leftover scaffolding, trampled farmland.
- **Rules.** Flag-only (they can never stop or change the actor). Their flags go to the journal. The review model may *propose new detectors*, but code validates each proposal against captured real windows before it is enabled, caps its severity, mutes one that throws or fires on nearly every pass, and limits the total to 12. This is the smallest real example of judgement turning into routine code.
- **Here.** `brain/telemetry`, `reviewer/` section 3, `brain/leftovers` (PR #318).

### 5. The dream (the checker)
- **What.** A scheduled job, every two hours here, that tests the notebook against the journal.
- **Rules.**
  - The model gets no tools. Code gives it numbered facts and the answer is a small JSON object that code applies.
  - A change must cite a fact id that was handed over (two for an addition). An invented id cancels the change. "The facts do not mention it" is not grounds for deletion.
  - Small steps: at most four corrections, three cuts and two additions per dream. A line it changed is left alone for 12 hours.
  - It touches only Policies and Traps. It never sees the actor's own wishes, and the store refuses a write that changes them.
  - It tells the actor what it changed and why, so a line can be put back.
  - If code can see there is nothing new, it makes no call at all.
- **Five steps, five short calls:** correct, cut, demote detail to a note, fill gaps across days and bots, hand off.

### 6. The work order (the ticket)
- **What.** The bridge between the memory loop and the code loop. A problem memory cannot fix becomes a ticket.
- **Rules.** Code computes candidates and gives each a stable key (`step-iron`, `death-<cause>`, `flag-<kind>`), so one problem keeps one ticket however it is described. Cost is computed by code in minutes lost. The model only says whether a candidate is a bug and writes the problem statement. Code opens at most four new orders per dream, costliest first, and remembers a "not a bug" for a day. An order nobody has seen for six dreams of a running bot closes with the commit the bot moved to named as the likely cause. If it returns, it reopens and the reopen is counted. An order carries its whole life: opened, PR, deploy, verdict.
- **Here.** `reviewer/lib/orders.js`, `ledger.jsonl`, `WORK-ORDERS.md`.

### 7. The fixer (the repairer)
- **What.** A fresh agent session per run, in its own copy of the code, that takes one ticket to a checked pull request.
- **Rules.**
  - Tools are narrow: file tools limited to its copy, run one file, run the tests, read git history. No shell, no web, no push. Every tool call passes a gate in code first.
  - It follows a debug loop: find the cause, write a test that fails because of it, fix it, run the suite. If it cannot make the fault happen, it ships telemetry that will catch it next time, not a guess. If it can do neither, it gives up and writes what it tried.
  - **Code checks what the session left and does not take its word.** Only allowed paths changed (never the rules file, the memory module, the free-time module, `CLAUDE.md`, `package.json`, the test runner or the loop's own jobs). There is a new test that fails on `main` and passes with the change. The whole suite passes. No laptop path, name or address leaks into the change. A failed check gets one repair session, then the change is thrown away.
  - Escalate to a human, with one question in the digest, when the change edits an existing test, removes free-time lines, exceeds 400 lines, or its test fails on `main` only for a missing file.
  - Two failed attempts park the order with what was tried.
- **Cost.** About 50 cents to a dollar of usage per session, against about 4 cents for a dream. First real trial: 17 minutes, 61 tool calls, a sound four-line fix (merged as PR #302).

### 8. The deployer, verdict and revert
- **What.** Ships the fix and judges it against the system's own recent past.
- **Rules.** Refuses a clone with local changes. Runs the tests on the candidate in a scratch checkout before touching anything. Never deploys on top of an unjudged deploy, so a verdict is about one change. Waits 40 minutes, compares weighted flags per hour with the same-length window before, and treats at least 1.5 times and at least 6 more as **worse**, which takes the previous commit back and marks the bad one so it is not redeployed until `main` moves on. Each actor is compared only with its own earlier hours, never with another actor. Every action is a line in a deploy log, and each day's numbers are tagged with the commit that ran, so before and after is a lookup.
- **Slow signals** (iron per day, deaths) are not in the verdict window; they go to the daily digest.

### 9. The digest (the human interface)
- **What.** One page a day: what each actor asked you for in its own words, deaths and lost minutes, the costliest orders and what happened to them, deploys and reverts, which jobs failed, and **at most one question**, asked once.
- **Rule.** No model. The human is asked almost nothing, and what they are asked is chosen by code.

### 10. The audit (the watcher of the watchers)
- **What.** Every six hours a stronger model (Sonnet 5.5, high effort here) reviews the whole chain.
- **Rules.** Code gathers facts and applies hard rules first: a job not installed, a job that has not run for three of its periods, bots silent, questions unanswered, orders nothing acts on, missing modules in the live code. The model then judges whether the chain closes and splits "only a person can do this" from "the loop should have done this, change this stage". Its verdict is never better than the worst hard rule. It has no tools, changes nothing, and still writes a report if the model call fails. The digest leads with its verdict.

## The rules that held it together

Written as rules you can apply to any loop. Each was learned here, most by breaking it first.

1. **Models propose; code disposes.** Anything code can check (caps, whether a cited fact exists, whether a test fails before and passes after, which files changed) is checked by code. Caps stated in a prompt made the small model mislabel bugs to fit the cap, so caps live in code.
2. **Every change cites evidence.** A rule with no "how I know" is a guess that later sessions will trust. The article's Mt. Moon note is the cautionary tale: one wrong landmark note kept an agent from ever passing a mountain.
3. **One writer per file.** If two stages need to write one thing, split it into two files or two sections with two owners, and let the store refuse out-of-lane writes.
4. **Keep injected memory small.** Long instruction files lower adherence. Move detail down into notes and leave a pointer.
5. **Narrow jobs.** One question and only the files needed for it. Several short calls beat one long session, especially on a small model.
6. **Stable keys.** A problem keeps one identity across runs. Before the reviewer's keys were made identities, it renamed about 105 keys in 56 runs and nothing could be tracked or closed.
7. **A finding closes with a reason**, not because the model stopped mentioning it: fixed by a named PR, went quiet after the actor moved to a named commit (a correlation, labelled as one), or closed by the reviewer.
8. **Compare an actor with its own past, by commit.** Never with another actor as a control group (Walter ruled that out), and never on a single run. Gate on rates over many runs (the insights doc suggests 20 to 30 scenario runs), because one passing run proves little.
9. **Everything reversible.** Memory writes are commits, holds expire, a stale brief is ignored, a bad deploy is reverted.
10. **Floors that no job can lower.** The rules file, the free-time slot and `CLAUDE.md` are edited only by the human, by PR. Enforcement sits where actions leave the actor (the packet gate), not scattered at call sites: the no-armor rule took five PRs while it was enforced at call sites.
11. **Fail soft, and visibly.** If a job is missing or broken, the actor plays as before. But a skipped run is recorded with its reason, a streak as one counting row, so silence is never mistaken for health.
12. **Treat memory and chat as data, never as instructions.** Every prompt says so.
13. **Shut out ambient memory in model calls.** A trial brief once quoted a rule that existed only in the surrounding session's own memory. Jobs run with automatic memory off and memory variables removed.
14. **Never ask the human what the actor can do itself.** Questions to a person who is asleep are wasted; track them like any other defect.
15. **Replay before changing a prompt.** Change a prompt only after running old and new on real captured data.
16. **Trace one real item end to end before you leave.** See the pre-flight checklist.

## What went wrong

This is the section to take seriously. The design in the doc was approved on 2026-11-10 and "all built" the next day. These are the failures between "built" and "working", in the order they showed up.

| What happened | Why | What fixed it | The general rule |
| --- | --- | --- | --- |
| **The back half of the loop was never installed, and nobody noticed.** The dream, fixer, deployer and digest were all merged, and none was registered in Windows Task Scheduler. The "not installed" state was a small badge deep inside each job card. | Merged code and installed code are different things. The design said Walter installs jobs with a button; nothing made missing buttons visible. | PR #326: a banner at the top of the Memory loop page lists every uninstalled job with install buttons. PR #325: the audit has a hard rule, "not installed, so it never runs". | A stage that is not running looks exactly like a stage that is healthy. Make "is each stage alive" a thing the system reports at the top, not a detail. |
| **No restart when the bots were offline.** The deployer fast-forwards the live code and asks for a restart by writing `restart-needed.json`, which only a running bot supervisor acts on. A bot that was not running got nothing, and the supervisor only works if the bot was started once on code that already has it. | The deploy path assumed a live supervised actor. | The audit now has a rule: a bot silent for over 30 minutes is "not running, and nothing restarts it", and it reports a missing `node_modules` before the next restart can crash on it. Starting a bot once on the new code is a human step. | Design every stage for the case where its neighbour is dead. Ask "what happens if the thing I hand off to is not there?" and make the answer a recorded alarm, not silence. |
| **The bots asked the human 15 questions in 14 hours** (why a tool-kit makes nothing, a chest, 3 iron ingots), at times when nobody was awake. No stage consumed them. | The dawn brief allowed one ask per brief. The ask went to a person, and a person is the slowest and least available stage. | PR #322: three asks in a day open a work order (`bot-asks`) written by code, so the fixer takes it. PR #332: the same question within 12 hours is dropped and the bot is told to decide for itself; the prompt says never to ask for what it can do itself. | Every question a hands-off actor asks is a symptom. Count questions, turn repeats into tickets, and make "decide for yourself" the default. |
| **The deployer deleted the live `node_modules`.** On 2026-11-11 the first two deploy runs removed 20 packages from the folder both live bots share. | The test checkout borrowed `node_modules` through a link (a junction on Windows). `git worktree remove --force` followed the link and emptied the real folder. | PR #324: remove the link first, delete the checkout only when no link is left. The audit now checks that required modules exist in the live code. | Anything that automates deletion must be tested against shared state, not just scratch state. A link is a pointer to something that is not yours. |
| **A stale lock blocked deploys for 45 minutes.** An app update killed a scheduled deploy mid-test; its lock then stopped every later deploy and left a scratch checkout. | A lock written by a process that no longer exists. | PR #330: a lock held by a dead process counts as stale at once. | Every lock needs an owner check, not only a timeout. Scheduled jobs get killed by the very updates the loop ships. |
| **A red `main` froze everything silently.** Deploys are refused when tests fail on `main`, and a sound fix was once refused because another merge had left an unrelated test red. | "Tests must pass" is correct, but nobody owned a red `main`. | PR #332: a red suite on `main` opens an order (`main-tests-red`), the costliest one; the next deploy that gets through closes it. A failing test that also fails on `main` is not held against a change. | A gate that can block the whole pipeline needs its own ticket and its own owner. |
| **The loop only closed once the Fixer actually ran.** The front half (journal, brief, dream, orders) worked and piled up tickets. The screenshot you pasted shows 31 open orders and 2,311 minutes of play lost, while the Fixer had only just opened a fix. Evidence and tickets with no repairer is a very tidy way to watch things stay broken. | The first fixer pass only ran every three hours on one order. | The fixer now works through orders back to back until none is left to take (cap 6 runs or 4 hours). The first real fix was PR #302. | "Closed loop" means one item travelled evidence, ticket, fix, deploy, verdict, close, on the real machine. Until that has happened once, you have a pipeline, not a loop. |
| **Findings dead-ended.** The reviewer ran 111 times in a day and raised 185 distinct findings, 120 of which appeared in two runs or fewer. A finding "resolved" when the model stopped mentioning it. | No consumer, and unstable keys. | Stable keys, closing reasons, and two consumers (the bot reads its open findings at dawn; the dream turns a recurring one into an order). | An alarm with no consumer is noise. Every output needs a named reader. |
| **The notes file was a transcript.** `lessons.md` had 3,464 lines, 91% watchdog alarms, and was read by nothing. | Logging into the notes layer, and "record only failures", which the article found harmful. | Alarm lines go to the journal; notes are written at the session boundary by a model, capped. | Do not file transcripts under notes. |
| **Rules were written by hand in many prompts and went stale.** The planner prompt still said "armor is wanted" after armor was banned. | Several hand-written copies of one rule. | Rule text generated from one rules file. | One source of truth, generated into every prompt. |
| **Smaller things**: the fixer's own tools inherited a 60-second limit from the environment; a session ended in prose instead of the answer form; the app installer carried a 346 MB bundled binary so updates took minutes with no sign of life; a test depended on one day of the owner's data. | Environment defaults and unstated assumptions. | Set limits explicitly, demand the answer form, show progress, test structure not one day's data. | Set every timeout and limit explicitly. Do not inherit defaults you have not read. |

**What we do not know yet.** The loop now closes mechanically. The doc's own measures (threads Walter opens to report bugs, time from first flag to judged fix, lost minutes per step, orders reopened after "fixed") were mostly "not recorded" when the design was written, and the schematic agent had not yet run on a live model when this was written. Treat this as a working pipeline whose improvement effect is still to be demonstrated. The design includes the right test: run a day with a component off and a day with it on, same commit, same actor, and compare lost minutes.

## Caps and budgets

Caps are what make "hands-off" safe. Every number here is one line in a config file or a constant in code, never a sentence in a prompt.

| Where | Cap | Reason |
| --- | --- | --- |
| Memory | `global.md` 60 lines (dream may add only below 40), 10 notes of 150 lines | Small injected context; room left for the actor's own lines |
| Dream | At most 4 corrections, 3 cuts, 2 additions per run; a changed line rests 12 hours; no call if nothing new | Small steps, no churn |
| Dream gap-filling | At most 2 new lines, every third dream | Slow growth |
| Work orders | At most 4 new per dream; "not a bug" remembered for a day; closes after 6 unseen dreams | Stop ticket floods |
| Dawn brief | Ask at most hourly and after a respawn at most every 10 min; at most 3 holds, each at most 3 in-game days; brief expires after 3 hours; same question within 12 hours is dropped | Bounded influence and bounded asking |
| Asks to the human | 3 asks in a day opens an order; digest has at most 1 question, asked once | Humans are scarce |
| Detectors | At most 12 custom detectors; severity capped at medium; muted if noisy or erroring | A model-written detector must not be able to cause harm |
| Fixer | One order per run, up to 6 runs or 4 hours in a pass; session up to 40 minutes; two failed attempts park an order; change over 400 lines goes to a human | Bound cost and blast radius |
| Deploy | No new deploy inside the 40-minute judging window; "worse" means 1.5 times and 6 more weighted flags | One change per verdict |
| Schematic agent (a model-made artifact that bots may request) | 25 calls a day for both bots together, 3 waiting at once, adjustable by the human; bots may only request new schematics or variants, never edit an existing one; the queue runs one at a time and only while the app is open | A tool that can spend money gets a daily cap and a queue |
| Cost reference | Dream about 4 cents; fixer 50 cents to a dollar; brief about 1 cent; review about 4.8 minutes and a few cents per run | Know your unit costs before you pick cadences |

## How to recreate it in any project

### Translate the vocabulary first

| Here | In your project it is |
| --- | --- |
| The bot | Whatever acts and can fail: a service, an agent, a data pipeline, a content process, a CI bot |
| Journal | Structured logs and events you already emit, normalised into one searchable place |
| Telemetry and detectors | Metrics and alerts (and cheap rule-based checks) |
| Dawn brief | The start of a run or a day: the actor reads its notes and picks a plan |
| Death, stall | Whatever failure you can count and cost in time or money |
| Scenario or trial server | A test environment where a failure can be replayed |
| Rules file | Your policy and safety constraints, edited by humans only |
| Pull request, merge | Whatever your change process is |

The one thing every project needs that a game gives for free is **a reality check you trust**: a test suite, a replayable scenario, a metric, or a human spot-check. If you cannot say how a fix is verified, build that first. It is what the fixer's "test that fails before and passes after" and the deployer's verdict stand on.

### Build order

Each phase is useful alone, ships switched on, and has a smoke test. Do not start the next until the smoke test passes.

| Phase | Build | Smoke test (done means this) |
| --- | --- | --- |
| 0 | **Record.** Journal, rollups, commit tagging per day. | Answer "how often did X happen last week?" with a lookup, no script. |
| 1 | **Detectors and flags**, cheap and model-free. | Cause a known failure on purpose and see the flag. |
| 2 | **Memory with caps, and a reader.** Notebook, size caps in code, session-start brief that changes behaviour inside limits. | Change a policy line and watch the next session act differently. Remove the job and confirm the actor still works. |
| 3 | **Review and the dream.** Stable keys, closing reasons, evidence-cited changes. | Insert a wrong policy and see it removed with a cited fact. Insert an invented fact id and see the change refused. |
| 4 | **Work orders with costs.** Candidates by code, a ledger. | One recurring problem produces one order, not five, and its cost moves when the problem moves. |
| 5 | **Fixer with code-side checks.** | A seeded bug becomes a PR whose new test fails on `main` and passes with the fix, with no human in between. |
| 6 | **Deployer with verdict and revert.** | Ship a deliberately bad change to a test actor and watch it come back out. |
| 7 | **Digest and audit.** | Switch one stage off and see the audit say so within one period. |

### Pre-flight checklist: before you walk away

Run this on the real machine, not in a test.

- [ ] Every scheduled job is **installed and has run at least once** (the page lists none as missing).
- [ ] The credentials the fixer needs (for example a logged-in GitHub client) are verified by a real run, not assumed.
- [ ] **Trace one real item** from evidence to ticket to fix to deploy to verdict to close.
- [ ] **Kill the actor** and confirm something notices and restarts it (or the audit raises it within an hour).
- [ ] Run the deploy path with the actor **offline** and with a **dead lock file** present.
- [ ] Confirm no automated step deletes or overwrites a **shared** folder (links, junctions, caches).
- [ ] Confirm `main` red produces a ticket, not silence.
- [ ] Count the questions asked to the human in a night. More than a few means a defect, not a feature.
- [ ] Confirm the human-only files really cannot be edited by any job.
- [ ] Set every timeout and cap **explicitly**.
- [ ] A skipped or failed job leaves a **recorded reason**.
- [ ] Put the "is each stage alive" summary at the **top** of the human's page.

### A starter prompt to give Claude in a new project

> I want a hands-off improvement loop for this project, modelled on MC-Player's. Read the guide (paste or attach it) and build it **one phase at a time**, from the build order table, finishing each smoke test before starting the next. Rules: models propose and code checks (caps, evidence citations, "test fails before and passes after" are all checked by code); one writer per file; every change cites evidence; stable keys for problems; every job narrow, with its caps in code; every skipped run recorded with its reason; no job may edit the rules file. Start with phase 0 and tell me what the project's equivalent of "a reality check I trust" is. Before you call it done, run the pre-flight checklist on the real machine and report which items you could not verify.

---

# Part 2. What to study

## The short answer

It is not graph engineering. A graph (nodes and arrows) is a way of drawing a workflow, and tools like LangGraph let you write one in code, but the diagram is not the discipline. What you built is a **closed-loop system around an AI agent**, and the skills behind it come from several older fields stacked together. The closest single label for the new part is **agent engineering**, and its sub-field **harness engineering**: designing everything around the model (its tools, its permissions, its memory, the scaffolding that checks it, the schedule it runs on) as opposed to the model itself. Everything else on the list is a mature discipline with books, so you do not have to invent the vocabulary. You borrow it.

Think of it as five questions, each owned by a field:

| Question | Field | Plain meaning |
| --- | --- | --- |
| How do I make an agent do useful work, safely? | **Agent engineering / harness engineering**, including **context engineering** | Tools, permissions, what goes into the model's prompt and when, memory |
| How do I know it is getting better? | **Evals** (evaluation) | Repeatable tests of agent behaviour, scored on rates over many runs, not one demo |
| How do I know what it is doing right now? | **Observability and SRE** (site reliability engineering) | Logs, metrics, alerts, postmortems, error budgets |
| How do I ship changes without breaking it? | **Release engineering, MLOps / LLMOps** | Canary deploys, verdicts, rollback, versioning of prompts and models |
| How do the pieces stay stable and keep improving? | **Control theory and feedback systems** (plus **workflow orchestration** for scheduling) | Sense, decide, act, check; why loops oscillate, lag or lie |

## The vocabulary, in plain language

- **Agent.** A model that chooses actions in a loop using tools.
- **Harness.** Everything around the model: tool definitions, permission gates, the caps, the file layout, the scheduler. Most of what you built is harness.
- **Context engineering.** Deciding what the model sees at each step. The dawn brief is context engineering: a 9 KB packet assembled by code.
- **Eval.** A repeatable test of agent behaviour with a score. A scenario on a trial server run 30 times is an eval. "It worked once" is a demo.
- **Observability.** Being able to ask new questions of the system from its own records. The journal is observability.
- **SRE.** A way of running systems with numbers: service levels, error budgets, blameless postmortems, alerts that need action.
- **Canary.** Ship a change to a small part first and watch. The deployer's 40-minute window is a canary with one actor.
- **Rollback / revert.** Return to the last good version automatically when a check says the new one is worse.
- **Idempotent.** Running something twice has the same effect as once. Stable keys make work orders idempotent.
- **Feedback loop.** An output that comes back as an input. Reinforcing loops amplify, balancing loops steady things.
- **Setpoint, sensor, actuator, controller.** The four parts of any control loop: the target you want, what measures reality, what acts, and the logic that compares them. Journal and detectors are sensors, the fixer is an actuator, the dream is part of the controller.
- **Open loop vs closed loop.** Open loop acts without checking the result. A loop with no verdict is open. A loop whose last stage never ran is open.
- **Delay and oscillation.** If feedback arrives late, a system overcorrects and swings. The dream's 12-hour rest on a changed line and the deploy's 40-minute window are there to stop that.
- **Goodhart's law.** When a measure becomes a target it stops being a good measure. A finding that "resolves" when the model stops mentioning it is the example here.
- **Watchdog.** A simple check that the system is alive. The audit is a watchdog for the loop.
- **Blast radius.** How much can go wrong if this stage misbehaves. Path limits on the fixer shrink it.
- **Human in the loop / human on the loop.** In the loop means a person approves each step. On the loop means a person supervises and is asked rarely. Hands-off means on the loop.
- **Durable execution / workflow orchestration.** Scheduling multi-step jobs so they survive crashes and can retry. Task Scheduler here is the crudest version. Tools like Temporal, Airflow and Dagster are the grown-up versions.
- **Technical debt in ML systems.** The old observation that the model is a small part of a larger system, and most of the cost is in the glue. It is still true.

## The primitives and rules, in one list

If you remember only these, you can design a loop anywhere:

1. **Sense**: a record you trust, built by code.
2. **Decide**: with cheap rules first, a model only for judgement, and a cost number attached.
3. **Act**: through narrow tools behind a gate.
4. **Check**: something other than the actor confirms the result, with evidence.
5. **Remember**: small, capped, owned, reversible.
6. **Ship and judge**: one change at a time, against the actor's own past, with an automatic way back.
7. **Watch the loop itself**: a second loop whose subject is the first.
8. **Bound everything**: caps, budgets, floors, off switches.
9. **Ask the human almost nothing**, and count every ask as a defect.

## A study path

The order matters: do the concept reading in the order below, and for each stop apply it to this repo. You learn the vocabulary fastest by finding it in code you already own. I have not opened these links today, so if one has moved, search the exact title.

**Step 0. Read your own project first (a couple of hours).** `docs/MEMORY-LOOP.md`, `docs/DEPLOYER.md`, `docs/HILLCLIMB-INSIGHTS.md`. Highlight every word in Part 2's vocabulary list where you find it.

**Step 1. Agent and harness engineering.**
- Anthropic, *Building effective agents* (anthropic.com/engineering/building-effective-agents). The workflow patterns (prompt chaining, routing, orchestrator-workers, evaluator-optimizer) are the same pieces you have, named.
- Anthropic, *The components of agent memory* (the article you already pasted). Re-read it after the rest of this list.
- The Anthropic engineering blog, for posts on context engineering, writing tools for agents, long-running agent harnesses and multi-agent systems (search those titles on anthropic.com/engineering).
- Paper: *Voyager* (arXiv 2305.16291), a Minecraft agent that keeps a library of skills it writes itself. Very close to your problem.
- Papers on memory and reflection: *Reflexion* (2303.11366), *Generative Agents* (2304.03442), *MemGPT* (2310.08560).
- Paper: *SWE-agent* (2405.15793), on designing the tool interface an agent codes through. It is the fixer's ancestor.
- **Exercise:** list every tool the fixer has and every tool it deliberately lacks. Argue for one you would add.

**Step 2. Evals.**
- Hamel Husain, *Your AI Product Needs Evals* (hamel.dev), and his follow-up field guide on improving AI products.
- Eugene Yan, *Patterns for Building LLM-based Systems & Products* (eugeneyan.com), especially evals and guardrails.
- Anthropic's engineering posts on evals for agents (search "evals for AI agents" on anthropic.com/engineering).
- **Exercise:** pick the bug with the biggest `costMin` on the Memory loop page. Write down what a 30-run pass-rate test for it would be. That is the missing eval layer the docs mention (a snapshot rebuilt on a trial server).

**Step 3. Observability and SRE.**
- Google, *Site Reliability Engineering* (free at sre.google/sre-book). Read "Monitoring Distributed Systems", "Postmortem Culture" and "Release Engineering".
- Google, *The SRE Workbook*, chapter on canarying releases (sre.google/workbook).
- Michael Nygard, *Release It!*, on timeouts, circuit breakers and bulkheads. Every item in "What went wrong" is a chapter in this book.
- **Exercise:** write a one-page postmortem of the `node_modules` deletion in the blameless style. Cause, impact, what caught it, what prevents it, and which rule it adds.

**Step 4. Deploy, rollback, MLOps.**
- DORA research (dora.dev) and the book *Accelerate*: four numbers (deploy frequency, lead time, change failure rate, time to restore). Your Memory loop measures are the same idea.
- Sculley et al., *Hidden Technical Debt in Machine Learning Systems* (NeurIPS 2015).
- **Exercise:** compute your own four numbers for the last week from the deploy log.

**Step 5. Control and systems thinking.**
- Donella Meadows, *Thinking in Systems*. Short, no maths. Read the chapters on feedback loops, delays and leverage points.
- Åström and Murray, *Feedback Systems* (free online at cds.caltech.edu/~murray/amwiki), chapters 1 and 2 only. The pictures are enough.
- Brian Douglas's control-systems lectures on YouTube, for an intuition of stability and delay with no maths.
- **Exercise:** for each cooldown, cap and window in the caps table, say which delay or oscillation it prevents.

**Step 6. Orchestration (only when the schedule becomes the bottleneck).**
- Temporal's documentation on durable execution; the concepts pages of Airflow or Dagster; the LangGraph documentation if you want to see the "graph" idea in code.
- **Exercise:** list which of your seven scheduled jobs would need retry and resume if the laptop slept mid-run. That tells you when Task Scheduler stops being enough.

### If you only do three things
1. Read *Building effective agents* and then re-read the memory article.
2. Write the `node_modules` postmortem.
3. Run the pre-flight checklist on a *second, tiny* project (a script that does one job), and see which items you could not tick.

### How to tell you have the vocabulary
You can answer these in a sentence each:
- What is the sensor, controller and actuator of this loop?
- Where is the delay, and what would oscillate without it?
- What keeps a model from marking its own homework?
- What happens if the stage after this one is not running?
- What is the blast radius of the fixer, and what limits it?
- What is the single number that tells me the loop is working?

If you can, you have the structure. Everything else is practice with the individual pieces.

---

*Sources: `docs/MEMORY-LOOP.md`, `docs/DEPLOYER.md`, `docs/HILLCLIMB-INSIGHTS.md`, PRs #281, #283, #286, #287, #299, #302, #318, #322, #324, #325, #326, #327, #330, #332, and the project memory notes on the loop, the schematic agent and the leftovers detector. The "what went wrong" items on offline restarts and the 15 asks come from the PR descriptions and the loop audit's own hard rules. The incident notes in this guide were read from those sources, not re-run.*
