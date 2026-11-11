// The loop's own review (docs/MEMORY-LOOP.md): once every six hours a stronger model reads what the loop did and says whether it is working as intended, which
// stage is stuck or idle, and what only Walter can unblock. `node run.js --audit`, from its own Task Scheduler entry (every 6 h).
//
// Code gathers the facts and applies hard rules first (a job that is not installed, a job that has not run for three of its periods, bots offline, questions
// nobody answered, orders that nothing is acting on, missing modules). Those rules are the floor: they are in the report whatever the model says, and the report is
// still written when the model call fails. The model then reads facts and rules together and adds the judgement the rules cannot make: is the chain closing, what
// should be tweaked. It has no tools and cannot change anything; a change goes to the fixer as a work order or to Walter as a line in `needsWalter`.
//
//   <loop dir>/audit/<time>.md       the report, kept 20
//   <loop dir>/audit/latest.json     { at, verdict, summary, needsWalter, rules, stages, tweaks }: the digest and the app read it; the next audit sees it
const fs = require('fs')
const path = require('path')
const orders = require('./orders')
const runs = require('./runs')
const schedule = require('./schedule')
const { deployLog } = require('./deploy')

const HOUR = 3600000, DAY = 24 * HOUR, KEEP = 20
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')) } catch { return d } }
const cut = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const mins = (ms) => Math.round(ms / 60000)

// the newest journal write of a bot: how long it has been silent
function journalAge(bot, now) {
  try {
    const dir = path.join(bot.dir, 'brain', 'state', 'journal')
    const day = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().pop()
    return day ? now - fs.statSync(path.join(dir, day)).mtimeMs : null
  } catch { return null }
}
function asksOf(bot, now) {
  try {
    const dir = path.join(bot.dir, 'brain', 'state', 'journal')
    const days = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-2)
    let n = 0
    for (const d of days) for (const l of fs.readFileSync(path.join(dir, d), 'utf8').split('\n')) {
      if (!l.includes('"k":"brief"') && !l.includes('"k": "brief"')) continue
      try { const e = JSON.parse(l); if (e.ask && Date.parse(e.at) >= now - DAY) n++ } catch { /* torn line */ }
    }
    return n
  } catch { return 0 }
}

// Everything the audit looks at. task: { jobId: schtasks status } (read by the caller, since it shells out).
function gather(cfg, now, task = {}) {
  const rows = runs.read(cfg, { limit: 800 })
  const jobs = {}
  for (const id of Object.keys(schedule.JOBS)) {
    const j = schedule.JOBS[id], mine = rows.filter(r => r.job === (id === 'review' ? 'review' : id)), day = mine.filter(r => Date.parse(r.at) >= now - DAY)
    jobs[id] = {
      title: j.title, everyMin: j.minutes, installed: task[id] ? !!task[id].installed : null,
      lastAt: mine[0] ? mine[0].at : null, lastOk: mine[0] ? mine[0].ok !== false : null, lastSummary: mine[0] ? cut(mine[0].summary, 160) : null,
      runs24h: day.filter(r => !r.skipped).length, skips24h: day.filter(r => r.skipped).reduce((n, r) => n + (r.n || 1), 0), lastSkip: mine[0] && mine[0].skipped ? cut(mine[0].summary, 140) : null, failed24h: day.filter(r => r.ok === false).length,
    }
  }
  const bots = cfg.bots.map(b => ({ name: b.name, silentMin: (() => { const a = journalAge(b, now); return a == null ? null : mins(a) })(), asks24h: asksOf(b, now) }))
  const all = orders.list(cfg.loopDir), led = orders.readLedger(cfg.loopDir, 600).filter(l => Date.parse(l.at) >= now - DAY)
  const open = all.filter(o => o.status === 'open' || o.status === 'parked')
  const count = (ev) => led.filter(l => l.ev === ev).length
  const ord = {
    open: open.length, opened24h: count('opened'), reopened24h: count('reopened'), closed24h: count('closed'), fixed24h: count('fixed'), prs24h: count('pr'), deploys24h: count('deploy'), verdicts24h: count('verdict'),
    oldestOpenH: open.length ? Math.round((now - Math.min(...open.map(o => Date.parse(o.openedAt) || now))) / HOUR) : 0, withPr: open.filter(o => o.pr).length,
    top: open.slice(0, 4).map(o => ({ key: o.key, costMin: o.costMin, ageH: Math.round((now - (Date.parse(o.openedAt) || now)) / HOUR), pr: o.pr || null, seenDreams: o.seenDreams })),
  }
  const dep = deployLog(cfg.codeDir, 20).filter(d => d.t >= now - DAY).map(d => `${d.event}${d.why ? `:${d.why}` : ''}${d.to ? ` ${String(d.to).slice(0, 9)}` : ''}`)
  const mods = ['mineflayer', 'mineflayer-pathfinder', 'ajv', 'prismarine-nbt'].filter(m => !fs.existsSync(path.join(cfg.codeDir || '', 'node_modules', m)))
  const dig = require('./digest').latest(cfg.loopDir)
  return { now: new Date(now).toISOString(), jobs, bots, orders: ord, deploys24h: dep, missingModules: mods, digestDate: dig ? dig.date : null, lastAudit: readJson(path.join(cfg.loopDir, 'audit', 'latest.json')) }
}

