> **Read CLAUDE.md first**: the bot is an independent player with its own goals, not a servant. Features here are requests to build with that in mind.

# Feature requests for the central thread (from the bot driver)

Requested by Walter: a default routine for undirected time (furnace upkeep first), plus faster/more reliable chat handling.
The driver thread keeps `join.js` running and talks to Walter in game chat; build features as modules the driver can load
(see `excavate.js`, `farm.js` for the pattern: `module.exports = function install({ bot, say, goals, tryGoto, ... })`).
Please do NOT restart the bot for experiments: every restart drops the player. Use `cmd.txt` (see below) to test commands.

## How the bot works today (facts)
- `run.js` (supervisor) runs `join.js`; if the bot disconnects it reconnects with backoff. Kill both to restart, start `node run.js` hidden.
- Chat in: `chat.log` (lines `OGWO: text`). Chat out: append lines to `outbox.txt` (sent at most 1 per 1.2 s, duplicates dropped).
- Commands without chat: append lines to `cmd.txt`; they run as if OGWO typed them (`handleCommand`). Replies appear in `join.log` as `MSG <OzoGo444> ...`.
- Instant local commands exist in `handleCommand` (follow, come, stay/stop/pause, go to x y z, go to <waypoint>, inventory, status, look, find <thing>, index chests, harvest, excavate/resume, sleep routine, ...). Anything not matched gets "Got it, one moment." and waits for the driver.
- Navigation: `navigate(goal,label,dynamic)`, `tryGoto(goal,label,ms)` (promise, returns {ok,secs,err}); pathfinder never digs/places; doors/gates are handled by `tendDoors()`.
- State files: `waypoints.json`, `stations.json`, `chest-index.json`, `exc-state.json`, `sleep-state.json`, `find-*.txt`.
- Bed routine: `bedRoutine()` (sleeps every 3rd night at dusk, pings Walter). Farm: `farm.js` (harvest+replant, auto-eat).

## Walter's rules (must hold in every feature)
1. NEVER walk or path with a lava bucket as the selected (held) item. Fill, then switch to a safe item (e.g. a sword) before moving; hold lava only for the instant it is placed into a chest.
2. Never break/place blocks unless Walter asked (excavation of the room and replanting crops are the explicit exceptions).
3. Do not leave piles of items on the ground; avoid overflow. Stop and tell Walter instead.
4. Common crop food may be taken from chests; otherwise practise farming.
5. Keep ~1 stack of food. Sleep every 3rd night, ping Walter if he is not in bed.
6. Chat replies short; never spam (one message per second at most).

## Feature 1: idle scheduler (highest value)
A scheduler in a new `idle.js` that runs when no user task is active and no chat command arrived for 3 minutes, and yields instantly
(set a stop flag, finish the current atomic step, stand down) when Walter types anything or says stop/pause.
Priority order: safety (low health / hostile close -> retreat or pause) > sleeping at dusk when due > eating > explicit chat tasks >
furnace upkeep > paused excavation (only if Walter said "resume") > stand still near Walter.
Each task: `{name, canRun(), run(signal), cooldownMs}`; log to `idle.log`; announce in chat only when something changes
(not every poll). A task that gets its goal changed by another command must retry later (the first bed attempt failed this way).

## Feature 2: furnace upkeep task
Two stations (coordinates from `stations.json`, waypoints `furnace station 1/2`, `lava depot 1/2`):
- Station 1: furnace -1043,130,2273. Input chest -1043,132,2273. Fuel chest -1043,131,2274 (side hopper -> furnace). Output double chest -1043,128,2273/2274.
- Station 2: furnaces -1051,153,2324 and -1051,153,2325. Input chests y155 (z 2323..2325), fuel chests -1051,154,2323 and -1051,154,2326, output double chests y151.
- Flow: used lava leaves an EMPTY bucket in the output chest. Upkeep = take empty buckets from the output chest(s) -> fill at a lava depot -> put lava buckets in the matching fuel chest.
- Lava depots are `lava_cauldron` blocks fed by pointed dripstone: depot 1 = 16 cauldrons at x -1046..-1045, y136, z 2314..2321; depot 2 = 7 cauldrons at x -1040..-1034, y128, z 2270.
  A cauldron only counts when it IS `lava_cauldron` (full). Using an empty bucket on it yields a lava bucket and leaves an empty cauldron that refills slowly; do not wait on empty ones.
- Targets: keep each fuel chest at >= 4 lava buckets (1 bucket smelts 100 items). Check every ~10 minutes while idle (read chests without taking). Never take anything except empty buckets (and lava buckets you made).
- Also: carried cobblestone goes into an input chest (keep 48 for tool crafting); report if an output chest is nearly full (>80% slots) instead of emptying it (Walter has not said where stone should go).
- Station 2's second fuel chest (-1051,154,2326) was EMPTY at last inspection and all input chests were empty.
- Order of operations when filling: equip bucket -> `bot.activateBlock(cauldron)` -> immediately `bot.equip(sword,'hand')` -> walk to chest -> open chest -> deposit lava buckets -> close. Verify held item is not lava_bucket before every `navigate/goto`.

## Feature 3: chat understanding
Local fuzzy intent matching for the common requests (done for many); for everything else keep the ack but also write the unmatched text to
`unhandled.log` so the driver can add rules. A per-user "last topic" memory so "do it again"/"there" can be resolved.

## Feature 4: mob safety
Detect hostiles within ~8 blocks: equip sword and fight back only if Walter allowed combat; otherwise walk away/pause and say so.
Respect health < 8 (pause tasks and tell Walter).

## Feature 5: status/dashboard
A tiny local web page or `status.json` updated every 5 s: position, health, food, current task, queue, last 20 chat lines, last error.

