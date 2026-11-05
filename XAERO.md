# Reading Xaero's Minimap / World Map data (read-only)

Files: `xaero.js` (library, node core only), `xaero-read.js` (CLI). Neither writes anything under `.minecraft`.
Data root: `%APPDATA%\.minecraft\xaero` (override with env `XAERO_DIR`). Walter's world = `HOME DEPOT GOD-EMPEROR`.

## Library
```js
const xaero = require('./xaero');
const W = 'HOME DEPOT GOD-EMPEROR';
xaero.waypoints(W, 0);            // [{name,x,y,z,color,disabled,set,dim}]  dim 0 overworld, -1 nether
const map = xaero.openMap(W, 0);  // surface layer; openMap(W, -1) for the nether
map.at(x, z)          // {explored, height, rgb:[r,g,b], biome}  height = y of the top block (waypoint y is +1)
map.isExplored(x, z)
map.nearestUnexplored(x, z, {step:16, maxR:1024})  // {x,z,dist} or null
map.bounds()          // block bbox of region files that exist
```
Re-reads a region file automatically if Xaero rewrote it (checked every 5 s). Use `map.refresh()` to force.

## CLI
`node xaero-read.js worlds | waypoints [world] [dim] | near X Z [r] | info | at X Z | frontier X Z [maxR] | png X0 Z0 X1 Z1 out.png [scale]`

## What the data is, and the limits
- Waypoints: plain text, `minimap/<world>/dim%0/waypoints.txt`. Saved when Walter edits them in game.
- Map: `world-map/<world>/null/cache_1/<rx>_<rz>.xwmc` (rx,rz = floor(x/512), floor(z/512)). Zip of a binary
  cache (save version 2.24, decoded from XaerosWorldMap 1.39.10 bytecode). Per 64x64-block tile: ARGB colour per column,
  top height (12-bit signed + known flag) and biome. 205 overworld region files, all parse cleanly.
- It is a rendered top-down picture, not block ids. No ores, caves, blocks below the surface, or entities. Heights are the
  surface Xaero last drew (trees count as surface; water shows the water-surface height).
- Only covers columns Walter actually rendered with the mod on. Unexplored = `{explored:false}`.
- Files lag the live game: Xaero writes regions when it unloads/saves them, so recent exploring may be minutes behind.
- Format is tied to this mod version; a different Xaero version throws `unsupported Xaero cache version` per region
  (caught; `region().error` is set, `at()` reports unexplored).
- Cave-mode layers (`.../caves`) are not decoded.
- Checked: map height is within 2 of the saved waypoint y (minus 1) for 16 of 21 overworld waypoints. The rest are
  underground portals, a roof built over one, or columns where the stored height looks off (e.g. "Valley Portal" reads 25
  vs 144), so treat height as a hint and confirm with `bot.blockAt` before pathing on it.
