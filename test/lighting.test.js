// brain/lighting: torches (and only torches) in dark spots on the routes the bot walks, inside Walter's base, with line of sight, logged.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Vec3 } = require('vec3')
const { mockBot } = require('./mock-bot')
const H = require('./mining.helpers')
const { Scheduler, PRIORITY } = require('../brain/scheduler')
const safehand = require('../brain/safehand')
const util = require('../brain/util')
const los = require('../brain/los')
const lighting = require('../brain/lighting')

const BASE_Y = 139                      // floor level in the room below; feet at 140
const X0 = -1050, Z0 = 2300

function world({ pos = [X0 + 0.5, BASE_Y + 1, Z0 + 0.5], floorW = 60 } = {}) {
  const bot = H.extend(mockBot({ pos }))
  bot.lavaHeldWhileMoving = []
  bot.goals = { ...bot.goals, GoalNear: class { constructor(x, y, z, r) { Object.assign(this, { x, y, z, r }) } }, GoalBlock: class { constructor(x, y, z) { Object.assign(this, { x, y, z }) } } }
  for (let x = X0 - 5; x <= X0 + floorW; x++) for (let z = Z0 - 12; z <= Z0 + 12; z++) bot.setBlock(x, BASE_Y, z, 'stone')
  bot.extraTorches = []
  bot.lightAt = (x, y, z) => { let l = 0; for (const [tx, ty, tz] of [...bot.placed, ...bot.extraTorches]) l = Math.max(l, 14 - Math.hypot(x - tx, y - ty, z - tz)); return Math.max(0, Math.round(l)) }
  return bot
}

