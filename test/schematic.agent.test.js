// brain/schematic/agent.js + agentstore.js + dashboard/schematicagent.js + the bot's request API: the schematic agent, with a fake model that calls the real tools.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'), os = require('os'), path = require('path')
const S = require('../brain/schematic/store')
const V = require('../brain/schematic/variants')
const F = require('../brain/schematic/format')
const AS = require('../brain/schematic/agentstore')
const AG = require('../brain/schematic/agent')
const D = require('../brain/schematic/designs')
const { createService } = require('../dashboard/schematicagent')
const register = require('../brain/schematic')

const T0 = Date.parse('2026-11-11T12:00:00')
const shared = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sch-agent-'))
const dirsOf = (sh) => S.dirsFor({ sharedDir: sh })
const ANSWER = { id: 'Oak Cottage!', name: 'Oak cottage', kind: 'house', category: 'Houses', tags: ['Cottage', 'oak'], purpose: 'A small cottage.', notes: ['two rooms'], summary: 'built it', variantName: '', variantDescription: '' }

// a model that builds a small cottage with the real tools and answers
const cottage = (extra = {}) => async (opts) => {
  const call = (name, args) => opts.tools.find(t => t.name === name).handler(args)
  const out = []
  out.push(await call('start_workspace', { width: 9, height: 7, depth: 9, mode: 'aesthetic' }))
  out.push(await call('fill', { from: [0, 0, 0], to: [8, 0, 8], block: 'cobblestone' }))
  out.push(await call('fill', { from: [1, 1, 1], to: [7, 4, 7], block: 'oak_planks', style: 'walls' }))
  out.push(await call('set_blocks', { blocks: [{ x: 4, y: 1, z: 1, block: 'oak_door', props: { facing: 'south' } }, { x: 3, y: 2, z: 7, block: 'glass_pane' }, { x: 2, y: 1, z: 6, block: 'no_such_block' }] }))
  out.push(await call('summary', {})); out.push(await call('view_slice', { axis: 'y', index: 1 }))
  opts.seen = out
  return { ok: true, data: { ...ANSWER, ...extra }, costUsd: 0.4, turns: 6, durationMs: 1000, calls: [] }
}
const req = (o = {}) => ({ id: 'rtest', createdAt: new Date(T0).toISOString(), source: 'user', by: 'Walter', prompt: 'a small oak cottage', kind: 'new', target: null, model: 'claude-opus-5-5', effort: 'medium', status: 'running', calls: [], ...o })

