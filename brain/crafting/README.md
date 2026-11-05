# brain/crafting

Two chat commands for OzoGo444, registered with `api.commands.add` (so `brain/chat` can list them):

| command | help text | risk | what it does |
|---|---|---|---|
| `craft-item` | `craft <item> [count]` | high | mineflayer recipes; ingredients from the bag, then from indexed chests, taking **only what the recipe needs**; walks to a crafting table when a recipe needs one |
| `find-item` | `find <item>` | low | bag + `chest-index.json` + loaded blocks within 128, nearest first; read only |

## craft

Phrases (tested against the filler-stripped lowercase text): `craft glass pane`, `craft 10 glass pane`, `craft glass pane x16`,
`make 16 glass panes`, `make me a chest`, `craft a stack of sticks`, `craft planks`, `craft wooden pickaxe`.
`count` means "this many more" (the recipe may yield more: 10 glass panes = one craft = 16). A name that fits several items
(`pickaxe`, `planks`) is crafted if only one is makeable right now, otherwise it answers `Which one? ...` and does nothing.
`craft <anything>` is always ours (a typo gets "I don't know an item called ...", not the legacy stone-tool job). `make`/`create` are only
ours when the words are a real item. `craft tool set`, `craft tools`, `make yourself some tools` are left to the legacy job.

How it works:

1. `planner.js` (pure) plans from `prismarine-recipe` recipes: bag first, then chests; missing intermediates are crafted
   (logs -> planks -> sticks -> tool, up to 3 levels). Stored blocks are never uncrafted to supply a sub-step (a gold block is not
   broken up for a golden pickaxe), `lava_bucket` and other bucket-with-contents are never ingredients.
2. `chests.js` reads `chest-index.json` (never writes it) plus its own overlay `brain/state/crafting-chests.json` of what it saw when it
   last opened a chest, so a second command does not trust stale counts. It picks the fewest chests (nearest first) and walks to them.
3. In each chest it reads the real contents, withdraws at most the planned amount, re-plans, then crafts. If the chest held less than
   the index said it crafts what it can (`Crafted 32 ... (wanted 48; out of ingredients: ...)`) or reports exactly what is missing.
4. 3x3 recipes need a table: nearest visible `crafting_table` within 64, then the known one from `config.json` (-1051,151,2320).
   2x2 recipes (sticks, planks, ...) are crafted in the bag without walking.
5. Runs as one scheduler task `craft` at `PRIORITY.CHAT`, `onUserStop: 'cancel'`; it calls `safehand.ensureSafeForMove()` before every walk
   and checks `ctx.checkpoint()` between steps. A preempted job resumes toward the same target total (no double crafting).

