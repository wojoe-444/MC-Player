# Villager farming: design (v1, for Walter's review)

Owner: villager thread. Module folder: `brain/villagers/` (register(api) per `brain/INTERFACE.md`). Status: **Phase 0 is being built now (nothing in
the world gets placed or broken). Phases 2+ (building the hall) wait for Walter's "approve villager plan".**

**Walter's decision so far: "we'll build a new hall for the villager farming"**, so the plan is a fresh, purpose-built hall (no reuse of an
existing building). He has not yet said "approve villager plan"; nothing is placed or broken until he does. Questions 1-3 in section 8 are still
open and my defaults apply.

## 1. Goal

A villager economy the bot can run by itself: **emeralds in (selling surplus crops), valuable trades out** (Mending, Efficiency V, Unbreaking III,
Fortune III, diamond gear, arrows, food, bells), with villagers kept safe and trading prices cheap (curing).

Biggest payoff, in order: (1) a librarian we can re-roll until it sells Mending; (2) selling the farm surplus (house chest holds ~380 carrots and
80 wheat) to a farmer for emeralds; (3) cured villagers for 30-80% cheaper trades; (4) armorer/toolsmith diamond gear; (5) breeding to a cap.

## 2. Rules that hold for everything here (CLAUDE.md + INTERFACE.md section 5)

- Survival-legit: no teleporting, no slash commands, no x-ray. Every villager interaction needs `api.canSee(entity)`; every placed or broken block
  needs `api.canSee(block)` / `api.ensureLineOfSight`. A villager we have not seen is "unknown", never assumed.
- Never hit a villager. Never wear or carry lava while moving (`safehand.ensureSafeForMove()` before each walk). No item piles: food for breeding is
  tossed in small batches and the leftovers picked up again.
- Chat is short and rare. Commands answer once; the idle upkeep says nothing unless something changes. Chat from Walter pauses upkeep (idleOnly task,
  priority below FARM, above EXCAVATE). Safety (zombies, pillagers, low health) always preempts.
- Placing and breaking blocks only inside an **approved plan** (below). Spending emeralds only on wishlist trades, within a per-run cap, and every
  deal is logged to the ledger.
- Persist only via `api.statePath('villagers-state.json')`.

## 3. Phases (what gets built, when, and what Walter sees)

| phase | what | touches the world? | needs Walter |
|---|---|---|---|
| **0 (now)** | perception (`find villagers`, `villager status`), trade ledger, valuation of trades, `trade for X`, selling crops, tests | only talking to villagers and opening their trade window | no |
| 1 | site survey + a concrete hall plan drawn on the real terrain (`villager plan`): block list, materials, cost, where the beds/workstations/cells go | no | **yes: approve the plan** |
| 2 | materials gathering via crafting + chests, then building the hall (placing blocks, lighting, doors) | yes, only plan blocks | approved plan |
| 3 | feeding + breeding to a cap, babies grow, professions claim workstations | tossing food | approved plan |
| 4 | librarian re-roll loop (break and replace the lectern before the first trade until a wanted book shows) | breaks/places one lectern | approved plan |
| 5 | curing (zombie villager + splash weakness + golden apple), restock cycle, golem/zombie defence upkeep | yes | approved plan |
| 6 | "villager upkeep" idle routine ties it together; dashboard line | no | no |

Phase 0 is useful on its own: if villagers already exist anywhere reachable (a village, a trapped one), the bot can trade right away.

## 4. The hall (plan only; nothing is placed until approved)

One compound, sized by how many villagers we want (default cap **8 adults**, config `breeding.cap`):

1. **Breeding room** (about 7x7 inside, 3 high): roof and walls on all sides, floor lit to light level 8+ everywhere (torches/lanterns on the
   walls; hostile mobs need darkness), more **beds than adults** (villagers only breed with a free bed), a composter and two other workstations,
   door = a fence gate or double door the bot passes through (zombies only break doors on Hard; difficulty is read from `bot.game.difficulty`
   and a plain door is refused on Hard).
2. **Trading cells**: one 1x2 cell per profession villager, each with its own workstation, no bed (so it cannot wander), a **front panel the bot can
   see through but the villager cannot leave by** (iron bars first; the cell test is: `api.canSee(villager)` from the corridor spot, checked once
   on a single prototype cell before building the rest). The villager keeps its profession because the workstation is in the cell.
