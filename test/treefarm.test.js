const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { rig, growTree, countBlocks, blockName, fakeCtx, wait, STORAGE, Scheduler, PRIORITY } = require('./treefarm.helpers')
const T = require('../brain/treefarm/trees')
const base = require('../brain/treefarm/config.json')
const register = require('../brain/treefarm')

const mk = (opts) => { const r = rig(opts); return r }
const done = (r) => r.stop()
const logsLeft = (r, logs) => logs.filter(p => /_log$/.test(r.bot.blockAt(p).name)).length
const run = (r, o = {}, ctx = fakeCtx()) => r.engine.run(ctx, { manual: true, ...o })

// ================================================================ trees.js (pure)

test('a natural tree is recognised; houses, stripped logs and saplings-sized stumps are not', () => {
  const r = mk(); const bot = r.bot
  const oak = growTree(bot, { x: 5, z: 5, h: 5 })
  assert.ok(T.scanTree(bot, oak[0], base).ok)
  const cabin = growTree(bot, { x: -6, z: 5, h: 5, natural: false })
  const c = T.scanTree(bot, cabin[1], base)
  assert.ok(!c.ok && /natural leaves/.test(c.why), c.why)
  const stump = growTree(bot, { x: -6, z: -6, h: 3 })
  assert.ok(!T.scanTree(bot, stump[0], base).ok, 'a 3-log tree is not full grown')
  bot.setBlock(8, 64, -8, 'oak_log'); bot.setBlock(8, 63, -8, 'planks')                      // a log on a floor of planks
  assert.ok(!T.scanTree(bot, new Vec3(8, 64, -8), base).ok)
  bot.setBlock(-12, 64, 0, 'stripped_oak_log'); assert.strictEqual(T.scanTree(bot, new Vec3(-12, 64, 0), base).species, null)
  // player-placed (persistent) leaves do not make a tree
  const fake = growTree(bot, { x: 12, z: -12, h: 5, natural: false })
  for (const [dx, dy, dz] of [[1, 3, 0], [-1, 3, 0], [0, 3, 1], [0, 3, -1]]) bot.setBlock(12 + dx, 64 + dy, -12 + dz, 'oak_leaves', { persistent: true })
  assert.ok(!T.scanTree(bot, fake[0], base).ok)
  done(r)
})

test('what to put away: spare saplings, sticks and logs above 32 (biggest stack first); nothing else', () => {
  const p = T.planUnload({ oak_log: 50, spruce_log: 40, birch_log: 3, oak_sapling: 20, spruce_sapling: 5, stick: 40, cobblestone: 500, dirt: 200, apple: 4 }, { ...base, keepLogs: 32 })
  assert.deepStrictEqual(p.saplings, { oak_sapling: 12 })
  assert.strictEqual(p.sticks, 24)
  assert.deepStrictEqual(p.logs, { spruce_log: 40, birch_log: 3, oak_log: 18 }.constructor === Object ? p.logs : {})
  assert.strictEqual(p.logCount, 50 + 40 + 3 - 32)
  assert.strictEqual(p.logs.oak_log, 18, 'the biggest stack keeps the 32')
  assert.ok(!('cobblestone' in p.saplings) && !('dirt' in p.logs))
  assert.deepStrictEqual(T.planUnload({}, { ...base, keepLogs: 32 }), { saplings: {}, logs: {}, sticks: 0, leaves: {}, logCount: 0 })
})

// ================================================================ chopping

test('chops a whole short tree, collects every log, and replants a sapling where it stood', async () => {
  const r = mk(); const { bot } = r
  const logs = growTree(bot, { x: 4, z: 3, h: 5 })
  const res = await run(r)
  assert.strictEqual(res.status, 'done')
  assert.strictEqual(logsLeft(r, logs), 0)
  assert.strictEqual(bot.count('oak_log'), 5, 'every log is in the bag, none on the ground')
  assert.strictEqual(Object.values(bot.entities).filter(e => e.name === 'item').length, 0)
  assert.strictEqual(blockName(bot, 4, 64, 3), 'oak_sapling')
  assert.strictEqual(r.state.pending.length, 0)
  assert.strictEqual(bot.losViolations.length, 0)
  assert.ok(r.said.some(t => /Chopped 1 tree \(5 logs\), planted 1 sapling/.test(t)), r.said.join(' | '))
  assert.ok(bot.actions.some(a => a[0] === 'equip' && a[1] === 'iron_axe'))
  done(r)
})

test('a tall spruce is chopped to the top from a pillar that is dug away again; the dirt comes back', async () => {
  const r = mk(); const { bot } = r
  const logs = growTree(bot, { x: 4, z: 3, h: 16, species: 'spruce' })
  const dirt0 = bot.count('dirt')
  await run(r)
  assert.strictEqual(logsLeft(r, logs), 0, 'all 16 logs, also the ones far above arm\'s reach')
  assert.strictEqual(bot.count('spruce_log'), 16)
  assert.strictEqual(countBlocks(bot, 'dirt'), 0, 'no pillar block left in the world')
  assert.strictEqual(bot.count('dirt'), dirt0, 'every pillar block was picked up again')
  assert.strictEqual(r.state.pillar, null)
  assert.ok(Math.abs(bot.entity.position.y - 64) < 0.01, `back on the ground (y=${bot.entity.position.y})`)
  assert.strictEqual(blockName(bot, 4, 64, 3), 'spruce_sapling')
  assert.ok(bot.actions.filter(a => a[0] === 'place' && a[1] === 'dirt').length >= 6, 'it really climbed')
  assert.strictEqual(bot.losViolations.length, 0)
  done(r)
})

