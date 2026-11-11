# brain/ledger: who made this block?

Walter, 2026-11-11: *"we want to mostly remove the guesswork of 'what is what'... every space should be tracked as it's built. Imagine an enderman places a block: it
should be a quick code scan to confirm you didn't place it."*

The ledger is one record per cell, written **at the moment a bot digs or places** and read back by a Map lookup. A block with no record is known not to be ours
(natural, an enderman, Walter, a flow), with the date recording began so the caller knows how far back "no" can be trusted.

## What is in a record

`[t, op, x, y, z, block, by, space, via]` per line in `bot-shared/ledger/<world hash>/<bot>.jsonl` (one writer per file, every bot reads all; format in `lib.js`).

| op | meaning |
|---|---|
| `p` | placed by `by` (one of our bots); `block` = what was placed |
| `d` | dug by `by`; `block` = what was dug out (the cell is open now) |
| `r` | a placed block taken out again (a plug, scaffolding): nothing was hollowed, so the Bases cast ignores it |
| `f` | a solid block appeared and none of our bots placed it; `by` is a player who swung an arm within 6 blocks, else `other` |
| `x` | one of our blocks was removed or swapped by someone else |
| `S` / `B` | space metadata (kind, label) / a writer's coverage marker |

`space` is the named space or structure: the **same ids the registry, the state files and the dashboard use** (a shaft id, a room id such as `mobfarm-<shaft>`, `tree-<farm id>`,
`pen-<pen id>`, `crops`), or empty. `via` is the scheduler job that was holding the body (`mining`, `build`, `treefarm`...).

## How nothing slips past (three layers)

1. **The wire**: `bot._client.write` is wrapped for `block_dig`, `block_place` and `use_item`. Even a raw packet dig (`autopilot/mining.js`) leaves an *intent* (position, time, the job's scope).
2. **The server**: every `blockUpdate` in a loaded chunk is classified. Matches one of our intents: ours (`d`, `p`, `r`). A solid block appearing with no intent: `f`. One of our own records changed from
   outside: `x`. Water and lava count only as *source* blocks placed with a bucket in hand; flows, leaf growth, ice, falling sand and plants are nobody's placement.
3. **mineflayer**: `diggingCompleted` and `blockPlaced` are recorded directly as well (they carry the exact block); duplicates are dropped.

## Which space a cell belongs to

In order: (1) the scope the job declared, `scope.within({ id, kind, label }, fn)` from `brain/ledger/scope.js` (read when the packet is sent, so it follows awaits; `autopilot/ladder.js` declares each shaft dig);
(2) the geometry of the registry's shafts and rooms and of the bots' state files (tree farms, pens, the crop plot); a room beats the shaft it hangs off; (3) none.
Whenever a registry or state file changes, `reconcile()` **claims the unassigned cells inside the new box**, so a room dug before it was registered is still the room's. A cell inside a space stays in it
(taking a plug out of a farm wall is still the farm's work).

## The API (`bot._ledger`)

| call | answer |
|---|---|
| `whoMade(pos[, blockName])` | `{ verdict, ours, mine, by, op, block, t, space, via, current, why, coverageFrom }`; verdict is `placed-by-us`, `dug-by-us`, `removed-by-us`, `placed-by-other`, `changed-since` (we made it, something else stands there now), `unrecorded` |
| `isOurs(pos)` | boolean shortcut |
| `at(pos)`, `spaceAt(pos)` | the record; the space id (record, else geometry) |
| `near(pos, r)`, `inBox(box)`, `inSpace(id)` | records (chunk-indexed, no scan) |
| `spaces()`, `space(id)` | per space: dug, placed, removed, foreign, by bot, first/last, bounding box |
| `audit(box[, read])` | made blocks in the box nobody recorded (`foreign`), our placements that changed (`changed`), counts |
| `claim({ id, kind, label, box, since })`, `declare(...)`, `within(space, fn)` | give a space an identity; late-bind unassigned cells |
| `stats()`, `coverageFrom()`, `save()` | counts, when recording began |

## Who uses it

* **planner**: `STATE.where.space` (the space the bot stands in), `STATE.built_spaces` (the five nearest, with what was dug and placed) and the `who_made {x,y,z}` skill (`autopilot/think.js`).
* **inspector**: `brain/inspect` adds `placed-changed` (warn) and `foreign-block` (note) findings for a build the ledger watched from the start, and `stats.provenance`.
* **dashboard**: `dashboard/basecast.js` reads the ledger first: digs filed under a space colour that space on the Bases page (the "by part" mode), a space only the ledger knows becomes its own part,
  removed plugs and foreign blocks are not cast, and the notes say how many blocks appeared that no bot placed.
* `brain/state/ledger-summary.json` (every minute): the spaces list, for anything that wants it without the bot.

## Honest limits

* Coverage starts when a bot first runs the module (`B` marker) plus whatever the older `placed-blocks.json` held (imported once, from 11-10). Before that, "no record" means *unknown*, and `whoMade().why` says so.
* The ledger only knows what the server sent this client for loaded chunks. A block placed far away while no bot was loaded there is not seen (nothing here asks the server for more).
* `isEstablished` (autopilot/plan.js) still uses `brain/placed.js`; the ledger is not yet a source for what the planner refuses to dig (filler blocks in a named space are the open question).
* The older `bot-shared/base-dug/*.jsonl` (brain/bases) is still written; the ledger supersedes it and the cast reads both.
