const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const catalogLib = require('../brain/router/catalog')
const { buildRequest, interpret } = require('../brain/router/decide')
const { createClient } = require('../brain/router/client')
const { rig, decision, reply, fakeFetch, SECRET, COMMANDS } = require('./router.helpers')
const wait = (ms) => new Promise(r => setTimeout(r, ms))

const cmds = COMMANDS.map(c => ({ ...c, canonical: String(c.help).split('|').map(s => s.trim()) }))
const WP = [{ name: 'farm', x: -1030, y: 64, z: 2350 }, { name: 'The First Base', x: -1500, y: 64, z: 1500 }, { name: 'portal (-637, -3030)', x: -637, y: 90, z: -3030 }]

// ---------------- catalog ----------------
test('catalog: closed list from the intent table + registered commands; slot, router and unregistered brain commands are not offered', () => {
  const c = catalogLib.build({ commands: cmds, waypoints: WP })
  const labels = c.options.map(o => o.label)
  for (const l of ['follow me', 'stay', 'inventory', 'start furnace upkeep', 'furnace status', 'what are you doing', 'resume excavation', 'excavate', 'resume tasks', 'goto-waypoint']) assert.ok(labels.includes(l), l)
  assert.ok(!labels.includes('you can fight') && !labels.includes('dashboard'), 'brain-native intents only when registered')
  assert.ok(!labels.some(l => /[<\[]/.test(l)), 'slot commands (craft <item>) stay with brain/chat')
  assert.ok(!labels.includes('@again') && !labels.some(l => /^router/.test(l)))
  assert.strictEqual(c.byLabel.get('start furnace upkeep').risk, 'high')
  assert.strictEqual(c.byLabel.get('stay').instant, true)
  assert.strictEqual(new Set(labels).size, labels.length)
})

test('catalog: waypoint canonicals follow the chat module rules (legacy-safe names stay names, others become coordinates)', () => {
  const c = catalogLib.build({ commands: cmds, waypoints: WP })
  const by = Object.fromEntries(c.waypoints.map(w => [w.name, w.canonical]))
  assert.strictEqual(by.farm, 'go to farm')
  assert.strictEqual(by['The First Base'], 'go to -1500 64 1500')
  assert.strictEqual(by['portal (-637, -3030)'], 'go to -637 90 -3030')
  assert.ok(!catalogLib.build({ commands: cmds, waypoints: [] }).byLabel.has('goto-waypoint'))
})

// ---------------- request / interpret ----------------
const cat = catalogLib.build({ commands: cmds, waypoints: WP })
const req = (msg = 'x') => buildRequest({ model: 'baseten/elephant-1:free', state: { message: msg }, catalog: cat })

test('request: one call carries a noul gate, the command choice (with none) and the place choice', () => {
  const r = req('please grab me some wheat')
  assert.strictEqual(r.model, 'baseten/elephant-1:free')
  assert.strictEqual(r.state.message, 'please grab me some wheat')
  assert.strictEqual(r.questions.directed.type, 'noul')
  assert.strictEqual(r.questions.command.type, 'choice')
  assert.ok('none' in r.questions.command.criteria && 'follow me' in r.questions.command.criteria)
  assert.deepStrictEqual(Object.keys(r.questions.place.criteria), ['farm', 'The First Base', 'portal (-637, -3030)'])
  assert.ok(JSON.stringify(r).length < 12000, 'stays far below the 16k context')
})

test('interpret: confident low-risk runs; high-risk always asks; none, low directed, low p and unknown labels defer', () => {
  const I = (o, th) => interpret(decision(o), cat, th)
  assert.strictEqual(I({ label: 'follow me' }).action, 'run')
  assert.strictEqual(I({ label: 'follow me' }).canonical, 'follow me')
  assert.strictEqual(I({ label: 'excavate', p: 0.99 }).action, 'ask', 'a model never starts a dig')
  assert.strictEqual(I({ label: 'start furnace upkeep', p: 0.99 }).action, 'ask')
  assert.strictEqual(I({ label: 'none' }).action, 'defer')
  assert.strictEqual(I({ label: 'follow me', directed: 0.2 }).reason, 'not-directed')
  assert.strictEqual(I({ label: 'follow me', p: 0.4 }).reason, 'low-confidence')
  assert.strictEqual(I({ label: 'follow me', p: 0.7 }).action, 'ask', 'in between: confirm')
  assert.strictEqual(I({ label: 'follow me', p: 0.85, second: ['come here', 0.7] }).action, 'ask', 'too close to call: confirm')
  assert.strictEqual(I({ label: 'rm -rf /' }).reason, 'unknown-label')
  assert.strictEqual(interpret({ answers: {} }, cat).reason, 'malformed')
  assert.strictEqual(interpret(null, cat).reason, 'malformed')
})

test('interpret: stop-style commands skip the directed gate and need only a low confidence', () => {
  const r = interpret(decision({ label: 'stay', p: 0.6, directed: 0.1 }), cat)
  assert.strictEqual(r.action, 'run')
  assert.strictEqual(interpret(decision({ label: 'stay', p: 0.3 }), cat).action, 'defer')
})

test('interpret: go-to needs a valid, confident place; the model cannot invent one', () => {
  const ok = interpret(decision({ label: 'goto-waypoint', place: 'The First Base', p: 0.95 }), cat)
  assert.strictEqual(ok.action, 'run'); assert.strictEqual(ok.canonical, 'go to -1500 64 1500'); assert.strictEqual(ok.shown, 'go to the first base')
  assert.strictEqual(interpret(decision({ label: 'goto-waypoint', place: 'farm', placeP: 0.3 }), cat).reason, 'no-place')
  assert.strictEqual(interpret(decision({ label: 'goto-waypoint', place: 'lava lake' }), cat).reason, 'no-place')
  assert.strictEqual(interpret(decision({ label: 'goto-waypoint' }), cat).reason, 'no-place')
})

// ---------------- client ----------------
test('client: no key means no request at all', async () => {
  const f = fakeFetch([decision({ label: 'none' })])
  const c = createClient({ fetch: f, env: {}, keyFile: path.join(os.tmpdir(), 'definitely-missing.key') })
  assert.deepStrictEqual(c.available(), { ok: false, reason: 'no-key' })
  assert.strictEqual((await c.decide({})).kind, 'no-key')
  assert.strictEqual(f.calls.length, 0)
})

test('client: key from a file works, is re-read when the file appears, and is sent only as a bearer header', async () => {
  const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rk-')), 'openrouter.key')
  const f = fakeFetch([decision({ label: 'none' })])
  const c = createClient({ fetch: f, env: {}, keyFile })
  assert.strictEqual(c.hasKey(), false)
  fs.writeFileSync(keyFile, '﻿' + SECRET + '\r\nignored second line\n')
  const r = await c.decide({ model: 'm', state: 's', questions: {} })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(f.calls[0].headers.Authorization, 'Bearer ' + SECRET)
  assert.ok(!JSON.stringify(f.calls[0].body).includes(SECRET))
  assert.strictEqual(c.status().keySource, 'file')
  assert.ok(!JSON.stringify(c.status()).includes(SECRET))
  assert.strictEqual(f.calls[0].url, 'https://openrouter.ai/api/alpha/decisions')
})

test('client: errors never carry the key, whatever the server or fetch says', async () => {
  const leak = [new Error(`connect failed for Bearer ${SECRET}`), reply(500, { error: { message: `bad key ${SECRET}` } }), reply(401, `Authorization: Bearer ${SECRET}`)]
  for (const s of leak) {
    const c = createClient({ fetch: fakeFetch([s]), env: { OPENROUTER_API_KEY: SECRET } })
    const r = await c.decide({})
    assert.strictEqual(r.ok, false)
    assert.ok(!JSON.stringify(r).includes(SECRET), JSON.stringify(r))
    assert.ok(!JSON.stringify(r).includes('v1-TESTSECRET'))
  }
})

test('client: timeout, 429, 401 and repeated failures open the breaker; it closes again later', async () => {
  let t = 1000000
  const mk = (script, extra = {}) => { const f = fakeFetch(script); return { f, c: createClient({ fetch: f, env: { OPENROUTER_API_KEY: SECRET }, now: () => t, timeoutMs: 30, failLimit: 2, failCooldownMs: 5000, ...extra }) } }
  let { f, c } = mk([{ hang: true }])
  assert.strictEqual((await c.decide({})).kind, 'timeout')
  assert.strictEqual(c.available().ok, true, 'one failure is not enough')
  assert.strictEqual((await c.decide({})).kind, 'timeout')
  assert.strictEqual(c.available().ok, false)
  assert.strictEqual((await c.decide({})).kind, 'breaker'); assert.strictEqual(f.calls.length, 2, 'no request while open')
  t += 6000; assert.strictEqual(c.available().ok, true)

  ;({ f, c } = mk([reply(429, { error: { message: 'rate limited' } }, { 'retry-after': '30' })]))
  assert.strictEqual((await c.decide({})).kind, 'rate')
  t += 29000; assert.strictEqual(c.available().ok, false, 'honours retry-after')
  t += 2000; assert.strictEqual(c.available().ok, true)

  ;({ f, c } = mk([reply(401, { error: { message: 'No auth credentials found' } })]))
  assert.strictEqual((await c.decide({})).kind, 'auth')
  t += 60000; assert.strictEqual(c.available().ok, false, 'a bad key is not retried every minute')

  ;({ f, c } = mk([reply(200, 'not json'), reply(200, { nope: 1 })]))
  assert.strictEqual((await c.decide({})).kind, 'bad-json')
  assert.strictEqual((await c.decide({})).kind, 'bad-shape')
})

test('client: latency percentiles', async () => {
  const c = createClient({ fetch: fakeFetch([decision({ label: 'none' })]), env: { OPENROUTER_API_KEY: SECRET } })
  for (let i = 0; i < 5; i++) await c.decide({})
  const l = c.latency()
  assert.strictEqual(l.n, 5); assert.ok(l.p50 >= 0 && l.p95 >= l.p50 && l.max >= l.p95)
})

// ---------------- module (live mode) ----------------
test('live: a confident low-risk decision dispatches the canonical command; Claude hand-off is not touched', async () => {
  const r = rig({ fetch: fakeFetch([decision({ label: 'follow me' })]) })
  assert.strictEqual(r.say('OGWO', 'hey buddy tag along with me over here'), true, 'the router owns the line while the request is in flight')
  await r.mod.idle()
  assert.deepStrictEqual(r.dispatched, ['follow me'])
  assert.deepStrictEqual(r.said, [])
  assert.strictEqual(r.unhandled(), '')
  const log = JSON.parse(r.routerLog().trim())
  assert.strictEqual(log.action, 'run'); assert.strictEqual(log.canonical, 'follow me'); assert.ok(log.ms >= 0)
  r.mod.stop()
})

test('live: the request carries the line, bot state and the registered commands; never the key in the body', async () => {
  const f = fakeFetch([decision({ label: 'none' })])
  const r = rig({ fetch: f })
  r.say('OGWO', 'could you grab me some wheat from the farm later')
  await r.mod.idle()
  const body = f.calls[0].body
  assert.strictEqual(body.state.message, 'could you grab me some wheat from the farm later')
  assert.strictEqual(body.state.doing, 'idle'); assert.strictEqual(body.state.health, 20)
  assert.ok('start furnace upkeep' in body.questions.command.criteria)
  assert.ok(!JSON.stringify(body).includes('TESTSECRET'))
  assert.ok(!JSON.stringify(r.logs).includes('TESTSECRET') && !r.routerLog().includes('TESTSECRET'))
  r.mod.stop()
})

test('live: high-risk is confirmed; "yes" runs it, a different line abandons it, "no" cancels it', async () => {
  let r = rig({ fetch: fakeFetch([decision({ label: 'start furnace upkeep', p: 0.97 })]) })
  r.say('OGWO', 'the furnaces are running low on fuel again, sort them out'); await r.mod.idle()
  assert.deepStrictEqual(r.dispatched, [])
  assert.deepStrictEqual(r.said, ['Did you mean "start furnace upkeep"? (yes/no)'])
  assert.strictEqual(r.say('OGWO', 'yes'), true, 'the bare yes is ours')
  assert.deepStrictEqual(r.dispatched, ['start furnace upkeep'])

  r = rig({ fetch: fakeFetch([decision({ label: 'excavate', p: 0.97 })]) })
  r.say('OGWO', 'time to carve out that ceiling now'); await r.mod.idle()
  assert.strictEqual(r.say('OGWO', 'no'), true)
  assert.deepStrictEqual(r.dispatched, []); assert.strictEqual(r.said[r.said.length - 1], 'OK, cancelled.')

  r = rig({ fetch: fakeFetch([decision({ label: 'excavate', p: 0.97 }), decision({ label: 'none' })]) })
  r.say('OGWO', 'time to carve out that ceiling now'); await r.mod.idle()
  assert.strictEqual(r.mod.onChat('OGWO', 'what is the weather like'), false, 'other lines are handled normally')
  assert.strictEqual(r.mod.onChat('OGWO', 'yes'), false, 'and the question is gone')
  assert.deepStrictEqual(r.dispatched, [])
  r.mod.stop()
})

test('live: an unanswered question expires', async () => {
  const r = rig({ fetch: fakeFetch([decision({ label: 'excavate', p: 0.97 })]), config: { confirmTtlMs: 30 } })
  r.say('OGWO', 'time to carve out that ceiling now'); await r.mod.idle()
  await wait(60)
  assert.strictEqual(r.mod.onChat('OGWO', 'yes'), false)
  assert.deepStrictEqual(r.dispatched, [])
})

test('live: go-to a saved place dispatches the waypoint canonical', async () => {
  const r = rig({ fetch: fakeFetch([decision({ label: 'goto-waypoint', place: 'farm' })]) })
  r.say('OGWO', 'would you mind heading over to where the crops are'); await r.mod.idle()
  assert.deepStrictEqual(r.dispatched, ['go to farm'])
})

test('live: "none", a failed dispatch, timeouts, rate limits and bad answers all go to Claude with the usual ack, once', async () => {
  const cases = [
    [decision({ label: 'none' }), 'what do you think about the new roof'],
    [{ hang: true }, 'could you do the thing with the stuff'],
    [reply(429, { error: { message: 'x' } }), 'please do that other thing'],
    [reply(500, 'oops'), 'please do that other thing'],
    [new Error('socket hang up'), 'please do that other thing'],
    [{ answers: 'garbage' }, 'please do that other thing']
  ]
  for (const [resp, text] of cases) {
    const r = rig({ fetch: fakeFetch([resp]) })
    assert.strictEqual(r.say('OGWO', text), true)
    await r.mod.idle()
    assert.deepStrictEqual(r.dispatched, [], text)
    assert.match(r.unhandled(), new RegExp(`OGWO: ${text}`))
    assert.strictEqual(r.said.length, 1, JSON.stringify(r.said))
    assert.match(r.said[0], /^(Got it, one moment\.|Let me think about that\.)$/)
    r.mod.stop()
  }
  const r = rig({ fetch: fakeFetch([decision({ label: 'follow me' })]), handled: () => false })
  r.say('OGWO', 'tag along with me over here'); await r.mod.idle()
  assert.match(r.unhandled(), /tag along/); assert.strictEqual(r.said.length, 1)
})

test('live: a slow answer gets the ack after ackAfterMs, and not a second one on defer', async () => {
  const r = rig({ fetch: fakeFetch([async () => { await wait(90); return decision({ label: 'none' }) }]), config: { timeoutMs: 500 } })
  r.say('OGWO', 'could you do the thing with the stuff'); await wait(60)
  assert.strictEqual(r.said.length, 1)
  await r.mod.idle()
  assert.strictEqual(r.said.length, 1)
  assert.match(r.unhandled(), /the stuff/)
})

test('live: a later "stop" beats the model: the old answer is dropped and goes to Claude', async () => {
  const r = rig({ fetch: fakeFetch([async () => { await wait(60); return decision({ label: 'follow me' }) }]), config: { timeoutMs: 500 } })
  r.say('OGWO', 'tag along with me over here')
  r.events.emit('chat', { user: 'OGWO', text: 'stop' })   // in the real flow the legacy stop rule takes this line before any fallback
  await r.mod.idle()
  assert.deepStrictEqual(r.dispatched, [])
  assert.ok(JSON.parse(r.routerLog().trim().split('\n')[0]).reason === 'superseded')
})

test('live: answers older than staleMs are not run', async () => {
  const r = rig({ fetch: fakeFetch([async () => { await wait(60); return decision({ label: 'follow me' }) }]), config: { timeoutMs: 500, staleMs: 20 } })
  r.say('OGWO', 'tag along with me over here'); await r.mod.idle()
  assert.deepStrictEqual(r.dispatched, [])
})

test('what is NOT sent to the model: other players, slash lines, chatter, Claude\'s cmd.txt lines, long text', async () => {
  const f = fakeFetch([decision({ label: 'none' })])
  const r = rig({ fetch: f })
  assert.strictEqual(r.say('Someone', 'follow me please'), false)
  assert.strictEqual(r.say('OGWO', '/gamemode creative'), false)
  assert.strictEqual(r.say('OGWO', 'lol'), false)
  assert.strictEqual(r.say('OGWO', 'ok!'), false)
  assert.strictEqual(r.say('OGWO', 'x'.repeat(400)), false)
  assert.strictEqual(r.say('OGWO', 'do the other thing please', { fromCmd: true }), false)
  await r.mod.idle()
  assert.strictEqual(f.calls.length, 0)
  r.mod.stop()
})

test('live: no key, open breaker or exhausted daily budget: the line is not taken (integrator logs + acks as before)', async () => {
  let r = rig({ fetch: fakeFetch([decision({ label: 'none' })]), withKey: false })
  assert.strictEqual(r.say('OGWO', 'could you do the thing with the stuff'), false)
  assert.deepStrictEqual(r.said, []); assert.strictEqual(r.unhandled(), '')

  const f = fakeFetch([reply(401, 'no')])
  r = rig({ fetch: f })
  r.say('OGWO', 'could you do the thing with the stuff'); await r.mod.idle()
  assert.strictEqual(r.say('OGWO', 'could you do another thing with it'), false, 'bad key: breaker is open')
  assert.strictEqual(f.calls.length, 1)

  const f2 = fakeFetch([decision({ label: 'none' })])
  r = rig({ fetch: f2, config: { maxPerDay: 2 } })
  for (const t of ['one thing please', 'two thing please']) { r.say('OGWO', t); await r.mod.idle() }
  assert.strictEqual(r.say('OGWO', 'three thing please'), false)
  assert.strictEqual(f2.calls.length, 2)
})

test('max in flight: extra lines are not queued behind a slow request', async () => {
  const r = rig({ fetch: fakeFetch([{ hang: true }]), config: { maxInFlight: 1, timeoutMs: 80 } })
  assert.strictEqual(r.say('OGWO', 'could you do the thing with the stuff'), true)
  assert.strictEqual(r.say('OGWO', 'could you do another thing with it'), false)
  await r.mod.idle()
})

// ---------------- shadow / off ----------------
test('shadow: asks the model and logs, but never acts, never acks and never takes the line', async () => {
  const f = fakeFetch([decision({ label: 'follow me' })])
  const r = rig({ fetch: f, mode: 'shadow' })
  assert.strictEqual(r.say('OGWO', 'tag along with me over here'), false)
  await r.mod.idle()
  assert.strictEqual(f.calls.length, 1)
  assert.deepStrictEqual(r.dispatched, []); assert.deepStrictEqual(r.said, []); assert.strictEqual(r.unhandled(), '')
  const log = JSON.parse(r.routerLog().trim())
  assert.strictEqual(log.mode, 'shadow'); assert.strictEqual(log.action, 'run'); assert.strictEqual(log.canonical, 'follow me')
  r.mod.stop()
})

test('off: nothing happens', async () => {
  const f = fakeFetch([decision({ label: 'follow me' })])
  const r = rig({ fetch: f, mode: 'off' })
  assert.strictEqual(r.say('OGWO', 'tag along with me over here'), false)
  assert.strictEqual(f.calls.length, 0)
})

test('"router live / shadow / off / status" switch the mode from chat and persist it', async () => {
  const f = fakeFetch([decision({ label: 'follow me' })])
  const r = rig({ fetch: f, mode: 'shadow' })
  const cmd = r.added.find(c => c.name === 'router-mode')
  assert.ok(cmd.match('OGWO', 'router live') && !cmd.match('OGWO', 'router rocks'))
  cmd.run('OGWO', 'router live', 'router live')
  assert.match(r.said[0], /^Router live \(saved\); key env;/)
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(r.dir, 'router-mode.json'), 'utf8')), { mode: 'live' })
  assert.strictEqual(r.say('OGWO', 'tag along with me over here'), true)
  await r.mod.idle()
  assert.deepStrictEqual(r.dispatched, ['follow me'])
  cmd.run('OGWO', 'router status', 'router status')
  assert.match(r.said[r.said.length - 1], /1\/1 calls ok/)
  cmd.run('Someone', 'router off', 'router off')
  assert.strictEqual(r.mod.status().mode, 'live', 'only Walter can switch it')
  cmd.run('OGWO', 'router off', 'router off')
  assert.strictEqual(r.mod.status().mode, 'off')
  r.mod.stop()
})

