// Work order flag-custom-shaft-round-trip: vertical legs of 10+ blocks with no digs or places. The iron step (brain/autopilot/plan.js) rides the ladder shaft
// down and then runs its tunnel. The tunnel's stop test had a clause for the next gear's iron (nextGearCost(), 1 ingot while no shield is held). With iron
// in the bag and no wood for a shield, that clause was already true, so the tunnel stopped before its first cell: the trip rode down, dug nothing, climbed
// back up, and was due again at once. The test drives the real iron step on a made-up shaft (bot at y56, bottom at y55) and records what the tunnel's stop
// test answers at the start of the trip. The tunnel and the climb are stubbed; the ride itself is not needed to show the stop.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'), os = require('os'), path = require('path')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')

const key = (x, y, z) => `${x},${y},${z}`

// a made-up flat world: stone up to y63, air above, a red bed at home 0,64,0; the bot stands in a shaft at 0.5,56,0.5 (entry 0,65,0, bottom 0,55,0).
function rig({ ingots, shield, freeSlots = 20 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-shaft-trip-'))
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
    has: (n) => n === 'shield' && shield, foodPoints: () => 20, rawFood: () => 0,
    items: () => [], toolTier: () => 3, freeSlots: () => freeSlots, isNight: () => false, skyVisible: () => true,
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
  // the tunnel and the climb are recorded, not run: what the tunnel's stop test says at the start of the trip is the thing under test
  const M = {
    stops: [], tunnelLens: [], ups: 0,
    tunnel: async (dirIdx, len, opts) => { M.stops.push(opts.stop()); M.tunnelLens.push(len); return { len: 0, mined: 0, reason: 'stop' } },
    goSurface: async () => { M.ups++; return 'ok' },
  }
  require('../brain/autopilot/plan')(G, S, M, api, () => {})
  const iron = G.steps.find(s => s.id === 'iron')
  return {
    G, iron, M,
    dispose: () => { try { G.dispose && G.dispose() } catch {} ; Date.now = realNow; if (prevReg === undefined) delete process.env.BOT_REGISTRY; else process.env.BOT_REGISTRY = prevReg }
  }
}

test('an iron trip with 20 ingots, no shield and no wood digs its tunnel: the tunnel is not stopped before its first cell', async () => {
  const r = rig({ ingots: 20, shield: false })
  try {
    assert.ok(r.iron.need(), 'the iron step is due (20 ingots is under 32)')
    await r.iron.run()
    assert.equal(r.M.stops.length, 1, 'the trip did not reach its tunnel once (the test setup is wrong, not the bot)')
    assert.equal(r.M.stops[0], false, 'the tunnel was stopped before its first cell: with no shield the next gear is 1 ingot and it is banked, so the trip ' +
      'rode the shaft down, dug nothing and climbed back up')
  } finally { r.dispose() }
})

test('control: with the shield held the tunnel is not stopped for the gear either (20 ingots)', async () => {
  const r = rig({ ingots: 20, shield: true })
  try {
    await r.iron.run()
    assert.equal(r.M.stops.length, 1, 'the trip reached its tunnel once')
    assert.equal(r.M.stops[0], false, 'with the shield on there is no gear stop')
  } finally { r.dispose() }
})

test('control: the tunnel still stops on its own conditions (no free slots left)', async () => {
  const r = rig({ ingots: 20, shield: false, freeSlots: 3 })
  try {
    await r.iron.run()
    assert.equal(r.M.stops.length, 1, 'the trip reached its tunnel once')
    assert.equal(r.M.stops[0], true, 'a full bag still stops the tunnel')
  } finally { r.dispose() }
})
