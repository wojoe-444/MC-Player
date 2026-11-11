// Data for the dashboard's Progress page (/api/progress): how far each bot is, from the bot's OWN records. Read-only, no dependencies, and no
// requirement on the brain/ code being present next to the server (the installed app bundles only dashboard/): everything is read from the bot folders.
//
//   roadmap  brain/state/roadmap.json (written by the bot's roadmap module every 10 min); when it is missing or stale, the predicates in the code folder
//            are evaluated here on the same records, so the page is never blank just because the module has not run yet
//   builds   the shared registry (shafts, rooms) joined with the bot's self-inspection (brain/state/inspect/summary.json), plus tree farms and pens
//   days     per in-game day: autopilot-state.json dayStats (iron, ingots, tunnels, deaths, armor, commits), the day in progress included
//            per real (UTC) day: the journal's day rollups (brain/state/journal/YYYY-MM-DD.day.json), items from acquired.jsonl when there is no journal yet
//
// A missing file is a missing section, never a made-up zero: the page says what has no record yet.
'use strict'
const fs = require('fs')
const path = require('path')

// The phases of ROADMAP.md. `total` comes from the roadmap predicates; a phase with no predicates yet is shown as "nothing measured yet".
const PHASES = [
  { id: '1', name: 'Subsistence', blurb: 'Food, stone tools, bed, shelter, torches' },
  { id: '2', name: 'Industry and structure', blurb: 'Shaft, storage room, farms, lit area, mob farm' },
  { id: '3', name: 'Structured mining base', blurb: 'A mining room at one Y level, diamond pickaxe, villager hall' },
  { id: '3.5', name: 'Nether portal', blurb: 'Portal with a safe shell on the far side' },
  { id: '4', name: 'Enchanting and potions', blurb: 'Bookshelves, Mending, brewing, then diamond gear' },
  { id: '5', name: 'Endgame', blurb: 'Stronghold, dragon kit, the Ender Dragon' },
]
const ROADMAP_FRESH_MS = 60 * 60000
const DAYS_SHOWN = 14, GAME_DAYS_SHOWN = 30
const IRON = /^(raw_iron|iron_ore|deepslate_iron_ore)$/, INGOT = /^iron_ingot$/, DIAMOND = /^(diamond|diamond_ore|deepslate_diamond_ore)$/

const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')) } catch { return d } }
const arr = (a) => (Array.isArray(a) ? a : [])
const mtime = (f) => { try { return fs.statSync(f).mtimeMs } catch { return null } }
const isoOrNull = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : null)
const round1 = (n) => Math.round(n * 10) / 10

// ---------------------------------------------------------------- roadmap
// Predicates from the bot's code folder, evaluated on this bot's records. Cached per bot for 30 s (the page polls).
const liveCache = new Map()
function evaluateLive({ codeDir, stateDir, botDir, registry }) {
  const key = codeDir + "|" + stateDir, c = liveCache.get(key)
  if (c && Date.now() - c.at < 30000) return c.v
  let v = null
  try {
    const file = path.join(codeDir, 'brain', 'roadmap', 'predicates.js')
    if (fs.existsSync(file)) {
      const P = require(file)
      const facts = P.loadFacts(stateDir, botDir)
      if (registry) facts.registry = registry
      v = P.evaluate(facts)
    }
  } catch { v = null }
  liveCache.set(key, { at: Date.now(), v })
  return v
}

function roadmapFor({ stateDir, botDir, codeDir, registry, now }) {
  const file = path.join(stateDir, 'roadmap.json')
  const saved = readJson(file)
  const savedAt = saved ? (Date.parse(saved.at) || mtime(file)) : null
  let src = null, data = null, at = null
  if (saved && saved.items && now - savedAt < ROADMAP_FRESH_MS) { src = 'bot'; data = saved; at = savedAt }
  else {
    const live = evaluateLive({ codeDir, stateDir, botDir, registry })
    if (live) { src = 'live'; data = live; at = now }
    else if (saved && saved.items) { src = 'stale'; data = saved; at = savedAt }
  }
  if (!data) return null
  const items = arr(data.items).map(i => ({ id: i.id, phase: String(i.phase), title: i.title, status: i.status, needs: i.needs || null }))
  const phases = PHASES.map(p => {
    const its = items.filter(i => i.phase === p.id)
    return { ...p, total: its.length, measured: its.filter(i => i.status !== 'unmeasured').length, done: its.filter(i => i.status === 'done').length, items: its }
  })
  return { source: src, at: isoOrNull(at), phases }
}

