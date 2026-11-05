// The safe Nether network (Walter, 2026-10-26): travel only along logged segments, never by algorithmic pathfinding, ask before exploring.
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
const { NetherNetwork } = require('../brain/nav/nether')
const { scanHazards, PathRecorder, SegmentWalker } = require('../brain/nav/nether-walk')
const { dimOf } = require('../brain/nav/waypoints')

const line = (a, b, step = 1.5) => { const n = Math.ceil(Math.hypot(b[0] - a[0], b[2] - a[2]) / step); return Array.from({ length: n + 1 }, (_, i) => ({ x: a[0] + (b[0] - a[0]) * i / n, y: a[1] + (b[1] - a[1]) * i / n, z: a[2] + (b[2] - a[2]) * i / n })) }
const NETHER = { x0: -40, x1: 200, y0: 0, y1: 120, z0: -40, z1: 80 }
// netherrack floor (top at y 64), lava sea one block lower beside a 3-wide road along z=0..2
const netherWorld = (s) => { s.floor(-30, -30, 190, 40, 63, 'netherrack') }

// ================================================================ the log itself
test('segments: thinned to ~2 block vertices, endpoints become nodes, the same walk twice is one segment, routes chain through nodes', () => {
  const n = new NetherNetwork()
  const a = n.addSegment({ points: line([0, 64, 0], [40, 64, 0], 0.5), source: 'walter', verified: true })
  assert.ok(a.points.length <= 24 && a.points.length >= 18, `${a.points.length} vertices`)
  assert.strictEqual(a.length, 40)
  const again = n.addSegment({ points: line([0, 64, 1], [40, 64, 1], 0.7), source: 'walter', verified: true })
  assert.strictEqual(again.id, a.id, 'same route: no copy')
  assert.strictEqual(a.walks, 2)
  n.addSegment({ points: line([40, 64, 0], [40, 64, 30]), source: 'walter', verified: true })
  assert.strictEqual(n.nodes().length, 3)
  const start = n.nearestNode({ x: 0, y: 64, z: 0 }), end = n.nearestNode({ x: 40, y: 64, z: 30 })
  const r = n.route(start.id, end.id)
  assert.ok(r.ok); assert.strictEqual(r.legs.length, 2); assert.strictEqual(r.length, 70)
  const back = n.route(end.id, start.id)
  assert.ok(back.legs.every(l => l.reverse), 'walked in the other direction')
  assert.deepStrictEqual(n.pointsOf(r.legs[0].seg, false)[0], n.pointsOf(r.legs[0].seg, true).at(-1))
})

test('only verified, unblocked segments are used; the shorter of two logged routes wins; a block removes a segment from planning', () => {
  const n = new NetherNetwork()
  n.addSegment({ points: line([0, 64, 0], [60, 64, 0]), source: 'walter', verified: true })
  const long1 = n.addSegment({ points: line([0, 64, 0], [30, 64, 40]), source: 'walter', verified: true })
  const long2 = n.addSegment({ points: line([30, 64, 40], [60, 64, 0]), source: 'walter', verified: true })
  const a = n.nearestNode({ x: 0, y: 64, z: 0 }), b = n.nearestNode({ x: 60, y: 64, z: 0 })
  assert.strictEqual(n.route(a.id, b.id).legs.length, 1, 'direct')
  const direct = n.segments().find(s => s.length === 60)
  n.noteBotWalk(direct.id, false, 'hazard ahead: lava')
  assert.ok(direct.blocked)
  const around = n.route(a.id, b.id)
  assert.ok(around.ok && around.legs.length === 2, 'goes the long way round')
  n.noteBotWalk(long1.id, false, 'ledge')
  assert.strictEqual(n.route(a.id, b.id).ok, false)
  n.clearBlock(long1.id); n.clearBlock(direct.id)
  assert.ok(n.route(a.id, b.id).ok)
  // an unverified one is not used by default
  const m = new NetherNetwork()
  m.addSegment({ points: line([0, 64, 0], [30, 64, 0]), source: 'bot-explore', verified: false })
  const p = m.nodes()
  assert.strictEqual(m.route(p[0].id, p[1].id).ok, true, 'the bot\'s own exploration track (walked once) can be used to return')
  const w = new NetherNetwork(); w.addSegment({ points: line([0, 64, 0], [30, 64, 0]), source: 'walter', verified: false })
  assert.strictEqual(w.route(w.nodes()[0].id, w.nodes()[1].id).ok, false, 'a walked-by-someone-else segment stays unusable until verified')
  assert.strictEqual(w.route(w.nodes()[0].id, w.nodes()[1].id, { allowUnverified: true }).ok, true)
})

