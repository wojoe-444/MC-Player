// brain/inspect: an observer. The bot's own builds, checked against their design, from the blocks, every few minutes and whenever a build routine asks.
// (Walter 2026-11-10: the mob farm was built, logged "done", and never produced a kill. It was visibly wrong in several ways, a human sees them in under a
// second, and nothing in the bot looked at its own work: telemetry sees the bot's body, the Haiku reviewer sees telemetry text, neither sees blocks.)
//
// What it does, for each registered room it knows a design for (today: `mobfarm`) that is within reach of the loaded chunks:
//   1. reads the room's box plus a light margin from the bot's own loaded world (no packets, no new view of the world: the blocks of a thing it built)
//   2. rebuilds the design (brain/mobfarm/geometry.js) and checks the blocks against it and against what the thing is for (brain/inspect/mobfarm.js)
//   3. writes brain/state/inspect/<room>.json (findings + the light map and two cutaways as text), summary.json (what the planner, the roadmap and the
//      Haiku reviewer read) and appends a [inspect] line to lessons.md when the set of faults changes, so the planner sees it in its own lesson log
//
// It never moves the bot and never touches a block. Fixing is the build routine's job (G.mobFarmBuild.repair), and only for what it can safely fix.
// bot._inspect = { run(roomId?), last() } lets a build routine inspect its own result the moment it finishes.
'use strict'
const fs = require('fs')
const path = require('path')
const grid = require('./grid')
const light = require('./light')
const mobfarm = require('./mobfarm')
const render = require('./render')
const exact = require('./exact')
const designs = require('../schematic/designs')
const SC = require('../schematic/store')

const EVERY_MS = 4 * 60000
const MARGIN = { x: 14, y: 6, z: 14 }          // light reaches 14 blocks; a torch farther away than that cannot matter, and rock stops it anyway

const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')) } catch { return d } }

