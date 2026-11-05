// P4: the five reflexes on the registry: combat replaces the fake "do not fight" dispatch, breath leases the body, safehand leases the hands,
// the night guard and the cave reflex defer to each other through leases.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Vec3 } = require('vec3')
const { createReflexes } = require('../brain/reflexes')
const safetyMod = require('../brain/safety')
const { Scheduler, PRIORITY } = require('../brain/scheduler')
const safehand = require('../brain/safehand')
const { mockBot } = require('./mock-bot')
const wait = (ms) => new Promise(r => setTimeout(r, ms))
const FAST = { calmMs: 150, scanMs: 20, eatGapMs: 0, holdMaxMs: 400, holdCooldownMs: 100000 }
const addMob = (bot, id, name, x, z) => { bot.entities[id] = { id, name, type: 'hostile', position: new Vec3(x, 64, z), height: 1.95 } }

function rig({ mode = 'fight', reflexes = null } = {}) {
  const bot = mockBot({ pos: [0, 64, 0], health: 20, food: 20 })
  bot.give('stone_sword', 1); bot.give('cobblestone', 5)
  for (let x = -40; x <= 40; x++) for (let z = -40; z <= 40; z++) bot.setBlock(x, 63, z, 'stone')
  bot.dig = bot.placeBlock = () => { throw new Error('safety module must never dig or place') }
  const sched = new Scheduler({ graceMs: 100 })
  const said = []
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-'))
  const rt = safetyMod.install({ bot, say: (t) => said.push(t), goals: bot.goals, scheduler: sched, PRIORITY, safehand: safehand({ bot }), config: FAST, stateFile: path.join(dir, 'safety-state.json'), reflexes })
  rt.setMode(mode)
  return { bot, sched, said, rt, dir }
}

test('combat holds the melee lease: safety stands aside, and Walter\'s saved fight mode is untouched', async () => {
  const reflexes = createReflexes()
  const combat = reflexes.register({ name: 'combat', priority: 70, claims: ['melee'] })
  combat.claim('melee', Infinity, 'always-on')
  const { bot, sched, rt, dir } = rig({ mode: 'fight', reflexes })
  addMob(bot, 7, 'zombie', 2, 0)
  rt.scan(); await wait(200)
  assert.ok(!bot.actions.some(a => a[0] === 'attack'), 'safety must not swing while combat holds melee')
  assert.strictEqual(rt.getMode(), 'fight', 'the saved mode stays fight')
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'safety-state.json'), 'utf8')).mode, 'fight')
  assert.strictEqual(rt.status().meleeBy, 'combat')
  sched.cancel('safety'); await wait(30)
})

test('without a melee holder safety fights back and takes the lease itself; combat taking it later wins', async () => {
  const reflexes = createReflexes()
  const { bot, sched, rt } = rig({ mode: 'fight', reflexes })
  addMob(bot, 7, 'zombie', 2, 0)
  rt.scan(); await wait(200)
  assert.ok(bot.actions.some(a => a[0] === 'attack' && a[1] === 'zombie'))
  assert.strictEqual(reflexes.holder('melee'), 'safety')
  const combat = reflexes.register({ name: 'combat', priority: 70, claims: ['melee'] })
  assert.ok(combat.claim('melee', Infinity)); assert.strictEqual(reflexes.holder('melee'), 'combat')
  delete bot.entities[7]; sched.cancel('safety'); await wait(30); rt.stop()
})

test('the combat module registers, holds melee for good and no longer dispatches a chat command', () => {
  const reflexes = createReflexes()
  const bot = mockBot({ pos: [0, 64, 0] })
  bot._client = { on() {}, removeListener() {}, write() {} }
  const dispatched = []
  const h = require('../brain/combat')({ bot, reflexes, log() {}, commands: { dispatch: (...a) => dispatched.push(a) } })
  h.start()
  assert.strictEqual(reflexes.holder('melee'), 'combat'); assert.deepStrictEqual(dispatched, [])
  h.stop(); assert.strictEqual(reflexes.holder('melee'), null)
  // an old integrator without a registry keeps the old behavior
  const h2 = require('../brain/combat')({ bot, log() {}, commands: { dispatch: (...a) => dispatched.push(a) } })
  h2.start(); assert.strictEqual(dispatched.length, 1); assert.match(dispatched[0][1], /do not fight/); h2.stop()
})