test('verification: an exploration track becomes verified after a second clean walk; an incident blocks it', () => {
  const n = new NetherNetwork()
  const s = n.addSegment({ points: line([0, 64, 0], [30, 64, 0]), source: 'bot-explore', verified: false })
  assert.strictEqual(s.botWalks, 1); assert.strictEqual(s.verified, false)
  n.noteBotWalk(s.id, true)
  assert.strictEqual(s.verified, true)
  n.noteBotWalk(s.id, false, 'wall')
  assert.ok(s.blocked && /wall/.test(s.blocked.reason))
  assert.strictEqual(n.summary().blocked, 1)
})

test('persistence: written atomically, reloaded intact, a broken file is ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nn-')), file = path.join(dir, 'state', 'nether-network.json')
  const n = new NetherNetwork({ file })
  n.addSegment({ points: line([0, 64, 0], [40, 64, 0]), source: 'walter', verified: true, hazards: [{ kind: 'lava', x: 10, y: 64, z: 2, r: 2, idx: 3 }] })
  n.ask({ kind: 'explore', label: 'x' })
  assert.ok(n.save()); assert.strictEqual(n.dirty, false)
  const m = new NetherNetwork({ file })
  assert.strictEqual(m.segments().length, 1); assert.strictEqual(m.data.hazards.length, 1); assert.ok(m.pending())
  const r = m.route(m.nodes()[0].id, m.nodes()[1].id); assert.ok(r.ok)
  fs.writeFileSync(file, '{ nope')
  assert.strictEqual(new NetherNetwork({ file }).segments().length, 0)
})

test('seeding from Walter\'s Xaero Nether waypoints: portals are verified portal nodes, the rest places of interest, the lava near the arrival portal is a hazard', () => {
  const book = { all: (dim) => dim === -1 ? [{ name: 'Portal', x: -130, y: 61, z: 284 }, { name: 'Portal', x: -548, y: 64, z: 288 }, { name: 'Lava Source', x: -84, y: 32, z: 281 }] : [] }
  const n = new NetherNetwork()
  const added = n.seedFromBook(book, [{ kind: 'lava', x: -129, y: 61, z: 288, r: 16, note: 'driver' }])
  assert.strictEqual(added, 3)
  assert.deepStrictEqual(n.nodes().map(x => [x.kind, x.verified]).sort(), [['poi', true], ['portal', true], ['portal', true]])
  assert.strictEqual(n.hazardsNear({ x: -130, y: 61, z: 284 }, 4).length, 1)
  assert.strictEqual(n.seedFromBook(book, [{ kind: 'lava', x: -129, y: 61, z: 288, r: 16 }]), 0, 'seeding twice adds nothing')
  assert.strictEqual(n.data.hazards.length, 1)
})

// ================================================================ hazards next to a path
test('scanHazards: lava within two blocks and ledges are noted, a clean path has none', () => {
  const sim = makeSim({ bounds: NETHER, pos: [0.5, 64, 0.5] })
  netherWorld(sim)
  sim.fill(10, 64, 3, 12, 64, 3, 'lava')                            // lava 3 blocks north... (z=3) : two blocks from a path at z=1
  sim.fill(20, 63, 2, 24, 63, 6, 'air'); sim.fill(20, 62, 2, 24, 62, 6, 'air'); sim.fill(20, 61, 2, 24, 61, 6, 'air'); sim.fill(20, 60, 2, 24, 60, 6, 'air')   // a hole beside the path
  const clean = scanHazards(sim.bot, line([0.5, 64, 0.5], [8.5, 64, 0.5]))
  assert.deepStrictEqual(clean, [])
  const lava = scanHazards(sim.bot, line([8.5, 64, 1.5], [14.5, 64, 1.5]))
  assert.ok(lava.some(h => h.kind === 'lava'))
  const ledge = scanHazards(sim.bot, line([18.5, 64, 1.5], [26.5, 64, 1.5]))
  assert.ok(ledge.some(h => h.kind === 'ledge'))
  sim.dispose()
})

