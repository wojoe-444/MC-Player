// Work order step-light-home: light-home walks stall and time out (7 of 55 runs, 2026-11-11). A pass that the step's 180 s budget cuts short keeps
// no record of it. The torch sites are sorted nearest-first, so the same unreachable site is walked to first on every pass, the budget runs out
// before the reachable sites get a turn, and no rest is set, so the step is due again at once from the same spot (timeouts at 180-190 s, from the
// same start spot (-6018,66,-2338) five minutes apart). The test drives the real light-home step (brain/autopilot/plan.js, the step's run) on a flat
// made-up world: torch sites west of x-10 cannot be walked to (each walk takes a minute and fails), the rest can (five seconds, the bot moves there).
// Time is a fake clock; the budget is enforced the way skills.js S.check enforces it (StepTimeout once S.stepDeadline has passed).
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'), os = require('os'), path = require('path')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')

const key = (x, y, z) => `${x},${y},${z}`
const BUDGET = 180000

// a made-up flat world: stone up to y63, air above, a red bed at home 0,64,0; the bot stands at -20.5,64,2.5 (west of home)
function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-lh-walk-'))
  const clock = { now: 1794000000000 }
  const realNow = Date.now
  Date.now = () => clock.now
  const cells = new Map([[key(0, 64, 0), 'red_bed']])
  const name = (x, y, z) => cells.get(key(x, y, z)) || (y <= 63 ? 'stone' : 'air')
  const block = (x, y, z) => { const n = name(x, y, z); return { name: n, boundingBox: n === 'air' || n === 'torch' ? 'empty' : 'block', position: new Vec3(x, y, z) } }
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(-20.5, 64, 2.5), onGround: true, yaw: 0 }
  bot.time = { day: 3, timeOfDay: 2000 }
  bot.health = 20; bot.food = 20; bot.username = 'fixer-test'
  bot.registry = { blocksArray: [{ name: 'torch', id: 50 }, { name: 'wall_torch', id: 51 }, { name: 'red_bed', id: 52 }], blocksByName: {}, blocksByStateId: {} }
  bot.world = { getBlockStateId: () => null }
  bot.blockAt = (p) => block(p.x, p.y, p.z)
  bot.findBlocks = () => []
  bot.controlState = {}; bot.setControlState = () => {}; bot.clearControlStates = () => {}; bot.lookAt = async () => {}
  let torches = 40
  const walks = []                                       // every go-to the step made: where, and whether it arrived
  const west = (p) => p.x <= -10
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
      if (west(at)) { clock.now += 60000; walks.push({ at, ok: false }); return { ok: false, err: 'nopath' } }
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
    G, base, step, walks, cells, clock, torchesLeft: () => torches,
    dispose: () => { try { G.dispose && G.dispose() } catch {} ; Date.now = realNow; if (prevReg === undefined) delete process.env.BOT_REGISTRY; else process.env.BOT_REGISTRY = prevReg }
  }
}

// one pass the way goals.js runs a step: the budget is set first, then the run; returns the run's error if it was cut short
async function pass(r) {
  r.base.stepDeadline = r.clock.now + BUDGET
  try { await r.step.run(); return null } catch (e) { return e } finally { r.base.stepDeadline = 0 }
}

test('a pass cut short by its budget is not started again from the same spot: the reachable torch sites get their turn', async () => {
  const r = rig()
  try {
    assert.ok(r.step, 'the light-home step exists')
    const cut = await pass(r)                              // four west sites at a minute each, then the budget is gone
    assert.ok(cut && cut.name === 'StepTimeout', 'the first pass should be cut short by the budget')
    r.walks.length = 0
    await pass(r)
    assert.ok(r.walks.length >= 1, 'the second pass made no walk at all')
    const first = r.walks[0].at
    assert.ok(first.x > -10, `the second pass walked first to the unreachable site ${first.x},${first.y},${first.z}, the same as the first pass`)
    assert.ok(r.cells.size > 1, 'no torch went up on the reachable sites')
  } finally { r.dispose() }
})

test('a pass cut short by its budget sets a rest: the step is not due again at once from the same spot', async () => {
  const r = rig()
  try {
    const cut = await pass(r)
    assert.ok(cut && cut.name === 'StepTimeout', 'the pass should be cut short by the budget')
    assert.equal(r.step.need(), false, 'the step is due again at once (its cool-down is one minute): no rest was recorded for the cut-short pass')
  } finally { r.dispose() }
})
