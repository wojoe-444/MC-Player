const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const { Vec3 } = require('vec3')
const h = require('./build.helpers')
const { rig, fakeCtx, wait, waitFor, PRIORITY, blueprint: bp, stateStore, nameAt, snapshot, diff, assertClean, assertBuilt } = h
const { findSite } = require('../brain/build/survey')

test('the whole tower: built from the pillar, every placement whitelisted, inside the volume, with line of sight; pillar gone; bot outside the door', async () => {
  const r = rig()
  const before = snapshot(r)
  const res = await r.engine.run(fakeCtx())
  assert.deepStrictEqual(res, { status: 'done' })
  assertClean(r); assertBuilt(r)
  const o = r.origin
  // exactly the blueprint was placed: every step once, plus the 10 pillar blocks
  assert.strictEqual(r.bot.placements.length, r.steps().length + 10)
  assert.strictEqual(r.bot.digLog.length, 10, 'the 10 pillar blocks, nothing else')
  assert.ok(r.bot.placements.filter(p => p.name === 'cobblestone').length === 10)
  for (const d of diff(r, before)) assert.ok(bp.inBox(o, d), `world changed outside the volume at ${d.x},${d.y},${d.z}`)
  // inventory: the pillar cobblestone came back, the rest of the materials were used up as planned
  assert.strictEqual(r.bot.count('cobblestone'), 40)
  assert.strictEqual(r.bot.count('stone_bricks'), 130 - 118); assert.strictEqual(r.bot.count('spruce_log'), 4); assert.strictEqual(r.bot.count('ladder'), 2)
  assert.strictEqual(r.bot.count('spruce_planks'), 60 - 52); assert.strictEqual(r.bot.count('spruce_door'), 0); assert.strictEqual(r.bot.count('torch'), 6 - 5)
  assert.ok(r.bot.count('stone_pickaxe') === 1)
  // standing outside at the door, on the ground
  const p = r.bot.entity.position
  assert.deepStrictEqual([Math.floor(p.x), p.y, Math.floor(p.z)], [o.ox + 2, o.oy, o.oz + 5])
  // chat: a start and an end line only
  assert.deepStrictEqual(r.said, ['Starting my tower at 100, 70, 200.', 'My tower is finished at 100, 70, 200.'])
  // the saved state mirrors it
  const saved = JSON.parse(fs.readFileSync(r.file, 'utf8'))
  assert.strictEqual(saved.finished, true); assert.strictEqual(saved.pillar, null); assert.ok(saved.placed.length >= 221)
  assert.match(r.engine.statusLine(), /finished/)
})

test('the order of the work: ring courses climb with the pillar, the ladder only goes up after the pillar is gone, the door is the last piece', async () => {
  const r = rig()
  await r.engine.run(fakeCtx())
  const pl = r.bot.placements, o = r.origin
  const firstLadder = pl.findIndex(p => p.name === 'ladder')
  assert.ok(r.bot.digLog.every(d => d.placedSoFar <= firstLadder), 'all pillar blocks are dug before the first ladder is placed')
  assert.ok(firstLadder > 0)
  assert.strictEqual(pl[pl.length - 1].name, 'spruce_door')
  // the feet of the bot while placing the walls: course c from feet y = oy + c
  for (const p of pl) if (p.name === 'stone_bricks' && p.y < o.oy + 9) assert.ok(Math.abs(p.feetY - (p.y - o.oy) - o.oy) < 0.3, `wall course ${p.y - o.oy} placed with feet at ${p.feetY - o.oy}`)
  // the first ladder rung stands on the ground, each next one is placed from the rung below
  const lad = pl.filter(p => p.name === 'ladder')
  lad.forEach((p, i) => assert.ok(Math.abs(p.feetY - o.oy - Math.max(0, i - 1)) < 0.3, `rung ${i} placed with feet at ${p.feetY - o.oy}`))
})

test('uneven ground: low cells get a cobblestone foundation first; the site from the survey drives the whole build', async () => {
  const ox = 100, oy = 70, oz = 200
  const ground = (x, z) => ((x === ox || x === ox + 4) && z === oz + 1) || (x === ox + 3 && z === oz + 4) ? oy - 2 : oy - 1
  const r = rig({ ground, site: false })
  const site = findSite(r.bot, { center: { x: ox, z: oz }, radius: 0, maxDy: 1, protect: [] })
  assert.deepStrictEqual([site.ox, site.oy, site.oz], [ox, oy, oz]); assert.strictEqual(site.low.length, 3)
  r.state.site = site
  const res = await r.engine.run(fakeCtx())
  assert.deepStrictEqual(res, { status: 'done' })
  assertClean(r); assertBuilt(r)
  const found = r.bot.placements.filter(p => p.y === oy - 1)
  assert.strictEqual(found.length, 3); assert.ok(found.every(p => p.name === 'cobblestone'))
  assert.deepStrictEqual(found.map(p => `${p.x - ox},${p.z - oz}`).sort(), ['0,1', '3,4', '4,1'])
  assert.strictEqual(nameAt(r, ox, oy - 1, oz + 1), 'cobblestone', 'the foundation stays')
  assert.strictEqual(r.bot.placements[0].name, 'cobblestone', 'foundation first')
  assert.strictEqual(r.bot.count('cobblestone'), 40 - 3)
})

