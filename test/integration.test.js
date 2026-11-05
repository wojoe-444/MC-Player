const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { mockBot } = require('./mock-bot')
const attach = require('../brain')
const config = require('../brain/furnace-config.json')
const wait = (ms) => new Promise(r => setTimeout(r, ms))

function rig(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-'))
  const bot = mockBot({ pos: [-1045, 128, 2276] })
  bot.give('stone_sword'); bot.give('cobblestone', 60)
  bot.world.raycast = () => null   // open space: line-of-sight rules have their own tests (los.test.js); the mock has no floors to stand on
  for (const u of config.stations.flatMap(s => s.units)) bot.setBlock(...u.furnace, 'furnace')
  bot.addChest(-1043, 131, 2274, 27, { lava_bucket: 1 }); bot.addChest(-1043, 132, 2273, 27, {}); bot.addChest(-1043, 128, 2273, 54, { bucket: 4 })
  bot.addChest(-1051, 154, 2323, 27, {}); bot.addChest(-1051, 155, 2324, 54, {}); bot.addChest(-1051, 151, 2324, 54, {})
  bot.addChest(-1051, 154, 2326, 27, {}); bot.addChest(-1051, 155, 2325, 27, {}); bot.addChest(-1051, 151, 2325, 54, { bucket: 2 })
  for (const d of config.depots) for (let x = d.box.min[0]; x <= d.box.max[0]; x++) for (let y = d.box.min[1]; y <= d.box.max[1]; y++) for (let z = d.box.min[2]; z <= d.box.max[2]; z++) bot.setBlock(x, y, z, 'lava_cauldron')
  const said = [], calls = []
  let navGoal = null
  const legacy = []
  const farmState = { busy: false }
  const farm = { isBusy: () => farmState.busy, stop: () => { farmState.stop = true }, storeCrops: async () => {}, async harvest(o) { calls.push(['harvest', o]); farmState.busy = true; for (let i = 0; i < 20 && !farmState.stop; i++) await wait(10); farmState.busy = false; farmState.stop = false } }
  const exc = { running: false, stopFlag: false, isRunning: () => exc.running, stop: () => { exc.stopFlag = true },
    async resume() { calls.push(['exc-resume']); exc.running = true; while (!exc.stopFlag) await wait(10); exc.stopFlag = false; exc.running = false },
    async start() { calls.push(['exc-start']); return exc.resume() } }
  const routines = { farm: false, lastFarmRun: 0 }
  const brain = attach({
    bot, say: (t) => { said.push(t); bot.say(t) }, goals: bot.goals, tryGoto: bot.tryGoto, stopNav: () => { navGoal = null; bot.pathfinder.setGoal(null) },
    navigateRaw: (g, l, d) => { navGoal = { g, l, d }; calls.push(['nav', l]) }, navActive: () => !!navGoal,
    handleCommand: (u, t) => { legacy.push(t); return /^(inventory|status)$/.test(t) },
    farm, excavation: exc, routines, saveRoutines: () => {}, dir, stateDir: path.join(dir, 'state'), jobs: { bedRoutine: async () => { calls.push(['bed']) } },
    stopAllLegacy: () => { exc.stop(); farm.stop() }, idleAfterMs: 50, safetyCooldownMs: 0, lingerMs: 0, moduleEntries: [], ...extra
  })
  return { brain, bot, said, calls, legacy, exc, dir, routines, getNav: () => navGoal, clearNav: () => { navGoal = null } }
}
const finish = (r) => { r.brain.stop() }

test('stock routines: sleep+furnace+farm registered, furnace and farm off until Walter says go', () => {
  const r = rig()
  const names = r.brain.scheduler.status().routines
  assert.deepStrictEqual(names.map(x => x.name).sort(), ['bag-room', 'farm', 'furnace', 'sleep'])
  assert.strictEqual(names.find(x => x.name === 'furnace').enabled, false)
  assert.strictEqual(names.find(x => x.name === 'sleep').enabled, true)
  assert.strictEqual(names.find(x => x.name === 'farm').enabled, false)
  finish(r)
})

test('"start furnace upkeep" enables it and does a first pass with lava never held while walking', async () => {
  const r = rig()
  assert.strictEqual(r.brain.route('OGWO', 'hey can you please start furnace upkeep', { handleCommand: () => false }), true)
  await wait(300)
  assert.strictEqual(r.brain.scheduler.isEnabled('furnace'), true)
  assert.ok(r.bot.chestItems(-1051, 154, 2323).lava_bucket > 0 || r.bot.chestItems(-1051, 154, 2326).lava_bucket > 0)
  assert.deepStrictEqual(r.bot.lavaHeldWhileMoving, [])
  finish(r)
})

