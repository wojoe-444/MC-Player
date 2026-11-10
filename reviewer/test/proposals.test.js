// Model-written detectors: validate on captured windows, install with a manifest, and the bot hot-loads them in the sandbox.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const proposals = require('../lib/proposals')
const register = require('../../brain/telemetry')
const SB = require('../../brain/telemetry/sandbox')
const { mockBot } = require('../../test/mock-bot')

const T0 = 1_700_000_000_000
const FLICKER = `// held item flips back and forth
function detect(samples, events, now, H) {
  var s = H.since(samples, now - 30000)
  if (!H.covers(s, 30000, 0.8)) return null
  var n = 0
  for (var i = 1; i < s.length; i++) if (s[i].h !== s[i - 1].h) n++
  return n >= 10 ? { sev: 'med', msg: n + ' held-item switches in 30s (last: ' + s[s.length - 1].h + ')', data: { switches: n } } : null
}`
// a 150 s window of samples at 4 Hz
function win(id, kind, at, f) {
  const samples = []
  for (let i = 0; i < 600; i++) samples.push({ t: at + i * 250, x: i * 0.05, y: 64, z: 0, g: 1, vy: 0, yaw: 0, pit: 0, h: 'stone_axe', mv: 1, act: 0, dg: '', tk: 'autopilot', hp: 20, ...f(i) })
  return { id, kind, at: new Date(at).toISOString(), t0: at, t1: at + 149750, flags: [], digest: { counters: { jumps: 0 } }, samples, events: [] }
}
function botWithWindows({ normals = 4 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prop-'))
  const wd = path.join(dir, 'brain/state/telemetry/windows'); fs.mkdirSync(wd, { recursive: true })
  const put = (w) => fs.writeFileSync(path.join(wd, w.id + '.json'), JSON.stringify(w))
  for (let i = 0; i < normals; i++) put(win(`w${1000 + i * 150}-normal`, 'normal', T0 + i * 150000, () => ({})))
  put(win('w2000-flagged', 'flagged', T0 + 9e6, (i) => ({ h: i % 2 ? 'dirt' : 'stone_sword' })))
  return { id: 'ozo', name: 'OzoGo444', dir }
}
const prop = (over) => ({ name: 'hotbar_flicker', title: 'Held item flips', why: 'bot keeps swapping dirt and sword', severity: 'med', source: FLICKER, badWindows: ['w2000-flagged'], ...over })

test('a detector that fires on the bad window and is quiet on normal ones is validated, installed with origin and hash, and logged with its source', () => {
  const bot = botWithWindows()
  const [ev] = proposals.process(bot, [prop()], { now: T0, model: 'claude-haiku-5-5' })
  assert.strictEqual(ev.action, 'enabled'); assert.deepStrictEqual(ev.validated.firedOnBad, ['w2000-flagged']); assert.strictEqual(ev.validated.firedOnNormal.length, 0)
  const dd = path.join(bot.dir, 'brain/state/detectors')
  const m = JSON.parse(fs.readFileSync(path.join(dd, 'manifest.json'), 'utf8'))
  assert.strictEqual(m.detectors[0].origin.by, 'claude-haiku-5-5'); assert.strictEqual(m.detectors[0].sha, SB.sha(fs.readFileSync(path.join(dd, 'hotbar_flicker.js'), 'utf8')))
  assert.match(fs.readFileSync(path.join(dd, 'hotbar_flicker.js'), 'utf8'), /It only flags/)
  const log = JSON.parse(fs.readFileSync(path.join(dd, 'log.jsonl'), 'utf8').trim())
  assert.strictEqual(log.action, 'enabled'); assert.match(log.source, /function detect/)
  assert.deepStrictEqual(proposals.customList(bot).map(d => d.kind), ['custom_hotbar_flicker'])
})

test('rejected: noisy on normal play, silent on the bad window, unscreenable, not enough normal windows, unknown window ids', () => {
  const bot = botWithWindows()
  const noisy = prop({ name: 'always', source: 'function detect(s,e,n,H){ return { sev: "med", msg: "always" } }' })
  const quiet = prop({ name: 'never', source: 'function detect(s,e,n,H){ return null }' })
  const evil = prop({ name: 'evil', source: 'function detect(s){ return s.constructor.constructor("return process")() }' })
  const spin = prop({ name: 'spin', source: 'function detect(s){ while (true) {} }' })
  const syntax = prop({ name: 'broken', source: 'function detect( {' })
  const evs = proposals.process(bot, [noisy, quiet], { now: T0 }).concat(proposals.process(bot, [evil, spin], { now: T0 }), proposals.process(bot, [syntax], { now: T0 }))
  assert.deepStrictEqual(evs.map(e => e.action), ['rejected', 'rejected', 'rejected', 'rejected', 'rejected'])
  assert.match(evs[0].reason, /fires on normal play/); assert.match(evs[1].reason, /silent on the bad window/)
  assert.match(evs[2].reason, /constructor/); assert.match(evs[3].reason, /timed out/); assert.match(evs[4].reason, /compile/)
  assert.match(proposals.process(botWithWindows({ normals: 2 }), [prop()], { now: T0 })[0].reason, /need 3/)
  assert.match(proposals.process(bot, [prop({ badWindows: ['w9-flagged'] })], { now: T0 })[0].reason, /none of the nominated/)
  assert.ok(!fs.existsSync(path.join(bot.dir, 'brain/state/detectors/manifest.json')), 'nothing enabled')
  const lines = fs.readFileSync(path.join(bot.dir, 'brain/state/detectors/log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(lines.length === 6 && lines.every(l => l.action === 'rejected' && typeof l.source === 'string'))
})

function liveModule(dir) {
  const bot = mockBot({ pos: [0, 64, 0] })
  bot.entity.velocity = new Vec3(0, 0, 0); bot.inventory.items = () => []; bot.blockAt = () => null; bot.targetDigBlock = null
  let clock = T0
  const h = register({ bot, events: new EventEmitter(), now: () => clock, log() {}, dir, statePath: (f) => path.join(dir, 'brain/state', f) })
  return { bot, h, advance: (ms) => { clock += ms } }
}

test('the bot hot-loads the installed detector in the sandbox and raises its flag; a tampered file is refused; a throwing detector is muted', () => {
  const bot = botWithWindows()
  proposals.process(bot, [prop()], { now: T0 })
  const m = liveModule(bot.dir)
  m.h.start()
  const items = ['dirt', 'stone_sword']
  for (let i = 0; i < 160; i++) { m.bot.heldItem = { name: items[i % 2] }; m.h._tick.sample(); m.advance(250) }
  m.h._tick.analyze()
  let sum = m.h._tick.summary()
  const f = sum.flags.find(x => x.kind === 'custom_hotbar_flicker')
  assert.ok(f, JSON.stringify(sum.flags)); assert.strictEqual(f.origin, 'model-written detector'); assert.match(f.msg, /held-item switches/)
  assert.match(fs.readFileSync(path.join(bot.dir, 'REVIEW-ALERTS.md'), 'utf8'), /custom_hotbar_flicker/)
  m.h.stop()
  // tampered source: the hash no longer matches, so it is not loaded
  fs.appendFileSync(path.join(bot.dir, 'brain/state/detectors/hotbar_flicker.js'), '\n// edited\n')
  const m2 = liveModule(bot.dir); m2.h.start()
  for (let i = 0; i < 160; i++) { m2.bot.heldItem = { name: items[i % 2] }; m2.h._tick.sample(); m2.advance(250) }
  m2.h._tick.analyze()
  assert.ok(!m2.h._tick.summary().flags.some(x => x.kind === 'custom_hotbar_flicker')); m2.h.stop()
  // a detector that throws is muted after 3 passes and never affects the bot
  const bot2 = botWithWindows()
  const boom = 'function detect(s, e, n, H) { if (s.length > 5) { return s[999999].h.x } return null }'
  const dd = path.join(bot2.dir, 'brain/state/detectors'); fs.mkdirSync(dd, { recursive: true })
  const file = '// boom\n' + boom + '\n'; fs.writeFileSync(path.join(dd, 'boom.js'), file)
  fs.writeFileSync(path.join(dd, 'manifest.json'), JSON.stringify({ detectors: [{ name: 'boom', enabled: true, sha: SB.sha(file), version: 1, origin: { by: 'test' } }] }))
  const m3 = liveModule(bot2.dir); m3.h.start()
  for (let i = 0; i < 40; i++) { m3.h._tick.sample(); m3.advance(250) }
  for (let k = 0; k < 5; k++) { m3.h._tick.analyze(); m3.advance(15000) }
  assert.deepStrictEqual(m3.h._tick.summary().customDetectors, [{ name: 'boom', muted: true }]); m3.h.stop()
})

test('the module captures raw windows (normal and flagged) for later validation, and keeps only the newest', () => {
  const bot = botWithWindows({ normals: 0 })
  fs.rmSync(path.join(bot.dir, 'brain/state/telemetry/windows'), { recursive: true })
  const m = liveModule(bot.dir); m.h.start()
  for (let round = 0; round < 12; round++) {
    for (let i = 0; i < 520; i++) { m.h._tick.sample(); m.advance(250) }     // 130 s
    m.h._tick.analyze()
  }
  const files = fs.readdirSync(path.join(bot.dir, 'brain/state/telemetry/windows'))
  assert.ok(files.length >= 5 && files.length <= 14, files.join())
  const w = JSON.parse(fs.readFileSync(path.join(bot.dir, 'brain/state/telemetry/windows', files[0]), 'utf8'))
  assert.ok(w.samples.length > 500 && w.digest.counters && Array.isArray(w.digest.excerpt))
  assert.ok(proposals.windowDigests(bot).length > 0 && !('samples' in proposals.windowDigests(bot)[0]))
  m.h.stop()
})
