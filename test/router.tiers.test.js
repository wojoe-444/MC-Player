const test = require('node:test')
const assert = require('node:assert')
const catalogLib = require('../brain/router/catalog')
const { validate } = require('../brain/router/slots')
const { mcData } = require('./mock-bot')
const { rig, decision, chatOk, reply, fakeFetch, SECRET, COMMANDS } = require('./router.helpers')
const wait = (ms) => new Promise(r => setTimeout(r, ms))

const cmds = COMMANDS.map(c => ({ ...c, canonical: String(c.help).split('|').map(s => s.trim()) }))
const WP = [{ name: 'farm', x: -1030, y: 64, z: 2350 }, { name: 'The First Base', x: -1500, y: 64, z: 1500 }]
const cat = catalogLib.build({ commands: cmds, waypoints: WP })
const reg = { blocks: mcData.blocksArray.map(b => b.name), items: mcData.itemsArray.map(i => i.name) }

test('slots.validate: catalog commands and slot commands pass; anything else is refused', () => {
  const V = (s) => validate(s, cat, reg)
  assert.deepStrictEqual([V('Follow Me').ok, V('follow me').canonical], [true, 'follow me'])
  assert.strictEqual(V('stay').instant, true)
  assert.strictEqual(V('excavate').risk, 'high')
  assert.deepStrictEqual([V('go to 100 64 -200').ok, V('go to 100 -200').ok, V('go to 100 900 -200').reason], [true, true, 'coords-range'])
  assert.strictEqual(V('go to 99999999999 5').ok, false)
  assert.strictEqual(V('go to farm').canonical, 'go to farm')
  assert.deepStrictEqual([V('go to the first base').canonical, V('go to the first base').shown], ['go to -1500 64 1500', 'go to the first base'])
  assert.strictEqual(V('go to lava lake').ok, false)
  assert.strictEqual(V('find diamond').canonical, 'find diamond ore')
  assert.strictEqual(V('find oak planks').canonical, 'find oak planks')
  assert.strictEqual(V('find unobtainium').reason, 'unknown-block')
  assert.deepStrictEqual([V('craft torch 4').ok, V('craft torch 4').risk, V('craft glass pane').canonical], [true, 'high', 'craft glass pane'])
  assert.strictEqual(V('craft torch 99999').reason, 'count-range')
  assert.strictEqual(V('craft bedrock_wand').ok, false)
  assert.strictEqual(V('save waypoint my mine').ok, true)
  for (const bad of ['/gamemode creative', 'dig down', 'rm -rf', 'follow me\nstop', 'x'.repeat(200), '', null, 5, 'unknown-label']) assert.strictEqual(V(bad).ok, false, String(bad))
})

const tierRig = (opts, tierFn, tierOpts) => {
  const r = rig({ fetch: fakeFetch([decision({ label: 'none' })]), ...opts })
  assert.ok(r.api.router && typeof r.api.router.addTier === 'function', 'hook is published on the shared api')
  const seen = []
  r.api.router.addTier('fast-lane', async (ctx) => { seen.push(ctx); return tierFn(ctx) }, tierOpts)
  return { r, seen }
}

test('tier: only called after Elephant defers, with what it needs; its command goes through the same validation and dispatch', async () => {
  const { r, seen } = tierRig({}, () => ({ action: 'run', canonical: 'find diamond' }))
  r.say('OGWO', 'any diamonds close by that you can spot'); await r.mod.idle()
  assert.deepStrictEqual(r.dispatched, ['find diamond ore'])
  assert.strictEqual(seen.length, 1)
  const c = seen[0]
  assert.strictEqual(c.text, 'any diamonds close by that you can spot'); assert.strictEqual(c.shadow, false)
  assert.deepStrictEqual(c.previous.map(p => [p.tier, p.action, p.reason]), [['elephant-1', 'defer', 'none']])
  assert.ok(c.catalog.options.some(o => o.label === 'follow me') && c.catalog.waypoints.some(w => w.name === 'farm'))
  assert.strictEqual(c.validate('craft torch 2').risk, 'high'); assert.ok(c.signal && c.state.message === c.text)
  assert.strictEqual(r.said.length, 0); assert.strictEqual(r.unhandled(), '')
  assert.strictEqual(JSON.parse(r.routerLog().trim()).tier, 'fast-lane')
  r.mod.stop()
})