test('furnace plan is read only; furnace status answers from cache', async () => {
  const r = rig()
  r.brain.route('OGWO', 'furnace plan', {}); await wait(200)
  assert.ok(r.said.some(t => /Fuel chests:/.test(t)))
  assert.ok(!r.bot.actions.some(a => ['withdraw', 'deposit', 'activate'].includes(a[0])))
  r.brain.route('OGWO', 'furnace status', {})
  assert.ok(r.said.some(t => /Furnace lava buckets: S1 1/.test(t)))
  finish(r)
})

test('Walter chat makes the idle furnace job yield; stop parks excavation until resume', async () => {
  const r = rig()
  r.brain.route('OGWO', 'excavate', {}); await wait(100)
  assert.strictEqual(r.brain.scheduler.status().running.name, 'excavation')
  // an explicit chat task (nav) preempts excavation, excavation resumes afterwards
  r.brain.navigate('G', 'you', false); await wait(100)
  assert.strictEqual(r.brain.scheduler.status().running.name, 'nav')
  r.clearNav(); await wait(500)
  assert.strictEqual(r.brain.scheduler.status().running.name, 'excavation')
  // stop: parks excavation
  r.brain.userStop(); await wait(100)
  assert.strictEqual(r.brain.scheduler.status().running, null)
  assert.strictEqual(r.brain.scheduler.status().parked[0].name, 'excavation')
  // not resumed on its own...
  await wait(200)
  assert.strictEqual(r.brain.scheduler.status().running, null)
  // ...but by Walter's go
  r.brain.route('OGWO', 'resume', {}); await wait(100)
  assert.strictEqual(r.brain.scheduler.status().running.name, 'excavation')
  r.brain.userStop(); await wait(50)
  finish(r)
})

test('navigate(): new goal replaces the old one, safety-style preemption resumes the goal', async () => {
  const r = rig()
  r.brain.navigate('A', 'a', true); await wait(50)
  r.brain.navigate('B', 'b', true); await wait(100)
  assert.deepStrictEqual(r.calls.filter(c => c[0] === 'nav').map(c => c[1]), ['a', 'b'])
  r.brain.scheduler.submit({ name: 'safety', priority: 100, preemptible: false, run: async (ctx) => { await ctx.sleep(80) } })
  await wait(40); assert.strictEqual(r.getNav(), null, 'nav stopped while safety runs')
  await wait(300)
  assert.deepStrictEqual(r.calls.filter(c => c[0] === 'nav').map(c => c[1]), ['a', 'b', 'b'])
  r.brain.userStop(); await wait(50)
  finish(r)
})

test('negated commands do not run the command', async () => {
  const r = rig()
  r.brain.navigate('A', 'a', true); await wait(50)
  assert.strictEqual(r.brain.route('OGWO', "don't follow me", { handleCommand: () => { throw new Error('legacy must not see it') } }), true)
  await wait(50)
  assert.strictEqual(r.brain.scheduler.status().running, null)
  assert.ok(r.said.includes('Okay, not doing that.'))
  finish(r)
})

test('unhandled chat goes to unhandled.log and returns false so the caller acks', () => {
  const r = rig()
  assert.strictEqual(r.brain.route('OGWO', 'is this fun by the way?', { handleCommand: () => false }), false)
  assert.match(fs.readFileSync(path.join(r.dir, 'unhandled.log'), 'utf8'), /OGWO: is this fun by the way\?/)
  assert.strictEqual(r.brain.route('OGWO', 'inventory', {}), true)
  finish(r)
})

test('module loader: good module registered, broken one skipped, chat hooks and status work', async () => {
  const mdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-'))
  fs.mkdirSync(path.join(mdir, 'good')); fs.mkdirSync(path.join(mdir, 'bad'))
  fs.writeFileSync(path.join(mdir, 'good', 'index.js'), `module.exports = (api) => ({ name: 'good', start() { api.commands.add({ name: 'ping', match: /^ping$/, run() { api.say('pong') } }) }, status: () => ({ ok: 1 }), fallback: (u, t) => t === 'maybe' && api.commands.dispatch(u, 'ping') })`)
  fs.writeFileSync(path.join(mdir, 'bad', 'index.js'), `module.exports = () => { throw new Error('nope') }`)
  const r = rig({ moduleEntries: [{ name: 'bad', path: path.join(mdir, 'bad', 'index.js') }, { name: 'good', path: path.join(mdir, 'good', 'index.js') }] })
  assert.strictEqual(r.brain.status().modules.good.ok, 1)
  assert.ok(!('bad' in r.brain.status().modules))
  assert.strictEqual(r.brain.route('OGWO', 'ping', {}), true)
  assert.strictEqual(r.brain.route('OGWO', 'maybe', { handleCommand: () => false }), true)   // fallback -> dispatch
  assert.strictEqual(r.said.filter(t => t === 'pong').length, 2)
  assert.match(fs.readFileSync(path.join(r.dir, 'idle.log'), 'utf8'), /BRAIN_MODULE_ERROR bad/)
  finish(r)
})

