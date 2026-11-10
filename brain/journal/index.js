// brain/journal: one searchable record per bot per day, and the day's numbers. An observer: it never moves the bot or touches the world.
// (docs/MEMORY-LOOP.md, job 1. The record existed already, spread over a 256 MB console log, an 840 KB lessons file that is 91% alarm lines, and six
// state files with six shapes. Nothing could ask "what happened yesterday" in one read, so nothing did.)
//
//   brain/state/journal/YYYY-MM-DD.jsonl      one JSON line per event, by the UTC date of the event: { at, k, day?, sal?, ... }  (shapes: README.md)
//   brain/state/journal/YYYY-MM-DD.day.json   that day's rollup (brain/journal/rollup.js): per step runs, minutes, results, alarms; flags; deaths; items; salient events
//   brain/state/journal/state.json            how far each source has been read, and what has been seen before (first-time items and steps)
//   bot._journal = { add(k, fields), dir, rollup(date?) }   for a module that wants to put an event on the record itself
//
// It is mostly a collector. Every 30 s it reads what is new in the logs other modules already write (runlog steps and commits, telemetry flags, the
// items-acquired log, lessons.md with its watchdog alarms and death post-mortems, the packet gate's recent list, the shared registry) and writes each
// as one event. Three things it hears itself: how each routine step ended (G.onStepEnd in goals.js), chat from other players, and the in-game dawn.
// "sal": 1 marks the events a later reader should look at first. Code sets it and it costs nothing: a death, a commit change, a blocked packet, an
// alarm the first fix did not clear, the first high flag of a kind in six hours, a first-time item or step, anything a person says, a registry change.
// Days older than 30 are deleted. Nothing here reads the model, the network or the world.
'use strict'
const fs = require('fs')
const path = require('path')
const P = require('./parse')
const { rollup } = require('./rollup')

const ROOT = path.join(__dirname, '..', '..')
const COLLECT_MS = 30000, HOOK_MS = 5000, ROLLUP_MS = 5 * 60000
const KEEP_DAYS = 30, DAY_MS = 86400000
const MAX_READ_BYTES = 8 * 1024 * 1024          // per source per pass; the rest is picked up on the next pass
const MAX_DAY_BYTES = 16 * 1024 * 1024          // past this a day file takes salient events only (a runaway source must not fill the disk)
const FLAG_QUIET_MS = 6 * 3600000                // a high flag is salient the first time its kind shows up, then not again for this long
const NEAR_MS = 120000                          // an event this close to now gets the bot's current in-game day

const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')) } catch { return d } }
const dateOf = (at) => String(at).slice(0, 10)

function botNames(root = ROOT) {
  const out = new Set()
  try { for (const d of fs.readdirSync(path.join(root, 'bots'))) { const p = readJson(path.join(root, 'bots', d, 'profile.json')); if (p && p.name) out.add(p.name) } } catch { /* no bots folder */ }
  return out
}

// Read what was appended to `file` since `st.pos`. Handles the three ways these logs shrink: renamed to file.1 (runlog), rewritten to its last lines
// (telemetry flags), compacted (acquired). After a shrink the whole file is read again and the caller drops rows at or before st.lastT.
function readNew(file, st, { whole = false } = {}) {
  let size
  try { size = fs.statSync(file).size } catch { return { text: '', rewound: false } }
  let text = '', rewound = false
  if (size < st.pos) {
    try { const old = fs.statSync(file + '.1'); if (old.size > st.pos) text += readRange(file + '.1', st.pos, Math.min(old.size, st.pos + MAX_READ_BYTES)) } catch { /* rewritten in place, not rotated */ }
    st.pos = 0; rewound = true
  }
  if (size > st.pos) {
    const end = Math.min(size, st.pos + MAX_READ_BYTES)
    let chunk = readRange(file, st.pos, end)
    if (!whole || end < size) {                    // line based (or a partial read): stop at the last complete line
      const nl = chunk.lastIndexOf('\n')
      if (nl < 0) { if (end - st.pos >= MAX_READ_BYTES) st.pos = end; chunk = '' }      // one line bigger than the cap: skip it
      else { chunk = chunk.slice(0, nl + 1); st.pos += Buffer.byteLength(chunk, 'utf8') }
    } else st.pos = end
    text += chunk
  }
  return { text, rewound }
}
function readRange(file, from, to) {
  const len = Math.max(0, to - from); if (!len) return ''
  const fd = fs.openSync(file, 'r')
  try { const buf = Buffer.alloc(len); const n = fs.readSync(fd, buf, 0, len, from); return buf.toString('utf8', 0, n) } finally { fs.closeSync(fd) }
}
function jsonLines(text) {
  const out = []
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)) } catch { /* a torn line */ } }
  return out
}

