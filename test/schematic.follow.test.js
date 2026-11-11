// brain/schematic/follow.js: a schematic turned into work, in a safe order, with the world as judge.
const test = require('node:test')
const assert = require('node:assert/strict')
const F = require('../brain/schematic/format')
const FO = require('../brain/schematic/follow')

// a world as a Map of "x,y,z" -> { name, props }; unset cells are stone inside the box and unknown outside it
function world(box, fill = 'stone') {
  const m = new Map()
  for (let y = box.y0; y <= box.y1; y++) for (let z = box.z0; z <= box.z1; z++) for (let x = box.x0; x <= box.x1; x++) m.set(`${x},${y},${z}`, { name: fill, props: {} })
  const get = (x, y, z) => m.get(`${x},${y},${z}`) || null
  return { m, get, set: (x, y, z, name, props = {}) => m.set(`${x},${y},${z}`, { name, props }) }
}
// a little room design in rock: a 3x2x3 hall at y 2..3, a hopper in the floor, a torch, a water source, a slab, a trapdoor
function design() {
  const box = { x0: 0, y0: 0, z0: 0, x1: 6, y1: 6, z1: 6 }
  const w = world(box)
  for (let y = 2; y <= 3; y++) for (let z = 2; z <= 4; z++) for (let x = 2; x <= 4; x++) w.set(x, y, z, 'air')
  w.set(3, 1, 3, 'hopper', { facing: 'down' })
  w.set(3, 0, 3, 'chest', { facing: 'north', type: 'single' })
  w.set(2, 3, 2, 'torch')
  w.set(4, 2, 4, 'water', { level: '0' })
  w.set(4, 2, 3, 'oak_trapdoor', { facing: 'west', half: 'bottom', open: 'false' })
  const s = F.capture(w.get, box, { id: 'hall', kind: 'test', surround: 0 })
  return { s, box }
}

test('a finished build is 100% and complete; the design is its own answer key', () => {
  const { s, box } = design()
  const w = world(box)
  for (let y = 2; y <= 3; y++) for (let z = 2; z <= 4; z++) for (let x = 2; x <= 4; x++) w.set(x, y, z, 'air')
  w.set(3, 1, 3, 'hopper', { facing: 'down' }); w.set(3, 0, 3, 'chest', { facing: 'north', type: 'single' }); w.set(2, 3, 2, 'torch'); w.set(4, 2, 4, 'water', { level: '0' }); w.set(4, 2, 3, 'oak_trapdoor', { facing: 'west', half: 'bottom', open: 'false' })
  const p = FO.progress(s, w.get, s.origin)
  assert.equal(p.complete, true, FO.summary(p))
  assert.equal(p.pct, 100)
})

test('solid rock where the hall goes is dig work; a missing hopper is place; a wrong block is replace; a dry water cell is fluid', () => {
  const { s, box } = design()
  const w = world(box)                       // the world is solid stone: nothing dug yet
  const p = FO.progress(s, w.get, s.origin)
  assert.equal(p.complete, false)
  assert.ok(p.pct < 100)
  assert.ok(p.counts.dig >= 15, JSON.stringify(p.counts))
  assert.ok(p.work.some(c => c.kind === 'replace' && /hopper/.test(c.want)), 'stone where a hopper goes is replaced')
  assert.ok(p.work.some(c => c.kind === 'replace' && /water/.test(c.want)))
  // the same world with the hall dug: only the fittings are left
  for (let y = 2; y <= 3; y++) for (let z = 2; z <= 4; z++) for (let x = 2; x <= 4; x++) w.set(x, y, z, 'air')
  const q = FO.progress(s, w.get, s.origin)
  assert.equal(q.counts.dig, undefined)
  assert.ok(q.counts.place >= 4 || q.counts.replace >= 1, JSON.stringify(q.counts))
  assert.ok(q.work.some(c => c.kind === 'fluid' || /water/.test(c.want)))
})

test('an unloaded cell is never counted wrong and stops the build from being called complete', () => {
  const { s } = design()
  const p = FO.progress(s, () => null, s.origin)
  assert.equal(p.checked, 0)
  assert.equal(p.complete, false)
  assert.equal(p.verified, false)
})

test('a torch where open air is wanted is dug; water where air is wanted is a drain hazard; lava wanted and absent is forbidden', () => {
  assert.equal(FO.classify({ role: 'air' }, { name: 'torch' }), 'dig')
  assert.equal(FO.classify({ role: 'air' }, { name: 'water', props: { level: '0' } }), 'drain')
  assert.equal(FO.classify({ role: 'lava', level: '0' }, { name: 'air' }), 'forbidden')
  assert.equal(FO.classify({ role: 'water', level: '3' }, { name: 'water', props: { level: '5' } }), 'settle')
  assert.equal(FO.classify({ role: 'block', block: 'oak_trapdoor', props: { facing: 'west', half: 'bottom', open: 'true' } }, { name: 'oak_trapdoor', props: { facing: 'west', half: 'bottom', open: 'false' } }), 'toggle')
  assert.equal(FO.classify({ role: 'solid', block: 'cobblestone' }, { name: 'stone' }), 'ok')
  assert.equal(FO.classify({ role: 'solid', block: 'cobblestone' }, { name: 'oak_planks' }), 'replace')
})

