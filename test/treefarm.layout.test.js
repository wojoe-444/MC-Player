// brain/treefarm/layout.js: the lit sapling lattice as pure geometry (no bot, no world: a block accessor over a Map)
const test = require('node:test')
const assert = require('node:assert')
const L = require('../brain/treefarm/layout')

// a flat world: grass at y=63, air above; `put` overrides single blocks
function world(put = {}, { ground = 63, soil = 'grass_block' } = {}) {
  const m = new Map(Object.entries(put))
  const get = (x, y, z) => {
    const k = `${x},${y},${z}`
    if (m.has(k)) { const n = m.get(k); return n === null ? null : { name: n, boundingBox: /^(air|short_grass|birch_sapling|torch|oak_leaves|birch_leaves)$/.test(n) ? 'empty' : 'block' } }
    if (y > ground) return { name: 'air', boundingBox: 'empty' }
    if (y === ground) return { name: soil, boundingBox: 'block' }
    return { name: 'stone', boundingBox: 'block' }
  }
  return { get, set: (x, y, z, n) => m.set(`${x},${y},${z}`, n) }
}
const farm = (o = {}) => L.makeFarm({ x: 10, y: 64, z: 10, ...o })

test('saplings sit on a lattice of period 4 (3 blocks between), in snake order', () => {
  const f = farm({ cols: 4, rows: 3 }), s = L.spots(f)
  assert.strictEqual(s.length, 12)
  assert.ok(s.every(p => (p.x - 10) % 4 === 0 && (p.z - 10) % 4 === 0))
  assert.deepStrictEqual(s.slice(0, 4).map(p => p.x), [10, 14, 18, 22])
  assert.deepStrictEqual(s.slice(4, 8).map(p => p.x), [22, 18, 14, 10], 'the second row walks back')
  for (let i = 1; i < s.length; i++) assert.strictEqual(Math.abs(s[i].x - s[i - 1].x) + Math.abs(s[i].z - s[i - 1].z), 4, 'no jump longer than one lattice step')
})

test('a torch in the middle of every lattice square plus one ring: torches are 4 apart (3 air between), none on a sapling spot', () => {
  const f = farm({ cols: 4, rows: 3 }), t = L.torchCells(f)
  assert.strictEqual(t.length, 5 * 4)
  const sp = new Set(L.spots(f).map(p => `${p.x},${p.z}`))
  assert.ok(t.every(c => !sp.has(`${c.x},${c.z}`)))
  for (const a of t) for (const b of t) if (a !== b) assert.ok(Math.abs(a.x - b.x) + Math.abs(a.z - b.z) >= 4, 'torches at least 4 apart: three air blocks between')
  // every sapling has a torch on all four diagonals
  for (const p of L.spots(f)) for (const [dx, dz] of [[2, 2], [-2, 2], [2, -2], [-2, -2]]) assert.ok(t.some(c => c.x === p.x + dx && c.z === p.z + dz))
})

test('light model: with torches at light 14 falling 1 per block, every sapling spot has light 10 or more and no cell of the farm is dark', () => {
  const f = farm({ cols: 5, rows: 4 }), t = L.torchCells(f), b = L.bounds(f)
  const light = (x, z) => Math.max(...t.map(c => 14 - (Math.abs(c.x - x) + Math.abs(c.z - z))))
  for (const p of L.spots(f)) assert.ok(light(p.x, p.z) >= 9, `sapling at ${p.x},${p.z} grows at light 9+`)
  for (let x = b.x0; x <= b.x1; x++) for (let z = b.z0; z <= b.z1; z++) assert.ok(light(x, z) >= 1, 'no cell at block light 0: nothing spawns here')
})

test('column(): free soil is ok; stone, water, lava, a roof, a tree and a planted sapling are told apart', () => {
  const w = world()
  assert.deepStrictEqual(L.column(w.get, 5, 5, { yHint: 64 }), { ok: true, state: 'empty', y: 64, floor: 'grass_block', lift: false })
  w.set(6, 63, 5, 'stone'); assert.strictEqual(L.column(w.get, 6, 5, { yHint: 64 }).reason, 'not-soil')
  w.set(7, 63, 5, 'water'); assert.strictEqual(L.column(w.get, 7, 5, { yHint: 64 }).reason, 'water')
  w.set(8, 63, 5, 'lava'); assert.strictEqual(L.column(w.get, 8, 5, { yHint: 64 }).reason, 'lava')
  w.set(9, 68, 5, 'stone'); assert.strictEqual(L.column(w.get, 9, 5, { yHint: 64 }).reason, 'blocked-above', 'a roof 4 blocks up leaves no room for a birch')
  w.set(10, 64, 5, 'birch_log'); const t = L.column(w.get, 10, 5, { yHint: 64 }); assert.strictEqual(t.state, 'tree'); assert.strictEqual(t.ok, false)
  w.set(11, 64, 5, 'birch_sapling'); assert.strictEqual(L.column(w.get, 11, 5, { yHint: 64 }).state, 'sapling')
  w.set(12, 64, 5, 'short_grass'); assert.strictEqual(L.column(w.get, 12, 5, { yHint: 64 }).ok, true, 'grass is no obstacle')
  w.set(13, 66, 5, 'birch_leaves'); w.set(13, 65, 5, 'birch_leaves'); assert.strictEqual(L.column(w.get, 13, 5, { yHint: 64 }).ok, true, 'leaves above are fine: a tree grows through them')
  assert.strictEqual(L.column(() => null, 5, 5, { yHint: 64 }).reason, 'unloaded')
})