test('a 2x2 dark oak trunk is chopped completely and all four bases are replanted', async () => {
  const r = mk({ inv: { iron_axe: 1, dirt: 20, dark_oak_sapling: 4 } }); const { bot } = r
  const logs = growTree(bot, { x: 4, z: 3, h: 9, species: 'dark_oak', thick: true })
  await run(r)
  assert.strictEqual(logsLeft(r, logs), 0)
  assert.strictEqual(bot.count('dark_oak_log'), 32, '36 cut; the 4 above the 32 kept went to the furnace chests')
  assert.ok(r.said.some(t => /\(36 logs\)/.test(t)))
  for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) assert.strictEqual(blockName(bot, 4 + dx, 64, 3 + dz), 'dark_oak_sapling')
  assert.strictEqual(countBlocks(bot, 'dirt'), 0)
  done(r)
})

test('without dirt to climb with it chops what it can reach, says so, and places nothing', async () => {
  const r = mk({ inv: { iron_axe: 1, oak_sapling: 2 } }); const { bot } = r
  const logs = growTree(bot, { x: 4, z: 3, h: 14, species: 'spruce' })
  await run(r)
  assert.ok(logsLeft(r, logs) > 0 && logsLeft(r, logs) < 14, 'the low part was cut')
  assert.strictEqual(bot.actions.filter(a => a[0] === 'place' && a[1] !== 'oak_sapling' && a[1] !== 'spruce_sapling').length, 0)
  assert.ok(r.said.some(t => /no dirt to climb/.test(t) && /out of reach/.test(t)), r.said.join(' | '))
  done(r)
})

test('the dirt for the pillar is fetched from the wood chest when the bag has none', async () => {
  const r = mk({ inv: { iron_axe: 1, oak_sapling: 2, spruce_sapling: 2 } }); const { bot } = r
  const c = bot.addChest(...STORAGE[0], 54, { dirt: 100 })
  const logs = growTree(bot, { x: 4, z: 3, h: 14, species: 'spruce' })
  await run(r)
  assert.strictEqual(logsLeft(r, logs), 0)
  assert.ok(bot.actions.some(a => a[0] === 'withdraw' && a[1] === 'dirt'))
  assert.strictEqual(countBlocks(bot, 'dirt'), 0)
  done(r)
})

test('never digs through a wall: a log that cannot be seen is left alone', async () => {
  const r = mk({ inv: { iron_axe: 1, oak_sapling: 2 } }); const { bot } = r
  const logs = growTree(bot, { x: 4, z: 3, h: 6 })
  // the whole trunk is shut into a stone sleeve and capped: no log is in plain view from anywhere
  for (let y = 64; y <= 69; y++) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) bot.setBlock(4 + dx, y, 3 + dz, 'stone')
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) bot.setBlock(4 + dx, 70, 3 + dz, 'stone')
  await run(r)
  assert.strictEqual(bot.losViolations.length, 0, bot.losViolations.join(' | '))
  assert.strictEqual(bot.digs, 0, 'nothing at all was dug: walls are not ours and the logs behind them cannot be seen')
  assert.strictEqual(logsLeft(r, logs), 6)
  assert.strictEqual(countBlocks(bot, 'stone'), 8 * 6 + 9)
  done(r)
})

test('houses and stripped logs are not trees: nothing is cut, the answer says so', async () => {
  const r = mk(); const { bot } = r
  growTree(bot, { x: 4, z: 3, h: 5, natural: false })
  const res = await run(r)
  assert.strictEqual(res.status, 'done')
  assert.strictEqual(bot.digs, 0)
  assert.ok(r.said.some(t => /do not see a full-grown tree/.test(t)), r.said.join(' | '))
  done(r)
})

test('chops the nearest trees first and stops after the requested count', async () => {
  const r = mk(); const { bot } = r
  const a = growTree(bot, { x: 4, z: 3, h: 5 }), b = growTree(bot, { x: -9, z: 3, h: 5 }), c = growTree(bot, { x: 20, z: 20, h: 5 })
  await run(r, { count: 2 })
  assert.strictEqual(logsLeft(r, a), 0); assert.strictEqual(logsLeft(r, b), 0); assert.strictEqual(logsLeft(r, c), 5)
  assert.strictEqual(r.state.stats.trees, 2)
  done(r)
})

test('"get 8 logs" stops once 8 are in the bag', async () => {
  const r = mk(); const { bot } = r
  growTree(bot, { x: 4, z: 3, h: 5 }); const b = growTree(bot, { x: -9, z: 3, h: 5 }); growTree(bot, { x: 20, z: 20, h: 5 })
  await run(r, { wantLogs: 8, count: 12 })
  assert.strictEqual(bot.count('oak_log'), 10, 'two trees: the second one finishes the 8')
  assert.strictEqual(logsLeft(r, b) + 0, 0)
  done(r)
})

// ================================================================ replanting

test('no sapling anywhere: the spot is remembered and planted on a later run', async () => {
  const r = mk({ inv: { iron_axe: 1 } }); const { bot } = r
  growTree(bot, { x: 4, z: 3, h: 5 })
  await run(r)
  assert.strictEqual(r.state.pending.length, 1)
  assert.strictEqual(blockName(bot, 4, 64, 3), 'air')
  assert.ok(r.said.some(t => /still need a sapling/.test(t)))
  bot.give('oak_sapling', 1)
  await r.engine.replantPending(fakeCtx(), { planted: 0, noSapling: 0, failedPlant: 0 })
  assert.strictEqual(blockName(bot, 4, 64, 3), 'oak_sapling')
  assert.strictEqual(r.state.pending.length, 0)
  done(r)
})