// ---------------------------------------------------------------- builds
const ownerName = (by) => (by ? String(by) : null)
const fmtPos = (p) => (Array.isArray(p) && p.length === 3 ? p.map(Math.round) : null)
const centre = (box) => (box && Number.isFinite(box.x0) ? [Math.round((box.x0 + box.x1) / 2), Math.round((box.y0 + box.y1) / 2), Math.round((box.z0 + box.z1) / 2)] : null)

// Shafts and rooms from the shared registry (both bots read and write it). Each room gets the verdict of its self-inspection when one exists.
function buildsFrom(registry, inspections) {
  const out = []
  if (!registry || !registry.worlds) return out
  const insp = {}
  for (const sum of inspections) for (const [id, r] of Object.entries((sum && sum.rooms) || {})) { if (!insp[id] || String(r.at) > String(insp[id].at)) insp[id] = r }
  const worlds = Object.values(registry.worlds)
  const many = worlds.length > 1
  for (const w of worlds) {
    for (const s of arr(w.shafts)) {
      out.push({ id: s.id, kind: 'shaft', label: `Shaft ${s.id}`, pos: fmtPos(s.entry), depth: s.entry && s.bottom ? Math.round(s.entry[1] - s.bottom[1]) : null,
        by: ownerName(s.by), at: Number.isFinite(s.at) ? isoOrNull(s.at) : null, inspection: null, status: s.bottom ? 'built' : 'digging' })
    }
    for (const r of arr(w.rooms)) {
      const i = insp[r.id] || null
      const status = i ? (i.skipped ? 'unchecked' : i.ok ? 'passes' : 'faults') : 'unchecked'
      out.push({ id: r.id, kind: r.type || 'room', label: r.id, pos: centre(r.box), by: ownerName(r.by), at: Number.isFinite(r.at) ? isoOrNull(r.at) : null,
        chests: arr(r.chests).length, hasReset: Array.isArray(r.reset) && r.reset.length === 3 ? true : undefined,
        inspection: i && !i.skipped ? { at: i.at || null, faults: i.faults || 0, warns: i.warns || 0, headline: arr(i.headline).slice(0, 3) } : null, status })
    }
  }
  if (many) out.forEach(b => { b.note = 'several worlds in the registry' })
  return out
}

// Farms and pens only the bot itself records (state files in its own folder).
function ownBuilds(stateDir) {
  const out = []
  const tf = readJson(path.join(stateDir, 'treefarm-state.json'))
  for (const f of arr(tf && tf.farms)) {
    out.push({ id: 'tree-' + f.id, kind: 'tree farm', label: `Tree farm ${f.id}`, pos: Number.isFinite(f.x) ? [f.x, f.y, f.z] : null, detail: `${f.cols || '?'}x${f.rows || '?'} ${f.species || ''}`.trim(),
      status: ((tf.stats || {}).planted || 0) > 0 && ((tf.stats || {}).lit || 0) > 0 ? 'working' : 'built', inspection: null })
  }
  const hu = readJson(path.join(stateDir, 'husbandry-state.json'))
  for (const p of arr(hu && hu.pens)) out.push({ id: 'pen-' + p.id, kind: 'animal pen', label: `Animal pen ${p.id}`, pos: Number.isFinite(p.ox) ? [p.ox, p.oy, p.oz] : null, detail: p.w ? `${p.w}x${p.d}` : '', status: p.built && p.lit ? 'working' : p.built ? 'built' : 'digging', inspection: null })
  for (const l of arr(hu && hu.lichen)) out.push({ id: 'lichen-' + (l.id || out.length), kind: 'glow lichen', label: 'Glow lichen wall', pos: Number.isFinite(l.x) ? [l.x, l.y, l.z] : null, detail: l.last ? `${l.last.faces || 0} faces` : '', status: l.last && l.last.faces > 0 ? 'working' : 'built', inspection: null })
  const mf = readJson(path.join(stateDir, 'mobfarm.json'))
  if (mf && mf.killBox) out.push({ id: 'mobfarm-record', kind: 'mob farm', label: 'Mob farm (bot record)', pos: Array.isArray(mf.killBox) ? fmtPos(mf.killBox) : (mf.killBox && Number.isFinite(mf.killBox.x) ? [mf.killBox.x, mf.killBox.y, mf.killBox.z] : null), detail: `${arr(mf.chests).length} chest(s)`, status: 'built', inspection: null })
  return out
}

