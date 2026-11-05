// DescentAssist: on a ladder you go down by doing nothing. The pathfinder holds 'forward' (and 'sprint') on every tick of a descent, which
// pushes the bot away from the rungs or against the plate and makes the descent jerky; sneaking would stop it altogether. So while the
// bot is inside a ladder/vine cell and the next path node is below it (inside the same column), every control state is released after
// the pathfinder's own tick handler ran (this listener is registered later). Control goes back to the pathfinder as soon as the next node is
// not straight below (the bottom: step off sideways, or walk on).
const { Vec3 } = require('vec3')

class DescentAssist {
  constructor({ bot, log = () => {} }) {
    this.bot = bot
    this.log = log
    this.livePath = []
    this.ticks = 0                 // ticks spent letting the ladder do the work (for status / tests)
    this.active = false
    const reg = bot.registry
    this.ids = new Set(['ladder', 'vine'].map(n => reg.blocksByName[n] && reg.blocksByName[n].id).filter(x => x !== undefined))
    this._onTick = () => this.tick()
    this._onPath = (r) => { this.livePath = (r && r.path) || [] }
    this._onReset = () => { this.livePath = [] }
  }
  attach() { const b = this.bot; b.on('physicsTick', this._onTick); b.on('path_update', this._onPath); b.on('path_reset', this._onReset); b.on('path_stop', this._onReset); return this }
  detach() { const b = this.bot; b.removeListener('physicsTick', this._onTick); b.removeListener('path_update', this._onPath); b.removeListener('path_reset', this._onReset); b.removeListener('path_stop', this._onReset) }

  inClimbCell() {
    const p = this.bot.entity.position
    const blk = this.bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y + 1e-3), Math.floor(p.z)))
    return !!(blk && this.ids.has(blk.type))
  }

  tick() {
    this.active = false
    const bot = this.bot
    if (!this.livePath.length || !bot.pathfinder || !bot.pathfinder.isMoving() || !bot.entity) return
    const node = this.livePath[0], p = bot.entity.position
    if (node.y - p.y > -0.6) return                                          // the next node is not below us
    if (Math.abs(node.x - p.x) > 0.8 || Math.abs(node.z - p.z) > 0.8) return // it is somewhere else: the pathfinder walks
    if (!this.inClimbCell()) return
    // Only once the bot is settled in the column: still steering to the middle of the cell (or carrying the run-up speed from the platform), the
    // pathfinder's forward key is what stops it; letting go there would slide it out of a one block wide shaft.
    const v = bot.entity.velocity
    if (Math.abs(node.x - p.x) > 0.3 || Math.abs(node.z - p.z) > 0.3 || Math.hypot(v.x, v.z) > 0.05) return
    bot.clearControlStates()                                                 // forward, back, left, right, jump, sprint AND sneak
    this.active = true
    this.ticks++
  }
}

module.exports = { DescentAssist }
