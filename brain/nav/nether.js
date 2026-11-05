// The safe Nether network: a log of the Nether places and walked routes that are known to be safe, kept in brain/state/nether-network.json.
//
// Walter's rule (FEATURE-REQUESTS.md, 2026-10-26): in the Nether the bot travels ONLY along logged segments, never by algorithmic
// pathfinding, and asks Walter before exploring anything new. This file is the data and the planning on top of it; nether-walk.js records
// walks and follows segments.
//
//   nodes     portals (seeded from Walter's Xaero Nether waypoints), junctions (where a walked route starts/ends) and places of interest
//   segments  a walked polyline between two nodes (vertices every ~2 blocks, with the y it was walked at), who walked it, whether it is verified,
//             how often the bot has walked it since, and the hazards seen next to it (lava, fire, ledges)
//   hazards   areas to keep away from (seeded: the 12 lava blocks around the arrival portal at -129,61,288)
//   pending   one question to Walter ("explore from A to B?") that is waiting for his answer
//
// A segment is USABLE when it is verified and not blocked. Verified means: Walter walked it himself, or the bot walked it twice without an
// incident (the exploration trip plus the walk back), or Walter said so. A segment that stopped the bot (lava next to the path, a ledge, an
// unexpected change) is blocked until Walter clears it.
const fs = require('fs')
const path = require('path')
const { hdist } = require('./waypoints')

const NODE_MERGE = 4            // a new node within this many blocks of an old one is the old one
const SEG_STEP = 2.0            // vertex spacing of a logged path
const SNAP = 4                  // how close the bot must be to a vertex/node to count as "on the network"

const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const pt = (p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 })

class NetherNetwork {
  constructor({ file = null, now = Date.now, log = () => {} } = {}) {
    this.file = file
    this.now = now
    this.log = log
    this.data = { version: 1, seq: 0, nodes: {}, segments: {}, hazards: [], pending: null }
    this.dirty = false
    this.load()
  }