Line of sight (Walter's survival-legit rule): before it opens a chest or uses a crafting table it calls the integrator's `api.ensureLineOfSight`
(`brain/los.js`): clear ray from the eye, otherwise it walks to a spot with a view, otherwise it leaves that chest/table alone and says
`No clear line to the chest at x,y,z (walls in the way)`. If `api.ensureLineOfSight` does not exist the module fails closed (opens nothing).
`find` only reads the index and loaded blocks, so it needs no line of sight.

Safety rules it keeps: no digging/placing; never takes `lava_bucket`; never takes anything from the furnace stations' fuel and input
chests, nor buckets from their output chests (rules in `config.json`, positions from `brain/furnace-config.json`); refuses to take items
when the bag cannot hold them (no piles on the ground); chat is one line when it starts a trip and one line at the end.

## find

`find glass`, `locate iron ingots`, `where are the beds`, `find planks`, `find glass panes`, `find galss`.
Names are matched whole first (`glass` stays `glass`, plurals only compared word by word), then families (`planks` = every `*_planks`),
then typos. If the exact name exists nowhere the search widens to longer names (`glass` -> `glass_pane`, `tinted_glass`) and says so.
Reply example: `glass: I carry 4; 9m 2 glass at -1040,128,2290; 21m chest -1043,128,2273 has 106 glass; 51m chest -1051,151,2324 has 30 glass.`
The full list (every group with its bounds) is written to `brain/state/find-last.txt`. Unknown words, pronouns, and `find furnace(s)` are
not claimed, so the legacy handler and `describeFurnaces` still answer them.

## For the integrator

1. Add `'crafting'` to `MODULES` in `brain/index.js` (the folder is loaded like the others; `BRAIN_DISABLE=crafting` or `state/disabled-modules.json` switches it off).
2. **Narrow the built-in `craft` command in `brain/index.js`.** It is registered before any module and its match
   `/\b(craft|tool ?set|make yourself)\b/` swallows `craft glass pane`. Suggested: `match: /\btool ?set\b|\bmake yourself\b|^craft (?:me )?(?:some |a |the )?tools?$/`.
   Until that is done the module notices the shadowing at `start()` (`status().shadowedByBuiltInCraft`) and answers owner lines itself from `onChat`,
   which covers everything Walter types. It cannot cover the chat module's fuzzy dispatch (`commands.dispatch` skips `onChat`), so fuzzy `craft ...`
   still hits the tool-set job until the match is narrowed.
3. No change to `join.js`. The legacy `find` branch keeps working for things this module does not claim.
4. Files written: `brain/state/crafting-chests.json`, `brain/state/find-last.txt`. Nothing else.

## Using it from another module: `api.crafting`

Registered at load, so look it up when you need it (`api.crafting` exists once this module is loaded, later than excavation/safety):

```js
// inside your own scheduler task; nothing is said in chat, you get the result back
const r = await api.crafting.craft(ctx, 'stone_pickaxe', 4, { chests: false, tableRadius: 96, placeTable: false })
// -> { ok, made, text, partial?, missing? }   text is a short first-person reason on failure ("Can't craft 4 stone pickaxe: missing 2 oak log ...")
api.crafting.canCraft('stone_pickaxe', 4)      // bag only, no walking -> { ok, missing:[...], needsTable }
```

It plans from the real recipes (sticks from whatever planks the bag has, logs -> planks, the right cobblestone/blackstone/deepslate variant), walks to
a crafting table with a clear line when the recipe needs one (`tableRadius` limits both the search and the known-table trek), checks that every
product actually shows up in the bag, and reports exactly what is missing. `chests: true` also takes from indexed chests (same protections as the chat command).
`placeTable: true` puts a crafting table on the floor beside the bot when none is reachable (makes one from 4 planks if needed). It is off by
default: placing a block is only for jobs that Walter has agreed allow it.

Why excavation's restock stopped with `no recipe stone_pickaxe`: it used `bot.recipesFor(id, null, 1, table)[0]`, which returns nothing when the bag
does not hold the ingredients of ONE craft at that moment (3 cobblestone/blackstone/deepslate and 2 sticks of a single kind), and the code then threw
"no recipe". Its stick/pickaxe arithmetic is an estimate that is never re-checked against the bag, and the message hides which ingredient was short. The
crafting module replaces the estimate with a plan and a verification after every craft.

## When the server ignores a craft ("the stick did not show up in my bag")

Live 2026-10-26 03:00 and 03:12: torches (bag grid) and ladders (table) both stopped at the stick step: `bot.craft` returned without an error, but
no sticks appeared. The bot-side click model is fine (replayed offline), so the server did not give the product. The cause is not confirmed.
Since the failure was silent and the earlier excavation restock ("no recipe stone_pickaxe") also needed freshly crafted sticks, treat it as one problem.
What the module does now (`doCraft`):
1. waits up to 3 s for the product (the server confirms slots a moment late), then
2. logs a `DIAG` line to idle.log (window type, cursor item, the 2x2/3x3 grid slots, planks and sticks in the bag) so the next occurrence shows where the items went,
3. gives back whatever is stuck in the grid or on the cursor (`recover`), then
4. retries: the same craft one at a time (`bot.craft(recipe, 1, ...)`, fresh window each time), then the other grid when the recipe fits both
   (table -> bag 2x2, bag 2x2 -> nearest table within 64), and only then fails with
   `the stick did not show up in my bag (tried 3 ways, details in idle.log)`.
If that still fails live, read the `DIAG` lines: items in the grid mean the click sequence was rejected; items on the cursor mean a click was interleaved
(auto-eat in farm.js and wearArmor in join.js also click the inventory window); sticks missing from everywhere mean the server never crafted.

First live DIAG lines (03:30 and 03:31): window closed, cursor empty, grid empty, bag already held 24-25 sticks and 5 planks. So nothing was stuck in the
grid; the batch just fell short of the count (partial arrival) and a later craft waited the full 20 s for `updateSlot:0` (ladder 03:31:25, stone_bricks 03:42:18).
Changes after that: `craftUnstuck` lets the craft run, and after 1.5 s (`craftSoftWaitMs`) emits the slot events on the open window every 300 ms so
mineflayer's own waits finish instead of timing out at 20 s; a batch of which only part arrived is continued with what is still missing instead of
being treated as a failure (`DIAG` now prints before/want). The hard timeout per craft call is 10 s + 1 s per craft (`craftTimeoutMs`).

## Fast bulk crafting (2026-10-26)

`craft stone bricks x98` used to be 25 crafts of mineflayer's `craft()`: about 8 awaited window clicks each (pick up, place four times, put away, take the
result, put it away), and a reopened table window per call. Now, for a step of 3+ crafts (or any step of a multi-step job):

