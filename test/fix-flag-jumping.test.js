// Work order flag-jumping: the bot jumps in place with no block placed and no height gained ("jumping on the spot", 20-49 jumps a minute).
// The climb that does it is LD.rideTo (brain/autopilot/ladder.js): it holds jump and forward for its whole budget (40-90 s), and its 5 s
// "climb not rising" check only logs and presses the keys again. Where the rung above the floor is missing, the bot hops on the floor of the
// shaft and nothing ever stops it. These tests drive the real ladder module on a made-up shaft (the bot and the server stubbed, the clock virtual):
//   1. a ride with no rung to climb stops after two 5 s checks with no height gained, instead of holding jump for the whole budget;
//   2. control: a ride up a shaft that has its rungs still reaches its level.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Vec3 } = require('vec3')

// the shared registry goes to a scratch file (the ladder module reads this once, when it is loaded)
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-flag-jumping-'))
process.env.BOT_REGISTRY = path.join(scratch, 'registry.json')

const key = (x, y, z) => `${x},${y},${z}`
const v = (x, y, z) => new Vec3(x, y, z)
const BB = (n) => (/^(air|cave_air|ladder|torch)$/.test(n) ? 'empty' : 'block')
class GoalBlock { constructor (x, y, z) { this.x = x; this.y = y; this.z = z } }
class GoalNear { constructor (x, y, z, r) { this.x = x; this.y = y; this.z = z; this.r = r } }

// a made-up shaft at x 0, z 0: stone floor up to y 60 (the bot stands on it at y 61), a stone wall on the east side of the column (x 1) from y 61 to 70.
// `cells` overrides single cells (ladders are 'ladder'); `ladders` is the count in the bag. No ladder hangs in this world unless it is in `cells`.
function rig({ cells = new Map(), ladders = 0, log = [] }) {
  const name = (x, y, z) => {
    const k = key(x, y, z)
    if (cells.has(k)) return cells.get(k)
    return (y <= 60 || (x === 1 && z === 0 && y >= 61 && y <= 70)) ? 'stone' : 'air'
  }
  const block = (x, y, z) => { const n = name(x, y, z); return { name: n, boundingBox: BB(n), position: v(x, y, z) } }
  const bot = {
    entity: { position: v(0.5, 61, 0.5), yaw: 0, onGround: true },
    username: 'test-bot', spawnPoint: { x: 0, z: 0 }, controlState: {},
    setControlState (k, on) { bot.controlState[k] = !!on },
    clearControlStates () { for (const k of Object.keys(bot.controlState)) bot.controlState[k] = false },
    lookAt: async () => {},
  }
  const S = {
    bot, goals: { GoalBlock, GoalNear }, v,
    block: (p) => block(p.x, p.y, p.z),
    dist: (p) => bot.entity.position.distanceTo(p),
    isLiquid: () => false, isWaterish: () => false,
    check () {}, wait: async () => {}, pickup: async () => true,
    count: (n) => (n === 'ladder' ? ladders : 0),
    items: () => [],
    craft: async () => false,
    placeAgainst: async () => false,            // the server will not hang a ladder here: the rung above the floor is missing
    goto: async () => ({ ok: false }),
  }
  const L = require('../brain/autopilot/ladder')(bot, S, S.goals, v, (tag, msg) => log.push(String(msg)))
  return { L, bot, name }
}

// the clock is virtual: each sleep advances it at once, so a 40 s budget costs no real time. `onSleep(ms)` lets a test move the bot as time passes.
function virtualClock(onSleep = () => {}) {
  const real = { now: Date.now, timeout: global.setTimeout }
  const clock = { t: 1e12 }
  Date.now = () => clock.t
  global.setTimeout = (fn, ms = 0) => { clock.t += ms; onSleep(ms); Promise.resolve().then(fn); return 0 }
  return { clock, restore: () => { Date.now = real.now; global.setTimeout = real.timeout } }
}

test('a ride with no rung to climb stops after two 5 s checks with no height gained (about 10 s), instead of holding jump and forward for its 40 s budget', async () => {
  const log = []
  const r = rig({ log })
  const sh = { id: 'test-shaft', entry: [0, 70, 0], bottom: [0, 64, 0], wall: [1, 0] }
  const vc = virtualClock()
  try {
    const t0 = vc.clock.t
    const ok = await r.L.rideTo(sh, 70)
    const held = vc.clock.t - t0
    assert.equal(ok, false, 'the ride reports that it did not get to its level')
    assert.equal(r.bot.controlState.jump, false, 'jump is let go when the ride ends')
    assert.ok(held < 15000, `the ride held jump and forward for ${held} ms with no height gained (budget 40000 ms). Log: ${log.join(' | ')}`)
  } finally { vc.restore() }
})

test('control: a ride up a shaft that has its rungs climbs to its level and returns true, as before', async () => {
  const cells = new Map()
  for (let y = 61; y <= 70; y++) cells.set(key(0, y, 0), 'ladder')
  const log = []
  const r = rig({ cells, ladders: 10, log })
  // on a ladder, holding jump and forward climbs 0.2 blocks a tick (50 ms)
  const vc = virtualClock((ms) => {
    const bc = r.bot.controlState, p = r.bot.entity.position
    if (bc.jump && bc.forward && r.name(0, Math.floor(p.y + 1e-3), 0) === 'ladder') r.bot.entity.position = v(0.5, p.y + 0.2 * ms / 50, 0.5)
  })
  try {
    const ok = await r.L.rideTo({ id: 'test-shaft', entry: [0, 70, 0], bottom: [0, 61, 0], wall: [1, 0] }, 70)
    assert.equal(ok, true, 'the ride reaches its level: ' + log.join(' | '))
    assert.ok(r.bot.entity.position.y >= 69.9, 'the bot is at the level, at y' + r.bot.entity.position.y)
  } finally { vc.restore() }
})
