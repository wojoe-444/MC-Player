#!/usr/bin/env node
// Dump Xaero world-map data (read-only) on the same grid layout the worldpreview mod writes, so the two can be
// compared. Writes OUT/meta.json, surface.i16 (-32768 = not explored), biome.u16 (65535 = unknown).
//   node tools/worldpreview/xaero-grid.js "<xaero world>" X0 Z0 X1 Z1 STEP OUT_DIR
// Xaero height = y of the top block drawn (trees/leaves count; water shows the water surface). The mod's surface
// grid is world-surface-height (y of the first air block above the top block), so it is Xaero + 1 on bare ground.
const fs = require('fs');
const path = require('path');
const xaero = require('../../xaero');

const [world, x0s, z0s, x1s, z1s, steps, out] = process.argv.slice(2);
if (!out) { console.error('usage: node xaero-grid.js "<world>" X0 Z0 X1 Z1 STEP OUT_DIR'); process.exit(2); }
const x0 = +x0s, z0 = +z0s, step = +steps;
const nx = Math.max(1, Math.floor((+x1s - x0) / step)), nz = Math.max(1, Math.floor((+z1s - z0) / step));
const map = xaero.openMap(world, 0);
const surface = new Int16Array(nx * nz).fill(-32768);
const biome = new Uint16Array(nx * nz).fill(65535);
const names = [], ids = new Map();
let explored = 0;
for (let iz = 0; iz < nz; iz++) {
  for (let ix = 0; ix < nx; ix++) {
    const c = map.at(x0 + ix * step, z0 + iz * step);
    if (!c.explored || c.height == null) continue;
    explored++;
    surface[iz * nx + ix] = c.height + 1;
    if (c.biome) {
      if (!ids.has(c.biome)) { ids.set(c.biome, names.length); names.push(c.biome); }
      biome[iz * nx + ix] = ids.get(c.biome);
    }
  }
}
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'surface.i16'), Buffer.from(surface.buffer));
fs.writeFileSync(path.join(out, 'biome.u16'), Buffer.from(biome.buffer));
fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify({
  name: 'xaero:' + world, source: 'xaero', x0, z0, step, nx, nz, seaLevel: 63, biomes: names, explored,
}, null, 1));
console.log(`wrote ${out}: ${nx}x${nz}, explored ${explored} (${(100 * explored / (nx * nz)).toFixed(1)}%), ${names.length} biomes`);