// ---------------------------------------------------------------- days
function gameDaysFrom(stateDir) {
  const st = readJson(path.join(stateDir, 'autopilot-state.json'))
  if (!st) return null
  const rows = arr(st.dayStats).map(d => ({ day: d.day, iron: d.iron || 0, ingots: d.ingots || 0, tunnels: d.tunnels || 0, deaths: d.deaths || 0, armor: d.armor || null, commits: arr(d.commits), done: true }))
  if (st.dayStat && st.dayStat.day != null) {
    const d = st.dayStat
    rows.push({ day: d.day, iron: d.iron || 0, ingots: d.ingots || 0, tunnels: d.tunnels || 0, deaths: d.deaths || 0, armor: null, commits: [], done: false })
  }
  return rows.slice(-GAME_DAYS_SHOWN)
}

// acquired.jsonl -> { 'YYYY-MM-DD': { items, iron, diamonds } } (dropped-item pickups only)
function acquiredByDate(stateDir) {
  let text = ''
  try { text = fs.readFileSync(path.join(stateDir, 'acquired.jsonl'), 'utf8') } catch { return {} }
  const out = {}
  for (const line of text.split('\n')) {
    if (!line) continue
    let j; try { j = JSON.parse(line) } catch { continue }
    if (!j || typeof j.item !== 'string' || !(j.n > 0) || !Number.isFinite(j.t)) continue
    const d = new Date(j.t).toISOString().slice(0, 10), o = out[d] || (out[d] = { items: 0, iron: 0, ingots: 0, diamonds: 0 })
    o.items += j.n
    if (IRON.test(j.item)) o.iron += j.n
    else if (INGOT.test(j.item)) o.ingots += j.n
    else if (DIAMOND.test(j.item)) o.diamonds += j.n
  }
  return out
}

// Online time of one UTC day, from the journal's event file: the sum of the gaps between consecutive events, each gap capped at
// ONLINE_GAP_CAP_MS (the rollup's own cap for a step: longer is a hole in the record, not play), and a gap that ends in a `start`
// event counted as nothing (the process was down). It is the denominator of every per-player-hour figure on the dashboard.
const ONLINE_GAP_CAP_MS = 30 * 60000
function onlineMinutes(events) {
  const ts = []
  for (const e of arr(events)) { const t = e && Date.parse(e.at); if (Number.isFinite(t)) ts.push([t, e.k]) }
  ts.sort((a, b) => a[0] - b[0])
  let ms = 0
  for (let i = 1; i < ts.length; i++) if (ts[i][1] !== 'start') ms += Math.min(ONLINE_GAP_CAP_MS, ts[i][0] - ts[i - 1][0])
  return ms / 60000
}
const onlineCache = new Map()                                  // file -> { sig, min }: the page polls every 20 s and a day file can be large
function onlineMinFor(file) {
  let st; try { st = fs.statSync(file) } catch { return null }
  const sig = st.size + ':' + st.mtimeMs, c = onlineCache.get(file)
  if (c && c.sig === sig) return c.min
  let text; try { text = fs.readFileSync(file, 'utf8') } catch { return null }
  const evs = []
  for (const line of text.split('\n')) {
    if (!line) continue
    const m = /"at":"([^"]+)"/.exec(line), k = /"k":"([^"]+)"/.exec(line)       // two fields only: no need to parse every event
    if (m) evs.push({ at: m[1], k: k ? k[1] : '' })
  }
  const min = round1(onlineMinutes(evs))
  onlineCache.set(file, { sig, min })
  return min
}