// ================================================================ recording Walter's walks
function recorderRig(extra = {}) {
  const sim = makeSim({ bounds: NETHER, pos: [0.5, 64, 0.5] })
  netherWorld(sim)
  sim.bot.game.dimension = 'the_nether'
  const network = new NetherNetwork()
  const rec = new PathRecorder({ bot: sim.bot, network, ownerName: 'OGWO', dimOf, ...extra }).attach()
  const walter = { entity: { position: new Vec3(0.5, 64, 10.5), onGround: true } }
  sim.bot.players.OGWO = walter
  // move Walter along a polyline at ~5 blocks per second
  const walterWalk = async (pts, { ground = true, speed = 0.25 } = {}) => {
    for (const p of pts) {
      while (walter.entity.position.distanceTo(new Vec3(p.x, p.y, p.z)) > 0.01) {
        const d = new Vec3(p.x, p.y, p.z).minus(walter.entity.position), n = d.norm()
        walter.entity.position = n <= speed ? new Vec3(p.x, p.y, p.z) : walter.entity.position.plus(d.scaled(speed / n))
        walter.entity.onGround = ground
        await sim.run(null, 1)
      }
    }
  }
  return { sim, network, rec, walter, walterWalk, close() { rec.detach(); sim.dispose() } }
}

test('recording: a walk by Walter in the Nether becomes a verified segment, with the hazards beside it', async () => {
  const r = recorderRig()
  r.sim.fill(20, 64, 12, 22, 64, 12, 'lava')                              // lava one block off the path
  await r.walterWalk(line([0.5, 64, 10.5], [60.5, 64, 10.5]))
  await r.sim.run(null, 400)                                              // Walter stands still for a while: the trace ends
  const segs = r.network.segments()
  assert.strictEqual(segs.length, 1)
  assert.strictEqual(segs[0].source, 'walter'); assert.strictEqual(segs[0].verified, true)
  assert.ok(segs[0].length >= 58 && segs[0].length <= 62)
  assert.ok(segs[0].hazards.some(h => h.kind === 'lava'), 'lava noted')
  assert.ok(r.network.data.hazards.some(h => h.kind === 'lava'))
  r.close()
})

test('recording ignores flying/teleports, tiny wanders, other dimensions, and can be switched off', async () => {
  let r = recorderRig()
  await r.walterWalk(line([0.5, 64, 10.5], [60.5, 64, 10.5]), { ground: false })
  await r.sim.run(null, 150)
  assert.strictEqual(r.network.segments().length, 0, 'flying is not a walked path')
  await r.walterWalk(line([60.5, 64, 10.5], [66.5, 64, 10.5]))
  await r.sim.run(null, 700)
  assert.strictEqual(r.network.segments().length, 0, 'six blocks is not a route')
  r.walter.entity.position = new Vec3(100.5, 64, 10.5)                     // teleported
  await r.sim.run(null, 12)
  assert.strictEqual(r.network.segments().length, 0)
  r.rec.enabled = false
  await r.walterWalk(line([100.5, 64, 10.5], [160.5, 64, 10.5]))
  await r.sim.run(null, 150)
  assert.strictEqual(r.network.segments().length, 0, 'logging switched off')
  r.close()
  r = recorderRig(); r.sim.bot.game.dimension = 'overworld'
  await r.walterWalk(line([0.5, 64, 10.5], [60.5, 64, 10.5]))
  await r.sim.run(null, 150)
  assert.strictEqual(r.network.segments().length, 0, 'overworld walks are not Nether routes')
  r.close()
})

