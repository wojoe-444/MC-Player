const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const register = require('../brain/safety')
const { Scheduler, PRIORITY } = require('../brain/scheduler')
const safehand = require('../brain/safehand')
const { mockBot } = require('./mock-bot')
const wait = (ms) => new Promise(r => setTimeout(r, ms))

const FAST = { calmMs: 150, scanMs: 20, eatGapMs: 0, holdMaxMs: 400, holdCooldownMs: 100000 }

function rig({ mode = 'warn', health = 20, food = 20, items = ['stone_sword', 'cobblestone'], config = {}, withSafehand = true } = {}) {
  const bot = mockBot({ pos: [0, 64, 0], health, food })
  for (const i of items) bot.give(i, 5)
  for (let x = -40; x <= 40; x++) for (let z = -40; z <= 40; z++) bot.setBlock(x, 63, z, 'stone')       // solid ground (no drops)
  bot.equipSwordFirst = () => {}
  // dig / place must never be touched by this module
  bot.dig = bot.placeBlock = () => { throw new Error('safety module must never dig or place') }
  // record what the hand held at the moment a movement goal was set
  const origSet = bot.pathfinder.setGoal.bind(bot.pathfinder)
  bot.goalHands = []
  bot.pathfinder.setGoal = (g, dyn) => { if (g) bot.goalHands.push(bot.heldItem && bot.heldItem.name); origSet(g) }
  bot.consume = async () => {
    const h = bot.heldItem
    if (!h || !bot.registry.foodsByName[h.name]) throw new Error('not food')
    bot.food = Math.min(20, bot.food + bot.registry.foodsByName[h.name].foodPoints)
    bot.health = Math.min(20, bot.health + 2)
    bot.take(h.name, 1); bot.actions.push(['eat', h.name])
  }
  const sched = new Scheduler({ graceMs: 100 })
  const said = []
  const sh = withSafehand ? safehand({ bot }) : null
  const rt = require('../brain/safety').install({ bot, say: (t) => said.push(t), goals: bot.goals, scheduler: sched, PRIORITY, safehand: sh, config: { ...FAST, ...config } })
  rt.setMode(mode)
  return { bot, sched, said, rt }
}
const addMob = (bot, id, name, x, z) => { bot.entities[id] = { id, name, type: 'hostile', position: new Vec3(x, 64, z), height: 1.95 } }
async function until(fn, ms = 3000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await wait(15) } return fn() }

test('warn mode: backs away, tells Walter, never attacks, never digs/places/activates', async () => {
  const { bot, sched, said, rt } = rig()
  addMob(bot, 7, 'zombie', 4, 0)
  rt.scan(); await wait(200)
  assert.ok(said.some(t => /zombie/.test(t)))
  assert.ok(bot.pathfinder._goal && bot.pathfinder._goal.goal, 'GoalInvert away from the zombie')
  assert.ok(!bot.actions.some(a => a[0] === 'attack' || a[0] === 'activate'))
  delete bot.entities[7]
  assert.ok(await until(() => { rt.scan(); return !sched.running }))
  assert.strictEqual(bot.pathfinder._goal, null, 'goal cleared when done')
})

test('lava bucket in hand is swapped out BEFORE any movement goal is set', async () => {
  for (const withSafehand of [true, false]) {
    const { bot, sched, rt } = rig({ items: ['stone_sword', 'lava_bucket'], withSafehand })
    await bot.equip('lava_bucket')
    addMob(bot, 7, 'zombie', 4, 0)
    rt.scan(); await until(() => bot.goalHands.length > 0)
    assert.ok(bot.goalHands.length > 0)
    assert.ok(bot.goalHands.every(h => h !== 'lava_bucket'), `hand at setGoal: ${bot.goalHands}`)
    delete bot.entities[7]; await until(() => { rt.scan(); return !sched.running })
  }
})

test('lava in hand and nothing else to hold: refuses to move and says so', async () => {
  const { bot, sched, said, rt } = rig({ items: [], withSafehand: false })
  bot.give('lava_bucket'); await bot.equip('lava_bucket')
  bot.unequip = async () => {}                           // simulate: cannot clear the hand
  addMob(bot, 7, 'zombie', 4, 0)
  rt.scan(); await wait(200)
  assert.strictEqual(bot.goalHands.length, 0)
  assert.ok(said.some(t => /cannot move safely/.test(t)))
  delete bot.entities[7]; await until(() => { rt.scan(); return !sched.running })
})

