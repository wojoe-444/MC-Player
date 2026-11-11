// brain/outcome: a build is judged by what it produces, not only by its blocks. The mob farm of 2026-11-10 passed every inspection and made nothing for a
// day because the world was on Peaceful; these tests fix that case and the neighbours (a tree farm that yields nothing, a farm that works, the bot in the way).
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'), os = require('os'), path = require('path')
const E = require('../brain/outcome/expect')
const register = require('../brain/outcome')
const orders = require('../reviewer/lib/orders')
const { mockBot } = require('./mock-bot')

const H = 3600000
const farm = (o) => ({ id: 'mobfarm-x', kind: 'mobfarm', liveMs: 0, got: 0, ...o })

test('a mob farm on a Peaceful world is blocked at once, whatever its blocks look like, and only a person can fix it', () => {
  const v = E.evaluate(farm({ liveMs: 0.2 * H }), { difficulty: 'peaceful' })
  assert.strictEqual(v.state, 'blocked'); assert.strictEqual(v.who, 'human'); assert.match(v.why[0], /Peaceful/)
})
test('grace first, then overdue when nothing came out, producing when something did', () => {
  assert.strictEqual(E.evaluate(farm({ liveMs: 1 * H }), { difficulty: 'easy' }).state, 'warming')
  const o = E.evaluate(farm({ liveMs: 5 * H }), { difficulty: 'easy' }); assert.strictEqual(o.state, 'overdue'); assert.match(o.why[0], /no kills/)
  assert.strictEqual(E.evaluate(farm({ liveMs: 5 * H, got: 6 }), { difficulty: 'easy' }).state, 'producing')
  assert.strictEqual(E.evaluate(farm({ liveMs: 20 * H, got: 1 }), { difficulty: 'hard' }).state, 'overdue', 'one kill in 20 hours is a quarter of the bar or less')
})
test('an unknown difficulty does not block; the bar is per build kind (tree farm, pens)', () => {
  assert.strictEqual(E.evaluate(farm({ liveMs: 5 * H, got: 3 }), { difficulty: null }).state, 'producing')
  assert.strictEqual(E.evaluate({ id: 't', kind: 'treefarm', liveMs: 10 * H, got: 0 }, {}).state, 'overdue')
  assert.strictEqual(E.evaluate({ id: 'p', kind: 'pen', liveMs: 30 * H, got: 4 }, {}).state, 'producing')
  assert.strictEqual(E.evaluate({ id: 'z', kind: 'nope' }, {}).state, 'unknown')
})
test('the bot standing where it blocks the platform is said, as a note, not a fault', () => {
  const v = E.evaluate(farm({ liveMs: 5 * H, got: 9, shadedFrac: 0.7 }), { difficulty: 'easy' })
  assert.strictEqual(v.state, 'producing'); assert.ok(v.notes && /70%/.test(v.notes[0]))
})

