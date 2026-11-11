const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { Config } = require('../lib/config')
const { TriggerManager } = require('../lib/triggers')
const { createReviewTrigger, listReviews, buildPrompt, collectBotEvidence, tailText } = require('../lib/review')
const { runClaude } = require('../lib/claude')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcapp-'))

test('config: defaults, overrides merge, dotted set persists', () => {
  const dir = tmp(), file = path.join(dir, 'config.json')
  fs.writeFileSync(file, JSON.stringify({ claude: { model: 'sonnet' }, triggers: { review: { intervalMin: 9 } } }))
  const c = new Config(file, 'HOME')
  assert.strictEqual(c.data.claude.model, 'sonnet')
  assert.strictEqual(c.data.claude.command, 'claude')
  assert.deepStrictEqual(c.data.triggers.review, { enabled: true, intervalMin: 9 })
  assert.ok(c.data.dashboard.ozoDir.endsWith('Minecraft-Survival'))
  c.set('triggers.review.enabled', false)
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).triggers.review.enabled, false)
})

test('trigger manager: runs, skips overlap, honors enabled', async () => {
  const cfg = { data: { triggers: { a: { enabled: true, intervalMin: 5 } } }, set(k, v) { const [, id, f] = k.split('.'); (this.data.triggers[id] ||= {})[f] = v } }
  let runs = 0, release
  const m = new TriggerManager(cfg, {}, { firstRunDelayMs: 1e9 })
  m.register({ id: 'a', title: 'A', run: () => { runs++; return new Promise(r => { release = () => r({ ok: true, summary: 'done' }) }) } })
  const p1 = m.runNow('a'); const p2 = m.runNow('a')
  assert.strictEqual(runs, 1)
  assert.strictEqual(m.list()[0].running, true)
  release(); await p1; await p2
  assert.strictEqual(m.list()[0].lastResult.summary, 'done')
  assert.ok(m.list()[0].nextRun)
  m.setSettings('a', { enabled: false })
  assert.strictEqual(m.list()[0].nextRun, null)
  m.stop()
})

function fakeBots() {
  const root = tmp()
  const mk = (n, idle) => { const d = path.join(root, n); fs.mkdirSync(path.join(d, 'brain', 'state'), { recursive: true }); fs.writeFileSync(path.join(d, 'idle.log'), idle); return d }
  return { root, ozo: mk('ozo', 'line1\nline2\nline3\n'), smeo: mk('smeo', 'x\n') }
}

test('review: builds prompt from logs, writes file, skips when nothing changed', async () => {
  const b = fakeBots(), reviewsDir = path.join(b.root, 'reviews')
  const cfg = { dashboard: { ozoDir: b.ozo, smeoDir: b.smeo }, claude: { command: 'claude', model: 'haiku', timeoutMs: 1000 } }
  const prompts = []
  const t = createReviewTrigger({ reviewsDir, getConfig: () => cfg, run: async (o) => { prompts.push(o); return { ok: true, text: 'All fine.\nmore', durationMs: 5 } } })
  const r1 = await t.run()
  assert.ok(r1.ok && !r1.skipped)
  assert.match(prompts[0].prompt, /OzoGo444/)
  assert.match(prompts[0].prompt, /line3/)
  assert.deepStrictEqual(prompts[0].addDirs, [b.ozo, b.smeo])
  assert.strictEqual(listReviews(reviewsDir)[0].text.trim(), 'All fine.\nmore')
  const r2 = await t.run()
  assert.ok(r2.skipped); assert.strictEqual(prompts.length, 1)
  fs.appendFileSync(path.join(b.ozo, 'idle.log'), 'new activity\n')
  const r3 = await t.run()
  assert.ok(!r3.skipped); assert.strictEqual(prompts.length, 2)
})