  // ---------- persistence ----------
  load() {
    if (!this.file) return
    try { const d = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^﻿/, '')); if (d && d.version === 1) this.data = { ...this.data, ...d } } catch { /* first run */ }
  }
  save() {
    if (!this.file || !this.dirty) return false
    try { const tmp = this.file + '.tmp'; fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(tmp, JSON.stringify(this.data)); fs.renameSync(tmp, this.file); this.dirty = false; return true } catch (e) { this.log('nether-network save failed: ' + e.message); return false }
  }
  touch() { this.dirty = true }
  id(prefix) { this.data.seq++; return `${prefix}${this.data.seq}` }

  // ---------- nodes ----------
  nodes() { return Object.values(this.data.nodes) }
  segments() { return Object.values(this.data.segments) }
  nearestNode(p, max = NODE_MERGE) {
    let best = null
    for (const n of this.nodes()) { const d = d3(n, p); if (d <= max && (!best || d < best.d)) best = { n, d } }
    return best ? best.n : null
  }
  addNode({ name = null, x, y, z, kind = 'junction', source = 'walked', verified = false }) {
    const near = this.nearestNode({ x, y, z })
    if (near) {
      // a named/portal node beats a junction that happens to sit next to it
      if (name && !near.name) near.name = name
      if (kind === 'portal') near.kind = 'portal'
      if (verified) near.verified = true
      this.touch()
      return near
    }
    const n = { id: this.id('n'), kind, name, x: Math.round(x), y: Math.round(y), z: Math.round(z), source, verified: !!verified, at: this.now() }
    this.data.nodes[n.id] = n
    this.touch()
    return n
  }
  // Walter's Xaero waypoints in the Nether: portals become verified portal nodes (he placed them), the rest places of interest.
  seedFromBook(book, hazards = []) {
    let added = 0
    for (const w of book.all(-1)) {
      const before = Object.keys(this.data.nodes).length
      const isPortal = /portal/i.test(w.name)
      this.addNode({ name: w.name, x: w.x, y: typeof w.y === 'number' ? w.y : 64, z: w.z, kind: isPortal ? 'portal' : 'poi', source: 'xaero', verified: true })
      if (Object.keys(this.data.nodes).length > before) added++
    }
    for (const h of hazards) this.addHazard({ ...h, source: h.source || 'seed' })
    return added
  }

  // ---------- hazards ----------
  addHazard({ kind, x, y, z, r = 2, note = '', source = 'bot' }) {
    const dup = this.data.hazards.find(h => h.kind === kind && Math.hypot(h.x - x, h.z - z) <= 1.5 && Math.abs(h.y - y) <= 2)
    if (dup) { dup.r = Math.max(dup.r, r); return dup }
    const h = { id: this.id('h'), kind, x: Math.round(x), y: Math.round(y), z: Math.round(z), r, note, source, at: this.now() }
    this.data.hazards.push(h)
    this.touch()
    return h
  }
  hazardsNear(p, r = 8) { return this.data.hazards.filter(h => hdist(h, p) <= r + h.r) }

  // ---------- segments ----------
  thin(points) {
    const out = []
    for (const p of points) if (!out.length || d3(out[out.length - 1], p) >= SEG_STEP) out.push(pt(p))
    const last = points[points.length - 1]
    if (out.length && d3(out[out.length - 1], last) > 0.4) out.push(pt(last))
    return out
  }
  length(points) { let l = 0; for (let i = 1; i < points.length; i++) l += d3(points[i - 1], points[i]); return l }
  // Log a walked path. Both ends attach to a node within NODE_MERGE blocks, or become junction nodes. If the same route is already logged
  // (same two nodes, every vertex within 2 blocks of the old line) the old segment's walk count goes up instead of adding a copy.
  addSegment({ points, source = 'walter', verified = false, hazards = [], note = '' }) {
    if (!points || points.length < 2) return null
    const pts = this.thin(points)
    if (pts.length < 2 || this.length(pts) < 6) return null
    const a = this.addNode({ ...pts[0], kind: 'junction', source: 'walked' })
    const b = this.addNode({ ...pts[pts.length - 1], kind: 'junction', source: 'walked' })
    if (a.id === b.id) return null
    for (const s of this.segments()) {
      const same = (s.a === a.id && s.b === b.id) || (s.a === b.id && s.b === a.id)
      if (same && this.within(pts, s.points, 2.5)) {
        s.walks = (s.walks || 0) + 1
        if (source === 'walter') { s.verified = true; s.sources = [...new Set([...(s.sources || [s.source]), 'walter'])] }
        this.touch()
        return s
      }
    }
    const seg = { id: this.id('s'), a: a.id, b: b.id, points: pts, length: Math.round(this.length(pts)), source, sources: [source], verified: !!verified, blocked: null, walks: 1, botWalks: source === 'bot-explore' ? 1 : 0, hazards, note, at: this.now() }
    this.data.segments[seg.id] = seg
    for (const h of hazards) this.addHazard({ ...h, source })
    this.touch()
    return seg
  }
  within(pts, line, tol) {
    return pts.every(p => line.some(q => d3(p, q) <= tol + SEG_STEP / 2))
  }
  // Verified, or one the bot walked itself during an approved exploration (its own tracks; a second walk makes it verified). Never a blocked one.
  usable(seg, { allowUnverified = false } = {}) { return !seg.blocked && (seg.verified || allowUnverified || (seg.source === 'bot-explore' && (seg.botWalks || 0) >= 1)) }
  // the bot walked a logged segment to the end (ok) or stopped on it (not ok: the reason blocks it until Walter clears it)
  noteBotWalk(segId, ok, reason = '') {
    const s = this.data.segments[segId]
    if (!s) return
    if (ok) { s.botWalks = (s.botWalks || 0) + 1; if (!s.verified && s.botWalks >= 2) s.verified = true }
    else { s.blocked = { reason, at: this.now() } }
    this.touch()
  }
  clearBlock(segId) { const s = this.data.segments[segId]; if (s) { s.blocked = null; this.touch() } return !!s }
  verify(segId) { const s = this.data.segments[segId]; if (s) { s.verified = true; s.blocked = null; this.touch() } return !!s }

  // ---------- where am I / how do I get there ----------
  // Nearest logged vertex (or node) to p: { seg, index, d } or { node, d }.
  snap(p, max = SNAP, opts = {}) {
    let best = null
    for (const n of this.nodes()) { const d = d3(n, p); if (d <= max && (!best || d < best.d)) best = { node: n, d } }
    for (const s of this.segments()) {
      if (!this.usable(s, opts)) continue
      for (let i = 0; i < s.points.length; i++) { const d = d3(s.points[i], p); if (d <= max && (!best || d < best.d - 0.01)) best = { seg: s, index: i, d } }
    }
    return best
  }
  // Shortest chain of usable segments from node `from` to node `to` (ids). Returns { ok, legs: [{ seg, reverse }], length } or { ok:false, err }.
  route(from, to, { allowUnverified = false } = {}) {
    if (from === to) return { ok: true, legs: [], length: 0 }
    const dist = { [from]: 0 }, prev = {}, done = new Set()
    for (;;) {
      let u = null
      for (const k of Object.keys(dist)) if (!done.has(k) && (u === null || dist[k] < dist[u])) u = k
      if (u === null) break
      if (u === to) break
      done.add(u)
      for (const s of this.segments()) {
        if (!this.usable(s, { allowUnverified })) continue
        const v = s.a === u ? s.b : s.b === u ? s.a : null
        if (!v || done.has(v)) continue
        const nd = dist[u] + s.length
        if (dist[v] === undefined || nd < dist[v]) { dist[v] = nd; prev[v] = { u, s, reverse: s.b === u } }
      }
    }
    if (dist[to] === undefined) return { ok: false, err: 'no logged route' }
    const legs = []
    for (let v = to; v !== from; v = prev[v].u) legs.unshift({ seg: prev[v].s, reverse: prev[v].reverse })
    return { ok: true, legs, length: Math.round(dist[to]) }
  }
  pointsOf(seg, reverse = false) { return reverse ? seg.points.slice().reverse() : seg.points }

  // ---------- the question waiting for Walter ----------
  ask(q) { this.data.pending = { ...q, at: this.now() }; this.touch(); return this.data.pending }
  pending(maxAgeMs = 10 * 60000) { const p = this.data.pending; return p && this.now() - p.at <= maxAgeMs ? p : null }
  clearPending() { this.data.pending = null; this.touch() }

  summary() {
    const segs = this.segments()
    return {
      nodes: this.nodes().length, portals: this.nodes().filter(n => n.kind === 'portal').length,
      segments: segs.length, usable: segs.filter(s => this.usable(s)).length, blocked: segs.filter(s => s.blocked).length, unverified: segs.filter(s => !s.verified && !s.blocked).length,
      blocks: Math.round(segs.filter(s => this.usable(s)).reduce((n, s) => n + s.length, 0)), hazards: this.data.hazards.length
    }
  }
}

module.exports = { NetherNetwork, NODE_MERGE, SEG_STEP, SNAP, d3 }
