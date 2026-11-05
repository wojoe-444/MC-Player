// Path-distance filter (Walter): a hostile 12 blocks away through solid rock is not a threat, one with a short WALKING path is.
// For hostiles inside pathRadius we ask the pathfinder for a path bot -> mob and only keep mobs whose path succeeds and is
// <= pathMax nodes. Results are cached per mob id (cacheMs), evaluation is budgeted per scan, and anything we could not afford to
// evaluate yet is trusted only when it is very close. Exceptions (see classify): adjacent mobs, flyers, climbers, arrow users
// (line of sight), neutral mobs.
//
// Uses bot.pathfinder.getPathFromTo (a pure generator) and NOT bot.pathfinder.getPathTo: the latter overwrites the pathfinder's
// internal astarContext and would corrupt whatever route another task is walking right now.
const { Vec3 } = require('vec3')
const { PROFILES, FLYING, CLIMBERS } = require('./profiles')

const PATH_DEFAULTS = {
  pathRadius: 24,       // only hostiles this close (straight line) are evaluated
  pathMax: 20,          // longest walking path that still counts as a threat
  pathTimeoutMs: 60,    // per path search (the search is synchronous: this is how long the bot can freeze)
  searchRadius: 32,
  cacheMs: 2000,
  movedInvalidate: 4,   // re-evaluate early when the mob moved this far since its path was computed
  maxEvalsPerScan: 3,
  budgetMs: 150,        // total time spent searching per scan
  closeSkip: 3.5,       // this close = threat without asking
  pendingTrust: 6,      // not yet evaluated: trusted only inside this straight-line range
  spiderRange: 10,      // climbers count as reachable inside this straight-line range
  losMax: 24
}

// Exact voxel traversal (Amanatides-Woo) from `from` to `to`: false when any voxel on the way, other than the first and last, is
// solid. solidAt(x,y,z) -> bool for the block containing the voxel. Diagonal corners are not squeezed through: a ray that passes
// between two solid blocks touching only at an edge visits one of them.
function lineOfSight(from, to, solidAt) {
  let x = Math.floor(from.x), y = Math.floor(from.y), z = Math.floor(from.z)
  const ex = Math.floor(to.x), ey = Math.floor(to.y), ez = Math.floor(to.z)
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z
  const sx = Math.sign(dx), sy = Math.sign(dy), sz = Math.sign(dz)
  const tdx = dx ? Math.abs(1 / dx) : Infinity, tdy = dy ? Math.abs(1 / dy) : Infinity, tdz = dz ? Math.abs(1 / dz) : Infinity
  let tx = dx ? ((sx > 0 ? x + 1 - from.x : from.x - x) * tdx) : Infinity
  let ty = dy ? ((sy > 0 ? y + 1 - from.y : from.y - y) * tdy) : Infinity
  let tz = dz ? ((sz > 0 ? z + 1 - from.z : from.z - z) * tdz) : Infinity
  for (let i = 0; i < 200; i++) {
    if (x === ex && y === ey && z === ez) return true
    if (tx <= ty && tx <= tz) { x += sx; tx += tdx } else if (ty <= tz) { y += sy; ty += tdy } else { z += sz; tz += tdz }
    if (x === ex && y === ey && z === ez) return true
    if (solidAt(x, y, z)) return false
  }
  return false
}

// Can a player whose eye is at `eye` hit / shoot this entity? Rays go from the eye to the hitbox centre, head, feet and both sides;
// any clear ray counts. Melee through a 1-block wall, over fences or round a corner is rejected.
function visibleFrom(bot, eye, e) {
  const h = e.height || 1.8, w = (e.width || 0.6) / 2, q = e.position
  const dx = q.x - eye.x, dz = q.z - eye.z, len = Math.hypot(dx, dz) || 1
  const px = -dz / len * w, pz = dx / len * w
  const targets = [
    { x: q.x, y: q.y + h * 0.5, z: q.z }, { x: q.x, y: q.y + h * 0.9, z: q.z }, { x: q.x, y: q.y + 0.15, z: q.z },
    { x: q.x + px, y: q.y + h * 0.5, z: q.z + pz }, { x: q.x - px, y: q.y + h * 0.5, z: q.z - pz }
  ]
  const solid = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); return !!b && b.boundingBox === 'block' }
  return targets.some(t => lineOfSight(eye, t, solid))
}
function entityVisible(bot, e) { const p = bot.entity.position; return visibleFrom(bot, { x: p.x, y: p.y + 1.62, z: p.z }, e) }