test('review: failures are reported and retried; missing folders handled', async () => {
  const b = fakeBots()
  const cfg = { dashboard: { ozoDir: b.ozo, smeoDir: b.smeo }, claude: {} }
  let n = 0
  const t = createReviewTrigger({ reviewsDir: path.join(b.root, 'r'), getConfig: () => cfg, run: async () => (n++ ? { ok: true, text: 'ok' } : { ok: false, error: 'boom' }) })
  assert.deepStrictEqual([(await t.run()).ok, (await t.run()).ok], [false, true])
  const none = createReviewTrigger({ reviewsDir: b.root, getConfig: () => ({ dashboard: { ozoDir: '/nope1', smeoDir: '/nope2' }, claude: {} }), run: async () => assert.fail('should not run') })
  assert.strictEqual((await none.run()).ok, false)
  assert.match(buildPrompt([collectBotEvidence({ id: 'x', name: 'X', dir: '/nope' })]), /bot folder not found/)
})

test('tailText drops the cut-off first line', () => {
  const f = path.join(tmp(), 'f.log'); fs.writeFileSync(f, 'aaaaaaaa\nbbbb\ncccc\n')
  assert.strictEqual(tailText(f, 12), 'bbbb\ncccc')
})

function fakeSpawn(stdout, code = 0, err) {
  return () => {
    const c = new EventEmitter()
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {}
    c.stdin = Object.assign(new EventEmitter(), { end(p) { c.prompt = p; setImmediate(() => { c.stdout.emit('data', stdout); c.emit('close', code) }) } })
    if (err) setImmediate(() => c.emit('error', err))
    return c
  }
}

test('runClaude: parses json result, reports errors, handles missing CLI', async () => {
  const ok = await runClaude({ prompt: 'hi', spawnFn: fakeSpawn(JSON.stringify({ result: ' hello ', total_cost_usd: 0 })) })
  assert.deepStrictEqual([ok.ok, ok.text], [true, 'hello'])
  const bad = await runClaude({ prompt: 'hi', spawnFn: fakeSpawn(JSON.stringify({ result: 'Not logged in', is_error: true }), 1) })
  assert.deepStrictEqual([bad.ok, bad.error], [false, 'Not logged in'])
  const missing = await runClaude({ prompt: 'hi', spawnFn: () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = Object.assign(new EventEmitter(), { end() {} }); setImmediate(() => c.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' }))); return c } })
  assert.match(missing.error, /not found/)
})

// ---- updater ----
const { UpdateManager, friendlyError } = require('../lib/updater')
function fakeAutoUpdater(opts = {}) {
  const au = new EventEmitter()
  au.calls = []
  au.checkForUpdates = async () => { au.calls.push('check'); if (opts.checkError) { const e = new Error(opts.checkError); au.emit('error', e); throw e } au.emit('checking-for-update'); au.emit(opts.latest ? 'update-available' : 'update-not-available', { version: opts.latest || '0.1.0', releaseNotes: opts.notes }) }
  au.downloadUpdate = async () => { au.calls.push('download'); if (opts.downloadError) throw new Error(opts.downloadError); au.emit('download-progress', { percent: 42.4 }); au.emit('update-downloaded', {}) }
  au.quitAndInstall = (...a) => au.calls.push('install:' + a.join(','))
  return au
}

test('updater: not packaged reports unsupported and never touches electron-updater', async () => {
  const au = fakeAutoUpdater({ latest: '0.2.0' })
  const u = new UpdateManager({ autoUpdater: au, currentVersion: '0.1.0', isPackaged: false })
  assert.strictEqual(u.state().status, 'unsupported')
  await u.check(); await u.install()
  assert.deepStrictEqual(au.calls, [])
})

test('updater: up to date', async () => {
  const au = fakeAutoUpdater()
  const u = new UpdateManager({ autoUpdater: au, currentVersion: '0.1.0', isPackaged: true })
  assert.strictEqual(au.autoDownload, false); assert.strictEqual(au.autoInstallOnAppQuit, false)
  const s = await u.check()
  assert.strictEqual(s.status, 'up-to-date'); assert.ok(s.checkedAt)
  await u.install() // nothing to install
  assert.deepStrictEqual(au.calls, ['check'])
})

test('updater: newer version is offered, then downloaded, dashboard stopped, and quitAndInstall runs once', async () => {
  const au = fakeAutoUpdater({ latest: '0.1.7', notes: '<p>Adds <b>Settings</b></p>' })
  const order = []
  const u = new UpdateManager({ autoUpdater: au, currentVersion: '0.1.0', isPackaged: true, beforeInstall: () => order.push('stop') })
  const seen = []; u.on('update', s => seen.push(s.status))
  let s = await u.check()
  assert.deepStrictEqual([s.status, s.latest, s.notes], ['available', '0.1.7', 'Adds Settings'])
  au.calls.length = 0
  au.quitAndInstall = (...a) => order.push('install:' + a.join(','))
  s = await u.install()
  assert.deepStrictEqual(order, ['stop', 'install:true,true'])
  assert.deepStrictEqual(au.calls, ['download'])
  assert.ok(seen.includes('downloading') && seen.includes('ready'))
  await u.install() // already ready: no second install
  assert.strictEqual(order.length, 2)
})

test('updater: check and download errors are reported in plain words and can be retried', async () => {
  const bad = new UpdateManager({ autoUpdater: fakeAutoUpdater({ checkError: 'HttpError: 404 Not Found\n{big json}' }), currentVersion: '0.1.0', isPackaged: true })
  const s = await bad.check()
  assert.strictEqual(s.status, 'error'); assert.match(s.error, /No published update/)
  assert.match(friendlyError(new Error('getaddrinfo ENOTFOUND github.com')), /Could not reach GitHub/)

  const o = { latest: '0.1.2', downloadError: 'disk full' }
  const au = fakeAutoUpdater(o)
  const u = new UpdateManager({ autoUpdater: au, currentVersion: '0.1.0', isPackaged: true, beforeInstall: () => assert.fail('must not stop the dashboard when the download failed') })
  await u.check()
  const r = await u.install()
  assert.deepStrictEqual([r.status, r.error, r.latest], ['error', 'disk full', '0.1.2'])
  assert.ok(!au.calls.some(c => c.startsWith('install')))
  o.downloadError = null
  await u.install() // retry from the error state
  assert.ok(au.calls.includes('install:true,true'))
})

// ---- local control endpoint ----
const http = require('http')
const { startControlServer } = require('../lib/control')

function req(port, route, { method = 'GET', headers = {}, token, host } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers }
    if (token) h.Authorization = 'Bearer ' + token
    if (host) h.Host = host
    const r = http.request({ host: '127.0.0.1', port, path: route, method, headers: h }, (res) => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ code: res.statusCode, body: b ? JSON.parse(b) : null }))
    })
    r.on('error', reject); r.end()
  })
}