test('night: sleep routine preempts excavation, hands off to bedRoutine, then excavation resumes', async () => {
  const r = rig({ sleepWanted: () => true })
  r.bot.time.timeOfDay = 14000
  r.brain.route('OGWO', 'excavate', {}); await wait(100)
  r.brain.scheduler.tick()
  r.brain.scheduler.routines.get('sleep').nextCheck = 0; r.brain.scheduler.tick(); await wait(200)
  assert.ok(r.calls.some(c => c[0] === 'bed'))
  await wait(300)
  assert.strictEqual(r.brain.scheduler.status().running.name, 'excavation')
  r.brain.userStop(); await wait(50)
  finish(r)
})

test('an excavation module (folder name implies provides) replaces the built-in adapter commands', async () => {
  const mdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-'))
  fs.mkdirSync(path.join(mdir, 'excavation'))
  fs.writeFileSync(path.join(mdir, 'excavation', 'index.js'), "module.exports = (api) => ({ name: 'excavation', start() { api.commands.add({ name: 'excavation-go', match: /^excavate$/, run() { api.say('module digs') } }) } })")
  const r = rig({ moduleEntries: [{ name: 'excavation', path: path.join(mdir, 'excavation', 'index.js') }] })
  assert.strictEqual(r.brain.route('OGWO', 'excavate', {}), true)
  assert.ok(r.said.includes('module digs'))
  assert.ok(!r.calls.some(c => c[0] === 'exc-start' || c[0] === 'exc-resume'), 'legacy adapter must not run')
  finish(r)
})

test('idle delay defaults to 15 s, can be changed in chat, and is remembered', async () => {
  const r = rig({ idleAfterMs: undefined })
  assert.strictEqual(r.brain.scheduler.idleAfterMs, 15000)
  r.brain.route('OGWO', 'only start idle jobs after 45 seconds of quiet', { handleCommand: () => false })
  assert.strictEqual(r.brain.scheduler.idleAfterMs, 45000)
  assert.ok(r.said.some(x => /after 45 seconds/.test(x)))
  r.brain.route('OGWO', 'idle delay 2 minutes', {})
  assert.strictEqual(r.brain.scheduler.idleAfterMs, 120000)
  const saved = JSON.parse(fs.readFileSync(path.join(r.dir, 'state', 'scheduler.json'), 'utf8'))
  assert.strictEqual(saved.idleAfterMs, 120000)
  finish(r)
})

test('furnace pass waits while safety tasks keep firing, then runs', async () => {
  const r = rig()
  r.brain.scheduler.submit({ name: 'safety', priority: 100, preemptible: false, run: async (ctx) => { await ctx.sleep(30) } })
  await wait(100)
  r.brain.route('OGWO', 'run furnace upkeep once', {}); await wait(300)
  assert.ok(!r.bot.actions.some(a => a[0] === 'open'), 'no chest work right after a safety task')
  assert.strictEqual(r.brain.scheduler.status().queue.concat(r.brain.scheduler.status().running ? [r.brain.scheduler.status().running] : []).some(t => t.name === 'furnace'), true)
  r.brain.userStop(); finish(r)
})

test('outing: walks, lingers, cannot be taken over by the furnace routine, yields to safety and finishes', async () => {
  const r = rig()
  r.brain.scheduler.setLinger(0)
  r.brain.route('OGWO', 'visit 10 20 for 2 seconds', { handleCommand: () => false })
  await wait(120)
  assert.strictEqual(r.brain.scheduler.status().running.name, 'outing')
  // the furnace routine becomes due but cannot start while the outing runs
  r.brain.scheduler.setEnabled('furnace', true); r.brain.scheduler.tick(); await wait(50)
  assert.strictEqual(r.brain.scheduler.status().running.name, 'outing')
  // safety preempts, the outing resumes and keeps its remaining time
  r.brain.scheduler.submit({ name: 'safety', priority: 100, preemptible: false, run: async (ctx) => { await ctx.sleep(30) } })
  await wait(120)
  assert.strictEqual(r.brain.scheduler.status().running.name, 'outing')
  await wait(2600)
  assert.ok(r.said.some(x => /Done at/.test(x)), r.said.join(' | '))
  r.brain.userStop(); finish(r)
})

