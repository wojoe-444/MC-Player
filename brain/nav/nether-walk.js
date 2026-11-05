// Walking the logged Nether network: scanning a path for hazards, recording walks (Walter's, and the bot's own during an approved
// exploration), and FOLLOWING a logged segment vertex by vertex with plain control states. There is no path search in here at all:
// the bot faces the next logged vertex, walks to it, jumps the step the log says is there, and stops the moment the world in front of it
// is not what the log promises (lava, fire, a hole, a drop of more than 3, a wall it cannot step over, or it left the logged line).
// Driven by `physicsTick`, no timers.
const { Vec3 } = require('vec3')
const { d3 } = require('./nether')

const LAVA_LIKE = /^(lava|flowing_lava|fire|soul_fire|magma_block|campfire|soul_campfire|cactus|sweet_berry_bush|powder_snow|nether_portal|pointed_dripstone|cobweb|sculk_sensor|sculk_shrieker)$/
const nameAt = (bot, x, y, z) => { const b = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))); return b ? b : null }

// Hazards next to a path: lava/fire/magma within 2 blocks, ledges (no floor within 3 blocks below a cell beside the path).
// Returns [{ kind, x, y, z, idx, note }] (deduplicated), only for chunks that are loaded.
function scanHazards(bot, points) {
  const out = [], seen = new Set()
  const add = (kind, x, y, z, idx, note) => { const k = `${kind}|${x}|${y}|${z}`; if (!seen.has(k)) { seen.add(k); out.push({ kind, x, y, z, idx, note, r: kind === 'ledge' ? 1 : 2 }) } }
  points.forEach((p, idx) => {
    const fx = Math.floor(p.x), fy = Math.floor(p.y + 1e-3), fz = Math.floor(p.z)
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -1; dy <= 2; dy++) {
      const b = nameAt(bot, fx + dx, fy + dy, fz + dz)
      if (b && LAVA_LIKE.test(b.name) && b.name !== 'nether_portal') add(b.name === 'lava' || b.name === 'flowing_lava' ? 'lava' : b.name, fx + dx, fy + dy, fz + dz, idx, `${b.name} ${Math.max(Math.abs(dx), Math.abs(dz))} block(s) from the path`)
    }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = fx + dx, z = fz + dz
      const feet = nameAt(bot, x, fy, z)
      if (!feet || feet.boundingBox !== 'empty') continue
      let floor = false
      for (let k = 1; k <= 4; k++) { const b = nameAt(bot, x, fy - k, z); if (!b) { floor = true; break } if (b.boundingBox === 'block') { floor = k <= 3; break } }
      if (!floor) add('ledge', x, fy, z, idx, 'drop of more than 3 blocks beside the path')
    }
  })
  return out
}

// ---------------------------------------------------------------- recording walks
// Records where Walter walks in the Nether (his entity, while it is loaded and on the ground) and, only while `botTrace` is on (an exploration
// Walter approved), where the bot walks. A trace ends when its subject is out of sight for 5 s, stands still for 30 s, leaves the ground for
// a jump of more than 6 blocks (flying, teleport) or the dimension changes; traces of 12+ blocks become segments.
class PathRecorder {
  constructor({ bot, network, ownerName = 'OGWO', dimOf, log = () => {}, config = {} }) {
    this.bot = bot
    this.net = network
    this.owner = ownerName
    this.dimOf = dimOf
    this.log = log
    this.cfg = { sampleTicks: 4, minLen: 12, lostTicks: 100, idleTicks: 300, maxPoints: 4000, ...config }
    this.t = 0
    this.traces = {}              // subject -> { pts, lastSeen, lastMove }
    this.botTrace = false         // set by the exploration code
    this.botVerified = false
    this.saved = []
    this._onTick = () => this.tick()
    this._onDim = () => this.flush('dimension change')
  }
  attach() { this.bot.on('physicsTick', this._onTick); this.bot.on('respawn', this._onDim); this.bot.on('forcedMove', this._onDim); return this }
  detach() { this.bot.removeListener('physicsTick', this._onTick); this.bot.removeListener('respawn', this._onDim); this.bot.removeListener('forcedMove', this._onDim); this.flush('stopped') }

  subjects() {
    const out = []
    const w = this.bot.players && this.bot.players[this.owner]
    if (this.enabled !== false && w && w.entity && w.entity.position) out.push({ name: 'walter', pos: w.entity.position, ground: w.entity.onGround !== false })
    if (this.botTrace && this.bot.entity) out.push({ name: 'bot', pos: this.bot.entity.position, ground: this.bot.entity.onGround })
    return out
  }

