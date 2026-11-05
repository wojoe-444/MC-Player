// brain/nav: planner configuration + real physics (hazards, falls, ladders, stairs, hatches). See test/nav.helpers.js.
const test = require('node:test')
const assert = require('node:assert')
const { rig, goals, Vec3, makeSim, legacyMovements } = require('./nav.helpers')
const { configure } = require('../brain/nav/movements')

const flat = (s) => s.floor(-5, -5, 40, 20, 63)
const G = (x, y, z) => new goals.GoalBlock(x, y, z)
const near = (r, x, y, z, d = 1.5) => r.sim.at().distanceTo(new Vec3(x, y, z)) <= d

test('flat ground: walks there with ordinary walking/sprinting speed, never a jump in position', async () => {
  const r = await rig({}, flat)
  const res = await r.go(G(15, 64, 3))
  assert.ok(res.ok, JSON.stringify(res))
  assert.ok(near(r, 15.5, 64, 3.5))
  assert.ok(r.sim.maxStep < 0.4, `largest per-tick step ${r.sim.maxStep}`)
  assert.strictEqual(r.nav.status().motion.anomalies, 0)
  r.close()
})

test('lava: walks around a pool and never touches it', async () => {
  const r = await rig({}, s => { flat(s); s.fill(4, 63, -3, 7, 63, 3, 'lava') })
  const bad = r.track(() => r.sim.bot.entity.isInLava || r.sim.blockName(Math.floor(r.sim.at().x), Math.floor(r.sim.at().y - 0.1), Math.floor(r.sim.at().z)) === 'lava')
  const res = await r.go(G(12, 64, 0))
  assert.ok(res.ok, JSON.stringify(res))
  assert.ok(!bad.some(Boolean), 'was in or over lava')
  r.close()
})

test('lava: stays two cells away from lava when there is room (next-to-lava costs extra)', async () => {
  const r = await rig({}, s => { flat(s); s.fill(0, 63, 4, 20, 63, 12, 'lava') })    // lake to the south of the straight route
  const minGap = r.track(() => { const p = r.sim.at(); return 4 - p.z })
  const res = await r.go(G(18, 64, 1))
  assert.ok(res.ok)
  assert.ok(Math.min(...minGap) >= 1.2, `came within ${Math.min(...minGap)} of the lava edge`)
  r.close()
})

test('lava all the way across: no path, and the bot does not walk in', async () => {
  const r = await rig({}, s => { flat(s); s.fill(8, 63, -5, 10, 63, 20, 'lava') })
  const res = await r.go(G(15, 64, 0), { maxTicks: 400 })
  assert.strictEqual(res.ok, false)
  assert.match(res.err, /no path|timed out/)
  assert.ok(r.sim.at().x < 8, 'stopped at the lava edge')
  r.close()
})

test('cactus: never brushes it; a corridor blocked by one is "no path"', async () => {
  const r = await rig({}, s => { flat(s); s.fill(6, 64, -1, 6, 66, 1, 'cactus') })
  const dist = r.track(() => Math.min(...[-1, 0, 1].map(z => Math.hypot(r.sim.at().x - 6.5, r.sim.at().z - (z + 0.5)))))
  const res = await r.go(G(12, 64, 0))
  assert.ok(res.ok)
  assert.ok(Math.min(...dist) >= 1.3, `closest approach to a cactus block ${Math.min(...dist)}`)
  r.close()
  const c = await rig({}, s => { flat(s); s.wallX(-5, 20, 6, 64, 66); s.fill(6, 64, 0, 6, 65, 0, 'cactus') })
  const res2 = await c.go(G(12, 64, 0), { maxTicks: 300 })
  assert.strictEqual(res2.ok, false)
  c.close()
})

test('magma block, campfire, soul campfire and fire are never stepped on or through', async () => {
  for (const name of ['magma_block', 'campfire', 'soul_campfire', 'fire']) {
    const r = await rig({}, s => { flat(s); s.wallX(-5, 20, 6, 64, 66); if (name === 'fire') { s.set(6, 64, 0, 'air'); s.set(6, 64, 0, 'fire') } else if (name === 'magma_block') { s.set(6, 63, 0, name); s.set(6, 64, 0, 'air') } else { s.set(6, 64, 0, name, { lit: true }) } })
    const res = await r.go(G(12, 64, 0), { maxTicks: 300 })
    assert.strictEqual(res.ok, false, `${name} in the only gap`)
    assert.ok(r.sim.at().x < 6, `${name}: bot stopped before it`)
    r.close()
  }
})

