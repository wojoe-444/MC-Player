const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Vec3 } = require('vec3')
const { rig, plantCrops, plantCane, plantBamboo, grass, ground, row, placed, baseConfig, blockName, ageAt, fakeCtx, waitFor, wait, SITE, HOUSE_CHEST, BED, PRIORITY } = require('./routines.helpers')
const crops = require('../brain/routines/crops')
const stateStore = require('../brain/routines/state')

const blk = (name, props = {}, floor = 'farmland') => ({ name, boundingBox: 'block', getProperties: () => props, _floor: floor })
const runFarm = (r, opts = {}, ctx = fakeCtx()) => r.farm.run(ctx, opts)
const inChest = (r) => r.bot.chestItems(...HOUSE_CHEST)

// ================================================================ crops.js (pure)

test('ripe means full age, on farmland: wheat/carrots/potatoes 7, beetroots 3', () => {
  const floor = { name: 'farmland' }
  assert.ok(crops.isRipe(blk('wheat', { age: 7 }), floor))
  assert.ok(!crops.isRipe(blk('wheat', { age: 6 }), floor))
  assert.ok(crops.isRipe(blk('beetroots', { age: 3 }), floor))
  assert.ok(!crops.isRipe(blk('beetroots', { age: 2 }), floor))
  assert.ok(!crops.isRipe(blk('wheat', { age: 7 }), { name: 'dirt' }), 'not over farmland')
  assert.ok(!crops.isRipe(blk('sugar_cane', { age: 15 }), floor))
  assert.ok(!crops.isRipe(null, floor))
})

test('what to store: 16 of every seed and one stack of food stay on the bot, the rest of the crops go in the chest', () => {
  const p = crops.planStore({ carrot: 100, potato: 50, wheat: 30, wheat_seeds: 40, beetroot_seeds: 5, bread: 10, cobblestone: 500, cooked_beef: 0 })
  assert.deepStrictEqual(p.keep, { wheat_seeds: 16, carrot: 54, potato: 16, beetroot_seeds: 5, bread: 10 })
  assert.strictEqual(p.food, 64)
  assert.deepStrictEqual(p.deposit, { wheat: 30, wheat_seeds: 24, carrot: 46, potato: 34 })
  assert.ok(!('cobblestone' in p.deposit), 'only crop items are ever stored')
})

test('what to store: other food (cooked meat) counts towards the stack but is never stored', () => {
  const p = crops.planStore({ cooked_beef: 64, carrot: 40, apple: 5 })
  assert.deepStrictEqual(p.deposit, { carrot: 24 }, 'only the 16 seed carrots stay')
  assert.ok(!('cooked_beef' in p.deposit) && !('apple' in p.deposit))
  assert.deepStrictEqual(crops.planStore({}).deposit, {})
})

// ================================================================ farm: harvest and replant

test('harvests only ripe crops over farmland, replants every one, leaves everything else alone', async () => {
  const r = rig()
  plantCrops(r.bot, [...row('wheat', 7, 5), ...row('wheat', 3, 3, -1070, 2359), ...row('carrots', 7, 3, -1070, 2360)])
  plantCrops(r.bot, [{ crop: 'wheat', age: 7, x: -1060, z: 2358, floor: 'dirt' }])            // ripe but not on farmland
  r.bot.setBlock(-1062, 160, 2358, 'sugar_cane', { age: 15 })
  const res = await runFarm(r, { manual: true })
  assert.strictEqual(res.status, 'done')
  for (let i = 0; i < 5; i++) assert.strictEqual(ageAt(r.bot, -1070 + i, 160, 2358), 0, `wheat ${i} replanted`)
  for (let i = 0; i < 3; i++) assert.strictEqual(ageAt(r.bot, -1070 + i, 160, 2360), 0, `carrot ${i} replanted`)
  for (let i = 0; i < 3; i++) assert.strictEqual(ageAt(r.bot, -1070 + i, 160, 2359), 3, 'unripe crop untouched')
  assert.strictEqual(ageAt(r.bot, -1060, 160, 2358), 7, 'crop on dirt untouched')
  assert.strictEqual(blockName(r.bot, -1062, 160, 2358), 'sugar_cane')
  assert.strictEqual(r.bot.dugAt().length, 8)
  assert.strictEqual(placed(r.bot).length, 8)
  assert.strictEqual(blockName(r.bot, -1070, 159, 2358), 'farmland')
  assert.ok(r.said.some(t => /Harvest done\. Picked 5 wheat, 3 carrots; replanted 5 wheat, 3 carrots/.test(t)), r.said.join(' | '))
  assert.strictEqual(r.state.farm.pending.length, 0)
  assert.deepStrictEqual(r.bot.lavaHeldWhileMoving, [])
})

test('extras go to the house chest at -1064,160,2326, a stack of food and 16 of each seed stay, nothing else is touched', async () => {
  const r = rig()
  plantCrops(r.bot, [...row('wheat', 7, 6), ...row('carrots', 7, 6, -1070, 2359), ...row('potatoes', 7, 6, -1070, 2360)])
  r.bot.give('cobblestone', 100); r.bot.give('stone_sword', 1); r.bot.give('wheat_seeds', 30); r.bot.give('potato', 20)
  await runFarm(r, { manual: true })
  const chest = inChest(r)
  assert.strictEqual(chest.wheat, 6, 'wheat stored')
  assert.strictEqual(r.bot.count('wheat'), 0)
  assert.strictEqual(r.bot.count('wheat_seeds'), 16); assert.strictEqual(chest.wheat_seeds, 14)
  assert.ok(r.bot.count('potato') >= 16 && r.bot.count('carrot') >= 12, 'seed crops kept')
  assert.ok(r.bot.count('carrot') + r.bot.count('potato') <= 64 + 16, 'about a stack of food')
  assert.strictEqual(r.bot.count('cobblestone'), 100); assert.strictEqual(r.bot.count('stone_sword'), 1)
  const opened = new Set(r.bot.actions.filter(a => a[0] === 'open').map(a => a[1]))
  assert.deepStrictEqual([...opened], [HOUSE_CHEST.join(',')])
  assert.ok(r.said.some(t => /Stored in the house chest at -1064, 160, 2326/.test(t)))
  assert.ok(!r.bot.actions.some(a => /toss|drop/.test(a[0])))
})

test('a food stack of 64 stays on the bot: 100 carrots harvested, about 64 kept, the rest stored', async () => {
  const r = rig()
  r.bot.give('carrot', 100)
  plantCrops(r.bot, row('carrots', 7, 4))
  await runFarm(r, { manual: true })
  assert.strictEqual(r.bot.count('carrot') + (inChest(r).carrot || 0), 100 + 4 * 3 - 4, '4 replanted')
  assert.strictEqual(r.bot.count('carrot'), 64)
})

test('placeBlock timeouts that actually planted the crop are not failures', async () => {
  const r = rig(); r.bot.placeMode = 'timeout-but-placed'
  plantCrops(r.bot, row('wheat', 7, 4))
  await runFarm(r, { manual: true })
  assert.strictEqual(r.state.farm.pending.length, 0)
  for (let i = 0; i < 4; i++) assert.strictEqual(blockName(r.bot, -1070 + i, 160, 2358), 'wheat')
  assert.strictEqual(r.bot.count('wheat_seeds'), 0, 'every seed went back into the ground')
})

