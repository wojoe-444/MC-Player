// brain/leftovers: an observer. Walter 2026-11-11 (screenshot at -6007,72,-2361): cobble and dirt scaffolding pillars nobody took down, and trees cut only part of
// the way up whose remaining logs kept the whole canopy alive: "the recursive loop should have caught both of these before me".
//
// Every SCAN_MS it looks at what is loaded around the bot (never moves, never touches a block):
//   scaffold  clusters of filler blocks that a bot of ours placed (brain/ledger), still as placed, outside any named space, open to the sky, older than 10 minutes
//   trees     clusters of natural logs that stand on nothing (a felled tree's upper logs and limbs), with how many leaves they hold up
// and reports each cluster that has stood for REPORT_AFTER_MS (so a climb or a felling in progress is not reported):
//   * telemetry event `leftover` every scan  -> detector flags `leftover_scaffold` / `leftover_trees` (brain/telemetry/detectors.js), the live alert and the Haiku reviewer
//   * journal event `leftover` (salient the first time a cluster is reported, again every 3 h while it stands)  -> rollup.leftovers -> the dream's work orders (reviewer/lib/orders.js)
//   * brain/state/leftovers.json  -> the tidy step (autopilot/plan.js) takes the scaffold clusters down and finishes the trees (treefarm engine.finishRemnant)
// bot._leftovers = { scaffold(), trees(), scan(), last() }   (README.md)
'use strict'
const fs = require('fs')
const path = require('path')
const L = require('./lib')
const { Vec3 } = require('vec3')

const SCAN_MS = 2 * 60000, REPORT_AFTER_MS = 5 * 60000, REMIND_MS = 3 * 3600000, RADIUS = 48, FIRST_SCAN_MS = 45000, MAX_CELLS = 6000

