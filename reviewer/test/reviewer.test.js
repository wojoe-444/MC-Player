const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { resolveConfig } = require('../lib/config')
const { collectBot, forModel, thinkSummary } = require('../lib/collect')
const findings = require('../lib/findings')
const { runReview } = require('../lib/review')
const { askClaude, childEnv } = require('../lib/claude')
const schedule = require('../lib/schedule')
const { SCHEMA, SYSTEM_PROMPT } = require('../lib/prompt')

const NOW = Date.parse('2026-11-10T04:00:00Z')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rev-'))
function mkBot(dir, { telemetryAgeS = 10, flags = [], idle = 'x do things\n' } = {}) {
  const sd = path.join(dir, 'brain', 'state'); fs.mkdirSync(path.join(sd, 'telemetry'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'idle.log'), idle); fs.utimesSync(path.join(dir, 'idle.log'), new Date(NOW - 1000), new Date(NOW - 1000))
  if (telemetryAgeS !== null) fs.writeFileSync(path.join(sd, 'telemetry', 'summary.json'), JSON.stringify({ updatedAt: new Date(NOW - telemetryAgeS * 1000).toISOString(), bot: 'x', last1min: { jumps: 3 }, last10min: {}, flags: flags.map(f => ({ kind: f.kind, sev: f.sev, msg: f.msg })), recent: { columns: [], rows: [[0, 1, 2, 3, 1, '', '', '']] } }))
  if (flags.length) fs.writeFileSync(path.join(sd, 'telemetry', 'flags.jsonl'), flags.map((f, i) => JSON.stringify({ id: 'a-' + i, at: new Date(NOW - 5000).toISOString(), ...f, excerpt: [[0, 1, 2, 3, 1, '', '', '']] })).join('\n') + '\n')
}
function cfgFor(root) {
  return { bots: [{ id: 'ozo', name: 'OzoGo444', dir: path.join(root, 'ozo') }, { id: 'smeo', name: 'Smeo444', dir: path.join(root, 'smeo') }], outDir: path.join(root, 'out'), model: 'claude-haiku-5-5', effort: 'xhigh', timeoutMs: 1000, staleMin: 5, args: { flags: new Set(), opts: {} } }
}

test('config: flags beat env beat the app settings beat the Downloads default; Haiku 5.5 at xhigh', () => {
  const home = path.join(tmp(), 'h')
  let c = resolveConfig({ argv: [], env: {}, home, exists: () => false })
  assert.ok(c.bots[0].dir.endsWith(path.join('Downloads', 'Minecraft-Survival')))
  assert.strictEqual(c.model, 'claude-haiku-5-5'); assert.strictEqual(c.effort, 'xhigh'); assert.strictEqual(c.minutes, 10)
  c = resolveConfig({ argv: ['--smeo', 'C:/s', '--minutes', '15'], env: { BOT_OZO_DIR: 'C:/o', BOT_SMEO_DIR: 'C:/ignored' }, home, exists: () => false })
  assert.deepStrictEqual(c.bots.map(b => b.dir), ['C:/o', 'C:/s']); assert.strictEqual(c.minutes, 15)
})

test('collect: telemetry live/stale/missing, offline when nothing is fresh, new flags only', () => {
  const root = tmp()
  mkBot(path.join(root, 'ozo'), { flags: [{ kind: 'jumping', sev: 'high', msg: '30 jumps' }] })
  let ev = collectBot({ dir: path.join(root, 'ozo') }, { now: NOW })
  assert.strictEqual(ev.telemetry, 'live'); assert.ok(ev.active); assert.strictEqual(ev.newFlagWindows.length, 1)
  ev = collectBot({ dir: path.join(root, 'ozo') }, { now: NOW, since: NOW })
  assert.strictEqual(ev.newFlagWindows.length, 0)
  mkBot(path.join(root, 'smeo'), { telemetryAgeS: 3600 })
  fs.utimesSync(path.join(root, 'smeo', 'idle.log'), new Date(NOW - 3600e3), new Date(NOW - 3600e3))
  ev = collectBot({ dir: path.join(root, 'smeo') }, { now: NOW })
  assert.strictEqual(ev.telemetry, 'stale'); assert.strictEqual(ev.active, false)
  mkBot(path.join(root, 'old'), { telemetryAgeS: null })
  ev = collectBot({ dir: path.join(root, 'old') }, { now: NOW })
  assert.strictEqual(ev.telemetry, 'missing'); assert.strictEqual(ev.active, true)    // logs are fresh: review from logs
  assert.strictEqual(collectBot({ dir: path.join(root, 'nope') }, { now: NOW }).active, false)
  assert.ok(!('signature' in forModel(ev)))
})