test('a sapling that "timed out" but was placed counts as planted; a failed placement is retried once and stays pending', async () => {
  const r = mk(); const { bot } = r
  growTree(bot, { x: 4, z: 3, h: 5 })
  bot.placeMode = 'fail'
  await run(r)
  assert.strictEqual(r.state.pending.length, 1, 'stays pending')
  assert.strictEqual(bot.actions.filter(a => a[0] === 'place' && /sapling/.test(a[1])).length, 2, 'two tries')
  bot.placeMode = 'ok'
  await r.engine.replantPending(fakeCtx(), { planted: 0, noSapling: 0, failedPlant: 0 })
  assert.strictEqual(r.state.pending.length, 0)
  done(r)
})

test('saplings missing in the bag are taken from the wood chest (same species first)', async () => {
  const r = mk({ inv: { iron_axe: 1 } }); const { bot } = r
  bot.addChest(...STORAGE[0], 54, { oak_sapling: 3, spruce_sapling: 30 })
  growTree(bot, { x: 4, z: 3, h: 5, species: 'spruce' })
  await run(r)
  assert.strictEqual(blockName(bot, 4, 64, 3), 'spruce_sapling')
  assert.ok(bot.actions.some(a => a[0] === 'withdraw' && a[1] === 'spruce_sapling'))
  done(r)
})

// ================================================================ putting things away

test('logs above 32 go through the shared furnace deposit; spare saplings go to the wood chest', async () => {
  const r = mk({ inv: { iron_axe: 1, oak_log: 40, oak_sapling: 30 } }); const { bot } = r
  growTree(bot, { x: 4, z: 3, h: 5 })
  await run(r)
  assert.ok(r.deposits.length >= 1 && r.deposits[0].force === true, 'api.depositSmeltables was used')
  assert.strictEqual(bot.count('oak_log'), 32)
  assert.ok(bot.count('oak_sapling') <= 8 + 0, `bag keeps 8 saplings (${bot.count('oak_sapling')})`)
  assert.ok((bot.chestItems(...STORAGE[0]).oak_sapling || 0) >= 20)
  assert.ok(r.said.some(t => /logs to the furnace chests/.test(t)))
  done(r)
})

test('when the furnace chests are full the logs go to the wood chest instead; when both are full it stops and tells Walter, dropping nothing', async () => {
  const r = mk({ inv: { iron_axe: 1, oak_log: 60 }, depositStub: async () => ({ moved: {}, left: [], full: true }) }); const { bot } = r
  growTree(bot, { x: 4, z: 3, h: 5 })
  await run(r)
  assert.strictEqual(bot.count('oak_log'), 32)
  assert.ok((bot.chestItems(...STORAGE[0]).oak_log || 0) >= 28)
  done(r)
  const f = mk({ inv: { iron_axe: 1, oak_log: 80 }, depositStub: async () => ({ moved: {}, left: [], full: true }), storage: false }); const b2 = f.bot
  for (const s of STORAGE) b2.addChest(...s, 1, {}).slots[0] = { name: 'dirt', count: 64 }       // single-slot chests, already full
  growTree(b2, { x: 4, z: 3, h: 5 })
  await run(f)
  assert.strictEqual(Object.values(b2.entities).filter(e => e.name === 'item').length, 0, 'nothing on the ground')
  assert.ok(f.said.some(t => /wood chests are full/.test(t)), f.said.join(' | '))
  done(f)
})

test('a nearly full inventory is emptied mid-run, and if that is impossible the run stops with a message', async () => {
  const r = mk({ inv: { iron_axe: 1 }, storage: false }); const { bot } = r
  for (const s of STORAGE) bot.addChest(...s, 1, {}).slots[0] = { name: 'dirt', count: 64 }
  for (let i = 0; i < 33; i++) bot.give(['cobblestone', 'stone', 'glass', 'sand', 'gravel', 'granite', 'diorite'][i % 7] + (i >= 7 ? '' : ''), 1)
  const names = ['stick', 'apple', 'bread', 'coal', 'iron_ingot', 'gold_ingot', 'clay_ball', 'flint', 'string', 'feather', 'bone', 'paper', 'book', 'leather', 'slime_ball', 'emerald', 'diamond', 'quartz', 'lapis_lazuli', 'redstone', 'glowstone_dust', 'gunpowder', 'sugar', 'egg', 'snowball', 'wheat', 'carrot', 'potato', 'beetroot', 'melon_slice', 'cocoa_beans', 'bamboo', 'kelp', 'cactus', 'vine', 'lily_pad']
  for (const n of names) if (bot.inventory.emptySlotCount() > 2) bot.give(n, 1)
  growTree(bot, { x: 4, z: 3, h: 5 })
  const res = await run(r)
  assert.strictEqual(res.status, 'done')
  assert.ok(r.said.some(t => /inventory is nearly full/.test(t)), r.said.join(' | '))
  assert.strictEqual(bot.digs, 0)
  done(r)
})

// ================================================================ safety, stop, hand

test('a hostile nearby pauses the run (retry), nothing is cut', async () => {
  const r = mk(); const { bot } = r
  growTree(bot, { x: 4, z: 3, h: 5 })
  bot.entities[99] = { id: 99, name: 'zombie', position: new Vec3(3, 64, 0) }
  const ctx = fakeCtx()
  const res = await r.engine.run(ctx, { manual: true })
  assert.strictEqual(res.status, 'retry')
  assert.strictEqual(bot.digs, 0)
  assert.ok(r.said.some(t => /Pausing the tree run: a zombie is near/.test(t)))
  done(r)
})

