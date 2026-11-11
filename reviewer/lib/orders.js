// Work orders and the ledger (docs/MEMORY-LOOP.md, phase 2): the list of problems only a code change can fix, ranked by what they cost.
//
//   <loop dir>/work-orders/<key>.json   one problem: what it is, the evidence, the numbers per bot, the cost in lost minutes over the last day, its history
//   <loop dir>/ledger.jsonl             one line per event in an order's life: opened, reopened, closed (later: pr, deploy, verdict)
//   <loop dir>/decisions.json           candidates the dream judged "not a bug", so it is not asked again every two hours
//   <loop dir>/WORK-ORDERS.md           the open orders, readable, most costly first
//
// Keys are made by code from what the journal measured (step-<id>, death-<cause>, flag-<kind>, finding-<key>), never by a model, so the same problem
// keeps the same order however it is described. A model only decides whether a candidate is a bug and writes the problem statement (lib/dream.js).
// Cost is an estimate, computed here: minutes stalled under a watchdog alarm, plus the share of a step's minutes whose runs ended in fail or timeout,
// plus a flat DEATH_MIN per death. Flags and reviewer findings carry no minutes; they rank by count below anything with a cost.
const fs = require('fs')
const path = require('path')

const OUTCOME_MIN_PER_H = 5               // a build that should produce and does not costs this many minutes per hour in range (flat, like DEATH_MIN)
const SCHEMATIC_STUCK_MIN = 30             // a stuck schematic build: a flat half hour (the executor worked on it for this long without one more cell right)
const DEATH_MIN = 10                       // what one death is counted as: the walk back and the lost bag. A constant, not a measurement.
const MIN_LOSS = 10, MIN_FAILS = 5, MIN_ALARMS = 5, MIN_DEATHS = 2, MIN_FLAGS = 10, MIN_FINDING_RUNS = 6
const QUIET_DREAMS = 6                     // an order nobody has seen for this many dreams of a running bot closes as "went quiet" (12 h at one dream per 2 h)
const REASK_MS = 24 * 3600000
const round1 = (n) => Math.round(n * 10) / 10
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
const cut = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')) } catch { return d } }
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(o, null, 1)); fs.renameSync(f + '.tmp', f) }

const dirOf = (loopDir) => path.join(loopDir, 'work-orders')
const fileOf = (loopDir, key) => path.join(dirOf(loopDir), `${slug(key)}.json`)

