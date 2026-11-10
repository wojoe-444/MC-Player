// brain/journal/parse: the pure parts of the journal (no bot, no clock, no files). Each function turns one row of an existing log into one journal event,
// or null when the row carries nothing worth keeping. The event shape is in brain/journal/README.md.
'use strict'

const iso = (t) => { const d = new Date(t); return Number.isFinite(d.getTime()) ? d.toISOString() : null }
const cut = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }

// lessons.md is not line based: the watchdog writes "\n- <entry>" and the death post-mortem writes "- <entry>\n", so two entries can share a line.
// An entry starts at "- YYYY-MM-DD HH:MM [tag] " and runs to the next such start.
const ENTRY = /- (\d{4}-\d\d-\d\d) (\d\d:\d\d) \[([a-z][a-z0-9-]*)\] /g
function splitLessons(text) {
  const src = String(text || ''), out = []
  let m, prev = null
  ENTRY.lastIndex = 0
  while ((m = ENTRY.exec(src))) {
    if (prev) { prev.text = src.slice(prev.from, m.index).trim(); out.push(prev) }
    prev = { at: `${m[1]}T${m[2]}:00.000Z`, tag: m[3], from: m.index + m[0].length, text: '' }
  }
  if (prev) { prev.text = src.slice(prev.from).trim(); out.push(prev) }
  for (const e of out) delete e.from
  return out
}

const RAISED = /^([A-Z]+) (A\d+): ([\s\S]*?)\. Situation: ([\s\S]*?)\. First fix: ([\s\S]*?)\.?$/
const CLEARED = /^(A\d+) ([A-Z]+) cleared after (\d+)s \(fix: ([\s\S]*)\)\.?$/
const REFLEX = /^cave reflex #(\d+): ([\s\S]*?) in sight underground at \(?(-?\d+), ?(-?\d+), ?(-?\d+)\)?/
const DIED = /^DIED(?: \(([\s\S]*?)\))? at (?:(-?\d+),(-?\d+),(-?\d+)|unknown)(, underground)?(?:, light (\d+))?\. Health trail ([\s\S]*?)\. Doing: ([\s\S]*?)\. Had: ([\s\S]*?)\. Lessons: ([\s\S]*?)$/
const level = (fix) => { const m = /\bL(\d)\b/.exec(String(fix || '')); return m ? Number(m[1]) : 0 }
const pos3 = (s) => { const m = /(-?\d+)[, ]+(-?\d+)[, ]+(-?\d+)/.exec(String(s || '')); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null }

// One lessons.md entry ({ at, tag, text } from splitLessons) -> one event.
function lessonEvent(e) {
  if (!e || !e.at) return null
  const t = e.text || ''
  if (e.tag === 'watchdog') {
    let m = RAISED.exec(t)
    if (m) {
      const sit = m[4], pick = (re) => { const x = re.exec(sit); return x && x[1] !== 'null' && x[1] !== 'undefined' ? x[1] : null }
      const ev = { at: e.at, k: 'alarm', ev: 'raised', type: m[1], id: m[2], cause: cut(m[3], 200), step: pick(/\bstep=(\S+)/), task: pick(/\btask=(\S+)/), pos: pos3(pick(/\bpos=\(([^)]*)\)/)), fix: cut(m[5], 160), level: level(m[5]) || 1 }
      const hp = pick(/\bhp=(\d+)/), night = pick(/\bnight=(true|false)/)
      if (hp != null) ev.hp = Number(hp)
      if (night != null) ev.night = night === 'true'
      return ev
    }
    m = CLEARED.exec(t)
    if (m) {
      const lv = level(m[4]) || 1, ev = { at: e.at, k: 'alarm', ev: 'cleared', type: m[2], id: m[1], secs: Number(m[3]), level: lv, fix: cut(m[4], 160) }
      if (lv >= 2) ev.sal = 1                                    // the first fix did not work: worth a look
      return ev
    }
    m = REFLEX.exec(t)
    if (m) return { at: e.at, k: 'reflex', n: Number(m[1]), mobs: cut(m[2], 60), pos: [Number(m[3]), Number(m[4]), Number(m[5])] }
    return { at: e.at, k: 'note', tag: e.tag, text: cut(t, 400) }
  }
  if (e.tag === 'safety' && /^DIED\b/.test(t)) {
    const m = DIED.exec(t)
    if (!m) return { at: e.at, k: 'death', text: cut(t, 400), sal: 1 }
    const tail = m[10], adj = /\s*Adjusted: ([\s\S]*?)\.?\s*$/.exec(tail)
    const ev = { at: e.at, k: 'death', cause: cut(m[1] || 'unknown', 120), pos: m[2] != null ? [Number(m[2]), Number(m[3]), Number(m[4])] : null, doing: cut(m[8], 120), had: cut(m[9], 160), lessons: cut(adj ? tail.slice(0, adj.index) : tail, 300).replace(/\.$/, ''), sal: 1 }
    if (m[5]) ev.underground = true
    if (m[6] != null) ev.light = Number(m[6])
    if (adj) ev.adjusted = cut(adj[1], 160)
    return ev
  }
  if (!t) return null
  return { at: e.at, k: 'note', tag: e.tag, text: cut(t, 400) }
}