  tick() {
    this.t++
    if (this.t % this.cfg.sampleTicks) return
    if (this.dimOf(this.bot) !== -1) { if (Object.keys(this.traces).length) this.flush('left the Nether'); return }
    const seen = new Set()
    for (const s of this.subjects()) {
      seen.add(s.name)
      let tr = this.traces[s.name]
      const p = { x: s.pos.x, y: s.pos.y, z: s.pos.z }
      if (tr && d3(tr.pts[tr.pts.length - 1], p) > 6) { this.end(s.name, 'jumped'); tr = null }       // flying / teleport: not a walked path
      if (!s.ground) { tr && (tr.lastSeen = this.t); continue }
      if (!tr) tr = this.traces[s.name] = { pts: [], lastSeen: this.t, lastMove: this.t }
      tr.lastSeen = this.t
      const last = tr.pts[tr.pts.length - 1]
      if (!last || d3(last, p) >= 1.6) { tr.pts.push(p); tr.lastMove = this.t }
      if (tr.pts.length > this.cfg.maxPoints) this.end(s.name, 'long')
    }
    for (const name of Object.keys(this.traces)) {
      const tr = this.traces[name]
      if (!seen.has(name) && this.t - tr.lastSeen > this.cfg.lostTicks) this.end(name, 'out of sight')
      else if (this.t - tr.lastMove > this.cfg.idleTicks) this.end(name, 'idle')
    }
  }

  end(name, why) {
    const tr = this.traces[name]
    delete this.traces[name]
    if (!tr || this.net.length(tr.pts) < this.cfg.minLen) return null
    const hazards = scanHazards(this.bot, this.net.thin(tr.pts))
    const critical = hazards.some(h => h.kind !== 'ledge' && h.kind !== 'lava')       // standing in fire/magma on the line itself is not a safe route
    const walter = name === 'walter'
    const seg = this.net.addSegment({
      points: tr.pts, source: walter ? 'walter' : 'bot-explore', verified: walter && !critical, hazards,
      note: `${walter ? 'Walter' : 'the bot (approved exploration)'} walked it (${why})`
    })
    if (seg) { this.saved.push(seg.id); this.log(`logged Nether ${walter ? 'walk by Walter' : 'exploration'} as ${seg.id}: ${seg.length} blocks, ${hazards.length} hazards noted, ${seg.verified ? 'verified' : 'unverified'}`) }
    return seg
  }
  flush(why) { for (const n of Object.keys(this.traces)) this.end(n, why) }
}

// ---------------------------------------------------------------- following a logged segment
// walk(points): resolves { ok, err, reached, idx }. No pathfinder. err is one of: 'not on the logged route', 'hazard ahead: lava', 'ledge', 'wall',
// 'off the logged route', 'stuck', 'aborted', 'blocked: <block>'.
class SegmentWalker {
  constructor({ bot, log = () => {}, config = {} }) {
    this.bot = bot
    this.log = log
    this.cfg = { reach: 0.4, startSnap: 4.5, corridor: 2.4, ticksPerVertex: 80, maxFall: 3, ...config }
    this.job = null
    this._onTick = () => this.tick()
  }
  attach() { this.bot.on('physicsTick', this._onTick); return this }
  detach() { this.bot.removeListener('physicsTick', this._onTick); this.finish({ ok: false, err: 'aborted' }) }
  get active() { return !!this.job }

  walk(points, { isAborted = null, startIndex = null } = {}) {
    if (this.job) this.finish({ ok: false, err: 'replaced' })
    const bot = this.bot
    if (bot.pathfinder) bot.pathfinder.setGoal(null)                       // nothing else may steer while we follow the log
    const p = bot.entity.position
    // start at the nearest logged vertex (it must be close), then walk on to the next ones
    let near = 0, nd = Infinity
    for (let i = 0; i < points.length; i++) { const d = d3(points[i], p); if (d < nd) { nd = d; near = i } }
    if (startIndex === null && nd > this.cfg.startSnap) return Promise.resolve({ ok: false, err: 'not on the logged route', reached: false, idx: 0 })
    return new Promise((resolve) => {
      this.job = { points, idx: Math.max(1, (startIndex !== null ? startIndex : near) + (nd < 0.9 ? 1 : 0)), isAborted, resolve, ticks: 0, vertexTicks: 0, lastPos: p.clone(), still: 0, walled: 0, waitChunk: 0, jumpedAt: -99 }
      if (this.job.idx >= points.length) this.finish({ ok: true, reached: true, idx: points.length - 1 })
    })
  }
  stop(reason = 'aborted') { if (this.job) this.finish({ ok: false, err: reason }) }

  finish(res) {
    const j = this.job
    if (!j) return
    this.job = null
    try { this.bot.clearControlStates() } catch { /* ignore */ }
    j.resolve({ reached: false, idx: j.idx, ...res })
  }

