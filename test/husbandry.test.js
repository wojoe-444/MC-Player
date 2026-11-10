// brain/husbandry (ROADMAP Phase 2 items 9 and 11): the pen blueprint, the herd policy, the site surveys, and the engine against a mock world.
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const bp = require('../brain/husbandry/blueprint')
const herd = require('../brain/husbandry/herd')
const sv = require('../brain/husbandry/survey')
const cfg = require('../brain/husbandry/config.json')
const { rig, fakeCtx, buildNow, PEN } = require('./husbandry.helpers')

const origin = { x: 10, y: 64, z: 10 }
const placedBy = (bot, kind) => bot.actions.filter(a => a[0] === 'place' && (kind ? a[1] === kind : true))

// ------------------------------------------------------------------------------------------------ blueprint
test('blueprint: a 7x7 pen is a ring of 31 fences and a gate in the middle of the south side, lit by torches on the posts', () => {
  const steps = bp.pen(origin, { w: 7, d: 7, wood: 'birch' })
  const by = (k) => steps.filter(s => s.kind === k)
  assert.strictEqual(by('fence').length, 31)
  assert.strictEqual(by('gate').length, 1)
  assert.deepStrictEqual([by('gate')[0].x, by('gate')[0].z], [13, 17])
  assert.strictEqual(steps.length, new Set(steps.map(s => s.key)).size, 'no cell twice')
  for (const s of by('fence')) { assert.ok(s.x === 9 || s.x === 17 || s.z === 9 || s.z === 17, 'on the ring'); assert.strictEqual(s.y, 64) }
  assert.deepStrictEqual(bp.materials(steps), { birch_fence: 31, birch_fence_gate: 1, torch: 7 })
  assert.deepStrictEqual(bp.materials(steps, s => s.kind === 'fence'), { birch_fence_gate: 1, torch: 7 }, 'standing pieces are not counted')
})

test('blueprint: torches stand on fence posts, never over the gate, at least 3 apart, and every interior cell gets light from one', () => {
  for (const [w, d] of [[5, 5], [7, 7], [8, 6], [9, 9]]) {
    const steps = bp.pen(origin, { w, d })
    const posts = new Set(steps.filter(s => s.kind === 'fence').map(s => s.key))
    const ts = steps.filter(s => s.kind === 'torch'), gate = steps.find(s => s.kind === 'gate')
    for (const t of ts) {
      assert.ok(posts.has(`${t.x},${t.y - 1},${t.z}`), `${w}x${d}: torch on a fence post`)
      assert.ok(!(t.x === gate.x && t.z === gate.z), 'not over the gate')
    }
    for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) assert.ok(Math.abs(ts[i].x - ts[j].x) + Math.abs(ts[i].z - ts[j].z) >= 3, `${w}x${d}: torches 3 apart`)
    assert.ok(bp.litEverywhere(steps, w, d, origin.x, origin.z), `${w}x${d}: lit everywhere`)
  }
})

test('blueprint: order is fences, then the gate, then torches; every torch comes after its post; no torches when asked not to', () => {
  const steps = bp.pen(origin, { w: 7, d: 7 })
  const kinds = steps.map(s => s.kind).join(',').replace(/(fence,)+/, 'F,').replace(/(torch,?)+/, 'T')
  assert.strictEqual(kinds, 'F,gate,T')
  assert.strictEqual(bp.pen(origin, { torches: false }).filter(s => s.kind === 'torch').length, 0)
  const seen = new Set()
  for (const s of steps) { if (s.kind === 'torch') assert.ok(seen.has(`${s.ref.x},${s.ref.y},${s.ref.z}`)); seen.add(s.key) }
})

test('blueprint: the bot stands off the ring, away from the pen, never in the cell it places', () => {
  for (const s of bp.pen(origin)) {
    const px = s.x + s.outward.x, pz = s.z + s.outward.z
    assert.ok(!(px >= 10 && px <= 16 && pz >= 10 && pz <= 16), 'outside the interior')
    assert.ok(!(px === s.x && pz === s.z))
  }
})

// ------------------------------------------------------------------------------------------------ herd policy
const mk = (name, adults, babies = 0, sheared = 0) => {
  const list = []
  for (let i = 0; i < adults; i++) list.push({ id: `${name}a${i}`, name, position: new Vec3(11 + i * 0.1, 64, 11), metadata: name === 'sheep' && i < sheared ? [] : [] })
  for (let i = 0; i < babies; i++) list.push({ id: `${name}b${i}`, name, position: new Vec3(12, 64, 12), metadata: Object.assign([], { 16: true }) })
  return list
}
const entities = (...lists) => { const o = {}; for (const l of lists) for (const e of l) o[e.id] = e; return o }
const box = bp.boxOf({ ox: 10, oy: 64, oz: 10, w: 7, d: 7 })