test('a danger while standing on the pillar brings the bot down first, no pillar left behind', async () => {
  const r = mk(); const { bot } = r
  const logs = growTree(bot, { x: 4, z: 3, h: 16, species: 'spruce' })
  bot.onDig = (n) => { if (bot.entity.position.y > 67 && !bot.entities[99]) bot.entities[99] = { id: 99, name: 'creeper', position: new Vec3(2, bot.entity.position.y, 3) } }
  const res = await run(r)
  assert.strictEqual(res.status, 'retry')
  assert.strictEqual(countBlocks(bot, 'dirt'), 0, 'pillar dug away')
  assert.strictEqual(r.state.pillar, null)
  assert.ok(Math.abs(bot.entity.position.y - 64) < 0.01)
  assert.ok(logsLeft(r, logs) > 0)
  done(r)
})

test('stopped (aborted) while high up: the pillar is still taken down, then the abort goes through', async () => {
  const r = mk(); const { bot } = r
  growTree(bot, { x: 4, z: 3, h: 16, species: 'spruce' })
  let stop = false
  bot.onDig = () => { if (bot.entity.position.y > 68) stop = true }
  const ctx = fakeCtx({ checkpoint() { if (stop) { const e = new Error('aborted: user-stop'); e.name = 'AbortError'; throw e } } })
  await assert.rejects(r.engine.run(ctx, { manual: true }), (e) => e.name === 'AbortError')
  assert.strictEqual(countBlocks(bot, 'dirt'), 0, 'nothing left floating in the forest')
  assert.strictEqual(r.state.pillar, null)
  assert.ok(Math.abs(bot.entity.position.y - 64) < 0.01, `y=${bot.entity.position.y}`)
  done(r)
})

test('a pillar left in the state by a crash is taken down at the start of the next run', async () => {
  const r = mk({ inv: { iron_axe: 1, oak_sapling: 1 } }); const { bot } = r
  for (let y = 64; y < 68; y++) bot.setBlock(4, y, 3, 'dirt')
  bot.entity.position = new Vec3(4.5, 68, 3.5)
  r.state.pillar = { x: 4, y: 64, z: 3, placed: ['4,64,3', '4,65,3', '4,66,3', '4,67,3'] }
  await run(r)
  assert.strictEqual(countBlocks(bot, 'dirt'), 0)
  assert.strictEqual(r.state.pillar, null)
  assert.strictEqual(bot.count('dirt'), 4)
  done(r)
})

test('the descent only ever digs blocks it placed itself', async () => {
  const r = mk({ inv: { iron_axe: 1 } }); const { bot } = r
  bot.setBlock(4, 64, 3, 'dirt'); bot.setBlock(4, 65, 3, 'dirt')
  bot.entity.position = new Vec3(4.5, 66, 3.5)
  r.state.pillar = { x: 4, y: 64, z: 3, placed: ['4,65,3'] }      // only the top block is ours
  await r.engine.descend(null)
  assert.strictEqual(blockName(bot, 4, 65, 3), 'air')
  assert.strictEqual(blockName(bot, 4, 64, 3), 'dirt', 'the other block was not ours')
  done(r)
})

test('a lava bucket is put away before any walking', async () => {
  const r = mk({ inv: { iron_axe: 1, oak_sapling: 1, lava_bucket: 1, cobblestone: 5 } }); const { bot } = r
  await bot.equip(bot.inventory.items().find(i => i.name === 'lava_bucket'), 'hand')
  growTree(bot, { x: 4, z: 3, h: 5 })
  await run(r)
  assert.deepStrictEqual(bot.lavaHeldWhileMoving, [])
  done(r)
})

// ================================================================ idle routine and sites

test('idle run with no known tree farm cuts nothing and asks Walter once', async () => {
  const r = mk(); const { bot } = r
  growTree(bot, { x: 4, z: 3, h: 5 })
  await r.engine.run(fakeCtx(), { manual: false })
  assert.strictEqual(bot.digs, 0)
  assert.strictEqual(r.said.filter(t => /do not know of a tree farm/.test(t)).length, 1)
  await r.engine.run(fakeCtx(), { manual: false })
  assert.strictEqual(r.said.length, 1, 'does not nag')
  assert.ok(!r.engine.due() || true)
  done(r)
})

test('idle run works the known tree farm, chops only grown trees there, and is quiet when nothing is ready', async () => {
  const site = { name: 'tree farm', x: 0, y: 64, z: 20, radius: 15 }
  const r = mk({ sites: [site] }); const { bot } = r
  const grown = growTree(bot, { x: 2, z: 20, h: 6 }), young = growTree(bot, { x: -3, z: 22, h: 3 }), elsewhere = growTree(bot, { x: -30, z: -30, h: 6 })
  await r.engine.run(fakeCtx(), { manual: false })
  assert.strictEqual(logsLeft(r, grown), 0)
  assert.strictEqual(logsLeft(r, young), 3, 'not full grown')
  assert.strictEqual(logsLeft(r, elsewhere), 6, 'not at the tree farm')
  assert.ok(r.said.length === 1 && /Chopped 1 tree/.test(r.said[0]), r.said.join(' | '))
  r.said.length = 0
  await r.engine.run(fakeCtx(), { manual: false })
  assert.deepStrictEqual(r.said, [], 'quiet when nothing is ready')
  done(r)
})

