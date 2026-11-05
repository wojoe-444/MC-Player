# brain/villagers (Phase 0)

Design and phases: `DESIGN.md`. This folder only **talks to villagers**: it never places or breaks a block and never hits anything. The hall
(building, breeding, lectern re-roll, curing) waits for Walter's plan approval.

## Commands (chat phrases tested in test/villagers.test.js)
| say | does | risk |
|---|---|---|
| `find villagers`, `are there any villagers around`, `where are the villagers` | scans loaded entities within 48 blocks; counts villagers/babies/zombie villagers/golems; professions only for those in line of sight | low |
| `villager status` | known villagers, emeralds on me / spent / earned, best known wishlist deals, hall state | low |
| `trade for mending`, `trade for efficiency 5`, `trade for diamond pickaxe`, `get me arrows from a villager` | visits known job villagers (best remembered offer first), opens the trade window, buys the cheapest acceptable offer under the price cap and the 128-emerald trip budget | high |
| `sell crops`, `sell my extra wheat` | sells inventory surplus (keeps 32 of wheat/carrot/potato, 16 beetroot) to villagers that pay emeralds | high |
| `villager plan` / `approve villager plan` | shows / records Walter's approval of the design (only `OGWO`); this does **not** unlock building by itself | low / high |
| `villager upkeep on` / `off` | idle routine `villager-upkeep` (off by default): refreshes remembered offers every 15 min, buys nothing | high / low |

## Rules it keeps
Line of sight: `api.canSee(entity)` before every trade window (tries 4 other spots around the villager, otherwise says "no clear line of sight").
Unseen villagers are "unknown" (no profession is reported or stored for them). Stops the trip when health is low or a hostile is within 8 blocks.
Walks only after `safehand.ensureSafeForMove()`. Chat only when a command finishes. Villagers that are nitwits, jobless or babies are skipped.

## Files
- `state`: `brain/state/villagers-state.json` (villagers met with last offers, ledger of every deal, totals, plan flags, upkeep flag).
- Config: `config.json` (wishlist with price caps, sell list and reserves, budget, scan radius).
- Tests: `test/villagers.test.js` + `test/villagers.helpers.js` (mock villagers, trade windows, ray casts).

## Integrator: what to change
1. Add `'villagers'` to the `MODULES` list in `brain/index.js`. Nothing in `join.js` changes.
2. `api.gotoNear` must accept `reach` (it does: `brain/util.js`). The module uses `api.canSee`, `api.safehand`, `api.scheduler`, `api.commands`.
3. The module needs `bot.openVillager` / `bot.trade` (mineflayer 4.39 has them); it relies on `villager_data` metadata for professions and tolerates
   it being absent (professions then come only from recorded trades).

## Not yet verified live (needs one real villager)
Profession metadata shape on 1.21.6, `stored_enchantments` parsing of enchanted-book offers, and the 3-block reach used in `approach()`. The first
`find villagers` + `trade for X` on a real librarian will confirm or correct these; logs go to `idle.log` with tag `villagers`.
