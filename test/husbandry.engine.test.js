// brain/husbandry engine against the mock world: building the pen, luring, breeding, shearing, culling, and the glow lichen farm.
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const bp = require('../brain/husbandry/blueprint')
const herd = require('../brain/husbandry/herd')
const { rig, fakeCtx, buildNow, PEN } = require('./husbandry.helpers')

const placedBy = (bot, kind) => bot.actions.filter(a => a[0] === 'place' && (kind ? a[1] === kind : true))
const FULL = { birch_fence: 31, birch_fence_gate: 1, torch: 7 }
const penRig = (o = {}) => {
  const r = rig({ pos: [8, 64, 20], ...o })
  buildNow(r.bot, PEN); r.state.pens.push({ ...PEN })
  return r
}
const gateOpen = (bot) => bot.blockAt(new Vec3(13, 64, 17)).getProperties().open
const inPen = (bot, name) => bot.animalsNamed(name).filter(e => herd.inBox(e.position, bp.boxOf(PEN)))

// ------------------------------------------------------------------------------------------------ building
test('build: places the whole ring, the gate and the torches, each from a spot with a clear ray and within reach', async () => {
  const r = rig({ inv: FULL })
  const pen = { id: 'pen1', ox: 10, oy: 64, oz: 10, w: 7, d: 7, wood: 'birch' }
  const res = await r.engine.buildPen(fakeCtx(), pen)
  assert.strictEqual(res.placed, 39); assert.ok(res.built && res.lit && res.done)
  assert.strictEqual(placedBy(r.bot, 'birch_fence').length, 31)
  assert.strictEqual(placedBy(r.bot, 'torch').length, 7)
  for (const a of placedBy(r.bot)) { assert.ok(a[3] <= 4.5, `${a[1]} ${a[2]} placed from ${a[3]} blocks`); assert.ok(a[4], `${a[1]} ${a[2]} placed with a clear ray`) }
  assert.strictEqual(r.state.stats.placed, 39)
  for (const k of ['birch_fence', 'birch_fence_gate', 'torch']) assert.strictEqual(r.bot.count(k), 0)
  assert.strictEqual(r.bot.blockAt(new Vec3(13, 64, 17)).name, 'birch_fence_gate')
  assert.strictEqual(r.bot.blockAt(new Vec3(10, 64, 9)).name, 'birch_fence')
  assert.strictEqual(r.bot.blockAt(new Vec3(9, 65, 9)).name, 'torch')
})

test('build: nothing is placed inside the pen or on the interior, and the bot is never in the cell it places', async () => {
  const r = rig({ inv: FULL })
  await r.engine.buildPen(fakeCtx(), { id: 'pen1', ox: 10, oy: 64, oz: 10, w: 7, d: 7, wood: 'birch' })
  for (const a of placedBy(r.bot)) { const [x, y, z] = a[2].split(',').map(Number); assert.ok(x === 9 || x === 17 || z === 9 || z === 17, 'on the ring: ' + a[2]) }
})

test('build: missing materials stop it before the first block and name what is short; a crafter fills the gap', async () => {
  const r = rig({ inv: { birch_fence: 20, torch: 7 } })
  const pen = { id: 'pen1', ox: 10, oy: 64, oz: 10, w: 7, d: 7, wood: 'birch' }
  await assert.rejects(() => r.engine.buildPen(fakeCtx(), pen), (e) => e.name === 'Missing' && e.needs.birch_fence === 11 && e.needs.birch_fence_gate === 1)
  assert.strictEqual(placedBy(r.bot).length, 0, 'not a single block until the whole pen can be finished')
  const asked = []
  const r2 = rig({ inv: { birch_fence: 20, torch: 7 }, craft: async (item, n) => { asked.push([item, n]); r2.bot.give(item, n); return true } })
  const res = await r2.engine.buildPen(fakeCtx(), { ...pen })
  assert.deepStrictEqual(asked, [['birch_fence', 11], ['birch_fence_gate', 1]])
  assert.ok(res.built && res.lit)
})

