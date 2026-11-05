// brain/nav/reach.js: the go-to primitive that does not give up (Walter: "there is no such thing as 'I can't get there'. You can tear down
// a wall and rebuild it after you get to the other side").
//
//   const r = await reach.goto(goal, { label, ms, isAborted, maxMs, escalate })       // { label, ok, secs, err, via }
//
// Level 0  the normal nav goto (doors, hazards, stuck recovery).
// Level 1  the same pathfinder with digging, bridging and 1x1 towers switched on (nav.enterDigMode): wall, rock, gap, cliff, door that will not open.
// Level 2  a hand-driven beeline when the planner has no answer (unloaded terrain, a search that times out, a pit with no exit):
//          dig through the block in front, bridge a gap, pillar up, dig a stair down. Every dig needs the block in view and in reach.
// Level 3  when a whole round makes no progress: sidestep to a point off to the side and plan again from there.
// Whatever it breaks that belongs to the base (or looks built: planks, bricks, glass, fences, doors ...) is written down and put back once the
// bot is on the far side (Breaches). Chests, furnaces, beds, ladders, the walls a ladder or torch hangs on and anything next to lava are never touched.
// It never asks for help and never says anything in chat; it pauses only while the bot is in real danger. Aborts (stop, a new goal) end it at once.
const { Vec3 } = require('vec3')
const B = require('./blocks')
const los = require('../los')
const { markPlacing } = require('../reflexes')

const AIR = /^(air|cave_air|void_air)$/
const HAZARD = /^(lava|fire|soul_fire|cactus|magma_block|campfire|soul_campfire|sweet_berry_bush|powder_snow|pointed_dripstone|cobweb|wither_rose|tripwire)$/
const GRAVITY = /^(sand|red_sand|gravel|.*_concrete_powder|suspicious_sand|suspicious_gravel)$/
// never broken: containers and workstations, beds, light/redstone gear, anything that needs a special tool or holds the bot's stuff
const PROTECTED = /(^|_)(chest|barrel|furnace|smoker|hopper|dropper|dispenser|crafting_table|bed|anvil|enchanting_table|brewing_stand|beacon|lectern|cauldron|jukebox|note_block|spawner|bedrock|obsidian|reinforced_deepslate|end_portal|end_portal_frame|nether_portal|end_gateway|command_block|barrier|ladder|ender_chest|composter|grindstone|stonecutter|loom|smithing_table|cartography_table|fletching_table|bell|lodestone|respawn_anchor|conduit|lever|button|repeater|comparator|piston|observer|redstone_lamp|redstone_wire|decorated_pot|trial_spawner|vault|crafter|scaffolding|sign|banner|head|skull|candle|end_rod|lantern|frame|sculk_sensor|sculk_shrieker|sculk_catalyst|spore_blossom|bamboo_sapling|farmland|water|lava)$|shulker_box$|_bed$|_sign$|_banner$|_head$|_skull$|_candle$|_lantern$|_rail$|^rail$|^torch$|_torch$/
// things that hang on a neighbouring block: breaking that block pops them off
const ATTACHED = /^(ladder|wall_torch|redstone_wall_torch|soul_wall_torch|vine|lever|tripwire_hook|.*_wall_sign|.*_wall_hanging_sign|.*_wall_banner|.*_button|.*_wall_head|.*_wall_skull|scaffolding)$/
// natural ground: not rebuilt outside the base zone
const NATURAL = /^(stone|dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium|sand|red_sand|gravel|clay|snow|snow_block|powder_snow|ice|packed_ice|blue_ice|deepslate|tuff|granite|diorite|andesite|netherrack|basalt|blackstone|calcite|dripstone_block|mud|moss_block|moss_carpet|sandstone|red_sandstone|terracotta|short_grass|tall_grass|fern|large_fern|dead_bush|vine|glow_lichen|snow|.*_ore|.*_leaves|.*_log|.*_wood|.*_stem|.*_wart_block|.*_roots|.*_sapling|.*_flower|bush|.*_coral.*)$/
// reads as built even in the wild
const STRUCTURE = /(planks|_bricks?$|brick|glass|_door$|fence|_gate$|_slab$|_stairs$|_wall$|concrete|glazed_terracotta|_wool$|bookshelf|iron_bars|sea_lantern|smooth_|polished_|chiseled_|cut_|_trapdoor$|copper|prismarine|purpur|quartz|mud_bricks|bamboo_mosaic|_block$)/
const SCAFFOLD = ['dirt', 'cobblestone', 'cobbled_deepslate', 'stone', 'netherrack', 'andesite', 'diorite', 'granite', 'tuff', 'coarse_dirt', 'sandstone', 'blackstone', 'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'bamboo_planks', 'crimson_planks', 'warped_planks']
const INTERACTIVE = /(chest|barrel|furnace|smoker|crafting_table|hopper|dropper|dispenser|beacon|lectern|anvil|_bed$|enchanting|brewing|shulker|cauldron|grindstone|stonecutter|loom|smithing|cartography|fletching|bell|note_block|jukebox|composter|_door$|_gate$|trapdoor|lever|button|crafter)/
const GATHERABLE = /^(stone|cobblestone|dirt|grass_block|coarse_dirt|andesite|diorite|granite|tuff|deepslate|netherrack|sandstone|gravel|sand)$/
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const SIX = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
const RETRY = new Set(['no path', 'path search timed out', 'stuck', 'timeout', 'arrival check failed', 'hazard'])
const HOSTILE = /^(zombie|zombie_villager|husk|drowned|skeleton|stray|creeper|spider|cave_spider|witch|pillager|vindicator|slime|phantom|silverfish|blaze|ghast|piglin_brute|hoglin|zoglin|wither_skeleton|magma_cube|evoker|ravager|vex|warden|bogged|breeze)$/

const DEFAULTS = {
  maxMs: 8 * 60000,           // total time one go-to may spend escalating
  maxStall: 5,                // rounds in a row without getting closer before it gives up (silently)
  thinkBase: 5000, thinkMax: 15000,           // ms the digging planner may think per attempt (grows each round)
  planMsBase: 20000, planMsPerBlock: 400, planMsMax: 60000,   // how long one planner attempt may take in all, walking included
  baseCenter: { x: -1059, z: 2341 }, baseRadius: 80,     // everything non-natural inside is rebuilt after a breach
  property: { x0: -1108, x1: -1012, z0: 2242, z1: 2368, minY: 134 },   // Walter's property surface (autopilot/memory.js): even dirt and grass dug here is put back, and digging it is a last resort
  lethalHp: 6, lethalMobRange: 6, lethalMaxWaitMs: 15000
}

const floorV = (p) => new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))

