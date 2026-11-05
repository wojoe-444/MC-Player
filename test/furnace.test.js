const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { mockBot } = require('./mock-bot')
const safehand = require('../brain/safehand')
const furnaceMod = require('../brain/furnace')
const { PRIORITY } = require('../brain/scheduler')
const config = require('../brain/furnace-config.json')

// World laid out exactly like stations.json / find-lava_cauldron.txt (2026-10-25 survey).
function world({ s2fuelB = 0, buckets = true } = {}) {
  const bot = mockBot({ pos: [-1045, 128, 2276] })
  bot.give('stone_sword'); bot.give('cobblestone', 120)
  for (const u of config.stations.flatMap(s => s.units)) bot.setBlock(...u.furnace, 'furnace')
  bot.addChest(-1043, 131, 2274, 27, { lava_bucket: 6 })                   // S1 fuel
  bot.addChest(-1043, 132, 2273, 27, {})                                   // S1 input
  bot.addChest(-1043, 128, 2273, 54, { glass: 106, stone: 286, smooth_stone: 267, bucket: buckets ? 4 : 0 }) // S1 output
  bot.addChest(-1051, 154, 2323, 27, { lava_bucket: 2 })                   // S2.1 fuel
  bot.addChest(-1051, 155, 2324, 54, {})
  bot.addChest(-1051, 151, 2324, 54, { glass: 30, water_bucket: 1, iron_ingot: 17, smooth_stone: 256, stone: 79, baked_potato: 166 })
  bot.addChest(-1051, 154, 2326, 27, s2fuelB ? { lava_bucket: s2fuelB } : {})  // S2.2 fuel
  bot.addChest(-1051, 155, 2325, 27, {})
  bot.addChest(-1051, 151, 2325, 54, { iron_ingot: 19, baked_potato: 60, stone: 288, bucket: buckets ? 2 : 0 })
  for (const d of config.depots) for (let x = d.box.min[0]; x <= d.box.max[0]; x++) for (let y = d.box.min[1]; y <= d.box.max[1]; y++) for (let z = d.box.min[2]; z <= d.box.max[2]; z++) bot.setBlock(x, y, z, 'lava_cauldron')
  const said = []
  const sh = safehand({ bot })
  const f = furnaceMod({ bot, say: (t) => said.push(t), goals: bot.goals, tryGoto: bot.tryGoto, safehand: sh, config, stateFile: null })
  return { bot, said, sh, f }
}

test('verify matches the real layout and flags a wrong coordinate', () => {
  const { bot, f } = world()
  assert.deepStrictEqual(f.verify().filter(p => !p.startsWith('unloaded')), [])
  bot.setBlock(-1043, 131, 2274, 'stone')
  assert.ok(f.verify().some(p => /S1 fuel chest .* is stone/.test(p)))
})

test('plan is read-only: takes and places nothing', async () => {
  const { bot, f } = world()
  const lines = await f.plan(null)
  assert.ok(lines.join(' ').includes('S2.2: 0 in the chest'))
  assert.ok(!bot.actions.some(a => ['withdraw', 'deposit', 'activate'].includes(a[0])))
  assert.strictEqual(bot.count('bucket'), 0)
})

test('full upkeep: buckets -> lava -> fuel chests, lava never held while moving, only buckets taken', async () => {
  const { bot, f, said } = world()
  const before = JSON.stringify(bot.chestItems(-1043, 128, 2273))
  await f.run(null)
  // S1 had 6, S2.1 had 2 (-> 6), S2.2 had 0 (-> 6): 8 lava needed but only 6 empty buckets exist
  const s1 = bot.chestItems(-1043, 131, 2274).lava_bucket
  const s21 = bot.chestItems(-1051, 154, 2323).lava_bucket
  const s22 = bot.chestItems(-1051, 154, 2326).lava_bucket
  assert.strictEqual(s1, 6)
  assert.strictEqual(s21 + s22, 2 + 6, 'all 6 collected buckets became lava and were delivered')
  assert.ok(s22 >= 2 && s21 >= 2)
  assert.deepStrictEqual(bot.lavaHeldWhileMoving, [], 'lava was selected while walking')
  assert.notStrictEqual(bot.heldItem && bot.heldItem.name, 'lava_bucket')
  // output chests lost only their buckets
  const after = bot.chestItems(-1043, 128, 2273)
  assert.strictEqual(after.bucket, undefined)
  assert.strictEqual(after.glass, 106); assert.strictEqual(after.stone, 286); assert.strictEqual(after.smooth_stone, 267)
  assert.strictEqual(bot.chestItems(-1051, 151, 2324).water_bucket, 1, 'water bucket untouched')
  assert.ok(said.some(t => /Furnace upkeep/.test(t)))
  // 120 cobble - 48 reserve = 72 into an input chest
  assert.strictEqual(bot.count('cobblestone'), 48)
})