3. **Corridor** in front of the cells for the bot, lit, roofed; **a second door** so the hall is an airlock.
4. **Zombie and golem protection**: full roof and walls, lit floor, no gaps at the base, fences or bars not trapdoors at ground level; an iron golem
   pair is optional (left to Walter: golems sometimes attack the player if the bot hits a villager, which it never does).
5. Site rules: on land that is already built over or flat grass the bot judges best (Walter trusts the choice), at least N blocks from the home and
   farms, not above a cave. The plan prints the chosen spot and **why**, with 2 alternatives.

The plan output (`villager plan`) is a text/ASCII layer map, the material list (planks, glass/bars, beds, workstations, torches) and what the bot
already has or can fetch from the chests listed in `chest-index.json`.

## 5. Economy (Java 1.21.6 behaviour, to verify live)

- **Sell**: farmer buys wheat 20, carrots 22, potatoes 26, beetroot 15 for 1 emerald each batch (the farm routine's surplus); fletcher buys sticks
  and string; librarian buys paper. Selling is the income. `sell crops` is a command.
- **Buy wishlist** (config `wishlist`, scored in `trades.js`): enchanted books (Mending, Efficiency V, Unbreaking III, Fortune III, Protection IV,
  Sharpness V, Looting III, Feather Falling IV, Silk Touch, Depth Strider III), diamond pickaxe/axe/shovel/sword and armour (toolsmith, armorer,
  weaponsmith), arrows, bread/cooked meat, bell, experience bottles. Each has a max emerald price; the bot only buys at or under it.
- **Prices**: cured villagers give a large permanent discount; trading often with the same villager raises demand prices, restocking (up to twice
  a day when it can reach its workstation) resets them. The ledger remembers each villager's offers and when they were last seen.
- **Locks**: a villager's profession locks after the first trade; to re-roll a librarian the bot breaks and re-places the lectern **before** trading,
  reads the offered book (opening the window) and repeats. Phase 4, gated by the plan.

## 6. Module layout and how it plugs in

```
brain/villagers/
  index.js      register(api): commands, upkeep routine, status() for the dashboard
  config.json   wishlist, price caps, caps (villagers, emeralds per run), intervals
  perceive.js   pure: classify entities (villager, baby, zombie villager, golem), read profession, summarise
  trades.js     pure: describe a trade, score against the wishlist, parse enchantments, plan a purchase or a sale
  state.js      villagers-state.json: seen villagers (id, pos, profession, level, last offers, last seen), ledger, plan flags
  trade.js      runtime: walk to a villager (api.gotoNear), check api.canSee, openVillager, evaluate, trade, close, record
  README.md     commands, files written, what the integrator wires in
```

- **Hand-over to the integrator**: add `'villagers'` to the `MODULES` list in `brain/index.js` (the integrator owns that file; I do not edit it).
- **Scheduler**: one idle routine `villager-upkeep` (priority between FARM and FURNACE, `idleOnly`, `defaultEnabled:false`; Walter turns it on with
  `villager upkeep on`). Chat commands that do work submit a `PRIORITY.CHAT` task with key `villagers`; "stop" cancels it.
- **Commands** (all `commands.add`, wording tested through the chat module): `find villagers`, `villager status`, `trade for <item|enchant>`,
  `sell crops`, `villager plan` (phase 1), `approve villager plan` / `villager upkeep on|off`, later `breed villagers`, `cure villager`.
- **Needs from other modules**: farm routine for crop surplus (house chest), crafting for beds/workstations (`brain/crafting`), safety for zombies,
  `api.depositSmeltables`-style helpers are not used (emeralds are valuables and go to a chest Walter names).

## 7. Tests (mock bot)

`test/villagers.helpers.js` extends the shared mock bot with villager entities (profession metadata, baby flag), a fake trade window
(`openVillager`, `trade`) and line-of-sight blocks. `test/villagers.test.js` covers: classification, scoring and purchase planning, price caps, the
emerald budget, refusing to trade without line of sight, unseen villagers reported unknown, `trade for X` end to end, persistence, commands and
that chat during a task pauses it.

## 8. Questions for Walter (my defaults in brackets, I proceed with them unless he objects)

1. Is there a village or any villager in the world I should start from? [Phase 0 `find villagers` will look around the known waypoints.]
2. Game difficulty? [read from the server; if Hard, doors are replaced by a fence-gate airlock.]
3. Where may emeralds and valuables go? [a new chest next to the house chest, which I will ask him to place or name.]
4. Hall size: 8 adult villagers, 4 trading cells to start. [fine to start smaller.]
5. May I break and re-place one lectern inside the approved hall to re-roll librarians? [needed for Mending; only inside the plan.]
