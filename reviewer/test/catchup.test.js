// Walter 2026-11-11, after the first audit: the fixer works until it is caught up; a red suite on main is an order; a skipped run says why; bots stop re-asking.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'), os = require('os'), path = require('path')
const runs = require('../lib/runs')
const orders = require('../lib/orders')
const fixer = require('../lib/fixer')
const { runDeploy } = require('../lib/deploy')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'catchup-'))
const cfgOf = () => { const root = tmp(); return { loopDir: path.join(root, 'loop'), codeDir: root, bots: [], outDir: root } }

test('runs.skip: a streak of the same reason is one row that counts up; a new reason starts a new row; real runs are untouched', () => {
  const cfg = cfgOf(), t = Date.parse('2026-11-11T10:00:00Z')
  runs.append(cfg, 'review', { ok: true, summary: 'reviewed both' }, t)
  for (let i = 0; i < 5; i++) runs.skip(cfg, 'review', 'all bots offline', t + (i + 1) * 600000)
  runs.skip(cfg, 'review', 'nothing changed', t + 9 * 600000)
  const rows = runs.read(cfg, { jobs: ['review'], limit: 10 }).reverse()
  assert.strictEqual(rows.length, 3)
  assert.strictEqual(rows[1].skipped, 'all bots offline'); assert.strictEqual(rows[1].n, 5)
  assert.match(rows[1].summary, /skipped: all bots offline \(5 times since 10:10Z\)/)
  assert.strictEqual(rows[1].at, new Date(t + 5 * 600000).toISOString(), 'the row shows when it last fired')
  assert.strictEqual(rows[2].skipped, 'nothing changed')
  assert.strictEqual(rows[0].summary, 'reviewed both')
})

test('runFixUntilCaughtUp: takes order after order until none is left, then says it is caught up', async () => {
  const seq = [{ ok: true, order: 'a', outcome: 'fixed', pr: 11 }, { ok: true, order: 'b', outcome: 'no-fix' }, { ok: true, order: 'c', outcome: 'fixed', pr: 12 }, { ok: true, skipped: true, summary: 'no open work order to take' }]
  let n = 0
  const r = await fixer.runFixUntilCaughtUp({}, { fix: async () => seq[n++] })
  assert.deepStrictEqual([r.ok, r.orders, r.prs, r.caughtUp, n], [true, ['a', 'b', 'c'], [11, 12], true, 4])
  assert.match(r.summary, /3 order\(s\): a fixed #11; b no-fix; c fixed #12; caught up/)
})

test('runFixUntilCaughtUp: stops at a break that is not the order\'s, at the lock, and at the cap', async () => {
  let n = 0
  let r = await fixer.runFixUntilCaughtUp({}, { fix: async () => (++n === 2 ? { ok: false, order: 'x', outcome: 'error', summary: 'x: the session failed' } : { ok: true, order: 'o' + n, outcome: 'fixed', pr: n }) })
  assert.deepStrictEqual([r.ok, n, r.caughtUp], [false, 2, false])
  n = 0; r = await fixer.runFixUntilCaughtUp({}, { fix: async () => { n++; return { ok: true, skipped: 'another fixer run is going' } } })
  assert.deepStrictEqual([n, r.skipped, r.caughtUp], [1, 'another fixer run is going', false])
  n = 0; r = await fixer.runFixUntilCaughtUp({}, { fix: async () => ({ ok: true, order: 'o' + ++n, outcome: 'fixed', pr: n }) }, { maxOrders: 3 })
  assert.strictEqual(n, 3)
  n = 0; let clock = 0
  r = await fixer.runFixUntilCaughtUp({}, { now: () => (clock += 3600000), fix: async () => ({ ok: true, order: 'o' + ++n, outcome: 'fixed', pr: n }) }, { budgetMs: 2 * 3600000 })
  assert.ok(n < 6, 'the time budget ends the run')
  n = 0; r = await fixer.runFixUntilCaughtUp({}, { only: 'k', fix: async () => ({ ok: true, order: 'k', outcome: 'fixed', pr: 1 }) })
  assert.strictEqual(r.orders.length, 1)
})

test('a red suite on main becomes the most costly order, written by code, and the next deploy that gets through closes it', async () => {
  const cfg = cfgOf(); fs.mkdirSync(cfg.loopDir, { recursive: true })
  const now = Date.now()
  const red = { judge: () => ({ result: 'none' }), deploy: () => ({ result: 'red', steps: ['candidate abc: 2 file(s) changed, needs: restart', 'tests FAILED, not deploying: ✖ test\\nav.waypoints.test.js 1 failed'] }) }
  const r = await runDeploy(cfg, { tool: red, now })
  assert.strictEqual(r.ok, false)
  const o = orders.load(cfg.loopDir, 'main-tests-red')
  assert.ok(o && o.status === 'open' && o.kind === 'bug' && o.type === 'ci')
  assert.match(o.title, /red on main/); assert.match(o.problem, /nav\.waypoints\.test\.js/); assert.match(o.line || o.bots.main.line, /nav\.waypoints/)
  assert.ok(o.costMin >= 3000, 'above every other order: nothing ships while it stands')
  // the fixer takes it first
  fs.mkdirSync(path.join(cfg.loopDir, 'work-orders'), { recursive: true })
  fs.writeFileSync(path.join(cfg.loopDir, 'work-orders', 'step-iron.json'), JSON.stringify({ v: 1, key: 'step-iron', type: 'step', status: 'open', title: 'iron', costMin: 900, bots: {}, history: [] }))
  assert.strictEqual(fixer.pick(orders.list(cfg.loopDir)).key, 'main-tests-red')
  // a second red run does not open a second order
  await runDeploy(cfg, { tool: red, now: now + 1000 })
  assert.strictEqual(orders.list(cfg.loopDir).filter(x => x.key === 'main-tests-red').length, 1)
  const green = { judge: () => ({ result: 'none' }), deploy: () => ({ result: 'deployed', from: 'a', to: 'b', action: 'reload' }) }
  await runDeploy(cfg, { tool: green, now: now + 2000, prs: () => [] })
  const after = orders.load(cfg.loopDir, 'main-tests-red')
  assert.strictEqual(after.status, 'closed'); assert.match(after.closed.reason, /green on main/)
})
