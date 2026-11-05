// Runtime hazard handling that complements the planner's avoidance (see movements.js):
//   HazardGuard   - if the bot ends up in lava/fire anyway (pushed, block changed under it), climb out the shortest safe way
//   MotionMonitor - watches per-tick displacement, so "no teleport-like jumps" is something we can assert and report
// Both are driven by `physicsTick` and own no timers.
const { Vec3 } = require('vec3')
const B = require('./blocks')

const BURNING = new Set(['lava', 'fire', 'soul_fire', 'magma_block', 'campfire', 'soul_campfire', 'cactus'])

class HazardGuard {
  constructor({ bot, penalties, log = () => {}, onHazard = () => {} }) {
    this.bot = bot
    this.pen = penalties
    this.log = log
    this.onHazard = onHazard
    this.escape = null            // { left, dir:{x,z} }
    this.t = 0
    this.lastReport = -1e9
    this.stats = { escapes: 0 }
    this._onTick = () => this.tick()
  }
  attach() { this.bot.on('physicsTick', this._onTick); return this }
  detach() { this.bot.removeListener('physicsTick', this._onTick); this.escape = null }

  nameAt(x, y, z) { const b = this.bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))); return b ? b.name : null }
  inDanger() {
    const p = this.bot.entity.position
    if (this.bot.entity.isInLava) return 'lava'
    for (const dy of [0, 1]) { const n = this.nameAt(p.x, p.y + dy, p.z); if (n === 'lava' || n === 'fire' || n === 'soul_fire') return n }
    const under = this.nameAt(p.x, p.y - 0.2, p.z)
    if (under === 'magma_block' || under === 'campfire' || under === 'soul_campfire') return under
    return null
  }

  // best direction to leave: nearest horizontal neighbour cell that is not hazardous and has something to stand on
  pickExit() {
    const p = this.bot.entity.position
    const fx = Math.floor(p.x), fy = Math.floor(p.y + 1e-3), fz = Math.floor(p.z)
    let best = null
    for (let r = 1; r <= 3 && !best; r++) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        for (const dy of [0, 1, -1]) {
          const x = fx + dx * r, y = fy + dy, z = fz + dz * r
          const feet = this.nameAt(x, y, z), head = this.nameAt(x, y + 1, z), floor = this.nameAt(x, y - 1, z)
          const bf = this.bot.blockAt(new Vec3(x, y, z)), bh = this.bot.blockAt(new Vec3(x, y + 1, z)), bg = this.bot.blockAt(new Vec3(x, y - 1, z))
          if (!bf || !bh || !bg) continue
          if (BURNING.has(feet) || BURNING.has(head) || BURNING.has(floor)) continue
          if (bf.boundingBox !== 'empty' || bh.boundingBox !== 'empty' || bg.boundingBox !== 'block') continue
          const d = Math.hypot(x + 0.5 - p.x, z + 0.5 - p.z) + Math.abs(dy) * 0.5
          if (!best || d < best.d) best = { d, x: x + 0.5, y, z: z + 0.5 }
        }
      }
    }
    return best
  }

  tick() {
    this.t++
    const bot = this.bot
    if (!bot.entity || !bot.entity.position) return
    if (this.escape) return this.runEscape()
    const danger = this.inDanger()
    if (!danger) return
    const exit = this.pickExit()
    this.stats.escapes++
    const p = bot.entity.position
    this.log(`in ${danger} at ${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}; ${exit ? 'leaving towards ' + Math.floor(exit.x) + ',' + exit.y + ',' + Math.floor(exit.z) : 'no safe neighbour found'}`)
    const report = this.t - this.lastReport > 200
    if (report) this.lastReport = this.t
    this.onHazard({ kind: danger, pos: p.clone(), exit, report })
    if (bot.pathfinder) bot.pathfinder.setGoal(null)
    this.escape = { left: 60, exit }
  }

  runEscape() {
    const bot = this.bot, e = this.escape
    const p = bot.entity.position
    if (--e.left <= 0 || (!this.inDanger() && bot.entity.onGround && e.left < 50)) {
      bot.clearControlStates(); this.escape = null; return
    }
    if (e.exit) {
      const dx = e.exit.x - p.x, dz = e.exit.z - p.z
      bot.look(Math.atan2(-dx, -dz), 0)
      bot.setControlState('forward', true)
      bot.setControlState('sprint', false)
    }
    bot.setControlState('jump', true)                    // swim up / hop out
  }
  get escaping() { return !!this.escape }
}

class MotionMonitor {
  constructor({ bot, log = () => {}, config = {} }) {
    this.bot = bot
    this.log = log
    this.cfg = { jumpBlocks: 3.0, graceTicks: 60, ...config }
    this.prev = null
    this.grace = 40
    this.maxStep = 0
    this.anomalies = []
    this._onTick = () => this.tick()
    this._grace = () => { this.grace = this.cfg.graceTicks; this.prev = null }
  }
  attach() {
    this.bot.on('physicsTick', this._onTick)
    for (const ev of ['forcedMove', 'respawn', 'spawn']) this.bot.on(ev, this._grace)
    return this
  }
  detach() {
    this.bot.removeListener('physicsTick', this._onTick)
    for (const ev of ['forcedMove', 'respawn', 'spawn']) this.bot.removeListener(ev, this._grace)
  }
  tick() {
    const p = this.bot.entity && this.bot.entity.position
    if (!p) return
    if (this.grace > 0) this.grace--
    if (this.prev && this.grace === 0) {
      const d = p.distanceTo(this.prev)
      if (d > this.maxStep) this.maxStep = d
      if (d > this.cfg.jumpBlocks) {
        this.anomalies.push({ from: this.prev.clone(), to: p.clone(), d })
        if (this.anomalies.length > 10) this.anomalies.shift()
        this.log(`sudden jump of ${d.toFixed(1)} blocks (nav itself never writes the position)`)
      }
    }
    this.prev = p.clone()
  }
  status() { return { maxStepPerTick: +this.maxStep.toFixed(2), anomalies: this.anomalies.length } }
}

module.exports = { HazardGuard, MotionMonitor, BURNING }