test('a spot that could not be replanted is remembered and replanted by the next run, even with nothing ripe', async () => {
  const r = rig(); r.bot.placeMode = 'fail'
  plantCrops(r.bot, row('wheat', 7, 3))
  await runFarm(r, { manual: true })
  assert.strictEqual(r.state.farm.pending.length, 3)
  assert.ok(r.said.some(t => /3 spot\(s\) still need seeds/.test(t)))
  assert.ok(placed(r.bot).length >= 3 * 2, 'tried more than once per spot')
  assert.strictEqual(JSON.parse(fs.readFileSync(r.file, 'utf8')).farm.pending.length, 3, 'persisted')
  r.bot.placeMode = 'ok'; r.said.length = 0
  await runFarm(r, { manual: false })
  assert.strictEqual(r.state.farm.pending.length, 0)
  for (let i = 0; i < 3; i++) assert.strictEqual(blockName(r.bot, -1070 + i, 160, 2358), 'wheat')
})

test('no seed in the bag after harvesting: spot is remembered, seeds are fetched from the house chest next time', async () => {
  const r = rig(); r.bot.seedDrop = 0
  plantCrops(r.bot, row('wheat', 7, 3))
  await runFarm(r, { manual: true })
  assert.strictEqual(r.state.farm.pending.length, 3)
  assert.strictEqual(blockName(r.bot, -1070, 160, 2358), 'air')
  r.bot.addChest(...HOUSE_CHEST, 54, { wheat_seeds: 40 })
  await runFarm(r, { manual: false })
  assert.strictEqual(r.state.farm.pending.length, 0)
  assert.strictEqual(blockName(r.bot, -1070, 160, 2358), 'wheat')
  assert.ok(r.bot.actions.some(a => a[0] === 'withdraw' && a[1] === 'wheat_seeds'))
  assert.ok(inChest(r).wheat_seeds >= 40 - 16 - 0)
})

test('pending spots that are already planted (or no longer farmland) are dropped without placing anything', async () => {
  const r = rig()
  r.bot.setBlock(-1070, 159, 2358, 'farmland'); r.bot.setBlock(-1070, 160, 2358, 'wheat', { age: 1 })
  r.state.farm.pending = [{ x: -1070, y: 160, z: 2358, crop: 'wheat' }, { x: -1071, y: 160, z: 2358, crop: 'wheat' }]
  await runFarm(r, { manual: false })
  assert.strictEqual(r.state.farm.pending.length, 0)
  assert.strictEqual(placed(r.bot).length, 0)
})

test('searches around the known farm sites, not around wherever the bot stands (it walks there first)', async () => {
  const r = rig({ pos: [0, 64, 0], sites: [{ name: 'home farm', x: -1067, y: 160, z: 2360 }, { name: 'north farm', x: 200, y: 70, z: -300 }] })
  plantCrops(r.bot, row('wheat', 7, 4, -1070, 2358))
  plantCrops(r.bot, row('carrots', 7, 3, 190, -300, 70))
  plantCrops(r.bot, [{ crop: 'wheat', age: 7, x: -1067 + 45, z: 2360 }])        // 45 blocks from the site centre: inside the 48 radius
  r.bot.setBlock(-1067 + 45, 159, 2360, 'farmland')
  await runFarm(r, { manual: true })
  assert.strictEqual(r.bot.dugAt().length, 4 + 3 + 1)
  const gotos = r.bot.actions.filter(a => a[0] === 'goto' && /farm/.test(a[1])).map(a => a[1])
  assert.deepStrictEqual(gotos.slice(0, 2).sort(), ['the home farm', 'the north farm'])
})

test('a site we cannot walk to is reported, the other sites are still done', async () => {
  const r = rig({ pos: [0, 64, 0], sites: [{ name: 'far farm', x: 500, y: 70, z: 500 }, { name: 'home farm', x: -1067, y: 160, z: 2360 }] })
  plantCrops(r.bot, row('wheat', 7, 3, -1070, 2358))
  r.bot.gotoFails = (goal, label) => label === 'the far farm'
  await runFarm(r, { manual: true })
  assert.strictEqual(r.bot.dugAt().length, 3)
  assert.ok(r.said.some(t => /could not walk to: far farm/.test(t)))
})

test('quiet when idle: an idle run with nothing ripe says nothing, a manual one answers', async () => {
  const r = rig({ config: { farm: { bamboo: { stalks: 0 } } } })
  await runFarm(r, { manual: false })
  assert.deepStrictEqual(r.said, [])
  await runFarm(r, { manual: true })
  assert.ok(r.said.some(t => /do not see any ripe crops/.test(t)))
})

test('inventory nearly full: unloads into the house chest in the middle of the run and goes on', async () => {
  const r = rig()
  plantCrops(r.bot, row('wheat', 7, 8))
  for (let i = 0; r.bot.inventory.emptySlotCount() > 4; i++) r.bot.give(['bone', 'flint', 'string', 'feather', 'gunpowder', 'paper', 'clay_ball', 'slime_ball'][i % 8], 64 * 1)
  const res = await runFarm(r, { manual: true })
  assert.strictEqual(res.status, 'done')
  assert.strictEqual(r.bot.dugAt().length, 8)
  for (let i = 0; i < 8; i++) assert.strictEqual(blockName(r.bot, -1070 + i, 160, 2358), 'wheat')
  assert.ok(!r.bot.actions.some(a => /toss|drop/.test(a[0])))
})

test('inventory full and the chest full: stops, tells Walter, leaves nothing on the ground', async () => {
  const r = rig({ houseChest: false })
  r.bot.addChest(...HOUSE_CHEST, 27, { stone: 27 * 64 })
  plantCrops(r.bot, row('wheat', 7, 20))
  for (let i = 0; r.bot.inventory.emptySlotCount() > 2; i++) r.bot.give('bone', 64)
  r.bot.give('wheat', 5)
  const res = await runFarm(r, { manual: true })
  assert.strictEqual(res.status, 'done')
  assert.ok(r.bot.dugAt().length < 20)
  assert.ok(r.said.some(t => /inventory is full and the house chest is full|could not empty/.test(t)), r.said.join('|'))
  assert.ok(!r.bot.actions.some(a => /toss|drop/.test(a[0])))
  assert.strictEqual(Object.values(r.bot.entities).filter(e => e.name === 'item').length, 0, 'no drops left behind')
})

test('house chest not at the configured spot: the nearest chest around the house waypoint is used', async () => {
  const r = rig({ houseChest: false })
  r.bot.addChest(-1066, 160, 2327, 54, {})
  plantCrops(r.bot, row('wheat', 7, 3))
  await runFarm(r, { manual: true })
  assert.ok((r.bot.chestItems(-1066, 160, 2327).wheat || 0) >= 3)
})

test('hostile close by or low health: no work, retried later, finally gives up', async () => {
  const r = rig()
  plantCrops(r.bot, row('wheat', 7, 3))
  r.bot.entities.z = { id: 99, name: 'creeper', position: r.bot.entity.position.offset(3, 0, 0) }
  const ctx = fakeCtx()
  let res = await runFarm(r, { manual: true }, ctx)
  assert.strictEqual(res.status, 'retry'); assert.strictEqual(r.bot.dugAt().length, 0)
  assert.ok(r.said.some(t => /creeper is near/.test(t)))
  for (let i = 0; i < 8 && res.status === 'retry'; i++) res = await runFarm(r, { manual: true }, ctx)
  assert.strictEqual(res.status, 'done')
  assert.ok(r.said.some(t => /Stopping the farm run/.test(t)))
  delete r.bot.entities.z
  assert.strictEqual((await runFarm(r, { manual: true })).status, 'done'); assert.strictEqual(r.bot.dugAt().length, 3)
})

test('a lava bucket in hand is put away before the first step', async () => {
  const r = rig(); plantCrops(r.bot, row('wheat', 7, 2))
  r.bot.give('lava_bucket', 1); await r.bot.equip(r.bot.inventory.items().find(i => i.name === 'lava_bucket'), 'hand')
  await runFarm(r, { manual: true })
  assert.deepStrictEqual(r.bot.lavaHeldWhileMoving, [])
})