test('herd: census counts adults and babies of each species inside the pen box and nothing outside', () => {
  const out = mk('cow', 1); out[0].id = 'far'; out[0].position = new Vec3(30, 64, 30)
  const c = herd.census(entities(mk('cow', 3, 1), mk('sheep', 2), out, [{ id: 'z', name: 'zombie', position: new Vec3(11, 64, 11), metadata: [] }]), box)
  assert.deepStrictEqual(herd.counts(c), { cow: { adults: 3, babies: 1 }, sheep: { adults: 2, babies: 0 }, pig: { adults: 0, babies: 0 }, chicken: { adults: 0, babies: 0 } })
})

test('herd: a pair below the target breeds; one animal does not; babies count toward the target', () => {
  const H = cfg.herd
  let d = herd.decide(herd.census(entities(mk('cow', 2), mk('pig', 1)), box), { cfg: H, capacity: 12 })
  assert.deepStrictEqual(d.breed, [{ species: 'cow', pairs: 1 }])
  d = herd.decide(herd.census(entities(mk('cow', 2, 2)), box), { cfg: H, capacity: 12 })
  assert.deepStrictEqual(d.breed, [], '2 adults + 2 babies = the target of 4')
  d = herd.decide(herd.census(entities(mk('cow', 4)), box), { cfg: H, capacity: 12 })
  assert.deepStrictEqual(d.breed, [])
})

test('herd: no breeding when the pen is full or the species is blocked; at most the pairs per run', () => {
  const H = cfg.herd
  assert.deepStrictEqual(herd.decide(herd.census(entities(mk('cow', 2)), box), { cfg: H, capacity: 2 }).breed, [])
  assert.deepStrictEqual(herd.decide(herd.census(entities(mk('cow', 2)), box), { cfg: H, capacity: 12, breedBlocked: { cow: true } }).breed, [])
  const d = herd.decide(herd.census(entities(mk('chicken', 4)), box), { cfg: H, capacity: 12, winter: false })
  assert.strictEqual(d.breed[0].pairs, 2, 'a target of 6 and four adults: two pairs')
})

test('herd: winter raises the targets (stock up), so a herd that is surplus in summer is not culled in winter', () => {
  const H = cfg.herd, c = herd.census(entities(mk('sheep', 6)), box)
  assert.deepStrictEqual(herd.decide(c, { cfg: H, capacity: 20, winter: false }).cull, [{ species: 'sheep', n: 1 }])
  assert.deepStrictEqual(herd.decide(c, { cfg: H, capacity: 20, winter: true }).cull, [])
  assert.strictEqual(herd.decide(c, { cfg: H, capacity: 20, winter: true }).target.sheep, 8)
})

test('herd: culls only adults above the target, never below the breeding pair, never babies', () => {
  const H = cfg.herd
  const d = herd.decide(herd.census(entities(mk('cow', 7, 3)), box), { cfg: H, capacity: 20 })
  assert.deepStrictEqual(d.cull, [{ species: 'cow', n: 3 }], '7 adults to 4')
  const low = herd.decide(herd.census(entities(mk('cow', 3)), box), { cfg: H, capacity: 20, foodLow: true })
  assert.deepStrictEqual(low.cull, [{ species: 'cow', n: 1 }], 'food low: half the target (2), so one of three')
  const pair = herd.decide(herd.census(entities(mk('cow', 2)), box), { cfg: H, capacity: 20, foodLow: true })
  assert.deepStrictEqual(pair.cull, [], 'the last pair is never culled')
  const v = herd.pickVictims(mk('cow', 4, 2).filter(e => !herd.isBaby(e)), 2)
  assert.ok(v.every(e => !herd.isBaby(e)))
})

test('herd: an overcrowded pen is thinned down to its capacity, from the species with the most spare adults', () => {
  const d = herd.decide(herd.census(entities(mk('cow', 4), mk('sheep', 5), mk('pig', 4), mk('chicken', 6)), box), { cfg: cfg.herd, capacity: 12 })
  const left = { cow: 4, sheep: 5, pig: 4, chicken: 6 }
  for (const c of d.cull) left[c.species] -= c.n
  assert.ok(Object.values(left).reduce((a, b) => a + b, 0) <= 12)
  assert.ok(Object.values(left).every(n => n >= 2))
})