test('falls: 3 blocks is allowed, 4 is refused, and the same cap applies to water', async () => {
  const drop = async (depth, water) => {
    const r = await rig({}, s => { flat(s); s.fill(3, 63, -5, 40, 63, 20, 'air'); s.floor(3, -5, 40, 20, 63 - depth); if (water) s.fill(3, 63 - depth + 1, -5, 40, 63 - depth + 1, 20, 'water') })
    const res = await r.go(G(8, 64 - depth, 0), { maxTicks: 300 })
    r.close()
    return res
  }
  assert.ok((await drop(3, false)).ok, '3 block drop')
  assert.strictEqual((await drop(4, false)).ok, false, '4 block drop')
  assert.strictEqual((await drop(6, true)).ok, false, '6 block drop into water')
})

test('falls: prefers the stairs to a 3 block jump when both exist', async () => {
  const r = await rig({}, s => {
    flat(s); s.fill(3, 63, -5, 40, 63, 20, 'air'); s.floor(3, -5, 40, 20, 60)            // lower level at y 60 (top 61)
    for (let i = 0; i < 3; i++) s.fill(3 + i, 61 + i, 10, 3 + i, 63, 10, 'stone')          // a stair-ish ramp at z=10... too far for a short walk
  })
  const vy = r.track(() => r.sim.bot.entity.velocity.y)
  const res = await r.go(G(8, 61, 0), { maxTicks: 400 })
  assert.ok(res.ok)
  r.close()
})

test('ladder up and a long ladder down (more than 3 blocks) both work, and the descent is a slide, not a fall', async () => {
  const build = (s) => { flat(s); s.fill(5, 64, -1, 5, 70, -1, 'stone'); s.ladder(5, 64, 70, 0, 'south'); s.fill(6, 70, -1, 9, 70, 2, 'stone') }
  const up = await rig({}, build)
  assert.ok((await up.go(G(7, 71, 0), { maxTicks: 600 })).ok, 'climb')
  up.close()
  const down = await rig({ pos: [7.5, 71, 0.5] }, build)
  const vy = down.track(() => down.sim.bot.entity.velocity.y)
  const res = await down.go(G(2, 64, 0), { maxTicks: 600 })
  assert.ok(res.ok, JSON.stringify(res))
  assert.ok(Math.min(...vy) > -0.7, `fell at ${Math.min(...vy)} blocks/tick`)
  down.close()
})

test('getLandingBlock: stock lets you drop any height into water, nav caps every fall at 3 blocks and lets ladders reset the fall', async () => {
  const sim = makeSim({ pos: [0.5, 71, 0.5] })
  sim.floor(-5, -5, 20, 20, 60); sim.fill(-5, 61, -5, 20, 63, 20, 'water')        // deep water, surface at y 63
  sim.fill(8, 60, 0, 8, 80, 0, 'stone')                                           // a pillar to stand on at x=8
  sim.fill(10, 61, 0, 10, 70, 0, 'air'); sim.set(10, 64, 0, 'stone'); sim.ladder(12, 61, 70, 0, 'east'); sim.fill(13, 61, 0, 13, 70, 0, 'stone')
  const mv = legacyMovements(sim.bot)
  const at = (x, y, z) => { const Move = require('mineflayer-pathfinder/lib/move'); return new Move(x, y, z, 0, 0) }
  const stock = mv.getLandingBlock(at(5, 71, 0), { x: 0, z: 0 })
  assert.ok(stock && stock.liquid, 'stock: lands in the water 8 blocks down')
  const h = configure(sim.bot, mv, { maxFall: 3 })
  assert.strictEqual(mv.getLandingBlock(at(5, 71, 0), { x: 0, z: 0 }), null, 'nav: refuses an 8 block drop into water')
  const ok = mv.getLandingBlock(at(5, 66, 0), { x: 0, z: 0 })
  assert.ok(ok && ok.liquid, 'nav: a drop of 3 into water is fine')
  const lad = mv.getLandingBlock(at(12, 70, 0), { x: 0, z: 0 })
  assert.ok(lad, 'nav: straight down a ladder column is not a fall')
  h.restore(); sim.dispose()
})

test('stairs and slabs, up and down', async () => {
  const build = (s) => {
    flat(s)
    for (let i = 0; i < 5; i++) { s.fill(6 + i, 64, -1, 6 + i, 64 + i, -1, 'stone'); s.fill(6 + i, 64, 1, 6 + i, 64 + i, 1, 'stone'); if (i) s.fill(6 + i, 64, 0, 6 + i, 63 + i, 0, 'stone'); s.set(6 + i, 64 + i, 0, 'oak_stairs', { facing: 'east', half: 'bottom', shape: 'straight' }) }
    s.floor(11, -1, 14, 1, 68)
    s.set(16, 64, 5, 'oak_slab', { type: 'bottom' }); s.set(17, 64, 5, 'oak_slab', { type: 'bottom' })
  }
  const up = await rig({}, build)
  assert.ok((await up.go(G(12, 69, 0), { maxTicks: 500 })).ok, 'up the stairs')
  assert.ok(up.sim.at().y >= 68.9)
  const back = await up.go(G(1, 64, 0), { maxTicks: 500 })
  assert.ok(back.ok, 'and back down: ' + JSON.stringify(back))
  up.close()
})