test('fight mode: equips the stone sword, attacks the zombie, then hands back to the paused job', async () => {
  const { bot, sched, said, rt } = rig({ mode: 'fight' })
  const log = []
  sched.submit({ name: 'furnace', priority: PRIORITY.FURNACE, async run(ctx) { log.push(ctx.resumed ? 'resume' : 'start'); await ctx.sleep(10000) } })
  await wait(30)
  addMob(bot, 7, 'zombie', 2, 0)
  rt.scan(); await wait(150)
  assert.strictEqual(sched.running.name, 'safety')
  assert.strictEqual(bot.heldItem.name, 'stone_sword')
  assert.ok(bot.actions.some(a => a[0] === 'attack' && a[1] === 'zombie'))
  assert.ok(said.some(t => /Fighting zombie/.test(t)))
  delete bot.entities[7]
  assert.ok(await until(() => { rt.scan(); return sched.running && sched.running.name === 'furnace' }))
  assert.deepStrictEqual(log, ['start', 'resume'])
  sched.cancel('furnace'); await wait(30)
})

test('creeper approaching: retreats even in fight mode, never attacks', async () => {
  const { bot, sched, rt } = rig({ mode: 'fight' })
  addMob(bot, 7, 'creeper', 4, 0)
  rt.scan(); await wait(150)
  assert.ok(bot.pathfinder._goal && bot.pathfinder._goal.goal)
  assert.ok(!bot.actions.some(a => a[0] === 'attack'))
  delete bot.entities[7]; await until(() => { rt.scan(); return !sched.running })
})

test('approach detection: warns about a zombie coming from 14 blocks before it is in fighting range', async () => {
  const { bot, said, rt, sched } = rig()
  addMob(bot, 7, 'zombie', 0, -14)
  const walk = setInterval(() => { bot.entities[7].position = bot.entities[7].position.offset(0, 0, 0.35) }, 50)   // ~7 blocks/s
  for (let i = 0; i < 12; i++) { rt.scan(); await wait(60) }
  clearInterval(walk)
  assert.ok(said.some(t => /zombie approaching from north/.test(t)), said.join(' | '))
  delete bot.entities[7]; await until(() => { rt.scan(); return !sched.running })
})

test('low health, nobody around: pauses tasks, says so once, eats, releases when healthy', async () => {
  const { bot, sched, said, rt } = rig({ health: 5, food: 8, items: ['stone_sword', 'bread', 'rotten_flesh'] })
  let ran = 0
  rt.scan()
  assert.strictEqual(sched.running.name, 'safety')
  sched.submit({ name: 'chat-job', priority: PRIORITY.CHAT, async run(ctx) { ran++; await wait(1) } })
  await until(() => bot.actions.some(a => a[0] === 'eat'))
  assert.ok(bot.actions.some(a => a[0] === 'eat' && a[1] === 'bread'))
  assert.ok(!bot.actions.some(a => a[0] === 'eat' && a[1] === 'rotten_flesh'))
  assert.strictEqual(bot.heldItem.name, 'stone_sword', 'sword back in hand after eating')
  bot.health = 20
  assert.ok(await until(() => { rt.scan(); return ran === 1 }, 2000), 'lower priority job runs after recovery')
  assert.strictEqual(said.filter(t => /Pausing my tasks/.test(t)).length, 1)
})

test('low health with no food: stops blocking other tasks after holdMax and tells Walter', async () => {
  const { bot, sched, said, rt } = rig({ health: 5, food: 10, items: ['stone_sword'] })
  let ran = 0
  rt.scan()
  sched.submit({ name: 'chat-job', priority: PRIORITY.CHAT, async run() { ran++ } })
  assert.ok(await until(() => { rt.scan(); return ran === 1 }, 3000))
  assert.ok(said.some(t => /not recovering/.test(t)))
  assert.ok(said.some(t => /no food/i.test(t)))
})

test('hurt and a zombie close: does not stop to eat next to it', async () => {
  const { bot, sched, rt } = rig({ mode: 'warn', health: 6, food: 10, items: ['stone_sword', 'bread'] })
  addMob(bot, 7, 'zombie', 3, 0)
  rt.scan(); await wait(250)
  assert.ok(!bot.actions.some(a => a[0] === 'eat'))
  delete bot.entities[7]; await until(() => { rt.scan(); return !sched.running }, 1500)
})