test('order: digs spread outward from an open cell, placements go bottom up against something that stands, water and torches last', () => {
  const { s, box } = design()
  const w = world(box)
  w.set(3, 3, 1, 'air')                       // a doorway from outside, at the hall's wall (z 1), so the dig can start next to it
  const p = FO.progress(s, w.get, s.origin)
  const o = FO.order(p.work, w.get, { starts: [[3, 3, 1]], have: { cobblestone: 9, hopper: 1, chest: 1, water_bucket: 1, torch: 4, oak_trapdoor: 2 } })
  assert.equal(o.orphans.length, 0)
  const digs = o.steps.filter(x => x.phase === 'dig')
  assert.ok(digs.length >= 15)
  // each dig touches the doorway or an earlier dig
  const seen = new Set(['3,3,1'])
  for (const d of digs) { const near = FO.key([d.x, d.y, d.z]); assert.ok([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([a, b, c]) => seen.has(FO.key([d.x + a, d.y + b, d.z + c]))), 'dig ' + near + ' touches nothing open'); seen.add(near) }
  const placeKinds = o.steps.filter(x => x.phase !== 'dig').map(x => x.phase + ':' + (x.item || ''))
  assert.ok(placeKinds.indexOf('fluid:water_bucket') > placeKinds.findIndex(k => /torch/.test(k)), 'water after the torch: ' + placeKinds.join(' '))
  const hop = o.steps.find(x => x.item === 'hopper'); assert.ok(hop)
  assert.deepEqual(hop.face, [0, 1, 0], 'a hopper that faces down is placed by clicking the top of what is below it')
  assert.deepEqual(hop.ref, [3, 0, 3])
})

test('recipe: wall torch, trapdoor, slab, hopper facing sideways follow the game rules', () => {
  const stand = () => true
  let r = FO.recipe({ role: 'block', block: 'wall_torch', props: { facing: 'east' } }, [5, 5, 5], { standing: stand })
  assert.deepEqual(r.ref, [4, 5, 5]); assert.deepEqual(r.face, [1, 0, 0]); assert.equal(r.item, 'torch')
  r = FO.recipe({ role: 'block', block: 'oak_trapdoor', props: { facing: 'north', half: 'top', open: 'true' } }, [5, 5, 5], { standing: stand })
  assert.deepEqual(r.ref, [5, 5, 6]); assert.deepEqual(r.face, [0, 0, -1]); assert.equal(r.half, 'top'); assert.equal(r.after, 'open')
  r = FO.recipe({ role: 'block', block: 'stone_slab', props: { type: 'top' } }, [5, 5, 5], { standing: stand })
  assert.deepEqual(r.ref, [5, 6, 5]); assert.equal(r.half, 'top')
  r = FO.recipe({ role: 'block', block: 'hopper', props: { facing: 'east' } }, [5, 5, 5], { standing: stand })
  assert.deepEqual(r.ref, [6, 5, 5]); assert.deepEqual(r.face, [-1, 0, 0])
  assert.equal(FO.recipe({ role: 'solid', block: 'cobblestone' }, [5, 5, 5], { standing: () => false }), null, 'nothing to click yet: wait')
})

test('needs: filler blocks are pooled, a bucket is one', () => {
  const steps = [{ phase: 'place', item: 'cobblestone' }, { phase: 'place', item: 'stone' }, { phase: 'place', item: 'hopper' }, { phase: 'fluid', item: 'water_bucket' }, { phase: 'fluid', item: 'water_bucket' }, { phase: 'dig' }]
  assert.deepEqual(FO.needs(steps, { cobblestone: 1 }), { filler: 1, hopper: 1, water_bucket: 1 })
  assert.deepEqual(FO.needs(steps, { cobblestone: 5, hopper: 1, water_bucket: 1 }), {})
})

test('findAt: the cheapest place in the rock; never into lava, an unloaded chunk or a no-dig cell', () => {
  const { s } = design()
  const big = { x0: -20, y0: -10, z0: -20, x1: 30, y1: 20, z1: 30 }
  const w = world(big)
  const near = [5, 12, 5]
  let r = FO.findAt(s, w.get, near, { radius: 6, dy: [-8, 0], step: 2 })
  assert.equal(r.ok, true, JSON.stringify(r))
  // lava next to a would-be open cell: that anchor is out
  const lavaAll = world(big); for (let y = -10; y <= 20; y++) for (let z = -20; z <= 30; z++) for (let x = -20; x <= 30; x++) if ((x + z + y) % 3 === 0) lavaAll.set(x, y, z, 'lava', { level: '0' })
  assert.equal(FO.findAt(s, lavaAll.get, near, { radius: 6, dy: [-4, 0], step: 2 }).ok, false)
  assert.equal(FO.findAt(s, () => null, near, { radius: 4, dy: [-2, 0], step: 2 }).ok, false)
  assert.equal(FO.findAt(s, w.get, near, { radius: 4, dy: [-2, 0], step: 2, noDig: () => true }).ok, false)
})