// A standable spot within melee reach of the entity from which it can be hit, nearest to the bot first. Only ground the bot can
// stand on is considered (empty feet and head, solid floor); nothing is dug or placed to get there. null when there is none.
function findVisibleSpot(bot, e, { reach = 2.8, minDist = 1.0 } = {}) {
  const me = bot.entity.position, q = e.position
  const isEmpty = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); return !b || b.boundingBox === 'empty' }
  const isSolid = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); return !!b && b.boundingBox === 'block' }
  const cands = []
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -1; dy <= 1; dy++) {
    const x = Math.floor(q.x) + dx, y = Math.floor(q.y) + dy, z = Math.floor(q.z) + dz
    const d = Math.hypot(x + 0.5 - q.x, z + 0.5 - q.z)
    if (d < minDist || d > reach) continue
    if (!isEmpty(x, y, z) || !isEmpty(x, y + 1, z) || !isSolid(x, y - 1, z)) continue
    cands.push({ x, y, z, far: Math.hypot(x + 0.5 - me.x, z + 0.5 - me.z) + Math.abs(y - me.y) })
  }
  cands.sort((m, n) => m.far - n.far)
  for (const c of cands.slice(0, 40)) {
    if (visibleFrom(bot, { x: c.x + 0.5, y: c.y + 1.62, z: c.z + 0.5 }, e)) return new Vec3(c.x, c.y, c.z)
  }
  return null
}

class PathReach {
  constructor({ bot, goals, now = Date.now, log = () => {}, cfg = {}, clock = () => performance.now() }) {
    this.bot = bot; this.goals = goals; this.now = now; this.log = log; this.clock = clock
    this.C = { ...PATH_DEFAULTS, ...cfg }
    this.cache = new Map()        // id -> { at, ok, why, pathLen, status, pos }
    this.suppressed = new Set()   // ids already reported in safety.log
    this.stat = { evals: 0, suppressed: 0, timeouts: 0, noPathfinder: false }
  }