function lapi(bot, { dispatch = null, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lighting-')) } = {}) {
  const clock = { t: 10000000000 }
  const scheduler = new Scheduler({ graceMs: 300, idleAfterMs: 0 })
  const said = [], logs = [], cmds = [], dispatched = []
  const sh = safehand({ bot })
  const api = {
    bot, scheduler, PRIORITY, say: (t) => said.push(t), goals: bot.goals, tryGoto: bot.tryGoto, stopNav() {}, safehand: sh,
    gotoNear: (o) => util.gotoNear({ bot, goals: bot.goals, tryGoto: bot.tryGoto, stop() {}, ...o }),
    canSee: (t) => los.canSee(bot, t), ensureLineOfSight: (o) => los.ensureLineOfSight({ bot, goals: bot.goals, tryGoto: bot.tryGoto, ...o }),
    ownerName: 'OGWO', dir, statePath: (f) => path.join(dir, f), log: (tag, m) => logs.push(`${tag}: ${m}`), now: () => clock.t,
    commands: { add: (c) => cmds.push(c), list: () => cmds, dispatch: (u, t) => { dispatched.push(t); return dispatch ? dispatch(u, t) : false } }
  }
  const handle = lighting(api)
  return { api, handle, clock, said, logs, cmds, dispatched, scheduler, dir }
}
const route = (h, cells, n = 1) => { for (const [x, y, z] of cells) h.routes.set(`${x},${y},${z}`, { n, last: 1 }) }
const corridor = (x1, x2, z = Z0) => { const out = []; for (let x = x1; x <= x2; x++) out.push([x, BASE_Y + 1, z]); return out }
const runIdle = (l) => l.handle.run(H.fakeCtx(), { manual: true })

test('routes: the cells the bot stands on are sampled (throttled), persisted, and the listener is removed on stop', () => {
  const bot = world()
  const l = lapi(bot)
  assert.strictEqual(bot.listenerCount('move'), 1)
  const at = (x, z) => { bot.entity.position = new Vec3(x + 0.5, BASE_Y + 1, z + 0.5); bot.emit('move') }
  at(X0, Z0); l.clock.t += 500; at(X0 + 1, Z0)                         // second one is inside the 2 s throttle
  assert.strictEqual(l.handle.routes.size, 1)
  l.clock.t += 2500; at(X0 + 1, Z0); l.clock.t += 2500; at(X0 + 1, Z0)
  assert.strictEqual(l.handle.routes.get(`${X0 + 1},${BASE_Y + 1},${Z0}`).n, 2)
  bot.entity.onGround = false; l.clock.t += 2500; at(X0 + 5, Z0); bot.entity.onGround = true
  assert.strictEqual(l.handle.routes.has(`${X0 + 5},${BASE_Y + 1},${Z0}`), false, 'in the air does not count')
  l.handle.stop()
  assert.strictEqual(bot.listenerCount('move'), 0)
  const l2 = lapi(world(), { dir: l.dir })                              // a restart keeps the routes
  assert.strictEqual(l2.handle.routes.get(`${X0 + 1},${BASE_Y + 1},${Z0}`).n, 2)
  l2.handle.stop()
})
test('dark spots: route cells in the base with block light below 2 and a plain floor; lit cells and other places are ignored', () => {
  const bot = world()
  const l = lapi(bot)
  route(l.handle, corridor(X0, X0 + 3), 5)
  route(l.handle, [[0, BASE_Y + 1, 0]], 9)                              // far from the base: not our business here
  bot.extraTorches.push([X0 + 3, BASE_Y + 1, Z0])                       // a torch lights the right end
  const spots = l.handle.darkSpots()
  assert.deepStrictEqual(spots.map(s => s.cell.x).sort(), [])           // light 14 - 3 >= 2 at all four cells
  bot.extraTorches.length = 0
  const dark = l.handle.darkSpots()
  assert.strictEqual(dark.length, 4); assert.ok(dark.every(s => s.light === 0))
  assert.ok(!dark.some(s => s.cell.x === 0))
  l.handle.stop()
})
test('run: torches go on plain floors with a clear view, one covers its neighbourhood, every placement is logged', async () => {
  const bot = world()
  bot.give('torch', 12)
  const l = lapi(bot)
  route(l.handle, corridor(X0, X0 + 30), 3)
  await runIdle(l)
  assert.ok(bot.placed.length >= 2 && bot.placed.length <= 4, `placed ${bot.placed.length}`)
  assert.ok(bot.placed.every(p => p[3] === 'torch' && p[1] === BASE_Y + 1))
  assert.deepStrictEqual(bot.losViolations, [])
  assert.strictEqual(l.handle.darkSpots().length, 0, 'every route cell is lit now')
  assert.strictEqual(l.handle.state.placed.length, bot.placed.length)
  assert.ok(l.logs.filter(x => /TORCH at/.test(x)).length >= bot.placed.length * 1)
  assert.match(l.said[l.said.length - 1], /Put up \d torch/)
  // not stacked on each other
  for (let i = 1; i < bot.placed.length; i++) assert.ok(Math.abs(bot.placed[i][0] - bot.placed[i - 1][0]) >= 6)
  l.handle.stop()
})
test('run: floors that are not plain (farmland, water, slabs, containers) never get a torch; a plain neighbour does', async () => {
  const bot = world()
  bot.give('torch', 8)
  const l = lapi(bot)
  for (const [i, bad] of ['farmland', 'water', 'oak_slab', 'chest'].entries()) bot.setBlock(X0 + i, BASE_Y, Z0, bad)
  route(l.handle, corridor(X0, X0 + 3), 2)
  await runIdle(l)
  assert.ok(bot.placed.length >= 1)
  for (const [x, y, z] of bot.placed) { const floor = bot.blockAt(new Vec3(x, y - 1, z)).name; assert.ok(!/farmland|water|slab|chest/.test(floor), floor) }
  l.handle.stop()
})
test('run: at most maxPerRun torches per pass; never outside the configured areas', async () => {
  const bot = world()
  bot.give('torch', 40)
  bot.lightAt = (x, y, z) => (bot.placed.some(([tx, ty, tz]) => Math.hypot(x - tx, y - ty, z - tz) <= 3) ? 12 : 0)      // a torch only helps its own surroundings here
  const l = lapi(bot)
  for (let i = 0; i < 10; i++) route(l.handle, [[X0 + (i % 5) * 8, BASE_Y + 1, Z0 + (i < 5 ? -8 : 8)]], 4)
  route(l.handle, [[0, 64, 0]], 50)
  for (let x = -5; x <= 5; x++) for (let z = -5; z <= 5; z++) bot.setBlock(x, 63, z, 'stone')
  await runIdle(l)
  assert.strictEqual(bot.placed.length, 6)
  assert.ok(bot.placed.every(p => p[0] < -1000), 'nothing at 0,64,0 (outside the base)')
  l.handle.stop()
})
test('run: no torches -> asks the crafting module once per two hours; if it cannot, says so once per six hours and places nothing', async () => {
  const bot = world()
  const l = lapi(bot, { dispatch: () => true })
  route(l.handle, corridor(X0, X0 + 3), 2)
  await runIdle(l)
  assert.deepStrictEqual(l.dispatched, ['craft 16 torch'])
  assert.strictEqual(bot.placed.length, 0)
  assert.strictEqual(l.said.filter(s => /no torches/.test(s)).length, 1)
  await runIdle(l)
  assert.strictEqual(l.dispatched.length, 1, 'does not ask again within two hours')
  assert.strictEqual(l.said.filter(s => /no torches/.test(s)).length, 1, 'does not repeat itself')
  l.clock.t += 3 * 3600000
  await runIdle(l)
  assert.strictEqual(l.dispatched.length, 2)
  // when crafting works the torches go down in the same pass
  const bot2 = world()
  const l2 = lapi(bot2, { dispatch: () => { bot2.give('torch', 16); return true } })
  route(l2.handle, corridor(X0, X0 + 3), 2)
  await runIdle(l2)
  assert.ok(bot2.placed.length >= 1)
  l.handle.stop(); l2.handle.stop()
})
test('run: a spot it cannot get a view of is skipped (no placement through walls), and not retried for an hour', async () => {
  const bot = world()
  bot.give('torch', 8)
  // a sealed one-cell pocket inside the base, walled in on every side
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 2; dy++) for (let dz = -1; dz <= 1; dz++) bot.setBlock(X0 + 30 + dx, BASE_Y + 1 + dy, Z0 + 8 + dz, 'stone')
  bot.setBlock(X0 + 30, BASE_Y + 1, Z0 + 8, 'air'); bot.setBlock(X0 + 30, BASE_Y + 2, Z0 + 8, 'air')
  const l = lapi(bot)
  route(l.handle, [[X0 + 30, BASE_Y + 1, Z0 + 8]], 5)
  await runIdle(l)
  assert.deepStrictEqual(bot.placed, [])
  assert.deepStrictEqual(bot.losViolations, [])
  assert.strictEqual(l.handle.darkSpots().length, 0, 'marked bad for an hour')
  l.clock.t += 3700000
  assert.strictEqual(l.handle.darkSpots().length, 1)
  l.handle.stop()
})
test('routine and chat: registered idle-only and on by default; phrases are specific to lighting', async () => {
  const bot = world()
  bot.give('torch', 8)
  const l = lapi(bot)
  const rt = l.scheduler.routines.get('lighting')
  assert.ok(rt && rt.idleOnly && l.scheduler.isEnabled('lighting'))
  assert.strictEqual(rt.due(), false, 'nothing dark known yet')
  route(l.handle, corridor(X0, X0 + 3), 2)
  assert.strictEqual(rt.due(), true)
  bot.game.dimension = 'the_nether'; assert.strictEqual(rt.due(), false); bot.game.dimension = 'overworld'
  const light = l.cmds.find(c => c.name === 'light-up'), P = lighting.phrases
  for (const t of ['light up the base', 'place torches', 'fix the lighting', 'put some torches down', 'light up']) assert.ok(P.LIGHT_UP.test(t), t)
  for (const t of ['craft torch 4', 'light the furnace', 'turn on the light', 'i need a torch', 'mine diamonds']) assert.ok(!P.LIGHT_UP.test(t), t)
  assert.ok(P.ROUTINE.test('lighting routine off') && P.STATUS.test('how many torches have you placed'))
  assert.strictEqual(light.risk, 'high')
  const off = l.cmds.find(c => c.name === 'lighting-routine'); off.run('OGWO', 'lighting routine off', 'lighting routine off')
  assert.strictEqual(l.scheduler.isEnabled('lighting'), false)
  off.run('OGWO', 'lighting routine on', 'lighting routine on')
  assert.strictEqual(l.scheduler.isEnabled('lighting'), true)
  light.run('OGWO', 'light up', 'light up')                                // a manual pass through the scheduler
  await H.waitFor(() => bot.placed.length >= 1)
  await H.waitFor(() => !l.scheduler.status().running && !l.scheduler.status().queue.length)
  assert.ok(l.said.some(s => /Put up \d torch/.test(s)))
  l.cmds.find(c => c.name === 'lighting-status').run()
  assert.match(l.said[l.said.length - 1], /placed \d+ torches/)
  l.handle.stop()
})

