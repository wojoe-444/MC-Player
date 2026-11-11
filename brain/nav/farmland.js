// FarmlandGuard: no hop over farmland. In vanilla a landing with a fall of more than half a block turns farmland back into dirt (the chance is `fall - 0.5`, so
// a plain jump that lands on the same level, a fall distance of about 1.25, does it three times in four). The planner side of this is the landing cost in
// movements.js; this is the other half, because a lot of code sets the jump key without any path: the stuck recovery's hop, the "hop to free myself" moves in
// mining and the ladder code, join.js's idle hop. Walter 2026-11-11: "a bot lands on farmland and turns it back into regular dirt".
//
// It wraps bot.setControlState and, while a jump is requested on level ground over (or about to land on) farmland, drops the request. A jump that has a reason is
// never held: a block in the way (a step up, the rim of the plot), a ladder or vine, water, or the pillar look (looking down at the feet). Held ones are counted
// (stats.held) and logged once in a while, so a module that keeps asking is visible. It owns no timers; the tick listener only covers a jump key held down
// from before the bot reached the farmland.
const { Vec3 } = require('vec3')

const CLIMB = /^(ladder|vine|scaffolding|weeping_vines|twisting_vines|cave_vines|cave_vines_plant)$/
const REACH = 2                  // cells ahead of the bot a walking hop can land in

class FarmlandGuard {
  constructor({ bot, log = () => {}, now = () => Date.now() }) {
    this.bot = bot
    this.log = log
    this.now = now
    this.stats = { held: 0, last: null }
    this._orig = null
    this._mine = null
    this._lastLog = -1e9
    this._onTick = () => this.tick()
  }

  attach() {
    const bot = this.bot
    if (this._mine || typeof bot.setControlState !== 'function') return this
    const orig = bot.setControlState, self = this
    const mine = function (control, state, ...rest) {
      if (control === 'jump' && state) { let hold = false; try { hold = self.holdsJump() } catch { /* never in the way of a control */ } if (hold) return orig.call(this, 'jump', false, ...rest) }
      return orig.call(this, control, state, ...rest)
    }
    mine.__orig = orig
    this._orig = orig; this._mine = mine
    bot.setControlState = mine
    bot.on('physicsTick', this._onTick)
    return this
  }

  detach() {
    const bot = this.bot
    bot.removeListener('physicsTick', this._onTick)
    if (this._mine && bot.setControlState === this._mine) bot.setControlState = this._orig
    this._mine = null; this._orig = null
  }

  tick() {
    const bot = this.bot
    if (!this._orig || !bot.controlState || !bot.controlState.jump) return
    let hold = false
    try { hold = this.holdsJump() } catch { /* ignore */ }
    if (hold) this._orig.call(bot, 'jump', false)
  }

  nameAt(x, y, z) { const b = this.bot.blockAt(new Vec3(x, y, z)); return b ? b.name : null }
  solidAt(x, y, z) { const b = this.bot.blockAt(new Vec3(x, y, z)); return !!b && b.boundingBox === 'block' }

  // True when a jump requested now would be a hop with nothing to jump for, that lands on farmland.
  holdsJump() {
    const bot = this.bot, e = bot.entity
    if (!e || !e.position || !e.onGround || e.isInWater || e.isInLava || e.isInWeb) return false
    if (typeof e.pitch === 'number' && e.pitch >= 0.9) return false                       // looking down at the feet: pillaring, the jump is the job
    const p = e.position
    const fx = Math.floor(p.x), fz = Math.floor(p.z), fy = Math.ceil(p.y - 1e-3), floorY = fy - 1       // fy: the cell the body starts in (farmland is 15/16 high, so a bot standing on it has its feet in the cell of the block it stands on)
    if (CLIMB.test(this.nameAt(fx, fy, fz) || '')) return false
    const cs = bot.controlState || {}
    const yaw = typeof e.yaw === 'number' ? e.yaw : 0
    const dx = -Math.sin(yaw), dz = -Math.cos(yaw)
    const ax = Math.abs(dx) > 0.38 ? Math.sign(dx) : 0, az = Math.abs(dz) > 0.38 ? Math.sign(dz) : 0
    const heading = [[ax, 0], [0, az], [ax, az]].filter(([a, b]) => a || b)          // the cells the bot is walking into (one, or three on a diagonal)
    const forwardOnly = !!cs.forward && !cs.back && !cs.left && !cs.right
    const moving = forwardOnly || !!(cs.back || cs.left || cs.right)
    // something to jump for: a block (or a ladder) in the way at foot level, in the heading, or around the bot when it is strafing or standing still
    const around = forwardOnly ? heading : [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
    for (const [qx, qz] of around) {
      if (this.solidAt(fx + qx, fy, fz + qz) || CLIMB.test(this.nameAt(fx + qx, fy, fz + qz) || '')) return false
    }
    // where the hop would come down: here, and (walking) up to REACH cells on
    const cells = [[0, 0]]
    if (forwardOnly) for (let i = 1; i <= REACH; i++) cells.push([ax * i, az * i])
    else if (moving) for (const [qx, qz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) cells.push([qx, qz])
    for (const [qx, qz] of cells) for (const y of [floorY, floorY - 1]) {
      if (this.nameAt(fx + qx, y, fz + qz) === 'farmland') {
        this.stats.held++; this.stats.last = { x: fx, y: fy, z: fz }
        const t = this.now()
        if (t - this._lastLog > 30000) { this._lastLog = t; this.log(`not hopping at ${fx},${fy},${fz}: it would land on farmland (held ${this.stats.held} so far)`) }
        return true
      }
    }
    return false
  }

  status() { return { ...this.stats } }
}

module.exports = { FarmlandGuard }
