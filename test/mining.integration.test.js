// brain/mining wired into the real brain/index.js (scheduler, command router, crafting module), on the extended mock world.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Vec3 } = require('vec3')
const { mockBot } = require('./mock-bot')
const H = require('./mining.helpers')
const { addCrafting } = require('./crafting.helpers')
const attach = require('../brain')

const MINING = path.join(__dirname, '..', 'brain', 'mining', 'index.js')
const CRAFTING = path.join(__dirname, '..', 'brain', 'crafting', 'index.js')
const wait = H.wait

function irig({ pickaxe = 'iron_pickaxe', craftStuff = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mining-int-'))
  const bot = addCrafting(H.extend(mockBot({ pos: [0.5, -58, 0.5] })))
  bot.lavaHeldWhileMoving = []
  bot.goals = { ...bot.goals, GoalNear: class { constructor(x, y, z, r) { Object.assign(this, { x, y, z, r }) } }, GoalBlock: class { constructor(x, y, z) { Object.assign(this, { x, y, z }) } } }
  H.underground(bot, { y: -58 })
  if (pickaxe) bot.give(pickaxe, 1)
  const chestIndex = {}
  if (craftStuff) {
    H.carve(bot, [[-1, -58, 0], [-1, -57, 0]])
    bot.setBlock(-1, -58, 0, 'crafting_table')
    bot.addChest(0, -58, 1, 27, { iron_ingot: 6, stick: 8 })
    chestIndex['0,-58,1'] = { items: { iron_ingot: 6, stick: 8 }, slots: 27, at: 1000 }
  }
  fs.writeFileSync(path.join(dir, 'chest-index.json'), JSON.stringify(chestIndex))
  const said = [], legacy = []
  const brain = attach({
    bot, say: (t) => { said.push(t); bot.say(t) }, goals: bot.goals, tryGoto: bot.tryGoto, stopNav: () => { bot.pathfinder.setGoal(null) },
    navigateRaw: () => {}, navActive: () => false,
    handleCommand: (u, t) => { legacy.push(t); return false },
    farm: { isBusy: () => false, stop() {}, storeCrops: async () => {}, harvest: async () => {} },
    excavation: { isRunning: () => false, stop() {}, start: async () => {}, resume: async () => {}, status() {} },
    routines: { farm: false, lastFarmRun: 0 }, saveRoutines: () => {}, dir, stateDir: path.join(dir, 'state'),
    jobs: { bedRoutine: async () => {} }, stopAllLegacy: () => {}, idleAfterMs: 50, lingerMs: 0,
    moduleEntries: [{ name: 'mining', path: MINING }, { name: 'crafting', path: CRAFTING }]
  })
  const route = (text) => brain.route('OGWO', text, { handleCommand: (u, t) => { legacy.push(t); return false } })
  const idle = async (ms = 20000) => { const t0 = Date.now(); await wait(30); while (Date.now() - t0 < ms) { const s = brain.scheduler.status(); if (!s.running && !s.queue.length) return; await wait(20) } throw new Error('did not finish: ' + JSON.stringify(brain.scheduler.status())) }
  return { brain, bot, dir, said, legacy, route, idle, stop: () => brain.stop() }
}

test('integration: "mine diamonds 1" goes through the router, mines the exposed ore and reports', { timeout: 60000 }, async () => {
  const r = irig()
  r.bot.setBlock(2, -58, -1, 'diamond_ore'); r.bot.setBlock(2, -55, 0, 'diamond_ore')
  assert.strictEqual(r.route('hey can you mine diamonds 1 please'), true)
  await r.idle()
  assert.strictEqual(r.bot.count('diamond'), 1)
  assert.strictEqual(r.bot.blockAt(new Vec3(2, -55, 0)).name, 'diamond_ore', 'hidden one untouched')
  assert.match(r.said.join(' '), /Done: 1 diamond/)
  assert.deepStrictEqual(r.bot.losViolations, [])
  assert.strictEqual(r.route('mining status'), true)
  assert.match(r.said[r.said.length - 1], /Finished: 1\/1 diamond/)
  const wp = JSON.parse(fs.readFileSync(path.join(r.dir, 'waypoints.json'), 'utf8'))
  assert.deepStrictEqual(wp['mine diamond'], { x: 0, y: -58, z: 0, source: 'mining' })
  assert.ok(fs.existsSync(path.join(r.dir, 'state', 'mining-state.json')))
  assert.ok(r.brain.commands.list().some(c => c.name === 'mine' && /mine <ore> <amount>/.test(c.help)))
  assert.ok(r.brain.status().modules.mining.mine)
  r.stop()
})
test('integration: a wooden pickaxe is swapped for an iron one by the crafting module (chests + table), then mining carries on', { timeout: 60000 }, async () => {
  const r = irig({ pickaxe: 'wooden_pickaxe', craftStuff: true })
  r.bot.setBlock(2, -58, -1, 'diamond_ore')
  assert.strictEqual(r.route('mine diamonds 1'), true)
  await r.idle(30000)
  assert.deepStrictEqual(r.bot.craftCalls.map(c => c[0]), ['iron_pickaxe'])
  assert.strictEqual(r.bot.count('diamond'), 1)
  assert.ok(r.said.some(s => /making a iron pickaxe/.test(s)), r.said.join(' | '))
  assert.strictEqual(r.bot.chestItems(0, -58, 1).iron_ingot, 3, 'only the 3 ingots the recipe needs were taken')
  assert.deepStrictEqual(r.bot.losViolations, [])
  r.stop()
})
test('integration: stop mining parks the job, resume mining continues it, unrelated lines are not claimed', { timeout: 60000 }, async () => {
  const r = irig()
  r.bot.setBlock(10, -58, 0, 'diamond_ore')                                // hidden: the strip runs to its end
  assert.strictEqual(r.route('mine diamonds 3'), true)
  await H.waitFor(() => r.bot.digs >= 12)
  assert.strictEqual(r.route('stop mining'), true)
  await H.waitFor(() => r.brain.scheduler.status().parked.some(t => t.name === 'mining'))
  const at = r.bot.digs
  await wait(80)
  assert.ok(r.bot.digs - at <= 2)
  assert.match(r.said[r.said.length - 1], /stopped mining/)
  assert.strictEqual(r.route('mining status'), true)
  assert.match(r.said[r.said.length - 1], /paused/)
  assert.strictEqual(r.route('resume mining'), true)
  await H.waitFor(() => r.bot.digs >= at + 20)
  assert.strictEqual(r.route('don\'t mine anymore'), true)
  await H.waitFor(() => r.brain.scheduler.status().parked.some(t => t.name === 'mining'))
  assert.strictEqual(r.route('mine is bigger than craft'), false)
  assert.strictEqual(r.route('mine emeralds 4'), true)
  assert.match(r.said[r.said.length - 1], /mountain/)
  r.stop()
})