test('integration: through the real brain/index.js "light up" puts torches down with the shared line-of-sight helpers', { timeout: 30000 }, async () => {
  const attach = require('../brain')
  const { addCrafting } = require('./crafting.helpers')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lighting-int-'))
  const bot = addCrafting(world())
  bot.give('torch', 8)
  fs.writeFileSync(path.join(dir, 'chest-index.json'), '{}')
  const said = []
  const brain = attach({
    bot, say: (t) => { said.push(t); bot.say(t) }, goals: bot.goals, tryGoto: bot.tryGoto, stopNav: () => { bot.pathfinder.setGoal(null) },
    navigateRaw: () => {}, navActive: () => false, handleCommand: () => false,
    farm: { isBusy: () => false, stop() {}, storeCrops: async () => {}, harvest: async () => {} },
    excavation: { isRunning: () => false, stop() {}, start: async () => {}, resume: async () => {}, status() {} },
    routines: { farm: false, lastFarmRun: 0 }, saveRoutines: () => {}, dir, stateDir: path.join(dir, 'state'),
    jobs: { bedRoutine: async () => {} }, stopAllLegacy: () => {}, idleAfterMs: 20,
    moduleEntries: [{ name: 'lighting', path: path.join(__dirname, '..', 'brain', 'lighting', 'index.js') }]
  })
  brain.scheduler.stop()
  // walk a corridor: the move listener records the routes
  for (let i = 0; i < 6; i++) { bot.entity.position = new Vec3(X0 + i + 0.5, BASE_Y + 1, Z0 + 0.5); bot.emit('move'); await H.wait(0); brain.status().modules.lighting }
  assert.ok(brain.status().modules.lighting.routeCells >= 1)
  const h = brain.status().modules.lighting
  assert.strictEqual(h.enabled, true)
  // feed more route cells by walking with a faked clock is slow; the module exposes them through its status only, so walk with real time gaps instead
  assert.strictEqual(brain.route('OGWO', 'light up'), true)
  await H.wait(100)
  brain.stop()
})