test('control endpoint: token, host and origin checks; check/apply drive the update manager; token persists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-'))
  const pointer = path.join(dir, 'ptr', 'app-control.json')
  const au = fakeAutoUpdater({ latest: '0.1.9' })
  const order = []
  au.quitAndInstall = (...a) => order.push('install')
  const u = new UpdateManager({ autoUpdater: au, currentVersion: '0.1.1', isPackaged: true, beforeInstall: () => order.push('stop') })
  const c = await startControlServer({ updates: u, info: () => ({ version: '0.1.1', packaged: true }), dataDir: dir, port: 0, pointerFile: pointer })
  try {
    assert.ok(c.token.length >= 32)
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(pointer, 'utf8')).token, c.token)
    assert.strictEqual((await req(c.port, '/v1/status')).code, 401)
    assert.strictEqual((await req(c.port, '/v1/status', { token: 'wrong' })).code, 401)
    assert.strictEqual((await req(c.port, '/v1/status', { token: c.token, headers: { Origin: 'http://evil.example' } })).code, 403)
    assert.strictEqual((await req(c.port, '/v1/status', { token: c.token, host: 'evil.example' })).code, 403)
    assert.strictEqual((await req(c.port, '/v1/nope', { token: c.token })).code, 404)
    assert.strictEqual((await req(c.port, '/v1/update/apply', { token: c.token })).code, 404) // POST only

    let r = await req(c.port, '/v1/status', { token: c.token })
    assert.deepStrictEqual([r.code, r.body.app.version, r.body.update.status], [200, '0.1.1', 'idle'])
    r = await req(c.port, '/v1/update/check', { method: 'POST', token: c.token })
    assert.deepStrictEqual([r.body.update.status, r.body.update.latest], ['available', '0.1.9'])
    r = await req(c.port, '/v1/update/apply', { method: 'POST', token: c.token })
    assert.strictEqual(r.code, 200)
    await new Promise(r => setTimeout(r, 50))
    assert.deepStrictEqual(order, ['stop', 'install'])
  } finally { await c.close() }
  // same token after a restart, so a tool that read it earlier still works
  const c2 = await startControlServer({ updates: u, info: () => ({}), dataDir: dir, port: 0, pointerFile: pointer })
  assert.strictEqual(c2.token, c.token); await c2.close()
})