test('status() is JSON-serialisable and holds no key', async () => {
  const r = rig({ fetch: fakeFetch([decision({ label: 'none' })]) })
  r.say('OGWO', 'could you do the thing with the stuff'); await r.mod.idle()
  const s = JSON.parse(JSON.stringify(r.mod.status()))
  assert.strictEqual(s.mode, 'live'); assert.strictEqual(s.keySource, 'env'); assert.ok(s.latencyMs && s.latencyMs.n === 1)
  assert.ok(!JSON.stringify(s).includes('TESTSECRET'))
})

test('stop() removes the chat listener and clears timers', async () => {
  const r = rig({ fetch: fakeFetch([{ hang: true }]), config: { timeoutMs: 500, ackAfterMs: 5000 } })
  r.say('OGWO', 'could you do the thing with the stuff')
  const before = r.events.listenerCount('chat')
  r.mod.stop()
  assert.strictEqual(r.events.listenerCount('chat'), before - 1)
})

// ---------------- against the real catalog the other modules register ----------------
test('every canonical the router can emit is understood by brain/chat\'s intent table (same strings the legacy rules accept)', () => {
  const { INTENTS } = require('../brain/chat/intents')
  const known = new Set(INTENTS.map(i => i.canonical))
  const c = catalogLib.build({ commands: cmds, waypoints: WP })
  for (const o of c.options) if (o.canonical && !cmds.some(x => x.canonical[0] === o.canonical)) assert.ok(known.has(o.canonical), o.canonical)
})

