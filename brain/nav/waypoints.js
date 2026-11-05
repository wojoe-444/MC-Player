// Named waypoints: Walter's own waypoints.json (saved in game with "set waypoint ...") merged with his Xaero minimap waypoints
// (read through ../../xaero.js, read-only). Handles typos, duplicate names ("Portal" x8), dimensions and the Nether 1:8 scale.
//
//   const book = new WaypointBook({ dir, xaero: require('../../xaero'), world: 'HOME DEPOT GOD-EMPEROR' })
//   book.find('ice portal', { dim: 0, from: bot.entity.position })  -> { match, candidates, exact, ambiguous }
//   book.near(pos, 0, 5)                                            -> the 5 nearest overworld waypoints
const fs = require('fs')
const path = require('path')

const DIM_BY_NAME = { overworld: 0, the_nether: -1, nether: -1, the_end: 1, end: 1 }
function dimOf(bot) {
  const d = String((bot.game && bot.game.dimension) || 'overworld').replace('minecraft:', '')
  return d in DIM_BY_NAME ? DIM_BY_NAME[d] : 0
}
const DIM_LABEL = { 0: 'overworld', '-1': 'nether', 1: 'end' }

const STOP = new Set(['the', 'a', 'an', 'my', 'to', 'at', 'in', 'of', 'please', 'waypoint', 'waypoints', 'place'])
function tokens(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(t => t && !STOP.has(t))
}
const norm = (s) => tokens(s).join(' ')

function lev(a, b) {
  if (a === b) return 0
  const m = a.length, n = b.length
  if (!m || !n) return Math.max(m, n)
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[n]
}
// does query token q match name token t? exact, prefix (>=3 chars), or a small typo
function tokenMatch(q, t) {
  if (q === t) return 1
  if (q.length >= 3 && t.startsWith(q)) return 0.9
  if (q.length >= 4 && lev(q, t) <= (q.length >= 7 ? 2 : 1)) return 0.7
  return 0
}

const hdist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)

class WaypointBook {
  constructor({ dir, xaero = null, world = null, log = () => {}, now = Date.now, recheckMs = 5000 }) {
    this.dir = dir
    this.xaero = xaero
    this.world = world
    this.log = log
    this.now = now
    this.recheckMs = recheckMs
    this.entries = []
    this.loadedAt = -Infinity
    this.sources = { local: 0, xaero: 0, xaeroWorld: null, error: null }
  }

  xaeroWorld() {
    if (this.world) return this.world
    try {
      const w = this.xaero && this.xaero.listWorlds().find(x => x.waypoints && x.map)
      return w ? w.name : null
    } catch { return null }
  }

  // Re-read (at most every recheckMs): waypoints.json + Xaero's waypoints.txt for dimensions 0, -1, 1.
  load(force = false) {
    if (!force && this.now() - this.loadedAt < this.recheckMs) return this.entries
    this.loadedAt = this.now()
    const out = []
    let local = {}
    try { local = JSON.parse(fs.readFileSync(path.join(this.dir, 'waypoints.json'), 'utf8').replace(/^﻿/, '')) } catch { /* none yet */ }
    const live = []
    this.sources.error = null
    const world = this.xaeroWorld()
    this.sources.xaeroWorld = world
    if (this.xaero && world) {
      for (const dim of [0, -1, 1]) {
        try { for (const w of this.xaero.waypoints(world, dim)) live.push({ name: w.name, x: w.x, y: w.y, z: w.z, dim, source: 'xaero', disabled: !!w.disabled }) } catch (e) { this.sources.error = e.message }
      }
    }
    // duplicates ("Portal" eight times) get their coordinates appended so each one can be addressed
    const count = new Map()
    for (const w of live) { const k = w.dim + '|' + norm(w.name); count.set(k, (count.get(k) || 0) + 1) }
    for (const w of live) {
      const dup = count.get(w.dim + '|' + norm(w.name)) > 1
      out.push({ ...w, baseName: w.name, name: dup ? `${w.name} (${w.x}, ${w.z})` : w.name })
    }
    const liveKeys = new Set(out.map(w => w.dim + '|' + norm(w.baseName)))
    let nLocal = 0
    for (const [name, c] of Object.entries(local)) {
      if (!c || typeof c.x !== 'number' || typeof c.z !== 'number') continue
      const dim = typeof c.dim === 'number' ? c.dim : 0
      const e = { name, baseName: name, x: c.x, y: typeof c.y === 'number' ? c.y : null, z: c.z, dim, source: c.source === 'xaero' ? 'xaero-cached' : 'local', disabled: false }
      if (e.source === 'xaero-cached') {
        // an older import of a Xaero waypoint: only a fallback when Xaero itself has no such waypoint now
        const sameCoord = out.some(w => w.dim === dim && w.x === e.x && w.z === e.z)
        if (sameCoord || liveKeys.has(dim + '|' + norm(name))) continue
      } else {
        // Walter saved this one himself: it wins over a Xaero waypoint of the same name
        for (let i = out.length - 1; i >= 0; i--) if (out[i].dim === dim && out[i].source === 'xaero' && norm(out[i].baseName) === norm(name)) out.splice(i, 1)
        nLocal++
      }
      out.push(e)
    }
    this.sources.local = nLocal
    this.sources.xaero = live.length
    this.entries = out
    return out
  }

