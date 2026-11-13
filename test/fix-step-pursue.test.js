// Work order step-pursue: pursue never succeeds (0 ok in 20 runs) and the log gives no failure reason. Three of pursue's own paths end a run
// as 'fail' without saying why: no mob of the kind in sight, a chase that does not kill it, a gather that gets nothing, and a shaft ride
// that does not reach the bottom. The step is driven through its own entry point (the step's run) on a made-up bag and world; the
// mining and mob calls are stubbed, and the notes it writes to the goal log are what the tests read.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Vec3 } = require('vec3')

// `goals` is the goal list in goals.json, `inv` the bag, `entities` what the bot sees; the S stubs record what pursue asked for
function rig({ goals, inv = {}, entities = {}, pos = new Vec3(0.5, 64, 0.5), gathered = 0, kill = null, mine = null, M = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-step-pursue-'))
  fs.writeFileSync(path.join(dir, 'goals.json'), JSON.stringify(goals))
  const notes = []
  const G = { state: { mine }, cool: {}, note: (m) => notes.push(m), save () {}, log: [] }
  const bot = { entity: { position: pos }, entities, version: '1.21.6', inventory: { items: () => [] } }
  const count = (n) => inv[n] || 0
  const S = {
    bot, goals: { GoalNear: class { constructor (x, y, z, r) { Object.assign(this, { x, y, z, r }) } }, GoalFollow: class {} }, v: (x, y, z) => new Vec3(x, y, z),
    dist: (p) => bot.entity.position.distanceTo(p), count, has: (n) => count(n) > 0, toolTier: () => 3, foodPoints: () => 20, freeSlots: () => 20,
    check () {}, wait: async () => {}, craft: async () => false, smelt: async () => 0, pickup: async () => 0,
    kill: kill || (async () => {}), gather: async () => gathered,
  }
  const api = { statePath: (f) => path.join(dir, f) }
  const pursue = require('../brain/autopilot/pursue')(G, S, M, api, () => {}, { daylightOk: () => true })
  return { step: pursue, notes, G }
}

test('a feather run with no chicken in sight says so in the goal log (it used to return false in silence)', async () => {
  const r = rig({ goals: ['feather'], entities: {} })
  assert.equal(await r.step.run(), false, 'no chicken, no feather')
  assert.ok(r.notes.some(n => /chicken/.test(n) && !/missing/.test(n)), `the log names no reason for the failed run: ${JSON.stringify(r.notes)}`)
})

test('a chase that does not kill the chicken says it is still alive, and what it got', async () => {
  const chicken = { id: 7, name: 'chicken', position: new Vec3(3, 64, 0.5), isValid: true }
  const r = rig({ goals: ['feather'], entities: { 7: chicken }, kill: async () => {} })     // the kill returns without a death (no path to it)
  assert.equal(await r.step.run(), false)
  assert.ok(r.notes.some(n => /chicken still alive/.test(n)), `the log does not say the chicken lived: ${JSON.stringify(r.notes)}`)
})

test('a sugar-cane run that gathers nothing says how many it gathered', async () => {
  const r = rig({ goals: [['sugar_cane', 3]], gathered: 0 })
  assert.equal(await r.step.run(), false)
  assert.ok(r.notes.some(n => /gathered 0 of 3 sugar_cane/.test(n)), `the log does not say what the gather got: ${JSON.stringify(r.notes)}`)
})

test('a shaft ride that does not reach the bottom says so before pursue gives up', async () => {
  const sh = { id: 'test-shaft', entry: [0, 65, 0], bottom: [0, 14, 0], wall: [1, 0] }
  const M = {
    LD: { shafts: () => [sh], clearPlug: async () => 0, down: async () => false, dig: async () => null },
  }
  const mine = { ladder: true, shaft: 'test-shaft', entry: [0, 65, 0], bottom: [0, 14, 0], wall: [1, 0], path: [] }
  const r = rig({ goals: ['diamond'], pos: new Vec3(0.5, 30, 0.5), mine, M })
  assert.equal(await r.step.run(), false, 'the ride did not reach the shaft bottom, so the run fails')
  assert.ok(r.notes.some(n => /ride to the shaft bottom y14 not reached/.test(n)), `the log does not say the ride failed: ${JSON.stringify(r.notes)}`)
})