test('control endpoint: up to date and unsupported do nothing; port in use is not fatal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-'))
  const au = fakeAutoUpdater()
  const u = new UpdateManager({ autoUpdater: au, currentVersion: '0.1.1', isPackaged: true })
  const c = await startControlServer({ updates: u, info: () => ({}), dataDir: dir, port: 0, pointerFile: path.join(dir, 'p.json') })
  const r = await req(c.port, '/v1/update/apply', { method: 'POST', token: c.token })
  assert.strictEqual(r.body.update.status, 'up-to-date')
  assert.deepStrictEqual(au.calls, ['check'])
  const clash = await startControlServer({ updates: u, info: () => ({}), dataDir: dir, port: c.port, pointerFile: path.join(dir, 'p2.json') })
  assert.strictEqual(clash, null)
  await c.close()
  const src = new UpdateManager({ autoUpdater: null, currentVersion: '0.1.1', isPackaged: false })
  assert.strictEqual((await src.apply()).status, 'unsupported')
})

test('memory loop tab: jobs, ranked work orders, each bot\'s memory and last check, and the run log, all read from this computer', async () => {
  const { loopState, loadLib, JOB_IDS } = require('../lib/loop')
  const lib = loadLib(path.join(__dirname, '..', '..', 'reviewer'))
  assert.ok(lib && lib.schedule.JOBS.dream, 'the reviewer package is next to the app')
  assert.deepStrictEqual(await loopState({ lib: null }), { available: false })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-')), loopDir = path.join(root, 'loop'), ozo = path.join(root, 'ozo'), mem = path.join(ozo, 'brain', 'state', 'memory')
  fs.mkdirSync(path.join(mem, 'dream'), { recursive: true })
  fs.writeFileSync(path.join(mem, 'global.md'), '# Now\nSmelt iron.\n')
  fs.writeFileSync(path.join(mem, 'brief.json'), JSON.stringify({ at: '2026-11-10T22:31:00Z', day: 55, intent: 'Iron today.', focus: ['iron-smelt'], holds: [], freeTime: { choice: 'vantage', note: '' }, ask: 'A chest of my own?', until: 1 }))
  fs.writeFileSync(path.join(mem, 'dream', 'last.json'), JSON.stringify({ at: '2026-11-10T22:55:00Z', memory: { changes: [{ step: 'cut', op: 'remove', from: 'x', why: 'y', cites: [] }] }, calls: [{ step: 'cut', ok: true }], skippedSteps: { demote: 'short' }, costUsd: 0.01, dropped: [] }))
  const cand = (key, costMin) => ({ key, type: 'step', step: key, costMin, counts: {}, line: key, evidence: [] })
  lib.orders.sync(loopDir, { bot: 'ozo', cands: [cand('step-a', 3), cand('step-b', 9)], decided: { 'step-a': { isBug: true, title: 'A', problem: 'p' }, 'step-b': { isBug: true, title: 'B', problem: 'p' } }, now: Date.parse('2026-11-10T22:55:00Z') })
  lib.runs.append({ loopDir }, 'dream', { ok: true, summary: 'OzoGo444: 2 calls' }, Date.parse('2026-11-10T22:56:00Z'))
  const asked = []
  const s = await loopState({ lib, loopDir, bots: [{ id: 'ozo', name: 'OzoGo444', dir: ozo }, { id: 'smeo', name: 'Smeo444', dir: path.join(root, 'none') }], status: async (j) => { asked.push(j.name); return { installed: j.id === 'review' } }, running: { dream: true } })
  assert.strictEqual(s.available, true); assert.deepStrictEqual(asked, ['MC-Player Bot Dream', 'MC-Player Bot Deployer', 'MC-Player Bot Digest', 'MC-Player Bot Reviewer'])
  assert.deepStrictEqual(s.jobs.map(j => [j.id, j.taskName, j.minutes, j.running, j.task.installed]), [['dream', 'MC-Player Bot Dream', 120, true, false], ['deploy', 'MC-Player Bot Deployer', 30, false, false], ['digest', 'MC-Player Bot Digest', 60, false, false]])
  assert.deepStrictEqual(JOB_IDS, ['dream', 'deploy', 'digest']); assert.ok(s.jobs.every(j => j.about))
  assert.deepStrictEqual(s.code, { dir: null, isClone: false, hasDeployer: false, last: [] }); assert.strictEqual(s.digest, null)
  // with a code folder and a digest on disk
  const code = path.join(root, 'code'); fs.mkdirSync(path.join(code, '.git'), { recursive: true }); fs.mkdirSync(path.join(code, 'tools')); fs.writeFileSync(path.join(code, 'tools', 'deployer.js'), ''); fs.writeFileSync(path.join(code, 'deploys.jsonl'), JSON.stringify({ t: 1, event: 'deploy', to: 'abc' }) + '\n')
  fs.mkdirSync(path.join(loopDir, 'digest')); fs.writeFileSync(path.join(loopDir, 'digest', '2026-11-11.md'), '# digest')
  const s2 = await loopState({ lib, loopDir, codeDir: code, bots: [], status: async () => ({ installed: false }) })
  assert.deepStrictEqual([s2.code.isClone, s2.code.hasDeployer, s2.code.last[0].to], [true, true, 'abc']); assert.deepStrictEqual(s2.digest, { date: '2026-11-11', text: '# digest' })
  assert.strictEqual(s.reviewTask.task.installed, true)
  assert.deepStrictEqual(s.orders.map(o => [o.key, o.costMin, o.title]), [['step-b', 9, 'B'], ['step-a', 3, 'A']])
  assert.strictEqual(s.runs[0].summary, 'OzoGo444: 2 calls')
  assert.strictEqual(s.bots[0].memory, '# Now\nSmelt iron.\n'); assert.strictEqual(s.bots[0].brief.ask, 'A chest of my own?'); assert.strictEqual(s.bots[0].lastCheck.changes.length, 1)
  assert.deepStrictEqual([s.bots[1].memory, s.bots[1].brief, s.bots[1].lastCheck], [null, null, null])
})