test('yields to a more important task and picks up where it was: every crop harvested and replanted once', async () => {
  const r = rig()
  plantCrops(r.bot, row('wheat', 7, 10))
  const order = []
  r.bot.onDig = (n) => { if (n === 4) r.scheduler.submit({ name: 'safety', priority: PRIORITY.SAFETY, async run(ctx) { order.push(r.bot.digs); await ctx.sleep(40); order.push(r.bot.digs) } }) }
  r.submitFarm({ manual: true })
  await waitFor(() => r.state.farm.lastResult && r.state.farm.lastResult.at && !r.farm.isRunning() && r.bot.dugAt().length === 10 && r.scheduler.idle())
  assert.strictEqual(order[0], order[1], 'no dig while the high priority task ran')
  const dug = r.bot.dugAt(); assert.strictEqual(new Set(dug).size, 10)
  for (let i = 0; i < 10; i++) assert.strictEqual(ageAt(r.bot, -1070 + i, 160, 2358), 0)
})

test('Walter says stop: the harvest stops at once (task cancelled), the next run finishes it', async () => {
  const r = rig()
  plantCrops(r.bot, row('wheat', 7, 10))
  r.bot.onDig = (n) => { if (n === 3) r.scheduler.userStop() }
  r.submitFarm({ manual: true })
  await waitFor(() => r.scheduler.idle() && !r.farm.isRunning())
  assert.ok(r.bot.dugAt().length >= 3 && r.bot.dugAt().length < 10)
  assert.ok(r.nav.stops >= 1)
  r.bot.onDig = null
  await runFarm(r, { manual: true })
  assert.strictEqual(r.bot.dugAt().length, 10)
})

test('routine due(): daytime only, every 45 minutes, every 15 only when food is really low (under 8)', () => {
  let t = 1e9
  const r = rig({ now: () => t })
  assert.strictEqual(r.farm.due(), true, 'never ran')
  r.bot.give('cooked_beef', 64)
  r.state.farm.lastRun = t - 44 * 60000; assert.strictEqual(r.farm.due(), false, 'ran 44 min ago, food fine')
  r.state.farm.lastRun = t - 46 * 60000; assert.strictEqual(r.farm.due(), true, '46 min ago')
  r.state.farm.lastRun = t - 10 * 60000; assert.strictEqual(r.farm.due(), false)
  r.bot.take('cooked_beef', 64); r.bot.give('cooked_beef', 10)
  assert.strictEqual(r.farm.due(), false, 'food 10 is not low: still 45 minutes')
  r.bot.take('cooked_beef', 10); r.bot.give('cooked_beef', 5)
  r.state.farm.lastRun = t - 10 * 60000; assert.strictEqual(r.farm.due(), false, 'food low: every 15 minutes')
  r.state.farm.lastRun = t - 16 * 60000; assert.strictEqual(r.farm.due(), true)
  r.bot.take('cooked_beef', 5)
  r.state.farm.lastRun = 0; r.bot.time.timeOfDay = 13000; assert.strictEqual(r.farm.due(), false, 'night')
  r.bot.time.timeOfDay = 1000; r.bot.game.dimension = 'the_nether'; assert.strictEqual(r.farm.due(), false)
})

// ================================================================ sleep

test('night and due: walks to the nearest bed, sleeps, the night skips, lastWakeAge is updated, no ping', async () => {
  const r = rig({ night: true })
  r.bot.setBlock(...BED, 'red_bed', { part: 'head' }); r.bot.setBlock(BED[0], BED[1], BED[2] - 1, 'red_bed', { part: 'foot' })
  r.bot.setBlock(-1000, 160, 2341, 'white_bed', { part: 'head' })
  r.bot.on('wake', () => r.sleep.onWake())
  const age0 = r.bot.time.age
  const p = r.sleep.run(fakeCtx())
  await waitFor(() => r.bot.isSleeping)
  assert.deepStrictEqual(r.bot.actions.find(a => a[0] === 'sleep').slice(1), BED)
  assert.ok(r.said.some(t => /Heading to the bed at -1058, 160, 2341/.test(t))); assert.ok(r.said.includes('In bed.'))
  r.bot.nightSkips()
  const res = await p
  assert.strictEqual(res.status, 'done')
  assert.strictEqual(r.state.sleep.lastWakeAge, age0 + 12000)
  assert.ok(!r.said.some(t => /not skipped/.test(t)))
  assert.strictEqual(r.sleep.due(), false)
})

test('Walter is not in bed: pinged once after 20 s (30 ms here), after 90 s (90 ms) it gets up and returns to its work', async () => {
  const r = rig({ night: true })
  r.bot.setBlock(...BED, 'red_bed', { part: 'head' })
  const res = await r.sleep.run(fakeCtx())
  assert.strictEqual(res.status, 'done')
  assert.strictEqual(r.said.filter(t => /not skipped yet/.test(t)).length, 1)
  assert.ok(r.said.some(t => /^OGWO, it is night/.test(t)))
  assert.ok(r.said.some(t => /getting up and going back to what I was doing/.test(t)))
  assert.strictEqual(r.bot.isSleeping, false); assert.ok(r.bot.actions.some(a => a[0] === 'wake'))
  assert.strictEqual(r.state.sleep.lastResult.gaveUp, true)
  assert.strictEqual(r.state.sleep.pingedDay, Math.floor(r.bot.time.age / 24000))
})

test('after giving up: cooldown, then one more try tonight, then no more until the next night', async () => {
  const r = rig({ night: true, config: { sleep: { retryAfterGiveUpMs: 300 } } })
  r.bot.setBlock(...BED, 'red_bed', { part: 'head' })
  r.bot.on('wake', () => r.sleep.onWake())
  assert.strictEqual(r.sleep.due(), true)
  await r.sleep.run(fakeCtx())
  r.state.sleep.lastWakeAge = -1e9                    // (the wake event counts as rest; pretend it is due again to test the attempt limit)
  assert.strictEqual(r.sleep.due(), false, 'cooling down')
  await wait(350)
  assert.strictEqual(r.sleep.due(), true, 'second attempt allowed')
  await r.sleep.run(fakeCtx())
  r.state.sleep.lastWakeAge = -1e9; await wait(350)
  assert.strictEqual(r.sleep.due(), false, 'max 2 attempts per night')
  r.bot.time.age += 24000                             // next night
  assert.strictEqual(r.sleep.due(), true)
})

test('48000-tick rule: not due right after sleeping, due again after two nights', () => {
  const r = rig({ night: true })
  r.state.sleep.lastWakeAge = r.bot.time.age - 20000
  assert.strictEqual(r.sleep.due(), false)
  r.state.sleep.lastWakeAge = r.bot.time.age - 47999; assert.strictEqual(r.sleep.due(), false)
  r.state.sleep.lastWakeAge = r.bot.time.age - 48000; assert.strictEqual(r.sleep.due(), true)
  r.bot.time.timeOfDay = 6000; assert.strictEqual(r.sleep.due(), false, 'daytime')
  r.bot.time.timeOfDay = 23460; assert.strictEqual(r.sleep.due(), false, 'dawn')
  r.bot.time.timeOfDay = 12542; assert.strictEqual(r.sleep.due(), true, 'dusk')
  r.bot.game.dimension = 'the_nether'; assert.strictEqual(r.sleep.due(), false)
})

