// Farmland turned back to dirt next to a bot (Walter 2026-11-11): the telemetry module notices the blockUpdate, asks the ledger whether the bot's own digging, hoeing
// or building explains it, and files a `trample` event (journal, salient) plus the farmland_trampled flag. Real telemetry and ledger modules on a fake bot.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'trample-'))
process.env.BOT_LEDGER_DIR = path.join(DIR, 'ledger')
process.env.BOT_REGISTRY = path.join(DIR, 'registry.json')
const D = require('../brain/telemetry/detectors')
const telemetry = require('../brain/telemetry')
const ledger = require('../brain/ledger')
const rollup = require('../brain/journal/rollup')
const orders = require('../reviewer/lib/orders')
const { mockBot } = require('./mock-bot')

const T0 = 1_700_000_000_000
let n = 0
function rig() {
  const bot = mockBot({ pos: [10.5, 64.9375, 10.5] })
  bot.entity.velocity = new Vec3(0, 0, 0)
  bot.inventory.items = () => []
  bot.spawnPoint = { x: 0, z: 0 }
  bot.sent = []; bot._client = { write(name, params) { bot.sent.push([name, params]) } }
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
  const toDirt = (x, y, z) => { const old = bot.blockAt(new Vec3(x, y, z)); world.set(`${x},${y},${z}`, 'dirt'); bot.emit('blockUpdate', { ...old, name: 'farmland' }, bot.blockAt(new Vec3(x, y, z))) }
  const adv = (ms) => { clock += ms }
  // 250 ms samples for `ms`, with a path for y: f(i) -> { y, g }
  const run = (steps, f) => { for (let i = 0; i < steps; i++) { const s = f(i); bot.entity.position.y = s.y; bot.entity.onGround = !!s.g; if (s.jump) bot.emit('physicsTick'); adv(250); h._tick.sample() } }
  const hop = () => { bot.entity.onGround = true; bot.emit('physicsTick'); bot.entity.onGround = false; bot.entity.velocity = new Vec3(0, 0.42, 0); bot.emit('physicsTick') }
  return { bot, h, led, journal, farm, toDirt, adv, run, hop, dir, stop: () => { h.stop(); led.stop() }, flags: () => { h._tick.analyze(); return JSON.parse(fs.readFileSync(path.join(dir, 'telemetry/summary.json'), 'utf8')).flags } }
}

test('a hop that lands on a farmland plot: the block turns to dirt under the bot, a trample event and a med flag appear, the journal gets a salient line', () => {
  const r = rig()
  for (let x = 9; x <= 11; x++) for (let z = 9; z <= 11; z++) r.farm(x, 64, z)
  r.run(2, () => ({ y: 64.9375, g: 1 }))
  r.hop(); r.run(3, (i) => ({ y: [65.6, 66.2, 65.4][i], g: 0 })); r.run(1, () => ({ y: 64.9375, g: 1 }))
  r.toDirt(10, 64, 10)
  const ev = r.h._tick.events().filter(e => e.k === 'trample')
  assert.strictEqual(ev.length, 1)
  assert.deepStrictEqual([ev[0].by, ev[0].how, ev[0].x, ev[0].y, ev[0].z], ['bot', 'jump', 10, 64, 10])
  assert.ok(ev[0].fall >= 1, 'fall ' + ev[0].fall)
  const j = r.journal.filter(e => e.k === 'trample')
  assert.strictEqual(j.length, 1); assert.strictEqual(j[0].sal, true); assert.deepStrictEqual(j[0].pos, [10, 64, 10]); assert.strictEqual(j[0].by, 'bot')
  const f = r.flags().find(x => x.kind === 'farmland_trampled')
  assert.ok(f && f.sev === 'med', JSON.stringify(f)); assert.match(f.msg, /1 farmland block\(s\) turned back to dirt/); assert.match(f.msg, /jump x1/)
  r.stop()
})

test('three in ten minutes is high; the same cell twice in 10 s counts once', () => {
  const r = rig()
  for (let x = 9; x <= 12; x++) r.farm(x, 64, 10)
  r.run(2, () => ({ y: 64.9375, g: 1 }))
  r.hop(); r.run(2, (i) => ({ y: [66.1, 65.4][i], g: 0 })); r.run(1, () => ({ y: 64.9375, g: 1 }))
  r.toDirt(10, 64, 10); r.toDirt(10, 64, 10)
  assert.strictEqual(r.h._tick.events().filter(e => e.k === 'trample').length, 1)
  r.toDirt(11, 64, 10); r.toDirt(9, 64, 10)
  assert.strictEqual(r.flags().find(x => x.kind === 'farmland_trampled').sev, 'high')
  r.stop()
})

