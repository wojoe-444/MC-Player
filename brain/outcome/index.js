// brain/outcome: an observer. Does each registered build DO what it is for? (the mob farm of 2026-11-10 passed every inspection and made nothing for a day:
// the world was on Peaceful.) Every few minutes it
//   1. lists the builds it knows an expectation for (brain/outcome/expect.js SPECS): the mob farm room in the shared registry, the tree farm, the animal pens
//   2. counts the time each could have been working (the bot online and inside the 128 block spawn range) and what it has produced since this module first saw it
//   3. reads what the bot can legitimately read about the world (bot.game.difficulty is in the login packet and the options screen)
//   4. writes brain/state/outcome.json, a [outcome] lesson line when a build's state changes, and a journal event `outcome` (salient) so the memory loop's
//      dream turns "blocked" and "overdue" into work orders (reviewer/lib/orders.js) without anyone having to notice
// It never moves the bot and never touches a block. bot._outcome = { run(), last() }.
'use strict'
const fs = require('fs')
const path = require('path')
const E = require('./expect')

const REMIND_MS = 6 * 3600000, EVERY_MS = 5 * 60000, MAX_STEP_MS = 10 * 60000, RANGE = 128, SHADE = 24
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')) } catch { return d } }

module.exports = function register(api) {
  const { bot } = api
  const now = () => (api.now ? api.now() : Date.now())
  const stateDir = path.dirname(api.statePath('x'))
  const file = api.statePath('outcome.json'), memFile = api.statePath('outcome-state.json')
  const registryFile = api.registryFile || process.env.BOT_REGISTRY || path.join(__dirname, '..', '..', '..', 'bot-shared', 'registry.json')
  const lessonsFile = api.statePath('lessons.md')
  const mem = Object.assign({ v: 1, builds: {} }, readJson(memFile, {}))
  let timer = null, lastTick = null, result = { builds: {} }

  const pos = () => { const p = bot.entity && bot.entity.position; return p ? [p.x, p.y, p.z] : null }
  const gstate = () => (bot._ap && bot._ap.G && bot._ap.G.state) || {}

  // ---- the builds this bot can count output for. get() = the cumulative output counter now; near = [x,z] or null (counts whenever the bot is online); pads = feet cells of a spawn platform.
  function builds() {
    const out = []
    const reg = readJson(registryFile, null)
    if (reg && reg.worlds) for (const w of Object.values(reg.worlds)) for (const r of (w.rooms || [])) {
      if (r.type !== 'mobfarm' || !r.box) continue
      let pads = null
      try { const L = require('../inspect/mobfarm').layoutOfRoom(r, (w.shafts || []).find(s => s.id === r.shaft) || null); if (L) pads = L.platform.pads.map(c => [c[0], c[1] + 1, c[2]]) } catch { /* no shading info */ }
      // a farm that follows a schematic (brain/schematic) is only counted as able to work once the world matches the schematic: until then it is "building", not "overdue"
      const sj = () => { try { const j = bot._schematic && bot._schematic.job(); return j && j.room === r.id ? { state: j.state, pct: j.pct, id: j.id } : (r.viaSchematic ? { state: 'complete', pct: 100, id: r.schematic } : null) } catch { return null } }
      out.push({ id: r.id, kind: 'mobfarm', near: [(r.box.x0 + r.box.x1) / 2, (r.box.z0 + r.box.z1) / 2], pads, schematic: r.viaSchematic || sj() ? sj : null, get: () => ((gstate().mobFarm || {}).kills) || 0 })
    }
    const tf = readJson(api.statePath('treefarm-state.json'), null)
    if (tf && Array.isArray(tf.farms) && tf.farms.length) {
      let near = null; try { const c = require('../treefarm/layout').centre(tf.farms[0]); near = [c.x, c.z] } catch { /* counts while online */ }
      out.push({ id: 'treefarm-1', kind: 'treefarm', near, get: () => (((readJson(api.statePath('treefarm-state.json'), {}) || {}).stats || {}).logs) || 0 })
    }
    const hb = readJson(api.statePath('husbandry-state.json'), null)
    if (hb && Array.isArray(hb.pens) && hb.pens.length) out.push({ id: 'pens', kind: 'pen', near: null, get: () => { const s = ((readJson(api.statePath('husbandry-state.json'), {}) || {}).stats) || {}; return (s.bred || 0) + (s.culled || 0) + (s.sheared || 0) } })
    return out
  }

  function env() {
    // bot.game.difficulty is undefined on the live 1.21.6 bots; brain/difficulty keeps the value from the raw 'difficulty' packet in bot._difficulty
const d = bot.game && typeof bot.game.difficulty === 'string' ? bot.game.difficulty : (bot._difficulty && bot._difficulty.value) || null
    return { difficulty: d, mobSpawning: null }
  }

  function tick() {
    const t = now(), dt = lastTick == null ? 0 : Math.min(t - lastTick, MAX_STEP_MS); lastTick = t
    const p = pos(), e = env(), verdicts = {}
    for (const b of builds()) {
      const m = mem.builds[b.id] = mem.builds[b.id] || { kind: b.kind, firstSeen: t, base: b.get(), liveMs: 0, shadedMs: 0 }
      const sch = b.schematic ? b.schematic() : null
      const building = !!sch && sch.state !== 'complete'
      const inRange = p && !building && (!b.near || Math.hypot(p[0] - b.near[0], p[2] - b.near[1]) < RANGE)
      if (dt > 0 && p && inRange) {
        m.liveMs += dt
        if (b.pads && b.pads.length) { const inside = b.pads.filter(c => Math.hypot(c[0] + 0.5 - p[0], c[1] - p[1], c[2] + 0.5 - p[2]) <= SHADE).length; if (inside >= b.pads.length / 2) m.shadedMs += dt }
      }
      const got = Math.max(0, b.get() - (m.base || 0))
      const v = E.evaluate({ id: b.id, kind: b.kind, liveMs: m.liveMs, got, shadedFrac: m.liveMs > 0 ? m.shadedMs / m.liveMs : null, schematic: sch }, e)
      v.since = new Date(m.firstSeen).toISOString()
      verdicts[b.id] = v
    }
    note(verdicts)
    result = { updatedAt: new Date(t).toISOString(), env: e, builds: verdicts }
    try { fs.writeFileSync(file + '.tmp', JSON.stringify(result, null, 1)); fs.renameSync(file + '.tmp', file); fs.writeFileSync(memFile, JSON.stringify(mem)) } catch (err) { if (api.log) api.log('outcome', 'write failed: ' + err.message) }
    return result
  }

  // a line in the lessons (the planner reads them) and a journal event, only when a build's state changes into something worth saying
  function note(verdicts) {
    for (const [id, v] of Object.entries(verdicts)) {
      const m = mem.builds[id], prev = m.state || 'warming', t = now()
      const bad = v.state === 'blocked' || v.state === 'overdue'
      // a build that stays broken is said again every REMIND_MS: the work-order loop only looks at the last 24 h of the journal, and an order whose
      // problem stops appearing there is closed as "went quiet" (12 h later), which for a build still making nothing would be the wrong thing to say
      const remind = bad && v.state === prev && t - (m.said || 0) > REMIND_MS
      if (v.state === prev && !remind) continue
      m.state = v.state; m.said = t
      if (v.state === 'warming' || v.state === 'unknown') continue
      if (!remind) {
        const day = new Date(now()).toISOString().slice(0, 16).replace('T', ' ')
        try { fs.appendFileSync(lessonsFile, `- ${day} [outcome] ${id}: ${v.state}. ${v.why.join(' ')}${v.who === 'human' ? ' (only a person can change this; ask Walter, do not work around it)' : ''}\n`) } catch { /* ignore */ }
      }
      try { if (bot._journal) bot._journal.add('outcome', { build: id, kindOf: v.kind, state: v.state, who: v.who || null, liveH: v.liveH, got: v.got, unit: v.unit, why: v.why.join(' ').slice(0, 300), purpose: v.purpose }, { sal: v.state === 'blocked' || v.state === 'overdue' }) } catch { /* observer */ }
    }
  }

  bot._outcome = { run: tick, last: () => result }
  return {
    name: 'outcome',
    start() { lastTick = now(); timer = setInterval(() => { try { tick() } catch (e) { if (api.log) api.log('outcome', 'tick failed: ' + e.message) } }, EVERY_MS); if (timer.unref) timer.unref(); setTimeout(() => { try { tick() } catch { /* next */ } }, 60000).unref() },
    stop() { clearInterval(timer); if (bot._outcome) delete bot._outcome },
    status() { return Object.fromEntries(Object.entries(result.builds).map(([id, v]) => [id, v.state])) },
    _tick: tick, _mem: mem,
  }
}
module.exports.meta = require('./meta.json')