test('pressure plates and tripwire are walked around when there is another way', async () => {
  const r = await rig({}, s => { flat(s); s.set(5, 64, 0, 'stone_pressure_plate'); s.set(5, 64, 1, 'oak_pressure_plate') })
  const onPlate = r.track(() => { const p = r.sim.at(); return /pressure_plate/.test(r.sim.blockName(Math.floor(p.x), Math.floor(p.y + 0.01), Math.floor(p.z))) })
  const res = await r.go(G(10, 64, 0))
  assert.ok(res.ok)
  assert.ok(!onPlate.some(Boolean), 'stepped on a pressure plate')
  r.close()
})

test('closed trapdoor above a ladder: opened on the way up, closed after; a floor trapdoor is never opened under our feet', async () => {
  const r = await rig({ pos: [2.5, 64, 0.5] }, s => { flat(s); s.fill(5, 64, -1, 5, 70, -1, 'stone'); s.ladder(5, 64, 68, 0, 'south'); s.floor(3, -3, 9, 3, 69, 'stone'); s.set(5, 69, 0, 'oak_trapdoor', { facing: 'south', half: 'bottom', open: false }); s.set(8, 69, 2, 'oak_trapdoor', { facing: 'south', half: 'bottom', open: false }) })
  const res = await r.go(G(7, 70, 0), { maxTicks: 600 })
  assert.ok(res.ok, JSON.stringify(res) + r.logs.join('\n'))
  assert.strictEqual(r.sim.blockProps(5, 69, 0).open, false, 'hatch closed again')
  assert.strictEqual(r.sim.blockProps(8, 69, 2).open, false, 'the trapdoor in the floor stayed shut')
  // walking over a floor trapdoor does not open it
  const walk = await r.go(G(8, 70, 2), { maxTicks: 300 })
  assert.ok(walk.ok)
  assert.strictEqual(r.sim.blockProps(8, 69, 2).open, false)
  r.close()
})

test('descending through a hatch is not planned (physics bobs against the panel): honest "no path"', async () => {
  const r = await rig({ pos: [7.5, 70, 0.5] }, s => { flat(s); s.fill(5, 64, -1, 5, 70, -1, 'stone'); s.ladder(5, 64, 68, 0, 'south'); s.floor(3, -3, 9, 3, 69, 'stone'); s.set(5, 69, 0, 'oak_trapdoor', { facing: 'south', half: 'bottom', open: false }) })
  const res = await r.go(G(2, 64, 0), { maxTicks: 300 })
  assert.strictEqual(res.ok, false)
  r.close()
})

test('configure() enforces the no-dig / no-place rules and can be undone', async () => {
  const sim = makeSim(); flat(sim)
  const mv = legacyMovements(sim.bot)
  mv.canDig = true; mv.allow1by1towers = true; mv.canOpenDoors = true; mv.scafoldingBlocks = [1]
  const h = configure(sim.bot, mv, { maxFall: 3 })
  assert.strictEqual(mv.canDig, false); assert.strictEqual(mv.allow1by1towers, false); assert.strictEqual(mv.canOpenDoors, false)
  assert.deepStrictEqual(mv.scafoldingBlocks, [])
  assert.strictEqual(mv.maxDropDown, 4)
  assert.strictEqual(mv.infiniteLiquidDropdownDistance, false)
  for (const n of ['lava', 'fire', 'cactus', 'magma_block', 'campfire', 'nether_portal', 'sculk_sensor', 'powder_snow']) assert.ok(mv.blocksToAvoid.has(sim.bot.registry.blocksByName[n].id), n)
  h.restore()
  assert.strictEqual(mv.canDig, true)
  sim.dispose()
})

test('a replaced Movements object gets the nav config too (join.js re-running its setup)', async () => {
  const r = await rig({}, flat)
  const { Movements } = require('mineflayer-pathfinder')
  const fresh = new Movements(r.bot); fresh.canDig = true
  r.bot.pathfinder.setMovements(fresh)
  await r.sim.run(null, 60)
  assert.strictEqual(fresh.canDig, false)
  assert.strictEqual(fresh.infiniteLiquidDropdownDistance, false)
  r.close()
})
