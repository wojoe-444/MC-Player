// DoorTender: opens doors, fence gates and trapdoors that the planned path goes through, and closes the ones it opened once the
// bot has gone through (or decided not to). Driven by `physicsTick` (1 tick = 50 ms of game time), so it needs no timers.
//
// Differences from the old join.js tendDoors():
//   - only doors on the bot's own path are opened (not every door it walks past), plus a fallback for "bumped into a closed door"
//   - it closes a door only when the bot's body is clear of the door cell, never while it stands in the doorway
//   - doors that will not open (server refuses, iron door, locked by plugin) are reported so the navigator can plan around them
//   - clicks do not turn the bot around while it is walking (activateBlock() normally does a lookAt first, which would fight the pathfinder)
//   - open trapdoors/hatches over ladders are handled the same way (opened on the way up/down, closed after)
const { Vec3 } = require('vec3')
const B = require('./blocks')

const KEY = (x, y, z) => `${x},${y},${z}`

class DoorTender {
  constructor({ bot, index, log = () => {}, onFailed = () => {}, persist = () => {}, canSee = null, config = {} }) {
    this.bot = bot
    this.index = index
    this.log = log
    this.onFailed = onFailed
    this.persist = persist
    this.canSeeFn = canSee             // Walter's line-of-sight rule (api.canSee): no click without a clear ray from the eye to the block
    this.losSkips = 0
    this.losWarned = false
    this.cfg = { openRadius: 2.8, closeMin: 1.15, closeMax: 4.0, reach: 4.0, retryTicks: 5, maxTries: 3, lookAhead: 14, ...config }
    this.t = 0
    this.opened = new Map()          // key -> { key, pos, name, axis, kind:'door'|'gate'|'trapdoor', tick, side, tries, passed }
    this.failed = new Map()          // key -> tick it was given up on (door that would not toggle)
    this.livePath = []               // the pathfinder's own remaining-path array (it shifts nodes off as they are reached)
    this.busy = false
    this.stats = { opened: 0, closed: 0, failed: 0, bumped: 0 }
    this._onTick = () => this.tick()
    this._onPath = (r) => { this.livePath = (r && r.path) || []; try { this.fixPath(this.livePath) } catch (e) { this.log('fixPath error: ' + e.message) } }
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
  }

  // Doors left open by an earlier run (state file): closed when the bot next passes within reach.
  restore(list) {
    for (const e of list || []) {
      try { this.opened.set(e.key, { ...e, pos: new Vec3(e.pos.x, e.pos.y, e.pos.z), tick: this.t, side: 0, tries: 0, passed: true, restored: true }) } catch { /* ignore */ }
    }
  }
  snapshot() { return [...this.opened.values()].map(e => ({ key: e.key, pos: { x: e.pos.x, y: e.pos.y, z: e.pos.z }, name: e.name, axis: e.axis, kind: e.kind })) }

  // The library puts a path node for a door/gate cell "on top of" the block (door top +1, gate top +1.5), which the bot can never
  // reach while it walks through the doorway (needs |dy| < 1). Pull those nodes back down to the doorway floor, in place: the
  // pathfinder keeps the very same array/objects, and this runs before it starts following the path.
  fixPath(path) {
    let fixed = this.fixLadders(path)
    if (!this.index.cells.size) return fixed
    for (const node of path) {
      if (node.toBreak && node.toBreak.length || node.toPlace && node.toPlace.length) continue
      const x = Math.floor(node.x), z = Math.floor(node.z), top = Math.floor(node.y + 1e-3)
      for (let yy = top; yy >= top - 2; yy--) {
        if (!this.index.cells.has(KEY(x, yy, z))) continue
        const door = this.lowerOf(this.bot.blockAt(new Vec3(x, yy, z)))
        if (!door || !B.isHandOpenable(door.name)) break
        const ly = door.position.y
        const under = this.bot.blockAt(new Vec3(x, ly - 1, z))
        let floorTop = ly
        if (under && under.shapes && under.shapes.length) floorTop = ly - 1 + Math.min(1, Math.max(...under.shapes.map(sh => sh[4])))
        if (node.y > floorTop + 0.05 || node.y < floorTop - 0.05) { node.x = x + 0.5; node.y = floorTop; node.z = z + 0.5; fixed++ }
        break
      }
    }
    return fixed
  }

