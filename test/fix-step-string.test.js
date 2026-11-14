// Work order step-string: the string step never completes and thrashes goals with home, stash and grove. Its run (brain/autopilot/plan.js)
// returns false at once when the bot has under 12 health (`if (bot.health < 12) return false`), but its need() does not say so. The picker
// therefore still picks the step with a spider in reach, the step fails in a moment, its cooldown runs, the idle walk home (or another
// goal) takes the turn, and the step comes back: each cycle is a goal switch to the watchdog. The fix moves the health rule into need(), so
// a step the bot cannot run is not picked at all. This test drives the real string step (brain/autopilot/plan.js) through the real picker
// (brain/autopilot/goals.js) on a made-up flat world: home at 0,64,0, one spider 5 blocks away, the health as the knob.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'), os = require('os'), path = require('path')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')

function rig({ health = 10 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-string-'))
  const clock = { now: 1794000000000 }
  const realNow = Date.now
  Date.now = () => clock.now
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(0.5, 64, 0.5), onGround: true, yaw: 0 }
  bot.time = { day: 3, timeOfDay: 6000 }
  bot.health = health; bot.food = 20; bot.username = 'fixer-test'
  bot.registry = { blocksArray: [{ name: 'red_bed', id: 52 }], blocksByName: {}, blocksByStateId: {} }
  bot.world = { getBlockStateId: () => null }
  bot.blockAt = () => null
  bot.findBlocks = () => []
  bot.controlState = {}; bot.setControlState = () => {}; bot.clearControlStates = () => {}; bot.lookAt = async () => {}
  const spider = { name: 'spider', id: 9, isValid: true, position: new Vec3(5.5, 64, 0.5) }
  bot.entities = { 9: spider }
  const kills = []                                       // every spider the step went for
  const base = {
    bot, goals: {
      GoalNear: class { constructor (x, y, z, r) { Object.assign(this, { x, y, z, r }) } },
      GoalFollow: class { constructor (e, r) { Object.assign(this, { e, r }) } },
    },
    v: (x, y, z) => new Vec3(x, y, z), flo: (p) => new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    block: (p) => (p && p.x === 0 && p.y === 64 && p.z === 0 ? { name: 'red_bed', boundingBox: 'block', position: p } : null),
    dist: (p) => bot.entity.position.distanceTo(p),
    has: () => false, count: () => 0, items: () => [], freeSlots: () => 20,
    hostilesNear: (r = 16) => (bot.entity.position.distanceTo(spider.position) <= r ? [spider] : []),
    isNight: () => false, skyVisible: () => true, toolTier: () => 3,
    check() {}, wait: async () => {}, say() {}, aborted: () => false, isAbort: () => false, stepDeadline: 0,
    kill: async (e) => { kills.push(e) },
    pickup: async () => 0,
  }
  const S = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => 0) })
  const api = { statePath: (f) => path.join(dir, f), profile: { get: () => ({ role: 'hillclimber', steps: null }) } }
  const prevReg = process.env.BOT_REGISTRY
  process.env.BOT_REGISTRY = path.join(dir, 'registry.json')     // no shared registry here
  const G = require('../brain/autopilot/goals')(S, {}, api, () => {})
  G.state.home = [0, 64, 0]
  require('../brain/autopilot/plan')(G, S, {}, api, () => {})
  const step = G.steps.find(s => s.id === 'string')
  G.steps.length = 0                                      // the picker sees only the string step (the idle walk home is the fallback)
  if (step) G.steps.push(step)
  return {
    G, step, kills,
    dispose: () => { try { G.dispose && G.dispose() } catch {} ; Date.now = realNow; if (prevReg === undefined) delete process.env.BOT_REGISTRY; else process.env.BOT_REGISTRY = prevReg }
  }
}

test('at 10 health a spider in reach is no reason for the string step to be due (its run refuses at under 12 health)', () => {
  const r = rig({ health: 10 })
  try {
    assert.ok(r.step, 'the string step exists')
    assert.equal(r.step.need(), false, 'string is due at 10 health, but its run returns false at once below 12 health: the picker keeps picking it')
  } finally { r.dispose() }
})

test('at 10 health the picker leaves string alone: no attempt, no failure, no goal switch to it', async () => {
  const r = rig({ health: 10 })
  try {
    for (let i = 0; i < 3; i++) await r.G.step()
    assert.deepEqual(r.kills, [], 'the bot went after a spider at 10 health')
    assert.equal(r.G.fails.string, undefined, 'the string step was picked and failed at 10 health: ' + JSON.stringify(r.G.log.slice(-4)))
    assert.ok(!r.G.log.some(l => / step string$/.test(l)), 'the string step was started at 10 health: ' + JSON.stringify(r.G.log.slice(-4)))
  } finally { r.dispose() }
})

test('at 14 health the same spider is hunted: the health rule does not switch the step off', async () => {
  const r = rig({ health: 14 })
  try {
    assert.equal(r.step.need(), true, 'string is not due at 14 health with a spider 5 blocks away')
    await r.G.step()
    assert.equal(r.kills.length, 1, 'the bot did not go after the spider at 14 health')
  } finally { r.dispose() }
})