test('build: resumes from the world: a second run places nothing, a half-built ring is finished, and a block of someone else is left alone', async () => {
  const r = rig({ inv: FULL })
  const pen = { id: 'pen1', ox: 10, oy: 64, oz: 10, w: 7, d: 7, wood: 'birch' }
  r.bot.setBlock(12, 64, 9, 'stone')                                   // somebody's block on the ring
  r.bot.give('birch_fence', 5)
  const a = await r.engine.buildPen(fakeCtx(), pen)
  assert.strictEqual(a.blocked, 1); assert.strictEqual(a.built, false, 'a ring with a hole is not built')
  assert.strictEqual(r.bot.blockAt(new Vec3(12, 64, 9)).name, 'stone', 'left alone')
  r.bot.setBlock(12, 64, 9, 'air')
  const n = placedBy(r.bot).length
  const b = await r.engine.buildPen(fakeCtx(), pen)
  assert.strictEqual(placedBy(r.bot).length, n + 1, 'only the hole is placed')
  assert.ok(b.built)
  const c = await r.engine.buildPen(fakeCtx(), pen)
  assert.strictEqual(c.placed, 0)
})

test('build: placeBlock that reports a timeout although the block went down still counts', async () => {
  const r = rig({ inv: FULL }); r.bot.placeMode = 'timeout'
  const res = await r.engine.buildPen(fakeCtx(), { id: 'pen1', ox: 10, oy: 64, oz: 10, w: 7, d: 7, wood: 'birch' })
  assert.ok(res.built && res.lit)
})

test('build: stops at night and when a hostile is near, and says why', async () => {
  const r = rig({ inv: FULL }); r.bot.time.timeOfDay = 13000
  const out = await r.engine.runBuild(fakeCtx())
  assert.strictEqual(out.ok, false); assert.match(out.why, /night/); assert.strictEqual(placedBy(r.bot).length, 0)
  const r2 = rig({ inv: FULL }); r2.bot.addHostile('zombie', 8, 6)
  const o2 = await r2.engine.runBuild(fakeCtx())
  assert.match(o2.why, /zombie/); assert.ok(o2.danger)
})

test('build: runBuild picks a site by itself, records the pen and builds it', async () => {
  const r = rig({ pos: [20, 64, 20], inv: FULL })
  const out = await r.engine.runBuild(fakeCtx())
  assert.ok(out.ok && out.built, JSON.stringify(out))
  assert.strictEqual(r.state.pens.length, 1); assert.ok(r.state.pens[0].built && r.state.pens[0].lit)
  const out2 = await r.engine.runBuild(fakeCtx())
  assert.strictEqual(r.state.pens.length, 1, 'a built pen is not planned twice'); assert.strictEqual(out2.ok, false); assert.match(out2.why, /already standing/)
  r.bot.give('birch_fence', 31); r.bot.give('birch_fence_gate', 1); r.bot.give('torch', 7)
  const out3 = await r.engine.runBuild(fakeCtx(), { another: true })
  assert.ok(out3.ok && out3.built); assert.strictEqual(r.state.pens.length, 2, 'asked for another: a second site, clear of the first')
})

// ------------------------------------------------------------------------------------------------ lure
test('lure: animals outside follow the bot holding wheat through the gate, the gate ends closed and the bot ends outside without the food in hand', async () => {
  const r = penRig({ inv: { wheat: 6, stone_pickaxe: 1 } })
  for (const [x, z] of [[2, 22], [3, 24], [4, 21]]) r.bot.addAnimal('cow', x, z)
  const res = await r.engine.lure(fakeCtx(), { ...PEN }, 'cow')
  assert.strictEqual(res.lured, 3)
  assert.strictEqual(inPen(r.bot, 'cow').length, 3)
  assert.strictEqual(gateOpen(r.bot), false, 'gate closed again')
  assert.ok(!herd.inBox(r.bot.entity.position, bp.boxOf(PEN)), 'bot outside')
  assert.notStrictEqual(r.bot.heldItem && r.bot.heldItem.name, 'wheat', 'food put away so they stay')
  assert.strictEqual(r.state.stats.lured, 3)
})

test('lure: nothing is lured without the food, and animals out of sight are not chased', async () => {
  const r = penRig({ inv: {} }); r.bot.addAnimal('cow', 3, 22)
  await assert.rejects(() => r.engine.lure(fakeCtx(), { ...PEN }, 'cow'), (e) => e.name === 'Missing' && e.needs.wheat === 2)
  const r2 = penRig({ inv: { wheat: 4 } }); r2.bot.addAnimal('cow', 60, 60)
  assert.deepStrictEqual(await r2.engine.lure(fakeCtx(), { ...PEN }, 'cow'), { lured: 0, why: 'no cow in sight outside the pen' })
})

test('lure: a different species does not follow wheat (pigs want carrots)', async () => {
  const r = penRig({ inv: { carrot: 4 } }); r.bot.addAnimal('pig', 3, 22); r.bot.addAnimal('cow', 4, 23)
  const res = await r.engine.lure(fakeCtx(), { ...PEN }, 'pig')
  assert.strictEqual(res.lured, 1); assert.strictEqual(inPen(r.bot, 'cow').length, 0)
})

