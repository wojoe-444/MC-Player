// Work order finding-ozo-iron-goal-shaft-shuttle: the iron goal rides the shaft down, its tunnel digs a little or nothing, and the trip climbs back up
// at once (4 legs of 10+ blocks between y37 and y77 in 2.5 min, 3 digs, 0 places, iron stuck at 14). The last climb in the iron step (brain/autopilot/plan.js,
// after the tunnel) goes up when nextGearCost() is met by the iron in the bag. With no shield that cost is 1 ingot, so any iron at all sent the bot up after
// every tunnel. The shield the climb is for is made by the shield step only with 6 planks (or the logs for them); with no wood the climb went up and came
// back down for nothing. The test drives the real iron step on a made-up shaft (bot at y56, bottom at y55) with the tunnel stubbed to dig nothing, and
// records whether the trip climbs back. Controls: with wood for the shield the climb is kept, and a bag of 24 ingots climbs for its own reason.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'), os = require('os'), path = require('path')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')

const key = (x, y, z) => `${x},${y},${z}`

// a made-up flat world: stone up to y63, air above, a red bed at home 0,64,0; the bot stands in a shaft at 0.5,56,0.5 (entry 0,65,0, bottom 0,55,0).
function rig({ ingots, shield = false, planks = 0, logs = 0, tunnel }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-iron-shuttle-'))
  const clock = { now: 1794000000000 }
  const realNow = Date.now
  Date.now = () => clock.now
  const cells = new Map([[key(0, 64, 0), 'red_bed']])
  const name = (x, y, z) => cells.get(key(x, y, z)) || (y <= 63 ? 'stone' : 'air')
  const block = (x, y, z) => { const n = name(x, y, z); return { name: n, boundingBox: n === 'air' || n === 'torch' ? 'empty' : 'block', position: new Vec3(x, y, z) } }
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(0.5, 56, 0.5), onGround: true, yaw: 0 }
  bot.time = { day: 3, timeOfDay: 2000 }
  bot.health = 20; bot.food = 20; bot.username = 'fixer-test'
  bot.registry = { blocksArray: [{ name: 'torch', id: 50 }, { name: 'wall_torch', id: 51 }, { name: 'red_bed', id: 52 }], blocksByName: {}, blocksByStateId: {} }
  bot.world = { getBlockStateId: () => null }
  bot.blockAt = (p) => block(p.x, p.y, p.z)
  bot.findBlocks = () => []
  bot.controlState = {}; bot.setControlState = () => {}; bot.clearControlStates = () => {}; bot.lookAt = async () => {}
  const count = (w) => {
    if (w === 'torch') return 40
    if (w === 'iron_ingot') return ingots
    if (w instanceof RegExp && w.test('iron_pickaxe')) return 2     // two pickaxes: the spare-tool rule passes
    return 0
  }
  const base = {
    bot, goals: { GoalNear: class { constructor (x, y, z, r) { Object.assign(this, { x, y, z, r }) } }, GoalBlock: class { constructor (x, y, z) { Object.assign(this, { x, y, z }) } } },
    v: (x, y, z) => new Vec3(x, y, z), flo: (p) => new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    block: (p) => block(p.x, p.y, p.z), isAir: (b) => !!b && b.name === 'air', isLiquid: () => false, isWaterish: () => false,
    passable: (b) => !!b && b.boundingBox === 'empty', solid: (b) => !!b && b.boundingBox === 'block',
    dist: (p) => bot.entity.position.distanceTo(p), count,
    has: (n) => n === 'shield' && shield, planks: () => planks, logs: () => logs, foodPoints: () => 20, rawFood: () => 0,
    items: () => [], toolTier: () => 3, freeSlots: () => 20, isNight: () => false, skyVisible: () => true,
    check() {}, wait: async () => {}, say() {}, aborted: () => false, isAbort: () => false, stepDeadline: 0,
    goto: async (goal) => { clock.now += 5000; bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); return { ok: true } },
  }
  const S = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => 0) })
  const api = { statePath: (f) => path.join(dir, f), profile: { get: () => ({ role: 'hillclimber', steps: null }) } }
  const prevReg = process.env.BOT_REGISTRY
  process.env.BOT_REGISTRY = path.join(dir, 'registry.json')     // no shared registry here
  const G = require('../brain/autopilot/goals')(S, {}, api, () => {})
  G.state.home = [0, 64, 0]
  G.state.mine = { entry: [0, 65, 0], bottom: [0, 55, 0], wall: [1, 0], ladder: true, shaft: 'test-shaft', dir0: 0, path: [] }
  // the tunnel and the climb are recorded, not run: what the trip does after the tunnel returns is the thing under test
  const M = {
    stops: [], tunnelLens: [], ups: 0,
    tunnel: async (dirIdx, len, opts) => { M.stops.push(opts.stop()); M.tunnelLens.push(len); return { ...tunnel } },
  }
  require('../brain/autopilot/plan')(G, S, M, api, () => {})
  // plan.js installs its own M.goSurface (the real climb): the rig counts each call and lets the real one run (the rig's sky is open, so it returns at once)
  const realUp = M.goSurface
  M.goSurface = async (...a) => { M.ups++; return realUp(...a) }
  const iron = G.steps.find(s => s.id === 'iron')
  return {
    G, iron, M,
    dispose: () => { try { G.dispose && G.dispose() } catch {} ; Date.now = realNow; if (prevReg === undefined) delete process.env.BOT_REGISTRY; else process.env.BOT_REGISTRY = prevReg }
  }
}

test('an iron trip with 14 ingots and no wood for a shield does not climb back up after a tunnel that dug nothing', async () => {
  const r = rig({ ingots: 14, tunnel: { len: 0, mined: 0, reason: 'stuck' } })
  try {
    assert.ok(r.iron.need(), 'the iron step is due (14 ingots is under 32)')
    await r.iron.run()
    assert.equal(r.M.stops.length, 1, 'the trip did not reach its tunnel once (the test setup is wrong, not the bot)')
    assert.equal(r.M.ups, 0, 'the trip climbed back up right after its tunnel: the climb is for the next gear (the shield, 1 ingot), and the shield step needs ' +
      '6 planks or logs for it, which the bot does not have, so the climb went up and came back down for nothing')
  } finally { r.dispose() }
})

test('control: with wood for the shield (6 planks) the trip still climbs after its tunnel to make it', async () => {
  const r = rig({ ingots: 14, planks: 6, tunnel: { len: 0, mined: 0, reason: 'stuck' } })
  try {
    await r.iron.run()
    assert.equal(r.M.ups, 1, 'with the planks for the shield the climb after the tunnel is kept')
  } finally { r.dispose() }
})

test('control: 24 ingots with no wood climb after the tunnel for their own reason (the bag is banked at 24)', async () => {
  const r = rig({ ingots: 24, tunnel: { len: 0, mined: 0, reason: 'stuck' } })
  try {
    await r.iron.run()
    assert.equal(r.M.ups, 1, 'at 24 ingots the trip goes up after its tunnel, as before')
  } finally { r.dispose() }
})
