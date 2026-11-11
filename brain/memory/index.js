// brain/memory: the bot's memory folder and its dawn brief (docs/MEMORY-LOOP.md, jobs 3 and "Memory on disk"). This is the reader the loop was missing:
// lessons.md and strategy.md were written for a model planner that has been off since 2026-11-04, so nothing in the game read them.
//
// What happens, per bot, when the brief is on (profile planner.brief; default on for a hillclimber):
//   1. At an in-game dawn (at most once an hour), after a respawn (at most every 10 minutes) and on first run, this module writes
//      brain/state/memory/brief-request.json: the rules, global.md, what the journal says happened since the last brief, the last brief, the reviewer's
//      open findings, open roadmap items, the bot's state and the step names it may use. It starts no process and calls no model.
//   2. A laptop job (reviewer/lib/brief.js, on the reviewer's Task Scheduler entry, Haiku 5.5 at xhigh effort) answers into brief-answer.json.
//   3. This module checks the answer in code (brief.js: no hold on a survival step or on free time, real step names only, at most three holds of at most
//      three in-game days), applies its memory edits under the caps (store.js), writes brief.json and hands it to the step picker as G.brief.
//      goals.js then skips held steps, tries focus steps first and gives free time its own slot once a day.
// If the job is not installed, is slow or fails, there is no brief and the step list plays exactly as it does today. A brief stops counting after three hours.
// bot._memory = { store, brief(), request(reason), status() }
'use strict'
const fs = require('fs')
const path = require('path')
const { createStore } = require('./store')
const B = require('./brief')
const { rulesText } = require('../gate/rules-text')
const { rollup } = require('../journal/rollup')

const TICK_MS = 10000
const DAWN_GAP_MS = 55 * 60000, RESPAWN_GAP_MS = 10 * 60000, PENDING_MS = 15 * 60000, FIRST_LOOKBACK_MS = 60 * 60000
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')) } catch { return d } }
const writeJson = (f, obj) => { const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 1)); fs.renameSync(tmp, f) }
const SEV = { high: 0, med: 1, medium: 1, low: 2 }

