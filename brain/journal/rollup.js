// brain/journal/rollup: one day of journal events -> the day's numbers. Pure: events in, a plain object out.
// This is what the later jobs read first (the dawn brief, the dream, the digest); the event file is there for when a number needs explaining.
'use strict'

const STEP_GAP_CAP_MS = 30 * 60000        // a step "lasting" longer than this is a gap in the record (the bot was off), not work
const MAX_SALIENT = 80, MAX_GAME_DAYS = 80
const round1 = (n) => Math.round(n * 10) / 10

function newStep() { return { runs: 0, minutes: 0, ok: 0, fail: 0, timeout: 0, other: 0, alarms: 0, stalledMin: 0 } }
function addItems(into, items) { for (const [k, n] of Object.entries(items || {})) if (n > 0) into[k] = (into[k] || 0) + n }
function top(obj, n) { return Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n)) }

function salientLine(e) {
  const o = { at: e.at, k: e.k }
  if (e.k === 'death') o.what = `${e.cause || 'died'}${e.doing ? ` while ${e.doing}` : ''}`
  else if (e.k === 'alarm') o.what = `${e.type} cleared after ${e.secs}s at fix level ${e.level}`
  else if (e.k === 'gate') o.what = `${e.rule} blocked ${e.packet || 'a packet'} x${e.n}: ${e.why || ''}`.trim()
  else if (e.k === 'trample') o.what = `farmland at ${(e.pos || []).join(',')} turned to dirt${e.by === 'bot' ? ` after the bot's ${e.how || 'landing'}` : ' (not clearly the bot)'}${e.space ? ` in ${e.space}` : ''}${e.step ? ` during ${e.step}` : ''}`
  else if (e.k === 'leftover') o.what = e.what === 'tree' ? `half-felled ${e.species || ''} tree at ${(e.pos || []).join(',')}: ${e.n} log(s) stand on nothing, ${e.leaves || 0} leaves held up` : `${e.kind} of ${e.block || 'filler'} at ${(e.pos || []).join(',')}: ${e.n} block(s), ${e.h} high, placed by ${e.by || 'a bot'}${e.via ? ` during ${e.via}` : ''}, standing ${e.standingMin} min`
  else if (e.k === 'flag') o.what = `${e.kind}: ${e.msg || ''}`.trim()
  else if (e.k === 'chat') o.what = `${e.from}: ${e.text}`
  else if (e.k === 'first') o.what = `first ${e.what}: ${e.id}`
  else if (e.k === 'registry') o.what = [e.added && e.added.length ? `added ${e.added.join(', ')}` : '', e.removed && e.removed.length ? `removed ${e.removed.join(', ')}` : ''].filter(Boolean).join('; ')
  else if (e.k === 'outcome') o.what = `${e.build} (${e.kindOf || 'build'}) is ${e.state}${e.why ? ': ' + e.why : ''}`
  else if (e.k === 'schematic') o.what = e.ev === 'state' ? `${e.id} (${e.kindOf || 'build'}) is ${e.state} at ${e.pct}%${e.off != null ? `, ${e.off} cells off` : ''}${e.wrong && e.wrong.length ? `; first off: ${e.wrong.slice(0, 2).join(' | ')}` : ''}` : e.ev === 'start' ? `started following ${e.id} at ${(e.at || []).join(',')}: ${e.reason || ''}` : `saved the schematic ${e.id}`
  else o.what = e.text || e.msg || ''
  if (o.what.length > 220) o.what = o.what.slice(0, 219) + '…'
  return o
}