test('mode is persisted and restored', () => {
  const fs = require('fs'), os = require('os'), path = require('path')
  const f = path.join(os.tmpdir(), `safety-state-${process.pid}.json`)
  try {
    const mk = () => require('../brain/safety').install({ bot: mockBot(), say() {}, goals: {}, scheduler: new Scheduler(), PRIORITY, stateFile: f })
    mk().setMode('fight')
    assert.strictEqual(mk().getMode(), 'fight')
    fs.writeFileSync(f, '{broken'); assert.strictEqual(mk().getMode(), 'fight', 'default is fight')
    mk().setMode('warn'); assert.strictEqual(mk().getMode(), 'warn')
  } finally { try { fs.unlinkSync(f) } catch { /* none */ } }
})

test('scan never throws, even with junk entities', () => {
  const { bot, rt } = rig()
  bot.entities[1] = { id: 1, name: 'zombie', type: 'hostile' }          // no position
  bot.entities[2] = null
  assert.doesNotThrow(() => rt.scan())
})

// ---- register(api) per INTERFACE.md ----
function fakeApi() {
  const bot = mockBot({ pos: [0, 64, 0] }); bot.give('stone_sword')
  const cmds = [], said = []
  const api = {
    bot, PRIORITY, scheduler: new Scheduler(), say: (t) => said.push(t), goals: bot.goals, tryGoto: bot.tryGoto, stopNav() {}, safehand: safehand({ bot }),
    ownerName: 'OGWO', statePath: (f) => require('path').join(require('os').tmpdir(), `safety-reg-${process.pid}-${f}`), log() {}, now: Date.now,
    commands: { add: (c) => cmds.push(c), list: () => cmds, dispatch: () => false }
  }
  return { api, cmds, said, bot }
}
const find = (cmds, text) => cmds.filter(c => (typeof c.match === 'function' ? c.match('OGWO', text) : c.match.test(text))).map(c => c.name)

test('register: returns the module shape and three commands', () => {
  const { api, cmds } = fakeApi()
  const m = register(api)
  assert.strictEqual(m.name, 'safety')
  for (const k of ['start', 'stop', 'status']) assert.strictEqual(typeof m[k], 'function')
  assert.deepStrictEqual(cmds.map(c => c.name).sort(), ['creeper-strike-off', 'creeper-strike-on', 'entomb-off', 'entomb-on', 'fight-mode', 'lessons', 'loadout-check', 'mob-status', 'no-fight', 'pack-up'])
  assert.strictEqual(cmds.find(c => c.name === 'fight-mode').risk, 'high')
  assert.doesNotThrow(() => JSON.stringify(m.status()))
  m.stop()
})

test('chat phrases: fight / no fight / status', () => {
  const { api, cmds, said } = fakeApi()
  const m = register(api)
  const fight = ['you can fight', 'fight back', 'defend yourself', 'defend me', 'you can attack zombies', 'kill the mobs', 'attack mobs']
  const nofight = ['do not fight', "don't fight", 'dont fight', 'no fighting', 'stop fighting', 'just retreat', 'run away', 'never attack mobs', 'do not fight back']
  const status = ['mob status', 'any mobs near', 'safety status']
  for (const t of fight) assert.deepStrictEqual(find(cmds, t), ['fight-mode'], t)
  for (const t of nofight) assert.deepStrictEqual(find(cmds, t), ['no-fight'], t)
  for (const t of status) assert.deepStrictEqual(find(cmds, t), ['mob-status'], t)
  for (const t of ['follow me', 'go to the farm', 'harvest', 'sleep', 'inventory', 'come here', 'stop', 'stay']) assert.deepStrictEqual(find(cmds, t), [], t)
  cmds.find(c => c.name === 'fight-mode').run(); assert.strictEqual(m.rt.getMode(), 'fight')
  cmds.find(c => c.name === 'no-fight').run(); assert.strictEqual(m.rt.getMode(), 'warn')
  cmds.find(c => c.name === 'mob-status').run()
  assert.ok(said.some(t => /Mode warn, creeper melee on, wall-in on, health 20\/20/.test(t)))
  const strike = ['hit creepers and back off', 'you can melee creepers', 'fight creepers with your sword']
  const nostrike = ['do not melee creepers', "don't hit creepers", 'only run from creepers', 'never attack creepers']
  for (const t of strike) assert.deepStrictEqual(find(cmds, t), ['creeper-strike-on'], t)
  for (const t of nostrike) assert.ok(find(cmds, t).includes('creeper-strike-off'), t)
  cmds.find(c => c.name === 'creeper-strike-on').run(); assert.strictEqual(m.rt.getCreeperStrike(), true)
  cmds.find(c => c.name === 'creeper-strike-off').run(); assert.strictEqual(m.rt.getCreeperStrike(), false)
  m.stop()
  try { require('fs').unlinkSync(api.statePath('safety-state.json')) } catch { /* none */ }
})