module.exports = function register(api) {
  const { bot } = api
  const now = () => (api.now ? api.now() : Date.now())
  const dir = path.join(path.dirname(api.statePath('x')), 'inspect')
  const registryFile = process.env.BOT_REGISTRY || path.join(__dirname, '..', '..', '..', 'bot-shared', 'registry.json')
  const lessonsFile = api.statePath('lessons.md')
  let timer = null, first = null, busy = false
  const last = {}                                 // roomId -> { at, result, signature }

  function rooms() {
    const reg = readJson(registryFile, null), out = []
    if (!reg || !reg.worlds) return out
    for (const w of Object.values(reg.worlds)) for (const r of (w.rooms || [])) {
      if (r.type !== 'mobfarm') continue
      out.push({ room: r, shaft: (w.shafts || []).find(s => s.id === r.shaft) || null })
    }
    return out
  }
  const near = (box) => {
    const p = bot.entity && bot.entity.position; if (!p) return false
    const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2, cz = (box.z0 + box.z1) / 2
    return Math.hypot(p.x - cx, p.z - cz) < 90 && Math.abs(p.y - cy) < 80
  }
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))

  async function inspectRoom({ room, shaft }, opt = {}) {
    const L = mobfarm.layoutOfRoom(room, shaft)
    if (!L) return { id: room.id, skipped: 'cannot rebuild the design from the registry record (shaft or platform level missing)' }
    const g = await grid.fromBot(bot, L.box, MARGIN, { yieldEvery: true, sleep })
    if (!g) return { id: room.id, skipped: 'the chunks around the room are not loaded' }
    let res = mobfarm.check(L, g, { done: true })
    // the exact check: cell by cell against the room's own blueprint (a schematic saved for it), or against the design when it has none (then only a note: the
    // specific checks above already say what is wrong, this says how much of the design is in place)
    try {
      const explicit = room.schematic ? SC.load(SC.dirsFor({ sharedDir: path.dirname(registryFile), stateDir: path.dirname(api.statePath('x')) }), room.schematic) : null
      const schem = explicit || designs.mobfarmDesign(L, { id: 'design-' + room.id })
      const ex = exact.check(schem, schem.origin, g, { fault: !!explicit })
      res.findings.push(...ex.findings); res.stats = { ...res.stats, exact: ex.stats }
      res = mobfarm.summarise(res.findings, res.stats, g)
    } catch (e) { api.log('inspect', 'exact check failed: ' + e.message) }
    const lm = light.blockLight(g)
    const pics = render.renderMobFarm(L, g, lm, res)
    const sig = res.findings.filter(f => f.sev !== 'note').map(f => f.id + ':' + f.count).join('|')
    const out = { id: room.id, type: room.type, at: new Date(now()).toISOString(), ok: res.ok, faults: res.faults, warns: res.warns, stats: res.stats, headline: res.headline,
      findings: res.findings, render: pics, box: L.box, signature: sig }
    return out
  }

  function note(out) {
    const prev = last[out.id], sig = out.signature
    last[out.id] = { at: now(), result: out, signature: sig }
    if (prev && prev.signature === sig) return
    try {
      const day = new Date(now()).toISOString().slice(0, 16).replace('T', ' ')
      const line = out.ok && !out.warns ? `- ${day} [inspect] ${out.id}: inspection passes (nothing differs from the design).` :
        `- ${day} [inspect] ${out.id}: ${out.faults} fault(s), ${out.warns} warning(s). ${out.headline.slice(0, 3).join(' | ')} (details: brain/state/inspect/${out.id}.json)`
      if (prev || !out.ok) fs.appendFileSync(lessonsFile, line + '\n')
    } catch { /* ignore */ }
  }

  function write(results) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      const summary = { updatedAt: new Date(now()).toISOString(), rooms: {} }
      for (const o of results) {
        if (o.skipped) { const p = last[o.id]; if (!p) summary.rooms[o.id] = { skipped: o.skipped }; continue }
        fs.writeFileSync(path.join(dir, o.id.replace(/[^\w.-]/g, '_') + '.json'), JSON.stringify(o, null, 1))
        const txt = [`# ${o.id}: ${o.ok ? 'passes' : o.faults + ' fault(s)'}, ${o.warns} warning(s) (${o.at})`, '', ...o.findings.map(f => `- **${f.sev}** \`${f.id}\` (${f.zone}) ${f.msg}${f.cells.length ? ' [' + f.cells.slice(0, 4).join(' | ') + ']' : ''}`), '', '```', o.render.lightPlan, '', o.render.along, '', o.render.across, '```', ''].join('\n')
        fs.writeFileSync(path.join(dir, o.id.replace(/[^\w.-]/g, '_') + '.md'), txt)
      }
      for (const [id, v] of Object.entries(last)) summary.rooms[id] = { at: v.result.at, ok: v.result.ok, faults: v.result.faults, warns: v.result.warns, stats: v.result.stats, headline: v.result.headline, fixes: v.result.findings.filter(f => f.fix).map(f => ({ id: f.id, ...f.fix })), file: id.replace(/[^\w.-]/g, '_') + '.md' }
      const tmp = path.join(dir, 'summary.json.tmp'); fs.writeFileSync(tmp, JSON.stringify(summary, null, 1)); fs.renameSync(tmp, path.join(dir, 'summary.json'))
    } catch (e) { api.log('inspect', 'write failed: ' + e.message) }
  }

  async function run(roomId) {
    if (busy) return Object.values(last).map(v => v.result)
    busy = true
    try {
      const results = []
      for (const r of rooms()) {
        if (roomId && r.room.id !== roomId) continue
        if (!near(r.room.box)) continue
        let o; try { o = await inspectRoom(r) } catch (e) { api.log('inspect', 'inspection failed: ' + e.message); continue }
        if (!o.skipped) note(o)
        results.push(o)
      }
      if (results.length) write(results)
      return results.filter(o => !o.skipped)
    } finally { busy = false }
  }

  bot._inspect = { run, last: (id) => (id ? last[id] && last[id].result : Object.values(last).map(v => v.result)) }
  return {
    name: 'inspect',
    start() {
      first = setTimeout(() => { run().catch(() => {}) }, 45000); if (first.unref) first.unref()
      timer = setInterval(() => { run().catch(() => {}) }, EVERY_MS); if (timer.unref) timer.unref()
    },
    stop() { clearInterval(timer); clearTimeout(first); if (bot._inspect) delete bot._inspect },
    status() { return Object.fromEntries(Object.entries(last).map(([id, v]) => [id, { ok: v.result.ok, faults: v.result.faults, warns: v.result.warns }])) },
    _run: run,
  }
}
module.exports.meta = require('./meta.json')