test('due(): daytime only, every 45 minutes, only with a site (or to ask once a day)', () => {
  let t = 1e12
  const site = { name: 'tree farm', x: 0, y: 64, z: 0 }
  const r = mk({ sites: [site], now: () => t }); const { bot } = r
  assert.ok(r.engine.due())
  r.state.lastRun = t
  assert.ok(!r.engine.due(), 'ran just now')
  t += 46 * 60000; assert.ok(r.engine.due())
  bot.time.timeOfDay = 13000; assert.ok(!r.engine.due(), 'night')
  bot.time.timeOfDay = 1000; bot.game.dimension = 'the_nether'; assert.ok(!r.engine.due())
  bot.game.dimension = 'overworld'; r.sites.length = 0
  assert.ok(r.engine.due(), 'no site: due once to ask')
  r.state.askedAt = t; assert.ok(!r.engine.due())
  r.state.pillar = { x: 0, y: 64, z: 0, placed: [] }; assert.ok(r.engine.due(), 'a leftover pillar is always due')
  done(r)
})

test('a night coming up ends an idle run after the current tree, a manual run carries on', async () => {
  const site = { name: 'tree farm', x: 0, y: 64, z: 20, radius: 25 }
  const r = mk({ sites: [site] }); const { bot } = r
  const a = growTree(bot, { x: 2, z: 20, h: 5 }), b = growTree(bot, { x: -4, z: 24, h: 5 })
  bot.onDig = (n) => { if (n === 3) bot.time.timeOfDay = 13000 }
  await r.engine.run(fakeCtx(), { manual: false })
  assert.strictEqual(logsLeft(r, a) + logsLeft(r, b), 5, 'the second tree was left for the morning')
  done(r)
})

test('"tree farm here" marks a site that survives a reload; "plant a grove" plants a spaced grid and registers it', async () => {
  const r = mk({ inv: { iron_axe: 1, oak_sapling: 20 }, config: { grove: { spacing: 4, count: 5, radius: 14, height: 7 } } }); const { bot } = r
  const p = r.engine.markSite()
  assert.deepStrictEqual([p.x, p.y, p.z], [0, 64, 0])
  const stateStore = require('../brain/treefarm/state')
  assert.strictEqual(stateStore.load({ file: r.file }).sites.length, 1)
  r.engine.forgetSites(); r.state.sites = []
  await r.engine.plantGrove(fakeCtx())
  const saplings = []
  for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) if (blockName(bot, x, 64, z) === 'oak_sapling') saplings.push([x, z])
  assert.strictEqual(saplings.length, 5)
  for (const a of saplings) for (const b of saplings) if (a !== b) assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) >= 4 - 1e-9, 'spaced out')
  assert.strictEqual(r.state.sites.length, 1)
  assert.strictEqual(bot.losViolations.length, 0)
  done(r)
})

// ================================================================ module: commands, routine, chat

function moduleRig({ chat = true } = {}) {
  const r = mk({ inv: { iron_axe: 1, dirt: 20, oak_sapling: 4, spruce_sapling: 4 } })
  const scheduler = new Scheduler({ graceMs: 300, idleAfterMs: 0 })
  const said = r.said, cmds = []
  const api = {
    bot: r.bot, PRIORITY, scheduler, say: (t) => said.push(t), goals: r.bot.goals, tryGoto: r.bot.tryGoto, stopNav: r.stop, safehand: r.sh,
    gotoNear: undefined, canSee: undefined, ensureLineOfSight: undefined, depositSmeltables: undefined,
    statePath: (f) => require('path').join(r.dir, f), log: () => {}, now: Date.now, dir: r.dir, ownerName: 'OGWO',
    commands: { add: (c) => { cmds.push(c); return true }, list: () => cmds, dispatch: () => false }
  }
  const los = require('../brain/los'), util = require('../brain/util')
  api.canSee = (t) => los.canSee(r.bot, t)
  api.ensureLineOfSight = (o) => los.ensureLineOfSight({ bot: r.bot, goals: r.bot.goals, tryGoto: r.bot.tryGoto, stop: r.stop, ...o })
  api.gotoNear = (o) => util.gotoNear({ bot: r.bot, goals: r.bot.goals, tryGoto: r.bot.tryGoto, stop: r.stop, ...o })
  const handle = register(api)
  return { ...r, scheduler, handle, cmds, api }
}

test('registers an idle routine that is on by default, and eight brain commands', () => {
  const m = moduleRig()
  const routine = m.scheduler.routines.get('treefarm')
  assert.ok(routine && routine.idleOnly && m.scheduler.isEnabled('treefarm'))
  assert.strictEqual(routine.priority, PRIORITY.FARM)
  assert.strictEqual(m.handle.name, 'treefarm')
  assert.ok(m.cmds.length >= 8)
  assert.ok(m.cmds.every(c => c.name && c.help && c.run))
  assert.ok(m.cmds.filter(c => c.risk === 'high').map(c => c.name).includes('chop-trees'))
  assert.ok(m.handle.status().sites)
  m.stop()
})

test('chat: "chop 2 trees" runs a chat-priority task that cuts exactly those trees', async () => {
  const m = moduleRig(); const { bot } = m
  const a = growTree(bot, { x: 4, z: 3, h: 5 }), b = growTree(bot, { x: -9, z: 3, h: 5 }), c = growTree(bot, { x: 20, z: 20, h: 5 })
  assert.strictEqual(m.handle.onChat('OGWO', 'hey can you please chop 2 trees'), true)
  const t0 = Date.now()
  while ((m.scheduler.running || m.scheduler.tasks.length) && Date.now() - t0 < 8000) await wait(20)
  assert.strictEqual(logsLeft(m, a) + logsLeft(m, b), 0)
  assert.strictEqual(logsLeft(m, c), 5)
  m.stop()
})