test('thinkSummary finds the same failing action repeated', () => {
  const step = (ok) => ({ ev: 'step', thought: 't', results: [{ a: 'goto', args: { x: 1 }, ok, note: 'no path' }] })
  const s = thinkSummary([step(false), step(false), step(false), step(true), { ev: 'model-error' }])
  assert.strictEqual(s.repeatedFailures[0].times, 3); assert.deepStrictEqual(s.byAction.goto, { ok: 1, fail: 3 }); assert.strictEqual(s.otherEvents['model-error'], 1)
})

test('findings.merge: persists, counts runs, resolves, ages out unseen, adds uncovered high detector flags', () => {
  const bot = { id: 'ozo', name: 'OzoGo444' }
  const f = (key, over) => ({ key, kind: 'excessive_jumping', severity: 'high', confidence: 'high', title: key, evidence: 'e', suggestion: 's', ...over })
  let st = findings.merge(null, bot, { summary: 'a', findings: [f('k1'), f('k2', { severity: 'low', kind: 'idle' })], resolved: [] }, { now: NOW })
  assert.deepStrictEqual(st.open.map(x => x.key), ['k1', 'k2']); assert.strictEqual(st.status, 'issues')
  st = findings.merge(st, bot, { findings: [f('k1')], resolved: [] }, { now: NOW + 600e3 })
  assert.strictEqual(st.open.find(x => x.key === 'k1').seenRuns, 2); assert.strictEqual(st.open.find(x => x.key === 'k2').missedRuns, 1)
  st = findings.merge(st, bot, { findings: [f('k1')], resolved: [] }, { now: NOW + 1200e3 })
  assert.deepStrictEqual(st.open.map(x => x.key), ['k1']); assert.match(st.recentlyResolved[0].why, /not seen/)
  st = findings.merge(st, bot, { findings: [], resolved: ['k1'] }, { now: NOW + 1800e3 })
  assert.strictEqual(st.status, 'ok'); assert.strictEqual(st.recentlyResolved[0].why, 'closed by the reviewer: gone, or merged into another finding')
  // a model failure must not age findings out
  st = findings.merge(st, bot, { findings: [f('k3')], resolved: [] }, { now: NOW })
  st = findings.merge(st, bot, { findings: [], resolved: [] }, { now: NOW, age: false })
  st = findings.merge(st, bot, { findings: [], resolved: [] }, { now: NOW, age: false })
  assert.strictEqual(st.open.length, 1)
  // detector flag the model skipped
  st = findings.merge(null, bot, { findings: [], resolved: [] }, { now: NOW, evidence: { activeDetectorFlags: [{ kind: 'stuck', sev: 'high', msg: 'stuck 20s' }, { kind: 'idle', sev: 'med', msg: 'x' }] } })
  assert.deepStrictEqual(st.open.map(x => [x.key, x.source]), [['ozo-detector-stuck', 'detector']])
  const md = findings.toMarkdown(st, { model: 'm' }); assert.match(md, /\[HIGH\] Detector: stuck/); assert.match(md, /Never posted to game chat/)
})

