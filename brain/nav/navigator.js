// Navigator: the part of brain/nav that sits on top of mineflayer-pathfinder.
//
//   const nav = new Navigator({ bot, goals, safehand, say, log, stateFile })
//   nav.attach()                                         // patches the live Movements, starts door tending / stuck recovery / hazard guard
//   const r = await nav.goto(new goals.GoalNear(x, y, z, 2), { label: 'the chest', ms: 45000, isAborted })
//   // r = { label, ok, secs, err }   (same shape as join.js tryGoto(); err: 'no path' | 'timeout' | 'stuck' | 'aborted' | 'hazard' | ...)
//
// attach() also helps every OTHER pathfinder user in the process (join.js navigate/tryGoto, farm, furnace): doors are opened and
// closed, hazards avoided, stuck bots recovered, because those pieces hook the pathfinder itself rather than only nav.goto().
const EventEmitter = require('events')
const { configure } = require('./movements')
const { DoorTender } = require('./doors')
const { Penalties, StuckMonitor } = require('./stuck')
const { HazardGuard, MotionMonitor } = require('./hazards')
const { DescentAssist } = require('./climb')
const { LadderWork } = require('./ladders')
const B = require('./blocks')
const { dimOf } = require('./waypoints')
const { Reach, PROTECTED, SCAFFOLD } = require('./reach')

const TICK_MS = 50

class Navigator extends EventEmitter {
  constructor({ bot, goals, safehand = null, say = () => {}, log = () => {}, persist = () => {}, saved = null, los = null, config = {} }) {
    super()
    this.bot = bot
    this.goals = goals
    this.safehand = safehand
    this.say = say
    this.log = log
    this.persist = persist
    this.saved = saved
    this.los = los                 // { canSee(block) -> bool, ensure({ target, ctx, label }) -> Promise<bool> } from brain/los.js via the api; null = no check
    this.cfg = { maxFall: 3, quietGoals: true, silenceHere: true, netherGuard: true, netherLocalMax: 8, replans: 3, minProgress: 1.5, rescanTicks: 200, escalate: true, doors: {}, stuck: {}, reach: {}, ...config }
    this.t = 0
    this.pen = new Penalties()
    this.mvHandle = null
    this.mv = null
    this.current = null           // the goto in flight
    this.attached = false
    this.lastGoto = null
    this.digDepth = 0             // enterDigMode() nesting: the dig-capable Movements stay on until the last go-to that asked for them is done
    this._dig = null
    this.reach = new Reach({ nav: this, bot, goals, log, persist, config: this.cfg.reach, saved })
    // hand-driven ladder climbing and completion (brain/nav/ladders.js); the plain walk is what it uses to get to the foot of the ladder
    this.ladders = new LadderWork({ bot, goals, log, goto: (g) => this.gotoOnce(g, { label: 'to the ladder', ms: 20000, noLadders: true }), isAborted: () => !!(this.current && this.current.isAborted && this.current.isAborted()) })
    this._onTick = () => this.tick()
    this._onGoalUpdated = () => { if (this.current) this.rescanDoors() }
  }