  _solid() {
    const bot = this.bot
    return (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); return !!b && b.boundingBox === 'block' }
  }
  _los(mob) {
    const bot = this.bot, p = bot.entity.position
    const eye = { x: p.x, y: p.y + 1.62, z: p.z }
    const to = { x: mob.pos.x, y: mob.pos.y + ((mob.entity && mob.entity.height) || 1.8) * 0.85, z: mob.pos.z }
    return lineOfSight(eye, to, this._solid())
  }

  los(mob) { return this._los(mob) }

  // Walking path from the bot to a fixed position (a shelter). { status, len, ok } where ok = found within maxLen. Same pure generator as _search.
  pathTo(pos, { radius = 2, timeout = 150, searchRadius = 160, maxLen = 120 } = {}) {
    const bot = this.bot, mv = bot.pathfinder && bot.pathfinder.movements
    if (!mv || typeof bot.pathfinder.getPathFromTo !== 'function') return { status: 'unavailable', len: 0, ok: true }
    try {
      const goal = new this.goals.GoalNear(pos.x, pos.y, pos.z, radius)
      const r = bot.pathfinder.getPathFromTo(mv, bot.entity.position, goal, { timeout, tickTimeout: timeout, searchRadius, optimizePath: false, resetEntityIntersects: false }).next().value.result
      const len = r.path ? r.path.length : 0
      return { status: r.status, len, ok: r.status === 'success' && len <= maxLen }
    } catch (e) { return { status: 'error', len: 0, ok: true } }
  }

  _search(mob) {
    const bot = this.bot, mv = bot.pathfinder && bot.pathfinder.movements
    if (!mv || typeof bot.pathfinder.getPathFromTo !== 'function') {
      if (!this.stat.noPathfinder) { this.stat.noPathfinder = true; this.log('path check unavailable (no movements/getPathFromTo): using straight-line distance') }
      return { status: 'unavailable', pathLen: 0, ok: true }
    }
    const goal = new this.goals.GoalNear(mob.pos.x, mob.pos.y, mob.pos.z, 1)
    try {
      const gen = bot.pathfinder.getPathFromTo(mv, bot.entity.position, goal, {
        timeout: this.C.pathTimeoutMs, tickTimeout: this.C.pathTimeoutMs, searchRadius: this.C.searchRadius, optimizePath: false, resetEntityIntersects: false
      })
      const r = gen.next().value.result
      const pathLen = r.path ? r.path.length : 0
      return { status: r.status, pathLen, ok: r.status === 'success' && pathLen <= this.C.pathMax }
    } catch (e) {
      this.log('path search failed, treating as reachable: ' + e.message)
      return { status: 'error', pathLen: 0, ok: true }
    }
  }

  // mobs: [{id,name,pos,entity?}]. Returns Map id -> { ok, why, pathLen?, status? }
  check(mobs) {
    const C = this.C, bot = this.bot, t = this.now(), me = bot.entity.position
    const out = new Map()
    const todo = []
    for (const m of mobs) {
      const d = me.distanceTo(m.pos)
      const prof = PROFILES[m.name]
      const pass = (why) => out.set(m.id, { ok: true, why })
      if (d > C.pathRadius) { pass('far'); continue }
      if (prof && prof.kind === 'neutral') { pass('neutral'); continue }
      if (d <= C.closeSkip) { pass('adjacent'); continue }
      if (FLYING.has(m.name)) { pass('flying'); continue }
      if (prof && prof.kind === 'ranged' && d <= C.losMax && this._los(m)) { pass('line of sight'); continue }
      if (CLIMBERS.has(m.name) && d <= C.spiderRange) { pass('climber'); continue }
      const c = this.cache.get(m.id)
      if (c && t - c.at < C.cacheMs && c.pos.distanceTo(m.pos) < C.movedInvalidate) { out.set(m.id, { ok: c.ok, why: c.why, pathLen: c.pathLen, status: c.status }); continue }
      todo.push({ m, d })
    }
    todo.sort((a, b) => a.d - b.d)
    let evals = 0, spent = 0
    for (const { m, d } of todo) {
      if (evals >= C.maxEvalsPerScan || spent >= C.budgetMs) { out.set(m.id, { ok: d <= C.pendingTrust, why: 'pending' }); continue }
      const t0 = this.clock()
      const r = this._search(m)
      spent += this.clock() - t0; evals++; this.stat.evals++
      const why = r.status === 'unavailable' ? 'no pathfinder' : r.ok ? `path ${r.pathLen}` : r.status === 'success' ? `path ${r.pathLen} > ${C.pathMax}` : `no walking path (${r.status})`
      if (r.status === 'timeout') this.stat.timeouts++
      this.cache.set(m.id, { at: t, ok: r.ok, why, pathLen: r.pathLen, status: r.status, pos: m.pos.clone ? m.pos.clone() : new Vec3(m.pos.x, m.pos.y, m.pos.z) })
      out.set(m.id, { ok: r.ok, why, pathLen: r.pathLen, status: r.status })
      if (!r.ok) {
        this.stat.suppressed++
        if (!this.suppressed.has(m.id)) { this.suppressed.add(m.id); this.log(`suppressed ${m.name}#${m.id} at ${d.toFixed(1)} blocks straight-line: ${why}`) }
      } else if (this.suppressed.delete(m.id)) this.log(`now reachable ${m.name}#${m.id} at ${d.toFixed(1)} blocks: ${why}`)
    }
    // forget mobs that are gone
    if (t - (this._cleanedAt || 0) > 5000) { this._cleanedAt = t; const live = new Set(mobs.map(x => x.id)); for (const id of [...this.cache.keys()]) if (!live.has(id)) { this.cache.delete(id); this.suppressed.delete(id) } }
    return out
  }
}

module.exports = { PathReach, lineOfSight, entityVisible, visibleFrom, findVisibleSpot, PATH_DEFAULTS }