test('runReview: one model call for both bots, writes findings + markdown, skips when nothing changed, skips offline bots', async () => {
  const root = tmp(), cfg = cfgFor(root)
  mkBot(cfg.bots[0].dir, { flags: [{ kind: 'jumping', sev: 'high', msg: '30 jumps in 1 min' }] })
  mkBot(cfg.bots[1].dir, { telemetryAgeS: 7200 }); fs.utimesSync(path.join(cfg.bots[1].dir, 'idle.log'), new Date(NOW - 7200e3), new Date(NOW - 7200e3))
  const calls = []
  const ask = async (o) => {
    calls.push(o)
    return { ok: true, costUsd: 0.01, durationMs: 5, data: { bots: [{ bot: 'OzoGo444', status: 'issues', summary: 'chopping', resolved: [], findings: [{ key: 'ozo-jump', kind: 'excessive_jumping', severity: 'high', confidence: 'high', title: 'Jumping on the spot', evidence: '30 jumps/min', suggestion: 'check the nav loop' }] }] } }
  }
  const r = await runReview(cfg, { ask, now: NOW })
  assert.ok(r.ok); assert.deepStrictEqual(r.reviewed, ['OzoGo444']); assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].model, 'claude-haiku-5-5'); assert.strictEqual(calls[0].effort, 'xhigh'); assert.strictEqual(calls[0].systemPrompt, SYSTEM_PROMPT)
  assert.ok(!calls[0].prompt.includes('Smeo444'), 'offline bot is not sent')
  const ozo = JSON.parse(fs.readFileSync(path.join(cfg.bots[0].dir, 'brain/state/review/findings.json'), 'utf8'))
  assert.strictEqual(ozo.open[0].key, 'ozo-jump'); assert.strictEqual(ozo.lastRun.model, 'claude-haiku-5-5')
  assert.match(fs.readFileSync(path.join(cfg.bots[0].dir, 'REVIEW-FINDINGS.md'), 'utf8'), /Jumping on the spot/)
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(cfg.bots[1].dir, 'brain/state/review/findings.json'), 'utf8')).status, 'offline')
  const r2 = await runReview(cfg, { ask, now: NOW + 1000 })
  assert.match(r2.skipped, /nothing changed/); assert.strictEqual(calls.length, 1)
  const r3 = await runReview(cfg, { ask, now: NOW + 2000, force: true }); assert.ok(r3.reviewed); assert.strictEqual(calls.length, 2)
  assert.strictEqual(fs.existsSync(path.join(cfg.outDir, 'reviewer.lock')), false)
})

test('runReview: a Claude failure still publishes the detector findings and keeps older ones', async () => {
  const root = tmp(), cfg = cfgFor(root)
  mkBot(cfg.bots[0].dir, { flags: [{ kind: 'stuck', sev: 'high', msg: 'stuck for 20s' }] })
  mkBot(cfg.bots[1].dir, { telemetryAgeS: null })
  const r = await runReview(cfg, { ask: async () => ({ ok: false, error: 'not logged in' }), now: NOW })
  assert.strictEqual(r.ok, false)
  const ozo = JSON.parse(fs.readFileSync(path.join(cfg.bots[0].dir, 'brain/state/review/findings.json'), 'utf8'))
  assert.strictEqual(ozo.open[0].source, 'detector'); assert.strictEqual(ozo.lastRun.error, 'not logged in')
  assert.strictEqual(fs.existsSync(path.join(cfg.outDir, 'reviewer.lock')), false)
})

test('runReview: all bots offline makes no model call; dry run sends nothing and takes no lock', async () => {
  const root = tmp(), cfg = cfgFor(root)
  let n = 0
  const r = await runReview(cfg, { ask: async () => { n++ }, now: NOW })
  assert.match(r.skipped, /offline/); assert.strictEqual(n, 0)
  mkBot(cfg.bots[0].dir)
  const d = await runReview(cfg, { ask: async () => { n++ }, now: NOW, dryRun: true })
  assert.ok(d.dryRun && d.prompt.includes('OzoGo444')); assert.strictEqual(n, 0)
})