// One row per UTC date, newest last: the journal's rollup where there is one, the acquired log for the rest.
function realDaysFrom(stateDir) {
  const jdir = path.join(stateDir, 'journal')
  let dates = []
  try { dates = fs.readdirSync(jdir).map(f => (/^(\d{4}-\d\d-\d\d)\.day\.json$/.exec(f) || [])[1]).filter(Boolean) } catch { /* no journal yet */ }
  const acq = acquiredByDate(stateDir)
  const all = [...new Set([...dates, ...Object.keys(acq)])].sort().slice(-DAYS_SHOWN)
  const hasJournal = dates.length > 0
  const rows = all.map(date => {
    const j = dates.includes(date) ? readJson(path.join(jdir, date + '.day.json')) : null
    const a = acq[date] || null
    const row = { date, journal: !!j, deaths: null, stalledMin: null, alarms: null, flagsHigh: null, commits: null, activeMin: null, onlineMin: null, topSteps: [], iron: null, ingots: null, diamonds: null, items: null }
    if (j) {
      row.deaths = arr(j.deaths).length
      row.stalledMin = round1((j.alarms && j.alarms.stalledMin) || 0)
      row.alarms = (j.alarms && j.alarms.raised) || 0
      row.flagsHigh = j.flagsHigh || 0
      row.commits = arr(j.commits).length
      const steps = Object.entries(j.steps || {}).map(([id, s]) => ({ id, minutes: round1(s.minutes || 0), runs: s.runs || 0, fail: (s.fail || 0) + (s.timeout || 0) }))
      row.activeMin = round1(steps.reduce((n, s) => n + s.minutes, 0))
      row.onlineMin = onlineMinFor(path.join(jdir, date + '.jsonl'))     // null when the event file is gone (rates then show a dash, never a made-up hour)
      row.topSteps = steps.sort((x, y) => y.minutes - x.minutes).slice(0, 4)
      const its = j.items || {}
      row.iron = Object.entries(its).filter(([k]) => IRON.test(k)).reduce((n, [, v]) => n + v, 0)
      row.ingots = Object.entries(its).filter(([k]) => INGOT.test(k)).reduce((n, [, v]) => n + v, 0)
      row.diamonds = Object.entries(its).filter(([k]) => DIAMOND.test(k)).reduce((n, [, v]) => n + v, 0)
      row.items = Object.values(its).reduce((n, v) => n + v, 0)
    }
    if (a && !j) { row.iron = a.iron; row.ingots = a.ingots; row.diamonds = a.diamonds; row.items = a.items }
    return row
  })
  return { rows, hasJournal }
}

// ---------------------------------------------------------------- put together
function botProgress(bot, { codeDir, registry, now }) {
  const stateDir = path.join(bot.dir, 'brain', 'state')
  const insp = readJson(path.join(stateDir, 'inspect', 'summary.json'))
  const real = realDaysFrom(stateDir)
  return {
    id: bot.id, name: bot.name,
    roadmap: roadmapFor({ stateDir, botDir: bot.dir, codeDir, registry, now }),
    inspectionAt: insp ? insp.updatedAt || null : null,
    inspection: insp,
    ownBuilds: ownBuilds(stateDir),
    gameDays: gameDaysFrom(stateDir),
    days: real.rows, hasJournal: real.hasJournal,
  }
}

function buildProgress({ bots, codeDir, registryFile, now = Date.now() }) {
  const registry = registryFile ? readJson(registryFile) : null
  const per = bots.map(b => botProgress(b, { codeDir, registry, now }))
  const builds = buildsFrom(registry, per.map(p => p.inspection))
  for (const p of per) delete p.inspection
  return {
    generatedAt: new Date(now).toISOString(),
    phases: PHASES.map(({ id, name, blurb }) => ({ id, name, blurb })),
    registry: { found: !!registry, shared: true },
    builds,
    bots: Object.fromEntries(per.map(p => [p.id, p])),
  }
}

module.exports = { onlineMinutes, buildProgress, PHASES, buildsFrom, gameDaysFrom, realDaysFrom, roadmapFor, acquiredByDate }