test('a new request: the model builds in the workspace and the result is filed as a schematic with the single variant Main', async () => {
  const sh = shared(); let seen
  const agent = async (o) => { seen = o; return cottage()(o).then(r => { seen.out = o.seen; return r }) }
  const r = await AG.runRequest(req(), { sharedDir: sh, dirs: dirsOf(sh), agent, now: () => T0 })
  assert.ok(r.ok, r.error); assert.strictEqual(r.result.schematicId, 'oak-cottage'); assert.strictEqual(r.result.variantId, 'main'); assert.deepStrictEqual(r.result.size, [9, 5, 9])
  assert.strictEqual(seen.model, 'claude-opus-5-5'); assert.strictEqual(seen.effort, 'medium'); assert.deepStrictEqual(seen.builtins, [], 'no built-in tools: no files, no shell, no web')
  assert.match(seen.out[3], /1 block\(s\) were REFUSED[\s\S]*no_such_block.*not a Minecraft 1\.21\.6 block/); assert.match(seen.out[4], /oak_planks/); assert.match(seen.out[5], /layer y=1/)
  assert.strictEqual(seen.gate('mcp__schem__fill').allow, true); assert.strictEqual(seen.gate('Bash').allow, false); assert.strictEqual(seen.gate('Write').allow, false)
  const doc = S.loadDoc(dirsOf(sh), 'oak-cottage').doc
  assert.strictEqual(doc.v, 3); assert.deepStrictEqual(doc.variants.map(v => v.name), ['Main']); assert.strictEqual(doc.category, 'house', '"Houses" is the shelf "house"'); assert.deepStrictEqual(doc.tags, ['cottage', 'oak'])
  assert.match(doc.variants[0].source.by, /claude-opus-5-5 \(medium\) for Walter/); assert.match(doc.variants[0].notes[0], /two rooms/)
  const s = S.load(dirsOf(sh), 'oak-cottage'); assert.strictEqual(s.mode, 'aesthetic'); assert.ok(s.palette.some(e => e.block === 'oak_door' && e.props.half === 'lower'))
})
test('a new request never overwrites: a taken id gets a number', async () => {
  const sh = shared()
  await AG.runRequest(req(), { sharedDir: sh, dirs: dirsOf(sh), agent: cottage(), now: () => T0 })
  const r2 = await AG.runRequest(req(), { sharedDir: sh, dirs: dirsOf(sh), agent: cottage(), now: () => T0 })
  assert.strictEqual(r2.result.schematicId, 'oak-cottage-2')
  const r3 = await AG.runRequest(req(), { sharedDir: sh, dirs: dirsOf(sh), agent: cottage({ id: 'starter-hut' }), now: () => T0 })
  assert.strictEqual(r3.result.schematicId, 'starter-hut-2', 'not even a library schematic is replaced by a new one')
})
test('a variant request: the base is open in the workspace, the result is filed next to it, Main is untouched, the library file is not written', async () => {
  const sh = shared(); let opening, summaryText
  const agent = async (o) => {
    opening = o.prompt
    const call = (n, a) => o.tools.find(t => t.name === n).handler(a)
    summaryText = await call('summary', {})
    assert.match(await call('grow', { x: 4 }), /now 29 x 22 x 23/)
    await call('replace_blocks', { from: 'oak_planks', to: 'spruce_planks' }); await call('replace_blocks', { from: 'oak_stairs', to: 'spruce_stairs' })
    return { ok: true, data: { id: 'ignored', name: '', kind: '', summary: 'spruce', variantName: 'Spruce', variantDescription: 'spruce instead of oak' }, costUsd: 0.2, turns: 4 }
  }
  const r = await AG.runRequest(req({ kind: 'variant', target: { id: 'starter-hut', variant: null }, prompt: 'the hut in spruce' }), { sharedDir: sh, dirs: dirsOf(sh), agent, now: () => T0 })
  assert.ok(r.ok, r.error); assert.strictEqual(r.result.variantId, 'spruce'); assert.strictEqual(r.result.schematicId, 'starter-hut')
  assert.match(opening, /new VARIANT of the schematic "Starter hut/); assert.match(summaryText, /oak_planks/)
  const doc = S.loadDoc(dirsOf(sh), 'starter-hut').doc
  assert.deepStrictEqual(doc.variants.map(v => v.id), ['main', 'spruce']); assert.strictEqual(doc.name, V.normalize(D.starterHut()).name, 'the schematic keeps its own name')
  assert.ok(S.load(dirsOf(sh), 'starter-hut', 'spruce').palette.some(e => e.block === 'spruce_planks')); assert.ok(!S.load(dirsOf(sh), 'starter-hut', 'main').palette.some(e => e.block === 'spruce_planks'))
  assert.ok(fs.existsSync(path.join(sh, 'schematics', 'starter-hut.json'))); assert.ok(fs.readdirSync(path.join(sh, 'schematic-agent', 'history')).length === 1, 'the previous file is kept')
})
test('an edit request replaces that variant in place (the old file goes to history) and refuses what does not exist', async () => {
  const sh = shared()
  await AG.runRequest(req(), { sharedDir: sh, dirs: dirsOf(sh), agent: cottage(), now: () => T0 })
  const agent = async (o) => {
    const call = (n, a) => o.tools.find(t => t.name === n).handler(a)
    const bb = /bounding box \((\d+), (\d+), (\d+)\) to \((\d+), (\d+), (\d+)\)/.exec(await call('summary', {})).slice(1).map(Number)
    assert.match(o.prompt, /6 cells of free room all round the build/)
    assert.match(await call('fill', { from: [bb[0], bb[4] + 1, bb[2]], to: [bb[3], bb[4] + 1, bb[5]], block: 'dark_oak_planks' }), /^ok: 81 blocks placed/)
    return { ok: true, data: { id: '', name: '', kind: '', summary: 'roof deck' }, costUsd: 0.1 } }
  const r = await AG.runRequest(req({ kind: 'edit', target: { id: 'oak-cottage', variant: 'main' }, prompt: 'add a dark oak roof deck' }), { sharedDir: sh, dirs: dirsOf(sh), agent, now: () => T0 + 1000 })
  assert.ok(r.ok, r.error); assert.strictEqual(r.result.variantId, 'main'); assert.deepStrictEqual(r.result.size, [9, 6, 9]); assert.deepStrictEqual(S.load(dirsOf(sh), 'oak-cottage').origin, [0, 0, 0], 'the margin is trimmed again and the origin is where it was')
  assert.ok(S.load(dirsOf(sh), 'oak-cottage').palette.some(e => e.block === 'dark_oak_planks')); assert.strictEqual(S.loadDoc(dirsOf(sh), 'oak-cottage').doc.variants.length, 1)
  assert.strictEqual(fs.readdirSync(path.join(sh, 'schematic-agent', 'history')).length, 1)
  assert.match((await AG.runRequest(req({ kind: 'edit', target: { id: 'nope' } }), { sharedDir: sh, dirs: dirsOf(sh), agent, now: () => T0 })).error, /no schematic "nope"/)
  assert.match((await AG.runRequest(req({ kind: 'edit', target: { id: 'oak-cottage', variant: 'zzz' } }), { sharedDir: sh, dirs: dirsOf(sh), agent, now: () => T0 })).error, /no variant "zzz"/)
})
test('failures are reported, nothing is saved: the model call fails, or the model builds nothing', async () => {
  const sh = shared()
  const f = await AG.runRequest(req(), { sharedDir: sh, dirs: dirsOf(sh), agent: async () => ({ ok: false, error: 'timed out after 25 min', costUsd: 1.2 }), now: () => T0 })
  assert.deepStrictEqual([f.ok, f.error, f.costUsd], [false, 'timed out after 25 min', 1.2])
  const e = await AG.runRequest(req(), { sharedDir: sh, dirs: dirsOf(sh), agent: async (o) => { await o.tools.find(t => t.name === 'start_workspace').handler({ width: 4, height: 4, depth: 4, mode: 'functional' }); return { ok: true, data: ANSWER } }, now: () => T0 })
  assert.match(e.error, /empty/); assert.ok(!fs.existsSync(path.join(sh, 'schematics')))
  const n = await AG.runRequest(req(), { sharedDir: sh, dirs: dirsOf(sh), agent: async () => ({ ok: true, data: ANSWER }), now: () => T0 })
  assert.match(n.error, /without building anything/)
})
test('tools: the workspace must be started once; peek and catalog read the catalog; the list of tools is only the workspace tools', async () => {
  const sh = shared(); let tools
  await AG.runRequest(req(), { sharedDir: sh, dirs: dirsOf(sh), now: () => T0, agent: async (o) => {
    tools = o.tools; const call = (n, a) => o.tools.find(t => t.name === n).handler(a)
    assert.match(await call('fill', { from: [0, 0, 0], to: [1, 1, 1], block: 'stone' }), /call start_workspace first/)
    assert.match(await call('start_workspace', { width: 5000, height: 2, depth: 2, mode: 'aesthetic' }), /ERROR.*longer than/)
    await call('start_workspace', { width: 4, height: 4, depth: 4, mode: 'aesthetic' }); assert.match(await call('start_workspace', { width: 4, height: 4, depth: 4, mode: 'aesthetic' }), /already open/)
    assert.match(await call('list_catalog', { query: 'hut' }), /starter-hut: .*variants: main 13x10x11/); assert.match(await call('list_catalog', { query: 'zzzz' }), /nothing matches/)
    assert.match(await call('peek_schematic', { id: 'starter-hut', axis: 'y', index: 1 }), /Starter hut \(a design\) \(Main\), 13 x 10 x 11[\s\S]*oak_log/); assert.match(await call('peek_schematic', { id: 'nope', axis: 'y', index: 0 }), /no schematic/)
    await call('set_blocks', { blocks: [{ x: 0, y: 0, z: 0, block: 'stone' }] })
    return { ok: true, data: ANSWER }
  } })
  assert.deepStrictEqual(tools.map(t => t.name).sort(), ['copy_region', 'fill', 'grow', 'list_catalog', 'mark_scenery', 'peek_schematic', 'replace_blocks', 'set_blocks', 'shape', 'start_workspace', 'summary', 'view_slice'])
})

// ---- the queue and the bots' daily cap
test('bot requests: counted per day, capped (25 by default), only new or variant, waiting ones limited, a cancelled one is given back, a new day starts at zero', () => {
  const sh = shared(), ask = (o = {}, t = T0) => AS.create(sh, { source: 'bot', by: 'OzoGo444', prompt: 'a lit storage room next to the shaft', ...o }, t)
  assert.strictEqual(AS.readConfig(sh).botDailyCap, 25); assert.strictEqual(AS.readConfig(sh).botModel, 'claude-opus-5-5'); assert.strictEqual(AS.readConfig(sh).botEffort, 'medium')
  assert.match(ask({ kind: 'edit', target: { id: 'x' } }).why, /new schematic or a new variant/); assert.match(ask({ prompt: 'hi' }).why, /say what you want/); assert.match(ask({ kind: 'variant' }).why, /needs the schematic/)
  AS.writeConfig(sh, { botMaxPending: 50 })
  let last
  for (let i = 0; i < 25; i++) { last = ask({ prompt: 'storage room number ' + i }); assert.ok(last.ok, last.why) }
  assert.deepStrictEqual([last.quota.used, last.quota.cap, last.quota.remaining], [25, 25, 0])
  const over = ask(); assert.strictEqual(over.ok, false); assert.match(over.why, /used up for today \(25 of 25\)/)
  // cancelled before it ran: the call comes back
  const r = AS.list(sh, { limit: 1 })[0]; AS.refund(sh, r, T0)
  assert.strictEqual(AS.quota(sh, T0).used, 24); assert.strictEqual(AS.quota(sh, T0).byBot.OzoGo444, 24); assert.strictEqual(ask({ prompt: 'one more storage room please' }).ok, true)
  assert.strictEqual(ask({ prompt: 'and another storage room' }).ok, false)
  assert.strictEqual(ask({ prompt: 'tomorrow a storage room' }, T0 + 24 * 3600 * 1000).ok, true, 'tomorrow is a new day')
  assert.strictEqual(AS.quota(sh, T0 + 24 * 3600 * 1000).used, 1)
})
test('bot requests: at most botMaxPending wait at once; a person is never limited; model and effort of a bot come from the settings, a person chooses', () => {
  const sh = shared()
  for (let i = 0; i < 3; i++) assert.ok(AS.create(sh, { source: 'bot', by: 'Smeo444', prompt: 'something useful number ' + i, model: 'claude-haiku-5-5', effort: 'low' }, T0).ok)
  const q = AS.create(sh, { source: 'bot', by: 'Smeo444', prompt: 'one more of those please' }, T0); assert.match(q.why, /3 schematic requests from the bots are already waiting/)
  const p = AS.create(sh, { source: 'user', by: 'Walter', prompt: 'a lighthouse on a cliff' }, T0); assert.ok(p.ok); assert.deepStrictEqual([p.request.model, p.request.effort], ['claude-opus-5-5', 'medium'], 'the form default is Opus 5.5, Medium')
  assert.strictEqual(AS.list(sh).find(r => r.source === 'bot').model, 'claude-opus-5-5', 'a bot cannot pick a bigger or other model than the settings say')
  const u = AS.create(sh, { source: 'user', prompt: 'a lighthouse on a cliff', model: 'claude-haiku-5-5', effort: 'xhigh' }, T0).request; assert.deepStrictEqual([u.model, u.effort], ['claude-haiku-5-5', 'xhigh'])
  const bad = AS.create(sh, { source: 'user', prompt: 'a lighthouse on a cliff', model: 'rm -rf', effort: 'ultra' }, T0).request; assert.deepStrictEqual([bad.model, bad.effort], ['claude-opus-5-5', 'medium'], 'nonsense falls back to the defaults')
  assert.strictEqual(AS.quota(sh, T0).used, 3, 'people do not use the bots\' quota')
})
test('settings are clamped and persisted; claimNext takes the oldest queued one; a dead runner\'s request is failed, a live one\'s is left', () => {
  const sh = shared()
  assert.strictEqual(AS.writeConfig(sh, { botDailyCap: 5000, botModel: 'claude-sonnet-5-5', botEffort: 'high' }).botDailyCap, 1000); assert.strictEqual(AS.readConfig(sh).botModel, 'claude-sonnet-5-5')
  assert.strictEqual(AS.writeConfig(sh, { botDailyCap: -3, botEffort: 'nope' }).botDailyCap, 0); assert.strictEqual(AS.readConfig(sh).botEffort, 'high')
  const a = AS.create(sh, { source: 'user', prompt: 'first thing to build' }, T0).request, b = AS.create(sh, { source: 'user', prompt: 'second thing to build' }, T0 + 5000).request
  assert.strictEqual(AS.claimNext(sh, 'x', T0 + 9000).id, a.id); assert.strictEqual(AS.claimNext(sh, 'x', T0 + 9000).id, b.id); assert.strictEqual(AS.claimNext(sh, 'x', T0 + 9000), null)
  AS.update(sh, a.id, { pid: 999999999 }); AS.update(sh, b.id, { pid: process.ppid })
  assert.strictEqual(AS.failStale(sh, T0 + 10000), 1, 'the one whose process is gone'); assert.strictEqual(AS.get(sh, a.id).status, 'failed'); assert.strictEqual(AS.get(sh, b.id).status, 'running', 'one held by another live process is left')
})

// ---- the runner in the dashboard
const until = async (f, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await new Promise(r => setTimeout(r, 10)) } throw new Error('timed out waiting') }
test('the dashboard service: a request from the page runs, shows its progress and result, and a finished one drops the caches', async () => {
  const sh = shared(); let changes = 0
  const svc = createService({ sharedDir: sh, dirs: () => dirsOf(sh), agent: async (o) => { const r = await cottage()(o); o.onCall({ tool: 'mcp__schem__fill' }); return r }, onChange: () => changes++, now: () => T0 })
  const bad = svc.create({ prompt: 'x' }); assert.strictEqual(bad.ok, false)
  assert.strictEqual(svc.create({ prompt: 'hut but in spruce', kind: 'variant', target: { id: 'missing' } }).ok, false)
  const r = svc.create({ prompt: 'a small oak cottage with a garden', model: 'claude-sonnet-5-5', effort: 'high' }); assert.ok(r.ok, r.why)
  const done = await until(() => { const x = svc.get(r.request.id); return x.status === 'done' && x })
  assert.strictEqual(done.result.schematicId, 'oak-cottage'); assert.strictEqual(done.model, 'claude-sonnet-5-5'); assert.strictEqual(done.costUsd, 0.4); assert.ok(done.calls >= 1)
  const info = svc.info(); assert.strictEqual(info.available, true); assert.deepStrictEqual(info.defaults, { model: 'claude-opus-5-5', effort: 'medium' }); assert.strictEqual(info.quota.cap, 25); assert.strictEqual(info.requests[0].id, r.request.id)
  assert.ok(info.models.some(m => m.id === 'claude-opus-5-5') && info.efforts.includes('medium')); assert.ok(changes >= 2)
  svc.stop()
})
test('the dashboard service: a failed run says why; cancelling a queued bot request gives its call back; cancelling a running one stops it', async () => {
  const sh = shared()
  let release
  const svc = createService({ sharedDir: sh, dirs: () => dirsOf(sh), now: () => T0, agent: async (o) => {
    if (/never finishes/.test(o.prompt)) return new Promise((res) => o.signal.addEventListener('abort', () => res({ ok: false, error: 'cancelled', cancelled: true }), { once: true }))
    if (/fails/.test(o.prompt)) return { ok: false, error: 'the Claude login has expired (run `claude` once to log in)', costUsd: 0 }
    await new Promise(r => { release = r }); return cottage()(o)
  } })
  const hold = svc.create({ prompt: 'this one waits for a while' }); await until(() => svc.get(hold.request.id).status === 'running')
  const bot = AS.create(sh, { source: 'bot', by: 'OzoGo444', prompt: 'a bot request that is queued' }, T0); assert.ok(bot.ok)
  assert.strictEqual(AS.quota(sh, T0).used, 1); assert.deepStrictEqual(svc.cancel(bot.request.id), { ok: true }); assert.strictEqual(AS.quota(sh, T0).used, 0); assert.strictEqual(svc.get(bot.request.id).status, 'cancelled')
  release(); await until(() => svc.get(hold.request.id).status === 'done')
  const f = svc.create({ prompt: 'this one fails to start' }); const ff = await until(() => { const x = svc.get(f.request.id); return x.status === 'failed' && x }); assert.match(ff.error, /login has expired/)
  const n = svc.create({ prompt: 'this never finishes at all' }); await until(() => svc.get(n.request.id).status === 'running')
  assert.strictEqual(svc.cancel(n.request.id).ok, true); const nn = await until(() => { const x = svc.get(n.request.id); return x.status === 'cancelled' && x }); assert.strictEqual(nn.error, 'cancelled')
  assert.strictEqual(svc.cancel('nope').ok, false); assert.strictEqual(svc.cancel(hold.request.id).ok, false, 'a finished one cannot be cancelled')
  assert.strictEqual(svc.setConfig({ botDailyCap: 10 }).botDailyCap, 10); assert.strictEqual(svc.info().quota.cap, 10)
  svc.stop()
})
test('the dashboard service without the Agent SDK says so and queues nothing', () => {
  const sh = shared()
  const svc = createService({ sharedDir: sh, dirs: () => dirsOf(sh), agent: null })
  // (the reviewer package is next to the dashboard in the repo, so force the unavailable case through a missing path)
  if (svc.available()) return
  assert.match(svc.create({ prompt: 'a lighthouse on a cliff' }).why, /reviewer package/)
})

