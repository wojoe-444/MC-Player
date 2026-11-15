// Work order flag-custom-horizontal-shuttle: the bot walks back and forth over the same 30-50 blocks with no digs or places. The light-home step
// (brain/autopilot/plan.js) sorts its torch sites once, by distance from the spot the pass starts at, and then walks that fixed order. Torch sites lie on
// both sides of home, so the order alternates sides and every leg crosses home (the 2026-11-10 finding: Smeo's walks ran 50 blocks east and 37 west).
// The test drives the real light-home step on a flat made-up world where every walk arrives. The first walk goes to the site nearest the start; the
// second must go to the site nearest where the bot now stands (10 blocks), not the one nearest the start on the far side of home (14 blocks).
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'), os = require('os'), path = require('path')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')

const key = (x, y, z) => `${x},${y},${z}`
const BUDGET = 180000

// a made-up flat world: stone up to y63, air above, a red bed at home 0,64,0; the bot starts at 0.5,64,0.5 (on home). Every walk arrives.
function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-shuttle-'))
  const clock = { now: 1794000000000 }
  const realNow = Date.now
  Date.now = () => clock.now
  const cells = new Map([[key(0, 64, 0), 'red_bed']])
  const name = (x, y, z) => cells.get(key(x, y, z)) || (y <= 63 ? 'stone' : 'air')
  const block = (x, y, z) => { const n = name(x, y, z); return { name: n, boundingBox: n === 'air' || n === 'torch' ? 'empty' : 'block', position: new Vec3(x, y, z) } }
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(0.5, 64, 0.5), onGround: true, yaw: 0 }
  bot.time = { day: 3, timeOfDay: 2000 }
  bot.health = 20; bot.food = 20; bot.username = 'fixer-test'
  bot.registry = { blocksArray: [{ name: 'torch', id: 50 }, { name: 'wall_torch', id: 51 }, { name: 'red_bed', id: 52 }], blocksByName: {}, blocksByStateId: {} }
  bot.world = { getBlockStateId: () => null }
  bot.blockAt = (p) => block(p.x, p.y, p.z)
  bot.findBlocks = () => []
  bot.controlState = {}; bot.setControlState = () => {}; bot.clearControlStates = () => {}; bot.lookAt = async () => {}
  let torches = 40
  const walks = []                                       // every go-to the step made, in order: where it was sent
  const base = {
    bot, goals: { GoalNear: class { constructor (x, y, z, r) { Object.assign(this, { x, y, z, r }) } }, GoalBlock: class { constructor (x, y, z) { Object.assign(this, { x, y, z }) } } },
    v: (x, y, z) => new Vec3(x, y, z), flo: (p) => new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    block: (p) => block(p.x, p.y, p.z), isAir: (b) => !!b && b.name === 'air', isLiquid: () => false, isWaterish: () => false,
    passable: (b) => !!b && b.boundingBox === 'empty', solid: (b) => !!b && b.boundingBox === 'block',
    dist: (p) => bot.entity.position.distanceTo(p), count: (w) => (w === 'torch' || (w instanceof RegExp && w.test('torch')) ? torches : 0),
    items: () => [], toolTier: () => 3, freeSlots: () => 20, isNight: () => false, skyVisible: () => true,
    check() {}, wait: async () => {}, say() {}, aborted: () => false, isAbort: () => false, stepDeadline: 0,
    placeAgainst: async (ref, face, item) => { if (item !== 'torch' || torches < 1) return false; cells.set(key(ref.position.x, ref.position.y + 1, ref.position.z), 'torch'); torches--; return true },
    goto: async (goal) => {
      if (base.stepDeadline && Date.now() > base.stepDeadline) { base.stepDeadline = 0; const e = new Error('step time budget used up'); e.name = 'StepTimeout'; throw e }
      const at = new Vec3(goal.x, goal.y, goal.z)
      clock.now += 5000; bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); walks.push({ at, ok: true }); return { ok: true }
    },
  }
  const S = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => 0) })
  const api = { statePath: (f) => path.join(dir, f), profile: { get: () => ({ role: 'hillclimber', steps: null }) } }
  const prevReg = process.env.BOT_REGISTRY
  process.env.BOT_REGISTRY = path.join(dir, 'registry.json')     // no shared registry here
  const G = require('../brain/autopilot/goals')(S, {}, api, () => {})
  G.state.home = [0, 64, 0]
  require('../brain/autopilot/plan')(G, S, {}, api, () => {})
  const step = G.steps.find(s => s.id === 'light-home')
  return {
    G, base, step, walks, clock,
    dispose: () => { try { G.dispose && G.dispose() } catch {} ; Date.now = realNow; if (prevReg === undefined) delete process.env.BOT_REGISTRY; else process.env.BOT_REGISTRY = prevReg }
  }
}

test('light-home walks on to the torch site nearest where it stands, not the one nearest its start across home', async () => {
  const r = rig()
  try {
    assert.ok(r.step, 'the light-home step exists')
    r.base.stepDeadline = r.clock.now + BUDGET           // one pass, the way goals.js runs a step: the budget is set first
    try { await r.step.run() } finally { r.base.stepDeadline = 0 }
    assert.ok(r.walks.length >= 3, `the pass made ${r.walks.length} walk(s), expected at least 3`)
    const a = r.walks[0].at, b = r.walks[1].at
    const leg = Math.hypot(b.x - a.x, b.z - a.z)
    assert.ok(leg <= 10.5, `after the first torch site ${a.x},${a.z} the next walk went to ${b.x},${b.z}, ${leg.toFixed(1)} blocks away across home, ` +
      'while sites 10 blocks from where the bot stood were still to do (the site list was sorted once, from the start spot)')
  } finally { r.dispose() }
})
