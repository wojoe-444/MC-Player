// Work order step-stash: stash stalls in autopilot 12 times in a day (8 min idle) and the journal says only 'stash' for each stall. Nothing in the
// step's notes says which walk or room call the run was waiting on, so the next stall cannot be traced to its call. The step now notes any
// walk, room call or chest open that holds it for 15 s or more, with its result. This test drives the real stash step (brain/autopilot/plan.js,
// its run) on a made-up flat world with one chest that cannot be walked to: the walk takes a minute and fails. The note must name that walk and
// its result. A walk that takes two seconds must leave no such note (the journal is not flooded with every chest walk).
// Time is a fake clock.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'), os = require('os'), path = require('path')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')

// a made-up flat world with a bed at home 0,64,0 and one chest at 5,64,0; the bot stands at 0.5,64,0.5 with a few items to store
function rig({ walkMs = 60000, walkOk = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-stash-'))
  const clock = { now: 1794000000000 }
  const realNow = Date.now
  Date.now = () => clock.now
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(0.5, 64, 0.5), onGround: true, yaw: 0 }
  bot.time = { day: 3, timeOfDay: 6000 }
  bot.health = 20; bot.food = 20; bot.username = 'fixer-test'
  bot.registry = { blocksArray: [{ name: 'chest', id: 60 }, { name: 'red_bed', id: 52 }], blocksByName: {}, blocksByStateId: {} }
  bot.world = { getBlockStateId: () => null }
  bot.blockAt = () => null
  bot.findBlocks = () => [new Vec3(5, 64, 0)]              // the chest near home
  bot.controlState = {}; bot.setControlState = () => {}; bot.clearControlStates = () => {}; bot.lookAt = async () => {}
  const walks = []                                       // every go-to the step made: where, and whether it arrived
  const base = {
    bot, goals: {
      GoalNear: class { constructor (x, y, z, r) { Object.assign(this, { x, y, z, r }) } },
      GoalLookAtBlock: class { constructor (pos, world, o) { Object.assign(this, { pos, o }) } },
    },
    v: (x, y, z) => new Vec3(x, y, z), flo: (p) => new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    block: (p) => (p && p.x === 0 && p.y === 64 && p.z === 0 ? { name: 'red_bed', boundingBox: 'block', position: p } : null),
    dist: (p) => bot.entity.position.distanceTo(p),
    items: () => [{ name: 'rotten_flesh', count: 5, type: 1 }], freeSlots: () => 20, isNight: () => false, skyVisible: () => true,
    toolTier: () => 3, check() {}, wait: async () => {}, say() {}, aborted: () => false, isAbort: () => false, stepDeadline: 0,
    goto: async (goal) => {
      const at = new Vec3(goal.x !== undefined ? goal.x : goal.pos.x, goal.y !== undefined ? goal.y : goal.pos.y, goal.z !== undefined ? goal.z : goal.pos.z)
      clock.now += walkMs
      walks.push({ at, ok: walkOk })
      return walkOk ? { ok: true } : { ok: false, err: 'nopath' }
    },
  }
  const S = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => 0) })
  const api = { statePath: (f) => path.join(dir, f), profile: { get: () => ({ role: 'hillclimber', steps: null }) } }
  const prevReg = process.env.BOT_REGISTRY
  process.env.BOT_REGISTRY = path.join(dir, 'registry.json')     // no shared registry here
  const G = require('../brain/autopilot/goals')(S, {}, api, () => {})
  G.state.home = [0, 64, 0]
  require('../brain/autopilot/plan')(G, S, {}, api, () => {})
  const step = G.steps.find(s => s.id === 'stash')
  return {
    G, step, walks,
    dispose: () => { try { G.dispose && G.dispose() } catch {} ; Date.now = realNow; if (prevReg === undefined) delete process.env.BOT_REGISTRY; else process.env.BOT_REGISTRY = prevReg }
  }
}

test('a chest walk that holds the stash run for a minute is named in the journal with its result', async () => {
  const r = rig({ walkMs: 60000, walkOk: false })
  try {
    assert.ok(r.step, 'the stash step exists')
    await r.step.run()
    assert.equal(r.walks.length, 1, 'the stash run should have walked to the one chest once')
    const lines = (r.G.log || []).map(String)
    assert.ok(lines.some(l => /stash: walk to the chest at .*took 60 s \(failed nopath\)/.test(l)),
      'the stash run waited a minute on a chest walk and the journal does not say so: ' + JSON.stringify(lines.slice(-6)))
  } finally { r.dispose() }
})

test('a quick chest walk leaves no timing note: only waits of 15 s or more are recorded', async () => {
  const r = rig({ walkMs: 2000, walkOk: false })
  try {
    await r.step.run()
    assert.equal(r.walks.length, 1, 'the stash run should have walked to the one chest once')
    const lines = (r.G.log || []).map(String)
    assert.ok(!lines.some(l => /took \d+ s/.test(l)), 'a two second walk was noted as a long wait: ' + JSON.stringify(lines.slice(-6)))
  } finally { r.dispose() }
})