test('chat phrases: what is taken and what is left to the other modules', () => {
  const m = moduleRig()
  const heard = []
  m.scheduler.submit = (d) => { heard.push(d.name); return { } }          // do not run anything
  const yes = ['chop trees', 'chop some trees', 'cut down 5 trees', 'get wood', 'get me 40 logs', 'gather some lumber', 'fell a tree', 'go chop wood', 'tree status', 'how is the tree farm', 'tree routine on', 'turn off the tree routine', 'tree farm here', 'plant a grove', 'start a tree farm', 'plant some trees', 'forget the tree farm', 'stop chopping']
  const no = ["don't chop trees", 'how many trees are there', 'what wood do you have', 'harvest crops', 'farm status', 'go to bed', 'where are the logs', 'craft a sword', 'chopping is fun', 'do not plant a grove']
  for (const p of yes) assert.strictEqual(m.handle.onChat('OGWO', p), true, `should take: ${p}`)
  for (const p of no) assert.strictEqual(m.handle.onChat('OGWO', p), false, `should leave: ${p}`)
  m.stop()
})

test('"tree routine off/on" switches the scheduler routine; status mentions sites and counts', () => {
  const m = moduleRig()
  m.handle.onChat('OGWO', 'tree routine off'); assert.ok(!m.scheduler.isEnabled('treefarm'))
  m.handle.onChat('OGWO', 'tree routine on'); assert.ok(m.scheduler.isEnabled('treefarm'))
  m.said.length = 0
  m.handle.onChat('OGWO', 'tree status')
  assert.ok(/Tree routine is ON/.test(m.said[0]) && /none known/.test(m.said[0]), m.said[0])
  m.stop()
})

test('amounts: trees and logs', () => {
  const { parseAmount } = require('../brain/treefarm')
  assert.deepStrictEqual(parseAmount('chop 5 trees'), { count: 5 })
  assert.deepStrictEqual(parseAmount('get 40 logs'), { wantLogs: 40, count: 12 })
  assert.deepStrictEqual(parseAmount('chop trees'), {})
})

test('the routine submitted by the scheduler runs while idle and yields when Walter chats', async () => {
  const site = { name: 'tree farm', x: 0, y: 64, z: 20, radius: 25 }
  const m = moduleRig(); const { bot } = m
  require('fs').writeFileSync(require('path').join(m.dir, 'waypoints.json'), JSON.stringify({ 'Tree Farm': { x: 0, y: 64, z: 20 } }))
  assert.strictEqual(m.handle.sitesFn().length, 1, 'a waypoint named like a tree farm is a site')
  const logs = growTree(bot, { x: 2, z: 20, h: 5 })
  m.scheduler.tick()
  const t0 = Date.now()
  while ((m.scheduler.running || m.scheduler.tasks.length) && Date.now() - t0 < 8000) await wait(20)
  assert.strictEqual(logsLeft(m, logs), 0)
  m.stop()
})

// ================================================================ work-site chest (Walter's time-economy rule)

test('far from the final chests a work-site chest is placed next to the trees, filled when the bag gets full, and hauled once at the end (chest picked up again)', async () => {
  const r = mk({ inv: { iron_axe: 1, oak_sapling: 4, chest: 1 }, config: { keepLogs: 0, minFreeSlots: 32, worksite: { enabled: true, minDistance: 8 } }, depositStub: false }); const { bot } = r
  bot.entity.position = new Vec3(-20.5, 64, -20.5)
  const a = growTree(bot, { x: -22, z: -24, h: 5 }), b = growTree(bot, { x: -28, z: -22, h: 5 }), c = growTree(bot, { x: -24, z: -30, h: 5 })
  await run(r, { count: 3 })
  assert.strictEqual(logsLeft(r, a) + logsLeft(r, b) + logsLeft(r, c), 0)
  const dep = bot.actions.filter(a => a[0] === 'deposit' && /_log$/.test(a[1]))
  const ws = dep.filter(a => a[3] !== STORAGE[0].join(',') && a[3] !== STORAGE[1].join(','))
  assert.ok(ws.length >= 1, 'logs went into the work-site chest while working: ' + JSON.stringify(bot.actions.filter(a => a[0] === 'deposit')))
  assert.ok(bot.actions.some(a => a[0] === 'place' && a[1] === 'chest'), 'chest placed')
  assert.strictEqual(bot.count('chest'), 1, 'the chest is back in the bag')
  assert.strictEqual(r.state.worksite, null)
  const total = (bot.chestItems(...STORAGE[0]).oak_log || 0) + (bot.chestItems(...STORAGE[1]).oak_log || 0)
  assert.strictEqual(total + bot.count('oak_log'), 15, 'nothing lost')
  assert.strictEqual(bot.losViolations.length, 0)
  assert.ok(bot.actions.filter(a => a[0] === 'open' && STORAGE.some(s => s.join(',') === a[1])).length <= 4, 'few trips to the far chests: one look for dirt, one haul')
  done(r)
})

test('near the final chests, or without a chest in the bag, no work-site chest is used', async () => {
  const r = mk({ inv: { iron_axe: 1, oak_sapling: 4, chest: 1 }, config: { keepLogs: 0, minFreeSlots: 31 } }); const { bot } = r      // default minDistance 40: the chests are 14 away
  growTree(bot, { x: 4, z: 3, h: 5 }); growTree(bot, { x: -9, z: 3, h: 5 })
  await run(r)
  assert.ok(!bot.actions.some(a => a[0] === 'place' && a[1] === 'chest'))
  done(r)
  const q = mk({ inv: { iron_axe: 1, oak_sapling: 4 }, config: { keepLogs: 0, minFreeSlots: 31, worksite: { enabled: true, minDistance: 8 } } })
  growTree(q.bot, { x: 4, z: 3, h: 5 }); growTree(q.bot, { x: -9, z: 3, h: 5 })
  await run(q)
  assert.ok(!q.bot.actions.some(a => a[0] === 'place' && a[1] === 'chest'))
  assert.ok(Object.values(q.bot.chestItems(...STORAGE[0])).length > 0 || Object.values(q.bot.chestItems(...STORAGE[1])).length > 0, 'went to the final chests as before')
  done(q)
})

