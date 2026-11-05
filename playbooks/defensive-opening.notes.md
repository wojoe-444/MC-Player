# Notes on the defensive opening playbook (2026-11-05)

Companion to [defensive-opening.md](defensive-opening.md). Where the current bot differs from the draft, what the draft is missing, and what needs Walter's call.

## 1. Where the current bot differs

Sources: `brain/autopilot/{goals,plan,think,reflect}.js`, `brain/safety/{deaths,runtime}.js`, `bots/ozo/seed/brain/state/`.

**It has no shelter-first opening.** Two planners exist. The model planner (`think.js`, system prompt around line 536) is told:
"chop_trees (8+ logs) -> craft planks, crafting table, wooden pickaxe, sword -> gather stone -> stone tools, furnace -> hunt animals -> coal -> torches. Before the first night, have a shelter: dig into a hillside or wall yourself into a 1x2 cell... Craft a bed (3 wool + 3 planks; sheep give wool)."
The fallback routine list (`G.steps`, order set in `plan.js` ~line 825) is: eat, take-cover, rebed, cook, night-home, restock, tool-kit, harvest, wood, wooden-tools, stone, stone-tools, furnace, torches, wood-stock, wear, shield, iron-smelt, iron-gear, food, berries/fish/seeds/farm, coal, stash, **iron**, grove, light-home, tidy. Neither makes the dug-out room a shelter, bed and storage hub. `night-home` and `rebed` assume a `home()` already exists.

**The safe-farm and tree-source infrastructure comes after iron.** In the routine order, `iron` (the mine trip) sits ahead of `grove` (trees), `light-home` and `tidy`. This is deliberate and recent: the comment in `plan.js` says "iron before upkeep: grove, lighting and tidying kept winning every pick and the hillclimber never went mining". So the draft's order (infrastructure first) reverses a fix. The playbook answers this with time boxes and finite "done when" lists, so upkeep can't starve mining again. That's the main design risk to talk through (open question 3).

**Armor: no hard gate, but three soft pressures push toward it.**
1. `think.js` prompt: "Then: iron ..., smelt, craft iron pickaxe, sword and ARMOR (armor is wanted here...). Armor matters a lot on Hard." The default goal text also ends "... iron, armor."
2. `brain/safety/deaths.js:36`: after any archer, melee or creeper death with fewer than 2 armor pieces, it writes the lesson "wear armor before leaving the base" and raises `req.armor` to 2. The seed `safety-tuning.json` already has `armor: 2`, so that is permanently on. Effect in `runtime.js:238-251`: underground with fewer than 2 pieces counts as "unprepared" and lifts the minimum fight health to 12. Soft, but it keeps feeding the planner "armor" as the lesson of every death.
3. Seed `strategy.md` policy 2: "Armed before afield ... shield, armor when affordable".
The readiness gate (`think.js:116`) does not require armor (stone pickaxe, sword, hp 16, food 14, 64 filler, 16 torches), which is correct. The crafting order in `iron-gear` is pickaxe, sword, then chestplate, leggings, helmet, boots, and `shield` runs before it. So the code's iron *order* is already close to FOUR. The rush is in what the planner is told to value, and in the missing foundation (the bot gets iron with no farm, no lit perimeter, no sleep discipline, so it dies and loses the armor).