test('tier: not called when Elephant is confident; invalid, high-risk, reply, timeout and error results', async () => {
  let { r, seen } = tierRig({ fetch: fakeFetch([decision({ label: 'follow me' })]) }, () => ({ action: 'run', canonical: 'stay' }))
  r.say('OGWO', 'tag along with me over here'); await r.mod.idle()
  assert.deepStrictEqual(r.dispatched, ['follow me']); assert.strictEqual(seen.length, 0)

  ;({ r } = tierRig({}, () => ({ action: 'run', canonical: 'dig down 10 blocks' })))        // invented command: refused, Claude gets it
  r.say('OGWO', 'please tunnel down for me'); await r.mod.idle()
  assert.deepStrictEqual(r.dispatched, []); assert.match(r.unhandled(), /tunnel down/); assert.strictEqual(r.said.length, 1)

  ;({ r } = tierRig({}, () => ({ action: 'run', canonical: 'craft torch 4' })))              // risky: confirmed even if the tier said run
  r.say('OGWO', 'we are short on light sources'); await r.mod.idle()
  assert.deepStrictEqual(r.said, ['Did you mean "craft torch 4"? (yes/no)']); assert.deepStrictEqual(r.dispatched, [])
  assert.strictEqual(r.say('OGWO', 'yes'), true); assert.deepStrictEqual(r.dispatched, ['craft torch 4'])

  ;({ r } = tierRig({}, () => ({ action: 'reply', text: '/op me\n  Nothing in my bag but dirt.', handoff: true })))
  r.say('OGWO', 'what is in your bag these days'); await r.mod.idle()
  assert.deepStrictEqual(r.said, ['op me Nothing in my bag but dirt.']); assert.match(r.unhandled(), /bag these days/); assert.deepStrictEqual(r.dispatched, [])

  ;({ r } = tierRig({}, () => ({ action: 'reply', text: 'Plain answer.' })))
  r.say('OGWO', 'what is in your bag these days'); await r.mod.idle()
  assert.deepStrictEqual(r.said, ['Plain answer.']); assert.strictEqual(r.unhandled(), '')

  ;({ r } = tierRig({}, () => new Promise(() => {}), { timeoutMs: 40 }))
  r.say('OGWO', 'could you do the thing with the stuff'); await r.mod.idle()
  assert.match(r.unhandled(), /the stuff/); assert.strictEqual(r.said.length, 1)

  ;({ r } = tierRig({}, () => { throw new Error('boom ' + SECRET) }))
  r.say('OGWO', 'could you do the thing with the stuff'); await r.mod.idle()
  assert.match(r.unhandled(), /the stuff/); assert.ok(!r.logs.join('\n').includes('TESTSECRET'))
})

test('tier: tiers run in order and the first usable answer wins; shadow mode passes shadow:true and never acts', async () => {
  const order = []
  const r = rig({ fetch: fakeFetch([decision({ label: 'none' })]) })
  r.api.router.addTier('a', async (ctx) => { order.push(['a', ctx.previous.length]); return { action: 'defer', reason: 'meh' } })
  r.api.router.addTier('b', async (ctx) => { order.push(['b', ctx.previous.map(p => p.reason).join(',')]); return { action: 'run', canonical: 'inventory' } })
  r.api.router.addTier('c', async () => { order.push(['c']); return { action: 'run', canonical: 'stay' } })
  r.say('OGWO', 'let me see whatever you are holding'); await r.mod.idle()
  assert.deepStrictEqual(order, [['a', 1], ['b', 'none,meh']])
  assert.deepStrictEqual(r.dispatched, ['inventory'])
  assert.deepStrictEqual(r.mod.status().tiers, ['a', 'b', 'c'])

  const s = tierRig({ mode: 'shadow', config: { tiersInShadow: true } }, () => ({ action: 'run', canonical: 'inventory' }))
  assert.strictEqual(s.r.say('OGWO', 'let me see whatever you are holding'), false); await s.r.mod.idle()
  assert.strictEqual(s.seen[0].shadow, true); assert.deepStrictEqual(s.r.dispatched, []); assert.deepStrictEqual(s.r.said, [])
  assert.strictEqual(JSON.parse(s.r.routerLog().trim()).canonical, 'inventory')
})

test('tier: Elephant being down still escalates; a stop typed meanwhile still wins', async () => {
  let { r, seen } = tierRig({ fetch: fakeFetch([reply(500, 'down')]) }, () => ({ action: 'run', canonical: 'inventory' }))
  r.say('OGWO', 'let me see whatever you are holding'); await r.mod.idle()
  assert.deepStrictEqual(r.dispatched, ['inventory']); assert.strictEqual(seen[0].previous[0].reason, 'api-server')

  ;({ r } = tierRig({}, async () => { await wait(50); return { action: 'run', canonical: 'follow me' } }))
  r.say('OGWO', 'tag along with me over here')
  r.events.emit('chat', { user: 'OGWO', text: 'stop' })
  await r.mod.idle()
  assert.deepStrictEqual(r.dispatched, []); assert.match(r.unhandled(), /tag along/)
})

