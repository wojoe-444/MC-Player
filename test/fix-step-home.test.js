// Work order step-home: 17 runs of step home in 97 min, 0 ok and 0 fail. The idle walk home (brain/autopilot/goals.js, G.step, the branch
// "nothing to do: back home") never reported how it ended: no stepEnd call, so the journal could not tell a walk that arrived from one
// that failed, and the title's "never completes" is that gap. The branch now reports its outcome through G.onStepEnd, as the routine
// steps do (an observer only: the walk itself is unchanged). Before the fix no result was recorded for any walk home.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'), os = require('os'), path = require('path')
const { EventEmitter } = require('events')

// a bot 'dist' blocks from home, with a walk that returns `walk`; no routine steps, so the picker finds nothing and the idle branch runs
function rig({ dist = 10, walk = { ok: true }, shelterDoor = null, shelter = null, night = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-home-'))
  const bot = new EventEmitter()
  bot.time = { day: 57, timeOfDay: 6000 }; bot.health = 20; bot.food = 20; bot.entity = { position: { x: 0, y: 64, z: 0 } }
  const walks = []
  const base = {
    bot, goals: { GoalNear: function (x, y, z, r) { Object.assign(this, { x, y, z, r }) } }, v: (x, y, z) => ({ x, y, z }),
    isNight: () => night, dist: () => dist, check() {}, wait: async () => {}, count: () => 0,
    goto: async (goal, o) => { walks.push({ x: goal.x, y: goal.y, z: goal.z, o }); return { ...walk } },
  }
  const S = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => 0) })
  const api = { statePath: (f) => path.join(dir, f), profile: { get: () => ({ role: 'hillclimber', steps: null }) } }
  const G = require('../brain/autopilot/goals')(S, {}, api, () => {})
  G.state.home = [0, 64, 0]
  if (shelterDoor) G.state.shelterDoor = shelterDoor
  if (shelter) G.enterShelter = shelter
  G.steps.length = 0
  const ended = []
  G.onStepEnd = (r) => ended.push([r.step, r.out])
  return { G, walks, ended }
}

test('the idle walk home reports ok when it arrives', async () => {
  const r = rig({ dist: 10, walk: { ok: true } })
  await r.G.step()
  assert.equal(r.walks.length, 1, 'the bot did not walk home from 10 blocks out')
  assert.deepStrictEqual(r.ended, [['home', 'ok']], 'the walk home never reported how it ended (the journal shows 0 ok for step home)')
})

test('the idle walk home reports fail when the walk fails', async () => {
  const r = rig({ dist: 10, walk: { ok: false, err: 'nopath' } })
  await r.G.step()
  assert.equal(r.walks.length, 1, 'the bot did not walk home from 10 blocks out')
  assert.deepStrictEqual(r.ended, [['home', 'fail']], 'a failed walk home was not reported as a failure (the journal shows 0 fail for step home)')
})

test('the walk home through the shelter door reports its result too', async () => {
  const r = rig({ dist: 10, shelterDoor: [3, 64, 3], shelter: async () => ({ ok: false, err: 'nopath' }) })
  await r.G.step()
  assert.deepStrictEqual(r.ended, [['home', 'fail']], 'the shelter walk home was not reported')
})

test('at night the walk home reports ok when it arrives', async () => {
  const r = rig({ dist: 10, night: true, walk: { ok: true } })
  await r.G.step()
  assert.equal(r.walks.length, 1, 'the bot did not walk home at night from 10 blocks out')
  assert.deepStrictEqual(r.ended, [['home', 'ok']], 'the night walk home never reported how it ended')
})

test('already at home: nothing is walked and no walk result is reported', async () => {
  const r = rig({ dist: 3 })
  await r.G.step()
  assert.equal(r.walks.length, 0, 'the bot walked although it was at home')
  assert.deepStrictEqual(r.ended, [], 'a result was reported for a walk that did not happen')
})