**The deaths say the problem is the surface at night, not the mine.** `safety-tuning.json` seeds 30 recorded deaths. By cause: skeleton archers 12, phantoms 6, zombies 4, creepers 4, endermen 2, fall 1, drowning 1. Position: 29 of 30 are at y 52 to 71, and 29 of 30 are within about 65 blocks of the island home (around 188,-291); the exceptions are one skeleton kill at y 21 and one drowning at the coast, 100 blocks out. That is surface and shallow, exactly what shelter, light and sleep address, and armor only softens. (Death times are spread across the day. I didn't check the in-game clock for each.)

**Phantoms (6 of 30) point at sleep.** Phantoms only target a player under open sky who has not slept for 3 or more in-game days. Walter's rule is "sleep every 3rd night", which puts the bot right on that threshold, and any missed sleep tips it over. Under the playbook the bot works underground at night, which also avoids phantoms. Worth checking, not proven: I haven't looked at the sleep log against those six deaths.

**The bot assumes it starts from nothing.** The think prompt says "brand-new world ... empty bag and no base" and crafts a bed from sheep wool. The draft assumes it already has a bed. That is a real difference in the first hour (sheep hunting is skipped), and Walter should say whether "starts with a bed" is true for a fresh start or just for respawns.

**Other differences**
- Light: the bot has `brain/lighting` and a `light-home` step, but they run late and torches are only "overplaced" per Walter's notes. The draft makes light a rule (8+ on every spawnable block), which wants a cheaper pattern than torch spam.
- Tree farm: `brain/treefarm` and the `grove` step already do "birch farm with 3-block spacing", which is Smeo444's job (see `site.json`). OzoGo444 would reuse that engine rather than a new one.
- Existing no-dig and work-zone rules (zone.json) remain; the first shaft must respect them. The playbook's "one shaft" rule matches Walter's earlier "one established surface shaft".

## 2. Gaps and risks in the draft

1. **Wooden pickaxe durability (59) vs a 6x6x3 room (108 blocks).** Drafted around: make the stone pickaxe after ~10 blocks.
2. **Water for the farm.** A bucket costs 3 iron, so the first farm needs natural water within 4 blocks, or the farm waits for iron. In an inland spot with no water, TWO stalls. Fallback: berries and animal pens first, farm after the bucket.
3. **Hand-punching 15 logs by day, then digging, then the patch: one day is tight.** Dusk comes at about 10 min of play. The playbook says: if dusk arrives, finish ONE underground.
4. **Skeletons shoot over fences and creepers blow them up.** A fence stops zombies and wandering animals, not the real killers. Light is the defense; the fence is mostly for keeping the crops from being trampled and pets in.
5. **Iron depth.** 15 blocks down is around y 45 to 50 at sea level, fine for coal and some iron, but most iron is lower (y 15 to 50). Drafted: extend the shaft after the room.
6. **Mine breaching a cave.** Drafted a rule (plug and go around), because the mine is the main place to meet open caves.
7. **Time boxes vs "never stall".** Without a time box, a finite checklist can still loop on a failing item (a tree that won't grow, wheat that won't take). Needs the same loop detector `G.step` already has.
8. **Respawn.** Dying in the room is safe, but dying in the mine drops the kit far from the bed. The "come up when ..." rules reduce this; a chest of spare tools in the room (stone pickaxe, sword, torches) makes a death cheap.
9. **Phantoms and the sleep rule** (above) may conflict with "sleep every 3rd night" in rule 4 of the world rules.

## 3. Open design questions for Walter

1. **Bed at start:** true for a fresh world, or only for respawns? If not, do we want sheep-for-a-bed as step zero?
2. **Iron order:** shield, sword, bucket, pickaxe, then armor chestplate first. Do you want the pickaxe or the bucket earlier, or armor earlier than the bucket?
3. **Infrastructure vs mining:** this reverses "iron before upkeep". Fine with time boxes? Or should TWO be a short "minimum viable" (6 trees, 12 wheat, lit) so the bot is mining by day 3?
4. **Where is home:** the shaft in the first stone you find, even when it's far from the island base? Or always inside the existing work zone near the Claudistan waypoint?
5. **Sleep:** sleep every night in the early game (kills phantoms, costs the night's mining), or keep "every 3rd night" and mine through the other two?
6. **Armor from chests:** the notes say "ask Walter before using chest items for armor". Keep it, and is spare iron in a shared chest OK for a shield?
7. **Animals:** pens (needs fence + wheat) as part of TWO, or leave to the berries/fishing steps?
8. **Scope:** hillclimber (OzoGo444) only? Smeo444 is the fixed assistant and already has a routine.

## 4. Mapping to the per-bot profile

The profile's `playbook` field is being added in another thread. This file is written so each lettered phase can become one entry: `id` (ONE, TWO, THREE, FOUR, FIVE), `time_box`, `done_when` (a list of inventory/world checks), and `posture` (the standing rules). I haven't assumed a schema. When that thread's format is known, convert this file mechanically. Implementation (a step source in `plan.js` or a new `playbook.js` consulted before the routine list, plus softening the armor prompts in `think.js`, `deaths.js` and `strategy.md`) is for after Walter signs off. No live behavior was changed.