// ------------------------------------------------------------------------------------------------ breed
test('breed: two cows fed wheat make a baby; the food is used up; the pair is not fed again inside the cooldown', async () => {
  const r = penRig({ inv: { wheat: 6 } }); r.bot.addAnimal('cow', 11, 11); r.bot.addAnimal('cow', 13, 12)
  await r.engine.enterPen(fakeCtx(), { ...PEN })
  const res = await r.engine.breed(fakeCtx(), { ...PEN }, 'cow', 1)
  assert.strictEqual(res.fed, 2); assert.strictEqual(res.babies, 1)
  assert.strictEqual(r.bot.count('wheat'), 4)
  assert.strictEqual(r.state.stats.bred, 1)
  const again = await r.engine.breed(fakeCtx(), { ...PEN }, 'cow', 1)
  assert.strictEqual(again.fed, 0); assert.match(again.why, /cooldown/)
  assert.strictEqual(r.bot.count('wheat'), 4)
})

test('breed: babies are never fed, and a pen with one adult cannot breed', async () => {
  const r = penRig({ inv: { wheat: 6 } }); r.bot.addAnimal('cow', 11, 11); r.bot.addAnimal('cow', 13, 12, { baby: true })
  await r.engine.enterPen(fakeCtx(), { ...PEN })
  const res = await r.engine.breed(fakeCtx(), { ...PEN }, 'cow', 1)
  assert.strictEqual(res.fed, 0)
  assert.strictEqual(r.bot.count('wheat'), 6)
})

test('breed: no wheat is a Missing error naming the food', async () => {
  const r = penRig({ inv: {} }); r.bot.addAnimal('cow', 11, 11); r.bot.addAnimal('cow', 13, 12)
  await r.engine.enterPen(fakeCtx(), { ...PEN })
  await assert.rejects(() => r.engine.breed(fakeCtx(), { ...PEN }, 'cow', 1), (e) => e.name === 'Missing' && e.needs.wheat === 2)
})

test('breed: three runs in a row without a baby (breeding blocked in the world) put the species on hold, and the hold ends after half an hour', async () => {
  let t = 1e12
  const r = penRig({ inv: { wheat: 40 }, now: () => t }); r.bot.sim.breeding = false
  r.bot.addAnimal('cow', 11, 11); r.bot.addAnimal('cow', 13, 12)
  const pen = r.state.pens[0]
  await r.engine.enterPen(fakeCtx(), pen)
  for (let i = 0; i < 3; i++) { t += 6 * 60000; await r.engine.breed(fakeCtx(), pen, 'cow', 1) }
  assert.ok(pen.breedBlocked && pen.breedBlocked.cow, 'on hold')
  assert.ok(r.logs.some(l => /did not breed/.test(l)))
  const plan1 = r.engine.snapshot().pens[0].blocked
  assert.deepStrictEqual(plan1, ['cow'])
  t += 31 * 60000
  assert.deepStrictEqual(r.engine.snapshot().pens[0].blocked, [], 'tries again later')
})

// ------------------------------------------------------------------------------------------------ shear
test('shear: sheep with wool are sheared with shears, wool is collected, sheared ones and babies are left', async () => {
  const r = penRig({ inv: { shears: 1 } })
  r.bot.addAnimal('sheep', 11, 11); r.bot.addAnimal('sheep', 13, 12); r.bot.addAnimal('sheep', 14, 13, { sheared: true }); r.bot.addAnimal('sheep', 12, 14, { baby: true })
  await r.engine.enterPen(fakeCtx(), { ...PEN })
  const res = await r.engine.shear(fakeCtx(), { ...PEN })
  assert.strictEqual(res.sheared, 2)
  assert.strictEqual(r.bot.count('white_wool'), 4, 'the wool was picked up, nothing lies about')
  assert.strictEqual(Object.values(r.bot.entities).filter(e => e.name === 'item').length, 0)
  assert.strictEqual(r.bot.actions.filter(a => a[0] === 'attack').length, 0, 'nobody was hit')
  assert.deepStrictEqual((await r.engine.shear(fakeCtx(), { ...PEN })).sheared, 0, 'all sheared now')
})

test('shear: without shears nothing happens', async () => {
  const r = penRig({}); r.bot.addAnimal('sheep', 11, 11)
  assert.deepStrictEqual(await r.engine.shear(fakeCtx(), { ...PEN }), { sheared: 0, why: 'no shears' })
})

