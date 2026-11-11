// The daily digest (docs/MEMORY-LOOP.md, job 7): one page a day for Walter, by exception. `node run.js --digest`, from its own Task Scheduler entry.
// The entry fires every hour and this job writes at most one digest per local day, the first time it runs after 07:00, so a laptop that was asleep
// at a fixed time still gets its page. No model is called: every line is a number or a sentence that some other part of the loop already wrote.
//
//   <loop dir>/digest/<YYYY-MM-DD>.md     kept 30 days; the Bot Dashboard app shows the newest on its Memory loop tab
//
// What is on it: what each bot asked Walter for (in the bot's own words, from its dawn briefs), deaths and stalled minutes, the most costly open work
// orders, what was opened, fixed, reopened or closed, what was deployed or taken back, which jobs failed, and at most one question.
const fs = require('fs')
const path = require('path')
const orders = require('./orders')
const runs = require('./runs')
const { deployLog } = require('./deploy')

const DAY_MS = 24 * 3600000, KEEP_DAYS = 30, AFTER_HOUR = 7
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')) } catch { return d } }
const cut = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const localDate = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`

// Pure: what was gathered -> markdown.
// data: { now, bots: [{ name, online, rollup, asks: [{ at, text }], brief, memoryLines, memoryChanges, roadmap }], orders: [..], ledger: [..], deploys: [..], runs: [..], question }
function buildDigest({ now = Date.now(), bots = [], orders: all = [], ledger = [], deploys = [], runs: runRows = [], question = null } = {}) {
  const since = now - DAY_MS
  const L = [`# Memory loop digest, ${localDate(now)}`, '', '_The last 24 hours. Written by code from the journals, the work orders and the run log on this computer._', '']

  const asks = bots.flatMap(b => (b.asks || []).map(a => ({ bot: b.name, ...a })))
  if (asks.length) { L.push('## The bots ask', ''); for (const a of asks.slice(-4)) L.push(`- **${a.bot}** (${String(a.at).slice(11, 16)}Z): ${cut(a.text, 260)}`); L.push('') }

  L.push('## The bots', '')
  for (const b of bots) {
    const r = b.rollup
    if (!r || !r.events) { L.push(`- **${b.name}**: nothing in its journal in the last 24 hours.`); continue }
    const lost = Object.entries(r.steps || {}).filter(([id, s]) => id !== 'unknown' && s.stalledMin > 0).sort((a, b2) => b2[1].stalledMin - a[1].stalledMin).slice(0, 3).map(([id, s]) => `${id} ${s.stalledMin} min`)
    const items = Object.entries(r.items || {}).sort((a, b2) => b2[1] - a[1]).slice(0, 5).map(([k, n]) => `${k} x${n}`)
    L.push(`- **${b.name}**: ${plural(r.deaths.length, 'death')}${r.deaths.length ? ` (${r.deaths.slice(-2).map(d => cut(d.cause, 50)).join('; ')})` : ''}, ${r.alarms.stalledMin} min stalled over ${plural(r.alarms.raised, 'alarm')}${lost.length ? ` (most: ${lost.join(', ')})` : ''}, ${plural(r.flagsHigh, 'high flag')}.${items.length ? ` Gained ${items.join(', ')}.` : ''}`)
    if (b.brief && b.brief.intent) L.push(`  - Its last plan (${String(b.brief.at).slice(11, 16)}Z): ${cut(b.brief.intent, 220)}${b.brief.freeTime && b.brief.freeTime.choice !== 'none' ? ` Free time: ${b.brief.freeTime.choice}.` : ''}`)
    if (b.memoryLines != null) L.push(`  - Memory: ${b.memoryLines} of 60 lines${b.memoryChanges ? `, ${plural(b.memoryChanges, 'line')} changed by the memory check` : ''}.`)
    if (b.roadmap) L.push(`  - Roadmap: ${b.roadmap}`)
  }
  L.push('')

  const open = all.filter(o => o.status === 'open' || o.status === 'parked')
  L.push('## Work orders', '')
  if (!open.length) L.push('- None open.')
  for (const o of open.slice(0, 5)) L.push(`- ${o.costMin} min lost: ${o.title} (\`${o.key}\`${o.status === 'parked' ? ', parked' : ''}${o.pr ? `, PR #${o.pr}` : ''}${o.reopens ? `, reopened ${o.reopens}x` : ''})`)
  if (open.length > 5) L.push(`- and ${open.length - 5} more`)
  const ev = ledger.filter(l => Date.parse(l.at) >= since)
  const names = (kind) => [...new Set(ev.filter(l => l.ev === kind && l.order).map(l => l.order))]
  const moved = [['opened', 'Opened'], ['pr', 'Pull request from the fixer'], ['ready', 'Checked fix that could not be pushed'], ['fixed', 'Fixed'], ['reopened', 'Came back after a fix'], ['closed', 'Went quiet'], ['parked', 'Parked']].map(([k, label]) => [label, names(k)]).filter(([, n]) => n.length)
  if (moved.length) L.push('', ...moved.map(([label, n]) => `- ${label}: ${n.join(', ')}`))
  L.push('')

  const dd = deploys.filter(d => d.t >= since)
  const promoted = dd.filter(d => d.event === 'deploy'), reverted = dd.filter(d => d.event === 'revert'), refused = dd.filter(d => d.event === 'refused')
  L.push('## Deploys', '', dd.length
    ? `- ${plural(promoted.length, 'deploy')}${promoted.length ? ` (now at ${promoted[promoted.length - 1].to})` : ''}, ${reverted.length} taken back${reverted.length ? ` (${reverted.map(r => r.from).join(', ')})` : ''}, ${refused.length} held back${refused.length ? ` (${[...new Set(refused.map(r => r.why))].join(', ')})` : ''}.`
    : '- None in the last 24 hours.', '')

  const jobs = {}
  for (const r of runRows.filter(r => Date.parse(r.at) >= since)) { const j = (jobs[r.job] = jobs[r.job] || { n: 0, failed: 0, cost: 0, last: null }); j.n++; if (r.ok === false) { j.failed++; j.last = j.last || r.summary } j.cost += r.costUsd || 0 }
  L.push('## Jobs', '')
  if (!Object.keys(jobs).length) L.push('- No job ran in the last 24 hours. Check the Memory loop tab: a job may not be installed.')
  for (const [name, j] of Object.entries(jobs).sort()) L.push(`- ${name}: ${plural(j.n, 'run')}${j.failed ? `, ${j.failed} failed (${cut(j.last, 140)})` : ''}${j.cost ? `, about $${j.cost.toFixed(2)}` : ''}`)
  L.push('')

  if (question) L.push('## One question', '', cut(question, 400), '')
  return L.join('\n')
}

