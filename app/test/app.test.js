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