// ---- the module, with a real registry file and a mock bot
function rig(difficulty) {
  const bot = mockBot(); bot.game = { difficulty }; bot.entity.position = { x: -6018, y: 7, z: -2354 }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outcome-'))
  const registryFile = path.join(dir, 'registry.json')
  fs.writeFileSync(registryFile, JSON.stringify({ worlds: { w: { shafts: [], rooms: [{ id: 'mobfarm-x', type: 'mobfarm', box: { x0: -6039, x1: -6019, y0: 35, y1: 60, z0: -2364, z1: -2346 } }] } } }))
  let clock = 1_700_000_000_000
  const events = []
  bot._journal = { add: (k, f, o) => events.push({ k, ...f, sal: o && o.sal }) }
  bot._ap = { G: { state: { mobFarm: { kills: 0 } } } }
  const h = register({ bot, now: () => clock, log() {}, statePath: (f) => path.join(dir, f), registryFile })
  return { bot, h, dir, events, advance: (ms) => { clock += ms }, lessons: () => { try { return fs.readFileSync(path.join(dir, 'lessons.md'), 'utf8') } catch { return '' } } }
}
test('module: Peaceful -> one lesson line, one salient journal event, outcome.json; said again after 6 h, not every tick', () => {
  const r = rig('peaceful')
  r.h.start(); r.h._tick()
  assert.strictEqual(r.events.length, 1); assert.strictEqual(r.events[0].state, 'blocked'); assert.strictEqual(r.events[0].who, 'human'); assert.ok(r.events[0].sal)
  assert.match(r.lessons(), /\[outcome\] mobfarm-x: blocked/)
  r.advance(5 * 60000); r.h._tick(); r.advance(5 * 60000); r.h._tick()
  assert.strictEqual(r.events.length, 1, 'no repeat inside 6 h')
  r.advance(6 * H); r.h._tick()
  assert.strictEqual(r.events.length, 2, 'said again so the order does not look quiet'); assert.strictEqual(r.lessons().match(/\[outcome\]/g).length, 1, 'the lesson is written once')
  const out = JSON.parse(fs.readFileSync(path.join(r.dir, 'outcome.json'), 'utf8')); assert.strictEqual(out.builds['mobfarm-x'].state, 'blocked'); assert.strictEqual(out.env.difficulty, 'peaceful')
  r.h.stop()
})
test('module: on Easy the farm warms, then goes overdue after the grace period with no kills, then producing once it kills', () => {
  const r = rig('easy'); r.h.start()
  for (let i = 0; i < 12; i++) { r.advance(5 * 60000); r.h._tick() }                     // 1 h in range
  assert.strictEqual(r.h.status()['mobfarm-x'], 'warming'); assert.strictEqual(r.events.length, 0)
  for (let i = 0; i < 36; i++) { r.advance(5 * 60000); r.h._tick() }                     // 4 h in range
  assert.strictEqual(r.h.status()['mobfarm-x'], 'overdue'); assert.strictEqual(r.events.at(-1).state, 'overdue')
  r.bot._ap.G.state.mobFarm.kills = 12; r.advance(5 * 60000); r.h._tick()
  assert.strictEqual(r.h.status()['mobfarm-x'], 'producing')
  r.h.stop()
})
test('module: time only counts while the bot is inside the 128 block range', () => {
  const r = rig('easy'); r.h.start(); r.bot.entity.position = { x: -5800, y: 64, z: -2354 }
  for (let i = 0; i < 48; i++) { r.advance(5 * 60000); r.h._tick() }
  assert.strictEqual(r.h.status()['mobfarm-x'], 'warming', '4 hours away from the farm is not 4 hours of chances')
  r.h.stop()
})

// ---- the loop: the journal event becomes a work order candidate that needs no model
test('orders: an outcome event is a candidate with its own problem statement; a blocked one is kind human; a producing one is none', () => {
  const ev = [
    { at: '2026-11-11T03:00:00Z', k: 'outcome', build: 'mobfarm-x', kindOf: 'mobfarm', state: 'blocked', who: 'human', liveH: 6, got: 0, unit: 'kills', why: 'the world is on Peaceful', purpose: 'bones' },
    { at: '2026-11-11T03:00:00Z', k: 'outcome', build: 'treefarm-1', kindOf: 'treefarm', state: 'overdue', liveH: 9, got: 0, unit: 'logs', why: 'no logs', purpose: 'logs' },
    { at: '2026-11-11T02:00:00Z', k: 'outcome', build: 'pens', kindOf: 'pen', state: 'overdue', liveH: 30, got: 0, unit: 'animals', why: 'x', purpose: 'y' },
    { at: '2026-11-11T03:05:00Z', k: 'outcome', build: 'pens', kindOf: 'pen', state: 'producing', liveH: 31, got: 3, unit: 'animals', why: 'ok', purpose: 'y' },
  ]
  const c = orders.candidates({ rollup: { steps: {}, deaths: [], flags: {} }, events: ev })
  assert.deepStrictEqual(c.map(x => x.key).sort(), ['outcome-mobfarm-x', 'outcome-treefarm-1'])
  const m = c.find(x => x.key === 'outcome-mobfarm-x'); assert.strictEqual(m.auto.kind, 'human'); assert.strictEqual(m.costMin, 30); assert.match(m.auto.problem, /Peaceful/)
  assert.strictEqual(c.find(x => x.key === 'outcome-treefarm-1').auto.kind, 'outcome')
})