test('a drop from a ledge (no jump) is a "drop", and a block that turned to dirt while the bot stood still is not blamed on it', () => {
  const r = rig()
  r.farm(10, 64, 10); r.farm(10, 64, 12)
  r.bot.entity.position.y = 66.9375
  r.run(2, () => ({ y: 66.9375, g: 1 })); r.run(2, (i) => ({ y: [66.2, 65.3][i], g: 0 })); r.run(1, () => ({ y: 64.9375, g: 1 }))
  r.toDirt(10, 64, 10)
  const drop = r.h._tick.events().filter(e => e.k === 'trample')[0]
  assert.deepStrictEqual([drop.by, drop.how], ['bot', 'drop'])
  // later, standing on the ground for more than the look-back: a dried-out block beside it is not the bot's doing
  r.run(12, () => ({ y: 64.9375, g: 1 }))
  r.toDirt(10, 64, 12)
  const calm = r.h._tick.events().filter(e => e.k === 'trample')[1]
  assert.deepStrictEqual([calm.by, calm.how], ['unknown', 'none'])
  const j = r.journal.filter(e => e.k === 'trample'); assert.deepStrictEqual(j.map(e => e.sal), [true, false])
  r.stop()
})

test('the bot\'s own work is not a trample: a block placed on the farmland (it turns to dirt), the hoe, a dig; a solid block on top; a block 9 away', () => {
  const r = rig()
  r.farm(10, 64, 10); r.farm(11, 64, 10); r.farm(9, 64, 10); r.farm(30, 64, 10)
  r.hop(); r.run(2, (i) => ({ y: [66, 65.3][i], g: 0 })); r.run(1, () => ({ y: 64.9375, g: 1 }))          // airborne a moment ago, so a trample would be blamed on it
  // the bot places cobblestone on top of (10,64,10): the packet names the farmland, the server turns it to dirt
  r.bot._client.write('block_place', { location: new Vec3(10, 64, 10), direction: 1, hand: 0 })
  r.toDirt(10, 64, 10)
  // a block placed at (11,65,10) by us, recorded in the ledger, with the dirt update arriving after it
  r.bot._client.write('block_place', { location: new Vec3(11, 64, 9), direction: 3, hand: 0 })
  r.bot.emit('blockPlaced', { name: 'air' }, { name: 'cobblestone', position: new Vec3(11, 65, 10) })
  r.toDirt(11, 64, 10)
  // something solid already sits on it (a block from someone else): it dried out under it
  r.bot.blockAt(new Vec3(9, 65, 10)); r.farm(9, 65, 10); r.toDirt(9, 64, 10)
  // too far to be the bot
  r.toDirt(30, 64, 10)
  assert.deepStrictEqual(r.h._tick.events().filter(e => e.k === 'trample'), [])
  assert.deepStrictEqual(r.journal.filter(e => e.k === 'trample'), [])
  assert.ok(!r.flags().some(x => x.kind === 'farmland_trampled'))
  assert.ok(r.h._tick.trampleStats().ours >= 2)
  r.stop()
})

test('detector and day numbers: unexplained ones are not flagged, bot ones are counted by how, space and step; a work order opens by itself at two', () => {
  const ev = (o) => ({ k: 'trample', t: T0, x: 1, y: 64, z: 1, by: 'bot', how: 'jump', space: 'crops', step: 'harvest', ...o })
  assert.strictEqual(D.analyze([], [ev({ by: 'unknown', how: 'none' })], T0 + 1000).filter(f => f.kind === 'farmland_trampled').length, 0)
  const f = D.analyze([], [ev({}), ev({ how: 'drop', t: T0 + 1 })], T0 + 1000).find(x => x.kind === 'farmland_trampled')
  assert.ok(f && f.sev === 'med'); assert.match(f.msg, /in crops while harvest/)
  assert.strictEqual(D.analyze([], [ev({}), ev({ t: T0 + 1 }), ev({ t: T0 + 2 })], T0 + 1000).find(x => x.kind === 'farmland_trampled').sev, 'high')
  assert.strictEqual(D.analyze([], [ev({})], T0 + 11 * 60000).filter(x => x.kind === 'farmland_trampled').length, 0, 'outside the window')

  const at = (m) => new Date(T0 + m * 60000).toISOString()
  const jev = (m, o) => ({ at: at(m), k: 'trample', pos: [1, 64, 1], by: 'bot', how: 'jump', space: 'crops', step: 'harvest', sal: 1, ...o })
  const events = [jev(1, {}), jev(2, { how: 'drop' }), jev(3, { by: 'unknown', how: 'none', sal: 0 })]
  const day = rollup.rollup(events)
  assert.strictEqual(day.trampled.n, 2)
  assert.deepStrictEqual(day.trampled.byHow, { jump: 1, drop: 1 }); assert.deepStrictEqual(day.trampled.bySpace, { crops: 2 }); assert.deepStrictEqual(day.trampled.byStep, { harvest: 2 })
  assert.strictEqual(day.salient.length, 2); assert.match(day.salient[0].what, /farmland at 1,64,1 turned to dirt after the bot's jump in crops during harvest/)
  const c = orders.candidates({ rollup: day, events }).find(x => x.key === 'trample-farmland')
  assert.ok(c && c.auto && c.auto.isBug && c.costMin > 0); assert.match(c.line, /2 farmland blocks/); assert.strictEqual(c.evidence.length, 2)
  assert.ok(!orders.candidates({ rollup: rollup.rollup([jev(1, {})]), events: [jev(1, {})] }).some(x => x.key === 'trample-farmland'), 'one alone waits')
})