// A day of journal numbers (brain/journal/rollup over the last 24 h) plus the raw events and the reviewer's open findings -> candidates. Pure.
// snapshots: [{ id, at, kind, step }] (brain/state/snapshots: the scene around a high flag, which tools/snapshot-rebuild.js can rebuild on a trial server).
// A step candidate takes the snapshots captured during that step, a flag candidate those of its kind, newest first.
function candidates({ rollup, events = [], findings = [], snapshots = [] }) {
  const out = []
  const snaps = (pick) => snapshots.filter(pick).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 4).map(s => s.id)
  const causes = new Map()                 // step -> Map(alarm cause -> n)
  for (const e of events) {
    if (e.k !== 'alarm' || e.ev !== 'raised') continue
    const id = e.step || 'unknown', m = causes.get(id) || new Map(); causes.set(id, m)
    const c = `${e.type}: ${cut(String(e.cause || '').replace(/\d+s\b/g, 'Ns'), 90)}`; m.set(c, (m.get(c) || 0) + 1)
  }
  for (const [id, s] of Object.entries((rollup && rollup.steps) || {})) {
    if (id === 'unknown') continue
    const done = s.ok + s.fail + s.timeout + s.other, failShare = done ? (s.fail + s.timeout) / done : 0
    const loss = round1(s.stalledMin + s.minutes * failShare)
    if (!(loss >= MIN_LOSS || s.fail + s.timeout >= MIN_FAILS || s.alarms >= MIN_ALARMS)) continue
    const why = [...(causes.get(id) || new Map())].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, n]) => `${n}x ${c}`)
    out.push({
      key: `step-${slug(id)}`, type: 'step', step: id, costMin: loss,
      counts: { runs: s.runs, minutes: s.minutes, ok: s.ok, fail: s.fail, timeout: s.timeout, alarms: s.alarms, stalledMin: s.stalledMin },
      line: `step ${id}: ${s.runs} runs, ${s.minutes} min, ${s.ok} ok, ${s.fail} fail, ${s.timeout} timeout, ${s.alarms} alarms, ${s.stalledMin} min stalled`,
      evidence: why, snapshots: snaps(s2 => s2.step === id),
    })
  }
  const deaths = new Map()
  for (const d of (rollup && rollup.deaths) || []) { const k = slug(String(d.cause || 'unknown').split(/[.,(]/)[0]) || 'unknown'; const g = deaths.get(k) || []; deaths.set(k, g); g.push(d) }
  for (const [k, g] of deaths) {
    if (g.length < MIN_DEATHS) continue
    out.push({ key: `death-${k}`, type: 'death', step: null, costMin: g.length * DEATH_MIN, counts: { deaths: g.length },
      line: `${g.length} deaths from ${cut(g[0].cause || 'unknown', 60)}`, evidence: g.slice(-3).map(d => `${String(d.at).slice(0, 16)}Z ${cut(d.cause, 60)} while ${cut(d.doing || '?', 50)}${d.pos ? ` at ${d.pos.join(',')}` : ''}`) })
  }
  for (const [kind, n] of Object.entries((rollup && rollup.flags) || {})) {
    if (n < MIN_FLAGS) continue
    const last = events.filter(e => e.k === 'flag' && e.kind === kind).slice(-2).map(e => `${String(e.at).slice(11, 16)}Z ${cut(e.msg, 120)}`)
    out.push({ key: `flag-${slug(kind)}`, type: 'flag', step: null, costMin: 0, counts: { flags: n }, line: `flag ${kind}: raised ${n} times`, evidence: last, snapshots: snaps(s2 => s2.kind === kind) })
  }
  // outcome verdicts (brain/outcome): a build that could have worked for hours and made nothing, or one a precondition blocks. These carry their own problem
  // statement, written by code from numbers, so no model has to notice or phrase them (`auto`: the dream opens the order itself). The cost is a flat
  // OUTCOME_MIN_PER_H lost minutes per hour the build was in range, capped at a day; a blocked build waits for a person, so its order is kind 'human'.
  const lastOutcome = new Map()
  for (const e of events) if (e && e.k === 'outcome' && e.build) lastOutcome.set(e.build, e)
  for (const [build, e] of lastOutcome) {
    if (e.state !== 'blocked' && e.state !== 'overdue') continue
    const h = Math.min(Number(e.liveH) || 0, 24), human = e.who === 'human'
    out.push({
      key: `outcome-${slug(build)}`, type: 'outcome', step: null, costMin: round1(h * OUTCOME_MIN_PER_H), counts: { liveH: Number(e.liveH) || 0, got: Number(e.got) || 0 },
      line: `${e.kindOf || 'build'} ${build} is ${e.state}: ${cut(e.why, 200)}`, evidence: [cut(`purpose: ${e.purpose || '?'}; output ${e.got || 0} ${e.unit || ''} in ${e.liveH || 0} h in range`, 200)],
      auto: { isBug: true, kind: human ? 'human' : 'outcome', title: cut(`${build}: ${e.state === 'blocked' ? 'cannot work' : 'produces nothing'}`, 100),
        problem: cut(`${build} (${e.kindOf || 'build'}) was in range for ${e.liveH || 0} h and produced ${e.got || 0} ${e.unit || 'output'}. ${e.why}`, 600),
        suggestion: human ? 'A person has to change the setting named above; code cannot work around it. Tell Walter once, then stop spending the bot\'s time on this build.' : 'The blocks match the design, so look at what the build needs from the world: competition for spawns, the bot standing too close, a counter the output is never added to.' },
    })
  }
  // schematic builds (brain/schematic, the bot following a blueprint for a big build): a job that stopped making progress is the executor's fault, not the world's: it
  // could not dig, place or reach cells the blueprint names. The journal event carries the first wrong cells (cell, what was wanted, what stands there), and the problem
  // statement is written here from them, so no model has to find it. Walter 2026-11-11: following a schematic makes construction easy to check; the check feeds the loop.
  const lastSchem = new Map()
  for (const e of events) if (e && e.k === 'schematic' && e.ev === 'state' && e.id) lastSchem.set(e.id, e)
  for (const [id, e] of lastSchem) {
    if (e.state !== 'stuck') continue
    const wrong = (e.wrong || []).slice(0, 4).map(w => cut(w, 90))
    out.push({
      key: `schematic-${slug(id)}`, type: 'schematic', step: null, costMin: SCHEMATIC_STUCK_MIN, counts: { off: Number(e.off) || 0 },
      line: `schematic ${id} is stuck at ${e.pct}% (${e.off} cells off${e.counts ? ': ' + Object.entries(e.counts).map(([k, n]) => n + ' ' + k).join(', ') : ''})`, evidence: wrong,
      auto: { isBug: true, kind: 'schematic', title: cut(`${id}: the build cannot get past ${e.pct}%`, 100),
        problem: cut(`The bot followed schematic ${id} and the world stopped matching it more at ${e.pct}%: ${e.off} cells are still off. First off: ${wrong.join('; ') || 'not recorded'}.${e.foreign ? ` ${e.foreign} of the wrong cells hold blocks no bot of ours made.` : ''}`, 600),
        suggestion: 'Look at why brain/autopilot/schematicbuild.js cannot do those cells: the placement recipe for that block (brain/schematic/follow.js recipe), a spot with a line of sight, a supply it lacks, or a cell that is not ours to dig (the ledger). The diff is the test: reproduce the cells from the journal event and make a test for the recipe.' },
    })
  }
  for (const f of findings || []) {
    if (!f || f.severity !== 'high' || !((f.seenRuns || 0) >= MIN_FINDING_RUNS)) continue
    out.push({ key: `finding-${slug(f.key)}`, type: 'finding', step: null, costMin: 0, counts: { seenRuns: f.seenRuns }, finding: f.key,
      line: `reviewer finding "${cut(f.title, 90)}": seen in ${f.seenRuns} reviews since ${String(f.firstSeen).slice(0, 16)}Z`, evidence: [cut(f.evidence, 240)] })
  }
  return out.sort((a, b) => (b.costMin - a.costMin) || (weight(b) - weight(a)))
}
const weight = (c) => (c.counts.deaths || 0) * 100 + (c.counts.alarms || 0) + (c.counts.fail || 0) + (c.counts.timeout || 0) + (c.counts.flags || 0) / 10 + (c.counts.seenRuns || 0) / 10