test('already stocked: no trips for lava, no bucket grabbing, no chat', async () => {
  const { bot, f, said } = world({ s2fuelB: 5 })
  bot.take('cobblestone', 120)
  bot.addChest(-1051, 154, 2323, 27, { lava_bucket: 5 })
  await f.run(null)
  assert.ok(!bot.actions.some(a => a[0] === 'activate' || a[0] === 'withdraw' || a[0] === 'deposit'))
  assert.strictEqual(bot.chestItems(-1043, 128, 2273).bucket, 4, 'buckets left alone when nothing is needed')
  assert.deepStrictEqual(said, [])
})

test('depots dry: warns once, delivers nothing, keeps buckets', async () => {
  const { bot, f, said } = world()
  for (const d of config.depots) for (let x = d.box.min[0]; x <= d.box.max[0]; x++) for (let z = d.box.min[2]; z <= d.box.max[2]; z++) bot.setBlock(x, d.box.min[1], z, 'cauldron')
  await f.run(null)
  assert.strictEqual(said.filter(t => /dry/.test(t)).length, 1)
  assert.strictEqual(bot.count('bucket'), 6)
  assert.strictEqual(bot.count('lava_bucket'), 0)
})

test('no empty buckets anywhere: asks Walter once', async () => {
  const { bot, f, said } = world({ buckets: false })
  await f.run(null); await f.run(null)
  assert.strictEqual(said.filter(t => /no empty buckets/.test(t)).length, 1)
})

test('output chest nearly full is reported, not emptied', async () => {
  const { bot, f, said } = world()
  const chest = bot.addChest(-1043, 128, 2273, 54, { stone: 64 * 48, bucket: 2 })
  await f.run(null)
  assert.ok(said.some(t => /S1 output chest is \d+% full/.test(t)))
  assert.strictEqual(bot.chestItems(-1043, 128, 2273).stone, 64 * 48)
})

test('abort mid-run leaves lava stowed and is resumable', async () => {
  const { bot, f } = world()
  let aborted = false, cb = null
  const ctx = { resumed: false, get aborted() { return aborted }, checkpoint() { if (aborted) { const e = new Error('x'); e.name = 'AbortError'; throw e } }, onAbort(c) { cb = c; return () => {} }, sleep: async () => {} }
  const origActivate = bot.activateBlock
  let n = 0
  bot.activateBlock = async (b) => { await origActivate(b); if (++n === 2) aborted = true }
  await assert.rejects(f.run(ctx), /x/)
  assert.notStrictEqual(bot.heldItem && bot.heldItem.name, 'lava_bucket')
  assert.ok(bot.count('lava_bucket') >= 1, 'keeps the lava it already made')
  // resume: finishes the job from inventory state
  aborted = false
  await f.run({ ...ctx, resumed: true })
  assert.deepStrictEqual(bot.lavaHeldWhileMoving, [])
  assert.strictEqual(bot.count('lava_bucket'), 0)
})

test('routine is disabled-by-default shaped and only due after the interval', () => {
  const { f, bot } = world()
  const r = f.routine(PRIORITY)
  assert.strictEqual(r.defaultEnabled, false)
  assert.strictEqual(r.idleOnly, true)
  assert.strictEqual(r.due(), true)       // never ran
  bot.health = 8
  assert.strictEqual(r.due(), false)      // too hurt to wander off
})

test('elevated fuel/input chests that the pathfinder cannot target are read from the output chest position', async () => {
  const { bot, f } = world()
  const orig = bot.tryGoto
  bot.tryGoto = async (goal, label) => (goal.y >= 131 ? { ok: false, secs: 0.1, err: 'Took to long to decide path to goal!' } : orig(goal, label))
  const lines = await f.plan(null)
  assert.ok(/S1: (1|6) in the chest/.test(lines.join(' ')), lines.join(' | '))
  const snap = f.snapshot()
  assert.deepStrictEqual(snap.units.find(u => u.name === 'S1').errors, [])
})