  all(dim = null) { return this.load().filter(w => dim === null || w.dim === dim) }

  // Best waypoint(s) for a spoken name. `exact` = normalised names are equal. `ambiguous` = several equally good candidates,
  // sorted by distance when `from` is given (the nearest is first).
  find(query, { dim = 0, from = null, anyDim = false } = {}) {
    const q = tokens(query)
    if (!q.length) return { match: null, candidates: [], exact: false, ambiguous: false, score: 0 }
    const pool = this.load().filter(w => anyDim || w.dim === dim)
    const scored = []
    for (const w of pool) {
      const nt = tokens(w.name), nb = tokens(w.baseName)
      const key = nt.join(' ')
      let score = 0, exact = false
      if (key === q.join(' ') || nb.join(' ') === q.join(' ')) { score = 10; exact = true }
      else {
        let sum = 0, ok = true
        for (const t of q) {
          let best = 0
          for (const u of new Set([...nb, ...nt])) best = Math.max(best, tokenMatch(t, u))
          if (!best) { ok = false; break }
          sum += best
        }
        if (ok) score = sum / q.length * (q.length / Math.max(nb.length, q.length) * 0.5 + 0.5)     // fuller coverage of the name scores higher
      }
      if (score > 0) scored.push({ w, score, exact, d: from ? hdist(from, w) : 0 })
    }
    if (!scored.length) return { match: null, candidates: [], exact: false, ambiguous: false, score: 0 }
    scored.sort((a, b) => b.score - a.score || a.d - b.d)
    const top = scored[0]
    const tied = scored.filter(s => Math.abs(s.score - top.score) < 1e-9)
    const sameBase = tied.every(s => norm(s.w.baseName) === norm(top.w.baseName))
    // "portal" x8: ask which, but the nearest is returned as match; different names that merely both fit are ambiguous too
    return { match: top.w, candidates: tied.map(s => s.w), exact: top.exact, ambiguous: tied.length > 1, sameBase, score: top.score }
  }

  near(pos, dim = 0, n = 5) {
    return this.all(dim).map(w => ({ w, d: hdist(pos, w) })).sort((a, b) => a.d - b.d).slice(0, n).map(x => ({ ...x.w, dist: Math.round(x.d) }))
  }

  // Overworld portal waypoint <-> Nether portal waypoint pairs (the Nether is 1:8): [{ ow, nether, off }] by smallest offset.
  portalPairs() {
    const ow = this.all(0).filter(w => /portal/i.test(w.name)), ne = this.all(-1).filter(w => /portal/i.test(w.name))
    const out = []
    for (const o of ow) {
      let best = null
      for (const n of ne) { const off = Math.hypot(o.x / 8 - n.x, o.z / 8 - n.z); if (!best || off < best.off) best = { ow: o, nether: n, off } }
      if (best && best.off <= 24) out.push(best)
    }
    return out
  }
}

// x/z between dimensions (floor like the game does)
function convert(p, from, to) {
  if (from === to) return { x: p.x, z: p.z }
  if (from === 0 && to === -1) return { x: Math.floor(p.x / 8), z: Math.floor(p.z / 8) }
  if (from === -1 && to === 0) return { x: p.x * 8, z: p.z * 8 }
  return { x: p.x, z: p.z }
}

module.exports = { WaypointBook, dimOf, convert, norm, tokens, DIM_LABEL, hdist }