class Breaches {
  // Remembers base blocks broken while a go-to escalates and puts them back from the far side.
  constructor({ reach, list = [] }) { this.r = reach; this.list = list; this.active = false; this._on = (o, n) => this.onUpdate(o, n) }
  begin() { if (this.active) return; this.active = true; this.r.bot.on('blockUpdate', this._on) }
  end() { if (!this.active) return; this.active = false; this.r.bot.removeListener('blockUpdate', this._on) }
  wanted(b) {
    const n = b.name
    if (AIR.test(n) || B.isHandOpenable(n)) return false                                    // a door that swings is not a breach
    if (this.r.inProperty(b.position)) return !/_leaves$/.test(n)                          // the lawn too
    if (this.r.inBase(b.position)) return !NATURAL.test(n)
    return STRUCTURE.test(n) && !NATURAL.test(n)
  }
  onUpdate(oldB, newB) {
    try {
      if (!oldB || !newB || oldB.type === newB.type || !newB.position) return
      if (!AIR.test(newB.name) || oldB.boundingBox === 'empty' || /^(water|lava)$/.test(oldB.name)) return
      const me = this.r.bot.entity.position
      if (me.distanceTo(oldB.position.offset(0.5, 0.5, 0.5)) > 7) return                 // somebody else's dig
      const props = oldB.getProperties ? oldB.getProperties() : {}
      if (props.half === 'upper') return                                                    // doors: the lower half carries the item
      if (!this.wanted(oldB)) return
      const p = oldB.position
      this.list.push({ x: p.x, y: p.y, z: p.z, name: oldB.name, props, from: { x: me.x, y: me.y, z: me.z }, tries: 0 })
      this.r.log(`breach: broke ${oldB.name} at ${p.x},${p.y},${p.z}`)
    } catch { /* never let bookkeeping break a dig */ }
  }
  itemFor(rec) {
    const bot = this.r.bot, items = bot.inventory.items()
    const exact = items.find(i => i.name === rec.name)
    if (exact) return exact
    const def = bot.registry.blocksByName[rec.name]
    const drop = def && def.drops && def.drops[0] && bot.registry.items[def.drops[0]]
    if (drop) { const d = items.find(i => i.name === drop.name); if (d) return d }
    const sub = SCAFFOLD.map(n => items.find(i => i.name === n)).find(Boolean)          // better a plain block than a hole in the wall
    return sub || null
  }
  // Seal one cell from the far side. Returns true when it is closed (or no longer needs closing).
  async sealOne(rec, run) {
    const r = this.r, bot = r.bot
    const cell = new Vec3(rec.x, rec.y, rec.z)
    const now = bot.blockAt(cell)
    if (!now) return false
    if (now.boundingBox !== 'empty' || /^(water|lava)$/.test(now.name)) return true
    const item = this.itemFor(rec)
    if (!item) { r.log(`breach: nothing to close ${rec.name} at ${rec.x},${rec.y},${rec.z} with`); return false }
    const fx = rec.x + 0.5 - rec.from.x, fy = rec.y + 0.5 - rec.from.y, fz = rec.z + 0.5 - rec.from.z
    const ax = Math.abs(fx), ay = Math.abs(fy), az = Math.abs(fz)
    const u = ax >= ay && ax >= az ? [Math.sign(fx), 0, 0] : az >= ay ? [0, 0, Math.sign(fz)] : [0, Math.sign(fy), 0]
    const spots = []
    for (let k = 1; k <= 2; k++) for (const dy of [0, -1, 1]) spots.push(new Vec3(rec.x + u[0] * k, rec.y + u[1] * k + dy, rec.z + u[2] * k))
    const standable = (s) => { const f = bot.blockAt(s.offset(0, -1, 0)), a = bot.blockAt(s), h = bot.blockAt(s.offset(0, 1, 0)); return f && a && h && f.boundingBox === 'block' && !HAZARD.test(f.name) && a.boundingBox === 'empty' && h.boundingBox === 'empty' }
    for (const attempt of [0, 1]) {
      if (r.stopped(run)) return false
      if (await r.placeAt(cell, item.name, { fromFarSide: u })) return true
      // not placeable from here: walk to the far side (through the opening) and try again
      const s = spots.find(standable)
      if (!s || attempt) return false
      const g = new r.goals.GoalBlock(s.x, s.y, s.z)
      const res = await r.nav.gotoOnce(g, { label: 'to close the wall', ms: 20000, isAborted: () => r.stopped(run) })
      if (!res.ok) return false
    }
    return false
  }
  async finish(run) {
    this.end()
    const todo = this.list.splice(0)
    const keep = []
    const t0 = this.r.t
    for (const rec of todo) {
      if (this.r.stopped(run) || this.r.t - t0 > 20 * 90) { keep.push(rec); continue }                   // ~90 s for the whole clean-up
      const away = this.r.bot.entity.position.distanceTo(new Vec3(rec.x + 0.5, rec.y + 0.5, rec.z + 0.5))
      if (away > 48) { keep.push(rec); continue }
      let ok = false
      try { ok = await this.sealOne(rec, run) } catch (e) { this.r.log('breach seal failed: ' + e.message) }
      if (!ok && ++rec.tries < 3) keep.push(rec)
    }
    this.left = keep
    if (keep.length) this.r.log(`breach: ${keep.length} block(s) still to put back`)
    return keep.length
  }
}