test('column(): a canopy over the ground is looked under, not mistaken for the floor', () => {
  const w = world()
  for (let y = 66; y <= 67; y++) w.set(5, y, 5, 'oak_leaves')
  const c = L.column(w.get, 5, 5, { yHint: 66 })
  assert.strictEqual(c.y, 64); assert.ok(c.ok)
})

test('underground mode: stone floor gets a dirt block first (lift), the sapling goes one up; surface mode refuses stone', () => {
  const w = world({}, { soil: 'stone' })
  assert.strictEqual(L.column(w.get, 5, 5, { yHint: 64, mode: 'surface' }).reason, 'not-soil')
  const c = L.column(w.get, 5, 5, { yHint: 64, mode: 'underground' })
  assert.ok(c.ok && c.lift); assert.strictEqual(c.y, 65)
  w.set(5, 70, 5, 'stone')                                                       // a cave roof 5 above the floor: too low for a tree
  assert.strictEqual(L.column(w.get, 5, 5, { yHint: 64, mode: 'underground' }).reason, 'blocked-above')
})

test('pickRect: finds a level clear rectangle round home and keeps off the base, trees, water and avoid boxes', () => {
  const w = world()
  const home = { x: 0, z: 0 }
  const grid = () => L.scanGrid(w.get, 0, 0, 30, { yHint: 64 })
  const r = L.pickRect(grid(), home, {})
  assert.ok(r && r.ok === 12)
  const f = L.makeFarm({ x: r.x, y: r.y, z: r.z }), b = L.bounds(f)
  assert.ok(Math.hypot((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2) >= 6, 'not on top of the base')
  // a natural tree and a pond inside the best spot: the farm moves, the tree stays (it is never in the lattice)
  w.set(r.x + 4, 64, r.z + 4, 'birch_log'); w.set(r.x + 4, 63, r.z + 4, 'grass_block')
  w.set(r.x, 63, r.z, 'water')
  const r2 = L.pickRect(grid(), home, {})
  assert.ok(r2)
  const b2 = L.bounds(L.makeFarm({ x: r2.x, y: r2.y, z: r2.z }))
  assert.ok(!(r.x + 4 >= b2.x0 && r.x + 4 <= b2.x1 && r.z + 4 >= b2.z0 && r.z + 4 <= b2.z1), 'the natural tree is outside the rectangle')
  assert.ok(!(r.x >= b2.x0 && r.x <= b2.x1 && r.z >= b2.z0 && r.z <= b2.z1), 'so is the pond')
  // an avoid box excludes its area (pad 2)
  const r3 = L.pickRect(grid(), home, { avoid: [{ x0: -40, x1: 40, z0: -40, z1: 40 }] })
  assert.strictEqual(r3, null)
  // slope too steep -> none
  const w2 = world(); for (let x = -30; x <= 30; x++) for (let z = -30; z <= 30; z++) { const h = 63 + Math.floor((x + 30) / 2); for (let y = 64; y <= h; y++) w2.set(x, y, z, 'stone') }
  const g2 = L.scanGrid(w2.get, 0, 0, 30, { yHint: 70, up: 10, down: 12 })
  assert.strictEqual(L.pickRect(g2, home, {}), null, 'a 1-in-2 slope is not level ground')
})

test('summarize + torchState read a farm from the world', () => {
  const w = world(), f = farm({ cols: 2, rows: 2 })
  let s = L.summarize(f, w.get)
  assert.deepStrictEqual([s.spots, s.empty, s.saplings, s.trees, s.torches, s.torchSpots, s.unlit], [4, 4, 0, 0, 0, 9, 9])
  w.set(10, 64, 10, 'birch_sapling'); w.set(14, 64, 10, 'birch_log'); w.set(12, 64, 12, 'torch')
  s = L.summarize(f, w.get)
  assert.deepStrictEqual([s.empty, s.saplings, s.trees, s.torches, s.unlit], [2, 1, 1, 1, 8])
})