test('the bot\'s own track is only recorded during an approved exploration, and then as an unverified segment', async () => {
  const r = recorderRig()
  const walkBot = async () => { r.sim.bot.setControlState('forward', true); r.sim.bot.look(Math.PI, 0); await r.sim.run(() => r.sim.at().z > 34, 600); r.sim.bot.clearControlStates() }
  await walkBot(); await r.sim.run(null, 150)
  assert.strictEqual(r.network.segments().length, 0)
  r.sim.bot.entity.position = new Vec3(0.5, 64, 0.5); r.sim.bot.entity.velocity = new Vec3(0, 0, 0); r.rec.flush('reset')
  r.rec.botTrace = true
  await walkBot()
  r.rec.botTrace = false
  const seg = r.rec.end('bot', 'test')
  assert.ok(seg && seg.source === 'bot-explore' && !seg.verified && seg.botWalks === 1)
  r.close()
})

// ================================================================ following a logged segment (no pathfinder)
function walkerRig(build = () => {}) {
  const sim = makeSim({ bounds: NETHER, pos: [0.5, 64, 0.5] })
  netherWorld(sim); build(sim)
  sim.bot.game.dimension = 'the_nether'
  const calls = []
  const origSet = sim.bot.pathfinder.setGoal
  sim.bot.pathfinder.setGoal = (g, d) => { if (g) calls.push(g); return origSet.call(sim.bot.pathfinder, g, d) }
  const walker = new SegmentWalker({ bot: sim.bot }).attach()
  const go = async (pts, o = {}) => { let res; walker.walk(pts, o).then(x => { res = x }); await sim.run(() => res, o.maxTicks || 1500); return res || { ok: false, err: 'no result' } }
  return { sim, walker, go, calls, close() { walker.detach(); sim.dispose() } }
}

test('walker: follows a logged line over steps up and down without any pathfinder goal', async () => {
  const w = walkerRig(s => { for (let x = 20; x <= 45; x++) { s.set(x, 64, 0, 'netherrack'); s.set(x, 64, 1, 'netherrack') } for (let x = 30; x <= 45; x++) { s.set(x, 65, 0, 'netherrack'); s.set(x, 65, 1, 'netherrack') } })
  const pts = [...line([0.5, 64, 0.5], [18.5, 64, 0.5]), ...line([20.5, 65, 0.5], [28.5, 65, 0.5]), ...line([30.5, 66, 0.5], [44.5, 66, 0.5]), { x: 46.5, y: 64, z: 0.5 }]
  const res = await w.go(pts)
  assert.ok(res.ok, JSON.stringify(res))
  assert.deepStrictEqual(w.calls, [], 'the pathfinder was never given a goal')
  assert.ok(w.sim.maxStep < 0.7)
  w.close()
})

test('walker: stops before lava that appeared on the line, before a hole, before a wall, and says why', async () => {
  for (const [what, build, want] of [
    ['lava', s => { s.set(15, 64, 0, 'lava') }, /hazard ahead: lava/],
    ['hole', s => { for (let y = 58; y <= 63; y++) for (let z = -1; z <= 2; z++) { s.set(15, y, z, 'air'); s.set(16, y, z, 'air') } }, /ledge/],
    ['wall', s => { s.fill(15, 64, -2, 15, 66, 3, 'netherrack') }, /wall/],
    ['fire', s => { s.set(15, 64, 0, 'fire') }, /hazard ahead: fire/]
  ]) {
    const w = walkerRig(build)
    const res = await w.go(line([0.5, 64, 0.5], [30.5, 64, 0.5]))
    assert.strictEqual(res.ok, false, what)
    assert.match(res.err, want, what)
    assert.ok(w.sim.at().x < 15.2, `${what}: stopped before it (x=${w.sim.at().x})`)
    assert.ok(!Object.values(w.sim.bot.controlState).some(Boolean), 'keys released')
    assert.deepStrictEqual(w.calls, [])
    w.close()
  }
})

test('walker: refuses to start away from the line, and gives up when it is pushed off the line', async () => {
  const w = walkerRig()
  const far = await w.go(line([30.5, 64, 20.5], [60.5, 64, 20.5]))
  assert.strictEqual(far.err, 'not on the logged route')
  let res; w.walker.walk(line([0.5, 64, 0.5], [40.5, 64, 0.5])).then(x => { res = x })
  await w.sim.run(null, 30)
  w.sim.bot.entity.position = new Vec3(w.sim.at().x, 64, 6.5)               // knocked off the line
  await w.sim.run(() => res, 60)
  assert.strictEqual(res.err, 'off the logged route')
  w.close()
})