class Reach {
  constructor({ nav, bot, goals, log = () => {}, config = {}, persist = () => {}, saved = null }) {
    this.nav = nav; this.bot = bot; this.goals = goals; this.log = log; this.persist = persist
    this.cfg = { ...DEFAULTS, ...config }
    this.t = 0                       // physics ticks seen
    this.run = null
    this.seq = 0
    this.phase = null
    this.internalSet = 0
    this.stats = { escalations: 0, solved: 0, gaveUp: 0, dug: 0, placed: 0, sealed: 0, byLevel: { plan: 0, manual: 0, sidestep: 0 } }
    this.last = null
    this.pending = (saved && Array.isArray(saved.breaches)) ? saved.breaches.slice(0, 200) : []      // breaches nobody has closed yet (survive restarts)
    this.open = new Set()                                                                            // Breaches of runs in flight
    this._tick = () => { this.t++ }
    this._goal = (g) => this.onGoalUpdated(g)
    bot.on('physicsTick', this._tick)
    bot.on('goal_updated', this._goal)
  }
  detach() { this.bot.removeListener('physicsTick', this._tick); this.bot.removeListener('goal_updated', this._goal); for (const b of this.open) b.end(); this.open.clear() }

  // ---------- run bookkeeping ----------
  stopped(run) { return !run || run.cancelled || (run.isAborted && run.isAborted()) || this.run !== run }
  cancel(why = 'stopped') { if (this.run) { this.run.cancelled = why; try { this.bot.clearControlStates() } catch { /* ignore */ } } }
  internal(fn) { this.internalSet++; try { return fn() } finally { this.internalSet-- } }
  // Somebody (stop, a routine, the chat) changed the pathfinder goal while we steer by hand: that is a stop or a new job.
  onGoalUpdated() {
    const run = this.run
    if (!run || this.phase !== 'manual' || this.internalSet) return
    run.cancelled = 'goal changed'
  }
  async ticks(n, run) {
    await new Promise((res) => { let k = 0; const f = () => { if (++k >= n || (run && this.stopped(run))) { this.bot.removeListener('physicsTick', f); res() } }; this.bot.on('physicsTick', f) })
  }