// ------------------------------------------------------------------------------------------------ cull
test('cull: kills only the surplus adults with the sword, spares babies and the last pair, and picks up the drops', async () => {
  const r = penRig({ inv: { stone_sword: 1 } })
  for (let i = 0; i < 6; i++) r.bot.addAnimal('sheep', 11 + (i % 5), 11 + (i % 4))
  r.bot.addAnimal('sheep', 15, 15, { baby: true })
  await r.engine.enterPen(fakeCtx(), { ...PEN })
  const res = await r.engine.cull(fakeCtx(), { ...PEN }, 'sheep', 1)
  assert.strictEqual(res.killed, 1)
  assert.strictEqual(res.sword, 'stone_sword')
  assert.strictEqual(herd.census(r.bot.entities, bp.boxOf(PEN)).sheep.adults.length, 5)
  assert.strictEqual(herd.census(r.bot.entities, bp.boxOf(PEN)).sheep.babies.length, 1, 'the lamb lives')
  assert.strictEqual(r.bot.count('mutton'), 1, 'the drop is in the bag')
  assert.strictEqual(Object.values(r.bot.entities).filter(e => e.name === 'item').length, 0)
  assert.ok(r.bot.actions.filter(a => a[0] === 'attack').every(a => a[3] === 'stone_sword'))
})

test('cull: never takes the last two adults of a species, whatever it is asked for', async () => {
  const r = penRig({ inv: { stone_sword: 1 } })
  for (let i = 0; i < 3; i++) r.bot.addAnimal('pig', 11 + i, 12)
  await r.engine.enterPen(fakeCtx(), { ...PEN })
  const res = await r.engine.cull(fakeCtx(), { ...PEN }, 'pig', 5)
  assert.strictEqual(res.killed, 1)
  assert.strictEqual(herd.census(r.bot.entities, bp.boxOf(PEN)).pig.adults.length, 2)
})

// ------------------------------------------------------------------------------------------------ a whole visit
test('tend: lures what is missing, breeds the pairs, shears, culls the surplus, leaves by the gate and records the herd', async () => {
  const r = penRig({ inv: { wheat: 20, shears: 1, stone_sword: 1 }, winter: false })
  r.bot.addAnimal('cow', 11, 11); r.bot.addAnimal('cow', 13, 12)                              // a pair of cows already inside
  for (let i = 0; i < 6; i++) r.bot.addAnimal('sheep', 11 + (i % 5), 13 + (i % 3))           // six sheep inside: one over the target of five
  r.bot.addAnimal('sheep', 2, 22); r.bot.addAnimal('sheep', 3, 23)                           // two more outside (they are not needed: six are in)
  const pen = r.state.pens[0]
  const res = await r.engine.tendPen(fakeCtx(), pen)
  assert.deepStrictEqual(res.bred, { cow: 1 })
  assert.deepStrictEqual(res.culled, { sheep: 1 })
  assert.strictEqual(res.sheared, 6, 'all six are sheared first, then one is culled')
  assert.ok(!herd.inBox(r.bot.entity.position, bp.boxOf(PEN)), 'back outside')
  assert.strictEqual(gateOpen(r.bot), false)
  assert.ok(pen.last && pen.last.counts.cow.babies === 1)
})

test('tend: a hostile near stops it before it opens the gate; the gate is never left open', async () => {
  const r = penRig({ inv: { wheat: 20 } }); r.bot.addAnimal('cow', 11, 11); r.bot.addAnimal('cow', 13, 12); r.bot.addHostile('creeper', 9, 20)
  const out = await r.engine.runTend(fakeCtx())
  assert.ok(out.danger && /creeper/.test(out.why))
  assert.strictEqual(gateOpen(r.bot), false)
})

test('tend: with no animals in sight and no food, a visit does nothing and costs nothing', async () => {
  const r = penRig({})
  const out = await r.engine.runTend(fakeCtx())
  assert.ok(out.ok); assert.deepStrictEqual(out.pens[0].lured, {}); assert.strictEqual(placedBy(r.bot).length, 0)
  assert.strictEqual(gateOpen(r.bot), false)
})

test('tend: the idle routine is due once a built pen exists, not at night, and not again inside the interval', async () => {
  let t = 1e12
  const r = penRig({ now: () => t })
  assert.strictEqual(r.engine.dueTend(), true)
  await r.engine.runTend(fakeCtx())
  assert.strictEqual(r.engine.dueTend(), false)
  t += r.C.routineIntervalMs + 1
  assert.strictEqual(r.engine.dueTend(), true)
  r.bot.time.timeOfDay = 14000
  assert.strictEqual(r.engine.dueTend(), false)
  assert.strictEqual(rig({}).engine.dueTend(), false, 'no pen, no routine')
})

