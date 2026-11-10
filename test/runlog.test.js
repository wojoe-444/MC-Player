const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'), os = require('os'), path = require('path')
const EventEmitter = require('events')
const { Vec3 } = require('vec3')
const register = require('../brain/runlog')
const { createLoopTracker, readCommit } = register

function rig({ commit = 'aaaaaaaaa', day = 3 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runlog-'))
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(10.5, 64, 20.5) }; bot.health = 20; bot.heldItem = null; bot.time = { day }
  let clock = 1000000, current = commit
  const logs = []
  const api = { bot, statePath: (rel) => path.join(dir, rel), now: () => clock, log: (a, b) => logs.push(b), readCommit: () => current, readSubject: () => 'subject of ' + current }
  const m = register(api)
  return { m, bot, dir, logs, setCommit: (c) => { current = c }, tick: (ms) => { clock += ms }, lines: (f) => { try { return fs.readFileSync(path.join(dir, 'runlog', f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) } catch { return [] } } }
}

test('loop tracker: A,B,A,B inside 10 minutes counts one ping-pong with its Y range; A,A,A,A and slow runs do not', () => {
  const t = createLoopTracker()
  assert.strictEqual(t.note('ladder-up', 0, 30), null); assert.strictEqual(t.note('craft', 1000, 64), null); assert.strictEqual(t.note('ladder-up', 2000, 31), null)
  const hit = t.note('craft', 3000, 64)
  assert.deepStrictEqual(hit && [hit.a, hit.b], ['ladder-up', 'craft'])
  assert.strictEqual(t.pairs['craft|ladder-up'].count, 1); assert.strictEqual(t.pairs['craft|ladder-up'].ys[0], '30..64')
  const same = createLoopTracker(); for (let i = 0; i < 6; i++) assert.strictEqual(same.note('iron', i * 1000, 30), null)       // the same step repeated is not a ping-pong
  const slow = createLoopTracker(); slow.note('a', 0, 1); slow.note('b', 100000, 1); slow.note('a', 200000, 1)
  assert.strictEqual(slow.note('b', 700000, 1), null, 'more than 10 minutes apart')
  const abc = createLoopTracker(); for (const [i, s] of ['a', 'b', 'c', 'a', 'b', 'c'].entries()) assert.strictEqual(abc.note(s, i * 1000, 1), null)
})

test('commit tag: read live, logged on every change with the subject, and listed per in-game day', () => {
  const r = rig(); r.m.start()
  assert.strictEqual(r.bot._runInfo.commit(), 'aaaaaaaaa')
  assert.deepStrictEqual(r.bot._runInfo.dayCommits(3), ['aaaaaaaaa'])
  r.setCommit('bbbbbbbbb'); r.tick(30000); assert.strictEqual(r.bot._runInfo.commit(), 'aaaaaaaaa', 'cached for 60 s')
  r.tick(40000); assert.strictEqual(r.bot._runInfo.commit(), 'bbbbbbbbb')
  assert.deepStrictEqual(r.bot._runInfo.dayCommits(3), ['aaaaaaaaa', 'bbbbbbbbb'])
  r.bot.time.day = 4; assert.deepStrictEqual(r.bot._runInfo.dayCommits(), ['bbbbbbbbb'])
  const rows = r.lines('commits.jsonl'); assert.deepStrictEqual(rows.map(x => x.commit), ['aaaaaaaaa', 'bbbbbbbbb']); assert.strictEqual(rows[1].subject, 'subject of bbbbbbbbb')
  r.m.stop(); assert.strictEqual(r.bot._runInfo, undefined)
})

test('readCommit finds the real HEAD of this repo, and null outside a checkout', () => {
  const c = readCommit(path.join(__dirname, '..')); assert.match(c, /^[0-9a-f]{7,9}$/)
  assert.strictEqual(readCommit(os.tmpdir()), null)
})

test('step transitions: assigning G.lastStep anywhere is logged with the Y level; the ping-pong summary is written; stop() puts a plain property back', () => {
  const r = rig(); r.bot._ap = { G: { lastStep: 'home' } }
  r.m.start()                                                                    // hooks G and logs the current step
  const G = r.bot._ap.G
  const ys = [64, 40, 64, 40]
  const steps = ['craft', 'ladder-down', 'craft', 'ladder-down']
  steps.forEach((s, i) => { r.tick(2000); r.bot.entity.position.y = ys[i]; G.lastStep = s })
  G.lastStep = 'ladder-down'                                                     // unchanged: not a transition
  const rows = r.lines('steps.jsonl'); assert.deepStrictEqual(rows.map(x => x.step), ['home', 'craft', 'ladder-down', 'craft', 'ladder-down'])
  assert.deepStrictEqual(rows.map(x => x.y), [64, 64, 40, 64, 40]); assert.strictEqual(rows[2].prev, 'craft'); assert.strictEqual(rows[0].x, 10)
  assert.ok(r.logs.some(l => /ping-pong craft <-> ladder-down/.test(l)))
  assert.strictEqual(r.m.status().loops['craft|ladder-down'], 1)
  r.m.stop()                                                                     // flushes step-loops.json
  const saved = JSON.parse(fs.readFileSync(path.join(r.dir, 'runlog', 'step-loops.json'), 'utf8'))
  assert.strictEqual(saved.pairs['craft|ladder-down'].count, 1)
  G.lastStep = 'iron'; assert.strictEqual(G.lastStep, 'iron'); assert.strictEqual(r.lines('steps.jsonl').length, 5, 'unhooked after stop')
})

test('the autopilot appearing after start is hooked by the 5 s poll (G does not exist yet when modules start)', () => {
  const r = rig(); r.m.start(); assert.strictEqual(r.m._tick.loops.pairs && Object.keys(r.m._tick.loops.pairs).length, 0)
  r.bot._ap = { G: { lastStep: null } }; r.m._tick.hook(); r.bot._ap.G.lastStep = 'wood'
  assert.deepStrictEqual(r.lines('steps.jsonl').map(x => x.step), ['wood']); r.m.stop()
})
