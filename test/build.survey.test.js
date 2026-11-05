const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { mockBot } = require('./mock-bot')
const { extend, makeGround } = require('./build.helpers')
const { findSite, survey } = require('../brain/build/survey')
const cfg = require('../brain/build/config.json')

const C = { x: -984, z: 2292 }
const R = 14
// grass world around the centre: ground(x, z) -> top block y
function world(ground = () => 70, { pad = 22 } = {}) {
  const bot = extend(mockBot({ pos: [C.x, 71, C.z] }))
  makeGround(bot, { x0: C.x - R - pad, x1: C.x + R + pad, z0: C.z - R - pad, z1: C.z + R + pad, ground })
  return bot
}
const OPTS = { center: C, radius: R, maxDy: 1, protect: cfg.protect }
const footprint = (s) => ({ x0: s.ox - 1, x1: s.ox + 5, z0: s.oz - 1, z1: s.oz + 5 })
const inside = (s, x, z, pad = 0) => { const f = footprint(s); return x >= f.x0 - pad && x <= f.x1 + pad && z >= f.z0 - pad && z <= f.z1 + pad }

test('flat ground: the site is the origin at the centre, base level one above the grass', () => {
  const bot = world()
  const s = findSite(bot, OPTS)
  assert.ok(s)
  assert.deepStrictEqual([s.ox, s.oy, s.oz], [C.x, 71, C.z])
  assert.strictEqual(s.flat, 0); assert.deepStrictEqual(s.low, []); assert.strictEqual(typeof s.score, 'number')
})

test('flat first, then the highest ground, then the closest', () => {
  const bot = world((x, z) => (x >= -980 && x <= -974 && z >= 2300 && z <= 2306 ? 73 : 70))     // a 7x7 plateau 3 higher: exactly one candidate fits it
  const s = findSite(bot, OPTS)
  assert.deepStrictEqual([s.ox, s.oy, s.oz], [-979, 74, 2301], 'the plateau wins over the (closer) lowland')
  // two plateaus of equal height: the one closer to the centre
  const bot2 = world((x, z) => ((x >= -980 && x <= -974 && z >= 2300 && z <= 2306) || (x >= -988 && x <= -982 && z >= 2282 && z <= 2288) ? 73 : 70))
  const s2 = findSite(bot2, OPTS)
  assert.deepStrictEqual([s2.ox, s2.oz], [-987, 2283], 'closer plateau (distance 9.5 vs 10.3 from the centre)')
})

test('a slope of one block is accepted (cobblestone foundation planned), flatter is preferred, the centre column stays at the base level', () => {
  const bot = world((x, z) => 70 + ((x + z) & 1))          // checkerboard: every 7x7 differs by 1
  const s = findSite(bot, OPTS)
  assert.ok(s); assert.strictEqual(s.flat, 1); assert.strictEqual(s.oy, 72)
  assert.ok(s.low.length > 0 && s.low.every(([dx, dz, g]) => g === 70 && dx >= 0 && dx <= 4 && dz >= 0 && dz <= 4))
  assert.ok(!s.low.some(([dx, dz]) => dx === 2 && dz === 2), 'the pillar centre is natural base-level ground')
  // a half-and-half hillside has flat candidates: they win
  const bot2 = world((x) => (x >= -984 ? 71 : 70))
  const s2 = findSite(bot2, OPTS)
  assert.strictEqual(s2.flat, 0); assert.strictEqual(s2.oy, 72)
})

test('slopes steeper than maxDy are rejected, with the reason', () => {
  const bot = world((x) => 70 + (x - (C.x - 40)) )         // one block up per block east
  const r = survey(bot, OPTS)
  assert.strictEqual(r.site, null)
  assert.match(r.reason, /no flat, dry, tree-free 7x7 patch/); assert.match(r.reason, /slope/)
  assert.strictEqual(findSite(bot, OPTS), null)
  const steep = survey(bot, { ...OPTS, maxDy: 6 })
  assert.strictEqual(steep.site, null, 'even a tolerated slope needs the pillar centre at the high point'); assert.match(steep.reason, /centre-low/)
})

test('water: no site over a lake, none within the 2 block margin of a pond', () => {
  const lake = world((x, z) => 70)
  for (let x = C.x - 40; x <= C.x + 40; x++) for (let z = C.z - 40; z <= C.z + 40; z++) { lake.setBlock(x, 70, z, 'water') }
  const r = survey(lake, OPTS)
  assert.strictEqual(r.site, null); assert.match(r.reason, /water/)
  const bot = world()
  bot.setBlock(C.x + 3, 70, C.z + 1, 'water')                 // one wet column near the centre
  const s = findSite(bot, OPTS)
  assert.ok(s); assert.ok(!inside(s, C.x + 3, C.z + 1, 2), `site ${s.ox},${s.oz} keeps 2 blocks from the water`)
  const lava = world(); lava.setBlock(C.x, 70, C.z, 'lava')
  const sl = findSite(lava, OPTS); assert.ok(!inside(sl, C.x, C.z, 2))
})

