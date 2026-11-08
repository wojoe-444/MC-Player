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