// ---------------- through the real brain/index.js route() with brain/chat loaded in front ----------------
test('integration: brain.route() -> chat misses -> router decides; Claude\'s cmd.txt lines and stops never reach the model', async () => {
  const { mockBot } = require('./mock-bot')
  const attach = require('../brain')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-int-'))
  const f = fakeFetch([decision({ label: 'what are you doing' })])
  const oldFetch = global.fetch, oldKey = process.env.OPENROUTER_API_KEY, oldMode = process.env.BOT_ROUTER_MODE, oldDM = process.env.BOT_ROUTER_DECISION
  global.fetch = f; process.env.OPENROUTER_API_KEY = SECRET; process.env.BOT_ROUTER_MODE = 'live'; process.env.BOT_ROUTER_DECISION = 'on'
  const bot = mockBot({ pos: [0, 64, 0] })
  const said = []
  const brain = attach({
    bot, say: (t) => { said.push(t) }, goals: bot.goals, tryGoto: bot.tryGoto, stopNav() {}, navigateRaw() {}, navActive: () => false,
    handleCommand: (u, t) => /^stay$/.test(t), farm: { isBusy: () => false, stop() {} }, excavation: { isRunning: () => false, stop() {} },
    routines: { farm: false, lastFarmRun: 0 }, saveRoutines() {}, dir, stateDir: path.join(dir, 'state'), jobs: {}, stopAllLegacy() {},
    idleAfterMs: 50, safetyCooldownMs: 0,
    moduleEntries: ['chat', 'router'].map(n => ({ name: n, path: path.resolve(__dirname, '..', 'brain', n, 'index.js') }))
  })
  try {
    const line = 'give me the rundown on your current agenda'
    assert.strictEqual(brain.route('OGWO', line, { handleCommand: () => false }), true)
    await wait(30)
    assert.strictEqual(f.calls.length, 1)
    assert.ok(said.some(t => /^Doing:/.test(t)), JSON.stringify(said))
    assert.ok(!fs.existsSync(path.join(dir, 'unhandled.log')))
    // cmd.txt line (fromCmd): not sent, falls through to the integrator's normal "unhandled" path
    assert.strictEqual(brain.route('OGWO', 'give me the rundown on your other agenda', { handleCommand: () => false, fromCmd: true }), false)
    // a legacy-handled line never reaches fallback
    assert.strictEqual(brain.route('OGWO', 'stay', { handleCommand: (u, t) => t === 'stay' }), true)
    await wait(30)
    assert.strictEqual(f.calls.length, 1)
    // the router's mode command is a registered brain command
    brain.route('OGWO', 'router status', { handleCommand: () => false })
    assert.ok(said.some(t => /^Router live; key env;/.test(t)), JSON.stringify(said))
  } finally {
    brain.stop()
    global.fetch = oldFetch
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey
    if (oldMode === undefined) delete process.env.BOT_ROUTER_MODE; else process.env.BOT_ROUTER_MODE = oldMode
    if (oldDM === undefined) delete process.env.BOT_ROUTER_DECISION; else process.env.BOT_ROUTER_DECISION = oldDM
  }
})