function load(loopDir, key) { return readJson(fileOf(loopDir, key)) }
function list(loopDir, { status = null } = {}) {
  let files = []; try { files = fs.readdirSync(dirOf(loopDir)).filter(f => f.endsWith('.json')) } catch { return [] }
  const all = files.map(f => readJson(path.join(dirOf(loopDir), f))).filter(o => o && o.key)
  return all.filter(o => !status || o.status === status).sort(rank)
}
const OPENISH = { open: 0, parked: 1, fixed: 2, closed: 3 }
const rank = (a, b) => ((OPENISH[a.status] ?? 9) - (OPENISH[b.status] ?? 9)) || ((b.costMin || 0) - (a.costMin || 0)) || ((b.seenDreams || 0) - (a.seenDreams || 0))
const totalCost = (o) => round1(Object.values(o.bots || {}).reduce((n, b) => n + (b.costMin || 0), 0))

function ledger(loopDir, row, now = Date.now()) {
  try { fs.mkdirSync(loopDir, { recursive: true }); fs.appendFileSync(path.join(loopDir, 'ledger.jsonl'), JSON.stringify({ at: new Date(now).toISOString(), ...row }) + '\n') } catch { /* the order file still has its history */ }
}
function readLedger(loopDir, limit = 200) {
  try { return fs.readFileSync(path.join(loopDir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).slice(-limit).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch { return [] }
}
const event = (o, at, ev, fields = {}) => { o.history = [...(o.history || []), { at, ev, ...fields }].slice(-60) }

// which candidates need a model's judgement this dream: no open order yet, and not judged "not a bug" recently at about this cost
function undecided(loopDir, cands, now = Date.now()) {
  const dec = readJson(path.join(loopDir, 'decisions.json'), {})
  return cands.filter(c => {
    const o = load(loopDir, c.key); if (o && (o.status === 'open' || o.status === 'parked')) return false
    const d = dec[c.key]; if (!d || d.isBug) return true
    return now - Date.parse(d.at) > REASK_MS || c.costMin > Math.max(MIN_LOSS, (d.costMin || 0) * 2)
  })
}

// One dream's result for one bot -> the order files. `decided`: key -> { isBug, title, problem, suggestion, kind, findings: [reviewer keys], why }.
// `commits`: code changes the bot has run ({ at, commit, subject }), used to say what an order went quiet after. -> { opened, reopened, updated, closed }
function sync(loopDir, { bot, cands = [], decided = {}, commits = [], now = Date.now() } = {}) {
  const at = new Date(now).toISOString(), res = { opened: [], reopened: [], updated: [], closed: [] }
  const dec = readJson(path.join(loopDir, 'decisions.json'), {})
  const byKey = new Map(cands.map(c => [c.key, c]))
  for (const c of cands) {
    const d = decided[c.key]
    if (d) dec[c.key] = { at, isBug: !!d.isBug, why: cut(d.why || d.problem, 240), costMin: c.costMin, bot }
    let o = load(loopDir, c.key)
    const live = o && (o.status === 'open' || o.status === 'parked')
    if (!live && !(d && d.isBug)) continue                      // not an order, and nobody called it a bug this time
    const numbers = { costMin: c.costMin, counts: c.counts, line: c.line, evidence: c.evidence || [], at, quiet: 0 }
    if (!o) {
      o = { v: 1, key: c.key, type: c.type, step: c.step || null, status: 'open', title: cut(d.title || c.line, 120), kind: d.kind || 'bug', problem: cut(d.problem, 600), suggestion: cut(d.suggestion, 400),
        findings: [], snapshots: [], bots: {}, costMin: 0, cost: [], openedAt: at, updatedAt: at, seenDreams: 0, reopens: 0, pr: null, history: [] }
      event(o, at, 'opened', { bot, costMin: c.costMin, why: cut(d.why, 200) }); ledger(loopDir, { order: o.key, ev: 'opened', bot, costMin: c.costMin, title: o.title }, now); res.opened.push(o.key)
    } else if (!live) {
      const was = o.status
      o.status = 'open'; o.reopens = (o.reopens || 0) + 1; o.closed = null
      event(o, at, 'reopened', { bot, costMin: c.costMin, was, afterPr: o.pr || null }); ledger(loopDir, { order: o.key, ev: 'reopened', bot, costMin: c.costMin, was, pr: o.pr || null }, now); res.reopened.push(o.key)
    } else res.updated.push(o.key)
    if (d && d.isBug) { if (d.title) o.title = cut(d.title, 120); if (d.problem) o.problem = cut(d.problem, 600); if (d.suggestion) o.suggestion = cut(d.suggestion, 400); if (d.kind) o.kind = d.kind }
    for (const k of [...((d && d.findings) || []), ...(c.finding ? [c.finding] : [])]) if (typeof k === 'string' && k && !o.findings.includes(k)) o.findings.push(k)
    o.findings = o.findings.slice(-12)
    o.snapshots = [...new Set([...(c.snapshots || []).map(id => `${bot}/${id}`), ...(o.snapshots || [])])].slice(0, 8)       // newest first, with the bot whose folder holds the file
    o.bots[bot] = numbers; o.costMin = totalCost(o); o.updatedAt = at; o.seenDreams = (o.seenDreams || 0) + 1
    o.cost = [...(o.cost || []), { at, bot, min: c.costMin }].slice(-60)
    writeJson(fileOf(loopDir, o.key), o)
  }
  // orders this bot is part of that the journal no longer shows: count the quiet dreams, close when every bot in the order has been quiet long enough
  for (const o of list(loopDir)) {
    if (o.status !== 'open' || !o.bots || !o.bots[bot] || byKey.has(o.key)) continue
    o.bots[bot] = { ...o.bots[bot], costMin: 0, quiet: (o.bots[bot].quiet || 0) + 1 }
    o.costMin = totalCost(o)
    o.cost = [...(o.cost || []), { at, bot, min: 0 }].slice(-60)
    if (Object.values(o.bots).every(b => (b.quiet || 0) >= QUIET_DREAMS)) {
      const lastSeen = Object.values(o.bots).map(b => b.at).sort().pop()
      const after = commits.filter(c => c.at > lastSeen).slice(-1)[0] || null
      const reason = after ? `went quiet after the bot moved to ${String(after.commit).slice(0, 9)} "${cut(after.subject, 90)}"` : 'went quiet with no code change in between'
      o.status = 'closed'; o.closed = { at, code: after ? 'quiet-after-deploy' : 'quiet', reason, commit: after ? after.commit : null }
      event(o, at, 'closed', { reason }); ledger(loopDir, { order: o.key, ev: 'closed', reason, commit: after ? after.commit : null }, now); res.closed.push(o.key)
    }
    o.updatedAt = at
    writeJson(fileOf(loopDir, o.key), o)
  }
  writeJson(path.join(loopDir, 'decisions.json'), dec)
  try { fs.writeFileSync(path.join(loopDir, 'WORK-ORDERS.md'), toMarkdown(list(loopDir), at)) } catch { /* the json files are the record */ }
  return res
}

// a later job (the fixer, the deployer) records a step in an order's life: record(loopDir, key, 'pr', { pr: 290 }), 'deploy', 'verdict', 'parked', 'fixed'
function record(loopDir, key, ev, fields = {}, now = Date.now()) {
  const o = load(loopDir, key); if (!o) return null
  const at = new Date(now).toISOString()
  if (ev === 'pr' && fields.pr) o.pr = fields.pr
  if (ev === 'fixed' || ev === 'parked' || ev === 'closed') o.status = ev
  if (ev === 'fixed' || ev === 'closed') o.closed = { at, code: ev, reason: cut(fields.reason || (ev === 'fixed' && o.pr ? `fixed by PR #${o.pr}` : ev), 240), pr: o.pr || null }
  event(o, at, ev, fields); o.updatedAt = at
  writeJson(fileOf(loopDir, key), o); ledger(loopDir, { order: key, ev, ...fields }, now)
  return o
}

function toMarkdown(orders, at) {
  const open = orders.filter(o => o.status === 'open' || o.status === 'parked')
  const L = ['# Work orders', '', `_Updated ${at}. Problems only a code change can fix, most costly first. Cost is an estimate of minutes lost in the last 24 hours (stalled under an alarm, runs that failed, ${DEATH_MIN} per death)._`, '']
  if (!open.length) L.push('_No open work orders._', '')
  for (const o of open) {
    L.push(`## ${o.costMin} min · ${o.title}`, `\`${o.key}\` · ${o.kind} · ${o.status} · opened ${o.openedAt} · seen in ${o.seenDreams} dream(s)${o.reopens ? ` · reopened ${o.reopens}x` : ''}${o.pr ? ` · PR #${o.pr}` : ''}`, '')
    if (o.problem) L.push(o.problem, '')
    for (const [b, n] of Object.entries(o.bots || {})) L.push(`- ${b}: ${n.line} (${n.costMin} min lost)`, ...(n.evidence || []).map(e => `  - ${e}`))
    if (o.suggestion) L.push('', `Where to look: ${o.suggestion}`)
    if ((o.findings || []).length) L.push('', `Reviewer findings: ${o.findings.map(k => `\`${k}\``).join(', ')}`)
    if ((o.snapshots || []).length) L.push('', `Snapshots to rebuild it from (brain/state/snapshots in that bot's folder): ${o.snapshots.join(', ')}`)
    L.push('')
  }
  const done = orders.filter(o => o.status === 'closed' || o.status === 'fixed').sort((a, b) => ((b.closed && b.closed.at) || '') > ((a.closed && a.closed.at) || '') ? 1 : -1).slice(0, 10)
  if (done.length) { L.push('## Recently closed', ''); for (const o of done) L.push(`- ${o.title} (\`${o.key}\`): ${(o.closed && o.closed.reason) || o.status}`); L.push('') }
  return L.join('\n')
}

// the code changes a bot has run, oldest first, from its runlog (a row is written at every start, so repeats of the same commit are dropped)
function botCommits(bot, limit = 40) {
  let text = ''; try { text = fs.readFileSync(path.join(bot.dir, 'brain', 'state', 'runlog', 'commits.jsonl'), 'utf8') } catch { return [] }
  const out = []
  for (const l of text.split('\n').filter(Boolean)) { let r; try { r = JSON.parse(l) } catch { continue } if (!r || !r.commit || !Number.isFinite(r.t)) continue; if (out.length && out[out.length - 1].commit === r.commit) continue; out.push({ at: new Date(r.t).toISOString(), commit: String(r.commit), subject: String(r.subject || '') }) }
  return out.slice(-limit)
}

module.exports = { candidates, undecided, sync, record, list, load, ledger, readLedger, toMarkdown, botCommits, slug, fileOf, dirOf, DEATH_MIN, QUIET_DREAMS, MIN_LOSS }
