// Work order step-wood-stock: wood-stock ran 85 times in a day, failing in 28 of 46 runs of one bot and 18 of 45 of the other, with idle stalls and
// thrash against stash. Its need() (plan.js) reads st.wantLogs, the log count the mine step set while it still had to wait for wood for a
// laddered shaft ("getting wood first"). Nothing clears that value once the shaft is dug, so the step stays due all day against a target the
// bot no longer has a use for. With 16 or more logs in the bag the bootstrap rule (farm.naturalPolicy) refuses natural trees while the farm has
// no grown tree, so each due run fails and the step is picked again after its cooldown. This test drives the real wood-stock step's need()
// on a made-up bag: a shaft already dug with a stale want of 24 logs must not make the step due at 18 logs; while the shaft is still to be
// dug the want still counts; with the shaft dug and a short bag the step still runs.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'), os = require('os'), path = require('path')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')

const SHAFT = { entry: [-10, 64, 10], bottom: [-10, 30, 10], wall: [1, 0], ladder: true, shaft: 'test-shaft', dir0: 0, path: [] }

// a bot with a made-up bag of logs and planks; everything else the planner touches at load is a stub
function rig({ logs = 0, planks = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-ws-'))
  const clock = { now: 1794000000000 }
  const realNow = Date.now
  Date.now = () => clock.now
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(0.5, 64, 0.5), onGround: true, yaw: 0 }
  bot.time = { day: 3, timeOfDay: 6000 }
  bot.health = 20; bot.food = 20; bot.username = 'fixer-test'
  bot.registry = { blocksArray: [], blocksByName: {}, blocksByStateId: {} }
  bot.world = { getBlockStateId: () => null }
  bot.blockAt = () => null
  bot.findBlocks = () => []
  bot.controlState = {}; bot.setControlState = () => {}; bot.clearControlStates = () => {}; bot.lookAt = async () => {}
  const base = {
    bot, goals: { GoalNear: class { constructor (x, y, z, r) { Object.assign(this, { x, y, z, r }) } } },
    v: (x, y, z) => new Vec3(x, y, z), flo: (p) => new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    dist: (p) => bot.entity.position.distanceTo(p),
    logs: () => logs, planks: () => planks,
    items: () => [], freeSlots: () => 20, isNight: () => false, skyVisible: () => true,
    toolTier: () => 3, check() {}, wait: async () => {}, say() {}, aborted: () => false, isAbort: () => false, stepDeadline: 0,
  }
  const S = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => 0) })
  const api = { statePath: (f) => path.join(dir, f), profile: { get: () => ({ role: 'hillclimber', steps: null }) } }
  const prevReg = process.env.BOT_REGISTRY
  process.env.BOT_REGISTRY = path.join(dir, 'registry.json')     // no shared registry here
  const G = require('../brain/autopilot/goals')(S, {}, api, () => {})
  G.state.home = [0, 64, 0]
  require('../brain/autopilot/plan')(G, S, {}, api, () => {})
  const step = G.steps.find(s => s.id === 'wood-stock')
  return {
    G, step,
    dispose: () => { try { G.dispose && G.dispose() } catch {} ; Date.now = realNow; if (prevReg === undefined) delete process.env.BOT_REGISTRY; else process.env.BOT_REGISTRY = prevReg }
  }
}

test('a shaft already dug: a log target the mine set before the dig is no reason for wood-stock to be due', () => {
  const r = rig({ logs: 18 })
  try {
    assert.ok(r.step, 'the wood-stock step exists')
    r.G.state.mine = { ...SHAFT }
    r.G.state.wantLogs = 24                                    // set by the mine while it waited for wood; nothing clears it after the dig
    assert.equal(r.step.need(), false, 'wood-stock is due at 18 logs with the shaft dug, against the stale 24-log target')
  } finally { r.dispose() }
})

test('the shaft still to be dug: the logs the mine asked for keep wood-stock due', () => {
  const r = rig({ logs: 18 })
  try {
    r.G.state.mine = null
    r.G.state.wantLogs = 24
    assert.equal(r.step.need(), true, 'wood-stock is not due although the mine still needs 24 logs for its shaft')
  } finally { r.dispose() }
})

test('the shaft dug and a short bag: wood-stock is still due', () => {
  const r = rig({ logs: 6 })
  try {
    r.G.state.mine = { ...SHAFT }
    r.G.state.wantLogs = 24
    assert.equal(r.step.need(), true, 'wood-stock is not due with 6 logs in the bag')
  } finally { r.dispose() }
})

test('no shaft wanted and enough wood: wood-stock is not due', () => {
  const r = rig({ logs: 18 })
  try {
    assert.equal(r.step.need(), false, 'wood-stock is due with 18 logs and nothing asking for more')
  } finally { r.dispose() }
})