## Known issues to fix
- `move_minecart` packets fail to decode in the 1.21.6 protocol data (harmless noise).
- `goal_reached` used to announce "Here." for internal moves; fixed by `quietNav` in `tryGoto`. Keep internal moves quiet.
- Restarting join.js drops the player; prefer hot-loading modules or the `cmd.txt` channel.

## Feature 6: idle "natural gaze" (requested by Walter, lowest priority)
When the bot has no task, it should default to looking at nearby things in a natural way: glance at Walter (and other players) when within ~16 blocks,
at animals/mobs and item drops, and at notable blocks, with short random pauses (1.5-4 s), smooth head turns (no snapping), occasional glances back
to Walter, and never staring at one thing for long. Strictly lowest priority: it must never interrupt or delay any task, movement, chat reply or
safety behaviour, and stops the moment any task starts. Implement as an idle task with `bot.lookAt(point, false)` and eased yaw/pitch steps.

## Nether notes (from the first tests)
- After arriving through a portal the player must step out and back in; `usePortal()` handles this.
- Nether lava is common near portals; never path across unknown terrain there; keep Nether trips short until armor (gold for piglins) and a plan exist.
- The pathfinder must never be allowed long water drops: `mv.infiniteLiquidDropdownDistance = false` (the bot once walked down a 120-block water shaft).

## Sleep rule update (from Walter, apply in the patched join.js)
If the bot is in bed and the night has not skipped after 90 seconds (Walter is not joining), it must get up (`bot.wake()`), say so briefly, and go back to whatever it was doing before (resume the interrupted task / idle routine) instead of stalling in bed. Do not retry the bed that night unless Walter says "sleep" again. Current code pings Walter after 20 s; keep that ping, add the 90 s wake-up.

## Farm search update (from Walter, apply in the patched farm.js)
The 40-block crop search around the bot's current position is too small/arbitrary. Search around the known farm locations instead: keep a list of
farm waypoints (currently "home farm" -1067,160,2360 in waypoints.json; more can be added), walk to each in turn, and search ripe crops within a
radius around that farm centre (start with ~64) rather than around wherever the bot happens to stand. Keep replanting everything taken, and still
store extras in the house chest. A farm waypoint list (names starting "farm" or a `farms` array in waypoints.json) lets Walter add farms by saying "set waypoint <name> farm".

## Idle threshold (from Walter)
Idle routines must start after LESS than 3 minutes of quiet. Current value is 2 minutes (lastChatAt check in join.js); make it a setting (IDLE_QUIET_MS, default 90 s) and keep it under 3 min.

Update: Walter chose a 15 second quiet threshold (IDLE_QUIET_MS = 15000). Any chat from him resets it; the idle task must yield instantly when he types.

## Task queue (from Walter)
The bot should keep a queue of background tasks; all free time in its routine goes to the queue, in order. Right now the queue holds one item: the paused
room excavation (exc-state.json, `resume`/`start` in excavate.js; 13 sections done, resumes from there). When idle (15 s of quiet, nothing else due), pop the next
task and run it; any chat from Walter, a higher-priority routine (safety, sleep, eat, farm) or "stop" pauses it with its state saved, and it resumes
when free time returns. Walter can add queued tasks by chat ("queue: ..."), see them ("what's queued"), and remove them. Persist the queue in tasks.json.

## Combat module (from Walter, replaces the vague "mob safety" item): auto-fight that avoids creeper explosions
Walter wants the bot to fight hostiles on its own, and above all not get blown up by creepers.
Existing building blocks to evaluate first (verify 1.21.6 support): `mineflayer-pvp` (auto attack, strafing, shield), `mineflayer-armor-manager` (equip best armor),
`mineflayer-auto-eat` (we already have eating in farm.js), `mineflayer-hawkeye` (bow/crossbow), `mineflayer-tool` (best weapon), and the defend/avoid logic in the
open-source Mindcraft and Voyager agents. None of these handle creepers specially, so the creeper rule is ours:
- Creeper detected (entity name `creeper`; the live safety module already reports "creeper approaching ... N blocks"): never let it get within ~5 blocks. Back away from it (keep >= 6),
  ideally breaking line of sight or putting a block/door between; if it is hissing (metadata fuse started) run directly away at once.