// ---------------- level 2 = brain/fastlane, called through the same hook ----------------
test('fastlane tier: command, reply, escalate and invalid answers; not called when level 1 is confident; skipped in shadow', async () => {
  const fl = (obj) => fakeFetch([chatOk(obj)])
  let f = fl({ kind: 'command', command: 'find iron ore', confidence: 0.92 })
  let r = rig({ fetch: fakeFetch([decision({ label: 'none' })]), flFetch: f })
  r.say('OGWO', 'any iron ore around here that you can see'); await r.mod.idle()
  assert.deepStrictEqual(r.dispatched, ['find iron ore']); assert.strictEqual(f.calls.length, 1)
  assert.ok(f.calls[0].headers.Authorization.startsWith('Bearer ')); assert.ok(!JSON.stringify(f.calls[0].body).includes('TESTSECRET'))
  assert.strictEqual(JSON.parse(r.routerLog().trim()).tier, 'fastlane')

  f = fl({ kind: 'reply', text: 'Doing fine, thanks!' })
  r = rig({ fetch: fakeFetch([decision({ label: 'none' })]), flFetch: f })
  r.say('OGWO', 'hope you are having a decent evening'); await r.mod.idle()
  assert.deepStrictEqual(r.said, ['Doing fine, thanks!']); assert.strictEqual(r.unhandled(), '', 'one answer only: Claude is not told twice')

  f = fl({ kind: 'escalate' })
  r = rig({ fetch: fakeFetch([decision({ label: 'none' })]), flFetch: f })
  r.say('OGWO', 'how should we lay out the new storage room'); await r.mod.idle()
  assert.match(r.unhandled(), /storage room/); assert.strictEqual(r.said.length, 1); assert.deepStrictEqual(r.dispatched, [])

  f = fl({ kind: 'command', command: 'dig down 10', confidence: 0.99 })
  r = rig({ fetch: fakeFetch([decision({ label: 'none' })]), flFetch: f })
  r.say('OGWO', 'tunnel down ten blocks for me please'); await r.mod.idle()
  assert.deepStrictEqual(r.dispatched, []); assert.match(r.unhandled(), /tunnel down/)

  f = fl({ kind: 'command', command: 'craft torch 4', confidence: 0.99 })
  r = rig({ fetch: fakeFetch([decision({ label: 'none' })]), flFetch: f })
  r.say('OGWO', 'make 4 torch for the cave'); await r.mod.idle()
  assert.deepStrictEqual(r.dispatched, []); assert.deepStrictEqual(r.said, ['Did you mean "craft torch 4"? (yes/no)'])

  f = fl({ kind: 'command', command: 'stay', confidence: 0.99 })
  r = rig({ fetch: fakeFetch([decision({ label: 'follow me' })]), flFetch: f })
  r.say('OGWO', 'tag along with me over here'); await r.mod.idle()
  assert.deepStrictEqual(r.dispatched, ['follow me']); assert.strictEqual(f.calls.length, 0)

  f = fl({ kind: 'command', command: 'inventory', confidence: 0.99 })
  r = rig({ mode: 'shadow', fetch: fakeFetch([decision({ label: 'none' })]), flFetch: f })
  r.say('OGWO', 'let me see whatever you are holding'); await r.mod.idle()
  assert.strictEqual(f.calls.length, 0, 'shadow mode does not spend the shared free-tier allowance on level 2'); assert.deepStrictEqual(r.dispatched, [])
  assert.ok(r.mod.status().fastlane)
})

// ---------------- varied acks by kind + "router last" ----------------
const { decision: dec0 } = require('./router.helpers')
const withKind = (kind, p = 0.9, base = {}) => { const d = dec0({ label: 'none', ...base }); d.answers.kind = { type: 'choice', choice: kind, confidence: p, probabilities: { [kind]: p } }; return d }