// ---- what a bot can do
test('bot module: request / requests / agentQuota, the journal, and a request for a variant of a schematic that does not exist', () => {
  const dir = shared(), env = process.env.BOT_SHARED; process.env.BOT_SHARED = path.join(dir, 'bot-shared'); fs.mkdirSync(process.env.BOT_SHARED, { recursive: true })
  const added = []
  const bot = { username: 'OzoGo444', _journal: { add: (k, f) => added.push([k, f.ev]) }, world: { getColumn: () => null }, blockAt: () => null }
  const h = register({ bot, now: () => T0, log() {}, statePath: (f) => path.join(dir, 'state', f), registryFile: path.join(dir, 'registry.json') })
  const r = bot._schematic.request({ prompt: 'a small lit storage room by the shaft, six chests' })
  assert.ok(r.ok, r.why); assert.deepStrictEqual([r.quota.used, r.quota.cap], [1, 25]); assert.deepStrictEqual(added, [['schematic', 'request']])
  const list = bot._schematic.requests(); assert.strictEqual(list.length, 1); assert.deepStrictEqual([list[0].status, list[0].id], ['queued', r.id])
  assert.match(bot._schematic.request({ prompt: 'the same room but smaller', kind: 'variant', target: { id: 'no-such' } }).why, /no schematic "no-such"/)
  assert.strictEqual(bot._schematic.request({ prompt: 'the hut, built in spruce', kind: 'variant', target: { id: 'starter-hut' } }).ok, true)
  assert.match(bot._schematic.request({ prompt: 'x' }).why, /say what you want/)
  assert.strictEqual(bot._schematic.agentQuota().used, 2)
  const other = { username: 'Smeo444', _journal: null }; assert.strictEqual(AS.list(process.env.BOT_SHARED).filter(x => x.by === other.username).length, 0, 'each bot sees its own requests')
  h.stop(); if (env == null) delete process.env.BOT_SHARED; else process.env.BOT_SHARED = env
})
test('a job can follow a variant of a schematic (variant is kept on the job and the room)', () => {
  const sh = shared(), hut = D.starterHut()
  S.save(path.join(sh, 'schematics'), hut)
  const base = S.loadDoc(dirsOf(sh), hut.id).doc
  S.saveDoc(path.join(sh, 'schematics'), V.withVariant(base, { ...hut, size: [3, 3, 3], rle: [0, 27], palette: [{ role: 'any' }], counts: { 0: 27 } }, { name: 'Tiny' }).doc)
  const LP = require('../brain/schematic/loop')
  const c = LP.choose({ id: hut.id, variant: 'tiny', dirs: dirsOf(sh), explicit: true })
  assert.strictEqual(c.schematic.variant, 'tiny'); assert.strictEqual(LP.choose({ id: hut.id, variant: 'nope', dirs: dirsOf(sh), explicit: true }).ok, false)
})