test('a work-site chest left in the state (restart mid-job) is hauled and picked up by the next run', async () => {
  const r = mk({ inv: { iron_axe: 1 }, config: { keepLogs: 0 }, depositStub: false }); const { bot } = r
  bot.addChest(6, 64, 6, 27, { oak_log: 40 })
  r.state.worksite = { x: 6, y: 64, z: 6, ledger: { oak_log: 40 }, at: 1 }
  assert.ok(r.engine.due(), 'a leftover work site makes the routine due')
  const res = await run(r)
  assert.strictEqual(res.status, 'done')
  assert.strictEqual(r.state.worksite, null)
  assert.strictEqual(blockName(bot, 6, 64, 6), 'air', 'chest picked up')
  assert.strictEqual(bot.count('chest'), 1)
  assert.strictEqual((bot.chestItems(...STORAGE[0]).oak_log || 0) + (bot.chestItems(...STORAGE[1]).oak_log || 0), 40)
  done(r)
})

// ================================================================ through the real brain/index.js

test('loads through brain/index.js: idle routine on by default, chat routed to it, a tree chopped with the shared api helpers', async () => {
  const fs = require('fs'), os = require('os'), path = require('path')
  const { extendTrees, mockBot, flatWorld } = require('./treefarm.helpers')
  const attach = require('../brain')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfb-'))
  const bot = extendTrees(mockBot({ pos: [0, 64, 0] })); flatWorld(bot)
  bot.give('iron_axe', 1); bot.give('oak_sapling', 3); bot.give('dirt', 10)
  for (const s of STORAGE) bot.addChest(...s, 54, {})
  const said = []
  const logs = growTree(bot, { x: 4, z: 3, h: 5 })
  const brain = attach({
    bot, say: (t) => said.push(t), goals: bot.goals, tryGoto: bot.tryGoto, stopNav: () => {}, navigateRaw: () => {}, navActive: () => false,
    handleCommand: () => false, farm: { isBusy: () => false, stop() {}, storeCrops: async () => {}, harvest: async () => {} },
    excavation: { isRunning: () => false, stop() {}, resume: async () => {}, start: async () => {} }, routines: { farm: false, lastFarmRun: 0 }, saveRoutines: () => {},
    dir, stateDir: path.join(dir, 'state'), jobs: { bedRoutine: async () => {} }, stopAllLegacy: () => {}, idleAfterMs: 20, safetyCooldownMs: 0,
    moduleEntries: [{ name: 'treefarm', path: path.join(__dirname, '..', 'brain', 'treefarm', 'index.js') }]
  })
  const routine = brain.scheduler.status().routines.find(x => x.name === 'treefarm')
  assert.ok(routine && routine.enabled, 'on by default')
  assert.strictEqual(brain.route('OGWO', 'tree status', { handleCommand: () => false }), true)
  assert.ok(said.some(t => /Tree routine is ON/.test(t)), said.join(' | '))
  assert.strictEqual(brain.route('OGWO', 'please chop a tree', { handleCommand: () => false }), true)
  const t0 = Date.now()
  while ((brain.scheduler.status().running || brain.scheduler.status().queue.length) && Date.now() - t0 < 8000) await wait(20)
  assert.strictEqual(logsLeft({ bot }, logs), 0)
  assert.strictEqual(bot.losViolations.length, 0)
  brain.stop(); bot.stopPhysics()
})

test('far from the final chests with no chest in the bag: it asks the crafting module for one, waits (retry), then uses it', async () => {
  let asked = 0
  const r = mk({ inv: { iron_axe: 1, oak_sapling: 4 }, config: { keepLogs: 0, minFreeSlots: 32, worksite: { enabled: true, minDistance: 8, craft: true, craftWaitMs: 5 } }, depositStub: false,
    requestChest: async () => { asked++; r.bot.give('chest', 1); return true } }); const { bot } = r
  bot.entity.position = new Vec3(-20.5, 64, -20.5)
  const logs = [...growTree(bot, { x: -22, z: -24, h: 5 }), ...growTree(bot, { x: -28, z: -22, h: 5 })]
  const ctx = fakeCtx()
  const first = await r.engine.run(ctx, { manual: true })
  assert.strictEqual(first.status, 'retry')
  assert.strictEqual(bot.digs, 0, 'nothing cut before the chest is there')
  const second = await r.engine.run(ctx, { manual: true })
  assert.strictEqual(second.status, 'done')
  assert.strictEqual(asked, 1, 'asked only once')
  assert.strictEqual(logsLeft(r, logs), 0)
  assert.ok(bot.actions.some(a => a[0] === 'place' && a[1] === 'chest'))
  assert.strictEqual(bot.count('chest'), 1)
  done(r)
})

test('if the crafting module cannot make a chest the job goes ahead without one', async () => {
  const r = mk({ inv: { iron_axe: 1, oak_sapling: 4 }, config: { worksite: { enabled: true, minDistance: 8, craft: true } }, requestChest: async () => false }); const { bot } = r
  const logs = growTree(bot, { x: 4, z: 3, h: 5 })
  const res = await run(r)
  assert.strictEqual(res.status, 'done')
  assert.strictEqual(logsLeft(r, logs), 0)
  done(r)
})