test('acks: a line that goes to Claude gets a reply that fits its kind, rotating, never the old generic one when the kind is known', async () => {
  const { ACKS } = require('../brain/router/acks')
  const f = fakeFetch([withKind('task'), withKind('task'), withKind('idea'), withKind('question')])
  const r = rig({ fetch: f })
  const lines = ['please have the bot reorganize all the chests by tomorrow', 'please have the bot rebuild the whole farm layout soon', 'maybe the bot could collect flowers sometime', 'is the decision model used for anything right now']
  for (const t of lines) { r.say('OGWO', t); await r.mod.idle() }
  assert.ok(ACKS.task.includes(r.said[0]) && ACKS.task.includes(r.said[1]) && r.said[0] !== r.said[1], JSON.stringify(r.said))
  assert.ok(ACKS.idea.includes(r.said[2])); assert.ok(ACKS.question.includes(r.said[3]))
  assert.ok(r.said.every(s => s !== 'Got it, one moment.'))
  assert.match(r.unhandled(), /rebuild the whole farm/, 'Claude still gets every line')
  assert.strictEqual(JSON.parse(r.routerLog().trim().split('\n')[0]).kind, 'task')
  assert.ok(f.calls[0].body.questions.kind.type === 'choice' && 'idea' in f.calls[0].body.questions.kind.criteria)
})

test('acks: an unsure or unknown kind falls back to the generic ack; no ack words promise an order was taken', async () => {
  const { ACKS } = require('../brain/router/acks')
  for (const resp of [withKind('task', 0.3), withKind('banana'), decision({ label: 'none' })]) {
    const r = rig({ fetch: fakeFetch([resp]) })
    r.say('OGWO', 'please have the bot reorganize all the chests'); await r.mod.idle()
    assert.match(r.said[0], /^(Got it, one moment\.|Let me think about that\.)$/)
  }
  for (const w of Object.values(ACKS).flat()) assert.ok(w.length <= 40 && !/\b(on it|yes sir|right away|as you wish|will do)\b/i.test(w), w)
})

test('acks: a recognised command is never answered with an ack, and the early ack still works before the model answers', async () => {
  let r = rig({ fetch: fakeFetch([decision({ label: 'follow me' })]) })
  r.say('OGWO', 'tag along with me over here'); await r.mod.idle()
  assert.deepStrictEqual(r.said, [])
  r = rig({ fetch: fakeFetch([async () => { await wait(90); return withKind('task') }]), config: { timeoutMs: 500 } })
  r.say('OGWO', 'please have the bot reorganize all the chests'); await wait(60)
  assert.deepStrictEqual(r.said, ['Got it, one moment.'])
  await r.mod.idle()
  assert.strictEqual(r.said.length, 1, 'one ack only')
})