// ------------------------------------------------------------------------------------------------ glow lichen
function lichenWorld(extra = {}) {
  const r = rig({ pos: [20, 64, 20], ...extra })
  for (let x = 17; x <= 23; x++) for (let y = 64; y <= 67; y++) for (let z = 10; z <= 12; z++) r.bot.setBlock(x, y, z, 'stone')   // south face z=12, air from z=13
  for (let x = 17; x <= 23; x++) r.bot.setBlock(x, 63, 13, 'stone')
  const site = { id: 'lichen1', x: 20, y: 64, z: 12, fx: 0, fz: 1, w: 3, h: 2 }
  r.state.lichen.push(site)
  return { ...r, site }
}
const lichenAt = (bot) => { let n = 0, faces = 0; for (let x = 15; x <= 25; x++) for (let y = 62; y <= 69; y++) for (let z = 11; z <= 16; z++) { const b = bot.blockAt(new Vec3(x, y, z)); if (b.name === 'glow_lichen') { n++; faces += Object.values(b.getProperties()).filter(Boolean).length } } return { n, faces } }

test('lichen: a seed placed on the wall is bone-mealed until it has spread to the target, and a bag of lichen with no bone meal only seeds', async () => {
  const r = lichenWorld({ inv: { glow_lichen: 1, bone_meal: 20 }, config: { lichen: { target: 6 } } })
  const res = await r.engine.tendLichen(fakeCtx(), r.site)
  assert.ok(res.seeded)
  assert.ok(lichenAt(r.bot).faces >= 6, 'grown to the target: ' + JSON.stringify(lichenAt(r.bot)))
  assert.ok(r.bot.count('bone_meal') < 20 && r.bot.count('bone_meal') > 8, 'not wasted once it reached the target')
  const r2 = lichenWorld({ inv: { glow_lichen: 1 } })
  const o2 = await r2.engine.tendLichen(fakeCtx(), r2.site)
  assert.ok(o2.seeded); assert.strictEqual(lichenAt(r2.bot).n, 1)
})

test('lichen: with no lichen anywhere it asks for one (Missing), and places nothing else', async () => {
  const r = lichenWorld({})
  const res = await r.engine.tendLichen(fakeCtx(), r.site)
  assert.deepStrictEqual(res.missing, { glow_lichen: 1 }); assert.strictEqual(placedBy(r.bot).length, 0)
})

test('lichen: once grown past the target it is sheared down to the seed blocks with shears, and the drops are collected', async () => {
  const r = lichenWorld({ inv: { glow_lichen: 1, bone_meal: 30, shears: 1 }, config: { lichen: { target: 6, keep: 3 } } })
  const res = await r.engine.tendLichen(fakeCtx(), r.site)
  assert.ok(res.harvested > 0)
  assert.strictEqual(lichenAt(r.bot).n, 3, 'the seed blocks stay')
  assert.ok(r.bot.count('glow_lichen') > 0, 'lichen in the bag')
  assert.strictEqual(Object.values(r.bot.entities).filter(e => e.name === 'item').length, 0, 'nothing on the floor')
  assert.ok(r.bot.actions.filter(a => a[0] === 'equip').some(a => a[1] === 'shears'))
  assert.ok(r.state.stats.lichenHarvested > 0)
})

test('lichen: no shears, no harvest; bone meal that does nothing three times in a row is not wasted further', async () => {
  const r = lichenWorld({ inv: { glow_lichen: 1, bone_meal: 30 }, config: { lichen: { target: 40 } } }); r.bot.growBlocked = true
  await r.engine.tendLichen(fakeCtx(), r.site)
  assert.ok(r.bot.count('bone_meal') >= 26, 'stopped after a few tries: ' + r.bot.count('bone_meal'))
  const r2 = lichenWorld({ inv: { glow_lichen: 1, bone_meal: 30 }, config: { lichen: { target: 4, keep: 1 } } })
  const o = await r2.engine.tendLichen(fakeCtx(), r2.site)
  assert.strictEqual(o.harvested, 0)
})

test('lichen: runLichen finds a wall by itself when none is registered', async () => {
  const r = lichenWorld({ inv: { glow_lichen: 1 } }); r.state.lichen.length = 0
  const out = await r.engine.runLichen(fakeCtx())
  assert.ok(out.ok, JSON.stringify(out)); assert.strictEqual(r.state.lichen.length, 1)
  assert.deepStrictEqual([r.state.lichen[0].fx, r.state.lichen[0].fz], [0, 1])
})
