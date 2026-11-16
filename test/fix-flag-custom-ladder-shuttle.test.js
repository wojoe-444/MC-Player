// Work order flag-custom-ladder-shuttle: the bot holds a ladder (on it) for most of 2 minutes with no digs or places, raised 11 times. The shaft
// travel in the go-to wrapper (brain/autopilot/plan.js, S.goto) rides a ladder for a goal that is far above or below the bot. The DOWN ride stops at
// the goal's level (rideTo to max(bottom, goal y)). The UP ride (LD.up) always climbs the shaft to its top and steps out, whatever the goal's level:
// a goal 12 blocks above a bot underground, still inside the shaft, is walked to from the top, and the walk comes back down the same shaft.
// The test drives the real go-to wrapper and the real ladder module on a made-up shaft: the bot and the server are stubbed, the clock is virtual,
// and a ladder climb is physics (jump and forward on a ladder rise 0.2 blocks a tick). Expected: a goal inside the shaft is reached by riding the
// shaft to the goal's level. Controls: a goal above the top still goes to the top, and a goal 5 blocks up is walked to without a ride.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'), os = require('os'), path = require('path')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')

// a laddered shaft at x 0, z 0: ladders from y 36 (bottom) up to y 69, the entry cell at y 70, the surface (stone) at y 69 and open air above it.
const SHAFT = { id: 'test-shaft', by: 'test-bot', entry: [0, 70, 0], wall: [1, 0], bottom: [0, 36, 0], at: 0, levels: [] }
class GoalBlock { constructor (x, y, z) { this.x = x; this.y = y; this.z = z } }
class GoalNear { constructor (x, y, z, r) { this.x = x; this.y = y; this.z = z; this.r = r } }

function rig(y0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-ladder-shuttle-'))
  // the ladder module reads its registry when plan.js loads it, so the scratch registry is set before that
  process.env.BOT_REGISTRY = path.join(dir, 'registry.json')
  fs.writeFileSync(process.env.BOT_REGISTRY, JSON.stringify({ worlds: { 'spawn 0,0': { shafts: [SHAFT], rooms: [] } } }))
  const name = (x, y, z) => (x === 0 && z === 0 && y >= 36 && y <= 69) ? 'ladder' : (y <= 69 ? 'stone' : 'air')
  const block = (x, y, z) => { const n = name(x, y, z); return { name: n, boundingBox: /^(air|ladder)$/.test(n) ? 'empty' : 'block', position: new Vec3(x, y, z) } }
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, y0, 0.5), onGround: false, yaw: 0 },
    username: 'test-bot', spawnPoint: { x: 0, z: 0 }, controlState: {}, time: { day: 3, timeOfDay: 2000 }, health: 20, food: 20,
    registry: { blocksArray: [], blocksByName: {}, blocksByStateId: {} },
    inventory: { items: () => [], slots: [] },
    setControlState (k, on) { bot.controlState[k] = !!on },
    clearControlStates () { for (const k of Object.keys(bot.controlState)) bot.controlState[k] = false },
    lookAt: async () => {}, equip: async () => {},
  })
  const calls = []                    // every walk the plain go-to was asked for: the goal object and the bot's height at the time
  const base = {
    bot, goals: { GoalBlock, GoalNear }, v: (x, y, z) => new Vec3(x, y, z),
    flo: (p) => new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    block: (p) => block(p.x, p.y, p.z), dist: (p) => bot.entity.position.distanceTo(p),
    isLiquid: () => false, isWaterish: () => false, skyVisible: () => false,
    check () {}, wait: async () => {}, pickup: async () => true, items: () => [], aborted: () => false, isAbort: () => false,
    count: (n) => (n === 'ladder' ? 10 : 0), craft: async () => false, placeAgainst: async () => false,
    _gotoNoShaft: undefined,           // unset, so plan.js installs the shaft-first wrapper on it
    goto: async (goal) => { calls.push({ goal, y: bot.entity.position.y }); return { ok: true } },
  }
  const S = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => 0) })
  const api = { statePath: (f) => path.join(dir, f), profile: { get: () => ({ role: 'hillclimber', steps: null }) } }
  const G = require('../brain/autopilot/goals')(S, {}, api, () => {})
  require('../brain/autopilot/plan')(G, S, { tunnel: async () => ({ len: 0, mined: 0, reason: 'stop' }), goSurface: async () => 'ok' }, api, () => {})
  return { S, bot, calls, name, dispose: () => { try { G.dispose && G.dispose() } catch {} } }
}

// the clock is virtual: each sleep advances it at once. Holding jump and forward on a ladder rises 0.2 blocks a tick (50 ms); the highest feet are kept.
function climbClock(r) {
  const real = { now: Date.now, timeout: global.setTimeout }
  const clock = { t: 1e12, maxY: -Infinity }
  Date.now = () => clock.t
  global.setTimeout = (fn, ms = 0) => {
    clock.t += ms
    const p = r.bot.entity.position, cs = r.bot.controlState
    if (cs.jump && cs.forward && r.name(0, Math.floor(p.y + 1e-3), 0) === 'ladder') r.bot.entity.position = new Vec3(0.5, p.y + 0.2 * ms / 50, 0.5)
    clock.maxY = Math.max(clock.maxY, r.bot.entity.position.y)
    Promise.resolve().then(fn)
    return 0
  }
  return { clock, restore: () => { Date.now = real.now; global.setTimeout = real.timeout } }
}

// one go-to from `y0` in the shaft to `goal`, the way a step makes it (the plain walk is stubbed; the shaft rides are real)
async function walkTo(goal, y0) {
  const r = rig(y0)
  const vc = climbClock(r)
  try {
    await r.S.goto(goal, { dig: false, ms: 30000, escalate: false })
    return { calls: r.calls, maxY: vc.clock.maxY }
  } finally { vc.restore(); r.dispose() }
}

test('a goal 12 blocks above the bot, still inside the shaft, is reached by riding the shaft to its level, not up to its top and back down', async () => {
  const goal = new GoalNear(5, 52, 5, 2)
  const r = await walkTo(goal, 40)
  const walk = r.calls.find(c => c.goal === goal)
  assert.ok(walk, 'the walk to the goal was made')
  assert.ok(walk.y <= 53, `the walk to the goal (y52) started at y${walk.y.toFixed(1)}: the bot rode the shaft up past the goal to its top and walked from there, ` +
    'and the walk comes back down the same ladder with no digs or places')
  assert.ok(r.maxY <= 53, `the bot climbed to y${r.maxY.toFixed(1)} for a goal at y52`)
})

test('control: a goal above the top of the shaft is still climbed to the top and walked to from there', async () => {
  const goal = new GoalNear(5, 74, 5, 2)
  const r = await walkTo(goal, 40)
  const walk = r.calls.find(c => c.goal === goal)
  assert.ok(walk, 'the walk to the goal was made')
  assert.ok(walk.y >= 69, `the walk to y74 started at y${walk.y.toFixed(1)}: a goal above the top is climbed to the top first`)
})

test('control: a goal 5 blocks up is walked to from where the bot stands, with no shaft ride', async () => {
  const goal = new GoalNear(5, 45, 5, 2)
  const r = await walkTo(goal, 40)
  const walk = r.calls.find(c => c.goal === goal)
  assert.ok(walk, 'the walk to the goal was made')
  assert.equal(walk.y, 40, 'the walk started where the bot stood: no ride for a goal under 7 blocks up')
})
