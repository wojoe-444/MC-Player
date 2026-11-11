// brain/schematic/designs.js: the bots' own build designs, as schematics (so the exact-diff check works on what the bots design themselves too). Pure.
'use strict'
const F = require('./format')
const MF = require('../mobfarm/geometry')

// brain/mobfarm/geometry.js layout -> schematic. Roles: the open cells (platform, corridors, drop column, kill pocket) are air, the water trench is water with the
// level it settles to, the hopper (facing down) and chest are exact, everything touching the open space is `solid` (natural rock or any solid wall: the design leaves the rock).
function mobfarmDesign(L, meta = {}) {
  const key = (c) => c[0] + ',' + c[1] + ',' + c[2]
  const m = new Map()
  const box = { x0: L.box.x0 - 1, x1: L.box.x1 + 1, y0: L.box.y0 - 1, y1: L.box.y1 + 1, z0: L.box.z0 - 1, z1: L.box.z1 + 1 }
  for (let x = box.x0; x <= box.x1; x++) for (let y = box.y0; y <= box.y1; y++) for (let z = box.z0; z <= box.z1; z++) m.set(x + ',' + y + ',' + z, { name: 'minecraft:stone', props: {} })
  for (const c of L.dig) m.set(key(c), { name: 'minecraft:air', props: {} })
  const lv = MF.waterLevels(L)
  for (const c of L.platform.trench) { const w = lv.get(key(c)); m.set(key(c), { name: 'minecraft:water', props: { level: String(w === 8 ? 0 : 8 - w) } }) }
  for (const c of L.platform.sources) m.set(key(c), { name: 'minecraft:water', props: { level: '0' } })
  m.set(key(L.chamber.chest), { name: 'minecraft:chest', props: { facing: 'north' } })
  m.set(key(L.chamber.hopper), { name: 'minecraft:hopper', props: { facing: 'down' } })
  for (const c of L.platform.plug || []) m.set(key(c), { name: 'minecraft:stone', props: {} })     // the corridor plug that closes the spawning room
  for (const c of L.chamber.torches || []) m.set(key(c), { name: 'minecraft:torch', props: {} })    // the kill corridor is lit (it is not the spawning room)
  return F.capture(F.getterOf(m), box, { id: meta.id || 'mobfarm-design', name: meta.name || 'Underground mob farm (the bots\' own design)', kind: 'mobfarm',
    purpose: 'a dark 17-wide diamond platform with a water trench to a drop of 22 blocks into a one-block pocket over a hopper and chest; the bot finishes the mobs through a slit',
    source: { world: 'design', save: null, capturedAt: new Date().toISOString(), by: 'brain/mobfarm/geometry.js' }, notes: ['Drawn from the design, not from a world.'] })
}
module.exports = { mobfarmDesign }
