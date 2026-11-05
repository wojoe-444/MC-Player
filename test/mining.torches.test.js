// Torches (the one kind of block placing Walter authorized): in the mine hallways, with line of sight, logged.
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const H = require('./mining.helpers')
const { rig, runJob, k } = H
const createTorches = require('../brain/lighting/torches')
const los = require('../brain/los')

const torchesFor = (bot) => createTorches({ bot, canSee: (b) => los.canSee(bot, b), sleep: () => Promise.resolve() })

test('torches: placed on the floor of the cell the bot stands in, only torches, every one audited for line of sight', async () => {
  const r = rig({ torches: true, torchCount: 20 })
  await runJob(r, 'diamond', 5)
  assert.ok(r.bot.placed.length >= 3, `placed ${r.bot.placed.length}`)
  assert.ok(r.bot.placed.every(p => p[3] === 'torch'))
  assert.deepStrictEqual(r.bot.losViolations, [])
  assert.strictEqual(r.bot.count('torch'), 20 - r.bot.placed.length)
  // each torch is in a hallway cell (feet level of the strip) and the hallway is still walkable (torches have no collision)
  for (const [x, y, z] of r.bot.placed) { assert.strictEqual(y, -58); assert.strictEqual(r.bot.blockAt(new Vec3(x, y, z)).name, 'torch') }
  assert.strictEqual(r.state.mines[0].trunk, 6)
  assert.ok(r.state.stats.torches >= 3)
  // spacing: no light data -> about every 9 cells, never two in a row
  const idx = r.bot.placed.map(p => p.join(','))
  assert.strictEqual(new Set(idx).size, idx.length)
})
test('torches: with light data a torch goes down only where the light is below 2, and at least 3 cells apart', async () => {
  const r = rig({ torches: true, torchCount: 20 })
  r.bot.lightAt = (x, y, z) => { let l = 0; for (const [tx, ty, tz] of r.bot.placed) l = Math.max(l, 14 - Math.hypot(x - tx, y - ty, z - tz)); return Math.max(0, Math.round(l)) }
  await runJob(r, 'diamond', 5)
  assert.ok(r.bot.placed.length >= 1 && r.bot.placed.length <= 4, `placed ${r.bot.placed.length}`)
  for (let i = 1; i < r.bot.placed.length; i++) {
    const a = r.bot.placed[i - 1], b = r.bot.placed[i]
    assert.ok(Math.hypot(a[0] - b[0], a[2] - b[2]) >= 3, 'torches are not stacked next to each other')
  }
  assert.deepStrictEqual(r.bot.losViolations, [])
})
test('torches: without torches it asks the crafting module once, says so, and carries on mining either way', async () => {
  const r = rig({ torches: true, dispatch: (u, t) => { if (/torch/.test(t)) r.bot.give('torch', 16); return true } })
  await runJob(r, 'diamond', 5)
  assert.deepStrictEqual(r.calls.dispatch, ['craft 16 torch'])
  assert.ok(r.bot.placed.length >= 3)
  assert.ok(r.said.some(s => /Out of torches/.test(s)))
  const r2 = rig({ torches: true, dispatch: () => true })              // the crafting module cannot make any
  const res = await runJob(r2, 'diamond', 5)
  assert.strictEqual(res.status, 'done')
  assert.strictEqual(r2.bot.placed.length, 0)
  assert.ok(r2.calls.dispatch.length <= 2, 'asks at most twice')
  assert.strictEqual(r2.state.mines[0].trunk, 6, 'the strip is still finished')
  const r3 = rig({ torches: true })                                        // no dispatch at all
  assert.strictEqual((await runJob(r3, 'diamond', 5)).status, 'done')
})
test('torches: the placer refuses without a clear view, on bad floors and where the cell is not empty', async () => {
  const r = rig({ torchCount: 4 })
  const t = torchesFor(r.bot)
  H.carve(r.bot, [[1, -58, 0], [1, -57, 0]])
  const floor = r.bot.blockAt(new Vec3(1, -59, 0))
  assert.strictEqual((await t.place(null, floor)).ok, true)                                   // in view, plain stone floor
  assert.deepStrictEqual(r.bot.placed, [[1, -58, 0, 'torch']])
  assert.strictEqual((await t.place(null, r.bot.blockAt(new Vec3(1, -59, 0)))).why, 'bad-floor')     // the cell above is a torch now
  const wall = r.bot.blockAt(new Vec3(5, -59, 0))                                              // behind rock
  H.carve(r.bot, [[5, -58, 0]])
  assert.strictEqual((await t.place(null, r.bot.blockAt(new Vec3(5, -59, 0)))).why, 'no-line-of-sight')
  for (const bad of ['farmland', 'water', 'oak_slab', 'chest', 'dirt_path', 'glass', 'oak_leaves', 'rail', 'lava']) {
    H.carve(r.bot, [[0, -58, 1]]); r.bot.setBlock(0, -59, 1, bad)
    const res = await t.place(null, r.bot.blockAt(new Vec3(0, -59, 1)))
    assert.strictEqual(res.ok, false, bad)
  }
  assert.strictEqual(r.bot.placed.length, 1)
  r.bot.take('torch', 99)
  H.carve(r.bot, [[0, -58, -1]])
  assert.strictEqual((await t.place(null, r.bot.blockAt(new Vec3(0, -59, -1)))).why, 'no-torches')
  r.bot.noRaycast()
  r.bot.give('torch', 1)
  assert.strictEqual((await t.place(null, r.bot.blockAt(new Vec3(0, -59, -1)))).why, 'cannot-verify-view')
})
test('torches: nothing but torches is ever placed (placeBlock rejects any other held item)', async () => {
  const r = rig({ torches: true, torchCount: 3 })
  r.bot.give('cobblestone', 64)
  await runJob(r, 'diamond', 5)
  assert.ok(r.bot.placed.every(p => p[3] === 'torch'))
  assert.strictEqual(r.bot.count('cobblestone') >= 64, true, 'cobblestone is never used as a block')
})
