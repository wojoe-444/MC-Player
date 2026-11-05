// The idle mining routine (Walter 2026-10-26: mining is part of the routine when nothing else is due), through the real brain/index.js.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { mockBot } = require('./mock-bot')
const H = require('./mining.helpers')
const { addCrafting } = require('./crafting.helpers')
const attach = require('../brain')

const MINING = path.join(__dirname, '..', 'brain', 'mining', 'index.js')
const CRAFTING = path.join(__dirname, '..', 'brain', 'crafting', 'index.js')
const wait = H.wait

// chestStock: items the chests "contain" (chest-index.json); waypoints: waypoints.json content
function rrig({ pickaxe = 'iron_pickaxe', chestStock = {}, waypoints = {}, health = 20, food = 20 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mining-routine-'))
  const bot = addCrafting(H.extend(mockBot({ pos: [0.5, -58, 0.5], health, food })))
  bot.lavaHeldWhileMoving = []
  bot.goals = { ...bot.goals, GoalNear: class { constructor(x, y, z, r) { Object.assign(this, { x, y, z, r }) } }, GoalBlock: class { constructor(x, y, z) { Object.assign(this, { x, y, z }) } } }
  H.underground(bot, { y: -58 })
  if (pickaxe) bot.give(pickaxe, 1)
  fs.writeFileSync(path.join(dir, 'chest-index.json'), JSON.stringify(Object.keys(chestStock).length ? { '1,1,1': { items: chestStock, slots: 27, at: 1000 } } : {}))
  fs.writeFileSync(path.join(dir, 'waypoints.json'), JSON.stringify(waypoints))
  const said = []
  const brain = attach({
    bot, say: (t) => { said.push(t); bot.say(t) }, goals: bot.goals, tryGoto: bot.tryGoto, stopNav: () => { bot.pathfinder.setGoal(null) },
    navigateRaw: () => {}, navActive: () => false, handleCommand: () => false,
    farm: { isBusy: () => false, stop() {}, storeCrops: async () => {}, harvest: async () => {} },
    excavation: { isRunning: () => false, stop() {}, start: async () => {}, resume: async () => {}, status() {} },
    routines: { farm: false, lastFarmRun: 0 }, saveRoutines: () => {}, dir, stateDir: path.join(dir, 'state'),
    jobs: { bedRoutine: async () => {} }, stopAllLegacy: () => {}, idleAfterMs: 20, lingerMs: 0,
    moduleEntries: [{ name: 'mining', path: MINING }, { name: 'crafting', path: CRAFTING }]
  })
  brain.scheduler.stop()                                                         // no timer: the tests call tick() themselves
  const tick = async () => { await wait(30); brain.scheduler.routines.get('mining').nextCheck = 0; brain.scheduler.tick() }
  const idle = async (ms = 80000) => { const t0 = Date.now(); await wait(30); while (Date.now() - t0 < ms) { const s = brain.scheduler.status(); if (!s.running && !s.queue.length) return; await wait(20) } throw new Error('did not finish: ' + JSON.stringify(brain.scheduler.status())) }
  const mining = () => brain.status().modules.mining
  const stateFile = () => JSON.parse(fs.readFileSync(path.join(dir, 'state', 'mining-state.json'), 'utf8'))
  return { brain, bot, dir, said, tick, idle, mining, stateFile, route: (t) => brain.route('OGWO', t, { handleCommand: () => false }), stop: () => brain.stop() }
}
const STOCKED = { coal: 500, iron_ingot: 500 }          // leaves diamond (needs an iron pickaxe) as the first ore with a gap

test('routine: it is registered, idle-only and on by default', () => {
  const r = rrig()
  const rt = r.brain.scheduler.routines.get('mining')
  assert.ok(rt); assert.strictEqual(rt.idleOnly, true); assert.strictEqual(r.brain.scheduler.isEnabled('mining'), true)
  r.stop()
})
test('routine: with a known mine and low stocks it starts mining the ore that is most short, by itself, and announces it once', { timeout: 120000 }, async () => {
  const r = rrig({ chestStock: STOCKED, waypoints: { 'mine diamond': { x: 0, y: -58, z: 0 } } })
  r.bot.setBlock(2, -58, -1, 'diamond_ore')
  await r.tick()
  await r.idle()
  assert.ok(r.said.some(s => /Nothing else to do, so I am going mining for 5 diamond/.test(s)), r.said.join(' | '))
  assert.strictEqual(r.said.filter(s => /OK, mining/.test(s)).length, 0, 'no second announcement')
  assert.ok(r.bot.count('diamond') >= 1)
  assert.deepStrictEqual(r.bot.losViolations, [])
  const st = r.stateFile()
  assert.strictEqual(st.auto, true)
  assert.ok(st.routine.nextAt > Date.now(), 'cooldown after a run')
  r.stop()
})
test('routine: stock counts the bag and the chest index; with every stock full it still goes mining, for whatever is relatively lowest', { timeout: 120000 }, async () => {
  const r = rrig({ chestStock: { coal: 500, iron_ingot: 500, diamond: 17, redstone: 500, lapis_lazuli: 500, gold_ingot: 500, copper_ingot: 500 }, waypoints: { 'mine diamond': { x: 0, y: -58, z: 0 } } })
  r.bot.setBlock(2, -58, -1, 'diamond_ore')
  await r.tick(); await r.idle()
  assert.ok(r.said.some(s => /going mining for \d+ diamond \(my stocks are full/.test(s)), r.said.join(' | '))
  assert.strictEqual(r.mining().routine.auto, true)
  r.stop()
})
test('routine: it only picks ores the pickaxes in the bag can mine', { timeout: 120000 }, async () => {
  const r = rrig({ pickaxe: 'stone_pickaxe', chestStock: { coal: 500 }, waypoints: { 'mine iron': { x: 0, y: -58, z: 0 } } })
  r.bot.setBlock(2, -58, -1, 'iron_ore')
  await r.tick(); await r.idle()
  assert.ok(r.said.some(s => /going mining for \d+ iron/.test(s)), r.said.join(' | '))      // iron needs stone; diamond/gold/redstone need iron and are skipped
  r.stop()
})
test('routine: no known mine -> it does not dig a new one on its own; one short hint, at most every 12 hours', async () => {
  const r = rrig({ chestStock: STOCKED })
  await r.tick(); await wait(50); await r.tick(); await wait(50)
  assert.strictEqual(r.bot.digs, 0)
  const hints = r.said.filter(s => /do not know a mine yet/.test(s))
  assert.strictEqual(hints.length, 1)
  assert.match(hints[0], /waypoint called "mine diamond"/)
  r.stop()
})
test('routine: stop mining holds it for two hours; routine off, low health and low food keep it quiet; a manual command clears the hold', { timeout: 120000 }, async () => {
  const r = rrig({ chestStock: STOCKED, waypoints: { 'mine diamond': { x: 0, y: -58, z: 0 } } })
  r.bot.setBlock(10, -58, 0, 'diamond_ore')                                   // hidden: the strip runs on
  r.route('mine diamonds 3')
  await H.waitFor(() => r.bot.digs >= 8)
  r.route('stop mining')
  await H.waitFor(() => r.brain.scheduler.status().parked.some(t => t.name === 'mining'))
  r.brain.scheduler.cancel('mining')                                           // gone from the queue, the hold stays
  await r.tick(); await wait(80)
  assert.strictEqual(r.brain.scheduler.status().running, null, 'held after Walter stopped it')
  assert.ok(r.mining().routine.holdS > 7000)
  r.route('resume mining')
  assert.strictEqual(r.mining().routine.holdS, 0)
  r.route('stop mining'); await wait(40)
  r.stop()

  const off = rrig({ chestStock: STOCKED, waypoints: { 'mine diamond': { x: 0, y: -58, z: 0 } } })
  assert.strictEqual(off.route('mining routine off'), true)
  assert.strictEqual(off.brain.scheduler.isEnabled('mining'), false)
  await off.tick(); await wait(60)
  assert.strictEqual(off.bot.digs, 0)
  assert.strictEqual(off.route('mining routine on'), true)
  assert.strictEqual(off.brain.scheduler.isEnabled('mining'), true)
  off.stop()

  const hurt = rrig({ chestStock: STOCKED, waypoints: { 'mine diamond': { x: 0, y: -58, z: 0 } }, health: 8 })
  await hurt.tick(); await wait(60)
  assert.strictEqual(hurt.bot.digs, 0)
  hurt.stop()
  const hungry = rrig({ chestStock: STOCKED, waypoints: { 'mine diamond': { x: 0, y: -58, z: 0 } }, food: 5 })
  await hungry.tick(); await wait(60)
  assert.strictEqual(hungry.bot.digs, 0)
  hungry.stop()
})
test('routine: a job that parks backs the routine off (30 min, doubling)', { timeout: 120000 }, async () => {
  const r = rrig({ chestStock: STOCKED, waypoints: { 'mine diamond': { x: 0, y: -58, z: 0 } } })
  r.bot.noRaycast()                                                            // cannot verify what it sees -> the job parks
  await r.tick(); await r.idle()
  const first = r.stateFile().routine
  assert.ok(first.backoff >= 1800000 - 1)
  assert.ok(first.nextAt > Date.now() + 1700000)
  assert.strictEqual(r.bot.digs, 0)
  assert.ok(r.said.filter(s => /cannot check what I can see/.test(s)).length <= 1)
  r.stop()
})
test('routine: a manual "mine" replaces the routine job and clears its quiet mode', { timeout: 120000 }, async () => {
  const r = rrig({ chestStock: STOCKED, waypoints: { 'mine diamond': { x: 0, y: -58, z: 0 } } })
  r.bot.setBlock(10, -58, 0, 'diamond_ore')
  await r.tick()
  await H.waitFor(() => r.bot.digs >= 6)
  const t = r.brain.scheduler.status().running || r.brain.scheduler.status().queue[0]
  assert.strictEqual(t.name, 'mining')
  r.route('mine iron 1')
  await wait(40)
  const j = r.stateFile()
  assert.strictEqual(j.job.ore, 'iron'); assert.strictEqual(j.auto, false)
  r.route('stop mining'); await wait(40)
  r.stop()
})

test('restart: a mining job Walter started is continued after a restart (and ahead of the excavation); a stopped or parked one is not', { timeout: 120000 }, async () => {
  const fs2 = require('fs')
  const mk = (stateObj) => {
    const dir = fs2.mkdtempSync(path.join(os.tmpdir(), 'mining-restart-'))
    fs2.mkdirSync(path.join(dir, 'state'), { recursive: true })
    fs2.writeFileSync(path.join(dir, 'state', 'mining-state.json'), JSON.stringify(stateObj))
    return dir
  }
  const job = { ore: 'diamond', amount: 3, drop: 'diamond', gained: 0, lastHave: 0, startedAt: 'x', craftAsks: {}, navAsks: 0, said: 0, finished: false }
  const boot = (dir) => {
    const bot = addCrafting(H.extend(mockBot({ pos: [0.5, -58, 0.5] })))
    bot.lavaHeldWhileMoving = []
    bot.goals = { ...bot.goals, GoalNear: class { constructor(x, y, z, r) { Object.assign(this, { x, y, z, r }) } }, GoalBlock: class { constructor(x, y, z) { Object.assign(this, { x, y, z }) } } }
    H.underground(bot, { y: -58 }); bot.give('iron_pickaxe', 1)
    fs2.writeFileSync(path.join(dir, 'chest-index.json'), '{}'); fs2.writeFileSync(path.join(dir, 'waypoints.json'), '{}')
    const brain = attach({
      bot, say: (t) => bot.say(t), goals: bot.goals, tryGoto: bot.tryGoto, stopNav: () => {}, navigateRaw: () => {}, navActive: () => false, handleCommand: () => false,
      farm: { isBusy: () => false, stop() {}, storeCrops: async () => {}, harvest: async () => {} },
      excavation: { isRunning: () => false, stop() {}, start: async () => {}, resume: async () => {}, status() {} },
      routines: { farm: false, lastFarmRun: 0 }, saveRoutines: () => {}, dir, stateDir: path.join(dir, 'state'),
      jobs: { bedRoutine: async () => {} }, stopAllLegacy: () => {}, idleAfterMs: 20, lingerMs: 0,
      moduleEntries: [{ name: 'mining', path: MINING }]
    })
    brain.scheduler.stop()
    return { brain, bot }
  }
  const running = boot(mk({ version: 1, active: true, job, mines: [], stats: { dug: 0, ores: 0, skipped: {} } }))
  const st = running.brain.scheduler.status()
  const t = st.running || st.queue.find(x => x.name === 'mining')
  assert.ok(t, 'continued after the restart: ' + JSON.stringify(st))
  assert.strictEqual(t.priority, 11, 'Walter\'s job runs one step ahead of the excavation (priority 10)')
  running.brain.stop()
  for (const old of [{ version: 1, active: false, job, mines: [], pauseReason: 'stopped by Walter.' }, { version: 1, active: true, job: { ...job, finished: true }, mines: [] }, { version: 1, active: false, job: null, mines: [] }]) {
    const b = boot(mk(old))
    const s2 = b.brain.scheduler.status()
    assert.ok(!s2.running && !s2.queue.some(x => x.name === 'mining') && !s2.parked.some(x => x.name === 'mining'), 'not started: ' + JSON.stringify(old.pauseReason || old.job))
    b.brain.stop()
  }
})

test('routine: it does not start at dusk or at night (Walters own command still does)', { timeout: 120000 }, async () => {
  const r = rrig({ chestStock: STOCKED, waypoints: { 'mine diamond': { x: 0, y: -58, z: 0 } } })
  r.bot.time.timeOfDay = 14000
  await r.tick(); await wait(80)
  assert.strictEqual(r.brain.scheduler.status().running, null)
  assert.strictEqual(r.bot.digs, 0)
  r.bot.time.timeOfDay = 3000
  await r.tick(); await wait(200)
  assert.ok(r.brain.scheduler.status().running || r.brain.scheduler.status().queue.length, 'daylight: it starts')
  r.route('stop mining'); await wait(40)
  r.stop()
})