function rollup(events, { date = null } = {}) {
  const evs = (events || []).filter(e => e && e.at && e.k).slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
  const out = {
    v: 1, date, from: evs.length ? evs[0].at : null, to: evs.length ? evs[evs.length - 1].at : null, events: evs.length,
    steps: {}, alarms: { raised: 0, cleared: 0, stalledMin: 0, maxLevel: 0, byType: {} }, flags: {}, flagsHigh: 0,
    deaths: [], trampled: { n: 0, byHow: {}, bySpace: {}, byStep: {}, last: null }, leftovers: { scaffold: { ids: {}, last: null }, trees: { ids: {}, last: null } }, items: {}, firsts: [], gate: {}, commits: [], starts: 0, chat: 0, reflexes: 0, notes: 0, salient: [], salientDropped: 0, gameDays: {}
  }
  const step = (id) => (out.steps[id] = out.steps[id] || newStep())
  const days = out.gameDays
  let day = null, cur = null                       // cur = the step the bot is in: { id, t }
  const gd = () => { if (day == null) return null; return (days[day] = days[day] || { from: null, to: null, steps: {}, deaths: 0, alarms: 0, stalledMin: 0, items: {} }) }
  const open = new Map()                           // alarm id -> the step it was raised in (ids repeat, so the latest raise wins)
  const closeStep = (t) => {
    if (!cur) return
    const mins = Math.min(STEP_GAP_CAP_MS, Math.max(0, t - cur.t)) / 60000
    step(cur.id).minutes += mins
    const g = gd(); if (g) { const s = (g.steps[cur.id] = g.steps[cur.id] || { runs: 0, minutes: 0 }); s.minutes += mins }
    cur = null
  }
  for (const e of evs) {
    const t = Date.parse(e.at)
    // an in-game day turned: the running step's minutes so far belong to the old day
    if (Number.isFinite(e.day) && e.day !== day) { if (cur) { const id = cur.id; closeStep(t); cur = { id, t } } day = e.day }
    const g = gd(); if (g) { if (!g.from) g.from = e.at; g.to = e.at }
    switch (e.k) {
      case 'step': {
        closeStep(t); cur = { id: e.step, t }
        step(e.step).runs++
        if (g) { const s = (g.steps[e.step] = g.steps[e.step] || { runs: 0, minutes: 0 }); s.runs++ }
        break
      }
      case 'result': { const s = step(e.step); if (e.out === 'ok' || e.out === 'explore') s.ok++; else if (e.out === 'fail' || e.out === 'error') s.fail++; else if (e.out === 'timeout') s.timeout++; else s.other++; break }
      case 'start': out.starts++; closeStep(t); break
      case 'alarm': {
        out.alarms.byType[e.type] = out.alarms.byType[e.type] || { raised: 0, cleared: 0, stalledMin: 0 }
        if (e.ev === 'raised') {
          out.alarms.raised++; out.alarms.byType[e.type].raised++
          const id = e.step || (cur && cur.id) || 'unknown'
          open.set(e.id, id); step(id).alarms++
          if (g) g.alarms++
        } else {
          const mins = (e.secs || 0) / 60, id = open.get(e.id) || (cur && cur.id) || 'unknown'
          open.delete(e.id)
          out.alarms.cleared++; out.alarms.byType[e.type].cleared++; out.alarms.byType[e.type].stalledMin += mins
          out.alarms.stalledMin += mins; out.alarms.maxLevel = Math.max(out.alarms.maxLevel, e.level || 0)
          step(id).stalledMin += mins
          if (g) g.stalledMin += mins
        }
        break
      }
      case 'flag': out.flags[e.kind] = (out.flags[e.kind] || 0) + 1; if (e.sev === 'high') out.flagsHigh++; break
      case 'death': out.deaths.push({ at: e.at, cause: e.cause || null, pos: e.pos || null, doing: e.doing || null }); if (g) g.deaths++; break
      case 'items': addItems(out.items, e.items); if (g) addItems(g.items, e.items); break
      case 'first': out.firsts.push(`${e.what}:${e.id}`); break
      case 'gate': { const r = (out.gate[e.rule] = out.gate[e.rule] || { violations: 0, blocked: 0 }); if (e.blocked) r.blocked += e.n || 1; else r.violations += e.n || 1; break }
      case 'commit': if (!e.same && !out.commits.some(c => c.commit === e.commit)) out.commits.push({ at: e.at, commit: e.commit, subject: e.subject || '' }); break
      case 'trample': {
        if (e.by !== 'bot') break                                                    // an unexplained one is on the record (the day file) but is not counted against the bot
        const tr = out.trampled; tr.n++
        const bump = (m, k) => { m[k] = (m[k] || 0) + 1 }
        bump(tr.byHow, e.how || 'unknown'); bump(tr.bySpace, e.space || 'unassigned'); bump(tr.byStep, e.step || e.task || 'unknown')
        tr.last = { at: e.at, pos: e.pos || null, how: e.how || null }
        break
      }
      case 'leftover': {                                                              // one entry per cluster id: the latest report of it wins (it grows or shrinks while it stands)
        const bucket = out.leftovers[e.what === 'tree' ? 'trees' : 'scaffold']
        bucket.ids[e.id] = { at: e.at, kind: e.kind || null, pos: e.pos || null, n: e.n || 0, h: e.h || 0, leaves: e.leaves || 0, species: e.species || null, block: e.block || null, by: e.by || null, via: e.via || null, standingMin: e.standingMin || 0 }
        bucket.last = { at: e.at, id: e.id, pos: e.pos || null }
        break
      }
      case 'chat': out.chat++; break
      case 'reflex': out.reflexes++; break
      case 'note': out.notes++; break
      default: break
    }
    if (e.sal) { if (out.salient.length < MAX_SALIENT) out.salient.push(salientLine(e)); else out.salientDropped++ }
  }
  if (evs.length) closeStep(Date.parse(out.to))
  for (const s of Object.values(out.steps)) { s.minutes = round1(s.minutes); s.stalledMin = round1(s.stalledMin) }
  out.alarms.stalledMin = round1(out.alarms.stalledMin)
  for (const a of Object.values(out.alarms.byType)) a.stalledMin = round1(a.stalledMin)
  const keys = Object.keys(days).map(Number).sort((a, b) => a - b)
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_GAME_DAYS))) delete days[k]
  for (const g of Object.values(days)) { for (const s of Object.values(g.steps)) s.minutes = round1(s.minutes); g.stalledMin = round1(g.stalledMin); g.items = top(g.items, 12) }
  return out
}

module.exports = { rollup, salientLine, STEP_GAP_CAP_MS }