  // Clear ray from the eye to the door block? Without a checker (tests of the old interface) everything counts as visible; if the
  // checker itself throws (no raycast available) we say so once and let the click through rather than freezing all movement.
  visible(block) {
    if (!this.canSeeFn) return true
    try { return !!this.canSeeFn(block) } catch (e) { if (!this.losWarned) { this.losWarned = true; this.log('line-of-sight check failed (' + e.message + '); not enforcing it for doors') } return true }
  }

  // The same library step also lifts a path node that sits in a LADDER cell onto the top of the ladder block (cell y + 1), and for an
  // ascending climb that is the target: the first node is then 2 blocks above a bot that has to jump onto the block under the ladder
  // first, so the jump is never made and the bot stands there until "stuck" (live: the bot could not mount the shaft ladder, every goal
  // "No path"/stuck). Nodes it moved are recognisable: integer y with a ladder/vine right below and x or z off the cell centre (the plate
  // bias of getPositionOnTopOf). Descending ladder nodes are centred by the library and left alone.
  fixLadders(path) {
    const bot = this.bot
    const climb = this.climbIds || (this.climbIds = new Set(['ladder', 'vine'].map(n => bot.registry.blocksByName[n] && bot.registry.blocksByName[n].id).filter(x => x !== undefined)))
    const isClimbCell = (x, y, z) => { const b = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y + 1e-3), Math.floor(z))); return !!(b && climb.has(b.type)) }
    let fixed = 0
    for (let i = 0; i < path.length; i++) {
      const node = path[i]
      if (node.toBreak && node.toBreak.length || node.toPlace && node.toPlace.length) continue
      if (Math.abs(node.y - Math.round(node.y)) > 1e-6) continue
      const cx = Math.floor(node.x) + 0.5, cz = Math.floor(node.z) + 0.5
      if (Math.abs(node.x - cx) < 1e-6 && Math.abs(node.z - cz) < 1e-6) continue
      const below = bot.blockAt(new Vec3(Math.floor(node.x), node.y - 1, Math.floor(node.z)))
      if (!below || !climb.has(below.type)) continue
      node.y -= 1; fixed++
      // The library aims every ladder node at a point 0.2 blocks INTO the ladder plate so that "forward" keeps pressing against it (that is what
      // climbs). Aiming at it from the side is a trap: the bot steers into the corner next to the plate and can never enter the cell (the plate is
      // 0.19 thick, the body 0.6 wide). So the node where the climb STARTS (the one before it is not a ladder cell) is aimed at the cell centre.
      const prev = i === 0 ? bot.entity.position : path[i - 1]
      if (!isClimbCell(prev.x, prev.y, prev.z)) { node.x = cx; node.z = cz }
    }
    return fixed
  }

  // ---------- helpers ----------
  lowerOf(block) {      // doors are two blocks; the lower half is the one we key and click
    if (!block) return null
    const pr = block.getProperties ? block.getProperties() : {}
    if (B.isDoor(block.name) && pr.half === 'upper') return this.bot.blockAt(block.position.offset(0, -1, 0))
    return block
  }
  isOpen(block) { const pr = block && block.getProperties ? block.getProperties() : {}; return pr.open === true }
  kindOf(name) { return B.isDoor(name) ? 'door' : B.isGate(name) ? 'gate' : 'trapdoor' }
  center(pos) { return new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5) }
  hdist(pos) { const p = this.bot.entity.position; return Math.hypot(pos.x + 0.5 - p.x, pos.z + 0.5 - p.z) }
  eyeDist(pos) { return this.bot.entity.position.offset(0, 1.62, 0).distanceTo(this.center(pos)) }
  sideOf(entry) {       // which side of the door plane the bot is on: -1 / 0 (inside the cell) / +1
    const p = this.bot.entity.position
    const c = entry.kind === 'trapdoor' ? p.y - (entry.pos.y + 0.5) : (entry.axis === 'x' ? p.x - (entry.pos.x + 0.5) : p.z - (entry.pos.z + 0.5))
    return Math.abs(c) < 0.9 && entry.kind !== 'trapdoor' ? 0 : Math.sign(c)
  }

  // Resolve when pred() is true or after maxTicks physics ticks. Returns pred() at the end.
  waitFor(pred, maxTicks) {
    return new Promise(res => {
      let n = 0
      const f = () => { if (pred() || ++n >= maxTicks) { this.bot.removeListener('physicsTick', f); res(pred()) } }
      this.bot.on('physicsTick', f)
    })
  }

  // Click a door without letting mineflayer turn the bot (the pathfinder re-aims every tick and lookAt() would wait on it).
  async interact(block, { look = false } = {}) {
    const bot = this.bot
    let p
    if (look) p = bot.activateBlock(block)
    else {
      const orig = bot.lookAt
      bot.lookAt = () => Promise.resolve()
      try { p = bot.activateBlock(block) } finally { bot.lookAt = orig }   // activateBlock reads lookAt synchronously, before its first await
    }
    let done = false
    p.then(() => { done = true }, () => { done = true })
    await this.waitFor(() => done, 24)
  }

  // ---------- per tick ----------
  tick() {
    this.t++
    if (!this.bot.entity || !this.bot.entity.position) return
    const moving = this.livePath.length > 0
    this.idleTicks = moving ? 0 : (this.idleTicks || 0) + 1
    if (this.busy) return
    let job = null
    try {
      const up = moving ? this.upcoming() : new Map()
      job = this.nextClose(up) || this.nextOpen(up) || this.nextBump()
    } catch (e) { this.log('door tick error: ' + e.message); return }
    if (!job) return
    this.busy = true
    job().catch(e => this.log('door action error: ' + e.message)).finally(() => { this.busy = false })
  }

  // doors/gates/hatches on the next few path nodes that the bot will really pass through
  upcoming() {
    const out = new Map()
    const path = this.livePath
    const n = Math.min(path.length, this.cfg.lookAhead)
    const add = (x, y, z, why, wantTrapdoor) => {
      const b = this.lowerOf(this.bot.blockAt(new Vec3(x, y, z)))
      if (!b || !B.isHandOpenable(b.name) || B.isTrapdoor(b.name) !== wantTrapdoor) return
      const k = KEY(b.position.x, b.position.y, b.position.z)
      if (!out.has(k)) out.set(k, { block: b, why })
    }
    for (let i = 0; i < n; i++) {
      const node = path[i], next = path[i + 1]
      const x = Math.floor(node.x), y = Math.floor(node.y + 1e-3), z = Math.floor(node.z)
      add(x, y, z, 'walk', false); add(x, y + 1, z, 'walk', false)                      // doors / gates (either half) in our way
      // Trapdoors are only ever opened as hatches over a ladder: one walked over on the floor must stay shut under our feet.
      if (next && Math.floor(next.x) === x && Math.floor(next.z) === z) {
        const ny = Math.floor(next.y + 1e-3)
        if (ny > y) add(x, y + 2, z, 'hatch-up', true)
      }
    }
    return out
  }

  nextOpen(up) {
    for (const [k, { block, why }] of up) {
      if (this.isOpen(block) || this.failed.has(k)) continue
      if (!this.visible(block)) { this.losSkips++; continue }
      const close = why === 'walk' ? this.hdist(block.position) <= this.cfg.openRadius && Math.abs(block.position.y - this.bot.entity.position.y) <= 2.6 : this.eyeDist(block.position) <= this.cfg.reach - 0.4
      if (!close) continue
      const prev = this.opened.get(k)
      if (prev && this.t - prev.tick < this.cfg.retryTicks) continue
      return () => this.open(block, k, why)
    }
    return null
  }

  // Walked into something closed that the planner did not announce (dynamic goals, replans): open what is straight ahead.
  nextBump() {
    const e = this.bot.entity
    if (!e.isCollidedHorizontally || !this.index.cells.size) return null
    const px = e.position.x - Math.sin(e.yaw) * 0.65, pz = e.position.z - Math.cos(e.yaw) * 0.65
    for (const dy of [0, 1]) {
      const b = this.lowerOf(this.bot.blockAt(new Vec3(Math.floor(px), Math.floor(e.position.y + 1e-3) + dy, Math.floor(pz))))
      if (!b || !B.isHandOpenable(b.name) || B.isTrapdoor(b.name) || this.isOpen(b)) continue
      const k = KEY(b.position.x, b.position.y, b.position.z)
      const prev = this.opened.get(k)
      if (this.failed.has(k) || (prev && this.t - prev.tick < this.cfg.retryTicks)) continue
      if (!this.visible(b)) { this.losSkips++; continue }
      this.stats.bumped++
      return () => this.open(b, k, 'bump')
    }
    return null
  }

  async open(block, k, why) {
    const pr = block.getProperties()
    const entry = this.opened.get(k) || { key: k, pos: block.position.clone(), name: block.name, axis: B.passAxis(pr), kind: this.kindOf(block.name), tick: this.t, side: 0, tries: 0, passed: false }
    entry.side = this.sideOf(entry); entry.tick = this.t; entry.tries++
    this.opened.set(k, entry)
    await this.interact(block)
    const ok = await this.waitFor(() => this.isOpen(this.bot.blockAt(block.position)), 4)   // the update comes back from the server
    if (ok) {
      this.stats.opened++; entry.tries = 0
      this.log(`opened ${block.name} at ${k} (${why})`)
      this.persist(this.snapshot())
      return
    }
    if (entry.tries >= this.cfg.maxTries) {
      this.opened.delete(k); this.failed.set(k, this.t); this.stats.failed++
      this.log(`${block.name} at ${k} will not open`)
      this.persist(this.snapshot())
      this.onFailed({ key: k, pos: block.position.clone(), name: block.name })
    }
  }

  nextClose(up) {
    for (const [k, e] of this.opened) {
      const block = this.bot.blockAt(e.pos)
      if (!block || block.name !== e.name) { this.opened.delete(k); this.persist(this.snapshot()); continue }
      if (!this.isOpen(block)) { if (this.t - e.tick > this.cfg.retryTicks * 2) { this.opened.delete(k); this.persist(this.snapshot()) } continue }
      if (this.t - e.tick < 3 || this.failed.has(k)) continue                // just opened
      const side = this.sideOf(e)
      if (!e.passed && e.side === 0 && side !== 0) e.side = -side            // we opened it from inside the cell: "before" is the other side
      if (!e.passed && side !== 0 && e.side !== 0 && side !== e.side) e.passed = true
      const d = e.kind === 'trapdoor' ? this.eyeDist(e.pos) : this.hdist(e.pos)
      if (d > this.cfg.closeMax) continue                                    // out of easy reach: stays listed, closed when we are near again
      const p = this.bot.entity.position
      const clear = e.kind === 'trapdoor' ? (Math.abs(p.y - (e.pos.y + 0.5)) >= 1.4 || this.hdist(e.pos) > 1.2) : (d >= this.cfg.closeMin && side !== 0)
      if (!clear) continue
      if (!this.visible(block)) { this.losSkips++; continue }
      const ahead = up.has(k)
      if (e.passed) return () => this.close(block, k)                        // went through: close behind us
      if (ahead) continue                                                    // still on its way to the door
      // never went through (goal changed / reached short of it): close once we have clearly walked off or stopped for a while
      if (d >= 3.2 || (this.idleTicks || 0) >= 20) return () => this.close(block, k)
    }
    return null
  }

  async close(block, k) {
    const e = this.opened.get(k)
    await this.interact(block)
    await this.waitFor(() => !this.isOpen(this.bot.blockAt(block.position)), 4)
    if (!this.isOpen(this.bot.blockAt(block.position))) {
      this.opened.delete(k); this.stats.closed++
      this.log(`closed ${block.name} at ${k}`)
      this.persist(this.snapshot())
    } else if (e) { e.tick = this.t; e.closeTries = (e.closeTries || 0) + 1; if (e.closeTries >= this.cfg.maxTries) { this.opened.delete(k); this.persist(this.snapshot()); this.log(`could not close ${block.name} at ${k}`) } }
  }

  // Doors left open that are still within `radius` (for a "go back and close it" chore).
  pendingNear(radius = 16) {
    const out = []
    for (const e of this.opened.values()) { const b = this.bot.blockAt(e.pos); if (b && this.isOpen(b) && this.hdist(e.pos) <= radius) out.push(e) }
    return out
  }
  status() { return { open: [...this.opened.keys()], failed: [...this.failed.keys()], losSkips: this.losSkips, ...this.stats } }
}

module.exports = { DoorTender }
