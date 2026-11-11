# brain/bases

Which waypoints are bases, and what the bots dig inside them. An observer: it listens, it never moves the bot or touches the world.

Walter (2026-11-11) saw the base in spectator mode and compared it to metal cast into an ant colony. The Bases page of the Bot Dashboard draws that
cast. It needs two records that did not exist, so this module writes them:

| file (in `bot-shared/`, next to `registry.json`) | shape | written by |
|---|---|---|
| `bases.json` | `{ worlds: { "<spawn x,z>": { bases: [ { id, name, x, y, z, radius, save, source, at } ] } } }` | every bot, from the waypoint book |
| `base-dug/<base id>.jsonl` | one line per block dug inside the base: `[x, y, z, block, bot, epochMs]` | the bot that dug it, on `diggingCompleted` |

* A base is a waypoint named in `config.json` (`bases`: `["Chicago"]`), found in the nav module's waypoint book (Xaero and `waypoints.json`), with a
  horizontal `radius` (110) at any height. Add a name to the list to make another waypoint a base. The id is `<slug>-<4 hex of the world>`; `save` is the name Xaero uses for the world (the save folder name for a LAN world), so the dashboard knows which save to read.
* "Inside the base" is decided when the block is dug, so the log says which base it belongs to; digs outside every base are not logged.
* Not logged (`config.json` `ignore`): tree trunks and leaves, plants, light, ladders, chests and fences, liquids, and any block the bot placed itself
  (`bot._placed`): taking those out hollows nothing.
* Only the bot's own digs are recorded, so Walter's digging does not appear. Placed blocks are not duplicated here: `brain/placed.js` already keeps them,
  and the dashboard assigns them to a base by the same radius.
* `bot._bases = { list(), at(pos) }` for code that wants to know which base a position is in.
* No backfill of old digs: they were never recorded. The page gets the open space itself from the world save (`dashboard/worldcast.js`: the underground air
  connected to the shaft, rooms and what the bots placed, inside the base circle) and labels it with what the registry and state files know; the dug log
  is the live overlay on top. That is a view for Walter in the dashboard; no bot reads the save.

The dashboard side is `dashboard/basecast.js` (`/api/bases`, `/api/bases/<id>`) and `dashboard/web/src/pages/Bases.tsx`.
After a merge the bot needs a restart to start logging; the page works before that.
