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
  return F.capture(F.getterOf(m), box, { id: meta.id || 'mobfarm-design', name: meta.name || 'Underground mob farm (the bots\' own design)', kind: 'mobfarm', surround: 0,
    purpose: 'a dark 17-wide diamond platform with a water trench to a drop of 22 blocks into a one-block pocket over a hopper and chest; the bot finishes the mobs through a slit',
    source: { world: 'design', save: null, capturedAt: new Date().toISOString(), by: 'brain/mobfarm/geometry.js' }, notes: ['Drawn from the design, not from a world.'] })
}

// A small built-for-looks example (mode 'aesthetic': every block is wanted as itself): a gabled oak hut on a cobblestone foundation in a fenced yard with torches.
// It exists so the Schematics page has a second kind of build to show, and so the aesthetic mode is tested on something with stairs, fences, glass, a door and torches.
function starterHut(meta = {}) {
  const m = new Map(), set = (x, y, z, name, props = {}) => m.set(x + ',' + y + ',' + z, { name: 'minecraft:' + name, props })
  const X = 13, Z = 11
  for (let x = 0; x < X; x++) for (let z = 0; z < Z; z++) set(x, 0, z, 'grass_block')
  for (let x = 3; x <= 9; x++) for (let z = 2; z <= 8; z++) set(x, 0, z, 'cobblestone')                       // foundation
  for (const z of [9, 10]) set(6, 0, z, 'stone_bricks')                                                       // path to the door
  for (let x = 3; x <= 9; x++) for (let z = 2; z <= 8; z++) {                                                   // walls, y 1..3
    const edge = x === 3 || x === 9 || z === 2 || z === 8; if (!edge) continue
    const corner = (x === 3 || x === 9) && (z === 2 || z === 8)
    set(x, 1, z, corner ? 'oak_log' : 'cobblestone')
    for (const y of [2, 3]) set(x, y, z, corner ? 'oak_log' : 'oak_planks')
  }
  for (const [x, z] of [[6, 2], [6, 8], [3, 5], [9, 5], [5, 2], [7, 2], [5, 8], [7, 8]]) set(x, 2, z, 'glass_pane')    // windows
  set(6, 2, 8, 'oak_door', { facing: 'north', half: 'lower', hinge: 'left', open: 'false' }); set(6, 3, 8, 'oak_door', { facing: 'north', half: 'upper', hinge: 'left', open: 'false' })
  for (let x = 2; x <= 10; x++) {                                                                               // the gable roof, ridge along x
    set(x, 4, 1, 'oak_stairs', { facing: 'south', half: 'bottom', shape: 'straight' }); set(x, 4, 9, 'oak_stairs', { facing: 'north', half: 'bottom', shape: 'straight' })
    for (let z = 2; z <= 8; z++) set(x, 4, z, 'oak_planks')
    set(x, 5, 2, 'oak_stairs', { facing: 'south', half: 'bottom', shape: 'straight' }); set(x, 5, 8, 'oak_stairs', { facing: 'north', half: 'bottom', shape: 'straight' })
    for (let z = 3; z <= 7; z++) set(x, 5, z, 'oak_planks')
    set(x, 6, 3, 'oak_stairs', { facing: 'south', half: 'bottom', shape: 'straight' }); set(x, 6, 7, 'oak_stairs', { facing: 'north', half: 'bottom', shape: 'straight' })
    for (let z = 4; z <= 6; z++) set(x, 6, z, 'oak_planks')
    set(x, 7, 4, 'oak_stairs', { facing: 'south', half: 'bottom', shape: 'straight' }); set(x, 7, 6, 'oak_stairs', { facing: 'north', half: 'bottom', shape: 'straight' })
    set(x, 7, 5, 'oak_slab', { type: 'bottom' })
  }
  for (let y = 5; y <= 8; y++) set(8, y, 4, 'cobblestone')                                                      // chimney
  for (let x = 0; x < X; x++) for (const z of [0, Z - 1]) set(x, 1, z, 'oak_fence')                              // yard fence
  for (let z = 0; z < Z; z++) for (const x of [0, X - 1]) set(x, 1, z, 'oak_fence')
  m.delete('6,1,10'); set(6, 1, 10, 'oak_fence_gate', { facing: 'north', open: 'false' })
  for (const [x, z] of [[0, 0], [X - 1, 0], [0, Z - 1], [X - 1, Z - 1]]) set(x, 2, z, 'torch')                    // torches on the corner posts
  set(5, 3, 9, 'wall_torch', { facing: 'south' }); set(7, 3, 9, 'wall_torch', { facing: 'south' })
  const box = { x0: 0, y0: 0, z0: 0, x1: X - 1, y1: 9, z1: Z - 1 }
  return F.capture((x, y, z) => m.get(x + ',' + y + ',' + z) || { name: 'minecraft:air', props: {} }, box, {
    id: meta.id || 'starter-hut', name: meta.name || 'Starter hut (a design)', kind: 'house', mode: 'aesthetic', surround: 2,
    masks: [{ x0: 0, y0: 1, z0: 0, x1: X - 1, y1: 9, z1: Z - 1 }, { x0: 3, y0: 0, z0: 2, x1: 9, y1: 0, z1: 8 }, { x0: 6, y0: 0, z0: 9, x1: 6, y1: 0, z1: 10 }],
    purpose: 'A gabled oak hut on a cobblestone foundation in a fenced yard. A built-for-looks example: every block is exactly the one drawn.',
    source: { world: 'design', save: null, capturedAt: new Date().toISOString(), by: 'brain/schematic/designs.js' }, notes: ['Drawn from a design, not from a world.'] })
}
module.exports = { mobfarmDesign, starterHut }