- Kill creepers at range with a bow/crossbow if available; otherwise use the "hit then retreat" pattern: sprint-hit to apply knockback, then back off 4+ blocks (a creeper's fuse resets when it loses range).
- Other hostiles (zombies, skeletons, spiders ...): equip the best sword (stone sword now), fight when they come within ~4 blocks, retreat if health < 8, keep food up.
- Never fight with a lava bucket selected; never chase mobs far from the task; never dig/place blocks to fight.
- Respect rules: no drops piles, and report kills/losses briefly in chat only when it matters. Needs armor: ask Walter before using chest items for armor.
Acceptance test: stand the bot near a creeper (peaceful test arena or a real one while Walter watches) and confirm it never takes explosion damage and kills it safely.

## Mob detection: use path distance, not straight-line distance (from Walter; applies to the live safety module and the combat module)
A mob 12 blocks away through solid rock (a cave next to the base) is not a threat; a mob whose WALKING path to the bot is short is. Mobs follow roughly the same
paths the bot can walk, so: for each hostile within ~24 blocks straight-line, ask the pathfinder for a path from the bot to the mob
(`bot.pathfinder.getPathTo(movements, new goals.GoalNear(mob.x, mob.y, mob.z, 1), 80)` returns {status, path}), and only alert/engage when status is 'success' and the path length is <= ~20 blocks.
Throttle it: evaluate at most 4 mobs per tick-batch, cache the result per mob id for ~2 s, short timeout (<= 80 ms), and drop mobs that are not moving closer. Exceptions to keep: flying mobs
(phantoms, bats ignore), spiders (can climb, treat as reachable at a shorter straight-line range), skeleton/pillager arrows (line of sight matters, not path), creepers (alert on path length, hiss distance still applies),
and endermen (only matter if the bot looks at them). Log false-flag suppressions to `safety.log` so Walter can check the heuristic.

## Survival-legit interaction rule: line of sight required (from Walter)
Walter noticed the bot earned "Monster Hunter" while the only monster was on the other side of a solid wall. The server does NOT check walls for attack packets (and
neither for block breaking, container opening or item use within reach), so a bot that skips the check plays like a wall-hack. Rule for ALL modules:
- Before `bot.attack(entity)`, shooting, opening a chest/furnace, breaking a block or placing an item, confirm a clear line from the bot's eye to the target
  (`bot.world.raycast(eyePos, direction, maxDistance)`; for an entity use the hitbox centre and edges; for a block require the ray's first hit to be that block, or a face-adjacent non-solid path).
- If blocked, do not act; move to a position with a clear line first (pathfinder goal) or give up the target.
- Melee through a one-block-thick wall, diagonal-corner attacks and reaching through doors/fences must all be rejected.
- Applies to: brain/safety (melee and bow), excavate.js digging (only expose-then-dig), farm.js, furnace upkeep and chest access in the brain modules.
Acceptance test: a mob directly behind a 1-block stone wall must not be hit; a chest behind a wall must not be opened from the other side.

Status update (driver): bot.attack is now wrapped in join.js with a line-of-sight check (clearLineTo; blocked attempts logged to los.log). It loads at the next bot restart. Still to guard in their owners' code: container opens (brain/furnace.js, brain/crafting/craft.js, brain/excavation/dump.js, brain/routines/farm.js) and block breaking/placing (excavation, farm replanting). Walter's principle: do nothing a regular player cannot do.

## Legit mining module (from Walter): mine without cheating, strip-mining pattern
Walter wants the bot to mine the way a regular player does: no x-ray. The bot can read every loaded block, so a naive "find diamond ore within 160 blocks" is a cheat. Rules:
- Pattern: strip/branch mining with a 1-wide, 2-high hallway, then 2 solid blocks, then the next hallway ("hallway, two blocks, hallway, two blocks ...", i.e. branches 3 apart). Every block between hallways touches a hallway, so
  any ore in the strip is exposed and visible without guessing. Main trunk tunnel 1x2 (or 2x2) with branches off it; keep to a configurable depth (y) and length; place no blocks.
- Only act on what a player could see: an ore/chest/mob/liquid counts only if it has a clear line of sight from the bot's eye (`bot.world.raycast`) and is on an exposed face. Never target hidden ore, never path toward ore found only through block data.
- Safety without x-ray: check the block in front and its neighbours only once they are exposed; never dig into lava/water you can see; step back if lava or water appears; avoid gravel/sand overhead; never dig down into the unseen (use stairs-down, check each step, never straight down).
- Torches/lighting, tool durability and returning to restock (use the chest and furnace routines), inventory management (drop or store cobble per Walter's rules), and a "mine <ore> <amount>" chat command that runs the pattern at a sensible depth (e.g. diamonds y -58..-50, iron y 16, coal anywhere) until the target is met.
- Uses the same line-of-sight guard as attacks and container opens (see the survival-legit rule above).

Mining command behaviour (Walter): "go mine for X". The module first looks for the existing mine at the optimal level for X (known mine entrances / tunnel networks: record them as waypoints named "mine <ore or area>", and discover them from Walter's Xaero waypoints and from chat "set waypoint mine ..."), walks there, and mines along its existing hallways with the same legit rules (line of sight, no x-ray). If no suitable mine is known, it starts its own strip mine at the optimal depth for X (e.g. diamonds y -58..-50, iron y 16, coal y 45, gold y -16, redstone y -58..-50) using the hallway/2-block/hallway pattern, and records the new mine as a waypoint. Never use hidden-ore knowledge to choose where to dig.

## Claude review loop for the decision model (from Walter)
Once the decision model and free models are wired in, they are weak models; Claude should review their choices from time to time and refine the rules. Build in: (1) a decision log
(`decisions.jsonl`: time, situation snapshot, options considered, the choice, outcome, any error or Walter correction), (2) a periodic review (every N decisions or daily) where a Claude thread
reads the log, flags bad choices (wasted trips, risky moves, ignored rules like lava/line-of-sight/no-teleport, repeated failures), and writes concrete rule or prompt fixes into the brain config
(`brain/decisions-review.md` plus changes to the rules the model is given), (3) a way to tag decisions as good/bad from in-game chat ("that was good/bad") so Walter's feedback lands in the log.
Free-model decisions must never be able to override the hard safety rules (lava bucket, line of sight, no teleport, no dig/place without Walter, creepers).

## Idle delay
Walter wants idle tasks to start after about 3 seconds of quiet. scheduler.setIdleAfter's minimum was lowered from 5000 to 3000 ms (needs a restart to load); the chat command "idle after N seconds" sets it and is saved in the scheduler state.

## Smeltables go to the auto-furnaces when the inventory fills (from Walter)
Today only cobblestone is deposited (spare above the 48 reserve, brain/furnace.js and brain/excavation/dump.js). Walter expects ALL smeltable items from mining to go into the auto-furnace input chests when the inventory fills.
Extend the dump to: raw_iron, raw_gold, raw_copper (and *_ore blocks if carried), ancient_debris, sand and red_sand (glass), clay_ball/clay, cobblestone (stone), cobbled_deepslate, stone (smooth stone), netherrack, quartz ore, kelp, cactus, wet_sponge, raw food (porkchop, beef, chicken, mutton, rabbit, cod, salmon, potato) except the 64 food the bot keeps,
and logs only if they are surplus beyond the planks/sticks needed for tools. Keep coal (fuel/torches). Respect each input chest's capacity and the "never throw items on the ground" rule: if all input chests are full, pause and report instead of tossing.
Trigger: whenever free slots <= 6 (same trigger as today), not only at the periodic furnace pass.

CONFIRMED by Walter (in game chat): all smeltable items are handled the same way as cobblestone (spare amount above the reserve goes into the input chests when the inventory fills).

## Tasks must persist through chat (from Walter)
Walter's messages should not derail a running task. Today every message from him preempts the running idle task (idle.log: "SCHED abort furnace: preempted" at 01:15:57, 01:16:23 ...), which is why the furnace pass keeps failing to complete.
Rule: only commands that need the bot's body (go somewhere, follow, come here, stay/stop/pause, sleep now, craft, mine, harvest ...) preempt. Pure chat or information requests (status, "what are you doing", inventory, where are you, questions, small talk, acknowledgements)
are answered in a side lane WITHOUT pausing or aborting the task, and a task that is preempted by a body command resumes automatically, from a checkpoint, when the command is done.
Also: a task should keep going through its own atomic step (finish the current chest open/deposit/dig before yielding) and never restart from scratch after an interruption.
Acceptance test: start a furnace pass, send three info messages ("status", "what's around", "how are you"); the pass finishes without any "preempted" line.

## Chat location context (from Walter)
Each chat line from Walter is now logged with his position and facing: chat-context.jsonl ({t,user,text,pos,seenAgoS,yaw,pitch,facing,dim,bot}) and the last seen position in player-pos.json (loads at the next restart).
Use it to resolve "expand this hallway", "dig here", "come to where I was", "this room" when the bot is not with him: take his logged position + facing (+ the look direction) as the referent,
and ask for confirmation if seenAgoS is large (he was out of tracking range, so the position is stale). Player positions are only visible within the server's tracking range, so this can be stale; the router/chat modules should read chat-context.jsonl.

## Walter's in-game requests, 2026-10-26 ~01:30-02:00 UTC (for the central thread; the driver already did what it could in join.js)
- DONE by the driver: armor worn automatically (join.js wearArmor, every 8 s, only carried items); narration toggle ("narration high|low|off", default high; scheduler start/pause/resume lines and the router's reading of each message, max one line per 4 s, in parentheses);
  "furnace lit=true" style debug lines are kept out of chat (go to furnace-debug.log); take-from-chest command ("take N item from x y z [and x y z]", scheduler task, line of sight required).
- Routine additions: (1) mining becomes part of the routine as a fallback when nothing else is due (strip-mining module, legit rules; non-smeltable drops go to storage chests Walter will name); (2) tree farming ("is the tree farming online? it should be part of routine"): NOT built yet.
  Tree farm module: pick a suitable built-environment spot, plant saplings, harvest logs, collect saplings after leaves decay (walk the canopy area, pick up drops), replant, keep logs for tools/planks and send surplus logs to the furnace input chests as charcoal only if Walter agrees.
- Preview: Walter wants to ask "what are you going to do next" and get a short preview (queue plus the next idle task and why). Extend the "what are you doing" command: current task, waiting tasks, the next idle task and its estimated trigger.
- Lighting: if the bot commonly walks through poorly lit areas (light level low enough for mob spawns), fix it autonomously by placing torches (Walter authorized this one use of block placing; torches only, keep to the routes it actually uses; log each placement).
- Building: find a source of schematics/blueprints for the bot's own builds (e.g. open litematica/schem libraries, mineflayer-builder / prismarine-schematic loaders). The bot picks its own private room (cottage or little tower), shows Walter the plan before building.
- Arrows and other items from the bot's request list: Walter said yes; ask him where to get them or craft them (string/feather/flint from chests per chest-index.json).

## NEW THREAD requested by Walter: villager farming (complex, high payoff)
Walter asked for a dedicated thread (a separate Claude thread, not the driver) to build villager farming for the bot. Scope for that thread to refine with Walter:
- Goal: a working villager economy: breeding (beds + food: bread/carrots/potatoes/beetroot from the farm routine), a safe villager hall with workstations (lectern, composter, grindstone, ...) so each has a profession, a trading hall with iron-golem protection and zombie-proof lighting, curing for discounts (weakness + golden apple), restocking by sleeping/workstation access, and an inventory of useful trades (mending/efficiency books, emeralds -> diamond gear, food, arrows, bells).
- Legit rules (see CLAUDE.md): survival-only, no teleporting, line of sight for every interaction, no x-ray, lava/creeper safety, no item piles. Trading is a normal right-click interaction with each villager's trade window (bot.openVillager / bot.trade in mineflayer).
- Perception: villager entity names/professions/trades are visible once in view and the trade window is open; treat unseen villagers as unknown.
- Placement and building: the bot judges the built environment and picks where things belong (Walter trusts that); it may build pens/halls with blocks it owns; show Walter the plan first for anything big.
- Needs from other modules: farm routine for crops, crafting for beds/workstations, storage chests for emeralds and valuables, safety/combat for zombies/pillagers, and the scheduler for a "villager upkeep" idle task (feed, breed to a cap, restock, collect trades), which yields to chat and safety.
- Deliverables: a design doc, a villager module (brain/villagers/), chat commands ("find villagers", "trade for X", "villager status"), and tests with the mock bot.

## Excavation extension (Walter, in game chat): 4 more blocks, 10 blocks of room height in total
Walter: "add to the excavation another 4 vertical blocks mined out, for a total of 10 vertical blocks in room height ... you will need to build temporary columns so you can jump up, or you can get scaffolding from bamboo." Explicitly authorizes placing temporary blocks for this job.
Geometry: floorY 136, so the room becomes y136..145 (10 tall); new dig layers y142..145 over the same footprint (box x -1069..-1053, z 2299..2344, columns open at y136/137). Stone-brick hall floor is y150 (hallMinY 151), so y146..149 stays as a 4-block ceiling; never dig above y145 (keep HARD_MAX_Y below 150 and make digTo = 145).
Code to change (brain/excavation): config.json digTo 141 -> 145; plan.js `ROOM_HEIGHT` (6) -> 10 and the clamp `floorY + ROOM_HEIGHT - 1`; engine.js needs a vertical access phase and state (new `layers` pass so a half-done room resumes correctly; do NOT reset `done` for y138-141; add a second done-set per layer band).
Reach: from the floor (eye y137.65, reach 5.1 to block centre) the bot can still dig y142 (centre 142.5, dist 4.85) but NOT y143..145. So: phase A digs y142 from the floor as today. Phase B per 3x3 section: pillar up with temporary cobblestone (bot has plenty; 48 reserve) at the section centre until feet are at y139-140
(place a block under the feet while jumping: look down, `placeBlock(blockBelow, up)` right after the jump apex; survival-legit: line of sight, normal reach), dig y143..145 over the 3x3 from the top of the pillar (centre of the section keeps every block within 5.1), then take the pillar down from the top (dig the block under the feet, drop one block each time) and pick up the blocks. Bamboo scaffolding is an alternative (craft scaffolding: 6 bamboo + 1 string per 6; bamboo is not on hand).
Safety: never pillar under a gravity block or below an unexpected opening; abort and descend if health < 8 or a hostile is near; fall damage from 1 block is trivial but never leave a pillar of more than 4; keep the light level up (torches) so mobs don't spawn in the new height; no item piles (pick up cobblestone, deposit spare cobblestone as before); never break the hall floor (y150) or protected blocks.

## Time economy (Walter): work-site chests, haul at the end
Do not walk to the far final chest every time the inventory fills. For long jobs (excavation, strip mining, harvesting) place or craft a work-site chest next to where the bot is working (chest = 8 planks; place it against a wall out of the way, mark it as a waypoint "worksite <job>"),
deposit there when the inventory fills, and make one haul to the final chests at the end of the job (or when the work-site chest is nearly full). The work-site chest must be picked up or emptied afterwards unless Walter wants it kept.
Applies to: excavation cobblestone/dirt, strip-mining junk and valuables, tree/farm output. Needs: craft chest, place chest (legit placement, line of sight), a ledger of what is in the work-site chest so a restart can still finish the haul, and the item-pile and furnace-deposit rules unchanged.

## Activity review (driver, 2026-10-26 02:15 UTC) of idle.log for undesirable loops
- 479 scheduler events. 36 of 55 furnace interruptions were safety alerts, ALL in the 00:00-01:00 UTC hour before the path-distance filter (A-B-A-B ping-pong: furnace<->safety, 76 sequences, runs under 30 s: 115 of 145). None since 01:00.
- Since 01:00 the real churn was idle jobs aborted by "chat quiet window": 29 aborts (farm 10, excavation 6, furnace 15 over the whole log) caused by Walter merely talking. Fixed: brain/scheduler.js now has lastTalkAt (delays STARTING idle jobs) separate from lastChatAt (set only when a message triggers a command, aborts running idle jobs); brain/index.js route() calls noteTalk() for every message and noteChat() only for matched commands that are not info-only. Backups: logs/scheduler.before-talk-split.js, logs/brain-index.before-infoonly-widen.js.
- No farm->furnace->farm style loop was found; task-to-task switches are single priority preemptions (excavation<-furnace 2, excavation<-farm 1, furnace<-farm 1). Keep watching: a creeper-driven retreat followed by a return to the same spot should have a cooldown (safetyCooldownMs exists).

## Mine off the ladder shaft (Walter, in game chat, with his go): iron first
"There is a ladder at approximately -1042, 128, 2281, build mines off this shaft at the appropriate y. I would give you discretion to mine for what you think is most helpful, but I'm thinking iron at this point. The ladder should be extended downwards if ne[eded]" (message was cut off at that point in the chat log).
- Start point: the ladder shaft at about -1042,128,2281 (inside Walter's protected base box, y100-200; mines must start below y100, so the shaft itself is the entry and the mine begins where the shaft passes the target depth).
- Extending the ladder (needs new code in brain/mining): craft ladders (7 sticks -> 3 ladders; the bot has planks for sticks), place them on the shaft's back wall while descending, one ladder per block, legit placement (line of sight, normal reach), never place anything else. Keep the shaft 1x1 or follow the existing shape; stop and park if the shaft hits water or lava, or goes through a cave opening (do not follow unseen caves).
- Depth: iron is best around y16 (range -8..40 in config.json): extend the ladder from y128 down to about y16 (112 blocks, so ~112 ladders = 37 crafts = about 260 sticks; ask Walter or gather wood; or dig a stair mine instead if he prefers). Branch the 1x2 trunk off the ladder at that level; 2-block spacing branches as in the strip-mining spec.
- Mining target: iron first (default 32); afterwards the module may choose what is most helpful (coal, redstone, lapis, diamonds deeper) under Walter's discretion; register the mine as waypoint "mine iron". Valuables go to the chest wall at x -1054, y 128-132, z 2275-2285; smeltables go to the furnace input chests via the existing deposit.
- Safety: ladders are climbed with the pathfinder (ladders count as climbable), lava and water rules as in the mining README, torches only as lighting, mobs per the safety module.

## From chat Claude (2026-10-26): excavation scaffolding must use the right tool
Walter saw the bot tearing down its temporary cobblestone scaffolding by hand during the 10-tall excavation. Equip the best pickaxe (via the existing tool-pick helper) before breaking any pillar/scaffold block; generally pick the proper tool for every block the bot breaks. Owner: driver thread "Join LAN world with alt account" / excavation module.

## From chat Claude (2026-10-26): harvest sugarcane
Walter: farming should include harvesting sugarcane, leaving the bottom block so it keeps growing (break canes only above the base). Add to the farm routine (farm.js / brain/routines). Walter has also asked the bot to go inspect tower sites at -1056,2334 and -984,2292 (priority); chat Claude sent `go to -1056 2334` via cmd.txt.

## Outing / linger task (found while visiting candidate build sites, 2026-10-26 02:40 UTC)
Walter asked "are your actions getting interrupted by routine?" Yes: the bot walked to candidate site B (nav task done 02:39:13) and the scheduler resumed the furnace job in the same instant ("SCHED resume furnace"), so the bot left before a first-person picture could be taken.
A whimsy outing needs a hold: a task type "outing" (own priority between chat 50 and farm 40, so idle jobs cannot take over) that walks to a place, lingers for N seconds (look around, take a picture, save a waypoint), and then releases the bot. Chat command: "visit <place or x z> for <N> seconds" and an API for the driver (outing({x,y,z,label,seconds,actions})). It must still yield to safety (creepers etc.), sleep and any command from Walter.
Workaround used today: render with `node pov.js out.png --around --at X,Y,Z` (works from any camera position inside loaded chunks, no need for the bot to be there), then send it with the file tool.

## From chat Claude (2026-10-26): personal tower build is APPROVED
Walter (chat 02:45 UTC): the meadow site (~-984,2292) is approved for the bot's personal build, and the build itself is pre-approved ("I'm curious to see the personal build"). Plan: small stone-brick and spruce tower with lookout deck; still show Walter the plan/screenshots as courtesy but no need to wait for a go. Needs the building module / blueprint source. Owner: driver thread.

## From chat Claude (2026-10-26): Nether safe network log
Walter: Nether wayfinding by algorithm could get the bot in trouble. Maintain a log of the safe Nether network (portals, walked/verified paths, hazards like lava and ledges; e.g. brain/state/nether-network.json), and have nav travel only along logged segments there, asking Walter before exploring anything new. Seed it from Xaero portals in waypoints.json and the paths Walter and the bot actually walked. Owner: nav thread.

## From chat Claude (2026-10-26): slow digging straight down
Walter noticed breaking blocks directly below the bot sometimes looks slow, maybe because it stands at the center of the block above and the dig ray/reach is awkward. Suggestion: step slightly off-center on the column (or aim at a better face point) and measure dig time before/after. Owner: excavation/mining module.

## From chat Claude (2026-10-26): inventory room before tasks
Walter: before starting a task, make sure there is reasonable inventory room, generally by clearing out blocks left over from prior tasks that are no longer needed (store in the right chest, no ground piles). Add a pre-task check to the scheduler/task start (e.g. >= N free slots, task-specific keep lists). Owner: scheduler/integrator.

## From chat Claude (2026-10-26): animal farms
Walter: there are no animal farms yet. Interesting builder task because it needs quick movement to lure an animal (holding its food: wheat for cows/sheep, carrots for pigs, seeds for chickens) into a contained pen, then breed and cull. Needs: pen design/site (ask Walter), lure-and-lead movement with line-of-sight rules, breeding, and a cull/food routine. Owner: new module; low priority until current routines are stable.

## From chat Claude (2026-10-26): tree farm must clear whole trees so leaves decay
Walter asks whether tree farming clears the whole tree so leaves can decompose; if not, add it. Code facts: brain/treefarm cuts logs and collects saplings from decayed leaves, never hand-breaks leaves. Verify every log of a tree (including side branches, dark oak/jungle multi-trunks, and logs in leaves) is removed so nothing keeps leaves alive; add a leftover-log sweep, and optionally clear stubborn leaves. Owner: treefarm.

## From chat Claude (2026-10-26): clear leaves by hand during tree farming
Walter: while tree farming, do not leave the farm while leaves decay; break the leaves by hand (shears/hand is fine for leaves; use shears if owned, otherwise hand) to speed it up until the area is cleared. Keep rules: only natural leaves of the felled trees, line of sight, collect saplings/sticks/apples, never leave drops on the ground. Supersedes the earlier "leaves decay on their own" behaviour. Owner: treefarm.

## From chat Claude (2026-10-26): "fuel chests are low" threshold
Walter: fuel is only truly low when the feeder hopper for fuel holds 1 or 0 buckets of lava. Otherwise do not send the "fuel chests are low but I have no empty buckets" message (also don't start a refill trip unless the hopper count is <= 1). Check the hopper contents (feeder hopper per furnace), not the chest count. Owner: furnace upkeep (brain/furnace.js).

## From chat Claude (2026-10-26): furnace task runs too often
idle.log shows SCHED start furnace at 03:23:24, 03:26:17, 03:28:00 (and 27 total this session). Routine intervalMs is 30000 in brain/furnace.js:502. The runs end without work (no empty buckets) and retrigger. Fix: trigger only when a feeder hopper holds <=1 lava bucket (same rule as the "fuel low" message); after a no-op run (nothing to do / no buckets) back off >= 15 min; announce the bucket shortage once, not each run. Owner: furnace.

## From chat Claude (2026-10-26): crop farm routine interval 45 min
Walter: farming is low priority; run the crop farm routine (brain/routines/farm.js) about once every 45 minutes instead of ~10. Crop farm only; tree farm and others unchanged. Owner: routines.
UPDATE (chat 03:31 UTC): Walter answered "both yes": the 45-minute interval applies to the crop farm AND the tree farm routine.

## From chat Claude (2026-10-26): bamboo in the farm
Walter: add bamboo farming to the farm, just 8-10 stalks since it grows fast. Plant on dirt/grass/podzol/moss near the home farm (ask Walter for the spot or pick a free one inside the farm area), harvest by breaking everything above the base block like sugarcane, keep the bottom stalk, put bamboo (scaffolding/sticks source) in the work-site chest. Also useful for ladders (sticks). Owner: routines/farm.

## From chat Claude (2026-10-26): block under the ladder end
Walter (03:34 UTC): if the gap between the bottom of the ladder shaft and the ground causes pathfinding issues, place a block under the ladder. Applies to the mining ladder (bot parked at -1041,26,2281, "could not place the next ladder (no-line-of-sight)"). Counts as part of the agreed mining job (placing allowed). Owner: mining.

## From chat Claude (2026-10-26): post new features after each restart
Walter: when the bot leaves and rejoins (restart), post a short chat message about its new features. Suggest: a file brain/state/whats-new.txt (one or two short lines, written by whoever restarts the bot, in the bot's voice); after join + a few seconds, say each line (<= 200 chars, 1 per 1.2 s) and clear/archive the file. Replaces the current "Restarted: ..." message. Owner: join/chat integrator. Until then chat Claude can post the summary manually via outbox.txt.

## From chat Claude (2026-10-26): mining routine should keep the bot busy by default
Walter: mining routine on by default; routines exist to keep the bot busy when no other commands are running. Current state: scheduler.json has mining enabled, but the routine text says "when I am idle and my stocks are low I go mining". Drop the "stocks low" gate (or make it a weight): when nothing else is due, mine. Owner: mining routine (brain/mining/index.js routineDue()).

## Mining must be able to climb back (driver, 2026-10-26)
The iron job went down the ladder shaft and stalled at y26 ("could not place the next ladder (no-line-of-sight)"); from there there was no walking path back and Walter had to teleport the bot out (twice in total today). Until the mining job has a RETURN CHECK (before descending, verify a climbable route back up: ladder cells continuous, shaft base reachable; at every ladder step re-verify; if the way up breaks, climb back immediately and park), the pilot director's auto-start of "mine iron 16" is switched off (brain/pilot/config.json director.autoHigh no longer lists mine-iron). Walter still wants iron mined off that shaft ("I'm thinking iron"), so the mining owner should add the return check and then re-add 'mine-iron' to autoHigh.

## From chat Claude (2026-10-26): speed up crafting (new thread requested by Walter)
Walter (03:45 UTC): crafting is pretty slow (e.g. "craft stone bricks x98" took a long time); wants a dedicated thread to improve it, especially when several recipes are submitted. Ideas: craft whole stacks per window click (shift-click / bulk recipe moves) instead of one per craft, batch consecutive recipes in one trip to the table, take all ingredients in one chest visit, avoid re-walking to the table between recipes, reduce per-click delays, craft in the inventory 2x2 grid when the recipe fits. Owner: new crafting-speed thread (coordinator to start).

## From chat Claude (2026-10-26): Walter planted the bamboo
Walter (03:49 UTC) started the bamboo patch himself where he stood (player-pos.json at that time: {"OGWO":{"x":-1066.4,"y":160,"z":2320.9,"yaw":5.964117303299373,"pitch":-0.24543692606170264,"dim":"overworld","at":1792986536430}}). Harvest rule: keep the bottom stalk so it regrows, break everything above it, and use an AXE for bamboo (right-tool rule). Register the patch as a farm site. Owner: routines/farm (bamboo) + safehand tool choice.

## From chat Claude (2026-10-26): comprehensive dropped-item sweep ("collect drops")
After the bot died at ~(-1033,144,2282) at 03:51 UTC, the manual driver searched the wrong area and ran out of steps (25) without finding loose items Walter could see. Need a deterministic command (e.g. "collect drops [radius]") using bot.entities (item entities) within a wide radius (>= 64), listing them with positions, walking to each by nearest-first with line of sight, picking up, repeating until none remain or the stack is full; also a post-death routine: remember the death position, go there when safe and sweep. treefarm's collectDrops(ctx, pos, radius, ...) in brain/treefarm/engine.js is a starting point. Owner: nav/safety.

## From chat Claude (2026-10-26): goal focus = priorities + saved tasks + persistence
Walter (03:57 UTC): the real need is (1) communicating priorities (the bot says what it ranks first and why when focus changes), (2) saving a task (a focus/goal queue stored in brain/state, e.g. "personal tower, then mines") that survives restarts and re-queues the active job after each restart, (3) persisting until finished (resume automatically after interruptions such as safety, sleep, deaths, nav failures; report only when done or truly blocked). Chain goals (tower -> iron mine). Owner: scheduler/pilot directives.

## From chat Claude (2026-10-26): climbing DOWN ladders
Walter (04:08 UTC): "Something is wrong with how you go down ladders. You just have to do nothing and you will descend." In Minecraft a player on a ladder with no forward/jump/sneak input slides down at ~3 blocks/s (sneak holds, jump climbs). The bot's descent logic likely presses keys (forward/sneak) or uses the pathfinder jump, so it stalls or bobs. Fix: when going down a ladder column, clear all control states (bot.clearControlStates()) and wait until y changes / reaches the target, stepping off at the bottom; avoid sneak (holds position). Test on the iron shaft at -1042,128,2281. Owner: mining / nav ladder code.

## From chat Claude (2026-10-26): manual mode must not hand back on its own (PERSISTENT PROBLEM, Walter 04:20 UTC)
The manual driver ends itself ("done after 4 steps", "step-budget after 25 steps") and the scheduler immediately resumes background tasks (mining/lighting/nav), which pulled the bot back UP the ladder right after it descended to y27 (walk-to-waypoint). Requirements: (1) manual mode ends only when Walter says stop/done or the goal is truly complete AND he has not set a longer-running goal; (2) while manual is active or in a linger window, background tasks stay paused (the scheduler hands back only on Walter's word); (3) a manual goal can be multi-phase with no step-budget cut-off (budget ~25 steps is too small: "descend ladder + dig tunnel" ran out); (4) after manual finishes, resume tasks from the bot's CURRENT position, not by re-navigating to a waypoint. Owner: pilot manual driver + scheduler.

## From chat Claude (2026-10-26): scheduler flip-flop between build (daylight hold) and excavation
idle.log 04:22:53-04:22:57: "resume build" -> "abort build: preempted" -> "holding build: waiting for daylight" -> "resume excavation" -> "abort excavation: preempted" -> "resume build" ... repeating each second, spamming "(Pausing build/excavation for something more urgent.)" and "Holding build until daylight. Say go anyway ...". Cause: the build task (priority 45/60 focus) is resumed by the scheduler, immediately holds itself (no daylight) and returns, but the scheduler keeps re-picking it ahead of lower tasks. Fix: a held/blocked task must be marked ineligible (not resumable) until its hold condition clears, so lower tasks run uninterrupted; and silence repeated hold messages (say once). Owner: scheduler/build.

## From chat Claude (2026-10-26): tower build "could not place the block under my feet"
Walter saw the cause: a flower (replaceable/non-solid plant) at the target cell that the bot did not destroy before placing the block. Fix in brain/build: before placing a block, check the target cell; if it holds a plant/flower/tall grass/snow etc. that is not air, break it first (right tool, line of sight), then place; same for the block under the bot's feet. Owner: build module.

## From chat Claude (2026-10-26): mining must be robust (Walter frustrated, 04:30 UTC)
Mining parked on "no solid rock beside the ladder" at y47 (gravel walls) and needed hand-holding. Walter: "the mining code needs to be robust to that, or include some trigger of manual mode". Requirements: handle gravel/sand/dirt walls (dig 1 block at a time, stand clear of falling blocks, place a block to stop it if needed), treat dirt/gravel as diggable for the first hallway cell, and when mining parks for ANY reason that is not a hard safety stop (no solid rock, blocked, no LOS, craft fail), automatically start a "manual:" session with a goal describing the situation instead of waiting for Walter, and report only when finished or truly blocked. Owner: mining + pilot manual driver.

## From chat Claude (2026-10-26): overflow stashing into ANY base chest (Walter 04:34 UTC)
Walter: "any of the chests in the base are fine for stuffing random items into." The pre-task bag-clearing routine should use the nearest base chest with free slots (chest-index.json) for anything not on a keep list (current task materials, food stack, tools, torches, armor worn). The bag had ~28 stacks incl. spare armor, flowers, pressure plates, seeds, 82 cobblestone, 112 stone bricks while the tower/excavation needed room. Fix: automatic stash step before each task, with a free-slot target (e.g. >= 8). Owner: integrator/scheduler (same as the earlier inventory-room request).

## From chat Claude (2026-10-26): refine mob-pause false flags (Walter 04:50 UTC)
Walter: "the pausing for mobs needs to be more refined, i see false flags quite a bit." Examples: "Holding mining until the skeleton nearby is gone" while mining underground in a sealed shaft / skeleton on the surface or behind walls; "Holding treefarm/build until the skeleton nearby is gone". Refine: a mob blocks a task only if it can reach or shoot the bot (walkable path <= N AND line of sight for skeletons, within task radius), is not above/below through solid blocks, not in water/cave unreachable, and not already stuck/suppressed by safety (safety.log has "suppressed ... no walking path"); also apply the same reachability filter to the hold used by build/mining/treefarm tasks and let it clear after a short time (e.g. 20 s with no LOS). Owner: safety + scheduler holds.

## From chat Claude (2026-10-26, Walter angry 16:47 UTC): chat spam audit; "safe path to you" message
Source: join.js:773  bot.on('path_update', r => { if (r.status === 'noPath') say("I can't find a safe path to you without digging or placing blocks.") })
It fires on EVERY pathfinder noPath, including internal tasks (mining, nav, tree farm, manual), so it is usually wrong ("to you") and spammy: 53 times in join.log today. Fix: remove this global handler; only say a path failure message from the command that was asked (come/follow), once, rate limited (>= 60 s per message), and mention the actual goal. Also general rule: any bot chat line may be said at most once per 60 s, and routine/scheduler chatter should be off by default.
Other repeated bot lines in join.log (count): "It's night. Heading to the bed..." 25; "In bed." 22; "Awake." 22; "(Pausing mining for something more urgent.)" 20; "(Finished sleep.)" 20; "Got it, one moment." 18; "(Pausing furnace for something more urgent.)" 16; "(Queued furnace for when I'm free.)" 13; "(Finished nav.)" 12; "Resuming the excavation..." 11; "Clear." 11; "(Starting lighting because nothing more important is waiting.)" 11; "(Pausing lighting ...)" 11; "(Finished furnace.)" 11. Walter wants nonsense chat noticed and fixed proactively: add a spam guard + a daily top-N repeated-line report. Owner: join.js integrator + scheduler narration.

## From chat Claude (2026-10-26): no armor for now (Walter 17:50 UTC)
"I worry with the amount that you currently die, armor is a waste. Please don't seek to wear it for now." Disable the pilot free-time option wear-armor (brain/pilot/options.js), the iron-armor crafting/smelting for armor, and any gear-recovery goal that targets armor, until Walter says to resume. Keep iron for tools/ladders. Add a flag (e.g. brain/state/no-armor.json). Owner: pilot options + crafting.

## From Walter (2026-10-27 17:54 UTC, in game): hallway / excavation method
"The passage should be 3 blocks wide by 10 blocks tall. To do it efficiently, you should first dig out like the top 6 layers, then the bottom 4, so you won't have to use temporary columns as scaffolding. That should be a persistent strategy in excavation by the way." The first message (where the hallway starts and runs) was sent while the bot was offline and is missing; the bot asked Walter in game to resend it. Walter was at about (-1071.6,136,2299.3) facing west when he sent the rest. Owner: excavation (brain/excavation) plus the think planner.

## From Walter (2026-11-10): phase plan additions (see ROADMAP.md)
Approved in full: respawn network, hopper smelter, underground crop farm, shearing pens, sugarcane, pointed dripstone and safe lava farms (late Phase 2), camps as logged travel nodes with boats and desire paths (late Phase 2 to Phase 3), villager hall with Mending, fishing, and the tool and armor switch once diamond with Mending exists. Tool rule: the minimum tool that does the job, no wood after the early game, stone by default. Build in phase order; ROADMAP.md has the designs and the open "verify" items. Owner: the driver thread, per phase.
