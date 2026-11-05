// brain/nav as the integrator loads it: register(api) -> commands, scheduler tasks, status, navigate(), stop(). Uses the real
// scheduler, real safehand and real brain/los.js on the simulated world.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const EventEmitter = require('events')
const { makeSim, legacyMovements, goals, Vec3 } = require('./nav.helpers')
const { Scheduler, PRIORITY } = require('../brain/scheduler')
const makeSafehand = require('../brain/safehand')
const losLib = require('../brain/los')
const { normalize } = require('../brain')
const register = require('../brain/nav')

const fakeXaero = (byDim) => ({
  listWorlds: () => [{ name: 'W', waypoints: true, map: true }],
  waypoints: (w, dim) => (byDim[dim] || []).map(p => ({ disabled: false, ...p, dim })),
  openMap: () => null
})

async function setup({ sim: simOpts = {}, build = () => {}, waypoints = {}, xaero = {}, extra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navmod-'))
  fs.writeFileSync(path.join(dir, 'waypoints.json'), JSON.stringify(waypoints))
  fs.mkdirSync(path.join(dir, 'state'))
  const sim = makeSim(simOpts)
  build(sim)
  legacyMovements(sim.bot)
  await sim.settle(10)
  const said = [], commands = []
  const scheduler = new Scheduler({ stateFile: path.join(dir, 'state', 'scheduler.json'), now: () => Date.now() })
  const safehand = makeSafehand({ bot: sim.bot, pollMs: 50 })
  const api = {
    bot: sim.bot, PRIORITY, scheduler, goals, safehand, ownerName: 'OGWO', dir, now: () => sim.now(),
    say: (t) => said.push(t), log: () => {}, statePath: (f) => path.join(dir, 'state', f), events: new EventEmitter(),
    stopNav: () => sim.bot.pathfinder.setGoal(null), tryGoto: async () => ({ ok: false }),
    canSee: (t) => losLib.canSee(sim.bot, t),
    ensureLineOfSight: (o) => losLib.ensureLineOfSight({ bot: sim.bot, goals, tryGoto: api.tryGoto, ...o }),
    xaero: fakeXaero(xaero),
    commands: { add(c) { commands.push(c); return true }, dispatch(u, t) { return route(u, t, true) } },
    ...extra
  }
  const route = (user, text) => {
    const t = normalize(text)
    for (const c of commands) { let hit = false; try { hit = typeof c.match === 'function' ? c.match(user, t) : c.match.test(t) } catch {} ; if (hit) { c.run(user, text, t); return c.name } }
    return false
  }
  const handle = register(api)
  handle.start()
  const settleScheduler = async (pred, ticks = 3000) => { let n = 0; for (; n < ticks; n++) { sim.tick(); await new Promise(r => setImmediate(r)); if (pred()) break } return n }
  return { dir, sim, said, commands, scheduler, safehand, api, handle, route, settleScheduler, close() { handle.stop(); sim.dispose() } }
}

const FLAT = (s) => s.floor(-10, -10, 120, 40, 63)

test('registers its commands and exposes status / provides nav', async () => {
  const m = await setup({ build: FLAT })
  const names = m.commands.map(c => c.name)
  for (const n of ['nav-goto', 'nav-travel', 'nav-where', 'nav-near', 'nav-sources', 'nav-status', 'nav-tidy']) assert.ok(names.includes(n), n)
  assert.deepStrictEqual(m.handle.provides, ['nav'])
  assert.strictEqual(typeof m.handle.navigate, 'function')
  assert.strictEqual(m.api.nav, m.handle)
  assert.doesNotThrow(() => JSON.stringify(m.handle.status()))
  for (const c of m.commands) assert.ok(c.help, c.name + ' needs help text for the chat module')
  m.close()
})

test('"go to the farm": walks there as a scheduler task, says one line at the start (far) and one on arrival', async () => {
  const m = await setup({ build: FLAT, waypoints: { farm: { x: 60, y: 64, z: 5 } } })
  assert.strictEqual(m.route('OGWO', 'hey can you please go to the farm'), 'nav-goto')
  await m.settleScheduler(() => m.said.some(t => /Arrived/.test(t)), 3000)
  assert.ok(m.sim.at().distanceTo(new Vec3(60.5, 64, 5.5)) < 3.5, m.sim.at().toString())
  assert.deepStrictEqual(m.said.length, 2, m.said.join(' | '))
  assert.match(m.said[0], /Going to farm, \d+ blocks/)
  assert.match(m.said[1], /Arrived at farm/)
  m.close()
})

test('short trips are silent at the start; Xaero waypoints work the same; casing and typos are fine', async () => {
  const m = await setup({ build: FLAT, xaero: { 0: [{ name: 'Mt Parros', x: 30, y: 64, z: 3 }] } })
  m.route('OGWO', 'walk to MT PAROS')
  await m.settleScheduler(() => m.said.some(t => /Arrived/.test(t)), 3000)
  assert.deepStrictEqual(m.said, ['Arrived at Mt Parros.'])
  m.close()
})

test('does not steal other commands: coordinates, "come here", "go to the nether", "go to bed", unknown names', async () => {
  const m = await setup({ build: FLAT, waypoints: { farm: { x: 60, y: 64, z: 5 } }, xaero: { 0: [{ name: 'Ice Portal', x: 5, y: 64, z: 5 }] } })
  for (const t of ['go to 100 64 200', 'go to x=10 z=20', 'come here', 'go to the nether', 'leave the nether', 'go to bed', 'go to sleep', 'go to the zorblax', 'follow me', 'go to me']) {
    assert.strictEqual(m.route('OGWO', t), false, t)
  }
  m.close()
})

test('ambiguity: "which one" for different names, nearest for identical names ("Portal" x3)', async () => {
  const m = await setup({ build: FLAT, xaero: { 0: [{ name: 'Portal', x: 20, y: 64, z: 0 }, { name: 'Portal', x: 90, y: 64, z: 0 }, { name: 'Ice Portal', x: 30, y: 64, z: 9 }, { name: 'Valley Pond', x: 8, y: 64, z: 9 }, { name: 'Valley Pool', x: 9, y: 64, z: 12 }] } })
  m.route('OGWO', 'go to valley')
  assert.match(m.said[0], /Which one: Valley (Pond|Pool), Valley (Pond|Pool)\?/)
  assert.strictEqual(m.scheduler.status().running, null, 'did not start walking')
  m.said.length = 0
  m.route('OGWO', 'go to the portal')
  assert.match(m.said[0], /Going to Portal \(20, 0\) \(nearest of 2\)/, m.said.join('|'))
  await m.settleScheduler(() => m.said.some(t => /Arrived/.test(t)), 2000)
  assert.ok(m.sim.at().distanceTo(new Vec3(20.5, 64, 0.5)) < 3.5)
  m.close()
})

test('"where is" / "how far is" answers from the merged list; unknown names fall through to the legacy handlers', async () => {
  const m = await setup({ build: FLAT, waypoints: { 'furnace station 1': { x: 40, y: 64, z: -30 } }, xaero: { 0: [{ name: 'Seaside Winter Village', x: -1085, y: 63, z: -3674 }] } })
  assert.strictEqual(m.route('OGWO', 'where is the seaside winter village'), 'nav-where')
  assert.match(m.said.at(-1), /Seaside Winter Village: \d+ blocks north/)
  assert.strictEqual(m.route('OGWO', 'how far is furnace station 1'), 'nav-where')
  assert.match(m.said.at(-1), /furnace station 1: \d+ blocks northeast \(40, 64, -30\)/)
  assert.strictEqual(m.route('OGWO', 'where is the chest'), false, 'weak match -> legacy find-block handler')
  assert.strictEqual(m.route('OGWO', 'where is the creeper'), false)
  m.close()
})

test('long trips are "high" risk (the chat module asks before a fuzzy match); near ones are low', async () => {
  const m = await setup({ build: FLAT, xaero: { 0: [{ name: 'Faraway', x: 3000, y: 64, z: 0 }, { name: 'Closeby', x: 20, y: 64, z: 0 }] } })
  assert.strictEqual(m.commands.find(c => c.name === 'nav-travel').risk, 'high')
  assert.strictEqual(m.commands.find(c => c.name === 'nav-goto').risk, 'low')
  assert.strictEqual(m.route('OGWO', 'go to faraway'), 'nav-travel')
  assert.strictEqual(m.route('OGWO', 'go to closeby'), 'nav-goto')
  m.close()
})

test('stop (scheduler.userStop) ends a trip immediately: no goal, keys released, no "couldn\'t get there" chatter', async () => {
  const m = await setup({ build: FLAT, waypoints: { far: { x: 100, y: 64, z: 0 } } })
  m.route('OGWO', 'go to far')
  await m.settleScheduler(() => m.sim.at().x > 20, 500)
  m.scheduler.userStop()
  await m.settleScheduler(() => false, 40)
  assert.strictEqual(m.sim.bot.pathfinder.goal, null)
  assert.ok(!Object.values(m.sim.bot.controlState).some(Boolean))
  assert.ok(m.sim.at().x < 60)
  assert.ok(!m.said.some(t => /couldn't/.test(t)), m.said.join('|'))
  m.close()
})

test('unreachable waypoint (plain navigator): no "I can\'t get there" in chat, the reason goes to the log / status', async () => {
  const m = await setup({ build: s => { FLAT(s); s.fill(10, 63, -10, 12, 63, 40, 'lava') }, waypoints: { island: { x: 30, y: 64, z: 0 } }, extra: { navConfig: { escalate: false } } })
  m.route('OGWO', 'go to island')
  await m.settleScheduler(() => m.handle.status().lastTrip, 1500)
  assert.ok(m.handle.status().lastTrip && m.handle.status().lastTrip.ok === false, JSON.stringify(m.handle.status().lastTrip))
  assert.match(m.handle.status().lastTrip.err, /no path|path search timed out/)
  assert.ok(!m.said.some(t => /couldn't|can't|stopped short/i.test(t)), m.said.join(' | '))
  m.close()
})

test('the lava-bucket rule: nav stows a lava bucket before the first step and never moves while one is selected', async () => {
  const m = await setup({ build: FLAT, waypoints: { far: { x: 40, y: 64, z: 0 } } })
  m.sim.give('stone_sword'); const lava = m.sim.give('lava_bucket')
  m.sim.bot.heldItem = lava
  const heldWhileMoving = []
  m.sim.bot.on('physicsTick', () => { if (m.sim.bot.controlState.forward) heldWhileMoving.push(m.sim.bot.heldItem && m.sim.bot.heldItem.name) })
  m.route('OGWO', 'go to far')
  await m.settleScheduler(() => m.said.some(t => /Arrived/.test(t)), 2000)
  assert.ok(heldWhileMoving.length > 10)
  assert.ok(!heldWhileMoving.includes('lava_bucket'), 'walked with lava in hand')
  m.close()
})

test('navigate(goal,label,dynamic) replaces the built-in nav (INTERFACE section 9): CHAT task named nav; orders queue back to back ("Queued" / "On my way." / "Here." in order)', async () => {
  const m = await setup({ build: FLAT })
  const t1 = m.handle.navigate(new goals.GoalNear(40, 64, 0, 1), 'x=40')
  assert.strictEqual(t1.name, 'nav'); assert.strictEqual(t1.priority, PRIORITY.CHAT)
  await m.settleScheduler(() => m.sim.at().x > 10, 400)
  m.handle.navigate(new goals.GoalNear(10, 64, 20, 1), 'x=10, z=20')            // a second order while the first is still being walked
  assert.match(m.said[0], /Queued: heading to x=10, z=20 after the walk I'm on/)
  await m.settleScheduler(() => m.said.filter(t => t === 'Here.').length === 2, 4000)
  assert.deepStrictEqual(m.said.slice(1), ['Here.', 'On my way.', 'Here.'], 'first walk finished and announced, then the queued one started and arrived')
  assert.ok(m.sim.at().distanceTo(new Vec3(10.5, 64, 20.5)) < 3, m.sim.at().toString())
  m.close()
})

test('navigate() with a dynamic goal (follow): keeps going until stopped; preempted nav resumes with the same goal', async () => {
  const m = await setup({ build: FLAT })
  const walker = { id: 7, position: new Vec3(30.5, 64, 0.5), height: 1.8, width: 0.6, velocity: new Vec3(0, 0, 0), isValid: true, type: 'player' }
  m.sim.bot.entities[7] = walker
  m.handle.navigate(new goals.GoalFollow(walker, 2), 'you', true)
  await m.settleScheduler(() => m.sim.at().distanceTo(walker.position) < 3.5, 800)
  walker.position = new Vec3(50.5, 64, 10.5)
  await m.settleScheduler(() => m.sim.at().distanceTo(walker.position) < 3.5, 800)
  assert.ok(m.sim.at().distanceTo(walker.position) < 4)
  m.scheduler.userStop()
  await m.settleScheduler(() => false, 40)
  assert.strictEqual(m.sim.bot.pathfinder.goal, null)
  m.close()
})

test('doors tended for ANY pathfinder user: a goal set by someone else through bot.pathfinder (join.js style) still opens and closes the door', async () => {
  const m = await setup({ build: s => { FLAT(s); s.wallX(-10, 40, 5, 64, 66); s.fill(5, 64, 0, 5, 66, 0, 'air'); s.door(5, 64, 0, { facing: 'east' }) } })
  const reached = []
  m.sim.bot.on('goal_reached', () => reached.push(1))
  m.sim.bot.pathfinder.setGoal(new goals.GoalBlock(12, 64, 0))
  await m.settleScheduler(() => reached.length, 600)
  await m.settleScheduler(() => false, 60)
  assert.strictEqual(reached.length, 1)
  assert.strictEqual(m.sim.blockProps(5, 64, 0).open, false)
  m.close()
})

test('"Here." stays quiet for nav\'s own legs but legacy goals still announce arrival (goal_reached listeners see only foreign goals)', async () => {
  const m = await setup({ build: FLAT })
  const seen = []
  m.sim.bot.on('goal_reached', (g) => seen.push(g))
  const mine = new goals.GoalNear(10, 64, 0, 1)
  let r = null; m.handle.goto(mine, { label: 'leg' }).then(x => { r = x })
  await m.settleScheduler(() => r, 400)
  assert.ok(r.ok); assert.strictEqual(seen.length, 0, 'nav goal arrival is not broadcast')
  const theirs = new goals.GoalNear(20, 64, 0, 1)
  m.sim.bot.pathfinder.setGoal(theirs)
  await m.settleScheduler(() => seen.length, 400)
  assert.strictEqual(seen[0], theirs)
  m.close()
})

test('stop(): everything is undone (movements restored, listeners gone, emit restored)', async () => {
  const sim = makeSim(); FLAT(sim)
  const mv = legacyMovements(sim.bot)
  const emit = sim.bot.emit
  const before = sim.bot.eventNames().reduce((n, e) => n + sim.bot.listenerCount(e), 0)
  const m = await setup({ build: FLAT })
  const bot = m.sim.bot, mv2 = bot.pathfinder.movements
  const listenersBefore = bot.eventNames().reduce((n, e) => n + bot.listenerCount(e), 0)
  m.handle.stop()
  const listenersAfter = bot.eventNames().reduce((n, e) => n + bot.listenerCount(e), 0)
  assert.ok(listenersAfter < listenersBefore)
  assert.strictEqual(mv2.canDig, false)                                     // join.js's own setting is still in force afterwards
  assert.strictEqual(mv2.infiniteLiquidDropdownDistance, true, 'stock value restored')
  sim.dispose(); m.sim.dispose()
})

test('state: only brain/state is written, and the door list is in nav-state.json', async () => {
  const m = await setup({ build: s => { FLAT(s); s.wallX(-10, 40, 5, 64, 66); s.fill(5, 64, 0, 5, 66, 0, 'air'); s.door(5, 64, 0, { facing: 'east' }) }, waypoints: { beyond: { x: 12, y: 64, z: 0 } } })
  const before = fs.readdirSync(m.dir).sort()
  m.route('OGWO', 'go to beyond')
  await m.settleScheduler(() => m.said.some(t => /Arrived/.test(t)), 800)
  assert.deepStrictEqual(fs.readdirSync(m.dir).sort(), before, 'nothing new next to join.js')
  const st = JSON.parse(fs.readFileSync(path.join(m.dir, 'state', 'nav-state.json'), 'utf8'))
  assert.ok(Array.isArray(st.doors))
  m.close()
})

// ---------------------------------------------------------------- dimensions
// a straight logged Nether walk between two points (what Walter walking it would have left in the log)
const line = (a, b, step = 1.5) => { const n = Math.ceil(Math.hypot(b[0] - a[0], b[2] - a[2]) / step); return Array.from({ length: n + 1 }, (_, i) => ({ x: a[0] + (b[0] - a[0]) * i / n, y: a[1], z: a[2] + (b[2] - a[2]) * i / n })) }
const WIDE = { x0: -40, x1: 300, y0: 0, y1: 120, z0: -40, z1: 80 }
test('Nether trip: walk to the portal, hop through usePortal, walk on in the Nether to the Nether waypoint', async () => {
  const hops = []
  let m
  const usePortal = async (want) => {
    hops.push(want)
    m.sim.bot.game.dimension = want === 'the_nether' ? 'the_nether' : 'overworld'
    m.sim.bot.entity.position = new Vec3(...(want === 'the_nether' ? [3.5, 64, 0.5] : [10.5, 64, 0.5]))      // the portal moved us (test double)
    m.sim.bot.emit('forcedMove')
    await new Promise(r => setTimeout(r, 5))
  }
  m = await setup({
    sim: { bounds: WIDE }, build: s => { s.floor(-10, -10, 200, 40, 63) }, extra: { usePortal },
    xaero: { 0: [{ name: 'Home Portal', x: 8, y: 64, z: 0 }], '-1': [{ name: 'Home Portal', x: 1, y: 64, z: 0 }, { name: 'Lava Source', x: 90, y: 64, z: 4 }] }
  })
  m.handle.nether.network.addSegment({ points: line([1.5, 64, 0.5], [90.5, 64, 4.5]), source: 'walter', verified: true })
  assert.strictEqual(m.route('OGWO', 'go to lava source'), 'nav-travel')
  await m.settleScheduler(() => m.said.some(t => /Arrived|couldn't/.test(t)), 6000)
  assert.deepStrictEqual(hops, ['the_nether'])
  assert.match(m.said.at(-1), /Arrived at Lava Source/, m.said.join(' | '))
  assert.ok(m.sim.at().distanceTo(new Vec3(90.5, 64, 4.5)) < 4)
  assert.match(m.said[0], /via a portal/)
  m.close()
})

test('Nether trip without api.usePortal: hands over to the driver\'s "go to the nether" command and continues after the dimension changes', async () => {
  let m
  const dispatched = []
  m = await setup({
    sim: { bounds: WIDE }, build: s => { s.floor(-10, -10, 200, 40, 63) },
    xaero: { 0: [{ name: 'Home Portal', x: 8, y: 64, z: 0 }], '-1': [{ name: 'Home Portal', x: 1, y: 64, z: 0 }, { name: 'Lava Source', x: 60, y: 64, z: 4 }] }
  })
  const origDispatch = m.api.commands.dispatch
  m.api.commands.dispatch = (u, t) => { dispatched.push(t); setTimeout(() => { m.sim.bot.game.dimension = 'the_nether'; m.sim.bot.entity.position = new Vec3(3.5, 64, 0.5); m.sim.bot.emit('forcedMove') }, 20); return true }
  m.handle.nether.network.addSegment({ points: line([1.5, 64, 0.5], [60.5, 64, 4.5]), source: 'walter', verified: true })
  assert.strictEqual(m.route('OGWO', 'go to lava source'), 'nav-travel')
  await m.settleScheduler(() => m.said.some(t => /Arrived|couldn't/.test(t)), 8000)
  assert.deepStrictEqual(dispatched, ['go to the nether'])
  assert.match(m.said.at(-1), /Arrived at Lava Source/, m.said.join(' | '))
  m.close()
})

// ---------------------------------------------------------------- the false "Here." bug
test('join.js\'s "Here." listener is silenced for goals nobody asked about (routines), other listeners still run; undone on stop()', async () => {
  const m = await setup({ build: FLAT })
  const say = (t) => m.said.push(t)
  m.sim.bot.on('goal_reached', () => { say('Here.') })                    // join.js line: bot.on('goal_reached', () => { if (!quietNav) say('Here.') })
  const other = []; m.sim.bot.on('goal_reached', (g) => other.push(g))
  const routineGoal = new goals.GoalNear(10, 64, 0, 1)                    // e.g. a furnace/farm leg through the raw pathfinder
  m.sim.bot.pathfinder.setGoal(routineGoal)
  await m.settleScheduler(() => other.length, 400)
  assert.deepStrictEqual(m.said, [], 'no "Here." for a routine\'s goal')
  assert.strictEqual(other[0], routineGoal, 'other listeners were still told')
  assert.ok(m.handle.nav.silenced >= 1)
  m.handle.stop()
  m.sim.bot.pathfinder.setGoal(new goals.GoalNear(20, 64, 0, 1))
  await m.settleScheduler(() => other.length > 1, 400)
  assert.deepStrictEqual(m.said, ['Here.'], 'without nav the old listener works again')
  m.sim.dispose()
})

test('go-to waiting behind a non-preemptible task: says it is waiting, no "Here." from other arrivals, "On my way." when it starts, "Here." only when really there', async () => {
  const m = await setup({ build: FLAT })
  const say = (t) => m.said.push(t)
  m.sim.bot.on('goal_reached', () => { say('Here.') })
  let release; const gate = new Promise(r => { release = r })
  m.scheduler.submit({ name: 'sleep', priority: PRIORITY.SLEEP, preemptible: false, async run(ctx) { await gate } })
  await m.settleScheduler(() => m.scheduler.status().running, 10)
  m.handle.navigate(new goals.GoalNearXZ(40, 6, 2), 'x=40, z=6')
  assert.match(m.said[0], /Waiting for sleep to finish, then heading to x=40, z=6/)
  // while it waits, the blocker's own movement reaches a goal: must not be announced as an arrival
  m.sim.bot.pathfinder.setGoal(new goals.GoalNear(5, 64, 0, 1))
  await m.settleScheduler(() => m.sim.reached, 300)
  assert.deepStrictEqual(m.said.filter(t => t === 'Here.'), [], 'no false Here.')
  assert.ok(m.sim.at().x < 20, 'and the go-to has not moved the bot')
  release()
  await m.settleScheduler(() => m.said.includes('Here.'), 3000)
  assert.deepStrictEqual(m.said.slice(1), ['On my way.', 'Here.'])
  assert.ok(Math.hypot(m.sim.at().x - 40.5, m.sim.at().z - 6.5) < 3.5, 'announced only once it was really there: ' + m.sim.at())
  m.close()
})

test('a go-to that is not waiting says nothing extra; one that ends short stays silent too (no failure chatter)', async () => {
  const m = await setup({ build: FLAT })
  m.handle.navigate(new goals.GoalNearXZ(30, 4, 2), 'x=30, z=4')
  assert.deepStrictEqual(m.said, [], 'idle bot: no "queued" chatter')
  await m.settleScheduler(() => m.said.length, 2000)
  assert.deepStrictEqual(m.said, ['Here.'])
  m.said.length = 0
  m.handle.nav.goto = async () => ({ ok: true, secs: 1 })                // pretend the pathfinder claimed success without moving
  m.handle.navigate(new goals.GoalNearXZ(100, 4, 2), 'the far corner')
  await m.settleScheduler(() => m.said.length, 200)
  assert.deepStrictEqual(m.said, [], 'no "stopped short" line in chat')
  m.close()
})

// ---------------------------------------------------------------- false arrivals (live: "Arrived at ladder shaft" 77 blocks away)
test('waypoint trip: "Arrived at <name>" only when the bot is really there, otherwise nothing is announced', async () => {
  const m = await setup({ build: FLAT, waypoints: { 'ladder shaft': { x: 100, y: 64, z: 0 } } })
  m.handle.nav.goto = async () => ({ ok: true, secs: 18 })              // whatever went wrong inside: the pathfinder claims success, the bot has not moved
  m.route('OGWO', 'go to ladder shaft')
  await m.settleScheduler(() => m.said.some(t => /Arrived/.test(t)), 600)
  assert.ok(!m.said.some(t => /Arrived|stopped short|couldn't/.test(t)), m.said.join(' | '))
  m.close()
})

test('goto: a goal_reached event that does not match the bot\'s position is ignored and the walk carries on to the real goal', async () => {
  const m = await setup({ build: FLAT })
  const goal = new goals.GoalNear(40, 64, 0, 1)
  let res = null; m.handle.goto(goal, { label: 'far' }).then(x => { res = x })
  await m.settleScheduler(() => m.sim.at().x > 8, 200)
  m.sim.bot.emit('goal_reached', goal)                                   // bogus: the bot is 30 blocks away
  await m.settleScheduler(() => res, 800)
  assert.ok(res && res.ok, JSON.stringify(res))
  assert.ok(m.sim.at().x > 38, 'it kept walking: ' + m.sim.at())
  assert.ok(m.handle.nav.falseArrivals >= 1)
  m.close()
})