module.exports = function register(api) {
  const { bot } = api
  const now = () => (api.now ? api.now() : Date.now())
  const log = (m) => { try { api.log && api.log('LEFTOVERS', m) } catch {} }
  const file = api.statePath('leftovers.json')
  const BOTS = /^(OzoGo444|Smeo444)$/
  const ours = (name) => { try { const s = bot._ledger && bot._ledger._store; if (s && s.isOurs(name)) return true } catch {} return BOTS.test(name || '') }
  const firstSeen = new Map(), reported = new Map()                  // cluster id -> first time seen, last time reported to the journal
  let timer = null, first = null, last = { at: 0, scaffold: [], trees: [], err: null }

  const read = (x, y, z) => { try { const b = bot.blockAt(new Vec3(x, y, z), false); return b ? b.name : null } catch { return null } }
  function seedLogs(center) {
    const reg = bot.registry && bot.registry.blocksByName; if (!reg || typeof bot.findBlocks !== 'function') return []
    const ids = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'cherry', 'pale_oak'].map(n => reg[n + '_log'] && reg[n + '_log'].id).filter(v => v != null)
    try { return bot.findBlocks({ point: center, matching: ids, maxDistance: RADIUS, count: 1500 }).map(p => ({ x: p.x, y: p.y, z: p.z })) } catch { return [] }
  }

  // where to look: around the bot, and around home when that is elsewhere (the pillars are at the base, the bot is often down the mine or out exploring)
  const gstate = () => (bot._ap && bot._ap.G && bot._ap.G.state) || {}
  const centres = (me) => {
    const out = [me]
    try { const h = gstate().home; if (Array.isArray(h) && h.length >= 3 && Math.hypot(h[0] - me.x, h[2] - me.z) > RADIUS / 2) out.push(new Vec3(h[0], h[1], h[2])) } catch {}
    return out
  }
  // cells that belong to the shelter or the home build are not scaffolding even when the ledger calls them filler
  const skipCell = (x, y, z) => { try { const sb = gstate()._shelterBox; return !!sb && x >= sb.x0 - 1 && x <= sb.x1 + 1 && z >= sb.z0 - 1 && z <= sb.z1 + 1 && y >= sb.y - 2 && y <= sb.y + 4 } catch { return false } }

  function scan() {
    const t = now(), me = bot.entity && bot.entity.position
    if (!me || !bot.blockAt) return last
    const led = bot._ledger
    let sc = [], tr = [], err = null, diag = { centres: 0, reasons: {}, candidates: 0, logSeeds: 0, dug: 0 }
    const cs = centres(me); diag.centres = cs.length
    const seenSc = new Set(), seenTr = new Set()
    for (const c of cs) {
      let cells = [], dug = []
      try {
        if (led && led.near) {
          const all = led.near(c, RADIUS)
          cells = all.filter(x => x.op === 'p').slice(0, MAX_CELLS)
          dug = all.filter(x => x.op === 'd' && L.LOG.test(x.block || ''))
        }
        const r = L.scaffold({ cells, read, isOurs: ours, now: t, skipCell })
        for (const k of Object.keys(r.reasons)) diag.reasons[k] = (diag.reasons[k] || 0) + r.reasons[k]
        diag.candidates += r.candidates
        for (const x of r.clusters) if (!seenSc.has(x.id)) { seenSc.add(x.id); sc.push(x) }
      } catch (e) { err = 'scaffold: ' + e.message }
      try {
        const get = (x, y, z) => { try { return led && led.at ? led.at({ x, y, z }) : null } catch { return null } }
        const seeds = seedLogs(c); diag.logSeeds += seeds.length; diag.dug += dug.length
        for (const x of L.trees({ seeds, read, get, dug, isOurs: ours, now: t }).clusters) if (!seenTr.has(x.id)) { seenTr.add(x.id); tr.push(x) }
      } catch (e) { err = (err ? err + '; ' : '') + 'trees: ' + e.message }
    }
    const ids = new Set([...sc, ...tr].map(c => c.id))
    // gone (and it would have been in view): forget it, so a new one at the same spot is news. One out of range stays on the books.
    for (const [id, f] of [...firstSeen]) if (!ids.has(id) && cs.some(c => Math.hypot(f.pos[0] - c.x, f.pos[2] - c.z) < RADIUS - 8)) { firstSeen.delete(id); reported.delete(id) }
    for (const c of [...sc, ...tr]) if (!firstSeen.has(c.id)) firstSeen.set(c.id, { t, pos: c.pos })
    const standing = (c) => t - firstSeen.get(c.id).t >= REPORT_AFTER_MS
    last = { at: t, scaffold: sc.filter(standing), trees: tr.filter(standing), seen: { scaffold: sc.length, trees: tr.length }, diag, err }
    report(t)
    persist(t)
    return last
  }

  function report(t) {
    const pos = (c) => c.pos
    for (const c of [...last.scaffold, ...last.trees]) {
      c.standingMin = Math.round((t - firstSeen.get(c.id).t) / 60000)
      try { if (typeof bot._telemetryEvent === 'function') bot._telemetryEvent({ k: 'leftover', t, what: c.what, id: c.id, kind: c.kind, n: c.n, h: c.h, leaves: c.leaves || 0, x: pos(c)[0], y: pos(c)[1], z: pos(c)[2], standingMin: c.standingMin }) } catch {}
      const prev = reported.get(c.id)
      if (prev && t - prev < REMIND_MS) continue
      reported.set(c.id, t)
      try {
        if (bot._journal && bot._journal.add) bot._journal.add('leftover', { what: c.what, id: c.id, kind: c.kind, pos: pos(c), n: c.n, h: c.h, leaves: c.leaves || 0, species: c.species || null, block: c.block || null, by: c.by || null, via: c.via || null, standingMin: c.standingMin, again: !!prev }, { sal: !prev })
      } catch {}
      log(`${c.what} ${c.kind} at ${pos(c).join(',')}: ${c.n} blocks${c.what === 'tree' ? `, ${c.leaves} leaves held up` : `, ${c.h} high`}, standing ${c.standingMin} min${c.by ? ' (' + c.by + ')' : ''}`)
    }
  }

  function persist(t) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const slim = (c) => { const { cells, logs, ...rest } = c; return rest }
      const tmp = file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify({ updatedAt: new Date(t).toISOString(), scaffold: last.scaffold.map(c => ({ ...slim(c), cells: c.cells })), trees: last.trees.map(c => ({ ...slim(c), logs: c.logs })), seen: last.seen, diag: last.diag, err: last.err }))
      fs.renameSync(tmp, file)
    } catch { /* a state file is a convenience */ }
  }

  const api2 = { v: 1, scaffold: () => last.scaffold, trees: () => last.trees, scan, last: () => last }
  bot._leftovers = api2

  return {
    name: 'leftovers',
    start() {
      first = setTimeout(() => { try { scan() } catch (e) { log(e.message) } }, FIRST_SCAN_MS); if (first.unref) first.unref()
      timer = setInterval(() => { try { scan() } catch (e) { log(e.message) } }, SCAN_MS); if (timer.unref) timer.unref()
    },
    stop() { clearTimeout(first); clearInterval(timer); if (bot._leftovers === api2) delete bot._leftovers },
    status() { return { scaffold: last.scaffold.length, trees: last.trees.length, lastScanAgoS: last.at ? Math.round((now() - last.at) / 1000) : null } },
    _tick: { scan, firstSeen: () => firstSeen }
  }
}
module.exports.meta = require('./meta.json')