test('askClaude: Haiku options, no tools, no settings, key stripped, structured output parsed, errors explained', async () => {
  let seen
  const sdk = { query: ({ prompt, options }) => { seen = { prompt, options }; return (async function* () { yield { type: 'system' }; yield { type: 'result', subtype: 'success', is_error: false, structured_output: { bots: [] }, total_cost_usd: 0.002 } })() } }
  process.env.ANTHROPIC_API_KEY = 'sk-test'
  const r = await askClaude({ sdk, systemPrompt: 'sys', prompt: 'p', schema: SCHEMA, model: 'claude-haiku-5-5', effort: 'xhigh', cwd: os.tmpdir(), timeoutMs: 1000 })
  delete process.env.ANTHROPIC_API_KEY
  assert.deepStrictEqual(r.data, { bots: [] })
  const o = seen.options
  assert.strictEqual(o.model, 'claude-haiku-5-5'); assert.strictEqual(o.effort, 'xhigh'); assert.strictEqual(o.systemPrompt, 'sys')
  assert.deepStrictEqual(o.tools, []); assert.deepStrictEqual(o.settingSources, []); assert.strictEqual(o.persistSession, false)
  assert.strictEqual(o.env.ANTHROPIC_API_KEY, undefined); assert.strictEqual(o.outputFormat.type, 'json_schema')
  const bad = await askClaude({ sdk: { query: () => (async function* () { yield { type: 'result', subtype: 'error_during_execution', errors: ['Invalid API key · login'] } })() }, schema: SCHEMA, timeoutMs: 1000 })
  assert.strictEqual(bad.ok, false); assert.match(bad.error, /run `claude` once/)
  assert.strictEqual(childEnv({ ANTHROPIC_API_KEY: 'x', PATH: 'p' }).PATH, 'p')
})