test('dashboard process: only attaches to a server that serves the redesigned UI', async () => {
  const http = require('http')
  const { servesCurrentUi, startDashboard, UI_MARKER } = require('../lib/dashboard-process')
  const serve = (html) => new Promise((resolve) => { const s = http.createServer((_q, r) => r.end(html)); s.listen(0, '127.0.0.1', () => resolve(s)) })
  const fresh = await serve(`<head><meta ${UI_MARKER} content="2"></head>`)
  const old = await serve('<title>old dashboard</title>')
  const url = (s) => `http://127.0.0.1:${s.address().port}`
  try {
    assert.strictEqual(await servesCurrentUi(url(fresh)), true)
    assert.strictEqual(await servesCurrentUi(url(old)), false)
    assert.strictEqual(await servesCurrentUi('http://127.0.0.1:1'), false)
    const d = await startDashboard({ port: fresh.address().port }, { repoRoot: __dirname, log: () => {} })
    assert.deepStrictEqual([d.attached, d.url], [true, url(fresh)])
    // an older dashboard on the port: the app must not attach (it would start its own on another port, which needs the real server, so only check it tried)
    const logs = []
    await assert.rejects(startDashboard({ port: old.address().port, ozoDir: tmp(), smeoDir: tmp(), codeDir: tmp() }, { repoRoot: path.join(tmp(), 'missing'), log: (m) => logs.push(m) }), /did not start|spare port/)
    assert.ok(logs.some(m => /older version/.test(m)))
  } finally { fresh.close(); old.close() }
})
