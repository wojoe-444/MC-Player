// The loop's own review (lib/audit.js): facts and hard rules by code, one model call with no tools, a report even when the model fails.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'), os = require('os'), path = require('path')
const audit = require('../lib/audit')
const runs = require('../lib/runs')

const NOW = Date.parse('2026-11-11T16:00:00Z')
const iso = (minAgo) => new Date(NOW - minAgo * 60000).toISOString()
const MODS = ['mineflayer', 'mineflayer-pathfinder', 'ajv', 'prismarine-nbt']
function rig({ journalMinAgo = 3, modules = true, openAgeH = 30 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'))
  const bot = path.join(root, 'ozo'), code = path.join(root, 'code'), loopDir = path.join(root, 'loop')
  fs.mkdirSync(path.join(bot, 'brain', 'state', 'journal'), { recursive: true })
  const jf = path.join(bot, 'brain', 'state', 'journal', '2026-11-11.jsonl')
  fs.writeFileSync(jf, [1, 2, 3, 4].map(i => JSON.stringify({ at: iso(60 - i), k: 'brief', ask: `question ${i} about tool-kit` })).join('\n') + '\n')
  fs.utimesSync(jf, new Date(NOW - journalMinAgo * 60000), new Date(NOW - journalMinAgo * 60000))
  if (modules) for (const m of MODS) fs.mkdirSync(path.join(code, 'node_modules', m), { recursive: true })
  else fs.mkdirSync(code, { recursive: true })
  const cfg = { bots: [{ id: 'ozo', name: 'OzoGo444', dir: bot }], loopDir, codeDir: code, outDir: path.join(root, 'out') }
  fs.mkdirSync(path.join(loopDir, 'work-orders'), { recursive: true })
  fs.writeFileSync(path.join(loopDir, 'work-orders', 'step-iron.json'), JSON.stringify({ v: 1, key: 'step-iron', status: 'open', title: 'iron', costMin: 20, openedAt: iso(openAgeH * 60), seenDreams: 5, bots: {}, history: [] }))
  for (const job of ['review', 'dream']) runs.append(cfg, job, { ok: true, summary: 'fine' }, NOW - 5 * 60000)
  return cfg
}
const none = { review: { installed: true }, dream: { installed: true }, deploy: { installed: false }, fix: { installed: false }, digest: { installed: false }, audit: { installed: true } }
const all = { ...none, deploy: { installed: true }, fix: { installed: true }, digest: { installed: true } }

test('rules: jobs not installed, a silent bot, unanswered questions and orders nothing acts on are named; the worst decides the verdict', () => {
  const rs = audit.rules(audit.gather(rig({ journalMinAgo: 400 }), NOW, none))
  const has = (stage, status) => rs.some(r => r.stage === stage && r.status === status)
  assert.ok(has('fix', 'broken') && has('deploy', 'broken') && has('digest', 'broken'), 'uninstalled jobs are broken')
  assert.ok(has('bot OzoGo444', 'broken'), 'a bot silent for hours is broken')
  assert.ok(has('asks OzoGo444', 'warn'))
  assert.ok(has('orders', 'broken'), 'an order open 30 h with no PR, fix or close')
  assert.strictEqual(audit.worst(rs), 'broken')
})

test('rules: a loop with every job running is not broken; missing modules in the live clone are', () => {
  const cfg = rig({ openAgeH: 2 })
  for (const j of ['deploy', 'fix', 'digest']) runs.append(cfg, j, { ok: true, summary: 'fine' }, NOW - 5 * 60000)
  fs.mkdirSync(path.join(cfg.loopDir, 'digest'), { recursive: true }); fs.writeFileSync(path.join(cfg.loopDir, 'digest', '2026-11-11.md'), 'x')
  const rs = audit.rules(audit.gather(cfg, NOW, all))
  assert.ok(!rs.some(r => r.status === 'broken'), JSON.stringify(rs.filter(r => r.status === 'broken')))
  assert.ok(audit.rules(audit.gather(rig({ modules: false }), NOW, none)).some(r => r.stage === 'node_modules' && r.status === 'broken'))
})

test('runAudit: one model call with facts and rules, report and latest.json written, the model cannot call it healthier than the rules', async () => {
  const cfg = rig({ journalMinAgo: 400 }); let seen = null
  const ask = async (o) => { seen = o; return { ok: true, costUsd: 0.1, data: { verdict: 'healthy', summary: 'All fine.', stages: [{ stage: 'fix', status: 'broken', finding: 'not installed' }], needsWalter: ['Install the fixer'], tweaks: ['Restart bots when offline'] } } }
  const r = await audit.runAudit(cfg, { ask, now: NOW, task: none })
  assert.strictEqual(seen.model, 'claude-sonnet-5-5'); assert.strictEqual(seen.effort, 'high'); assert.match(seen.prompt, /hard rules applied by code/)
  assert.strictEqual(r.verdict, 'broken', 'the floor from the rules wins over a rosier model')
  const latest = audit.latest(cfg.loopDir)
  assert.deepStrictEqual([latest.verdict, latest.needsWalter, latest.tweaks], ['broken', ['Install the fixer'], ['Restart bots when offline']])
  assert.ok(fs.readdirSync(path.join(cfg.loopDir, 'audit')).some(f => f.endsWith('.md')))
  assert.strictEqual(runs.read(cfg, { jobs: ['audit'] }).length, 1)
})

test('runAudit: a failed model call still writes the rules as the report; a dry run calls nothing and writes nothing', async () => {
  const cfg = rig({ journalMinAgo: 400 })
  const d = await audit.runAudit(cfg, { ask: async () => { throw new Error('should not be called') }, now: NOW, task: none, dryRun: true })
  assert.ok(d.dryRun && d.prompt.includes('bot OzoGo444') && !fs.existsSync(path.join(cfg.loopDir, 'audit')))
  const r = await audit.runAudit(cfg, { ask: async () => ({ ok: false, error: 'login expired' }), now: NOW, task: none })
  assert.strictEqual(r.ok, false); assert.strictEqual(r.verdict, 'broken')
  const latest = audit.latest(cfg.loopDir); assert.match(latest.modelError, /login expired/); assert.ok(latest.needsWalter.length)
})

test('digest: the audit verdict leads the page when there is one', () => {
  const { buildDigest } = require('../lib/digest')
  const t = buildDigest({ now: NOW, audit: { verdict: 'degraded', summary: 'Fixer idle.', needsWalter: ['Install the fixer'] } })
  assert.match(t, /## Loop health: degraded/); assert.match(t, /Needs you: Install the fixer/)
  assert.doesNotMatch(buildDigest({ now: NOW }), /Loop health/)
})