1. the table is found once and its window is opened **once** per job (`craftMany` / the chat command / `api.crafting.craft`); every step and batch reuses it;
2. for each batch it sends `craft_recipe_request` (the recipe-book "fill the grid" packet) once per set, with `makeAll: false`: the first request puts one set
   in the grid and every further request adds one more set to each slot, so exactly the number of crafts asked for is placed (never the whole stack);
3. it checks the grid holds exactly that many sets, then **shift-clicks the result slot once**, which crafts everything in the grid (up to 64 sets per batch);
4. it waits for the product to show up in the bag, and repeats for the next batch.

So 98 stone bricks is 25 small packets and one click instead of about 200 clicks. `craftMany(ctx, [{name,count},...])` does a whole queue in one visit
(`craft tool set` uses it: sticks, then the five tools).
Measured on the toy server in `test/crafting.fast.helpers.js` with 25 ms per awaited click: 98 stone bricks 5.0 s before, 0.04 s after (about 5 vs 700 crafts/s).
That is a model, not the real game: the real number depends on the server tick (50 ms) and has to be read from the first live run
(`status().fast` counts batches/crafts/fails; `idle.log` has a line per failure).

Safety nets: any unexpected state (grid not filled to the exact number of sets, product missing after the shift-click, request ignored) returns the grid to the bag,
closes the window and finishes that step the old click-by-click way; the same recipe is not tried fast again, and after 3 failures the fast way is off until restart.
Recipes the recipe book does not list (not unlocked yet) simply use the old way.

**Needs one thing in join.js (integrator):** the server sends the recipe book (`recipe_book_add`) at login, before this module exists, and mineflayer drops it. Put this
right after `const bot = mineflayer.createBot(...)` so it is listening from the start:

```js
bot._recipeBook = new Map()
bot._client.on('recipe_book_add', (p) => { if (p.replace) bot._recipeBook.clear(); for (const e of p.entries || []) bot._recipeBook.set(e.recipe.displayId, e.recipe.display) })
bot._client.on('recipe_book_remove', (p) => { for (const id of p.recipeIds || []) bot._recipeBook.delete(id) })
```
Without it the fast way stays off (`status().fast.recipes` is 0) and everything works as before. If the packet layout of this protocol version differs, `status().fast.recipes` shows it.

Assumptions about vanilla 1.21.6 that the toy server encodes (check on the first live run, the `fails` counter and `idle.log` will say if they are wrong):
a non-`makeAll` request adds one set to a grid that already holds that recipe; a recipe must be unlocked (listed in the recipe book) to be placed;
shift-click on the result crafts every set in the grid and stops when the bag is full.

## Retiring join.js craftToolSet

`api.crafting.toolSet(ctx)` / the chat phrases `craft tool set`, `craft tools`, `make yourself some tools` now run through the planner and `api.gotoNear`
(no `bot.pathfinder.goto`, so no `GoalChanged` when nav ends a goal). To retire the legacy path: remove `craftToolSet` from the `jobs: { ... }` object passed to
`require('./brain')(...)` in join.js (then `brain/index.js` does not register its built-in `craft` command and nothing shadows this module), and later delete the
function and the two `craft|tool ?set|make yourself` branches in `handleCommand` (they are only reached when no brain command matched). `tools/patch-join.js` lists
`craftToolSet` in REQUIRED: keep the function until that list is updated, or just drop it from `jobs`.

## Chat module

The chat matcher sees one dynamic intent per command from the help text (`craft item count`, `find item`); it does not extract the item slot,
so only the existing `find <block>` slot logic reaches `find-item`. A `craft <item> [count]` slot rule in `brain/chat` would let fuzzy phrases
("could you make me some torches") dispatch `craft torch`.

## Tests

`node --test test/crafting.test.js` (58 tests: names, planner, chest rules, line of sight, the real brain wiring with a mock bot, find). Rig: `test/crafting.helpers.js`
(mock bot + mineflayer-style `bot.craft`). Phrases exercised: `craft glass pane 10`, `make 16 glass panes`, `craft 4 sticks`, `craft wooden pickaxe`,
`craft furnace`, `craft 48 glass pane`, `craft pickaxe`, `craft glass`, `craft flurbwidget`, `craft yourself a stick`, `craft tool set`, `craft tools`,
`make yourself some tools`, `make sure you are careful`, `find glass`, `find galss`, `find glass panes`, `find planks`, `where are the iron ingots`,
`locate iron ingot`, `find diamond`, `find the secret base`, `find furnaces`.

Not verified on the real game: the crafting-table window round trip (`bot.craft` with a table) and `container.withdraw` on a double chest.
Watch the first real `craft glass pane` once.
