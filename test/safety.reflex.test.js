const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'), os = require('os'), path = require('path')
const { Vec3 } = require('vec3')
const register = require('../brain/safety')
const { Scheduler, PRIORITY } = require('../brain/scheduler')
const safehand = require('../brain/safehand')
const { mockBot } = require('./mock-bot')
const { rig, addMob, until, wait } = require('./safety.combat.helpers')

const roof = (bot) => { for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) bot.setBlock(x, 80, z, 'stone') }

// ---------- early retreat: below 10; 12 when unprepared underground ----------
test('underground and unprepared (no armor, no torches, little cobble): disengages at 11.5 health; fully prepared it keeps fighting', async () => {
  const bare = rig({ items: ['stone_sword'] }); roof(bare.bot); bare.rt.scan(); bare.bot.health = 11.5; addMob(bare.bot, 7, 'zombie', 3, 0)
  bare.rt.scan(); await wait(250)
  assert.ok(bare.bot.goalLog.some(g => g.kind === 'away' || g.kind === 'follow'), 'retreat goal')
  assert.ok(!bare.bot.actions.some(a => a[0] === 'attack'))
  assert.deepStrictEqual(bare.rt.preparedness().why.sort(), ['armor', 'filler', 'food', 'torches'])
  delete bare.bot.entities[7]; await until(() => { bare.rt.scan(); return !bare.sched.running }, 4000)

  const ready = rig({ items: ['stone_sword', 'iron_helmet', 'iron_chestplate'] }); roof(ready.bot)
  ready.bot.give('torch', 20); ready.bot.give('cobblestone', 64); ready.bot.give('bread', 10)
  ready.rt.scan(); ready.bot.health = 11.5; addMob(ready.bot, 7, 'zombie', 3, 0)
  ready.rt.scan(); await wait(300)
  assert.strictEqual(ready.rt.preparedness().unprepared, false)
  assert.ok(ready.bot.actions.some(a => a[0] === 'attack'), 'prepared bot keeps fighting at 11.5')
  delete ready.bot.entities[7]; await until(() => { ready.rt.scan(); return !ready.sched.running }, 4000)
})
test('on the surface unprepared does not matter (no 12 health reflex)', async () => {
  const { bot, sched, rt } = rig({ items: ['stone_sword'] })
  rt.scan(); bot.health = 11.5; addMob(bot, 7, 'zombie', 3, 0); rt.scan(); await wait(300)
  assert.strictEqual(rt.preparedness().unprepared, false)
  assert.ok(bot.actions.some(a => a[0] === 'attack'))
  delete bot.entities[7]; await until(() => { rt.scan(); return !sched.running }, 4000)
})

// ---------- standing ground (the shaft bottom) ----------
test('standGround: four zombies do not make it run, it hits what reaches it and never follows; low health still retreats', async () => {
  const { bot, sched, rt } = rig({ items: ['stone_sword'] })
  rt.standGround(30000)
  for (const [i, x] of [[1, 2.5], [2, 3], [3, 3.4], [4, 6]]) addMob(bot, i, 'zombie', x, i - 2)
  for (let i = 0; i < 8; i++) { rt.scan(); await wait(100) }
  assert.ok(bot.actions.some(a => a[0] === 'attack'))
  assert.ok(!bot.goalLog.some(g => g.kind === 'away' || g.kind === 'follow'), `goals: ${bot.goalLog.map(g => g.kind)}`)
  bot.health = 7
  for (let i = 0; i < 6; i++) { rt.scan(); await wait(100) }
  assert.ok(bot.goalLog.length > 0, 'retreats at low health')
  for (let i = 1; i <= 4; i++) delete bot.entities[i]; bot.health = 20; await until(() => { rt.scan(); return !sched.running }, 6000)
})

// ---------- hard prep before descent ----------
function guardRig({ items = {}, commands = null } = {}) {
  const bot = mockBot({ pos: [0.5, 64, 0.5] }); for (const [n, c] of Object.entries(items)) bot.give(n, c)
  for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) bot.setBlock(x, 63, z, 'stone')
  const sched = new Scheduler({ graceMs: 100, idleAfterMs: 0 }), said = [], dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'))
  const api = {
    bot, PRIORITY, scheduler: sched, say: (t) => said.push(t), goals: bot.goals, tryGoto: bot.tryGoto, stopNav() {}, safehand: safehand({ bot }), ownerName: 'OGWO', dir,
    statePath: (f) => path.join(dir, f), log() {}, now: Date.now, commands: commands || { add() {}, list: () => [], dispatch: () => false }
  }
  const m = register(api); m.start()
  return { bot, sched, said, m, api, cleanup: () => { m.stop(); fs.rmSync(dir, { recursive: true, force: true }) } }
}
const miningDef = (spy) => ({ name: 'mining', key: 'mining', priority: 11, async run() { spy.n++; return { status: 'done' } } })

test('descent guard: mining does not start without torches / sword / pickaxe / food; says what is missing; retries; starts once the bag is right', async () => {
  const g = guardRig({ items: { cobblestone: 64 } }); const spy = { n: 0 }
  g.sched.submit(miningDef(spy))
  await wait(250)
  assert.strictEqual(spy.n, 0, 'held back')
  assert.ok(g.said.some(t => /Not going down yet: need .*torches 0\/16/.test(t)), g.said.join(' | '))
  assert.ok(/sword/.test(g.said.join(' ')) && /pickaxe/.test(g.said.join(' ')) && /food/.test(g.said.join(' ')))
  const t = g.sched.tasks.find(x => x.name === 'mining'); assert.ok(t && t.status === 'paused', `status ${t && t.status}`)
  for (const [n, c] of [['stone_sword', 1], ['stone_pickaxe', 1], ['torch', 20], ['bread', 12]]) g.bot.give(n, c)
  t.notBefore = 0; g.sched.pump(); await until(() => spy.n === 1, 2000)
  assert.strictEqual(spy.n, 1, 'goes down once prepared')
  g.cleanup()
})
test('descent guard: crafting is asked for torches first and the wait ends when they arrive', async () => {
  const cmds = []
  const g = guardRig({ items: { cobblestone: 64, stone_sword: 1, stone_pickaxe: 1, bread: 12 }, commands: { add() {}, list: () => [], dispatch: (u, text) => { cmds.push(text); setTimeout(() => g.bot.give('torch', 16), 40); return true } } })
  const spy = { n: 0 }; g.sched.submit(miningDef(spy))
  await until(() => spy.n === 1, 4000)
  assert.deepStrictEqual(cmds, ['craft 16 torch']); assert.strictEqual(spy.n, 1)
  g.cleanup()
})
test('descent guard: after four rounds it goes anyway, says what it lacks, never deadlocks', async () => {
  const g = guardRig({ items: { cobblestone: 64 } }); const spy = { n: 0 }
  g.sched.submit(miningDef(spy))
  for (let i = 0; i < 6 && spy.n === 0; i++) { await wait(200); const t = g.sched.tasks.find(x => x.name === 'mining'); if (t) { t.notBefore = 0; g.sched.pump() } }
  await until(() => spy.n === 1, 2000)
  assert.strictEqual(spy.n, 1)
  assert.ok(g.said.some(t => /Going down short of/.test(t)))
  g.cleanup()
})
test('descent guard: only the mining task is guarded', async () => {
  const g = guardRig({}); const spy = { n: 0 }
  g.sched.submit({ name: 'farm', key: 'farm', priority: 40, async run() { spy.n++ } })
  await until(() => spy.n === 1, 1500); assert.strictEqual(spy.n, 1)
  g.cleanup()
})