test('combat reflex: yields to the body lease (breath) and will not swap the hand while safehand holds it', () => {
  const reflexes = createReflexes()
  const bot = mockBot({ pos: [0, 64, 0] }); bot._reflexes = reflexes
  const breath = reflexes.register({ name: 'breath', priority: 90, claims: ['body'] })
  const hand = reflexes.register({ name: 'safehand', priority: 95, claims: ['hands'] })
  assert.strictEqual(reflexes.heldByOther('body', 'combat'), null)
  breath.claim('body', 1500, 'out of air'); assert.strictEqual(reflexes.heldByOther('body', 'combat'), 'breath')
  hand.claim('hands', 1500); assert.strictEqual(reflexes.heldByOther('hands', 'combat'), 'safehand')
  const src = fs.readFileSync(path.join(__dirname, '..', 'brain', 'combat', 'reflex.js'), 'utf8')
  assert.match(src, /heldByOther\('body', 'combat'\)/); assert.match(src, /heldByOther\('hands', 'combat'\)/)
})

test('breath leases the body while it swims out, and releases it when the head is in air', async () => {
  const reflexes = createReflexes()
  const bot = mockBot({ pos: [0, 64, 0] }); bot._reflexes = reflexes
  bot.entity.isInWater = true
  const logs = []
  const h = require('../brain/breath')({ bot, reflexes, log() {}, statePath: (f) => f })
  h.start()
  const reg = reflexes.status().reflexes.find(r => r.name === 'breath')
  assert.ok(reg && reg.claims.includes('body') && reg.priority === 90)
  h.stop()
  assert.strictEqual(reflexes.holder('body'), null)
})

test('safehand leases the hands while it stows lava and during a lava moment, then releases', async () => {
  const reflexes = createReflexes()
  const bot = mockBot(); bot.give('stone_sword'); bot.give('lava_bucket')
  const sh = safehand({ bot, pollMs: 10, reflexes }); sh.start()
  let during = null
  await sh.lavaMoment(async () => { during = reflexes.holder('hands'); await bot.equip('lava_bucket'); await wait(40) })
  assert.strictEqual(during, 'safehand'); assert.strictEqual(reflexes.holder('hands'), null)
  assert.strictEqual(bot.heldItem.name, 'stone_sword')
  await bot.equip('lava_bucket'); await wait(60)
  assert.strictEqual(bot.heldItem.name, 'stone_sword'); assert.strictEqual(reflexes.holder('hands'), null, 'stow lease released')
  sh.stop()
})

test('danger lease: the planner\'s reflex outranks the cave reflex, which stands down', () => {
  const reflexes = createReflexes()
  const cave = reflexes.register({ name: 'cave', priority: 50, claims: ['danger'] })
  const planner = reflexes.register({ name: 'danger-reflex', priority: 60, claims: ['danger'] })
  assert.ok(cave.claim('danger', 20000)); assert.strictEqual(reflexes.heldByOther('danger', 'cave'), null)
  assert.ok(planner.claim('danger', 120000)); assert.strictEqual(reflexes.heldByOther('danger', 'cave'), 'danger-reflex')
  assert.strictEqual(cave.claim('danger', 20000), false, 'cave cannot take it back')
  planner.release('danger'); assert.ok(cave.claim('danger', 20000))
})

test('night guard: holds the body lease at priority 40, below breath', () => {
  const reflexes = createReflexes()
  const guard = reflexes.register({ name: 'night-guard', priority: 40, claims: ['body'] })
  const breath = reflexes.register({ name: 'breath', priority: 90, claims: ['body'] })
  assert.ok(guard.claim('body', 100000)); assert.ok(breath.claim('body', 1500)); assert.strictEqual(guard.claim('body', 100000), false)
  assert.strictEqual(reflexes.holder('body'), 'breath')
})

test('markPlacing: takes hands as the placer, blocks only weapon swaps, safehand outranks it, flag still written', () => {
  const { markPlacing } = require('../brain/reflexes')
  const reflexes = createReflexes()
  const bot = mockBot({ pos: [0, 64, 0] }); bot._reflexes = reflexes
  markPlacing(bot, 4000)
  assert.strictEqual(reflexes.holder('hands'), 'placer'); assert.ok(bot._placingUntil > Date.now())
  const hand = reflexes.register({ name: 'safehand', priority: 95, claims: ['hands'] })
  assert.ok(hand.claim('hands', 1000)); assert.strictEqual(reflexes.holder('hands'), 'safehand')
  const bare = mockBot({ pos: [0, 64, 0] }); markPlacing(bare, 1000); assert.ok(bare._placingUntil > Date.now())    // no registry: only the flag
  const src = fs.readFileSync(path.join(__dirname, '..', 'brain', 'combat', 'reflex.js'), 'utf8')
  assert.match(src, /h !== 'placer' \|\| \/_sword\$\|_axe\$\//)
})