  // ---------- life cycle ----------
  attach() {
    if (this.attached) return this
    const bot = this.bot
    this.applyMovements()
    this.doors = new DoorTender({
      bot, index: this.mvHandle.index, log: (m) => this.log(m), config: this.cfg.doors,
      persist: (list) => this.persist({ doors: list }),
      canSee: this.los && this.los.canSee ? (b) => this.los.canSee(b) : null,
      onFailed: (d) => this.doorFailed(d)
    })
    if (this.saved && this.saved.doors) this.doors.restore(this.saved.doors)
    this.doors.attach()
    this.stuck = new StuckMonitor({ bot, penalties: this.pen, log: (m) => this.log(m), config: this.cfg.stuck })
    this.stuck.attach()
    this.guard = new HazardGuard({ bot, penalties: this.pen, log: (m) => this.log(m), onHazard: (h) => { this.emit('hazard', h); if (this.current) this.finish(this.current, { ok: false, err: 'hazard' }) } })
    this.guard.attach()
    this.motion = new MotionMonitor({ bot, log: (m) => this.log(m) })
    this.motion.attach()
    this.descent = new DescentAssist({ bot, log: (m) => this.log(m) })
    this.descent.attach()
    bot.on('physicsTick', this._onTick)
    bot.on('goal_updated', this._onGoalUpdated)
    // join.js says "Here." on EVERY 'goal_reached', whoever set the goal (a furnace trip, a farm leg, a goal queued behind a routine...),
    // so a go-to that is still waiting could announce an arrival that never happened. With nav attached, arrivals are announced only by
    // nav's own navigate() after it has checked the bot's real position. So: (1) goals set by nav.goto() deliver 'goal_reached' to nav
    // only (quietGoals); (2) for every other goal the listener that just says "Here." is skipped (silenceHere), all other listeners still run.
    // Both are undone in detach(). (Not needed once join.js drops its own "Here." listener.)
    if (this.cfg.quietGoals || this.cfg.silenceHere) {
      const self = this, orig = bot.emit
      const isHereAnnouncer = (l) => { const fn = l.listener || l; try { return /say\(\s*['"]Here\.['"]\s*\)/.test(Function.prototype.toString.call(fn)) } catch { return false } }
      this._patchedEmit = function (ev, ...args) {
        if (ev !== 'goal_reached') return orig.call(this, ev, ...args)
        const c = self.current
        if (self.cfg.quietGoals && c && args[0] === c.goal && !c.done) { c.onReached(args[0]); return true }
        if (!self.cfg.silenceHere) return orig.call(this, ev, ...args)
        const ls = this.rawListeners('goal_reached')
        for (const l of ls) { if (isHereAnnouncer(l)) { self.silenced = (self.silenced || 0) + 1; continue } try { l.apply(this, args) } catch (e) { self.log('goal_reached listener failed: ' + e.message) } }
        return ls.length > 0
      }
      this._origEmit = orig
      bot.emit = this._patchedEmit
    }
    this.attached = true
    this.log('nav attached')
    return this
  }

  detach() {
    if (!this.attached) return
    const bot = this.bot
    this.reach.cancel('nav stopped')
    this.digDepth = 0; this.leaveDigMode(true)
    this.reach.detach()
    if (this.current) this.finish(this.current, { ok: false, err: 'nav stopped' })
    bot.removeListener('physicsTick', this._onTick)
    bot.removeListener('goal_updated', this._onGoalUpdated)
    if (this._patchedEmit && bot.emit === this._patchedEmit) bot.emit = this._origEmit
    this._patchedEmit = null
    for (const c of [this.doors, this.stuck, this.guard, this.motion, this.descent]) { try { c && c.detach() } catch { /* ignore */ } }
    if (this.mvHandle) this.mvHandle.restore()
    this.mvHandle = null
    this.attached = false
  }

  applyMovements() {
    const bot = this.bot
    if (this.mvHandle) this.mvHandle.restore()
    this.mv = bot.pathfinder.movements
    this.mvHandle = configure(bot, this.mv, { maxFall: this.cfg.maxFall })
    this.mv.exclusionAreasStep.push(this.pen.weight)
    this.mvHandle.index.rescan()
    if (this.doors) this.doors.index = this.mvHandle.index
  }

  rescanDoors() { const t = Date.now(); if (t - (this._lastRescan || 0) < 15000) return 0; this._lastRescan = t; try { return this.mvHandle.index.rescan() } catch { return 0 } }

  doorFailed(d) {
    // a door that will not open is a wall: keep the planner away from it for a while and plan again
    this.pen.addArea(d.pos.x, d.pos.y, d.pos.z, 0, 150, 6000)
    this.log(`door ${d.name} at ${d.pos.x},${d.pos.y},${d.pos.z} will not open; planning around it`)
    const g = this.bot.pathfinder.goal
    if (g && !this.stuck.maneuvering) this.bot.pathfinder.setGoal(g, this.current ? this.current.dynamic : false)
    this.emit('door-failed', d)
  }

  // ---------- dig mode (go-to escalation) ----------
  // The one deliberate exception to "nav never digs or places": while reach.js escalates a go-to that the normal planner could not solve, the
  // pathfinder gets a Movements object with digging, bridging and 1x1 towers on (same hazard / door / fall rules as the normal one), and the
  // normal one comes back afterwards. Chests, furnaces, beds, ladders and the walls things hang on stay unbreakable.
  enterDigMode() {
    if (this.digDepth++ > 0) return
    const bot = this.bot, reg = bot.registry
    const { Movements } = require('mineflayer-pathfinder')
    if (!this._dig) {
      const mv = new Movements(bot)
      const handle = configure(bot, mv, { maxFall: this.cfg.maxFall, allowParkour: true })
      mv.canDig = true
      mv.allow1by1towers = true
      mv.allowParkour = true
      mv.digCost = 3
      mv.placeCost = 3
      mv.scafoldingBlocks = SCAFFOLD.map(n => reg.itemsByName[n] && reg.itemsByName[n].id).filter(id => id !== undefined)
      for (const b of reg.blocksArray) if (PROTECTED.test(b.name)) mv.blocksCantBreak.add(b.id)
      mv.exclusionAreasStep.push(this.pen.weight)
      mv.exclusionAreasBreak.push((b) => this.reach.breakWeight(b))
      this._dig = { mv, handle }
    }
    this._dig.handle.index.rescan()
    this._dig.prev = { mv: this.mv, handle: this.mvHandle }
    this.mv = this._dig.mv
    this.mvHandle = this._dig.handle
    if (this.doors) this.doors.index = this.mvHandle.index
    bot.pathfinder.setMovements(this.mv)
  }
  leaveDigMode(force = false) {
    if (!force && (this.digDepth === 0 || --this.digDepth > 0)) return
    if (!this._dig || !this._dig.prev) return
    const prev = this._dig.prev
    this._dig.prev = null
    this.mv = prev.mv
    this.mvHandle = prev.handle
    if (this.doors && this.mvHandle) this.doors.index = this.mvHandle.index
    try { this.bot.pathfinder.setMovements(this.mv) } catch { /* bot gone */ }
    if (force) { try { this._dig.handle.restore() } catch { /* ignore */ } this._dig = null }
  }

  // ---------- per tick ----------
  tick() {
    this.t++
    // someone replaced the Movements object (e.g. a restart of join.js's setupMovement): configure the new one too
    if (this.t % 40 === 0 && this.bot.pathfinder.movements !== this.mv) { this.log('movements replaced; re-applying nav config'); this.applyMovements() }
    const c = this.current
    if (!c) return
    if (this.t % this.cfg.rescanTicks === 0) this.rescanDoors()
    if (c.isAborted && c.isAborted()) return this.finish(c, { ok: false, err: 'aborted' })
    if (this.t - c.startTick > c.maxTicks) return this.finish(c, { ok: false, err: 'timeout' })
    if (this.guard.escaping) return                                            // climbing out of lava has priority over everything
    // The pathfinder followed a partial path to its end and now idles because the goal was not in reach: plan again from here.
    if (c.awaitingReplan && !this.bot.pathfinder.isMoving() && !this.stuck.maneuvering) {
      const h = c.goal.heuristic ? c.goal.heuristic(this.bot.entity.position.floored()) : 0
      if (c.replansLeft <= 0 || (c.lastH - h) < this.cfg.minProgress) return this.finish(c, { ok: false, err: 'no path' })
      c.replansLeft--; c.lastH = h; c.awaitingReplan = false
      this.setGoal(c)
    }
  }

  setGoal(c) { c.settingGoal = true; try { this.bot.pathfinder.setGoal(c.goal, c.dynamic) } finally { c.settingGoal = false } }

  // ---------- goto ----------
  // opts: { label, ms (default 45000), isAborted(): bool, dynamic, escalate (false = one plain attempt only), maxMs (budget for the escalation) }
  // The public go-to never answers "I can't get there": when the plain attempt fails it escalates (brain/nav/reach.js): digging planner,
  // hand-driven tunnel / bridge / pillar, sidesteps, and it puts back what it broke. It ends only on arrival, an abort, or after maxMs.
  async goto(goal, opts = {}) {
    if (opts.escalate === false || opts.dynamic || this.cfg.escalate === false) return this.gotoOnce(goal, opts)
    if (!this.attached) this.attach()
    return this.reach.goto(goal, opts)
  }

  // One plain pathfinder attempt with all of nav's helpers (no digging, no placing), then - only when it ended in a ladder loop, or in "no path" for
  // a goal up a ladder that does not reach - the ladder is climbed or finished by hand (ladders.js: it places ladders, nothing else unless a backing
  // block is needed). opts.noLadders switches that off (ladders.js itself walks with it).
  async gotoOnce(goal, opts = {}) {
    const res = await this._gotoPlain(goal, opts)
    if (res.ok || opts.noLadders || this.cfg.ladders === false || opts.dynamic) return res
    if (res.err !== 'ladder-loop' && res.err !== 'no path') return res
    const p = this.bot.entity.position
    if (![goal.x, goal.y, goal.z].every(Number.isFinite) || (res.err === 'no path' && goal.y < p.y + 1.5)) return res   // a plain "no path" to somewhere below or level: not a ladder matter
    const col = this.ladderGoal(goal)
    if (!col) return res
    this.log(`ladders: ${res.err} on the way to ${Math.floor(goal.x)},${Math.floor(goal.y)},${Math.floor(goal.z)}; working the ladder at ${col.x},${col.z} (y${col.lowest}..${col.highest}) by hand`)
    const r = await this.ladders.completeUp(col, Math.floor(goal.y), { x: Math.floor(goal.x), y: Math.floor(goal.y), z: Math.floor(goal.z) })
    if (r.ok) return { label: res.label, ok: true, secs: res.secs, via: 'ladder-work' }
    return { ...res, ladderWhy: r.why }
  }

  // the ladder column that a goal above the bot hangs on (within 3 blocks of the goal, lowest rung below it), or null
  ladderGoal(goal) {
    if (![goal.x, goal.y, goal.z].every(Number.isFinite) || goal.y < this.bot.entity.position.y + 1.5) return null
    try { return this.ladders.findColumn({ x: Math.floor(goal.x), y: Math.floor(goal.y), z: Math.floor(goal.z) }) } catch { return null }
  }

  async _gotoPlain(goal, opts = {}) {
    if (!this.attached) this.attach()
    const label = opts.label || 'there'
    if (this.current) this.finish(this.current, { ok: false, err: 'replaced' })
    if (this.safehand && this.safehand.ensureSafeForMove) {
      try { await this.safehand.ensureSafeForMove() } catch (e) { return { label, ok: false, secs: 0, err: 'lava bucket in hand' } }
    }
    const bad = this.goalHazard(goal)
    if (bad) return { label, ok: false, secs: 0, err: `goal is in ${bad}` }
    // Walter's rule: in the Nether the bot walks only logged routes (nether.js / nether-walk.js), never a pathfinder search to somewhere far.
    // Short local moves (stepping out of a portal, ~8 blocks) are fine; an approved exploration passes { netherOk: true }.
    const gp = typeof goal.x === 'number' && typeof goal.z === 'number' ? goal : goal.entity && goal.entity.position ? goal.entity.position : null
    if (this.cfg.netherGuard && !opts.netherOk && dimOf(this.bot) === -1 && gp) {
      const p = this.bot.entity.position
      if (Math.hypot(gp.x - p.x, gp.z - p.z) > this.cfg.netherLocalMax) return { label, ok: false, secs: 0, err: 'the Nether is walked only along logged routes' }
    }
    // standing in lava/fire right now: let the hazard guard get us out first (planning from inside lava finds no path)
    for (let i = 0; i < 100 && (this.guard.escaping || this.guard.inDanger()); i++) await new Promise(res => this.bot.once('physicsTick', res))
    return new Promise((resolve) => {
      const bot = this.bot
      const c = this.current = {
        goal, label, resolve, dynamic: !!opts.dynamic, isAborted: opts.isAborted, startTick: this.t, maxTicks: Math.ceil((opts.ms || 45000) / TICK_MS),
        replansLeft: this.cfg.replans, awaitingReplan: false, lastH: goal.heuristic ? goal.heuristic(bot.entity.position.floored()) : 0, settingGoal: false
      }
      // "reached" is believed only when the bot's real position satisfies the goal (live bug: "Arrived" 77 blocks short of the waypoint)
      c.falseArrivals = 0
      c.onReached = (g) => {
        if (g !== goal || c.done) return
        if (this.satisfied(goal, c.dynamic)) return this.finish(c, { ok: true })
        const p = this.bot.entity.position
        this.falseArrivals = (this.falseArrivals || 0) + 1
        this.log(`ignored a goal_reached for "${label}" at ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}: the position does not satisfy the goal`)
        if (++c.falseArrivals > 3) return this.finish(c, { ok: false, err: 'arrival check failed' })
        this.setGoal(c)                                    // the pathfinder dropped the goal when it announced it; set it again and carry on
      }
      c.onPath = (r) => {
        if (r.status === 'noPath' || r.status === 'timeout') {
          if (!r.path.length) return this.finish(c, { ok: false, err: r.status === 'timeout' ? 'path search timed out' : 'no path' })
          // a goal up a ladder that does not reach it: do not ride the partial path up to the end of the rungs (and into whatever is there), hand over now
          if (this.cfg.ladders !== false && !opts.noLadders && !c.dynamic && this.ladderGoal(goal)) return this.finish(c, { ok: false, err: 'no path' })
          c.awaitingReplan = true                                              // follow the part we do have, then try again from there
        } else if (r.status === 'success') c.awaitingReplan = false
      }
      c.onGoal = (g) => { if (c.settingGoal || this.stuck.maneuvering || g === goal) return; if (g === null && this.guard.escaping) return; this.finish(c, { ok: false, err: 'goal changed' }) }
      c.onStuck = () => this.finish(c, { ok: false, err: 'stuck' })
      c.onLoop = () => this.finish(c, { ok: false, err: 'ladder-loop' })
      this.stuck.on('ladder-loop', c.onLoop)
      bot.on('goal_reached', c.onReached)
      bot.on('path_update', c.onPath)
      bot.on('goal_updated', c.onGoal)
      this.stuck.on('stuck-fail', c.onStuck)
      this.stuck.dynamic = c.dynamic
      this.stuck.reset()
      goal.navQuiet = true
      this.setGoal(c)
    })
  }

  // Does the bot's real position satisfy `goal` (same test the pathfinder uses, tolerant of standing on a half block and of a goal in the cell just above the top rung
  // of a ladder, which a body cannot occupy: test/nav.ladder.test.js)? THE definition of "arrived": S.goto (autopilot/skills.js) asks this too. It used to demand the
  // exact feet cell, so a goal one block above or below the bot came back as an instant "nopath" from a navigator that had just said ok (BUG-HUNT finding 10).
  satisfied(goal, dynamic = false) {
    if (dynamic || !goal || typeof goal.isEnd !== 'function') return true
    const p = this.bot.entity.position.floored()
    try { return !!(goal.isEnd(p) || goal.isEnd(p.offset(0, 1, 0)) || goal.isEnd(p.offset(0, -1, 0))) } catch { return true }
  }

  finish(c, res) {
    if (!c || c.done) return
    c.done = true
    const bot = this.bot
    bot.removeListener('goal_reached', c.onReached)
    bot.removeListener('path_update', c.onPath)
    bot.removeListener('goal_updated', c.onGoal)
    this.stuck.removeListener('stuck-fail', c.onStuck)
    if (c.onLoop) this.stuck.removeListener('ladder-loop', c.onLoop)
    if (this.current === c) this.current = null
    if (!res.ok || bot.pathfinder.goal === c.goal) { if (!this.guard.escaping && !this.stuck.maneuvering) bot.pathfinder.setGoal(null) }
    const out = { label: c.label, ok: !!res.ok, secs: +(((this.t - c.startTick) * TICK_MS) / 1000).toFixed(1) }
    if (!res.ok) out.err = res.err
    this.lastGoto = { ...out, at: Date.now() }
    // resolve on the next macrotask like pathfinder's own goto(), so the pathfinder has settled before the caller sets a new goal
    setImmediate(() => c.resolve(out))
  }

  stop(reason = 'stopped') {
    this.reach.cancel(reason)
    if (this.current) this.finish(this.current, { ok: false, err: reason })
    else if (this.bot.pathfinder) this.bot.pathfinder.setGoal(null)
  }

  // A goal that sits inside lava/fire/etc. is refused up front.
  goalHazard(goal) {
    if (goal && typeof goal.x === 'number' && typeof goal.y === 'number' && typeof goal.z === 'number') {
      const { Vec3 } = require('vec3')
      for (const dy of [0, 1]) {
        const b = this.bot.blockAt(new Vec3(Math.floor(goal.x), Math.floor(goal.y) + dy, Math.floor(goal.z)))
        if (b && (b.name === 'lava' || b.name === 'fire' || b.name === 'soul_fire' || b.name === 'magma_block' || b.name === 'cactus')) return b.name
      }
    }
    return null
  }

  // ---------- reaching a block to use it (chest, furnace, cauldron, lever...) ----------
  // Why not GoalNear(block, 3)? When the block sits 4-5 blocks above the floor (Walter's furnace chests on the wall of a tall hall) there is
  // NO standable cell inside that sphere, so the pathfinder can never finish: it searches everything it can reach and dies with
  // "Took to long to decide path to goal!". Instead: list the cells where the bot CAN stand and use the block (eye within arm's reach,
  // clear line of sight), and path to the nearest of those. An unreachable block now fails at once with a reason.
  eyeTo(pos, from) {                       // eye (at `from` = feet position) to the nearest point of the block's cube
    const ex = from.x, ey = from.y + 1.62, ez = from.z
    const cl = (v, lo) => Math.max(lo, Math.min(lo + 1, v))
    return Math.hypot(ex - cl(ex, pos.x), ey - cl(ey, pos.y), ez - cl(ez, pos.z))
  }
  visibleFrom(eye, pos) {
    const world = this.bot.world
    if (!world || !world.raycast) return true
    const { Vec3 } = require('vec3')
    const c = new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5)
    const pts = [c]
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) pts.push(c.offset(dx * 0.45, dy * 0.45, dz * 0.45))
    for (const p of pts) {
      const d = p.minus(eye), n = d.norm()
      if (n < 1e-6) return true
      const hit = world.raycast(eye, d.scaled(1 / n), n)
      if (!hit || (hit.position && hit.position.x === pos.x && hit.position.y === pos.y && hit.position.z === pos.z)) return true
    }
    return false
  }
  // Cells the pathfinder can use as a node (solid floor, two free cells above, no hazard) within arm's reach of `pos`, each with a clear view.
  standCells(pos, { reach = 4.2, max = 24 } = {}) {
    const { Vec3 } = require('vec3')
    const bot = this.bot, me = bot.entity.position
    const bad = /lava|fire|cactus|magma|campfire|powder_snow|berry|cobweb|portal|sculk|pointed_dripstone|tripwire|water/
    const out = []
    for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) for (let dy = -6; dy <= 3; dy++) {
      const x = pos.x + dx, y = pos.y + dy, z = pos.z + dz
      if (x === pos.x && z === pos.z && y >= pos.y - 1 && y <= pos.y) continue           // inside the block itself / its footprint
      const feet = bot.blockAt(new Vec3(x, y, z)), head = bot.blockAt(new Vec3(x, y + 1, z)), floor = bot.blockAt(new Vec3(x, y - 1, z))
      if (!feet || !head || !floor) continue
      if (feet.boundingBox !== 'empty' || head.boundingBox !== 'empty' || floor.boundingBox !== 'block') continue
      if (bad.test(feet.name) || bad.test(head.name) || bad.test(floor.name)) continue
      const top = floor.shapes.length ? y - 1 + Math.max(...floor.shapes.map(sh => sh[4])) : y
      if (top > y + 0.01 || top < y - 0.6) continue                                      // fence-high or not really a floor
      const feetPos = new Vec3(x + 0.5, top, z + 0.5)
      if (this.eyeTo(pos, feetPos) > reach) continue
      if (!this.visibleFrom(feetPos.offset(0, 1.62, 0), pos)) continue
      out.push({ x, y, z, top, d: feetPos.distanceTo(me) })
    }
    return out.sort((a, b) => a.d - b.d).slice(0, max)
  }
  // Walk to a place from which the block at `pos` can be used. Returns { label, ok, secs, err, stand }.
  async approachBlock(pos, { label = 'the block', reach = 4.2, ms = 60000, isAborted = null } = {}) {
    if (!this.attached) this.attach()
    const { Vec3 } = require('vec3')
    pos = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))
    const me = this.bot.entity.position
    if (this.eyeTo(pos, me) <= reach + 0.2 && this.visibleFrom(me.offset(0, 1.62, 0), pos)) return { label, ok: true, secs: 0, stand: { x: me.x, y: me.y, z: me.z }, via: 'already' }
    const cells = this.standCells(pos, { reach })
    if (!cells.length) return { label, ok: false, secs: 0, err: 'no spot within reach with a clear view of it' }
    const g = new this.goals.GoalCompositeAny(cells.map(c => new this.goals.GoalBlock(c.x, c.y, c.z)))
    const r = await this.goto(g, { label, ms, isAborted })
    const p = this.bot.entity.position
    const near = this.eyeTo(pos, p) <= reach + 0.3 && this.visibleFrom(p.offset(0, 1.62, 0), pos)
    if (r.ok && !near) return { ...r, ok: false, err: 'arrived but cannot use the block from here' }
    return { ...r, ok: r.ok || near, stand: { x: p.x, y: p.y, z: p.z }, via: 'moved' }
  }
  // Same signature as brain/util.js gotoNear({ pos, ctx, label, ms }): true when the block can be used from where the bot ends up.
  async gotoNear({ pos, ctx = null, label = 'there', ms = 60000 }) {
    if (ctx) ctx.checkpoint()
    const r = await this.approachBlock(pos, { label, ms, isAborted: ctx ? () => ctx.aborted : null })
    if (ctx) ctx.checkpoint()
    this.lastApproach = r
    return !!r.ok
  }

  // Walk back to doors we left open (missed the closing window) and close them. Returns how many were left open.
  async tidy({ radius = 12, isAborted = () => false } = {}) {
    let left = 0
    for (const e of this.doors.pendingNear(radius)) {
      if (isAborted()) break
      const g = new this.goals.GoalNear(e.pos.x, e.pos.y, e.pos.z, 3)
      const r = await this.goto(g, { label: 'to close a door', ms: 15000, isAborted, escalate: false })
      if (!r.ok) { left++; continue }
      const blk = this.bot.blockAt(e.pos)
      if (this.los && this.los.ensure && blk && !(await this.los.ensure({ target: blk, label: 'a spot where I can see the door' }))) { left++; continue }
      for (let i = 0; i < 100 && this.doors.opened.has(e.key); i++) await new Promise(res => this.bot.once('physicsTick', res))
    }
    return left
  }

  status() {
    return {
      attached: this.attached,
      goto: this.current ? { label: this.current.label, ticks: this.t - this.current.startTick } : null,
      last: this.lastGoto,
      doors: this.doors ? this.doors.status() : null,
      stuck: this.stuck ? { ...this.stuck.stats, level: this.stuck.level } : null,
      hazards: this.guard ? this.guard.stats : null,
      motion: this.motion ? this.motion.status() : null,
      ladderDescentTicks: this.descent ? this.descent.ticks : 0,
      penalties: this.pen.size,
      reach: this.reach.status()
    }
  }
}

module.exports = { Navigator, TICK_MS }