test('"sleep" in chat bypasses the 48000 rule at night, and says so in daytime', async () => {
  const r = rig({ night: true })
  r.state.sleep.lastWakeAge = r.bot.time.age - 1000
  r.bot.setBlock(...BED, 'red_bed', { part: 'head' })
  assert.strictEqual((await r.sleep.run(fakeCtx())).status, 'done'); assert.ok(!r.bot.actions.some(a => a[0] === 'sleep'), 'not due, not forced: nothing')
  const p = r.sleep.run(fakeCtx(), { force: true })
  await waitFor(() => r.bot.isSleeping); r.bot.nightSkips(); await p
  const d = rig(); d.bot.setBlock(...BED, 'red_bed', { part: 'head' })
  await d.sleep.run(fakeCtx(), { force: true })
  assert.ok(d.said.includes('It is not night yet, so I cannot sleep.')); assert.ok(!d.bot.actions.some(a => a[0] === 'sleep'))
})

test('no bed within reach: says so once per day, not every 15 seconds', async () => {
  const r = rig({ night: true })
  await r.sleep.run(fakeCtx()); await r.sleep.run(fakeCtx()); await r.sleep.run(fakeCtx())
  assert.strictEqual(r.said.filter(t => /can't find a bed/.test(t)).length, 1)
  assert.strictEqual(r.sleep.due(), false, 'waits a minute before trying again')
})

test('first bed unreachable: tries the next nearest; "monsters nearby" stops the attempt', async () => {
  const r = rig({ night: true, pos: [-1058, 160, 2380] })
  r.bot.setBlock(-1058, 160, 2341, 'red_bed', { part: 'head' }); r.bot.setBlock(-1040, 160, 2341, 'white_bed', { part: 'head' })
  r.bot.gotoFails = (goal) => goal.x === -1058
  const p = r.sleep.run(fakeCtx())
  await waitFor(() => r.bot.isSleeping)
  assert.deepStrictEqual(r.bot.actions.find(a => a[0] === 'sleep').slice(1), [-1040, 160, 2341])
  r.bot.nightSkips(); await p
  const m = rig({ night: true, pos: [-1058, 160, 2380] }); m.bot.setBlock(...BED, 'red_bed', { part: 'head' }); m.bot.setBlock(-1040, 160, 2341, 'white_bed', { part: 'head' })
  m.bot.sleepError = 'There are monsters nearby'
  await m.sleep.run(fakeCtx())
  assert.strictEqual(m.bot.actions.filter(a => a[0] === 'goto' && a[1] === 'the bed').length, 1, 'did not try the second bed')
  assert.ok(m.said.some(t => /couldn't sleep: There are monsters nearby/.test(t)))
})

test('a hostile near the bot: no bed trip', async () => {
  const r = rig({ night: true }); r.bot.setBlock(...BED, 'red_bed', { part: 'head' })
  r.bot.entities.z = { id: 1, name: 'zombie', position: r.bot.entity.position.offset(2, 0, 0) }
  await r.sleep.run(fakeCtx())
  assert.ok(!r.bot.actions.some(a => a[0] === 'goto'))
})

test('stopped or preempted while in bed: gets out of bed so it can move again', async () => {
  const r = rig({ night: true }); r.bot.setBlock(...BED, 'red_bed', { part: 'head' })
  r.submitSleep({ force: true })
  await waitFor(() => r.bot.isSleeping)
  r.scheduler.userStop()
  await waitFor(() => !r.bot.isSleeping)
  assert.ok(r.bot.actions.some(a => a[0] === 'wake'))
  const q = rig({ night: true }); q.bot.setBlock(...BED, 'red_bed', { part: 'head' })
  q.submitSleep({ force: true }); await waitFor(() => q.bot.isSleeping)
  q.scheduler.submit({ name: 'safety', priority: PRIORITY.SAFETY, async run(ctx) { await ctx.sleep(20) } })
  await waitFor(() => !q.bot.isSleeping)
})

test('a lava bucket in hand is put away before walking to the bed', async () => {
  const r = rig({ night: true }); r.bot.setBlock(...BED, 'red_bed', { part: 'head' })
  r.bot.give('lava_bucket', 1); await r.bot.equip(r.bot.inventory.items().find(i => i.name === 'lava_bucket'), 'hand')
  const p = r.sleep.run(fakeCtx()); await waitFor(() => r.bot.isSleeping); r.bot.nightSkips(); await p
  assert.deepStrictEqual(r.bot.lavaHeldWhileMoving, [])
})

// ================================================================ line of sight (survival-legit rule)

const wall = (bot, x, zs, ys = [159, 160, 161, 162, 163]) => { for (const y of ys) for (let z = zs[0]; z <= zs[1]; z++) bot.setBlock(x, y, z, 'stone') }

test('line of sight: a normal harvest, replant, store and sleep never acts through anything (the mock refuses and records it)', async () => {
  const r = rig({ night: false })
  plantCrops(r.bot, [...row('wheat', 7, 6), ...row('carrots', 7, 6, -1070, 2359)])
  await runFarm(r, { manual: true })
  assert.deepStrictEqual(r.bot.losViolations, [])
  assert.strictEqual(r.bot.dugAt().length, 12)
  const n = rig({ night: true }); n.bot.setBlock(...BED, 'red_bed', { part: 'head' })
  const p = n.sleep.run(fakeCtx()); await waitFor(() => n.bot.isSleeping); n.bot.nightSkips(); await p
  assert.deepStrictEqual(n.bot.losViolations, [])
})

test('a crop behind a wall is not harvested from the wrong side; the rest of the field is', async () => {
  const r = rig()
  plantCrops(r.bot, [...row('wheat', 7, 3), ...row('wheat', 7, 3, -1070, 2350)])
  wall(r.bot, -1072, [2347, 2353])                    // between the bot's arrival spot and the z=2350 row
  r.bot.arriveAt = (goal, label) => (label === 'a crop' && goal.z === 2350 ? new Vec3(-1074.5, 160, goal.z + 0.5) : null)
  await runFarm(r, { manual: true })
  assert.deepStrictEqual(r.bot.losViolations, [])
  assert.strictEqual(r.bot.dugAt().length, 3, 'only the visible row')
  for (let i = 0; i < 3; i++) assert.strictEqual(ageAt(r.bot, -1070 + i, 160, 2350), 7, 'hidden crop untouched')
  assert.ok(r.said.some(t => /3 crop\(s\) had no clear line/.test(t)), r.said.join(' | '))
})

test('with the pathfinder look-at goal the farmer walks round the wall and harvests the crop', async () => {
  const r = rig(); r.bot.enableLookAt()
  plantCrops(r.bot, row('wheat', 7, 3, -1070, 2350))
  wall(r.bot, -1072, [2347, 2353])
  r.bot.arriveAt = (goal, label) => (label === 'a crop' && goal.z === 2350 ? new Vec3(-1074.5, 160, goal.z + 0.5) : null)
  await runFarm(r, { manual: true })
  assert.deepStrictEqual(r.bot.losViolations, [])
  assert.strictEqual(r.bot.dugAt().length, 3)
})

test('the house chest behind a wall is not opened: the crops stay in the bag and Walter is told', async () => {
  const r = rig()
  plantCrops(r.bot, row('wheat', 7, 4))
  wall(r.bot, -1065, [2324, 2328], [159, 160, 161, 162, 163])
  r.bot.arriveAt = (goal, label) => (label === 'the house chest' ? new Vec3(-1067.5, 160, 2326.5) : null)
  await runFarm(r, { manual: true })
  assert.deepStrictEqual(r.bot.losViolations, [])
  assert.ok(!r.bot.actions.some(a => a[0] === 'open'), 'chest never opened')
  assert.ok(r.said.some(t => /clear line to the house chest/.test(t)))
  assert.strictEqual(inChest(r).wheat, undefined)
})

test('a bed behind a wall is not used; the next bed is', async () => {
  const r = rig({ night: true, pos: [-1058, 160, 2380] })
  r.bot.setBlock(...BED, 'red_bed', { part: 'head' }); r.bot.setBlock(-1040, 160, 2341, 'white_bed', { part: 'head' })
  wall(r.bot, -1060, [2339, 2343])
  r.bot.arriveAt = (goal) => (goal.x === -1058 ? new Vec3(-1062.5, 160, 2341.5) : null)
  const p = r.sleep.run(fakeCtx())
  await waitFor(() => r.bot.isSleeping)
  assert.deepStrictEqual(r.bot.actions.find(a => a[0] === 'sleep').slice(1), [-1040, 160, 2341])
  r.bot.nightSkips(); await p
  assert.deepStrictEqual(r.bot.losViolations, [])
})

test('a replant is refused when there is no clear line to the farmland (pending, nothing placed)', async () => {
  const r = rig()
  r.bot.setBlock(-1070, 159, 2358, 'farmland')
  r.bot.give('wheat_seeds', 5)
  r.state.farm.pending = [{ x: -1070, y: 160, z: 2358, crop: 'wheat' }]
  wall(r.bot, -1072, [2355, 2361])
  r.bot.arriveAt = (goal, label) => (label === 'a crop' ? new Vec3(-1074.5, 160, 2358.5) : null)
  await runFarm(r, { manual: false })
  assert.deepStrictEqual(r.bot.losViolations, [])
  assert.strictEqual(placed(r.bot).length, 0)
  assert.strictEqual(r.state.farm.pending.length, 1, 'still pending')
})

// ================================================================ sugar cane

test('sugar cane: only stalks of 3 or more are cut, at the second block, so the bottom block stays and keeps growing; the drops are collected and stored', async () => {
  const r = rig()
  plantCane(r.bot, [1, 2, 3, 4, 5].map((h, i) => ({ x: -1070 + i, z: 2350, h })))
  await runFarm(r, { manual: true })
  const topOf = (x) => { let y = 160; while (blockName(r.bot, x, y, 2350) === 'sugar_cane') y++; return y - 160 }
  assert.deepStrictEqual([0, 1, 2, 3, 4].map(i => topOf(-1070 + i)), [1, 2, 1, 1, 1], 'tall stalks are down to their bottom block, short ones untouched')
  assert.deepStrictEqual(r.bot.dugAt().sort(), ['-1066,161,2350', '-1067,161,2350', '-1068,161,2350'], 'only the second block of each tall stalk was broken')
  assert.strictEqual(inChest(r).sugar_cane, 2 + 3 + 4, 'every dropped cane block was picked up and stored')
  assert.strictEqual(r.bot.count('sugar_cane'), 0)
  assert.ok(r.said.some(t => /Cut 9 sugar cane \(the bottom block of each stalk stays\)/.test(t)), r.said.join(' | '))
  assert.deepStrictEqual(r.bot.losViolations, [])
  assert.strictEqual(r.state.farm.pending.length, 0)
})

test('sugar cane: the threshold is configurable (2 = cut anything above the bottom block); the floor under it and the water are never touched', async () => {
  const r = rig({ config: { farm: { caneMinHeight: 2 } } })
  plantCane(r.bot, [{ x: -1070, z: 2350, h: 2 }, { x: -1069, z: 2350, h: 1 }])
  r.bot.setBlock(-1071, 159, 2350, 'water')
  await runFarm(r, { manual: true })
  assert.strictEqual(blockName(r.bot, -1070, 160, 2350), 'sugar_cane'); assert.strictEqual(blockName(r.bot, -1070, 161, 2350), 'air')
  assert.strictEqual(blockName(r.bot, -1069, 160, 2350), 'sugar_cane')
  assert.strictEqual(blockName(r.bot, -1070, 159, 2350), 'sand'); assert.strictEqual(blockName(r.bot, -1071, 159, 2350), 'water')
  assert.strictEqual(r.bot.dugAt().length, 1)
})

test('sugar cane behind a wall is not cut from the wrong side; ripe crops in the same run still are', async () => {
  const r = rig()
  plantCrops(r.bot, row('wheat', 7, 3))
  plantCane(r.bot, [{ x: -1070, z: 2350, h: 4 }])
  wall(r.bot, -1072, [2347, 2353])
  r.bot.arriveAt = (goal, label) => (label === 'sugar cane' ? new Vec3(-1074.5, 160, 2350.5) : null)
  await runFarm(r, { manual: true })
  assert.deepStrictEqual(r.bot.losViolations, [])
  assert.strictEqual(blockName(r.bot, -1070, 161, 2350), 'sugar_cane', 'not cut')
  assert.strictEqual(r.bot.dugAt().length, 3, 'the three wheat')
  assert.ok(r.said.some(t => /1 crop\(s\) had no clear line/.test(t)), r.said.join(' | '))
})

test('sugar cane sites: waypoints with "cane" or "sugar" in the name count as places to work, next to the farms', () => {
  const { phrases } = require('../brain/routines')
  assert.ok(new RegExp(require('../brain/routines/config.json').farm.sitePattern, 'i').test('sugar cane field'))
  assert.ok(new RegExp(require('../brain/routines/config.json').farm.sitePattern, 'i').test('home farm'))
  assert.ok(!new RegExp(require('../brain/routines/config.json').farm.sitePattern, 'i').test('crafting table'))
})

// ================================================================ bamboo

const BAMBOO_CELLS = [[-1060, 160, 2364], [-1059, 160, 2364], [-1058, 160, 2364], [-1060, 160, 2365], [-1059, 160, 2365], [-1058, 160, 2365], [-1060, 160, 2366], [-1059, 160, 2366]]
const NOANCHOR = { farm: { bamboo: { ...baseConfig.farm.bamboo, anchor: null } } }          // the old "pick a spot yourself" behaviour
const saplings = (r) => r.bot.actions.filter(a => a[0] === 'place' && a[1] === 'bamboo')

test('bamboo: no patch yet and bamboo in the bag -> 8 stalks are planted on free grass near the farm, away from farmland and crops, each with a clear line', async () => {
  const r = rig({ config: NOANCHOR }); grass(r.bot); plantCrops(r.bot, row('wheat', 3, 4, -1070, 2358))
  r.bot.give('bamboo', 10)
  await runFarm(r, { manual: true })
  const p = saplings(r)
  assert.strictEqual(p.length, 8, 'the configured number of stalks')
  for (const [, , x, y, z] of p) {
    assert.strictEqual(blockName(r.bot, x, y, z), 'bamboo_sapling'); assert.strictEqual(blockName(r.bot, x, y - 1, z), 'grass_block', 'dirt-like floor')
    assert.ok(Math.hypot(x - SITE.x, z - SITE.z) <= 13, 'near the crop farm')
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) assert.notStrictEqual(blockName(r.bot, x + dx, y - 1, z + dz), 'farmland', 'not next to farmland')
  }
  assert.strictEqual(r.state.farm.bamboo.cells.length, 8); assert.strictEqual(r.state.farm.bamboo.site, 'home farm')
  assert.strictEqual(r.bot.count('bamboo'), 2)
  assert.deepStrictEqual(r.bot.losViolations, [])
  const before = placed(r.bot).length
  await runFarm(r, { manual: true })
  assert.strictEqual(placed(r.bot).length, before, 'nothing missing, nothing planted again')
})

test('bamboo: stalks of 4 or more are cut at the second block (base stays), with a sword or axe in hand; the bamboo is kept for planting (4) and the rest stored', async () => {
  const r = rig(); grass(r.bot)
  r.bot.give('stone_axe', 1)
  plantBamboo(r.bot, BAMBOO_CELLS.map(([x, y, z], i) => ({ x, z, h: [2, 3, 4, 5, 6, 3, 8, 1][i] })))
  r.state.farm.bamboo = { cells: BAMBOO_CELLS, site: 'home farm' }
  await runFarm(r, { manual: true })
  const h = (x, z) => { let n = 0; while (blockName(r.bot, x, 160 + n, z) === 'bamboo') n++; return n }
  assert.deepStrictEqual(BAMBOO_CELLS.map(([x, , z]) => h(x, z)), [2, 3, 1, 1, 1, 3, 1, 1], 'tall stalks are cut down to the base, short ones left')
  assert.strictEqual(r.bot.heldWhenDug, 'stone_axe', 'the right tool was in hand')
  const cut = (4 - 1) + (5 - 1) + (6 - 1) + (8 - 1)
  assert.strictEqual(r.bot.count('bamboo') + (inChest(r).bamboo || 0), cut)
  assert.strictEqual(r.bot.count('bamboo'), 4, 'planting stock stays in the bag'); assert.strictEqual(inChest(r).bamboo, cut - 4)
  assert.ok(r.said.some(t => /Cut 19 bamboo/.test(t) || /bamboo/.test(t)), r.said.join(' | '))
  assert.deepStrictEqual(r.bot.losViolations, [])
})

test('bamboo: only the patch is touched: wild bamboo nearby is left alone; a missing stalk is replanted from the bag', async () => {
  const r = rig(); grass(r.bot)
  plantBamboo(r.bot, [{ x: -1065, z: 2364, h: 9 }])                                  // wild bamboo, not in the patch
  plantBamboo(r.bot, BAMBOO_CELLS.slice(0, 7).map(([x, y, z]) => ({ x, z, h: 5 })))
  r.state.farm.bamboo = { cells: BAMBOO_CELLS, site: 'home farm' }                    // the 8th cell is empty
  r.bot.give('bamboo', 3)
  await runFarm(r, { manual: true })
  assert.strictEqual(blockName(r.bot, -1065, 168, 2364), 'bamboo', 'wild bamboo untouched (all nine blocks)'); assert.strictEqual(blockName(r.bot, -1065, 161, 2364), 'bamboo')
  assert.strictEqual(blockName(r.bot, -1059, 160, 2366), 'bamboo_sapling', 'the missing one was planted')
  assert.strictEqual(saplings(r).length, 1)
})

test('bamboo: nothing to plant with -> asked for once per day, not every run; bamboo in the house chest is taken and planted', async () => {
  const r = rig({ config: NOANCHOR }); grass(r.bot)
  await runFarm(r, { manual: true }); await runFarm(r, { manual: true })
  assert.strictEqual(r.said.filter(t => /no bamboo to plant/.test(t)).length, 1)
  r.bot.addChest(...HOUSE_CHEST, 54, { bamboo: 12 })
  await runFarm(r, { manual: true })
  assert.strictEqual(saplings(r).length, 8)
  assert.ok(r.bot.actions.some(a => a[0] === 'withdraw' && a[1] === 'bamboo'))
})

test('bamboo: no free dirt or grass near the farm -> says so once and plants nothing', async () => {
  const r = rig({ config: NOANCHOR }); r.bot.give('bamboo', 10)
  await runFarm(r, { manual: true }); await runFarm(r, { manual: true })
  assert.strictEqual(saplings(r).length, 0)
  assert.strictEqual(r.said.filter(t => /no free dirt or grass/.test(t)).length, 1)
})

test('bamboo behind a wall is not cut from the wrong side', async () => {
  const r = rig(); grass(r.bot)
  plantBamboo(r.bot, [{ x: -1060, z: 2364, h: 6 }]); r.state.farm.bamboo = { cells: [[-1060, 160, 2364]], site: 'home farm' }
  wall(r.bot, -1062, [2361, 2367])
  r.bot.arriveAt = (goal, label) => (label === 'the bamboo' ? new Vec3(-1064.5, 160, 2364.5) : null)
  await runFarm(r, { manual: true })
  assert.deepStrictEqual(r.bot.losViolations, [])
  assert.strictEqual(blockName(r.bot, -1060, 161, 2364), 'bamboo')
})

// Walter planted a patch himself at his spot (-1066, 160, 2321): it is registered in the config, found again on every run, never replaced, never asked about
const WALTER = [-1066, 160, 2321]
const walterPatch = (bot, hs = [1, 3, 5, 6, 8, 4, 2, 7]) => plantBamboo(bot, hs.map((h, i) => ({ x: -1068 + (i % 4), z: 2320 + Math.floor(i / 4), h })))

test('Walter\'s bamboo patch: found around his spot, nothing is planted or asked for, tall stalks are cut with an AXE (not the sword) and the bottom stalk stays', async () => {
  const r = rig(); grass(r.bot, { x0: -1070, x1: -1064, z0: 2318, z1: 2323 }); walterPatch(r.bot)
  r.bot.give('stone_sword', 1); r.bot.give('stone_axe', 1)
  await runFarm(r, { manual: true })
  const st = r.state.farm.bamboo
  assert.strictEqual(st.cells.length, 8); assert.strictEqual(st.fixed, true); assert.deepStrictEqual(st.anchor, WALTER)
  assert.strictEqual(saplings(r).length, 0, 'nothing planted'); assert.ok(!r.said.some(t => /no bamboo to plant|free dirt or grass/.test(t)), 'no asking')
  const h = (x, z) => { let n = 0; while (blockName(r.bot, x, 160 + n, z) === 'bamboo') n++; return n }
  const hs = [1, 3, 5, 6, 8, 4, 2, 7].map((hh, i) => h(-1068 + (i % 4), 2320 + Math.floor(i / 4)))
  assert.deepStrictEqual(hs, [1, 3, 1, 1, 1, 1, 2, 1], 'stalks of 4+ are down to their base, shorter ones untouched')
  assert.strictEqual(r.bot.heldWhenDug, 'stone_axe')
  assert.strictEqual(r.bot.count('bamboo') + (inChest(r).bamboo || 0), (5 - 1) + (6 - 1) + (8 - 1) + (4 - 1) + (7 - 1))
  assert.deepStrictEqual(r.bot.losViolations, [])
})

test('Walter\'s bamboo patch: shoots he adds later are taken in on the next run; a far patch is walked to; one that cannot be reached is reported', async () => {
  const r = rig({ pos: [-1000, 160, 2400] }); grass(r.bot, { x0: -1070, x1: -1060, z0: 2316, z1: 2325 })
  plantBamboo(r.bot, [{ x: -1068, z: 2320, h: 2 }])
  await runFarm(r, { manual: true })
  assert.strictEqual(r.state.farm.bamboo.cells.length, 1)
  assert.ok(r.bot.actions.some(a => a[0] === 'goto' && a[1] === 'the bamboo patch'), 'walked to the patch')
  plantBamboo(r.bot, [{ x: -1067, z: 2320, h: 5 }])
  await runFarm(r, { manual: true })
  assert.strictEqual(r.state.farm.bamboo.cells.length, 2); assert.strictEqual(blockName(r.bot, -1067, 161, 2320), 'air', 'the new stalk was cut too')
  const u = rig({ pos: [-1000, 160, 2400] }); u.bot.gotoFails = (g, l) => l === 'the bamboo patch'
  await runFarm(u, { manual: true })
  assert.ok(u.said.some(t => /could not walk to: bamboo patch/.test(t)), u.said.join(' | '))
})

test('Walter\'s bamboo patch: a gap is replanted from the bag when there is bamboo, silently; with none, nothing happens and nobody is asked', async () => {
  const r = rig(); grass(r.bot, { x0: -1070, x1: -1064, z0: 2318, z1: 2323 }); walterPatch(r.bot)
  await runFarm(r, { manual: true })
  r.bot.take('bamboo', r.bot.count('bamboo')); r.bot.addChest(...HOUSE_CHEST, 54, {})        // no bamboo left in the bag or in the chest
  r.bot.setBlock(-1068, 160, 2320, 'air')                 // a stalk is gone (base too)
  r.said.length = 0
  await runFarm(r, { manual: true })
  assert.strictEqual(saplings(r).length, 0); assert.deepStrictEqual(r.said.filter(t => /bamboo/i.test(t)), [], 'no bamboo in the bag: nothing said')
  r.bot.give('bamboo', 3)
  await runFarm(r, { manual: true })
  assert.strictEqual(saplings(r).length, 1); assert.strictEqual(blockName(r.bot, -1068, 160, 2320), 'bamboo_sapling')
})

test('chat "bamboo patch at x y z" registers a patch at once (live), "bamboo patch" without numbers asks for them', async () => {
  const r = rig({ config: NOANCHOR }); grass(r.bot, { x0: -1070, x1: -1064, z0: 2318, z1: 2323 }); walterPatch(r.bot)
  const { brain } = attachBrain(r)
  brain.route('OGWO', 'bamboo patch', { handleCommand: () => false })
  assert.ok(r.said.some(t => /Tell me where: "bamboo patch at/.test(t)))
  brain.route('OGWO', 'the bamboo patch is at -1066 160 2321', { handleCommand: () => false })
  assert.ok(r.said.some(t => /look after the bamboo patch at -1066, 160, 2321/.test(t)))
  const mod = brain.api && brain.status().modules.routines
  assert.ok(mod)
  brain.stop()
})

// ================================================================ work-site chest (time-economy rule)

const craftChest = (r, c) => ({ dispatch: (text) => { if (/chest/.test(text)) { r.bot.give('chest', 1); c.n++; return true } return false }, busy: () => false })
const fillBag = (bot, leave) => { for (let i = 0; bot.inventory.emptySlotCount() > leave; i++) bot.give('bone', 64) }
const WSROW = row('wheat', 7, 6, -1070, 2358)

test('work site (farm): the bag fills mid-run -> a chest next to the field against its wall, the crops go in there, ONE haul to the house chest at the end, chest picked up', async () => {
  const c = { n: 0 }
  const r = rig({ craft: { dispatch: (text) => { if (/chest/.test(text)) { r.bot.give('chest', 1); c.n++; return true } return false }, busy: () => false } })
  ground(r.bot); plantCrops(r.bot, WSROW)
  r.bot.give('wheat', 128); fillBag(r.bot, 2)
  await runFarm(r, { manual: true })
  assert.strictEqual(c.n, 1, 'one chest crafted through the crafting module')
  const pc = placed(r.bot).filter(a => a[1] === 'chest')
  assert.strictEqual(pc.length, 1)
  const [, , cx, cy, cz] = pc[0]
  assert.ok(Math.hypot(cx - SITE.x, cz - SITE.z) <= 12.5, 'next to the field')
  assert.ok([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => r.bot.blockAt(new Vec3(cx + dx, cy, cz + dz)).name === 'stone'), 'against a wall')
  assert.notStrictEqual(blockName(r.bot, cx, cy - 1, cz), 'farmland')
  const opens = r.bot.actions.filter(a => a[0] === 'open').map(a => a[1])
  assert.strictEqual(opens[0], `${cx},${cy},${cz}`, 'the first container opened was the work-site chest, not the far house chest')
  assert.ok(inChest(r).wheat >= 128, 'the haul ended in the house chest')
  assert.ok(!r.state.farm.worksite, 'ledger cleared'); assert.strictEqual(blockName(r.bot, cx, cy, cz), 'air', 'chest picked up'); assert.ok(r.bot.count('chest') >= 1)
  for (let i = 0; i < 6; i++) assert.strictEqual(ageAt(r.bot, -1070 + i, 160, 2358), 0, 'replanted')
  assert.deepStrictEqual(r.bot.losViolations, [])
})

test('work site (farm): no chest and nothing to craft one with -> the house chest directly, as before', async () => {
  const r = rig()
  ground(r.bot); plantCrops(r.bot, WSROW)
  r.bot.give('wheat', 128); fillBag(r.bot, 2)
  await runFarm(r, { manual: true })
  assert.ok(!placed(r.bot).some(a => a[1] === 'chest')); assert.ok(inChest(r).wheat >= 128)
  assert.ok(!r.state.farm.worksite)
})

test('work site (farm): a restart with stuff still in the work-site chest: the next run hauls it and picks the chest up', async () => {
  const r = rig({})
  ground(r.bot)
  r.bot.addChest(-1073, 160, 2360, 27, { wheat: 100, carrot: 40 })
  r.state.farm.worksite = { pos: [-1073, 160, 2360], items: { wheat: 100, carrot: 40 }, slots: 27, used: 2, hauledUsed: 0 }
  await runFarm(r, { manual: true })
  assert.ok(inChest(r).wheat >= 100); assert.ok(!r.state.farm.worksite); assert.strictEqual(blockName(r.bot, -1073, 160, 2360), 'air')
})

test('work site (farm): only the chest from the ledger is touched; the house chest is not mistaken for it', async () => {
  const r = rig({})
  ground(r.bot)
  r.state.farm.worksite = { pos: [-1073, 160, 2360], items: { wheat: 5 }, slots: 27, used: 1 }       // our chest is gone
  await runFarm(r, { manual: true })
  assert.ok(!r.state.farm.worksite, 'stale ledger dropped')
  assert.ok(!r.bot.dugAt().includes('-1064,160,2326'))
})

test('the two copies of the shared helpers (brain/excavation and brain/routines) are identical', () => {
  for (const f of ['los.js', 'worksite.js']) assert.strictEqual(fs.readFileSync(path.join(__dirname, '..', 'brain', 'excavation', f), 'utf8'), fs.readFileSync(path.join(__dirname, '..', 'brain', 'routines', f), 'utf8'), f)
})

// ================================================================ state and the module

test('state: imports the driver files once (farm flag, last farm run, last wake, last ping), never writes them', () => {
  const r = rig({ legacy: { 'routine-state.json': { farm: true, lastFarmRun: 1792974696220 }, 'sleep-state.json': { lastWakeAge: 2457340, pingedDay: 102 } } })
  assert.strictEqual(r.state.farm.enabled, true); assert.strictEqual(r.state.farm.lastRun, 1792974696220)
  assert.strictEqual(r.state.sleep.lastWakeAge, 2457340); assert.strictEqual(r.state.sleep.pingedDay, 102)
  assert.strictEqual(r.state.importedFrom.length, 2)
  const before = fs.readFileSync(r.legacySleepFile, 'utf8')
  r.state.sleep.lastWakeAge = 5; r.save()
  const again = stateStore.load({ file: r.file, legacyRoutineFile: r.legacyRoutineFile, legacySleepFile: r.legacySleepFile })
  assert.strictEqual(again.sleep.lastWakeAge, 5, 'own file wins afterwards')
  assert.strictEqual(fs.readFileSync(r.legacySleepFile, 'utf8'), before)
})

test('state: missing or corrupt files never throw', () => {
  const r = rig()
  assert.strictEqual(r.state.farm.enabled, false); assert.strictEqual(r.state.sleep.lastWakeAge, -1e9)
  fs.writeFileSync(r.file, '{oops'); fs.writeFileSync(r.legacySleepFile, JSON.stringify({ lastWakeAge: 7 }))
  assert.strictEqual(stateStore.load({ file: r.file, legacyRoutineFile: r.legacyRoutineFile, legacySleepFile: r.legacySleepFile }).sleep.lastWakeAge, 7)
})

const attachBrain = (r, extra = {}) => {
  const attach = require('../brain')
  const legacyCalls = []
  const brain = attach({
    bot: r.bot, say: (t) => r.said.push(t), goals: r.bot.goals, tryGoto: r.bot.tryGoto, stopNav() {}, navigateRaw() {}, navActive: () => false, handleCommand: () => false,
    farm: { isBusy: () => false, stop() {}, async harvest() { legacyCalls.push('harvest') }, async storeCrops() { legacyCalls.push('store') } },
    excavation: { isRunning: () => false, stop() {} }, routines: { farm: false, lastFarmRun: 0 }, saveRoutines() {},
    jobs: { async bedRoutine() { legacyCalls.push('bed') } }, dir: r.dir, stateDir: path.join(r.dir, 'state'), idleAfterMs: 30,
    moduleEntries: [{ name: 'routines', path: path.join(__dirname, '..', 'brain', 'routines', 'index.js') }], ...extra
  })
  return { brain, legacyCalls }
}

test('module: loads next to the integrator, replaces its farm/sleep routines, shows in status, imports the driver state', async () => {
  const r = rig({ legacy: { 'routine-state.json': { farm: true, lastFarmRun: 0 }, 'sleep-state.json': { lastWakeAge: 99, pingedDay: 3 } } })
  const { brain } = attachBrain(r)
  const st = brain.status()
  assert.ok(st.modules.routines && st.modules.routines.farm && st.modules.routines.sleep)
  assert.strictEqual(st.modules.routines.farm.enabled, true)
  assert.deepStrictEqual(brain.scheduler.status().routines.map(x => x.name).sort(), ['farm', 'furnace', 'sleep'])
  assert.ok(brain.api.commands.list().some(c => c.name === 'farm-routine-on'))
  assert.ok(!st.logTail.some(l => /BRAIN_MODULE_ERROR/.test(l)))
  assert.ok(fs.existsSync(path.join(r.dir, 'state', 'routines-state.json')))
  brain.stop()
})

test('module: chat "harvest" and "sleep" run our code, not the driver\'s legacy farm.js / bedRoutine', async () => {
  const r = rig({ night: false })
  plantCrops(r.bot, row('wheat', 7, 3))
  const { brain, legacyCalls } = attachBrain(r)
  assert.strictEqual(brain.route('OGWO', 'hey please harvest the crops', { handleCommand: () => false }), true)
  await waitFor(() => r.bot.dugAt().length === 3)
  await waitFor(() => r.said.some(t => /Harvest done/.test(t)))
  assert.deepStrictEqual(legacyCalls, [])
  r.bot.time.timeOfDay = 14000; r.bot.setBlock(...BED, 'red_bed', { part: 'head' })
  brain.route('OGWO', 'sleep', { handleCommand: () => false })
  await waitFor(() => r.bot.isSleeping); r.bot.nightSkips()
  await waitFor(() => brain.scheduler.idle())
  assert.deepStrictEqual(legacyCalls, [])
  brain.route('OGWO', 'stop the farm routine', { handleCommand: () => false })
  brain.stop()
})

test('module: farm routine on/off/status in chat, state saved in our file', async () => {
  const r = rig()
  const { brain } = attachBrain(r)
  brain.route('OGWO', 'farm routine on', { handleCommand: () => false })
  assert.ok(r.said.some(t => /^Farm routine on/.test(t)))
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(r.dir, 'state', 'routines-state.json'), 'utf8')).farm.enabled, true)
  assert.strictEqual(brain.scheduler.isEnabled('farm'), true)
  brain.route('OGWO', 'farm status', { handleCommand: () => false })
  assert.ok(r.said.some(t => /Farm routine is ON/.test(t) && /home farm/.test(t)))
  brain.route('OGWO', 'turn off the farm routine', { handleCommand: () => false })
  assert.strictEqual(brain.scheduler.isEnabled('farm'), false)
  brain.route('OGWO', 'sleep status', { handleCommand: () => false })
  assert.ok(r.said.some(t => /sleep/i.test(t) && /(due|Next sleep|no record)/.test(t)))
  brain.stop()
})

test('module: with the routine on, an idle bot harvests by itself (and not when the routine is off)', async () => {
  const r = rig({ legacy: { 'routine-state.json': { farm: true, lastFarmRun: 0 } } })
  plantCrops(r.bot, row('wheat', 7, 3))
  const { brain } = attachBrain(r)
  await waitFor(() => r.bot.dugAt().length === 3, 3500)
  brain.stop()
  const off = rig(); plantCrops(off.bot, row('wheat', 7, 3))
  const b2 = attachBrain(off)
  await wait(1300)
  assert.strictEqual(off.bot.dugAt().length, 0)
  b2.brain.stop()
})

test('module: at night, due, the sleep routine goes to bed by itself; the "wake" event keeps the clock', async () => {
  const r = rig({ night: true, legacy: { 'sleep-state.json': { lastWakeAge: -1e9, pingedDay: -99 } } })
  r.bot.setBlock(...BED, 'red_bed', { part: 'head' })
  const { brain } = attachBrain(r)
  await waitFor(() => r.bot.isSleeping, 3500)
  const age = r.bot.time.age
  r.bot.nightSkips()
  await waitFor(() => brain.scheduler.idle())
  assert.strictEqual(brain.api.status.all().modules.routines.sleep.ticksSinceWake, r.bot.time.age - (age + 12000))
  brain.stop()
})

test('module: chat phrases', () => {
  const { phrases: P } = require('../brain/routines')
  const yes = { FARM_RUN: ['harvest', 'harvest the crops', 'get some food', 'gather crops', 'pick the crops', 'farm the crops'], STORE: ['store the crops', 'store food', 'store the harvest'],
    FARM_ON: ['farm routine on', 'start the farm routine', 'turn on the farm routine', 'enable farm routine'], FARM_OFF: ['farm routine off', 'stop the farm routine', 'disable the farm routine', 'turn off the farm routine'],
    FARM_STATUS: ['farm status', 'farm report', 'how is the farm', 'how are the crops', 'farm routine status'], SLEEP_NOW: ['sleep', 'go to bed', 'time for bed', "let's sleep", 'go sleep'],
    SLEEP_STATUS: ['sleep status', 'bed schedule', 'when do you sleep next', 'when will we sleep'] }
  for (const [k, list] of Object.entries(yes)) for (const t of list) assert.ok(P[k].test(t), `${k}: ${t}`)
  for (const t of ['hello', 'excavate', 'walk to me', 'where are you', 'sleeping beauty']) for (const k of ['FARM_RUN', 'FARM_ON', 'FARM_OFF', 'SLEEP_NOW']) assert.ok(!P[k].test(t), `${k} must not match "${t}"`)
})

test('module: negations and stops are not treated as commands by our chat hook', async () => {
  const r = rig({ night: true }); r.bot.setBlock(...BED, 'red_bed', { part: 'head' }); plantCrops(r.bot, row('wheat', 7, 2))
  const { brain } = attachBrain(r)
  for (const t of ["don't harvest", 'do not sleep', 'no more sleeping', 'never go to bed']) brain.route('OGWO', t, { handleCommand: () => false })
  await wait(50)
  assert.strictEqual(r.bot.dugAt().length, 0); assert.ok(!r.bot.actions.some(a => a[0] === 'sleep'))
  brain.stop()
})
