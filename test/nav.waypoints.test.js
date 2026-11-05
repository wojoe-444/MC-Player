// brain/nav: named waypoints (waypoints.json + Xaero through xaero.js).
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { WaypointBook, convert, norm, dimOf } = require('../brain/nav/waypoints')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wp-'))
const fakeXaero = (byDim, world = 'W') => ({
  listWorlds: () => [{ name: world, waypoints: true, map: true }],
  waypoints: (w, dim) => (byDim[dim] || []).map(p => ({ disabled: false, set: 'gui.xaero_default', initials: 'X', ...p, dim }))
})
const XW = {
  0: [
    { name: 'Portal', x: -4369, y: 63, z: 2291 }, { name: 'Portal', x: -2977, y: 65, z: -4493 }, { name: 'Portal', x: -147, y: 68, z: 2663 },
    { name: 'Ice Portal', x: -1102, y: 63, z: -2178 }, { name: 'Valley Portal', x: -1042, y: 144, z: 2281 },
    { name: 'Seaside Winter Village', x: -1085, y: 63, z: -3674 }, { name: 'Mt Parros', x: -579, y: 255, z: 1990 },
    { name: 'Farm', x: -106, y: 69, z: 577 }, { name: 'House', x: -1068, y: 159, z: 2337, disabled: true }
  ],
  '-1': [{ name: 'Portal', x: -130, y: 61, z: 284 }, { name: 'Portal', x: -548, y: 64, z: 288 }, { name: 'Lava Source', x: -84, y: 32, z: 281 }, { name: 'Ice Portal', x: -131, y: 50, z: -283 }]
}
const book = (local, xaero = fakeXaero(XW)) => {
  const dir = tmp()
  if (local) fs.writeFileSync(path.join(dir, 'waypoints.json'), JSON.stringify(local))
  return new WaypointBook({ dir, xaero, world: 'W' })
}

test('merges waypoints.json with Xaero: counts, sources, dimensions', () => {
  const b = book({ 'crafting table': { x: -1051, y: 151, z: 2320 }, 'lava depot 1': { x: -1046, y: 136, z: 2317 } })
  assert.strictEqual(b.all(0).length, 9 + 2)
  assert.strictEqual(b.all(-1).length, 4)
  assert.deepStrictEqual({ local: b.sources.local, xaero: b.sources.xaero }, { local: 2, xaero: 13 })
  assert.strictEqual(b.find('crafting table').match.source, 'local')
})

test('duplicate names ("Portal" x3) get their coordinates, and each can be addressed', () => {
  const b = book(null)
  const names = b.all(0).filter(w => /^Portal/.test(w.name)).map(w => w.name)
  assert.deepStrictEqual(names.sort(), ['Portal (-147, 2663)', 'Portal (-2977, -4493)', 'Portal (-4369, 2291)'])
  const r = b.find('portal', { dim: 0, from: { x: -150, z: 2600 } })
  assert.ok(r.ambiguous && r.sameBase)
  assert.strictEqual(r.match.x, -147, 'nearest first')
  assert.strictEqual(r.candidates.length, 3)
  assert.strictEqual(b.find('portal -4369', { dim: 0 }).match.x, -4369)
})

test('a waypoint Walter saved himself wins over a Xaero one with the same name; an older Xaero import is only a fallback', () => {
  const b = book({
    Farm: { x: 1, y: 70, z: 2 },                                                // his own
    'ice portal': { x: -1102, y: 63, z: -2178, source: 'xaero' },               // old import, same coordinates as the live one
    'lost old thing': { x: 5, y: 60, z: 5, source: 'xaero' }                    // no longer in Xaero
  })
  const farm = b.find('farm').match
  assert.deepStrictEqual([farm.x, farm.source], [1, 'local'])
  assert.strictEqual(b.all(0).filter(w => /ice portal/i.test(w.name)).length, 1, 'no double entry')
  assert.ok(b.find('lost old thing').match, 'cached import still works as a fallback')
})

test('fuzzy: typos, partial names, filler words, case', () => {
  const b = book(null)
  for (const [q, want] of [['seaside winter vilage', 'Seaside Winter Village'], ['the farm', 'Farm'], ['MT PARROS', 'Mt Parros'], ['valley', 'Valley Portal'], ['ice portl', 'Ice Portal'], ['winter village', 'Seaside Winter Village']]) {
    const r = b.find(q, { dim: 0 })
    assert.ok(r.match, q)
    assert.strictEqual(r.match.name, want, q)
  }
  assert.strictEqual(b.find('nonsense place', { dim: 0 }).match, null)
  assert.strictEqual(b.find('', { dim: 0 }).match, null)
})