test('trees: leaves and logs in the volume rule a candidate out; a canopy over everything rules out the area', () => {
  const bot = world()
  for (let y = 71; y <= 75; y++) bot.setBlock(C.x, y, C.z, 'oak_log')
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) bot.setBlock(C.x + dx, 76, C.z + dz, 'oak_leaves')
  const s = findSite(bot, OPTS)
  assert.ok(s); assert.ok(!inside(s, C.x, C.z, 0) && !inside(s, C.x + 2, C.z + 2, 0), 'not under the tree')
  // leaves above the volume (y+13) do not matter
  const high = world(); high.setBlock(C.x + 2, 84, C.z + 2, 'oak_leaves')
  assert.deepStrictEqual([findSite(high, OPTS).ox, findSite(high, OPTS).oz], [C.x, C.z])
  const leaves = world()
  for (let x = C.x - 40; x <= C.x + 40; x++) for (let z = C.z - 40; z <= C.z + 40; z++) leaves.setBlock(x, 74, z, 'spruce_leaves')
  const r = survey(leaves, OPTS)
  assert.strictEqual(r.site, null); assert.match(r.reason, /obstacle/)
})

test('player blocks: ground that is not natural, a wall or a torch inside the volume', () => {
  const bot = world()
  bot.setBlock(C.x, 70, C.z, 'stone_bricks')
  const s = findSite(bot, OPTS)
  assert.ok(!inside(s, C.x, C.z, 2), 'a player-made block in the 11x11 read rules the candidate out')
  const wall = world(); wall.setBlock(C.x + 1, 72, C.z + 1, 'cobblestone')
  const sw = findSite(wall, OPTS); assert.ok(!inside(sw, C.x + 1, C.z + 1, 0))
  const torch = world(); torch.setBlock(C.x + 1, 71, C.z + 1, 'torch')
  const st = findSite(torch, OPTS); assert.ok(!inside(st, C.x + 1, C.z + 1, 0))
})

test('grass tufts and flowers on the ground are fine', () => {
  const bot = world()
  for (let x = C.x - 6; x <= C.x + 6; x++) for (let z = C.z - 6; z <= C.z + 6; z++) bot.setBlock(x, 71, z, (x + z) % 3 ? 'short_grass' : 'poppy')
  const s = findSite(bot, OPTS)
  assert.deepStrictEqual([s.ox, s.oy, s.oz], [C.x, 71, C.z])
})

test("Walter's protected base box is off limits", () => {
  const bot = world()
  const box = { min: [C.x - 3, 60, C.z - 3], max: [C.x + 3, 120, C.z + 3] }
  const s = findSite(bot, { ...OPTS, protect: [box] })
  assert.ok(s); assert.ok(!(s.ox - 1 <= box.max[0] && s.ox + 5 >= box.min[0] && s.oz - 1 <= box.max[2] && s.oz + 5 >= box.min[2]), 'footprint clears the box')
  const all = survey(bot, { ...OPTS, protect: [{ min: [C.x - 100, 0, C.z - 100], max: [C.x + 100, 200, C.z + 100] }] })
  assert.strictEqual(all.site, null); assert.match(all.reason, /protected/)
  // the real config protects the base; a site next to it at the configured centre is allowed
  assert.ok(cfg.protect.some(p => p.min[0] === -1100 && p.max[0] === -1020 && p.min[2] === 2250 && p.max[2] === 2360))
  const base = survey(bot, { ...OPTS, center: { x: -1030, z: 2300 }, radius: 3 })
  assert.strictEqual(base.site, null, 'inside the base: nothing (and no world there anyway)')
})

test('unloaded chunks are unknown, never suitable', () => {
  const bot = world()
  for (let x = C.x - 60; x <= C.x + 60; x++) for (let z = C.z - 60; z <= C.z + 60; z++) for (let y = 20; y <= 120; y++) bot.unloaded.add(`${x},${y},${z}`)
  const r = survey(bot, OPTS)
  assert.strictEqual(r.site, null); assert.match(r.reason, /unloaded/)
  // only the east half is missing: the site is on the loaded side, with the whole 11x11 read loaded
  const half = world()
  for (let x = C.x; x <= C.x + 60; x++) for (let z = C.z - 60; z <= C.z + 60; z++) for (let y = 20; y <= 120; y++) half.unloaded.add(`${x},${y},${z}`)
  const s = findSite(half, OPTS)
  assert.ok(s); assert.ok(s.ox + 7 < C.x, `site at ${s.ox} is clear of the unloaded half (x >= ${C.x})`)
  // a missing ground block in the margin is enough
  const hole = world(); hole.unloaded.add(`${C.x + 6},70,${C.z + 6}`)
  const sh = findSite(hole, OPTS); assert.ok(!inside(sh, C.x + 6, C.z + 6, 2))
})

test('no ground in the scanned height range is "no ground"', () => {
  const bot = extend(mockBot({ pos: [C.x, 71, C.z] }))
  const r = survey(bot, { ...OPTS, radius: 2 })
  assert.strictEqual(r.site, null); assert.match(r.reason, /no-ground/)
})