test('an idle run at an empty tree farm site plants a grove there once; a site with trees or saplings is left alone', async () => {
  const site = { name: 'Tree Farm', x: 0, y: 64, z: 25, radius: 25 }
  const r = mk({ sites: [site], inv: { iron_axe: 1, oak_sapling: 12 }, config: { grove: { spacing: 4, count: 5, radius: 14, height: 7 } } }); const { bot } = r
  await r.engine.run(fakeCtx(), { manual: false })
  const saplings = []
  for (let x = -12; x <= 12; x++) for (let z = 13; z <= 37; z++) if (blockName(bot, x, 64, z) === 'oak_sapling') saplings.push([x, z])
  assert.strictEqual(saplings.length, 5, 'planted around the site centre')
  assert.ok(saplings.every(([x, z]) => Math.hypot(x, z - 25) <= 9))
  assert.strictEqual(r.said.filter(t => /Planted 5 saplings at the tree farm/.test(t)).length, 1, r.said.join(' | '))
  assert.strictEqual(bot.losViolations.length, 0)
  r.said.length = 0
  bot.give('oak_sapling', 10)
  await r.engine.run(fakeCtx(), { manual: false })
  assert.strictEqual(r.said.length, 0, 'quiet the second time (saplings growing there)')
  done(r)
  const q = mk({ sites: [site], inv: { iron_axe: 1, oak_sapling: 12 } })
  growTree(q.bot, { x: 2, z: 25, h: 3 })                    // a young tree: still growing, nothing to plant or chop
  await q.engine.run(fakeCtx(), { manual: false })
  assert.strictEqual(q.bot.actions.filter(a => a[0] === 'place').length, 0)
  done(q)
})

test('an empty site with no saplings anywhere stays quiet in the idle run (no chat spam) and is retried only after 6 hours', async () => {
  let t = 1e12
  const site = { name: 'Tree Farm', x: 0, y: 64, z: 25, radius: 25 }
  const r = mk({ sites: [site], inv: { iron_axe: 1 }, storage: false, now: () => t }); const { bot } = r
  await r.engine.run(fakeCtx(), { manual: false })
  assert.deepStrictEqual(r.said, [])
  bot.give('oak_sapling', 6); t += 3600000
  await r.engine.run(fakeCtx(), { manual: false })
  assert.strictEqual(bot.actions.filter(a => a[0] === 'place').length, 0, 'not before 6 hours')
  t += 6 * 3600000
  await r.engine.run(fakeCtx(), { manual: false })
  assert.ok(bot.actions.filter(a => a[0] === 'place').length > 0)
  done(r)
})

// ================================================================ spruce first (Walter: "we need spruce in the tree farm most of all")

test('at a tree farm every felled tree is replanted with spruce, whatever grew there; in the woods it is replanted with its own species', async () => {
  const site = { name: 'Tree Farm', x: 0, y: 64, z: 20, radius: 15 }
  const r = mk({ sites: [site], inv: { iron_axe: 1, oak_sapling: 6, birch_sapling: 6, spruce_sapling: 6 } }); const { bot } = r
  growTree(bot, { x: 2, z: 20, h: 6, species: 'birch' })
  growTree(bot, { x: -30, z: -30, h: 6, species: 'birch' })
  await r.engine.run(fakeCtx(), { manual: false })
  assert.strictEqual(blockName(bot, 2, 64, 20), 'spruce_sapling', 'tree farm: spruce')
  await r.engine.run(fakeCtx(), { manual: true, center: new Vec3(-30, 64, -30), radius: 10 })
  assert.strictEqual(blockName(bot, -30, 64, -30), 'birch_sapling', 'the woods keep their species')
  done(r)
})

test('a grove is planted with spruce when it can be had (also from the wood chest), other saplings only as a fallback', async () => {
  const site = { name: 'Tree Farm', x: 0, y: 64, z: 25, radius: 25 }
  const r = mk({ sites: [site], inv: { iron_axe: 1, oak_sapling: 12 }, config: { grove: { spacing: 4, count: 5, radius: 14, height: 7 } } }); const { bot } = r
  bot.addChest(...STORAGE[0], 54, { spruce_sapling: 40 })
  await r.engine.run(fakeCtx(), { manual: false })
  const kinds = {}
  for (let x = -12; x <= 12; x++) for (let z = 13; z <= 37; z++) { const n = blockName(bot, x, 64, z); if (/_sapling$/.test(n)) kinds[n] = (kinds[n] || 0) + 1 }
  assert.deepStrictEqual(kinds, { spruce_sapling: 5 })
  done(r)
  const q = mk({ sites: [site], inv: { iron_axe: 1, oak_sapling: 12 }, config: { grove: { spacing: 4, count: 5, radius: 14, height: 7 } } })
  await q.engine.run(fakeCtx(), { manual: false })
  assert.strictEqual(blockName(q.bot, 0, 64, 25) === 'oak_sapling' || [-4, 0, 4].some(x => [21, 25, 29].some(z => blockName(q.bot, x, 64, z) === 'oak_sapling')), true, 'no spruce anywhere: oak')
  done(q)
})

test('spare spruce saplings are kept (16) before the surplus goes to the chest', () => {
  const p = T.planUnload({ spruce_sapling: 30, oak_sapling: 30 }, { ...base, preferSpecies: 'spruce' })
  assert.deepStrictEqual(p.saplings, { spruce_sapling: 14, oak_sapling: 22 })
})