test('"router last" tells Walter what the last decisions were; others are ignored', async () => {
  const r = rig({ fetch: fakeFetch([decision({ label: 'follow me' }), withKind('task'), decision({ label: 'start furnace upkeep', p: 0.97 })]) })
  for (const t of ['tag along with me over here', 'please have the bot reorganize all the chests', 'the furnaces are running low on fuel again']) { r.say('OGWO', t); await r.mod.idle() }
  r.said.length = 0
  const cmd = r.added.find(c => c.name === 'router-last')
  assert.ok(cmd.match('OGWO', 'router last') && !cmd.match('OGWO', 'router lasting'))
  cmd.run('Someone', 'router last', 'router last'); assert.deepStrictEqual(r.said, [])
  cmd.run('OGWO', 'router last', 'router last')
  assert.strictEqual(r.said.length, 1); assert.ok(r.said[0].length <= 230)
  assert.match(r.said[0], /^asked "start furnace upkeep" \d+ms: "the furnaces are runni.*\| to Claude \(task, none\) \d+ms: .*\| ran "follow me" \d+ms/)
  const e = rig({ fetch: fakeFetch([decision({ label: 'none' })]) })
  e.added.find(c => c.name === 'router-last').run('OGWO', 'router last', 'router last')
  assert.deepStrictEqual(e.said, ['No lines have reached the router yet.'])
})

// ---------------- field-test fixes: statements never run an action; status shows both tiers ----------------
test('interpret: a long line that mentions an action is never run (asked at most); an unsure "directed" defers', () => {
  const longLine = 'x'.repeat(150)
  const I = (o, meta) => interpret(dec0({ label: 'sleep', ...o }), cat, {}, meta)
  const { interpret } = require('../brain/router/decide')
  assert.strictEqual(I({ directed: 0.61, p: 0.86 }, { len: 195 }).action, 'defer')       // "it's important that you find a bed when it gets dark..." ran `sleep` in the field
  assert.strictEqual(I({ directed: 0.95, p: 0.97 }, { len: 120 }).action, 'ask')
  assert.strictEqual(I({ directed: 0.95, p: 0.97 }, { len: 150 }).reason, 'too-long')
  assert.strictEqual(I({ directed: 0.95, p: 0.97 }, { len: 12 }).action, 'run')
  assert.strictEqual(interpret(dec0({ label: 'what are you doing', directed: 0.99, p: 0.97 }), cat, {}, { len: 150 }).action, 'run', 'read-only reports are not length-limited')
  assert.ok(longLine.length === 150)
})

test('router status reports Elephant-1 and the fast lane, two short lines', async () => {
  const flf = fakeFetch([chatOk({ kind: 'reply', text: 'Doing fine, thanks!' })])
  const r = rig({ fetch: fakeFetch([decision({ label: 'none' }), decision({ label: 'follow me' })]), flFetch: flf })
  r.say('OGWO', 'hope you are having a decent evening'); await r.mod.idle()
  r.say('OGWO', 'tag along with me over here'); await r.mod.idle()
  r.said.length = 0
  r.added.find(c => c.name === 'router-mode').run('OGWO', 'router status', 'router status')
  assert.strictEqual(r.said.length, 2)
  assert.match(r.said[0], /^Router live; key env; 2\/2 calls ok, 2 lines seen: ran 1, asked 0, to Claude 0; Elephant-1 median \d+ ms/)
  assert.match(r.said[1], /^Fast lane \(.+\): 1 calls, said 1, ran 0, asked 0, passed to Claude 0/)
  assert.ok(r.said.every(s => s.length <= 230))
  const noFl = rig({ fetch: fakeFetch([decision({ label: 'none' })]) })
  noFl.added.find(c => c.name === 'router-mode').run('OGWO', 'router status', 'router status')
  assert.strictEqual(noFl.said.length, 1)
})

// ---------------- pilot present: the router stays silent about hand-offs ----------------
test('acks: with the pilot quick voice (tier "talker") loaded the router says nothing automatic; the event says so; "acks: always" restores them', async () => {
  const evs = []
  let r = rig({ fetch: fakeFetch([withKind('task')]) })
  r.events.on('router', (e) => evs.push(e))
  r.api.router.addTier('talker', async () => ({ action: 'defer', reason: 'talker-not-wanted' }), { first: true })
  r.say('OGWO', 'please have the bot reorganize all the chests'); await wait(60); await r.mod.idle()
  assert.deepStrictEqual(r.said, [], 'no ack, no early ack')
  assert.match(r.unhandled(), /reorganize all the chests/, 'Claude still gets the line')
  assert.strictEqual(evs.length, 1); assert.strictEqual(evs[0].silent, true); assert.strictEqual(evs[0].ackText, null); assert.strictEqual(evs[0].kind, 'task')

  r = rig({ fetch: fakeFetch([async () => { await wait(90); return withKind('task') }]), config: { timeoutMs: 500 } })
  r.api.router.addTier('talker', async () => ({ action: 'defer' }))
  r.say('OGWO', 'please have the bot reorganize all the chests'); await wait(70); await r.mod.idle()
  assert.deepStrictEqual(r.said, [], 'the early ack is silenced too')

  r = rig({ fetch: fakeFetch([withKind('task')]), config: { acks: 'always' } })
  const evs2 = []; r.events.on('router', (e) => evs2.push(e))
  r.api.router.addTier('talker', async () => ({ action: 'defer' }))
  r.say('OGWO', 'please have the bot reorganize all the chests'); await r.mod.idle()
  assert.strictEqual(r.said.length, 1); assert.strictEqual(evs2[0].ackText, r.said[0]); assert.strictEqual(evs2[0].silent, false)

  r = rig({ fetch: fakeFetch([withKind('task')]) })       // no pilot: fallback acks stay
  const evs3 = []; r.events.on('router', (e) => evs3.push(e))
  r.say('OGWO', 'please have the bot reorganize all the chests'); await r.mod.idle()
  assert.strictEqual(r.said.length, 1); assert.strictEqual(evs3[0].ackText, r.said[0])

  r = rig({ fetch: fakeFetch([decision({ label: 'follow me' })]) })                 // commands and confirmations are never silenced
  r.api.router.addTier('talker', async () => ({ action: 'defer' }))
  r.say('OGWO', 'tag along with me over here'); await r.mod.idle(); assert.deepStrictEqual(r.dispatched, ['follow me'])
  r = rig({ fetch: fakeFetch([decision({ label: 'excavate', p: 0.97 })]) })
  r.api.router.addTier('talker', async () => ({ action: 'defer' }))
  r.say('OGWO', 'time to carve out that ceiling now'); await r.mod.idle()
  assert.deepStrictEqual(r.said, ['Did you mean "excavate"? (yes/no)'])
})