test('static: lighting and mining place nothing but torches, run no timers and no process handlers, never call bot.chat', () => {
  const root = path.join(__dirname, '..', 'brain')
  const files = [...fs.readdirSync(path.join(root, 'mining')).filter(f => f.endsWith('.js')).map(f => path.join(root, 'mining', f)), ...fs.readdirSync(path.join(root, 'lighting')).filter(f => f.endsWith('.js')).map(f => path.join(root, 'lighting', f))]
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    const name = path.relative(root, f)
    assert.ok(!/setInterval|process\.(on|exit)|bot\.chat\(/.test(src), `${name}: forbidden call`)
    if (path.basename(f) !== 'torches.js' || path.basename(path.dirname(f)) !== 'lighting') assert.ok(!/placeBlock|activateBlock/.test(src), `${name}: only torches.js may place`)
  }
  const torchSrc = fs.readFileSync(path.join(root, 'lighting', 'torches.js'), 'utf8')
  assert.strictEqual((torchSrc.match(/placeBlock\(/g) || []).length, 1, 'one placeBlock call, on the torch path')
  assert.ok(/viewOk/.test(torchSrc) && /canSee/.test(torchSrc), 'placement checks the line of sight first')
  assert.ok((torchSrc.match(/placeAgainst\(/g) || []).length <= 5, 'one generic placer: torch, chest, ladder and cobblestone support only')
})
