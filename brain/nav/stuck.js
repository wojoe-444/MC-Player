// Stuck detection and recovery, driven by `physicsTick` (so it works in game time, and in tests in virtual time).
//
// "Stuck" means: the pathfinder has a path and is pressing forward, but the bot has not really moved for a while
// (or keeps dithering inside a tiny area). Recovery climbs a ladder of increasingly firm, still player-like actions:
//   1. tap jump            2. sidestep + jump, re-plan        3. back up, remember the blocked cell, re-plan
//   4. longer back-up + bigger no-go area around the blocked cell, re-plan        5. give up ('stuck-fail') so the caller can tell Walter
// It never teleports, digs or places: every action is a control-state press for a few ticks.
const { Vec3 } = require('vec3')

const B = require('./blocks')

const KEY = (x, y, z) => `${x},${y},${z}`
const HAZARDS = new Set([...B.HARD_AVOID, 'water'])

// Cells the planner should avoid for a while (where we got stuck, doors that would not open).
class Penalties {
  constructor() { this.m = new Map(); this.t = 0 }
  tick() { this.t++; if (this.m.size && this.t % 100 === 0) for (const [k, v] of this.m) if (v.until <= this.t) this.m.delete(k) }
  add(x, y, z, weight, ticks = 1200) {
    const k = KEY(Math.floor(x), Math.floor(y), Math.floor(z))
    const cur = this.m.get(k)
    this.m.set(k, { weight: Math.max(weight, cur ? cur.weight : 0), until: this.t + ticks })
  }
  addArea(x, y, z, r, weight, ticks) {
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let dy = -1; dy <= 1; dy++) this.add(x + dx, y + dy, z + dz, weight, ticks)
  }
  // exclusionAreasStep() function for the Movements object
  weight = (block) => {
    if (!this.m.size || !block || !block.position) return 0
    const v = this.m.get(KEY(block.position.x, block.position.y, block.position.z))
    return v && v.until > this.t ? v.weight : 0
  }
  clear() { this.m.clear() }
  get size() { return this.m.size }
}

class StuckMonitor extends require('events') {
  constructor({ bot, penalties, log = () => {}, config = {} }) {
    super()
    this.bot = bot
    this.pen = penalties
    this.log = log
    this.cfg = { windowTicks: 50, minMove: 0.45, ditherTicks: 160, ditherRadius: 2.2, calmTicks: 400, ...config }
    this.t = 0
    this.hist = []                 // recent positions, one per tick while following a path
    this.level = 0                 // current escalation level (0 = fine)
    this.lastTrouble = 0           // tick of the last stuck episode
    this.action = null             // running maneuver: { name, left, controls, goal, dynamic }
    this.stats = { episodes: 0, maxLevel: 0, failed: 0 }
    this.dynamic = false           // set by the navigator when the current goal is a dynamic one (follow)
    this.livePath = []
    this._onTick = () => this.tick()
    this._onPath = (r) => { this.livePath = (r && r.path) || [] }
    this._onReset = () => { this.livePath = [] }
  }
  attach() {
    this.bot.on('physicsTick', this._onTick)
    this.bot.on('path_update', this._onPath)
    this.bot.on('path_reset', this._onReset)
    this.bot.on('path_stop', this._onReset)
    return this
  }
  detach() {
    this.bot.removeListener('physicsTick', this._onTick)
    this.bot.removeListener('path_update', this._onPath)
    this.bot.removeListener('path_reset', this._onReset)
    this.bot.removeListener('path_stop', this._onReset)
    this.action = null
  }
  reset() { this.hist.length = 0; this.level = 0; this.action = null }
  get goal() { return this.bot.pathfinder && this.bot.pathfinder.goal }
  get maneuvering() { return !!this.action }

  tick() {
    this.t++
    this.pen.tick()
    const bot = this.bot, p = bot.entity && bot.entity.position
    if (!p) return
    if (this.action) return this.runAction()                    // a maneuver in progress owns the controls
    const moving = bot.pathfinder && bot.pathfinder.isMoving() && this.goal
    if (!moving || bot.isSleeping) { this.hist.length = 0; return }
    this.hist.push(p.clone())
    if (this.hist.length > this.cfg.ditherTicks) this.hist.shift()
    if (!bot.controlState.forward) { this.hist.length = 0; return }   // waiting for something (a door, a block update): not stuck
    const w = this.cfg.windowTicks
    if (this.hist.length < w) return
    const old = this.hist[this.hist.length - w]
    const moved = Math.hypot(p.x - old.x, p.z - old.z) + Math.abs(p.y - old.y)
    if (moved < this.cfg.minMove) return this.stuck('no progress')
    if (this.level && this.t - this.lastTrouble > this.cfg.calmTicks) this.level = 0
    if (this.hist.length >= this.cfg.ditherTicks && this.dithering()) return this.stuck('dithering')
  }