// The hard rules. -> [{ stage, status: 'ok'|'warn'|'broken', why }]
function rules(f) {
  const out = [], add = (stage, status, why) => out.push({ stage, status, why })
  for (const [id, j] of Object.entries(f.jobs)) {
    if (id === 'audit') continue
    if (j.installed === false) { add(id, 'broken', `${j.title}: not installed in Task Scheduler, so it never runs`); continue }
    if (j.lastAt) {
      const age = Date.parse(f.now) - Date.parse(j.lastAt)
      if (age > 3 * j.everyMin * 60000 + 30 * 60000) { add(id, 'warn', `${j.title}: last run ${Math.round(age / HOUR)} h ago, its period is ${j.everyMin} min`); continue }
    }
    if (j.failed24h && j.failed24h >= Math.max(2, j.runs24h / 2)) { add(id, 'warn', `${j.title}: ${j.failed24h} of ${j.runs24h} runs failed in a day (${j.lastSummary || ''})`); continue }
    if (j.installed && !j.lastAt) add(id, 'warn', `${j.title}: installed but never ran`)
    else add(id, 'ok', `${j.title}: ${j.runs24h} runs in a day`)
  }
  for (const b of f.bots) {
    if (b.silentMin == null) add(`bot ${b.name}`, 'warn', 'no journal at all')
    else if (b.silentMin > 30) add(`bot ${b.name}`, 'broken', `silent for ${b.silentMin} min: not running, and nothing restarts it`)
    else add(`bot ${b.name}`, 'ok', 'journal is current')
    if (b.asks24h >= 3) add(`asks ${b.name}`, 'warn', `${b.asks24h} questions to Walter in a day, nobody answers at night`)
  }
  const o = f.orders
  if (o.open && o.oldestOpenH >= 24 && o.prs24h === 0 && o.fixed24h === 0 && o.closed24h === 0) add('orders', 'broken', `${o.open} open work orders, the oldest ${o.oldestOpenH} h, and none got a pull request, a fix or a close in a day: nothing acts on them`)
  else if (o.open) add('orders', o.prs24h || o.fixed24h || o.closed24h ? 'ok' : 'warn', `${o.open} open, ${o.opened24h} opened, ${o.prs24h} pull requests, ${o.deploys24h} deploys, ${o.fixed24h} fixed, ${o.closed24h} closed in a day`)
  if (o.reopened24h >= 3) add('orders', 'warn', `${o.reopened24h} orders came back after a fix in a day: fixes are not holding`)
  if (f.deploys24h.some(d => d.startsWith('refused:tests'))) add('deploy', 'warn', 'a deploy was refused because the tests are red on main: nothing ships until they pass')
  if (f.missingModules.length) add('node_modules', 'broken', `the live clone's node_modules lacks ${f.missingModules.join(', ')}: the next bot restart will crash`)
  if (!f.digestDate) add('digest', 'warn', 'no digest has been written yet')
  return out
}
const worst = (rs) => (rs.some(r => r.status === 'broken') ? 'broken' : rs.some(r => r.status === 'warn') ? 'degraded' : 'healthy')