module.exports = function register(api) {
  const { bot } = api
  const now = () => (api.now ? api.now() : Date.now())
  const dir = path.dirname(api.statePath('memory/x'))
  const store = createStore({ dir, author: bot.username || 'bot', git: api.memoryGit !== false, log: (m) => api.log && api.log('memory', m) })
  const reqFile = path.join(dir, 'brief-request.json'), ansFile = path.join(dir, 'brief-answer.json'), briefFile = path.join(dir, 'brief.json'), stFile = path.join(dir, 'brief-state.json')
  const st = Object.assign({ lastReqAt: 0, lastReqDay: null, lastReqId: null, appliedId: null, refused: [], seq: 0 }, readJson(stFile, {}))
  let current = null, died = false, respawnAt = 0, lastError = null
  const save = () => { try { writeJson(stFile, st) } catch { /* next tick */ } }
  const G = () => bot._ap && bot._ap.G
  const day = () => (bot.time && Number.isFinite(bot.time.day) ? bot.time.day : null)

  function enabled() {
    if (typeof api.briefEnabled === 'boolean') return api.briefEnabled
    if (process.env.BOT_BRIEF === '0') return false
    try { const p = api.profile && api.profile.get(); if (!p) return false; return p.planner && typeof p.planner.brief === 'boolean' ? p.planner.brief : p.role === 'hillclimber' } catch { return false }
  }
  const playing = () => { const ap = bot._ap; return !!(ap && ap.G && Array.isArray(ap.G.steps) && (typeof ap.active !== 'function' || ap.active())) }

  // what the journal says happened since `since` (one or two day files), as a rollup
  function sinceRollup(since) {
    const jdir = (bot._journal && bot._journal.dir) || path.dirname(api.statePath('journal/x'))
    const dates = [...new Set([new Date(since).toISOString().slice(0, 10), new Date(now()).toISOString().slice(0, 10)])]
    const evs = []
    for (const d of dates) {
      let text; try { text = fs.readFileSync(path.join(jdir, `${d}.jsonl`), 'utf8') } catch { continue }
      for (const line of text.split('\n')) { if (!line) continue; try { const e = JSON.parse(line); if (Date.parse(e.at) >= since) evs.push(e) } catch { /* torn line */ } }
    }
    return B.digest(rollup(evs))
  }
  function stateLine() {
    const g = G(), s = (g && g.state) || {}, e = bot.entity, p = e && e.position
    const bag = {}; try { for (const i of bot.inventory.items()) bag[i.name] = (bag[i.name] || 0) + i.count } catch { /* no inventory yet */ }
    return {
      pos: p ? [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)] : null, hp: Math.round(bot.health || 0), food: Math.round(bot.food || 0),
      home: s.home || null, mine: (s.mine && s.mine.entry) || null, doing: (g && g.lastStep) || null,
      bag: Object.fromEntries(Object.entries(bag).sort((a, b) => b[1] - a[1]).slice(0, 16)),
      schematicJob: schematicJob(),
    }
  }
  // the blueprint being followed for a big build (brain/schematic), as the world reads it: the dawn brief can focus `schematic-build` while it is building, or hold it when stuck
  function schematicJob() {
    try {
      const j = bot._schematic && bot._schematic.job(); if (!j || j.state === 'abandoned') return null
      return { id: j.id, state: j.state, percentRight: j.pct, cellsOff: j.off, stuckOn: j.state === 'stuck' ? (j.lastWrong || []).slice(0, 2) : undefined, step: 'schematic-build' }
    } catch { return null }
  }
  function findings() {
    const f = readJson(api.statePath('review/findings.json'))
    return ((f && f.open) || []).slice().sort((a, b) => (SEV[a.severity] ?? 3) - (SEV[b.severity] ?? 3))
  }
  function roadmap() {
    const r = readJson(api.statePath('roadmap.json')); if (!r) return null
    return { phases: Object.fromEntries(Object.entries(r.phases || {}).map(([k, p]) => [k, `${p.done} done of ${p.measured} measured, ${p.total} items`])), open: (r.items || []).filter(i => i.status === 'open').slice(0, 8).map(i => i.title) }
  }
  function stepIds() { const g = G(); if (!g) return []; if (typeof g.stepIds === 'function') return g.stepIds(); return (g.steps || []).map(s => s.id) }

  function request(reason) {
    const t = now(), g = G(); if (!g) return null
    store.ensure()
    const last = readJson(briefFile)
    const since = Math.max(last && Date.parse(last.at) || 0, t - 6 * 3600000, st.lastReqAt ? 0 : t - FIRST_LOOKBACK_MS)
    let rules = []; try { rules = rulesText(readJson(api.rulesFile || path.join(__dirname, '..', 'gate', 'rules.json'))) } catch { /* no rules file */ }
    const id = `${(bot.username || 'bot').toLowerCase()}-${new Date(t).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${++st.seq}`
    const req = B.buildRequest({
      id, at: new Date(t).toISOString(), reason, bot: bot.username || null, role: g.role || 'hillclimber', day: day(), timeOfDay: bot.time ? bot.time.timeOfDay : null,
      steps: stepIds(), state: stateLine(), rules, global: store.readGlobal(), notes: store.notes(), since: sinceRollup(since),
      lastBrief: last, refused: st.refused || [], findings: findings(), roadmap: roadmap(),
      lastCheck: B.checkSummary(readJson(path.join(dir, 'dream', 'last.json')), (last && Date.parse(last.at)) || 0),
    })
    writeJson(reqFile, req)
    st.lastReqAt = t; st.lastReqDay = day(); st.lastReqId = id; save()
    if (api.log) api.log('memory', `brief requested (${reason}) ${id}`)
    return req
  }

  function wanted() {
    const t = now(), d = day()
    if (st.lastReqId && st.lastReqId !== st.appliedId && t - st.lastReqAt < PENDING_MS) return null       // one is being answered
    if (!st.lastReqAt) return 'first'
    if (respawnAt && respawnAt > st.lastReqAt && t - st.lastReqAt >= RESPAWN_GAP_MS) return 'respawn'
    if (d != null && st.lastReqDay != null && d !== st.lastReqDay && t - st.lastReqAt >= DAWN_GAP_MS) return 'dawn'
    return null
  }

  // an answer from the laptop job for the request we are waiting on: check it, apply it, hand it to the picker
  function takeAnswer() {
    if (!st.lastReqId || st.lastReqId === st.appliedId) return false
    const ans = readJson(ansFile); if (!ans || ans.id !== st.lastReqId) return false
    st.appliedId = ans.id
    if (!ans.ok || !ans.data) {
      lastError = String(ans.error || 'no answer').slice(0, 200); save()
      if (bot._journal) bot._journal.add('note', { tag: 'brief', text: `no brief this time: ${lastError}` })
      return false
    }
    const req = readJson(reqFile) || {}
    const v = B.validate(ans.data, { steps: (req.id === ans.id && req.steps) || stepIds(), day: day() ?? req.day ?? 0, now: now(), id: ans.id, model: ans.model || null, lastAsk: st.lastAsk || null })
    if (v.brief.ask) st.lastAsk = { text: v.brief.ask, at: now() }
    let mem = { refused: [], changed: false, lines: null }
    try { mem = store.applyBrief(v.edits, `dawn brief ${ans.id}: ${v.brief.intent}`.slice(0, 200)) } catch (e) { mem.refused = ['memory not written: ' + e.message] }
    v.brief.memory = { changed: mem.changed, lines: mem.lines, refused: mem.refused }
    st.refused = [...v.dropped, ...mem.refused].slice(0, 8); lastError = null; save()
    writeJson(briefFile, v.brief)
    current = v.brief; give()
    if (bot._journal) bot._journal.add('brief', { text: v.brief.intent, focus: v.brief.focus, holds: v.brief.holds.map(h => h.step), freeTime: v.brief.freeTime.choice, ask: v.brief.ask, dropped: st.refused.length }, { sal: true })
    if (api.log) api.log('memory', `brief ${ans.id}: ${v.brief.intent} | focus ${v.brief.focus.join(',') || '-'} | hold ${v.brief.holds.map(h => h.step).join(',') || '-'} | free time ${v.brief.freeTime.choice}`)
    return true
  }
  const give = () => { const g = G(); if (g && g.brief !== current) g.brief = current }
  const brief = () => B.active(current, { now: now(), day: day() })

  function tick() {
    if (!enabled()) { if (current) { current = null; give() } return }
    give()
    if (!playing()) return
    takeAnswer()
    const why = wanted(); if (why) { request(why); if (why === 'respawn') respawnAt = 0 }
  }
  const onDeath = () => { died = true }
  const onSpawn = () => { if (died) { died = false; respawnAt = now() } }

  let timer = null
  bot._memory = { v: 1, store, brief, request, status: () => status() }
  function status() { const b = brief(); return { enabled: enabled(), dir, lastRequestAt: st.lastReqAt || null, waiting: !!(st.lastReqId && st.lastReqId !== st.appliedId), lastError, brief: b ? { intent: current.intent, at: current.at, focus: b.focus, holds: b.holds, freeTime: b.freeTime, ask: current.ask } : null, refused: st.refused } }
  return {
    name: 'memory',
    start() {
      try { if (enabled()) store.ensure() } catch (e) { if (api.log) api.log('memory', 'could not set up the memory folder: ' + e.message) }
      current = readJson(briefFile)
      bot.on('death', onDeath); bot.on('spawn', onSpawn)
      timer = setInterval(() => { try { tick() } catch (e) { lastError = e.message; if (api.log) api.log('memory', 'tick failed: ' + e.message) } }, TICK_MS)
      if (timer.unref) timer.unref()
    },
    stop() {
      clearInterval(timer); timer = null
      bot.removeListener('death', onDeath); bot.removeListener('spawn', onSpawn)
      const g = G(); if (g && g.brief === current) delete g.brief
      if (bot._memory && bot._memory.v === 1) delete bot._memory
    },
    status,
    _tick: { tick, request, takeAnswer, wanted, state: st }
  }
}
module.exports.meta = require('./meta.json')