test('missing materials park with the exact list and one short line; nothing is placed, then it carries on once they are there', async () => {
  const r = rig({ materials: { ...h.MATERIALS, spruce_planks: 40, ladder: 0, stone_bricks: 0, cobblestone: 5, stone_pickaxe: 0 } })
  const res = await r.engine.run(fakeCtx())
  assert.strictEqual(res.status, 'park')
  assert.strictEqual(res.reason, 'Tower: need 118 x stone_bricks, 10 x ladder, 13 x cobblestone, 1 x pickaxe.')
  assert.deepStrictEqual(r.said, [res.reason])
  assert.strictEqual(r.bot.placements.length, 0); assert.strictEqual(r.state.active, false)
  assert.deepStrictEqual(r.engine.missing().map(m => `${m.count} x ${m.name}`), ['118 x stone_bricks', '12 x spruce_planks', '10 x ladder', '13 x cobblestone', '1 x pickaxe'])
  // the driver fetches things; "resume building" runs the job again with the same state
  r.bot.give('stone_bricks', 118); r.bot.give('spruce_planks', 12); r.bot.give('ladder', 10); r.bot.give('cobblestone', 13); r.bot.give('iron_pickaxe', 1)
  const again = await r.engine.run(fakeCtx({ resumed: true }))
  assert.deepStrictEqual(again, { status: 'done' })
  assertClean(r); assertBuilt(r)
})

test('running out of bricks half way: the bot comes down from the pillar first, parks with what is missing, and finishes later without duplicates', async () => {
  const r = rig({ materials: { ...h.MATERIALS, stone_bricks: 60 } })
  const res1 = await r.engine.run(fakeCtx())
  // a partial shortage is no reason to stand still: it builds what it can, comes down, and parks with the real shortage
  assert.strictEqual(res1.status, 'park'); assert.match(res1.reason, /need \d+ x stone_bricks/)
  assert.ok(r.bot.placements.length > 0); assert.strictEqual(r.bot.entity.position.y, r.origin.oy); assert.strictEqual(r.state.pillar, null)
  // now the bricks "disappear" while building (another thread took them): placement runs dry mid-course
  const r2 = rig()
  let took = false
  r2.bot.onPlace = (n, rec) => { if (!took && rec.name === 'stone_bricks' && rec.y >= r2.origin.oy + 5) { took = true; r2.bot.take('stone_bricks', r2.bot.count('stone_bricks')) } }
  const res2 = await r2.engine.run(fakeCtx())
  assert.strictEqual(res2.status, 'park'); assert.match(res2.reason, /need \d+ x stone_bricks/)
  assert.strictEqual(r2.bot.entity.position.y, r2.origin.oy, 'on the ground again, not on the pillar')
  assert.strictEqual(r2.state.pillar, null); assert.strictEqual(nameAt(r2, r2.cx, r2.origin.oy, r2.cz), 'air')
  assert.ok(r2.engine.statusLine().startsWith('Tower (not running): phase walls'))
  r2.bot.give('stone_bricks', 130)
  const res3 = await r2.engine.run(fakeCtx({ resumed: true }))
  assert.deepStrictEqual(res3, { status: 'done' })
  assertClean(r2); assertBuilt(r2)
})

test('furnishing is only what is in the bag: nothing there, nothing placed, no complaint', async () => {
  const r = rig({ furnishing: false, materials: { ...h.MATERIALS, torch: 4 } })
  const res = await r.engine.run(fakeCtx())
  assert.deepStrictEqual(res, { status: 'done' })
  assert.ok(!r.bot.placements.some(p => /_bed$|chest|crafting_table/.test(p.name)))
  assert.strictEqual(r.bot.placements.filter(p => p.name === 'torch').length, 4)
  assert.deepStrictEqual(r.said.length, 2)
  assertClean(r); assertBuilt(r, { furnished: false })
  // with the bag full: the bed head lies north of the foot, table and chest on the floor, a torch on the west wall
  const f = rig()
  await f.engine.run(fakeCtx())
  const o = f.origin
  assert.match(nameAt(f, o.ox + 3, o.oy, o.oz + 2), /_bed$/); assert.match(nameAt(f, o.ox + 3, o.oy, o.oz + 1), /_bed$/)
  assert.strictEqual(nameAt(f, o.ox + 1, o.oy, o.oz + 3), 'crafting_table'); assert.strictEqual(nameAt(f, o.ox + 3, o.oy, o.oz + 3), 'chest')
  assert.strictEqual(nameAt(f, o.ox + 1, o.oy + 2, o.oz + 3), 'wall_torch')
})


test('loop breaker: the same park reason three times in a row holds the job for a few minutes (one chat line), then it is tried again', async () => {
  const r = rig({ materials: { ...h.MATERIALS, ladder: 0 } })
  const reasons = []
  for (let i = 0; i < 3; i++) { const res = await r.engine.run(fakeCtx()); reasons.push(res.reason) }
  assert.strictEqual(new Set(reasons).size, 1)
  assert.ok(r.said.some(t => /keeps stopping for the same reason/.test(t)), r.said.join(' | '))
  const held = await r.engine.run(fakeCtx())
  assert.strictEqual(held.status, 'retry'); assert.ok(held.afterMs >= 5000)
  r.state.holdUntil = Date.now() - 1                                  // the few minutes are over
  r.bot.give('ladder', 10)
  const again = await r.engine.run(fakeCtx())
  assert.deepStrictEqual(again, { status: 'done' })
})