function gather(cfg, now) {
  const { recentDays } = require('./dream')                       // the journal readers live with the dream (they need brain/journal/rollup)
  const { rollup } = require(path.join(__dirname, '..', '..', 'brain', 'journal', 'rollup.js'))
  const since = now - DAY_MS
  const runRows = runs.read(cfg, { limit: 500 })
  const bots = cfg.bots.map(b => {
    const sd = path.join(b.dir, 'brain', 'state'), mem = path.join(sd, 'memory')
    let events = []; try { events = recentDays(b, now, 2).flatMap(d => d.events).filter(e => Date.parse(e.at) >= since) } catch { /* no journal */ }
    const asks = events.filter(e => e.k === 'brief' && e.ask).map(e => ({ at: e.at, text: e.ask }))
    const brief = readJson(path.join(mem, 'brief.json'))
    let memoryLines = null; try { memoryLines = fs.readFileSync(path.join(mem, 'global.md'), 'utf8').split('\n').filter(l => l.trim()).length } catch { /* no memory folder */ }
    const road = readJson(path.join(sd, 'roadmap.json'))
    return {
      name: b.name, rollup: events.length ? rollup(events) : null,
      // what the bot asked Walter for, in its own words: from the journal's brief events, and the plan it is on now
      asks: [...asks, ...(brief && brief.ask && Date.parse(brief.at) >= since ? [{ at: brief.at, text: brief.ask }] : [])].filter((a, i, all) => all.findIndex(x => x.text === a.text) === i),
      brief: brief && Date.parse(brief.at) >= since ? brief : null, memoryLines,
      memoryChanges: runRows.filter(r => r.job === 'dream' && r.bot === b.id && Date.parse(r.at) >= since).reduce((n, r) => n + (r.changes || 0), 0),
      roadmap: road && road.phases ? Object.entries(road.phases).map(([k, p]) => `phase ${k}: ${p.done} of ${p.measured} measured items done`).join('; ') : null,
    }
  })
  let question = null; try { question = fs.readFileSync(path.join(cfg.loopDir, 'digest-question.txt'), 'utf8').split('\n').map(s => s.trim()).find(Boolean) || null } catch { /* none */ }
  return { now, bots, orders: orders.list(cfg.loopDir), ledger: orders.readLedger(cfg.loopDir, 400), deploys: deployLog(cfg.codeDir, 100), runs: runRows, question }
}

// At most one digest per local day, the first run after 07:00 (force writes one now). -> { ok, skipped?, file? }
function runDigest(cfg, { now = Date.now(), force = false, log = () => {} } = {}) {
  const dir = path.join(cfg.loopDir, 'digest'), file = path.join(dir, `${localDate(now)}.md`)
  if (!force && fs.existsSync(file)) return { ok: true, skipped: 'today\'s digest is already written' }
  if (!force && new Date(now).getHours() < AFTER_HOUR) return { ok: true, skipped: `before ${AFTER_HOUR}:00` }
  const text = buildDigest(gather(cfg, now))
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, text)
  try { fs.unlinkSync(path.join(cfg.loopDir, 'digest-question.txt')) } catch { /* there was none */ }                  // a question is asked once
  for (const f of fs.readdirSync(dir).filter(f => /^\d{4}-\d\d-\d\d\.md$/.test(f)).sort().slice(0, -KEEP_DAYS)) { try { fs.unlinkSync(path.join(dir, f)) } catch { /* next time */ } }
  runs.append(cfg, 'digest', { ok: true, summary: `wrote ${path.basename(file)}` }, now)
  log(`digest wrote ${file}`)
  return { ok: true, file, text }
}

function latest(loopDir) {
  const dir = path.join(loopDir, 'digest')
  try { const f = fs.readdirSync(dir).filter(f => /^\d{4}-\d\d-\d\d\.md$/.test(f)).sort().pop(); return f ? { date: f.slice(0, 10), text: fs.readFileSync(path.join(dir, f), 'utf8') } : null } catch { return null }
}

module.exports = { buildDigest, runDigest, gather, latest }