  dithering() {
    // inside a small volume for the whole history although the path says go somewhere (a ladder climb moves only vertically: not dithering)
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity
    for (const q of this.hist) { minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x); minZ = Math.min(minZ, q.z); maxZ = Math.max(maxZ, q.z); minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y) }
    return Math.hypot(maxX - minX, maxZ - minZ) < this.cfg.ditherRadius && (maxY - minY) < 2.5 && this.livePath.length > 3
  }

  // ---- escalation ----
  stuck(why) {
    const bot = this.bot, p = bot.entity.position
    if (this.t - this.lastTrouble > this.cfg.calmTicks) this.level = 0
    this.level++
    this.lastTrouble = this.t
    this.stats.episodes++; this.stats.maxLevel = Math.max(this.stats.maxLevel, this.level)
    this.hist.length = 0
    const next = this.livePath[0]
    this.log(`stuck (${why}) level ${this.level} at ${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}${next ? ' heading for ' + Math.floor(next.x) + ',' + Math.floor(next.y) + ',' + Math.floor(next.z) : ''}`)
    this.emit('stuck', { level: this.level, why, pos: p.clone() })
    const penalize = (r, w) => { if (next) this.pen.addArea(next.x, Math.floor(next.y + 1e-3), next.z, r, w, 1800) }
    switch (this.level) {
      case 1: return this.begin('jump', 6, { jump: true, forward: this.safe(0, 2.4) })
      case 2: return this.begin('sidestep', 12, { ...this.sideControls(), jump: true })
      case 3: penalize(0, 45); return this.begin('back-up', 14, { back: this.safe(Math.PI, 2.4) })
      case 4: penalize(1, 100); return this.begin('back-up-long', 24, { back: this.safe(Math.PI, 3.2), ...this.sideControls() })
      default:
        this.stats.failed++
        this.log('stuck: giving up')
        this.level = 0
        this.emit('stuck-fail', { pos: p.clone(), next: next ? next.clone() : null })
    }
  }

  // Would moving `dist` blocks in direction (yaw + angle) end somewhere sane? No hazard in the way, no hole or drop deeper than 2.
  // Every recovery move goes through this: "just press forward" at the edge of a lava pool is how a bot dies.
  safe(angle, dist) {
    const bot = this.bot, p = bot.entity.position, a = bot.entity.yaw + angle
    const dx = -Math.sin(a), dz = -Math.cos(a)
    const name = (x, y, z) => { const b = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))); return b ? b : null }
    for (let d = 0.8; d <= dist + 0.01; d += 0.8) {
      const x = p.x + dx * d, z = p.z + dz * d, y = Math.floor(p.y + 1e-3)
      const feet = name(x, y, z), head = name(x, y + 1, z)
      if (!feet || !head) return false
      if (HAZARDS.has(feet.name) || HAZARDS.has(head.name)) return false
      let floor = null
      for (let dy = 1; dy <= 3 && !floor; dy++) { const f = name(x, y - dy, z); if (!f) return false; if (f.boundingBox === 'block' || HAZARDS.has(f.name)) floor = { f, dy } }
      if (!floor || floor.dy > 2 || HAZARDS.has(floor.f.name)) return false
    }
    return true
  }

  sideControls() {
    // prefer the side whose cell is free and safe; alternate so we do not repeat ourselves; nothing if neither side is safe
    const p = this.bot.entity.position, yaw = this.bot.entity.yaw
    const free = (a) => { const b = this.bot.blockAt(new Vec3(Math.floor(p.x - Math.sin(a)), Math.floor(p.y + 1e-3), Math.floor(p.z - Math.cos(a)))); return b && b.boundingBox === 'empty' }
    const left = this.safe(Math.PI / 2, 2.4) && free(yaw + Math.PI / 2), right = this.safe(-Math.PI / 2, 2.4) && free(yaw - Math.PI / 2)
    if (left && right) return (this.level % 2) ? { left: true } : { right: true }
    if (left) return { left: true }
    if (right) return { right: true }
    return {}
  }

  begin(name, ticks, controls) {
    const bot = this.bot
    const goal = this.goal, dynamic = this.dynamic
    this.action = { name, left: ticks, controls, goal, dynamic }
    bot.pathfinder.setGoal(null)                       // pause the pathfinder (this also clears its control states)
    this.applyControls(controls)
  }
  applyControls(c) {
    for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) this.bot.setControlState(k, !!c[k])
  }
  runAction() {
    const a = this.action
    if (--a.left > 0) { this.applyControls(a.controls); return }
    this.bot.clearControlStates()
    this.action = null
    this.hist.length = 0
    if (a.goal && !this.goal) this.bot.pathfinder.setGoal(a.goal, a.dynamic)    // resume (re-plans from where we are now)
  }
}

module.exports = { Penalties, StuckMonitor }
