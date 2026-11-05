const test = require('node:test')
const assert = require('node:assert')
const { PathReach } = require('../brain/safety/reach')
const { rig, addMob, until, wait, Vec3 } = require('./safety.combat.helpers')
const { mockBot } = require('./mock-bot')

// pathfinder stand-in: script(goal) -> { status, path:[...] }
function withPaths(bot, script) {
  const calls = []
  bot.pathfinder.movements = {}
  bot.pathfinder.getPathTo = () => { throw new Error('getPathTo must not be used: it overwrites the pathfinder astarContext') }
  bot.pathfinder.getPathFromTo = function * (mv, start, goal, opts) { calls.push({ goal, opts }); yield { result: script(goal), astarContext: {} } }
  return calls
}
const path = (n) => ({ status: 'success', path: Array.from({ length: n }, () => ({})) })
const m = (id, name, x, z, y = 64) => ({ id, name, pos: new Vec3(x, y, z), entity: { height: 1.9 } })
const mk = (script, cfg = {}) => {
  const bot = mockBot({ pos: [0, 64, 0] }); const logs = []; let t = 1000
  const calls = withPaths(bot, script)
  const reach = new PathReach({ bot, goals: bot.goals, now: () => t, log: (x) => logs.push(x), cfg })
  return { bot, reach, logs, calls, tick: (ms) => { t += ms } }
}

test('cave behind rock: no walking path -> suppressed and logged once', () => {
  const { reach, logs } = mk(() => ({ status: 'noPath', path: [] }))
  const z = m(1, 'zombie', 12, 0)
  assert.strictEqual(reach.check([z]).get(1).ok, false)
  reach.check([z])
  assert.strictEqual(logs.filter(l => /suppressed zombie#1/.test(l)).length, 1)
  assert.match(logs[0], /12\.0 blocks/)
})

test('short path counts, long path (> 20) does not, timeout does not', () => {
  const { reach } = mk((g) => g.x === 10 ? path(14) : g.x === 11 ? path(30) : { status: 'timeout', path: [] })
  const r = reach.check([m(1, 'zombie', 10, 0), m(2, 'zombie', 11, 0), m(3, 'zombie', 12, 0)])
  assert.strictEqual(r.get(1).ok, true); assert.strictEqual(r.get(2).ok, false); assert.strictEqual(r.get(3).ok, false)
  assert.match(r.get(2).why, /30 > 20/)
})

test('results are cached per mob for 2 s, then refreshed; moving far invalidates early', () => {
  const { reach, calls, tick } = mk(() => path(10))
  const z = m(1, 'zombie', 10, 0)
  reach.check([z]); reach.check([z]); tick(1500); reach.check([z])
  assert.strictEqual(calls.length, 1)
  tick(600); reach.check([z]); assert.strictEqual(calls.length, 2)
  reach.check([m(1, 'zombie', 15, 3)]); assert.strictEqual(calls.length, 3, 'moved > 4 blocks')
})

test('exceptions: adjacent, flying, climbers (near), arrow users with line of sight, neutral mobs', () => {
  const { reach, calls } = mk(() => ({ status: 'noPath', path: [] }))
  const r = reach.check([m(1, 'zombie', 3, 0), m(2, 'phantom', 15, 0, 70), m(3, 'spider', 8, 0), m(4, 'skeleton', 14, 0), m(5, 'enderman', 10, 5), m(6, 'zombie', 15, 0)])
  for (const id of [1, 2, 3, 4, 5]) assert.strictEqual(r.get(id).ok, true, `mob ${id}: ${r.get(id).why}`)
  assert.strictEqual(r.get(6).ok, false)
  assert.strictEqual(calls.length, 1, 'only the plain zombie was searched')
})

test('skeleton behind a wall with no path: line of sight decides', () => {
  const { bot, reach } = mk(() => ({ status: 'noPath', path: [] }))
  for (let y = 64; y <= 66; y++) for (let z = -3; z <= 3; z++) bot.setBlock(5, y, z, 'stone')
  assert.strictEqual(reach.check([m(1, 'skeleton', 14, 0)]).get(1).ok, false)
})

test('budget: at most 3 searches per scan, the rest only count when very close', () => {
  const { reach, calls } = mk(() => path(8))
  const mobs = [10, 11, 12, 13, 14].map((x, i) => m(i + 1, 'zombie', x, 0)).concat([m(9, 'zombie', 5, 0)])
  const r = reach.check(mobs)
  assert.strictEqual(calls.length, 3)
  assert.strictEqual(r.get(9).ok, true)                              // nearest searched first
  assert.strictEqual(r.get(4).ok, false); assert.strictEqual(r.get(4).why, 'pending')
  assert.strictEqual(reach.check(mobs).get(4).ok, true)              // next scan gets to it
})

test('search is bounded: short timeout, search radius, no side effects on the live route', () => {
  const { reach, calls } = mk(() => path(5))
  reach.check([m(1, 'zombie', 10, 0)])
  const o = calls[0].opts
  assert.ok(o.timeout <= 80 && o.tickTimeout <= 80 && o.searchRadius > 0)
  assert.strictEqual(o.resetEntityIntersects, false)
})

test('no pathfinder / throwing pathfinder: falls back to straight-line (reachable) and says so once', () => {
  const a = mk(() => path(5)); delete a.bot.pathfinder.getPathFromTo
  assert.strictEqual(a.reach.check([m(1, 'zombie', 10, 0)]).get(1).ok, true)
  a.reach.check([m(2, 'zombie', 10, 5)]); assert.strictEqual(a.logs.filter(l => /unavailable/.test(l)).length, 1)
  const b = mk(() => { throw new Error('boom') })
  assert.strictEqual(b.reach.check([m(1, 'zombie', 10, 0)]).get(1).ok, true)
})

test('runtime: a zombie in a cave behind rock raises no alarm and starts no safety task; the same zombie on a walkable path does', async () => {
  const { bot, sched, said, slog, rt } = rig({ mode: 'fight', withReach: true })
  let walkable = false
  withPaths(bot, () => walkable ? path(9) : { status: 'noPath', path: [] })
  addMob(bot, 7, 'zombie', 7, 0)
  rt.scan(); await wait(200)
  assert.strictEqual(sched.running, null)
  assert.strictEqual(said.length, 0)
  assert.ok(slog.some(l => /suppressed zombie#7/.test(l)))
  walkable = true
  bot.entities[7].position = new Vec3(3, 64, 3)       // moved >4 blocks: cache invalidated, now inside fighting range
  rt.scan(); await wait(300)
  assert.ok(sched.running && sched.running.name === 'safety')
  delete bot.entities[7]; await until(() => { rt.scan(); return !sched.running })
})
