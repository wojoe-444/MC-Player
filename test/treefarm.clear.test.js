// brain/treefarm: the whole tree goes (so the leaves can decay) and the decay drops are collected.
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { rig, growTree, addBranch, countBlocks, blockName, fakeCtx } = require('./treefarm.helpers')

const mk = (opts) => rig(opts)
const done = (r) => r.stop()
const logsLeft = (r, logs) => logs.filter(p => /_log$/.test(r.bot.blockAt(p).name)).length
const run = (r, o = {}, ctx = fakeCtx()) => r.engine.run(ctx, { manual: true, ...o })
const allLogsAround = (bot, cx, cz, r = 10) => {
  let n = 0
  for (let x = cx - r; x <= cx + r; x++) for (let y = 64; y < 100; y++) for (let z = cz - r; z <= cz + r; z++) if (/_log$/.test(bot.blockAt(new Vec3(x, y, z)).name)) n++
  return n
}

test('big oak with diagonal branches buried in leaves: every log goes, branches included, so nothing keeps the canopy alive', async () => {
  const r = mk({ inv: { iron_axe: 1, dirt: 30, oak_sapling: 2 } }); const { bot } = r
  const trunk = growTree(bot, { x: 4, z: 3, h: 12 })
  const b1 = addBranch(bot, { x: 4, z: 3, y: 71, dx: 1, dz: 1, len: 4 }), b2 = addBranch(bot, { x: 4, z: 3, y: 69, dx: -1, dz: 0, len: 5 }), b3 = addBranch(bot, { x: 4, z: 3, y: 73, dx: 0, dz: -1, len: 3 })
  const all = [...trunk, ...b1, ...b2, ...b3]
  await run(r)
  assert.strictEqual(logsLeft(r, all), 0, `left: ${all.filter(p => /_log$/.test(bot.blockAt(p).name)).map(p => p.toString())}`)
  assert.strictEqual(allLogsAround(bot, 4, 3), 0, 'no stray log within 10 blocks')
  assert.strictEqual(countBlocks(bot, 'dirt'), 0, 'pillar gone')
  assert.ok(Math.abs(bot.entity.position.y - 64) < 0.01)
  assert.strictEqual(bot.losViolations.length, 0, bot.losViolations.join(' | '))
  assert.ok(!r.said.some(t => /out of reach/.test(t)), r.said.join(' | '))
  done(r)
})

test('a spruce with a diagonal limb and a 2x2 dark oak with a branch: also cleared completely', async () => {
  const r = mk({ inv: { iron_axe: 1, dirt: 30, spruce_sapling: 2 } }); const { bot } = r
  const s = growTree(bot, { x: 4, z: 3, h: 14, species: 'spruce' }), sb = addBranch(bot, { x: 4, z: 3, y: 72, dx: 1, dz: -1, len: 4, species: 'spruce' })
  await run(r)
  assert.strictEqual(logsLeft(r, [...s, ...sb]), 0)
  assert.strictEqual(allLogsAround(bot, 4, 3), 0)
  done(r)
  const q = mk({ inv: { iron_axe: 1, dirt: 30, dark_oak_sapling: 4 } })
  const d = growTree(q.bot, { x: 4, z: 3, h: 9, species: 'dark_oak', thick: true }), db = addBranch(q.bot, { x: 5, z: 4, y: 69, dx: 1, dz: 1, len: 4, species: 'dark_oak' })
  await run(q)
  assert.strictEqual(logsLeft(q, [...d, ...db]), 0)
  assert.strictEqual(allLogsAround(q.bot, 4, 3), 0)
  done(q)
})

test('with clearLeaves off, leaves are only broken when one hides a log of this tree; the canopy is left to decay', async () => {
  const r = mk({ inv: { iron_axe: 1, oak_sapling: 2 }, config: { clearLeaves: false } }); const { bot } = r
  growTree(bot, { x: 4, z: 3, h: 5 })
  const other = growTree(bot, { x: -9, z: 3, h: 3 })                           // a young tree next door: not ours, not touched
  const leavesBefore = countBlocks(bot, 'oak_leaves')
  await run(r, { count: 1 })
  const dugLeaves = bot.actions.filter(a => a[0] === 'dig' && /_leaves$/.test(a[1])).length
  assert.ok(dugLeaves <= 6, `${dugLeaves} leaves broken`)
  assert.ok(countBlocks(bot, 'oak_leaves') >= leavesBefore - dugLeaves)
  assert.strictEqual(logsLeft(r, other), 3)
  done(r)
})

test('with clearLeaves off, after the leaves have had time to decay it comes back and picks up the saplings, apples and sticks; not before', async () => {
  let t = 1e12
  const r = mk({ now: () => t, inv: { iron_axe: 1, oak_sapling: 2 }, config: { clearLeaves: false } }); const { bot } = r
  growTree(bot, { x: 4, z: 3, h: 5 })
  await run(r, { count: 1 })
  assert.strictEqual(r.state.decay.length, 1, 'the felled tree is watched')
  // leaves decay (the test does what the game would) and drop things on the ground around the old trunk
  for (let x = 0; x <= 8; x++) for (let y = 62; y < 72; y++) for (let z = -1; z <= 7; z++) if (/_leaves$/.test(bot.blockAt(new Vec3(x, y, z)).name)) bot.setBlock(x, y, z, 'air')
  bot.addItemEntity(6.5, 64, 5.5, 'oak_sapling', 2); bot.addItemEntity(2.5, 64, 1.5, 'apple', 1); bot.addItemEntity(5.5, 64, 2.5, 'stick', 3)
  bot.entity.position = new Vec3(-20.5, 64, -20.5)
  r.said.length = 0
  t += 30000
  assert.ok(!r.engine.due(), 'too early: the leaves are still there')
  t += 100000
  assert.ok(r.engine.due(), 'two minutes later it is worth a visit')
  const saplings0 = bot.count('oak_sapling'), sticks0 = bot.count('stick')
  await run(r, { count: 1 })
  assert.strictEqual(bot.count('oak_sapling'), saplings0 + 2)
  assert.strictEqual(bot.count('apple'), 1)
  assert.strictEqual(bot.count('stick'), sticks0 + 3)
  assert.strictEqual(Object.values(bot.entities).filter(e => e.name === 'item').length, 0, 'nothing left on the ground')
  assert.ok(r.said.some(m => /where the leaves decayed/.test(m)), r.said.join(' | '))
  done(r)
})

test('a felled tree is visited at most 3 times, and not after 25 minutes', async () => {
  let t = 1e12
  const r = mk({ now: () => t }); const { bot } = r
  r.state.decay.push({ x: 4, y: 64, z: 3, at: t, visits: 0, lastVisit: 0 })
  for (let i = 0; i < 5; i++) { t += 130000; await r.engine.run(fakeCtx(), { manual: true, center: new Vec3(40, 64, 40), radius: 3 }) }
  assert.strictEqual(r.state.decay.length, 0, 'forgotten after 3 visits')
  r.state.decay.push({ x: 4, y: 64, z: 3, at: t - 26 * 60000, visits: 0, lastVisit: 0 })
  assert.ok(!r.engine.due())
  await r.engine.run(fakeCtx(), { manual: true, center: new Vec3(40, 64, 40), radius: 3 })
  assert.strictEqual(r.state.decay.length, 0)
  done(r)
})