test('walker: waits for unloaded chunks instead of guessing, abort stops it at once', async () => {
  const w = walkerRig()
  let res; w.walker.walk(line([0.5, 64, 0.5], [30.5, 64, 0.5]), { isAborted: () => w.sim.ticks > 60 }).then(x => { res = x })
  await w.sim.run(() => res, 200)
  assert.strictEqual(res.err, 'aborted')
  assert.ok(!Object.values(w.sim.bot.controlState).some(Boolean))
  w.close()
})

// ================================================================ the module in the Nether
const fakeXaero = (byDim) => ({ listWorlds: () => [{ name: 'W', waypoints: true, map: true }], waypoints: (w, dim) => (byDim[dim] || []).map(p => ({ disabled: false, ...p, dim })), openMap: () => null })
async function setup({ build = netherWorld, xaero = {}, extra = {}, pos = [3.5, 64, 0.5], dim = 'the_nether', bounds = NETHER } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nethermod-'))
  fs.writeFileSync(path.join(dir, 'waypoints.json'), '{}'); fs.mkdirSync(path.join(dir, 'state'))
  const sim = makeSim({ bounds, pos }); build(sim)
  sim.bot.game.dimension = dim
  legacyMovements(sim.bot)
  await sim.settle(30)
  const said = [], commands = []
  const scheduler = new Scheduler({ stateFile: path.join(dir, 'state', 'scheduler.json'), now: () => Date.now() })
  const safehand = makeSafehand({ bot: sim.bot, pollMs: 50 })
  const api = { bot: sim.bot, PRIORITY, scheduler, goals, safehand, ownerName: 'OGWO', dir, now: () => sim.now(), say: (t) => said.push(t), log: () => {}, statePath: (f) => path.join(dir, 'state', f), events: new EventEmitter(),
    canSee: (t) => losLib.canSee(sim.bot, t), ensureLineOfSight: async () => true, xaero: fakeXaero(xaero), commands: { add(c) { commands.push(c); return true }, dispatch() { return false } }, ...extra }
  const route = (user, text) => { const t = normalize(text); for (const c of commands) { let hit = false; try { hit = typeof c.match === 'function' ? c.match(user, t) : c.match.test(t) } catch {} if (hit) { c.run(user, text, t); return c.name } } return false }
  const handle = register(api); handle.start()
  const settle = async (pred, ticks = 3000) => { let n = 0; for (; n < ticks; n++) { sim.tick(); await new Promise(r => setImmediate(r)); if (pred()) break } return n }
  return { sim, said, commands, scheduler, handle, route, settle, dir, net: handle.nether.network, close() { handle.stop(); sim.dispose() } }
}
const NX = { '-1': [{ name: 'Home Portal', x: 1, y: 64, z: 0 }, { name: 'Basalt Camp', x: 60, y: 64, z: 4 }, { name: 'Far Fort', x: 120, y: 64, z: 30 }] }