const SYSTEM = `You review a memory loop that keeps two Minecraft bots improving without their owner, Walter, at the wheel. Walter wants to step away. The loop is meant to work like this:
1. A journal records what each bot did. Each bot keeps a small memory file and reads a dawn brief (focus, holds, free time) written by a model; it asks Walter a question only when stuck.
2. The Dream job (every 2 h) checks the memory against the journal and opens work orders for problems only code can fix.
3. The Fixer (every 3 h) takes the most costly order to a checked pull request and merges it. The Deployer (every 30 min) puts main on the live bots, judges the result against the bot's own earlier hours, and takes a bad deploy back. The order is marked fixed when the verdict is good, reopened if the problem returns.
4. The Digest writes one page a day. This audit is the check on the whole chain.
Stepping away is real only when the chain closes by itself: evidence, order, fix, deploy, verdict, with the bots alive and busy and Walter asked about almost nothing.
You get facts gathered by code, and hard rules code already applied (they stand whatever you say). Judge only from them. Do not invent numbers. Say plainly what is broken, what is idle, and what is merely slow. Separate what a person must do (install a job, restart the app, a preference) from what the loop should do itself (then say which stage should have done it and what to change in it). Be specific and brief. If last audit named a problem, say whether it is gone.`

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdict', 'summary', 'stages', 'needsWalter', 'tweaks'],
  properties: {
    verdict: { type: 'string', enum: ['healthy', 'degraded', 'broken'] },
    summary: { type: 'string', description: 'Two or three sentences: is Walter able to step away, and why or why not.' },
    stages: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['stage', 'status', 'finding'], properties: { stage: { type: 'string' }, status: { type: 'string', enum: ['ok', 'idle', 'slow', 'broken'] }, finding: { type: 'string' } } } },
    needsWalter: { type: 'array', items: { type: 'string' }, description: 'Only what a person must do. Empty when nothing.' },
    tweaks: { type: 'array', items: { type: 'string' }, description: 'Changes to the loop itself that would make it close without a person. One concrete change each.' },
  },
}

const userPrompt = (f, rs) => ['## facts', JSON.stringify(f, null, 1), '', '## hard rules applied by code', ...rs.map(r => `- [${r.status}] ${r.stage}: ${r.why}`)].join('\n')

function toMarkdown({ at, verdict, summary, rules: rs, stages = [], needsWalter = [], tweaks = [], modelError = null, model = null }) {
  const L = [`# Loop audit, ${at}`, '', `**${verdict}.** ${summary || ''}`, '']
  if (needsWalter.length) L.push('## Needs Walter', ...needsWalter.map(s => `- ${s}`), '')
  if (tweaks.length) L.push('## Tweaks to the loop', ...tweaks.map(s => `- ${s}`), '')
  if (stages.length) L.push('## Stages', ...stages.map(s => `- ${s.stage} (${s.status}): ${s.finding}`), '')
  L.push('## Hard rules', ...rs.map(r => `- ${r.status}: ${r.stage}: ${r.why}`), '')
  L.push(modelError ? `_The model review failed (${cut(modelError, 160)}); the rules above are the whole report._` : `_Reviewed by ${model}._`, '')
  return L.join('\n')
}

// deps: { ask, now, log, task: { jobId: status } }
async function runAudit(cfg, { ask, now = Date.now(), log = () => {}, task = {}, dryRun = false } = {}) {
  const f = gather(cfg, now, task), rs = rules(f)
  const model = cfg.auditModel || 'claude-sonnet-5-5', effort = cfg.auditEffort || 'high'
  if (dryRun) return { ok: true, dryRun: true, system: SYSTEM, prompt: userPrompt(f, rs), rules: rs }
  const at = new Date(now).toISOString()
  let r = null
  try { r = await ask({ systemPrompt: SYSTEM, prompt: userPrompt(f, rs), schema: SCHEMA, model, effort, cwd: cfg.loopDir, timeoutMs: 8 * 60000, claudePath: cfg.claudePath }) } catch (e) { r = { ok: false, error: String(e && e.message || e) } }
  const d = r && r.ok ? r.data : null
  // the model may say more than the rules, never less: the verdict is at least as bad as the worst hard rule
  const order = ['healthy', 'degraded', 'broken'], floor = worst(rs)
  const verdict = d && order.indexOf(d.verdict) >= order.indexOf(floor) ? d.verdict : floor
  const rep = { at, verdict, summary: d ? d.summary : `${rs.filter(x => x.status !== 'ok').length} rule(s) not ok; the model review did not run.`, rules: rs, stages: d ? d.stages : [], needsWalter: d ? d.needsWalter : rs.filter(x => x.status === 'broken').map(x => x.why), tweaks: d ? d.tweaks : [], model, modelError: d ? null : (r && r.error) || 'no answer' }
  const dir = path.join(cfg.loopDir, 'audit')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, at.replace(/[:.]/g, '-') + '.md'), toMarkdown(rep))
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(rep, null, 1))
  for (const x of fs.readdirSync(dir).filter(x => x.endsWith('.md')).sort().slice(0, -KEEP)) { try { fs.unlinkSync(path.join(dir, x)) } catch { /* next time */ } }
  runs.append(cfg, 'audit', { ok: !!d, summary: `${verdict}: ${cut(rep.summary, 140)}`, costUsd: r && r.costUsd, durationMs: r && r.durationMs }, now)
  log(`audit ${verdict}${d ? '' : ' (rules only)'}`)
  return { ok: !!d, verdict, report: rep }
}

const latest = (loopDir) => readJson(path.join(loopDir, 'audit', 'latest.json'))

module.exports = { runAudit, gather, rules, worst, toMarkdown, latest, SYSTEM, SCHEMA }