test('"portal" alone is ambiguous across different names, an exact name is not', () => {
  const b = book(null)
  const r = b.find('portal', { dim: 0, from: { x: -1040, z: 2280 } })
  assert.ok(r.ambiguous)
  const ice = b.find('ice portal', { dim: 0 })
  assert.ok(ice.exact && !ice.ambiguous)
})

test('dimensions: the Nether has its own list and can be searched when the name is not in this dimension', () => {
  const b = book(null)
  assert.strictEqual(b.find('lava source', { dim: 0 }).match, null)
  const r = b.find('lava source', { dim: 0, anyDim: true })
  assert.strictEqual(r.match.dim, -1)
  assert.strictEqual(dimOf({ game: { dimension: 'minecraft:the_nether' } }), -1)
  assert.strictEqual(dimOf({ game: { dimension: 'overworld' } }), 0)
  assert.deepStrictEqual(convert({ x: -1042, z: 2281 }, 0, -1), { x: -131, z: 285 })
  assert.deepStrictEqual(convert({ x: -130, z: 284 }, -1, 0), { x: -1040, z: 2272 })
})

test('portal pairs: overworld portals matched to the Nether portal ~1/8 of their coordinates', () => {
  const b = book(null)
  const pairs = b.portalPairs()
  const valley = pairs.find(p => p.ow.name === 'Valley Portal')
  assert.ok(valley && valley.nether.x === -130 && valley.off < 3)
  const far = pairs.find(p => p.ow.x === -4369)
  assert.ok(far && far.nether.x === -548)
})

test('near(): nearest first, with distances; disabled Xaero waypoints still count', () => {
  const b = book(null)
  const n = b.near({ x: -1050, z: 2300 }, 0, 3)
  assert.deepStrictEqual(n.map(w => w.name), ['Valley Portal', 'House', 'Mt Parros'])
  assert.ok(n[0].dist < 40)
})

test('re-reads files on a timer (a waypoint added in game or by Xaero shows up) and survives broken input', () => {
  let t = 0
  const dir = tmp()
  const b = new WaypointBook({ dir, xaero: fakeXaero({ 0: [] }), world: 'W', now: () => t, recheckMs: 5000 })
  assert.strictEqual(b.all().length, 0)
  fs.writeFileSync(path.join(dir, 'waypoints.json'), JSON.stringify({ shed: { x: 1, y: 2, z: 3 } }))
  assert.strictEqual(b.all().length, 0, 'cached for 5 s')
  t = 6000
  assert.strictEqual(b.all().length, 1)
  fs.writeFileSync(path.join(dir, 'waypoints.json'), '{ not json')
  t = 12000
  assert.strictEqual(b.all().length, 0, 'broken file: empty, no throw')
  const broken = new WaypointBook({ dir, xaero: { listWorlds() { throw new Error('boom') }, waypoints() { throw new Error('boom') } } })
  assert.strictEqual(broken.all().length, 0)
})

test('works without xaero at all (no APPDATA, other machine)', () => {
  const b = new WaypointBook({ dir: tmp(), xaero: null })
  assert.deepStrictEqual(b.all(), [])
})

test('name normalisation', () => {
  assert.strictEqual(norm('The  Seaside-Winter  Village!'), 'seaside winter village')
  assert.strictEqual(norm('Portal (-4369, 2291)'), 'portal 4369 2291')
})

test('real data: Walter\'s Xaero folder and waypoints.json (skipped when not on this machine)', (t) => {
  let xaero
  try { xaero = require('../xaero') } catch { return t.skip('xaero.js unavailable') }
  const world = 'HOME DEPOT GOD-EMPEROR'
  if (!xaero.listWorlds().some(w => w.name === world)) return t.skip('Xaero world not found')
  const b = new WaypointBook({ dir: path.resolve(__dirname, '..'), xaero, world })
  assert.ok(b.all(0).length >= 21)
  assert.ok(b.all(-1).length >= 10)
  assert.ok(b.find('seaside winter village', { dim: 0 }).match)
  assert.ok(b.find('lava depot 1', { dim: 0 }).match)
  assert.ok(b.portalPairs().length >= 8)
})
