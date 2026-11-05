# Solo survival hillclimb: running results

World: new LAN world "OGWO - Claudistan" (Hard, no cheats). Bot: OzoGo444, folder `Minecraft-Survival` (clean copy of Minecraft-Agent, no base-world memory).
Metric (brain/survival): per life, game ticks survived (24000 = 1 day), cause of death, nights survived, and ticks-since-life-start for each milestone
(log, table, wooden/stone/iron tools, furnace, food, coal, bed, iron, armor, diamond). A life only counts if it starts in daylight (Walter: no
no-inventory night strategies; night-start lives are excluded). Data: `brain/state/survival-summary.json`, `survival-runs.jsonl`. View: `node tools/watch.js`.

## Lives so far
| life | counts? | ticks | cause | note |
|---|---|---|---|---|
| 1 | no (night start) | 1580 | drowned | empty bag at dusk |
| 2 | no | 429 | zombie | respawned into the same night |
| 3 | no | 3011 | spider | |
| 4 | no | n/a | disconnect | connection reset |
| 5-9 | no | 14200 / 440 / 520 / 260 / 420 | witch, zombie, skeleton, zombie, zombie | planner dead (see below), routines only |
| 10 | yes (day start) | open | | log, wood tools, cobble, stone pick, furnace, stone sword, coal; sealed in for night 1 |

## Findings
1. The model planner (think.js through OpenRouter) failed with `breaker:payment` (out of credit) around 22:52. Lives 5-9 ran on the rule-based fallback only and died to mobs.
2. A dropped connection (ECONNRESET at 22:07) left the bot offline for 30 minutes because it was started without the supervisor. Always start with `node run.js` (MC_PORT env set).
3. `S.craft` for planks without a table times out (`updateSlot:0` never fires) and the wooden pickaxe craft fails with "missing ingredient". Crafting by hand at a placed table works (`bot.recipesFor(id, null, n, table)` then `bot.craft`). Fix S.craft to use the table for planks/sticks.
4. Autopilot loop and manual eval pilot fight over movement; set `ap.enabled=false` before driving by hand.
5. Mid-morning is short: 24000 ticks is 20 real minutes, dusk about 10 minutes in.

## Next
- Rejoin when Walter reopens the world (port changes every restart; run `MC_PORT=<port> node run.js`).
- Fix S.craft table handling; restore the planner (credit) or keep piloting by hand.
- Run daylight-start lives and compare ticks survived and milestone times between brain versions (git history in this folder).

## World 3 ("Forever2k27", port 60348, 2026-11-01)
Fresh spawn near 256,111,428. Lives 11-32 so far (22 lives, only 3 start in daylight: 11, 20, 21; the rest respawn at night with an empty bag and die within ~1-3 minutes).
- Best stretch: life 14/15 (daylight): log 380 ticks, table 1400, wooden pick 1260 (second run), cobblestone 2240, stone pick+sword 3740, furnace 5060.
- Top killers: drowning (about half), skeleton arrows, zombie/drowned. Pathing now penalises water (liquidCost 25).
- Base-world leftovers that stalled the bot, now removed: watchdog night-hold + forced shelter walk to (-1051,151,2320); safety "entombed" state staying on in the open; routines module (farm coordinates) disabled in this world.
- Open: needs `/time set day` (no cheats) to get clean daylight trials; planner still has no model credit (breaker:payment), so it runs on the fallback step list.

## Claudistan (Forever2k27, port 54564), 2026-11-02/03: Claude driving, automatic layer growing
- Driving model (Walter): Claude drives at the high level, reflexes and recurring processes move into the automatic layer over time.
- Added to the automatic layer: processes in brain/autopilot/plan.js (home/sleep, restock from home chest, tool-kit, torches via charcoal, wood stock, shield/iron gear, kelp + wheat farm, grove, lit home ring, stash, lit mine that moves when flooded or after a death there); goals.js loop detector, per-step time budgets, provisional cooldowns, no wandering at night; brain/breath (drowning + suffocation reflexes); zone guard; hot reload of all modules.
- Death rate: from one every few minutes (lives 15-90) to 4 deaths in ~4 hours (2 drowning before the reflex fix, 2 suffocation in one gravel pocket before death-place memory).
- Root causes found on the way: base-world coordinates left in explore and the night guard; event-loop blocking scan caused server resets; 2x2 crafting unreliable (craft at a carried table); stale crafting window broke chests and crafts; torch recipe variants; oxygen reported in ticks.
- Paused 02:52 UTC at Walter's request; bot offline.

## Claudistan, 2026-11-03 day session (port 50991)
- Progress: first iron 15:42 UTC, shield + iron pickaxe, iron sword + boots 17:22, rebuilt kit several times; iron helmet 01:54, iron chestplate 04:08 (Nov 4).
- Walter's input applied as mechanisms: established vs incidental (built things never broken by pathing/digging, home = own bed), no building on the sea, torch spacing, level farm field, reset process (tp/spawnpoint/time commands via a loop breaker).
- Freeze hunting: door rescan 96 blocks per goal change, bed scan 160, water-crossing check, dashboard timer; profiler (brain/lag) loads first; think layer switched off (brain/state/think-off).
- Deaths: water and gravel early; later pillagers/skeletons at night or near home without armor -> take-cover process; one respawn trap in an underground bed room (fixed by stable home + loop breaker).
- World closed ~04:35 UTC Nov 4; bot supervisor retrying.