test('whats-new.txt: said once after start (max 4 lines), then emptied', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'news-'))
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'state', 'whats-new.txt'), 'New: one.\nNew: two.\n\nNew: three.\nNew: four.\nNew: five.\n')
  const r = rig({ stateDir: path.join(dir, 'state') })
  await wait(8300)
  assert.deepStrictEqual(r.said.filter(x => /^New:/.test(x)), ['New: one.', 'New: two.', 'New: three.', 'New: four.'])
  assert.strictEqual(fs.readFileSync(path.join(dir, 'state', 'whats-new.txt'), 'utf8'), '')
  finish(r)
})

test.skip("a parked task emits a generic 'park' event with its name, reason and position, and resumeParked(name) resumes it", async () => {
  const r = rig()
  const seen = []
  r.brain.api.events.on('park', (p) => seen.push(p))
  let runs = 0
  r.brain.scheduler.submit({ name: 'mining', priority: 11, onUserStop: 'park', async run(ctx) { runs++; if (runs === 1) return { status: 'park', reason: 'the shaft bottom is blocked' }; await ctx.sleep(30) } })
  await wait(80)
  assert.strictEqual(seen.length, 1)
  assert.strictEqual(seen[0].module, 'mining'); assert.match(seen[0].reason, /blocked/); assert.ok(seen[0].pos && typeof seen[0].pos.x === 'number')
  assert.strictEqual(r.brain.scheduler.resumeParked('mining'), 1)
  await wait(120)
  assert.strictEqual(runs, 2)
  finish(r)
})

test('bag room: aggressive plan keeps the working set and stashes the rest; routine fires when fewer than 6 slots are free', async () => {
  const plan = require('../brain/bagroom').plan
  const inv = [['stone_pickaxe', 1], ['bread', 70], ['carrot', 213], ['wheat', 102], ['wheat_seeds', 196], ['poppy', 4], ['stone_pressure_plate', 6], ['iron_helmet', 1], ['torch', 40], ['cobblestone', 200], ['spruce_planks', 19], ['dirt', 17], ['birch_sapling', 30], ['coal', 27], ['stick', 3]].map(([name, count]) => ({ name, count }))
  const got = Object.fromEntries(plan(inv, { reserved: {} }).map(t => [t.name, t.count]))
  assert.deepStrictEqual(got, { carrot: 213, bread: 6, wheat: 86, wheat_seeds: 180, poppy: 4, stone_pressure_plate: 6, iron_helmet: 1, dirt: 17, birch_sapling: 14, coal: 11 })
  const r = rig()
  assert.ok(r.brain.scheduler.status().routines.some(x => x.name === 'bag-room' && x.enabled))
  finish(r)
})

test.skip('gate: only a real threat counts (near, or in line of sight); walls and other levels are ignored; running mining is never paused for a mob', async () => {
  const { Vec3 } = require('vec3')
  const r = rig()
  const gate = r.brain.scheduler.gate
  r.bot.entity.position = new Vec3(0, 64, 0)
  r.bot.time.timeOfDay = 1000; r.bot.health = 20
  const mob = (x, y, z, name = 'zombie') => ({ id: 77, name, type: 'hostile', position: new Vec3(x, y, z), height: 1.95 })
  const mining = { name: 'mining' }, build = { name: 'build' }
  r.bot.entities = { 77: mob(12, 64, 0) }
  assert.strictEqual(gate.check(build, {}).ok, false, 'in the open, 12 blocks away, visible: a threat')
  const wall = (name) => { for (let y = 62; y <= 70; y++) for (let z = -3; z <= 3; z++) for (const wx of [3, 4]) r.bot.setBlock(wx, y, z, name) }
  wall('stone')   // a wall between the bot and the mob
  assert.strictEqual(gate.check(build, {}), true, 'behind a wall at 12 blocks: ignored')
  r.bot.entities = { 77: mob(5, 64, 0) }
  assert.strictEqual(gate.check(build, {}).ok, false, 'within 6 blocks counts even behind a wall')
  r.bot.entities = { 77: mob(5, 40, 0) }
  assert.strictEqual(gate.check(build, {}), true, 'far below: ignored')
  wall('air')
  r.bot.entities = { 77: mob(8, 64, 0, 'skeleton') }
  assert.strictEqual(gate.check(mining, { running: true }), true, 'running mining is never paused for a mob')
  assert.strictEqual(gate.check(mining, { running: false }).ok, false, 'but starting mining next to a skeleton in view waits')
  assert.strictEqual(gate.check(build, {}).holdMs, 10000, 'a mob hold is short')
  finish(r)
})