test('few buckets are shared fairly: every low chest reaches the minimum before any gets topped up', async () => {
  const { bot, f } = world()
  bot.take('bucket', bot.count('bucket'))
  // S1 output has 4 buckets, S2.2 output 2: total 6; S2.1 has 2 lava, S2.2 has 0, S1 has 6 (full enough)
  await f.run(null)
  const s21 = bot.chestItems(-1051, 154, 2323).lava_bucket, s22 = bot.chestItems(-1051, 154, 2326).lava_bucket
  assert.strictEqual(s21 + s22, 8)
  assert.ok(s21 >= 4 && s22 >= 4, `both reach the minimum of 4 (got ${s21} and ${s22})`)
})

// Walter's rule: low only when the feeder hopper (under the fuel chest) holds 0 or 1 lava buckets
function withHoppers(feeders) {
  const w = world()
  for (const u of config.stations.flatMap(s => s.units)) {
    const hp = [u.fuel[0], u.fuel[1] - 1, u.fuel[2]]
    const n = feeders[u.fuel.join(',')]
    if (n === undefined) continue
    w.bot.addChest(...hp, 5, n ? { lava_bucket: n } : {})
    w.bot.setBlock(...hp, 'hopper')
  }
  return w
}
test('feeder hoppers holding 5 mean fuel is fine even if the fuel chest is empty: no refill trip, no low report', async () => {
  const { bot, f, said } = withHoppers({ '-1043,131,2274': 5, '-1051,154,2323': 5, '-1051,154,2326': 5 })
  await f.run(null)
  assert.ok(!bot.actions.some(a => a[0] === 'activate' || (a[0] === 'deposit' && a[1] === 'lava_bucket')), 'no lava trip')
  assert.ok(f.snapshot().units.every(u => u.low === false))
  assert.deepStrictEqual(said.filter(x => /fuel/i.test(x)), [])
})
test('a feeder hopper holding 0 or 1 triggers the refill; 2 does not', async () => {
  const { bot, f } = withHoppers({ '-1043,131,2274': 2, '-1051,154,2323': 1, '-1051,154,2326': 0 })
  await f.plan(null)
  const u = Object.fromEntries(f.snapshot().units.map(x => [x.name, x]))
  assert.strictEqual(u.S1.low, false); assert.strictEqual(u['S2.1'].low, true); assert.strictEqual(u['S2.2'].low, true)
  assert.strictEqual(u['S2.1'].feederLava, 1)
  await f.run(null)
  assert.ok(bot.chestItems(-1051, 154, 2323).lava_bucket >= 4 && bot.chestItems(-1051, 154, 2326).lava_bucket >= 4, 'low stations got lava in their fuel chests')
  assert.strictEqual(bot.chestItems(-1043, 131, 2274).lava_bucket, 6, 'S1 untouched')
})

test('routine: below mining/excavation priority, backs off 15 min after a no-op pass, announces a shortage only once, boosted when overdue', async () => {
  let n = 1000000
  const w = world({ buckets: false })
  const f2 = furnaceMod({ bot: w.bot, say: (x) => w.said.push(x), goals: w.bot.goals, tryGoto: w.bot.tryGoto, safehand: safehand({ bot: w.bot }), config, stateFile: null, now: () => n })
  const r = f2.routine(PRIORITY)
  assert.ok(r.priority < PRIORITY.EXCAVATE, 'idle check sits below excavation (10) and manual mining (11)')
  assert.strictEqual(r.due(), true)
  await f2.run(null); await f2.run(null)
  assert.strictEqual(w.said.filter(x => /feeder is low/.test(x)).length, 1, 'shortage announced once')
  assert.strictEqual(f2.state().lastResult.noop, true)
  n += 11 * 60000; assert.strictEqual(r.due(), false, 'a no-op pass backs off 15 minutes, not 10')
  n += 5 * 60000; assert.strictEqual(r.due(), true)
  assert.strictEqual(r.make().priority < PRIORITY.EXCAVATE, true)
  n += 100 * 60000
  assert.strictEqual(r.make().priority, PRIORITY.FURNACE, 'overdue: boosted so the fuel cannot run out')
})
