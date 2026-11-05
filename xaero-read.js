#!/usr/bin/env node
// CLI over xaero.js (read-only). World defaults to the most recently updated one.
//   node xaero-read.js worlds
//   node xaero-read.js waypoints [world] [dim=0]  [--json]
//   node xaero-read.js near X Z [radius=500] [world] [dim=0]   waypoints close to a point
//   node xaero-read.js info [world]                            explored bounds / region count
//   node xaero-read.js at X Z [world]                          surface height, colour, biome, explored?
//   node xaero-read.js frontier X Z [maxR=1024] [world]        nearest unexplored column
//   node xaero-read.js png X0 Z0 X1 Z1 out.png [scale=1] [world]
const x = require('./xaero');
const fs = require('fs');
const [cmd, ...a] = process.argv.slice(2).filter(s => s !== '--json');
const json = process.argv.includes('--json');
const out = v => console.log(json ? JSON.stringify(v, null, 2) : (typeof v === 'string' ? v : JSON.stringify(v)));
const defWorld = () => x.listWorlds()[0]?.name;

switch (cmd) {
  case 'worlds': x.listWorlds().forEach(w => console.log(`${w.name}\twaypoints=${w.waypoints}\tmap=${w.map}\t${new Date(w.mtime).toISOString()}`)); break;
  case 'waypoints': {
    const w = a[0] || defWorld(), dim = +(a[1] ?? 0);
    const list = x.waypoints(w, dim);
    if (json) out(list); else list.forEach(p => console.log(`${p.name}\t${p.x} ${p.y} ${p.z}${p.disabled ? '\t(disabled)' : ''}`));
    break;
  }
  case 'near': {
    const [px, pz, r = 500, w = defWorld(), dim = 0] = a;
    const list = x.waypoints(w, +dim).map(p => ({ ...p, dist: Math.round(Math.hypot(p.x - px, p.z - pz)) })).filter(p => p.dist <= r).sort((p, q) => p.dist - q.dist);
    if (json) out(list); else list.forEach(p => console.log(`${p.dist}\t${p.name}\t${p.x} ${p.y} ${p.z}`));
    break;
  }
  case 'info': { const m = x.openMap(a[0] || defWorld()); out(m.bounds()); break; }
  case 'at': { const m = x.openMap(a[2] || defWorld()); out(m.at(+a[0], +a[1])); break; }
  case 'frontier': { const m = x.openMap(a[3] || defWorld()); out(m.nearestUnexplored(+a[0], +a[1], { maxR: +(a[2] || 1024) })); break; }
  case 'png': {
    const [x0, z0, x1, z1, file, scale = 1, w = defWorld()] = a;
    const m = x.openMap(w);
    fs.writeFileSync(file, x.renderPng(m, +x0, +z0, +x1, +z1, +scale));
    console.log('wrote ' + file);
    break;
  }
  default: console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 11).join('\n').replace(/^\/\/ ?/gm, ''));
}
