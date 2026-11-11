// brain/autopilot/goals.js, the idle branch ("nothing to do"): it runs light-home's routine directly. It must respect light-home's own need()
// (torch floor, rest after a pass). Before the fix it ran every minute with 8-13 torches: the routine places nothing below 14 torches, so the pass
// was computation with no movement or placement, which the watchdog reads as a stall. It also cleared the rest timer, so the pass repeated each minute.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'), os = require('os'), path = require('path')
const { EventEmitter } = require('events')

function rig({ torches, lightAt = 0, cooled = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-idle-'))
  const bot = new EventEmitter()
  bot.time = { day: 57, timeOfDay: 6000 }; bot.health = 20; bot.food = 20; bot.entity = { position: { x: 0, y: 64, z: 0 } }
  const base = { bot, goals: { GoalNear: function () {} }, v: (x, y, z) => ({ x, y, z }), isNight: () => false, dist: () => 0, check() {}, wait: async () => {},
    count: (w) => (w === 'torch' ? torches : 0) }
  const S = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => 0) })
  const api = { statePath: (f) => path.join(dir, f), profile: { get: () => ({ role: 'hillclimber', steps: null }) } }
  const G = require('../brain/autopilot/goals')(S, {}, api, () => {})
  G.state.home = [0, 64, 0]; G.state.lightAt = lightAt
  const ran = []
  // a stand-in for light-home with the same need() as plan.js: 16 torches, near home, and the rest after a pass
  const lh = { id: 'light-home', need: () => torches >= 16 && Date.now() > (G.state.lightAt || 0), run: async () => { ran.push(Date.now()); return true } }
  G.steps.length = 0; G.steps.push(lh)
  if (cooled) G.cool['light-home'] = Date.now() + 60000
  return { G, ran }
}

test('idle lighting does not run light-home while its own need() says no: 10 torches (the routine places nothing below 14)', async () => {
  const r = rig({ torches: 10 })
  await r.G.step()
  assert.deepStrictEqual(r.ran, [], 'nothing to do: the light-home routine ran with 10 torches')
})

test('idle lighting keeps the rest light-home asked for after a pass: 20 torches, rest not over', async () => {
  const later = Date.now() + 300000
  const r = rig({ torches: 20, lightAt: later })
  await r.G.step()
  assert.deepStrictEqual(r.ran, [], 'the light-home routine ran during its rest')
  assert.strictEqual(r.G.state.lightAt, later, 'the rest timer was cleared')
})

test('idle lighting still runs when light-home is ready (20 torches, rest over) even though the picker is cooling it', async () => {
  const r = rig({ torches: 20, cooled: true })
  await r.G.step()
  assert.strictEqual(r.ran.length, 1, 'idle lighting that the step is ready for must still happen')
})