test('schedule: schtasks arguments, launcher script, query parsing', () => {
  const a = schedule.createArgs({ vbsPath: 'C:\\Users\\w\\.mc-player\\reviewer\\launch-reviewer.vbs', minutes: 10 })
  assert.deepStrictEqual(a.slice(0, 9), ['/Create', '/F', '/TN', 'MC-Player Bot Reviewer', '/SC', 'MINUTE', '/MO', '10', '/RL'])
  assert.ok(!a.includes('/RU') && !a.includes('/RP'), 'no stored password, no SYSTEM account')
  assert.match(a[a.length - 1], /^wscript\.exe \/\/B \/\/Nologo "C:.*launch-reviewer\.vbs"$/)
  const v = schedule.launcherVbs({ nodeExe: 'C:\\Program Files\\nodejs\\node.exe', scriptPath: 'C:\\MC-Player\\reviewer\\run.js', workDir: 'C:\\MC-Player\\reviewer' })
  assert.match(v, /sh\.Run """C:\\Program Files\\nodejs\\node\.exe"" ""C:\\MC-Player\\reviewer\\run\.js"" --once", 0, False/)
  assert.ok(!/ELECTRON_RUN_AS_NODE/.test(v))
  assert.match(schedule.launcherVbs({ nodeExe: 'e.exe', scriptPath: 's.js', workDir: 'w', electronAsNode: true }), /ELECTRON_RUN_AS_NODE/)
  const q = schedule.parseQuery('Folder: \\\r\nTaskName: \\MC-Player Bot Reviewer\r\nNext Run Time: 11/10/2026 4:10:00 AM\r\nStatus: Ready\r\nLast Run Time: 11/10/2026 4:00:00 AM\r\nLast Result: 0\r\n')
  assert.deepStrictEqual([q.installed, q.status, q.nextRun, q.lastResult], [true, 'Ready', '11/10/2026 4:10:00 AM', '0'])
})

test('a failed pass keeps the detector events from earlier passes', () => {
  const findings = require('../lib/findings')
  const prev = { open: [], recentlyResolved: [], detectorEvents: [{ name: 'x', action: 'rejected', reason: 'r' }] }
  const st = findings.merge(prev, { id: 'ozo', name: 'OzoGo444' }, { summary: 'failed', findings: [], resolved: [] }, { now: Date.now(), run: {}, evidence: {}, age: false })
  assert.deepStrictEqual(st.detectorEvents, prev.detectorEvents)
})

test('plannerEvidence: a switched-off or long-silent planner log is a statement, not counts (the 16-run false alarm of 2026-11-10)', () => {
  const { plannerEvidence } = require('../lib/collect')
  const summary = { steps: 0, otherEvents: { 'model-error': 380, 'no-plan': 369 } }
  const dead = plannerEvidence({ summary, logMtime: NOW - 6 * 86400e3, switchedOff: true, now: NOW })
  assert.strictEqual(dead.plannerRunning, false); assert.strictEqual(dead.switchedOff, true); assert.ok(!('otherEvents' in dead)); assert.match(dead.note, /switched off/)
  const quiet = plannerEvidence({ summary, logMtime: NOW - 2 * 3600e3, switchedOff: false, now: NOW })
  assert.strictEqual(quiet.plannerRunning, false); assert.match(quiet.note, /120 min/)
  assert.match(plannerEvidence({ summary, logMtime: 0, switchedOff: false, now: NOW }).note, /no planner log/i)
  const live = plannerEvidence({ summary, logMtime: NOW - 60e3, switchedOff: false, now: NOW })
  assert.strictEqual(live.plannerRunning, true); assert.strictEqual(live.otherEvents['model-error'], 380)
  // collectBot wires it in: a stale think-log plus think-off never reaches the model as counts
  const root = tmp(); mkBot(path.join(root, 'ozo'))
  const sd = path.join(root, 'ozo', 'brain', 'state'); fs.writeFileSync(path.join(sd, 'think-log.jsonl'), '{"ev":"model-error"}\n{"ev":"no-plan"}\n'); fs.writeFileSync(path.join(sd, 'think-off'), '')
  fs.utimesSync(path.join(sd, 'think-log.jsonl'), new Date(NOW - 6 * 86400e3), new Date(NOW - 6 * 86400e3))
  const ev = collectBot({ dir: path.join(root, 'ozo') }, { now: NOW })
  assert.strictEqual(ev.plannerSummary.plannerRunning, false); assert.ok(!('otherEvents' in ev.plannerSummary))
})

test('findings.merge: a flag named in explainsFlags is covered, so no extra HIGH "Detector:" entry is appended', () => {
  const bot = { id: 'ozo', name: 'OzoGo444' }
  const f = { key: 'ozo-nav-timeouts', kind: 'code_fault', severity: 'high', confidence: 'high', title: 't', evidence: 'e', suggestion: 's', explainsFlags: ['repeated_failure'] }
  const flags = [{ kind: 'repeated_failure', sev: 'high', msg: '26x timeout' }, { kind: 'pillar_failing', sev: 'high', msg: 'p' }]
  const st = findings.merge(null, bot, { findings: [f], resolved: [] }, { now: NOW, evidence: { activeDetectorFlags: flags } })
  assert.deepStrictEqual(st.open.map(x => x.key).sort(), ['ozo-detector-pillar_failing', 'ozo-nav-timeouts'])   // only the uncovered flag is added
  const same = findings.merge(null, bot, { findings: [{ ...f, kind: 'repeated_failure', explainsFlags: [] }], resolved: [] }, { now: NOW, evidence: { activeDetectorFlags: [flags[0]] } })
  assert.deepStrictEqual(same.open.map(x => x.key), ['ozo-nav-timeouts'])   // same kind still covers
  assert.ok(SCHEMA.properties.bots.items.properties.findings.items.required.includes('explainsFlags'))
})

test('runReview: a bot with fewer than 3 normal windows gets no window digests and a closed detector-proposal note; the prompt is compact JSON', async () => {
  const root = tmp(), cfg = cfgFor(root)
  mkBot(cfg.bots[0].dir); mkBot(cfg.bots[1].dir)
  const wd = path.join(cfg.bots[0].dir, 'brain', 'state', 'telemetry', 'windows'); fs.mkdirSync(wd, { recursive: true })
  for (const id of ['w1-normal', 'w2-normal', 'w3-normal']) fs.writeFileSync(path.join(wd, id + '.json'), JSON.stringify({ id, kind: 'normal', at: 'x', samples: [], digest: { n: 1 } }))
  const r = await runReview(cfg, { ask: async () => ({ ok: true, data: { bots: [] } }), now: NOW, dryRun: true })
  const bots = JSON.parse(r.prompt.slice(r.prompt.indexOf('[')))
  assert.strictEqual(bots[0].detectorProposals, 'open'); assert.strictEqual(bots[0].windows.length, 3)
  assert.match(bots[1].detectorProposals, /^closed/); assert.ok(!('windows' in bots[1]))
  assert.ok(!/\n\s+"/.test(r.prompt.slice(r.prompt.indexOf('['))), 'no pretty-printing whitespace in the evidence')
})

test('findings.merge: a resolved key that returns keeps its first-seen time and run count; the model sees recentlyResolved', async () => {
  const bot = { id: 'ozo', name: 'OzoGo444' }
  const f = (key) => ({ key, kind: 'code_fault', severity: 'med', confidence: 'high', title: key, evidence: 'e', suggestion: 's', explainsFlags: [] })
  let st = findings.merge(null, bot, { findings: [f('ozo-gap')], resolved: [] }, { now: NOW })
  st = findings.merge(st, bot, { findings: [f('ozo-gap')], resolved: [] }, { now: NOW + 600e3 })
  st = findings.merge(st, bot, { findings: [], resolved: ['ozo-gap'] }, { now: NOW + 1200e3 })
  assert.strictEqual(st.open.length, 0); assert.strictEqual(st.recentlyResolved[0].key, 'ozo-gap')
  st = findings.merge(st, bot, { findings: [f('ozo-gap')], resolved: [] }, { now: NOW + 1800e3 })
  const g = st.open.find(x => x.key === 'ozo-gap')
  assert.strictEqual(g.firstSeen, new Date(NOW).toISOString()); assert.strictEqual(g.seenRuns, 3)
  assert.ok(!st.recentlyResolved.some(x => x.key === 'ozo-gap'))
  // the evidence handed to the model carries the recently resolved keys
  const root = tmp(), cfg = cfgFor(root); mkBot(cfg.bots[0].dir); mkBot(cfg.bots[1].dir)
  findings.save(cfg.bots[0], { ...st, open: [], recentlyResolved: [{ key: 'ozo-old', title: 'Old thing', resolvedAt: 'x', why: 'w' }] }, {})
  const r = await runReview(cfg, { ask: async () => ({ ok: true, data: { bots: [] } }), now: NOW, dryRun: true })
  const bots = JSON.parse(r.prompt.slice(r.prompt.indexOf('[')))
  assert.deepStrictEqual(bots[0].recentlyResolved.map(x => x.key), ['ozo-old'])
  assert.match(SYSTEM_PROMPT, /KEYS ARE IDENTITY/); assert.match(SYSTEM_PROMPT, /reset process/)
})

test('findClaudeExecutable: leaves the SDK alone when its own binary is bundled, otherwise finds the installed Claude Code', () => {
  const { findClaudeExecutable } = require('../lib/claude')
  const base = { platform: 'win32', arch: 'x64', home: 'C:\\Users\\w', env: { PATH: 'C:\\a;C:\\b' } }
  assert.strictEqual(findClaudeExecutable({ ...base, resolve: () => 'x' }), undefined)
  const missing = () => { throw new Error('not found') }
  assert.strictEqual(findClaudeExecutable({ ...base, resolve: missing, exists: f => f === 'C:\\b\\claude.exe' }), 'C:\\b\\claude.exe')
  assert.strictEqual(findClaudeExecutable({ ...base, resolve: missing, exists: f => f === 'C:\\Users\\w\\.local\\bin\\claude.exe' }), 'C:\\Users\\w\\.local\\bin\\claude.exe')
  assert.strictEqual(findClaudeExecutable({ ...base, resolve: missing, exists: () => false }), undefined)
  assert.strictEqual(findClaudeExecutable({ ...base, env: { REVIEWER_CLAUDE_PATH: 'D:\\c.exe' }, resolve: missing }), 'D:\\c.exe')
})