module.exports = function register(api) {
  const { bot } = api
  const now = () => (api.now ? api.now() : Date.now())
  const dir = path.dirname(api.statePath('journal/x'))
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  const stateFile = path.join(dir, 'state.json')
  const registryFile = api.registryFile || process.env.BOT_REGISTRY || path.join(ROOT, '..', 'bot-shared', 'registry.json')
  const bots = api.botNames || botNames(api.repoRoot || ROOT)
  const day = () => (bot.time && Number.isFinite(bot.time.day) ? bot.time.day : null)

  const st = Object.assign({ v: 1, src: {}, gateT: 0, registry: null, items: [], steps: [], lastDay: null, lastCommit: null, flagAt: {} }, readJson(stateFile, {}))
  const seenItems = new Set(st.items), seenSteps = new Set(st.steps)
  const src = (id) => (st.src[id] = st.src[id] || { pos: 0, lastT: 0 })
  const dirty = new Set()
  const counts = { written: 0, dropped: 0 }
  let stateDirty = false, lastRollupAt = 0, lastCollectAt = 0

  function saveState() {
    if (!stateDirty) return
    st.items = [...seenItems]; st.steps = [...seenSteps]
    try { fs.writeFileSync(stateFile, JSON.stringify(st)); stateDirty = false } catch { /* next pass */ }
  }

  // Append events to their day files, oldest first. Events from before the retention window are dropped (a first run reads logs that go back weeks).
  function write(events) {
    const t = now(), oldest = t - KEEP_DAYS * DAY_MS, d = day(), byDate = new Map()
    for (const e of events) {
      if (!e || !e.at || !e.k) continue
      const et = Date.parse(e.at); if (!Number.isFinite(et) || et < oldest) continue
      if (e.day === undefined && d != null && Math.abs(t - et) <= NEAR_MS) e.day = d
      const key = dateOf(e.at), list = byDate.get(key) || []; byDate.set(key, list); list.push(e)
    }
    for (const [date, list] of byDate) {
      list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
      const file = path.join(dir, `${date}.jsonl`)
      let size = 0; try { size = fs.statSync(file).size } catch { /* new day */ }
      const keep = size > MAX_DAY_BYTES ? list.filter(e => e.sal) : list
      counts.dropped += list.length - keep.length
      if (!keep.length) continue
      try { fs.appendFileSync(file, keep.map(e => JSON.stringify(e)).join('\n') + '\n'); counts.written += keep.length; dirty.add(date) } catch { /* a log is a nicety */ }
    }
  }

  const fresh = (rows, s, rewound, tOf) => {       // after a shrink, drop what was already taken; always remember the newest time seen
    const out = rewound ? rows.filter(r => tOf(r) > s.lastT) : rows
    for (const r of out) { const t = tOf(r); if (Number.isFinite(t) && t > s.lastT) s.lastT = t }
    return out
  }
  function firsts(set, what, id, at) { if (!id || set.has(id)) return null; set.add(id); stateDirty = true; return { at, k: 'first', what, id, sal: 1 } }

  function collect() {
    const out = []
    lastCollectAt = now()
    const jsonl = (id, rel, tOf, each) => {
      const s = src(id), before = s.pos, r = readNew(api.statePath(rel), s)
      if (s.pos !== before || r.rewound) stateDirty = true
      if (!r.text) return
      each(fresh(jsonLines(r.text), s, r.rewound, tOf))
    }
    jsonl('steps', 'runlog/steps.jsonl', r => r.t, rows => { for (const r of rows) { const e = P.stepEvent(r); if (!e) continue; const f = firsts(seenSteps, 'step', e.step, e.at); if (f) out.push(f); out.push(e) } })
    jsonl('commits', 'runlog/commits.jsonl', r => r.t, rows => {
      for (const r of rows) { const e = P.commitEvent(r); if (!e) continue; if (e.commit === st.lastCommit) e.same = true; else { st.lastCommit = e.commit; stateDirty = true } out.push(e) }   // same = a restart on the same code
    })
    jsonl('flags', 'telemetry/flags.jsonl', r => Date.parse(r.at), rows => {
      for (const r of rows) {
        const e = P.flagEvent(r); if (!e) continue
        if (e.sev === 'high') { const t = Date.parse(e.at); if (t - (st.flagAt[e.kind] || 0) >= FLAG_QUIET_MS) { e.sal = 1; st.flagAt[e.kind] = t; stateDirty = true } }
        out.push(e)
      }
    })
    jsonl('items', 'acquired.jsonl', r => r.t, rows => {
      for (const e of P.itemEvents(rows)) { for (const name of Object.keys(e.items)) { const f = firsts(seenItems, 'item', name, e.at); if (f) out.push(f) } out.push(e) }
    })
    { // lessons.md: entries, not lines (see parse.splitLessons); a write is one whole entry, so the file is read to its end
      const s = src('lessons'), before = s.pos, r = readNew(api.statePath('lessons.md'), s, { whole: true })
      if (s.pos !== before || r.rewound) stateDirty = true
      if (r.text) for (const en of fresh(P.splitLessons(r.text), s, r.rewound, x => Date.parse(x.at))) { const e = P.lessonEvent(en); if (e) out.push(e) }
    }
    { // the packet gate keeps its last events in one JSON file; take the ones newer than the last taken
      const g = readJson(api.statePath('gate-log.json'))
      if (g && Array.isArray(g.recent) && g.recent.length) {
        const evs = P.gateEvents(g.recent, st.gateT)
        if (evs.length) { st.gateT = Math.max(st.gateT, ...g.recent.map(r => r.t || 0)); stateDirty = true; out.push(...evs) }
      }
    }
    { // rooms and shafts the bots have registered (shared file, both bots see the same change)
      const reg = readJson(registryFile)
      if (reg) {
        const ids = P.registryIds(reg)
        if (!Array.isArray(st.registry)) { st.registry = ids; stateDirty = true }                 // first sight: the baseline, not news
        else {
          const was = new Set(st.registry), is = new Set(ids), added = ids.filter(i => !was.has(i)), removed = st.registry.filter(i => !is.has(i))
          if (added.length || removed.length) { st.registry = ids; stateDirty = true; out.push({ at: P.iso(now()), k: 'registry', added, removed, sal: 1 }) }
        }
      }
    }
    if (out.length) write(out)
    saveState()
    return out.length
  }

  function rollDate(date) {
    const file = path.join(dir, `${date}.jsonl`)
    let text; try { text = fs.readFileSync(file, 'utf8') } catch { return null }
    const r = rollup(jsonLines(text), { date })
    r.builtAt = P.iso(now())
    try { fs.writeFileSync(path.join(dir, `${date}.day.json`), JSON.stringify(r, null, 1)) } catch { return null }
    return r
  }
  function rollDirty() {
    lastRollupAt = now()
    for (const date of [...dirty]) { dirty.delete(date); rollDate(date) }
  }
  function prune() {
    const cutoff = dateOf(P.iso(now() - KEEP_DAYS * DAY_MS))
    try { for (const f of fs.readdirSync(dir)) { const m = /^(\d{4}-\d\d-\d\d)\.(jsonl|day\.json)$/.exec(f); if (m && m[1] < cutoff) { try { fs.unlinkSync(path.join(dir, f)) } catch {} } } } catch { /* nothing to prune */ }
  }

  // ---- what the journal hears itself ----
  const add = (k, fields = {}, { sal = false } = {}) => { const e = { at: P.iso(now()), k, ...fields }; if (sal) e.sal = 1; write([e]); return e }
  const onChat = (user, text) => { try { if (!user || user === bot.username) return; add('chat', { from: String(user), text: P.cut(text, 200) }, { sal: !bots.has(user) }) } catch { /* observer */ } }
  const onStepEnd = (r) => { if (r && r.step) add('result', { step: String(r.step), out: String(r.out || 'ok'), ms: Math.round(r.ms || 0) }) }
  let hookedG = null, prevHook = null, mine = null
  function hook() {
    const G = bot._ap && bot._ap.G
    if (!G || G === hookedG) return
    unhook()
    prevHook = typeof G.onStepEnd === 'function' ? G.onStepEnd : null
    mine = (r) => { try { if (prevHook) prevHook(r) } catch { /* someone else's observer */ } try { onStepEnd(r) } catch { /* observer */ } }
    G.onStepEnd = mine; hookedG = G
  }
  function unhook() { if (hookedG && hookedG.onStepEnd === mine) hookedG.onStepEnd = prevHook || undefined; hookedG = null; prevHook = null; mine = null }
  function dawn() {
    const d = day(); if (d == null) return
    if (st.lastDay != null && d > st.lastDay) { add('dawn', { day: d, prevDay: st.lastDay }); st.lastDay = d; stateDirty = true; try { collect(); rollDirty() } catch { /* next pass */ } }
    else if (st.lastDay == null || d < st.lastDay) { st.lastDay = d; stateDirty = true }          // first run, or another world
  }

  let timers = []
  bot._journal = { v: 1, add, dir, rollup: (date) => rollDate(date || dateOf(P.iso(now()))) }
  return {
    name: 'journal',
    start() {
      prune()
      bot.on('chat', onChat)
      try { hook(); dawn(); collect() } catch (e) { if (api.log) api.log('journal', 'first pass failed: ' + e.message) }       // what the logs hold from before this start goes in first
      add('start', { bot: bot.username || null, commit: (bot._runInfo && bot._runInfo.commit && bot._runInfo.commit()) || null })
      try { rollDirty() } catch { /* next pass */ }
      timers = [
        setInterval(() => { try { hook(); dawn() } catch {} }, HOOK_MS),
        setInterval(() => { try { collect() } catch (e) { if (api.log) api.log('journal', 'collect failed: ' + e.message) } }, COLLECT_MS),
        setInterval(() => { try { rollDirty(); prune() } catch {} }, ROLLUP_MS)
      ]
      for (const t of timers) if (t.unref) t.unref()
    },
    stop() {
      for (const t of timers) clearInterval(t); timers = []
      bot.removeListener('chat', onChat)
      unhook()
      try { collect(); rollDirty() } catch { /* shutting down */ }
      saveState()
      if (bot._journal && bot._journal.v === 1) delete bot._journal
    },
    status() { return { dir, written: counts.written, dropped: counts.dropped, lastCollectAt, lastRollupAt, day: st.lastDay, sources: Object.fromEntries(Object.entries(st.src).map(([k, v]) => [k, v.pos])) } },
    _tick: { collect, rollDirty, rollDate, hook, dawn, prune, onChat, onStepEnd, state: st }
  }
}
module.exports.meta = require('./meta.json')
module.exports.readNew = readNew
module.exports.botNames = botNames