  // ---------- geometry ----------
  blk(x, y, z) { return this.bot.blockAt(new Vec3(x, y, z)) }
  inProperty(p) { const q = this.cfg.property; return !!q && p.x >= q.x0 && p.x <= q.x1 && p.z >= q.z0 && p.z <= q.z1 && p.y >= q.minY }
  // extra path cost for breaking a block: natural ground on the property (and the base) is the last thing to dig
  breakWeight(b) {
    if (!b || !b.position) return 0
    if (this.attachedTo(b)) return 500
    if (this.inProperty(b.position)) return 40
    return this.inBase(b.position) && NATURAL.test(b.name) ? 10 : 0
  }
  inBase(p) { const c = this.cfg.baseCenter; return !!c && Math.abs(p.x - c.x) <= this.cfg.baseRadius && Math.abs(p.z - c.z) <= this.cfg.baseRadius }
  feet() { return floorV(this.bot.entity.position) }
  targetOf(goal) {
    if (!goal) return null
    if (typeof goal.x === 'number' && typeof goal.z === 'number') return { x: Math.floor(goal.x), y: typeof goal.y === 'number' ? Math.floor(goal.y) : null, z: Math.floor(goal.z), near: typeof goal.rangeSq === 'number' ? Math.sqrt(goal.rangeSq) : 0 }
    if (goal.pos && typeof goal.pos.x === 'number') return { x: Math.floor(goal.pos.x), y: Math.floor(goal.pos.y), z: Math.floor(goal.pos.z), near: 2, lookAt: true }
    if (Array.isArray(goal.goals)) {
      const me = this.bot.entity.position
      let best = null, bd = Infinity
      for (const g of goal.goals) { const t = this.targetOf(g); if (!t) continue; const d = Math.hypot(t.x - me.x, (t.y == null ? me.y : t.y) - me.y, t.z - me.z); if (d < bd) { bd = d; best = t } }
      return best
    }
    return null
  }
  dist(t) { const p = this.bot.entity.position; return Math.hypot(t.x + 0.5 - p.x, t.z + 0.5 - p.z) + (t.y == null ? 0 : Math.abs(t.y - p.y) * 0.5) }
  isHazard(b) { return !!b && HAZARD.test(b.name) }
  floodRisk(c) {
    for (const [dx, dy, dz] of SIX) { const b = this.blk(c.x + dx, c.y + dy, c.z + dz); if (b && b.name === 'lava') return true }
    return false
  }
  attachedTo(b) {                       // does something hang on this block (a ladder, a torch, a sign ...)? Walter: never dig a ladder's wall.
    const p = b.position
    for (const [dx, dy, dz] of SIX) {
      const n = this.blk(p.x + dx, p.y + dy, p.z + dz)
      if (!n || !ATTACHED.test(n.name)) continue
      const pr = n.getProperties ? n.getProperties() : {}
      if (n.name === 'vine' || n.name === 'scaffolding') return true
      if (pr.facing) { const f = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] }[pr.facing]; if (f && p.x + dx - f[0] === p.x && p.z + dz - f[2] === p.z && dy === 0) return true }
      else if (dy === 1 || dy === -1) return true
    }
    return false
  }
  diggable(b) {
    if (!b) return false
    if (b.boundingBox === 'empty') return true
    if (PROTECTED.test(b.name) || b.diggable === false || b.name === 'bedrock') return false
    if (this.attachedTo(b)) return false
    return true
  }
  satisfied(goal) { return this.nav.satisfied(goal) }

  // ---------- danger ----------
  lethal() {
    const bot = this.bot
    if (bot.entity.isInLava) return true
    if (bot.health > this.cfg.lethalHp) return false
    const me = bot.entity.position
    return Object.values(bot.entities).some(e => e && e.position && e !== bot.entity && HOSTILE.test(e.name || '') && e.position.distanceTo(me) < this.cfg.lethalMobRange)
  }
  async lethalPause(run) {
    let waited = 0
    while (this.lethal() && !this.stopped(run) && waited < this.cfg.lethalMaxWaitMs / 50) { await this.ticks(10, run); waited += 10 }
  }

  // ---------- main entry ----------
  async goto(goal, opts = {}) {
    const nav = this.nav
    const t0 = this.t
    const secs = () => +(((this.t - t0) * 50) / 1000).toFixed(1)
    const label = opts.label || 'there'
    if (this.run) this.run.cancelled = 'replaced'
    const run = this.run = { id: ++this.seq, cancelled: false, isAborted: opts.isAborted || null, label }
    try {
      let r = null
      if (!opts.startAtDig) r = await nav.gotoOnce(goal, opts)
      if (r && (r.ok || !RETRY.has(r.err))) return r
      if (this.stopped(run)) return r || { label, ok: false, secs: secs(), err: 'aborted' }
      if (opts.escalate === false || opts.dynamic) return r
      const target = this.targetOf(goal)
      if (!target) return r || { label, ok: false, secs: secs(), err: 'no target' }
      this.stats.escalations++
      this.log(`reach: "${label}" ${r ? 'failed (' + r.err + ')' : 'starts digging'}; escalating toward ${target.x},${target.y},${target.z}`)
      const res = await this.escalate(goal, target, run, opts)
      this.last = { label, ok: res.ok, err: res.err || null, via: res.via || null, secs: secs(), at: Date.now() }
      if (res.ok) this.stats.solved++; else if (!this.stopped(run)) this.stats.gaveUp++
      this.log(`reach: "${label}" ${res.ok ? 'arrived via ' + res.via : 'ended: ' + res.err} after ${secs()}s`)
      return { label, ok: res.ok, secs: secs(), ...(res.ok ? { via: res.via } : { err: res.err }) }
    } finally {
      if (this.run === run) { this.run = null; this.phase = null }
    }
  }

  async escalate(goal, target, run, opts) {
    const nav = this.nav, bot = this.bot
    const budget = Math.ceil((opts.maxMs || this.cfg.maxMs) / 50)
    const start = this.t
    let best = this.dist(target), stall = 0, via = 'plan'
    nav.enterDigMode()
    const breaches = new Breaches({ reach: this })
    breaches.begin(); this.open.add(breaches)
    try {
      for (let round = 0; this.t - start < budget && !this.stopped(run); round++) {
        await this.lethalPause(run)
        if (this.stopped(run)) break
        if (this.satisfied(goal)) return { ok: true, via }
        // level 1: planner with digging / bridging / towers
        this.phase = 'plan'; this.stats.byLevel.plan++
        const think = Math.min(this.cfg.thinkMax, this.cfg.thinkBase + round * 3000)
        const old = bot.pathfinder.thinkTimeout
        bot.pathfinder.thinkTimeout = think
        let r
        try { r = await nav.gotoOnce(goal, { label: opts.label, ms: Math.min(this.cfg.planMsMax, this.cfg.planMsBase + this.dist(target) * this.cfg.planMsPerBlock), isAborted: () => this.stopped(run), netherOk: opts.netherOk }) } finally { bot.pathfinder.thinkTimeout = old }
        if (r.ok) return { ok: true, via: 'plan' }
        if (this.stopped(run)) break
        if (!RETRY.has(r.err)) return { ok: false, err: r.err }
        // level 2: by hand
        this.phase = 'manual'; this.stats.byLevel.manual++
        const m = await this.manual(goal, target, run, { steps: 70 + round * 20 })
        if (m.ok) return { ok: true, via: 'manual' }
        if (this.stopped(run)) break
        const d = this.dist(target)
        if (d < best - 1.5) { best = d; stall = 0 } else stall++
        if (stall >= 2) {                                                              // level 3: come at it from another side
          this.stats.byLevel.sidestep++
          await this.sidestep(goal, target, run, stall)
        }
        if (stall >= this.cfg.maxStall) return { ok: false, err: 'no way found after digging' }
      }
      return { ok: false, err: this.stopped(run) ? 'aborted' : 'out of time' }
    } finally {
      this.phase = null
      if (this.run === run) this.internal(() => { try { bot.pathfinder.setGoal(null) } catch { /* ignore */ } try { bot.clearControlStates() } catch { /* ignore */ } })     // not when a newer go-to already took over
      nav.leaveDigMode()
      try { await breaches.finish(run) } catch (e) { this.log('breach clean-up: ' + e.message) }
      this.open.delete(breaches)
      this.addPending(breaches.left || [])
    }
  }

  // Walk 12-24 blocks to the side of the line to the target (by hand), then let the planner try again from there.
  async sidestep(goal, target, run, stall) {
    const me = this.feet()
    const dx = target.x - me.x, dz = target.z - me.z, n = Math.hypot(dx, dz) || 1
    const sign = (stall % 2) ? 1 : -1, len = 10 + 6 * Math.min(stall, 4)
    const to = { x: Math.floor(me.x + (-dz / n) * len * sign), y: null, z: Math.floor(me.z + (dx / n) * len * sign), near: 2 }
    this.log(`reach: sidestep to ${to.x},${to.z}`)
    await this.manual({ isEnd: (p) => Math.hypot(p.x - to.x, p.z - to.z) <= 2 }, to, run, { steps: 40 })
  }

  // ---------- level 2: hand-driven beeline ----------
  async manual(goal, target, run, { steps = 80 } = {}) {
    const bot = this.bot
    const visits = new Map()
    let fails = 0, did = 0
    while (did++ < steps && !this.stopped(run)) {
      await this.lethalPause(run)
      if (this.satisfied(goal)) return { ok: true }
      const here = this.feet()
      const k = `${here.x},${here.y},${here.z}`
      visits.set(k, (visits.get(k) || 0) + 1)
      if (target.lookAt && Math.abs(target.x - here.x) + Math.abs(target.z - here.z) + Math.abs(target.y - here.y) <= 2) return { ok: false, err: 'next to it' }
      const move = this.chooseMove(here, target, visits, fails)
      if (!move) { if (++fails > 4) return { ok: false, err: 'boxed in' }; await this.ticks(10, run); continue }
      const ok = await this.doMove(move, run)
      if (ok) fails = 0; else { fails++; if (move.cell) this.banCell(move.cell) }
      if (fails > 6) return { ok: false, err: 'could not make the move' }
    }
    return { ok: false, err: 'steps used up' }
  }

  banCell(c) { (this._ban || (this._ban = new Map())).set(`${c.x},${c.y},${c.z}`, this.t + 20 * 40) }
  banned(c) { const t = this._ban && this._ban.get(`${c.x},${c.y},${c.z}`); return !!t && t > this.t }

  // Everything one horizontal step (dy -1 / 0 / +1) would take: cells to clear, a block to place, doors to open, or why it cannot be done.
  planMove(here, hx, hz, dy) {
    const nx = here.x + hx, nz = here.z + hz, ny = here.y + dy
    const plan = { type: 'step', hx, hz, dy, cell: { x: nx, y: ny, z: nz }, dig: [], place: null, doors: [], drop: 0, ok: true }
    const need = [[nx, ny, nz], [nx, ny + 1, nz]]
    if (dy === 1) need.unshift([here.x, here.y + 2, here.z])
    for (const [x, y, z] of need) {
      const b = this.blk(x, y, z)
      if (!b) { plan.ok = false; return plan }
      if (this.isHazard(b)) { plan.ok = false; return plan }
      if (b.boundingBox === 'empty') continue                                      // air, water, plants, torches...
      if (B.isHandOpenable(b.name)) { plan.doors.push({ x, y, z }); continue }
      if (!this.diggable(b) || this.floodRisk({ x, y, z })) { plan.ok = false; return plan }
      plan.dig.push({ x, y, z })
    }
    const fb = this.blk(nx, ny - 1, nz)
    if (!fb) { plan.ok = false; return plan }
    if (this.isHazard(fb)) { plan.ok = false; return plan }
    if (fb.boundingBox !== 'block' && fb.name !== 'water') {
      let landed = false
      if (dy <= 0) {
        for (let k = 1; k <= 3; k++) {
          const lb = this.blk(nx, ny - 1 - k, nz)
          if (!lb) { plan.ok = false; return plan }
          if (this.isHazard(lb) || lb.name === 'lava') { plan.ok = false; return plan }
          if (lb.boundingBox === 'block' || lb.name === 'water') { landed = true; plan.drop = k; break }
        }
      }
      if (!landed) plan.place = { x: nx, y: ny - 1, z: nz }
    }
    return plan
  }
  moveCost(p, wantY, gain, here, visits) {
    let c = p.dig.length * 2 + (p.place ? 3 : 0) + p.doors.length * 0.5 + (wantY >= 0 ? p.drop * 2 : 0)
    for (const d of p.dig) { const b = this.blk(d.x, d.y, d.z); if (b) c += this.breakWeight(b) / 5 }
    if (p.dy !== wantY) c += p.dy === 0 ? 1.5 : 3
    if (gain < 0) c += 6; else if (gain === 0) c += 3
    c += 2 * Math.min(3, visits.get(`${p.cell.x},${p.cell.y},${p.cell.z}`) || 0)
    return c
  }
  chooseMove(here, target, visits, fails) {
    const dx = target.x - here.x, dz = target.z - here.z
    const wantY = target.y == null ? 0 : (target.y > here.y ? 1 : target.y < here.y ? -1 : 0)
    if (!dx && !dz) {
      if (wantY > 0) return { type: 'pillar' }
      if (wantY < 0) return { type: 'down' }
      return null
    }
    const options = []
    for (const [hx, hz] of DIRS) {
      const gain = Math.abs(dx) - Math.abs(dx - hx) + Math.abs(dz) - Math.abs(dz - hz)
      if (gain < 0 && fails < 2) continue
      for (const dy of [0, 1, -1]) {
        if (dy === 1 && wantY < 0 && fails < 3) continue
        if (dy === -1 && wantY > 0 && fails < 3) continue
        const p = this.planMove(here, hx, hz, dy)
        if (!p.ok || this.banned(p.cell)) continue
        options.push({ p, cost: this.moveCost(p, wantY, gain, here, visits) })
      }
    }
    if (wantY > 0 && Math.abs(dx) + Math.abs(dz) <= 2) options.push({ p: { type: 'pillar' }, cost: 5 })
    if (!options.length) return null
    options.sort((a, b) => a.cost - b.cost)
    return options[0].p
  }

  async doMove(move, run) {
    const bot = this.bot
    if (move.type === 'pillar') return this.pillar(run)
    if (move.type === 'down') return this.digDown(run)
    for (const d of move.doors) {
      const b = this.blk(d.x, d.y, d.z)
      if (b && B.isHandOpenable(b.name)) { const pr = b.getProperties ? b.getProperties() : {}; if (pr.open !== true) { try { await bot.activateBlock(b) } catch { /* try the next thing */ } await this.ticks(4, run) } }
    }
    for (const c of move.dig) { if (this.stopped(run)) return false; if (!(await this.digCell(c, run))) return false }
    if (move.place) {
      if (!(await this.ensureBlocks(1, run))) return false
      const it = this.scaffoldItem()
      if (!it || !(await this.placeAt(new Vec3(move.place.x, move.place.y, move.place.z), it.name, {}))) return false
      this.stats.placed++
    }
    return this.walkInto(move, run)
  }

  scaffoldItem() { const items = this.bot.inventory.items(); for (const n of SCAFFOLD) { const it = items.find(i => i.name === n); if (it) return it } return null }
  scaffoldCount() { let n = 0; for (const it of this.bot.inventory.items()) if (SCAFFOLD.includes(it.name)) n += it.count; return n }

  async equipFor(b) {
    const bot = this.bot
    try {
      const tool = bot.pathfinder && bot.pathfinder.bestHarvestTool ? bot.pathfinder.bestHarvestTool(b) : null
      if (tool && (!bot.heldItem || bot.heldItem.type !== tool.type)) await bot.equip(tool, 'hand')
    } catch { /* bare hands work too, just slower */ }
  }

  // Dig one cell: the block must be diggable, in reach, and in view (when something else is in the way, that gets dug first).
  async digCell(c, run, depth = 0) {
    const bot = this.bot
    const b = this.blk(c.x, c.y, c.z)
    if (!b) return false
    if (b.boundingBox === 'empty') return true
    if (!this.diggable(b) || this.floodRisk(c) || depth > 3) return false
    const eye = bot.entity.position.offset(0, 1.62, 0)
    if (eye.distanceTo(new Vec3(c.x + 0.5, c.y + 0.5, c.z + 0.5)) > 4.8) return false
    if (!los.canSee(bot, b)) {
      const d = new Vec3(c.x + 0.5, c.y + 0.5, c.z + 0.5).minus(eye)
      const hit = bot.world.raycast(eye, d.scaled(1 / d.norm()), d.norm())
      if (hit && hit.position && (hit.position.x !== c.x || hit.position.y !== c.y || hit.position.z !== c.z)) return (await this.digCell(hit.position, run, depth + 1)) && (await this.digCell(c, run, depth + 1))
      return false
    }
    await this.equipFor(b)
    try {
      await bot.lookAt(new Vec3(c.x + 0.5, c.y + 0.5, c.z + 0.5), true)
      await bot.dig(b, true)
    } catch (e) { this.log(`dig ${b.name} at ${c.x},${c.y},${c.z}: ${e.message}`); return false }
    this.stats.dug++
    await this.ticks(2, run)
    const after = this.blk(c.x, c.y, c.z)
    return !after || after.boundingBox === 'empty' || after.type !== b.type
  }

  // Put `itemName` into the empty cell, against any solid neighbour face that can be seen and reached.
  async placeAt(cell, itemName, { fromFarSide = null } = {}) {
    const bot = this.bot
    const it = bot.inventory.items().find(i => i.name === itemName)
    if (!it) return false
    const me = bot.entity.position
    const eye = me.offset(0, 1.62, 0)
    const cc = new Vec3(cell.x + 0.5, cell.y + 0.5, cell.z + 0.5)
    if (eye.distanceTo(cc) > 4.6) return false
    if (Math.abs(me.x - cc.x) < 0.9 && Math.abs(me.z - cc.z) < 0.9 && me.y + 1.8 > cell.y && me.y < cell.y + 1) return false          // would place it inside ourselves
    const cands = []
    for (const [dx, dy, dz] of SIX) {
      const ref = this.blk(cell.x - dx, cell.y - dy, cell.z - dz)
      if (!ref || ref.boundingBox !== 'block' || INTERACTIVE.test(ref.name)) continue
      const face = new Vec3(dx, dy, dz)
      const click = new Vec3(ref.position.x + 0.5 + dx * 0.5, ref.position.y + 0.5 + dy * 0.5, ref.position.z + 0.5 + dz * 0.5)
      if (eye.distanceTo(click) > 4.8) continue
      if (!los.canSee(bot, ref)) continue
      cands.push({ ref, face, score: (dy === 1 ? 0 : dy === 0 ? 1 : 2) })
    }
    if (!cands.length) return false
    cands.sort((a, b) => a.score - b.score)
    try {
      await bot.equip(it, 'hand')
      for (const c of cands.slice(0, 2)) {
        try { await bot.lookAt(c.ref.position.offset(0.5 + c.face.x * 0.5, 0.5 + c.face.y * 0.5, 0.5 + c.face.z * 0.5), true); await bot.placeBlock(c.ref, c.face) } catch (e) { this.log(`place ${itemName} at ${cell.x},${cell.y},${cell.z}: ${e.message}`); continue }
        await this.ticks(2)
        const now = this.blk(cell.x, cell.y, cell.z)
        if (now && now.boundingBox !== 'empty') { if (fromFarSide) this.stats.sealed++; return true }
      }
    } catch (e) { this.log('place failed: ' + e.message) }
    return false
  }

  // Need at least n blocks to build with: dig a few natural blocks within arm's reach if the bag has none.
  async ensureBlocks(n, run) {
    if (this.scaffoldCount() >= n) return true
    const bot = this.bot
    const ids = Object.values(bot.registry.blocksByName).filter(b => GATHERABLE.test(b.name)).map(b => b.id)
    for (let i = 0; i < 12 && this.scaffoldCount() < n && !this.stopped(run); i++) {
      let spots = []
      try { spots = bot.findBlocks({ matching: ids, maxDistance: 3, count: 24 }) } catch { return false }
      const me = bot.entity.position
      const under = (p) => p.y === Math.floor(me.y) - 1 && Math.floor(me.x) === p.x && Math.floor(me.z) === p.z        // the block we stand on stays
      spots = spots.filter(p => !this.inBase(p) && p.distanceTo(me) <= 3.2 && !under(p))
        .filter(p => { const b = bot.blockAt(p); return b && !this.floodRisk(p) && this.diggable(b) && los.canSee(bot, b) })
        .sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
      if (!spots.length) return false
      if (!(await this.digCell(spots[0], run))) { this.banCell(spots[0]); continue }
      await this.ticks(8, run)                                                      // drops fly to us
    }
    return this.scaffoldCount() >= n
  }

  async walkInto(move, run) {
    const bot = this.bot
    const { x, y, z } = move.cell
    const cx = x + 0.5, cz = z + 0.5
    bot.clearControlStates()
    try {
      for (let i = 0; i < 70 && !this.stopped(run); i++) {
        const p = bot.entity.position
        const dh = Math.hypot(cx - p.x, cz - p.z)
        if (dh < 0.35 && Math.abs(p.y - y) < 0.9 && (bot.entity.onGround || move.dy < 0)) return true
        await bot.lookAt(new Vec3(cx, p.y + 1.62, cz), true)
        bot.setControlState('forward', true)
        bot.setControlState('sprint', false)
        bot.setControlState('jump', move.dy > 0 && dh < 1.6 && bot.entity.onGround)
        await this.ticks(1, run)
      }
      const p = bot.entity.position
      return Math.hypot(cx - p.x, cz - p.z) < 0.8 && Math.abs(p.y - y) < 1.2
    } finally { bot.clearControlStates() }
  }

  // Jump and place a block under the feet; repeat. Needs two free cells above the head.
  async pillar(run) {
    const bot = this.bot
    if (!(await this.ensureBlocks(1, run))) return false
    const f = this.feet()
    for (const dy of [1, 2]) { const c = { x: f.x, y: f.y + dy, z: f.z }; const b = this.blk(c.x, c.y, c.z); if (!b || this.isHazard(b)) return false; if (b.boundingBox !== 'empty' && !(await this.digCell(c, run))) return false }
    const it = this.scaffoldItem(); if (!it) return false
    const ref = this.blk(f.x, f.y - 1, f.z)
    if (!ref || ref.boundingBox !== 'block') return false
    try {
      markPlacing(bot, 4000)
      await bot.equip(it, 'hand')
      await bot.look(bot.entity.yaw, -Math.PI / 2, true)
      bot.setControlState('jump', true)
      let placed = false
      for (let i = 0; i < 40 && !placed && !this.stopped(run); i++) {
        await this.ticks(1, run)
        if (bot.entity.position.y >= f.y + 1.0) {
          try { if (!bot.heldItem || bot.heldItem.name !== it.name) await bot.equip(it, 'hand'); await bot.placeBlock(ref, new Vec3(0, 1, 0)); placed = true } catch (e) { this.log('pillar place: ' + e.message); break }
        }
      }
      bot.setControlState('jump', false)
      await this.ticks(6, run)
      if (placed) this.stats.placed++
      return placed && bot.entity.position.y >= f.y + 0.9
    } catch (e) { this.log('pillar: ' + e.message); return false } finally { bot.clearControlStates() }
  }

  // Dig the block under the feet and drop one level, after checking there is something safe below that.
  async digDown(run) {
    const f = this.feet()
    const under = this.blk(f.x, f.y - 1, f.z), l2 = this.blk(f.x, f.y - 2, f.z), l3 = this.blk(f.x, f.y - 3, f.z)
    if (!under || !l2) return false
    if (this.isHazard(l2) || (l2.boundingBox === 'empty' && (!l3 || this.isHazard(l3) || l3.name === 'lava'))) return false
    if (under.boundingBox === 'block' && !(await this.digCell({ x: f.x, y: f.y - 1, z: f.z }, run))) return false
    await this.ticks(12, run)
    return this.feet().y < f.y
  }

  // ---------- put things back ----------
  addPending(list) { if (list.length) this.pending.push(...list); this.pending = this.pending.slice(-200); this.persistBreaches() }
  persistBreaches() { try { this.persist({ breaches: this.pending.map(({ x, y, z, name, props, from, tries }) => ({ x, y, z, name, props, from, tries })) }) } catch { /* ignore */ } }
  // Close breaches an earlier go-to left open (it was too far to walk back, or got interrupted).
  async rebuildPending({ isAborted = null } = {}) {
    const list = this.pending.splice(0)
    if (!list.length) return 0
    const run = this.run = { id: ++this.seq, cancelled: false, isAborted, label: 'rebuild' }
    const br = new Breaches({ reach: this, list })
    try { const left = await br.finish(run); this.addPending(br.left || []); return left } finally { if (this.run === run) this.run = null; this.persistBreaches() }
  }

  status() {
    return { run: this.run ? { label: this.run.label, phase: this.phase } : null, stats: this.stats, last: this.last, pendingBreaches: this.pending.length }
  }
}

module.exports = { Reach, Breaches, PROTECTED, SCAFFOLD, RETRY, DEFAULTS, ATTACHED, NATURAL, STRUCTURE }
