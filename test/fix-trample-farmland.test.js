// Work order trample-farmland: the trample event says "after a jump" for any jump in the 1.5 s before, so the digest cannot tell a landing from a plot that
// dried out on its own (vanilla FarmBlock.randomTick turns farmland back to dirt when no water is within 4 blocks and no crop is on it). The event must record the
// facts that tell the two apart: the moisture the block had, whether water is near, what sat on it, and where the bot last stood on the ground before it went
// airborne (cell, yaw, pitch). Real telemetry and ledger modules on a fake bot, same pattern as test/telemetry.farmland.test.js.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'trample-facts-'))
process.env.BOT_LEDGER_DIR = path.join(DIR, 'ledger')
process.env.BOT_REGISTRY = path.join(DIR, 'registry.json')
const telemetry = require('../brain/telemetry')
const ledger = require('../brain/ledger')
const { mockBot } = require('./mock-bot')

const T0 = 1_700_000_000_000
let n = 0
function rig() {
  const bot = mockBot({ pos: [10.5, 64.9375, 10.5] })
  bot.entity.velocity = new Vec3(0, 0, 0)
  bot.entity.yaw = 0.8; bot.entity.pitch = -0.3
  bot.inventory.items = () => []
  bot.spawnPoint = { x: 0, z: 0 }
  bot.sent = []; bot._client = { write() {} }
  const world = new Map()
  bot.blockAt = (p) => { const nm = world.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) || 'air'; return { name: nm, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: nm === 'air' || nm === 'wheat' ? 'empty' : 'block' } }
  const dir = path.join(DIR, 'bot' + (n++)); fs.mkdirSync(dir, { recursive: true })
  let clock = T0
  const events = new EventEmitter()
  const journal = []
  bot._journal = { v: 1, add: (k, f, o) => journal.push({ k, ...f, sal: !!(o && o.sal) }) }
  const api = { bot, events, now: () => clock, log() {}, dir, statePath: (f) => path.join(dir, f), scheduler: { running: { name: 'autopilot' } } }
  const led = ledger(api); led.start()
  const h = telemetry(api); h.start()
  const farm = (x, y, z) => world.set(`${x},${y},${z}`, 'farmland')
  // the server turns a farmland block to dirt; the old block still reports its moisture, as the real one does
  const toDirt = (x, y, z, moist = 0) => { const old = bot.blockAt(new Vec3(x, y, z)); world.set(`${x},${y},${z}`, 'dirt'); bot.emit('blockUpdate', { ...old, name: 'farmland', getProperties: () => ({ moisture: String(moist) }) }, bot.blockAt(new Vec3(x, y, z))) }
  const adv = (ms) => { clock += ms }
  // 250 ms samples for `steps`, with a path for y: f(i) -> { y, g }
  const run = (steps, f) => { for (let i = 0; i < steps; i++) { const s = f(i); bot.entity.position.y = s.y; bot.entity.onGround = !!s.g; if (s.jump) bot.emit('physicsTick'); adv(250); h._tick.sample() } }
  const hop = () => { bot.entity.onGround = true; bot.emit('physicsTick'); bot.entity.onGround = false; bot.entity.velocity = new Vec3(0, 0.42, 0); bot.emit('physicsTick') }
  return { bot, h, led, journal, world, farm, toDirt, adv, run, hop, stop: () => { h.stop(); led.stop() } }
}

// a hop off a plot cell at (10, 64, 10) to the ground, in a bare plot with no water near: the event must say so
test('a bare, dry plot that a hop came down on: the trample event records moisture 0, no water near, nothing on it, and where the bot took off', () => {
  const r = rig()
  try {
    for (let x = 9; x <= 11; x++) for (let z = 9; z <= 11; z++) r.farm(x, 64, z)
    r.run(2, () => ({ y: 64.9375, g: 1 }))
    r.hop(); r.run(3, (i) => ({ y: [65.6, 66.2, 65.4][i], g: 0 })); r.run(1, () => ({ y: 64.9375, g: 1 }))
    r.toDirt(10, 64, 10, 0)
    const ev = r.h._tick.events().find(e => e.k === 'trample')
    assert.ok(ev, 'a trample event is recorded')
    assert.strictEqual(ev.how, 'jump')                                              // the label itself is unchanged
    assert.strictEqual(ev.moist, 0, 'the moisture the block had')
    assert.strictEqual(ev.wet, false, 'no water within 4 blocks')
    assert.strictEqual(ev.above, 'air', 'what sat on the block')
    assert.deepStrictEqual(ev.takeoff && [ev.takeoff.x, ev.takeoff.y, ev.takeoff.z, ev.takeoff.yaw, ev.takeoff.pit], [10.5, 64.9375, 10.5, 0.8, -0.3], 'where the bot last stood on the ground before it went airborne')
    const j = r.journal.find(e => e.k === 'trample')
    assert.ok(j, 'the journal line is written')
    assert.deepStrictEqual([j.moist, j.wet, j.above], [0, false, 'air'])
    assert.ok(j.takeoff && j.takeoff.y === 64.9375)
  } finally { r.stop() }
})

// the same hop onto a plot with water three blocks away and a crop on top: the event shows it was wet and planted
test('a plot with water three blocks off and a crop on top is recorded as wet and planted', () => {
  const r = rig()
  try {
    for (let x = 9; x <= 11; x++) for (let z = 9; z <= 11; z++) r.farm(x, 64, z)
    r.world.set('13,64,10', 'water'); r.world.set('10,65,10', 'wheat')
    r.run(2, () => ({ y: 64.9375, g: 1 }))
    r.hop(); r.run(3, (i) => ({ y: [65.6, 66.2, 65.4][i], g: 0 })); r.run(1, () => ({ y: 64.9375, g: 1 }))
    r.toDirt(10, 64, 10, 7)
    const ev = r.h._tick.events().find(e => e.k === 'trample')
    assert.ok(ev, 'a trample event is recorded')
    assert.strictEqual(ev.moist, 7)
    assert.strictEqual(ev.wet, true, 'water three blocks away counts as hydration')
    assert.strictEqual(ev.above, 'wheat')
  } finally { r.stop() }
})