test('herd: shear count is the adult sheep not sheared; babies are not sheared; food by species', () => {
  const sheep = mk('sheep', 4); sheep[0].metadata[17] = 0x10; sheep[1].metadata[17] = 0x10
  const baby = mk('sheep', 0, 1)
  assert.strictEqual(herd.decide(herd.census(entities(sheep, baby), box), { cfg: cfg.herd, capacity: 12 }).shear, 2)
  assert.strictEqual(herd.foodFor('pig', [{ name: 'wheat', count: 3 }, { name: 'potato', count: 2 }]).name, 'potato')
  assert.strictEqual(herd.foodFor('cow', [{ name: 'wheat_seeds', count: 3 }]), null)
  assert.strictEqual(herd.foodFor('chicken', [{ name: 'wheat_seeds', count: 3 }]).name, 'wheat_seeds')
})

// ------------------------------------------------------------------------------------------------ surveys
test('survey: finds a flat grass patch for the pen, nearest first, and says why not when there is none', () => {
  const r = rig({ pos: [20, 64, 20] })
  const s = sv.findPenSite(r.bot, { w: 7, d: 7, radius: 20 })
  assert.ok(s && s.oy === 64 && s.grass === 1)
  assert.ok(s.dist <= 4, 'right where the bot stands')
  const r2 = rig({ pos: [20, 64, 20], size: 40 })
  for (let x = -15; x <= 40; x++) for (let z = -15; z <= 40; z++) r2.bot.setBlock(x, 63, z, 'sand')
  assert.strictEqual(sv.findPenSite(r2.bot, { radius: 12 }), null)
  assert.match(sv.penSiteWhy(), /sand in the way/)
})

test('survey: a step in the ground, water, a tree or another pen rules a spot out', () => {
  const r = rig({ pos: [20, 64, 20] })
  for (let x = -15; x <= 60; x++) for (let z = -15; z <= 60; z++) if (x < 20) r.bot.setBlock(x, 64, z, 'grass_block')     // a one-block rise west of x=20
  const s = sv.findPenSite(r.bot, { radius: 14 })
  assert.ok(s.ox - 1 >= 20 || s.ox + 7 < 20, 'the ring does not straddle the step')
  const w = rig({ pos: [20, 64, 20] })
  for (let x = 14; x <= 26; x++) for (let z = 14; z <= 26; z++) w.bot.setBlock(x, 63, z, 'water')
  const sw = sv.findPenSite(w.bot, { radius: 25 })
  assert.ok(sw.ox + 7 < 14 || sw.ox - 1 > 26 || sw.oz + 7 < 14 || sw.oz - 1 > 26, 'dry land only: the ring stays off the water')
  const t = rig({ pos: [20, 64, 20] })
  t.bot.setBlock(20, 64, 20, 'oak_log'); t.bot.setBlock(20, 65, 20, 'oak_log')
  const st = sv.findPenSite(t.bot, { radius: 10, w: 5, d: 5 })
  assert.ok(!(st.ox - 1 <= 20 && st.ox + 5 >= 20 && st.oz - 1 <= 20 && st.oz + 5 >= 20), 'the tree stays outside the ring')
  const a = sv.findPenSite(rig({ pos: [20, 64, 20] }).bot, { radius: 10, avoid: [{ x0: 10, x1: 30, z0: 10, z1: 30 }] })
  assert.ok(a === null || a.ox + 7 < 10 || a.ox - 1 > 30 || a.oz + 7 < 10 || a.oz - 1 > 30, 'clear of the other pen')
})

test('survey: an unloaded column makes a site unsuitable', () => {
  const r = rig({ pos: [20, 64, 20], size: 22 })
  const s = sv.findPenSite(r.bot, { radius: 30, w: 7, d: 7 })
  assert.ok(s && s.ox + 7 <= 23, 'stays inside the loaded ground')
})

test('survey: a lichen wall needs a plain stone face 3 wide and 2 high with open air two deep in front, and no water near', () => {
  const r = rig({ pos: [20, 64, 20] })
  for (let x = 17; x <= 23; x++) for (let y = 64; y <= 67; y++) for (let z = 10; z <= 12; z++) r.bot.setBlock(x, y, z, 'stone')       // a stone mass; its south face is z=12 with air at z>=13
  const w = sv.findLichenWall(r.bot, { radius: 12 })
  assert.ok(w && w.fz === 1 && w.w === 3 && w.h === 2)
  const r2 = rig({ pos: [20, 64, 20] })
  for (let x = 17; x <= 23; x++) for (let y = 64; y <= 67; y++) for (let z = 10; z <= 12; z++) r2.bot.setBlock(x, y, z, 'stone')
  r2.bot.setBlock(20, 64, 14, 'water')
  assert.strictEqual(sv.findLichenWall(r2.bot, { radius: 12, center: new Vec3(20, 64, 20) }) && sv.findLichenWall(r2.bot, { radius: 12 }).fz === 1, false, 'water in front rules the south face out')
})