  // Is it still safe to step into the cell at (x, z) ahead? null when fine, else the reason. A solid block at foot height is fine only where the
  // log has a step up (targetY above us); otherwise it is a wall. Without a floor within maxFall+1 blocks it is a ledge.
  danger(x, z, y, targetY) {
    const bot = this.bot
    const fy = Math.floor(y + 1e-3)
    const feet = nameAt(bot, x, fy, z), head = nameAt(bot, x, fy + 1, z)
    if (!feet || !head) return 'chunk not loaded'
    for (const b of [feet, head]) if (LAVA_LIKE.test(b.name)) return `hazard ahead: ${b.name}`
    if (feet.boundingBox === 'block') return targetY <= y + 0.5 ? 'wall' : null
    for (let k = 1; k <= this.cfg.maxFall + 1; k++) {
      const b = nameAt(bot, x, fy - k, z)
      if (!b) return 'chunk not loaded'
      if (LAVA_LIKE.test(b.name)) return `hazard ahead: ${b.name}`
      if (b.boundingBox === 'block') return null
    }
    return 'ledge'
  }

  tick() {
    const j = this.job
    if (!j) return
    const bot = this.bot, p = bot.entity.position
    j.ticks++; j.vertexTicks++
    if (j.isAborted && j.isAborted()) return this.finish({ ok: false, err: 'aborted' })
    if (bot.isSleeping) return this.finish({ ok: false, err: 'aborted' })
    if (bot.entity.isInLava) return this.finish({ ok: false, err: 'hazard: in lava' })
    const target = j.points[j.idx], prev = j.points[j.idx - 1]
    const dx = target.x - p.x, dz = target.z - p.z, dy = target.y - p.y, hd = Math.hypot(dx, dz)
    // reached this vertex?
    if (hd <= this.cfg.reach && Math.abs(dy) < 1.2) {
      j.idx++; j.vertexTicks = 0
      if (j.idx >= j.points.length) return this.finish({ ok: true, reached: true, idx: j.points.length - 1 })
      return this.tick()
    }
    // the logged line: distance from the segment prev -> target
    const sx = target.x - prev.x, sz = target.z - prev.z, l2 = sx * sx + sz * sz || 1
    const t = Math.max(0, Math.min(1, ((p.x - prev.x) * sx + (p.z - prev.z) * sz) / l2))
    const off = Math.hypot(prev.x + sx * t - p.x, prev.z + sz * t - p.z)
    if (off > this.cfg.corridor) return this.finish({ ok: false, err: 'off the logged route' })
    if (j.vertexTicks > this.cfg.ticksPerVertex) return this.finish({ ok: false, err: 'stuck' })
    // what is directly ahead (one body length) must match the log
    const ux = hd > 1e-6 ? dx / hd : 0, uz = hd > 1e-6 ? dz / hd : 0
    const ax = p.x + ux * 0.9, az = p.z + uz * 0.9
    const bad = this.danger(ax, az, p.y, target.y)
    if (bad === 'chunk not loaded') {                                     // wait for the world to arrive instead of guessing
      bot.clearControlStates()
      if (++j.waitChunk > 100) return this.finish({ ok: false, err: bad })
      return
    }
    if (bad && bad !== 'wall') return this.finish({ ok: false, err: bad })
    // steer: turn toward the vertex (at most ~0.45 rad per tick, like a hand on the mouse), walk, jump the step the log has
    let want = Math.atan2(-dx, -dz), cur = bot.entity.yaw
    let diff = ((want - cur + Math.PI * 3) % (Math.PI * 2)) - Math.PI
    bot.look(cur + Math.max(-0.45, Math.min(0.45, diff)), 0)
    const facing = Math.abs(diff) < 0.6
    bot.setControlState('forward', facing)
    bot.setControlState('sprint', false)
    bot.setControlState('back', false); bot.setControlState('left', false); bot.setControlState('right', false)
    const needsStep = dy > 0.45 && hd < 1.8
    const bumped = bot.entity.isCollidedHorizontally && bot.entity.onGround
    const wantJump = (needsStep || bumped) && bot.entity.onGround && j.ticks - j.jumpedAt > 6
    if (wantJump) j.jumpedAt = j.ticks
    bot.setControlState('jump', !!wantJump)
    if (bad === 'wall' && ++j.walled > 20) return this.finish({ ok: false, err: 'wall' })
    // standing still although we press forward
    if (p.distanceTo(j.lastPos) < 0.02) { j.still++; if (j.still > 50) return this.finish({ ok: false, err: 'stuck' }) } else { j.still = 0; j.lastPos = p.clone() }
  }
}

module.exports = { scanHazards, PathRecorder, SegmentWalker, LAVA_LIKE }