// runlog/steps.jsonl row { t, day, step, prev, x, y, z, hp, held }
function stepEvent(r) {
  const at = r && iso(r.t); if (!at || !r.step) return null
  const ev = { at, k: 'step', step: String(r.step), prev: r.prev || null }
  if (Number.isFinite(r.day)) ev.day = r.day
  if (Number.isFinite(r.x) && Number.isFinite(r.z)) ev.pos = [r.x, Math.round(r.y), r.z]
  if (Number.isFinite(r.hp)) ev.hp = Math.round(r.hp)
  if (r.held) ev.held = r.held
  return ev
}
// runlog/commits.jsonl row { t, day, commit, subject }: the commit the bot's code is at, written at every start and every change.
// (The row's day is not carried: it is written before the first time packet, so it is 0 on most starts.)
function commitEvent(r) {
  const at = r && iso(r.t); if (!at || !r.commit) return null
  return { at, k: 'commit', commit: String(r.commit), subject: cut(r.subject, 140) }
}
// telemetry/flags.jsonl row { id, at, kind, sev, msg, data, excerpt... }: the excerpt (seconds of raw telemetry) stays where it is, the journal keeps the claim
function flagEvent(r) {
  const at = r && iso(r.at); if (!at || !r.kind) return null
  const ev = { at, k: 'flag', kind: String(r.kind), sev: r.sev || 'low', msg: cut(r.msg, 200) }
  if (r.id) ev.id = String(r.id)
  if (r.data !== undefined) { try { const s = JSON.stringify(r.data); if (s.length <= 200) ev.data = r.data } catch { /* not serialisable */ } }
  return ev
}
// acquired.jsonl rows { t, item, n } -> one 'items' event per 10 minutes (a mining trip is hundreds of cobblestone rows)
const ITEM_BUCKET_MS = 10 * 60000
function itemEvents(rows) {
  const buckets = new Map()
  for (const r of rows || []) {
    if (!r || typeof r.item !== 'string' || !(r.n > 0) || !Number.isFinite(r.t)) continue
    const key = Math.floor(r.t / ITEM_BUCKET_MS), b = buckets.get(key) || { t: 0, items: {} }
    buckets.set(key, b); b.t = Math.max(b.t, r.t); b.items[r.item] = (b.items[r.item] || 0) + r.n
  }
  return [...buckets.values()].map(b => ({ at: iso(b.t), k: 'items', items: b.items }))
}
// gate-log.json "recent" entries { t, rule, packet, why, blocked, sites, owner } -> one event per rule + outcome + owner, with a count
function gateEvents(recent, sinceT = 0) {
  const groups = new Map()
  for (const r of recent || []) {
    if (!r || !Number.isFinite(r.t) || r.t <= sinceT || !r.rule) continue
    const key = `${r.rule}|${r.blocked ? 1 : 0}|${r.owner || ''}|${r.packet || ''}`, g = groups.get(key) || { t: 0, n: 0, r }
    groups.set(key, g); g.n++; g.t = Math.max(g.t, r.t)
  }
  return [...groups.values()].map(({ t, n, r }) => {
    const ev = { at: iso(t), k: 'gate', rule: r.rule, packet: r.packet || null, blocked: !!r.blocked, n, why: cut(r.why, 160) }
    if (r.owner) ev.owner = r.owner
    if (Array.isArray(r.sites) && r.sites[0]) ev.site = String(r.sites[0])
    if (ev.blocked) ev.sal = 1
    return ev
  })
}
// the shared registry { worlds: { key: { rooms: [{ id, type }], shafts: [{ id }] } } } -> the set of things the bots have registered
function registryIds(reg) {
  const out = []
  for (const [wk, w] of Object.entries((reg && reg.worlds) || {})) {
    for (const r of (w && w.rooms) || []) if (r && r.id) out.push(`${wk}/room/${r.type || 'room'}/${r.id}`)
    for (const s of (w && w.shafts) || []) if (s && s.id) out.push(`${wk}/shaft/${s.id}`)
  }
  return out.sort()
}

module.exports = { splitLessons, lessonEvent, stepEvent, commitEvent, flagEvent, itemEvents, gateEvents, registryIds, iso, cut, ITEM_BUCKET_MS }