test('in the Nether, "go to <place>" walks the logged route only', async () => {
  const m = await setup({ xaero: NX })
  m.net.addSegment({ points: line([1.5, 64, 0.5], [60.5, 64, 4.5]), source: 'walter', verified: true })
  const realSet = m.sim.bot.pathfinder.setGoal; m.sim.bot.pathfinder.setGoal = (g, d) => { if (g) throw new Error('the pathfinder must not be given a goal in the Nether'); return realSet.call(m.sim.bot.pathfinder, g, d) }
  assert.strictEqual(m.route('OGWO', 'go to basalt camp'), 'nav-goto')
  await m.settle(() => m.said.some(t => /Arrived|couldn't/.test(t)), 3000)
  assert.match(m.said.at(-1), /Arrived at Basalt Camp/, m.said.join(' | '))
  assert.ok(m.sim.at().distanceTo(new Vec3(60.5, 64, 4.5)) < 3)
  assert.strictEqual(m.net.segments()[0].botWalks, 1)
  m.close()
})

test('a place with no logged route: nothing is walked, Walter is asked once, "no" drops the question', async () => {
  const m = await setup({ xaero: NX })
  m.net.addSegment({ points: line([1.5, 64, 0.5], [60.5, 64, 4.5]), source: 'walter', verified: true })
  const start = m.sim.at().clone()
  assert.strictEqual(m.route('OGWO', 'go to far fort'), 'nav-goto')
  assert.match(m.said.at(-1), /no logged Nether route to Far Fort.*explore the nether route/i)
  await m.settle(() => false, 100)
  assert.ok(m.sim.at().distanceTo(start) < 0.5, 'did not move')
  assert.ok(m.net.pending())
  assert.strictEqual(m.route('OGWO', 'no'), 'nether-explore-no')
  assert.strictEqual(m.net.pending(), null)
  assert.strictEqual(m.route('OGWO', 'explore the nether route'), false, 'nothing pending any more: not captured')
  m.close()
})

test('explore needs the question first, and Walter\'s "explore the nether route" then runs it with the pathfinder, logging an unverified route that later trips may use', async () => {
  const m = await setup({ xaero: NX })
  m.net.addSegment({ points: line([1.5, 64, 0.5], [60.5, 64, 4.5]), source: 'walter', verified: true })
  assert.strictEqual(m.route('OGWO', 'explore the nether route'), false, 'no question pending: ignored')
  m.route('OGWO', 'go to far fort')
  assert.strictEqual(m.route('OGWO', 'yes explore the nether route'), 'nether-explore-ok')
  await m.settle(() => m.said.some(t => /Arrived|couldn't/.test(t)), 9000)
  assert.match(m.said.join(' | '), /Exploring the Nether toward Far Fort/)
  assert.match(m.said.at(-1), /Arrived at Far Fort/, m.said.join(' | '))
  const fresh = m.net.segments().filter(s => s.source === 'bot-explore')
  assert.strictEqual(fresh.length, 1)
  assert.strictEqual(fresh[0].verified, false); assert.strictEqual(fresh[0].botWalks, 1)
  assert.match(m.said.join(' | '), /Logged \d+ blocks of new Nether route/)
  // the way back is now a logged route: walked with no pathfinder
  const realSet2 = m.sim.bot.pathfinder.setGoal; m.sim.bot.pathfinder.setGoal = (g, d) => { if (g) throw new Error('no pathfinder goal in the Nether'); return realSet2.call(m.sim.bot.pathfinder, g, d) }
  m.said.length = 0
  m.route('OGWO', 'go to home portal')
  await m.settle(() => m.said.some(t => /Arrived|couldn't|no logged/.test(t)), 9000)
  assert.match(m.said.at(-1), /Arrived at Home Portal/, m.said.join(' | '))
  assert.strictEqual(fresh[0].verified, true, 'second clean walk verifies it')
  m.close()
})

test('the guard: a far goto in the Nether is refused, short local moves and approved explorations are not', async () => {
  const m = await setup({})
  const far = await new Promise(res => { m.handle.goto(new goals.GoalNear(50, 64, 0, 1), { label: 'far' }).then(res); m.sim.run(null, 5) })
  assert.strictEqual(far.ok, false); assert.match(far.err, /walked only along logged routes/)
  const follow = await new Promise(res => { m.handle.goto(new goals.GoalFollow({ position: new Vec3(40, 64, 0), height: 1.8 }, 2), { label: 'you', dynamic: true }).then(res); m.sim.run(null, 5) })
  assert.match(follow.err, /logged routes/)
  let near; m.handle.goto(new goals.GoalNear(8.5, 64, 0.5, 1), { label: 'beside the portal' }).then(x => { near = x })
  await m.settle(() => near, 400)
  assert.ok(near.ok, JSON.stringify(near))
  let ok; m.handle.goto(new goals.GoalNear(30.5, 64, 0.5, 1), { label: 'approved', netherOk: true }).then(x => { ok = x })
  await m.settle(() => ok, 600)
  assert.ok(ok.ok)
  m.close()
})

test('a logged segment that is no longer safe stops the bot, is marked blocked, and "nether route ok" clears it', async () => {
  const m = await setup({ xaero: NX })
  m.net.addSegment({ points: line([1.5, 64, 0.5], [60.5, 64, 4.5]), source: 'walter', verified: true })
  m.sim.set(30, 63, 2, 'netherrack')
  // lava has flowed over the road at x=30
  for (let z = -1; z <= 4; z++) m.sim.set(30, 64, z, 'lava')
  m.route('OGWO', 'go to basalt camp')
  await m.settle(() => m.said.some(t => /marked it blocked|couldn't/.test(t)), 3000)
  assert.ok(m.said.some(t => /stopped on a logged Nether route \(hazard ahead: lava\).*blocked/.test(t)), m.said.join(' | '))
  assert.ok(m.sim.at().x < 30)
  assert.strictEqual(m.net.summary().blocked, 1)
  assert.ok(!Object.values(m.sim.bot.controlState).some(Boolean))
  m.said.length = 0
  m.route('OGWO', 'go to basalt camp')                                       // blocked: now there is no usable route, so it asks instead of trying again
  assert.match(m.said.at(-1), /no logged Nether route/)
  for (let z = -1; z <= 4; z++) m.sim.set(30, 64, z, 'air')
  m.route('OGWO', 'the nether route is ok')
  assert.strictEqual(m.net.summary().blocked, 0)
  m.close()
})

test('from the overworld: a trip into the Nether is not started when there is no logged route on the Nether side', async () => {
  const hops = []
  const m = await setup({
    dim: 'overworld', pos: [0.5, 64, 0.5], bounds: { x0: -40, x1: 200, y0: 0, y1: 120, z0: -40, z1: 80 },
    build: s => s.floor(-30, -30, 190, 40, 63),
    xaero: { 0: [{ name: 'Home Portal', x: 8, y: 64, z: 0 }], '-1': [{ name: 'Home Portal', x: 1, y: 64, z: 0 }, { name: 'Far Fort', x: 120, y: 64, z: 30 }] },
    extra: { usePortal: async (w) => { hops.push(w) } }
  })
  const start = m.sim.at().clone()
  assert.strictEqual(m.route('OGWO', 'go to far fort'), 'nav-travel')
  await m.settle(() => false, 100)
  assert.deepStrictEqual(hops, [], 'never went through the portal')
  assert.ok(m.sim.at().distanceTo(start) < 0.5)
  assert.match(m.said.at(-1), /explore the nether route/)
  m.close()
})

test('commands: network status, switching the logging of Walter\'s walks, and the pending question is part of the status', async () => {
  const m = await setup({ xaero: NX })
  m.net.addSegment({ points: line([1.5, 64, 0.5], [60.5, 64, 4.5]), source: 'walter', verified: true })
  assert.strictEqual(m.route('OGWO', 'what is the nether network'), 'nether-network')
  assert.match(m.said.at(-1), /Nether network: 1 portals, 1 usable routes \(\d+ blocks\), 0 unverified, 0 blocked, 1 hazards logged/)
  assert.strictEqual(m.route('OGWO', 'stop logging my nether walks'), 'nether-log')
  assert.strictEqual(m.handle.nether.recorder.enabled, false)
  assert.strictEqual(m.route('OGWO', 'log my nether walks'), 'nether-log')
  assert.strictEqual(m.handle.nether.recorder.enabled, true)
  assert.doesNotThrow(() => JSON.stringify(m.handle.status()))
  assert.strictEqual(m.handle.status().nether.usable, 1)
  m.close()
})

test('persisted: the network survives a restart (same state dir)', async () => {
  const m = await setup({ xaero: NX })
  m.net.addSegment({ points: line([1.5, 64, 0.5], [60.5, 64, 4.5]), source: 'walter', verified: true })
  m.net.save()
  const file = path.join(m.dir, 'state', 'nether-network.json')
  m.close()
  assert.ok(fs.existsSync(file))
  const again = new NetherNetwork({ file })
  assert.strictEqual(again.segments().length, 1)
})
