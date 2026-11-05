// The mining job: legit strip mining for one ore (see README.md, brain/INTERFACE.md and Walter's "Legit mining module" request).
//
// Rules this file keeps (each has a test in test/mining.*.test.js):
//  - no x-ray: a block is only ever dug, approached or counted when it is in plain view (sight.js: exposed face + clear raycast). Hallway
//    cells are dug from the cell in front of the bot, ores only when they were seen. bot.findBlocks is never used for ores or liquids.
//  - pattern: 1 wide, 2 high hallways; a trunk with a branch pair every `spacing` (3) cells = hallway, two solid blocks, hallway.
//  - safety: never dig down (stairs are 1 down per step with the floor seen before stepping), nothing is dug next to visible liquid, back off
//    from visible lava/water, stop at gravel overhead, only natural filler is dug, nothing is ever placed, base area is protected.
//  - supplies: tools through the crafting module (commands.dispatch "craft ..."), storage through api.depositSmeltables, no item piles.
const { Vec3 } = require('vec3')
const makeMover = require('../excavation/move')
const los = require('../los')
const makeSight = require('./sight')
const makeTools = require('./tools')
const G = require('./geometry')
const createWorksite = require('./worksite')
const createShaft = require('./shaft')
const createExit = require('./exit')
const { fit } = require('./mines')
const baseConfig = require('./config.json')

const HOSTILE = /^(zombie|skeleton|creeper|spider|cave_spider|husk|drowned|witch|pillager|vindicator|phantom|slime|silverfish|enderman|zombie_villager|stray|bogged|breeze|blaze|ghast|wither_skeleton)$/
const isItem = (e) => !!e && (e.name === 'item' || e.displayName === 'Item')
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1)
const pretty = (n) => n.replace(/_/g, ' ')
const things = (drop, n) => `${n} ${pretty(drop)}${drop === 'diamond' && n !== 1 ? 's' : ''}`
const floorVec = (p) => new Vec3(Math.floor(p.x), Math.floor(p.y + 0.01), Math.floor(p.z))
const ctr = (c) => new Vec3(c.x + 0.5, c.y, c.z + 0.5)
const k3 = (p) => `${p.x},${p.y},${p.z}`

class Pause extends Error {
  constructor(kind, reason, afterMs) { super(reason || kind); this.kind = kind; this.reason = reason; this.afterMs = afterMs }
}

module.exports = function createEngine({ bot, say, goals, tryGoto, safehand, stopNav = () => {}, canSee = null, config = baseConfig, state, save, deposit = null, dispatch = null,
  scheduler = null, owner = 'OGWO', waypoints = null, torches = null, stock = null, events = null, now = Date.now, log = () => {} }) {
  const L = { ...baseConfig.limits, ...(config.limits || {}) }
  const ORES = config.ores || baseConfig.ores
  const TC = { ...baseConfig.torches, ...(config.torches || {}) }
  const WC = { ...baseConfig.worksite, ...(config.worksite || {}) }
  const SC = { ...baseConfig.shaft, ...(config.shaft || {}) }
  const mover = makeMover({ bot, goals, tryGoto, safehand, stopNav })
  const sight = makeSight({ bot, canSee, config, log })
  const tools = makeTools({ bot, limits: L, log })
  let running = false
  let last = null
  const note = (msg) => { last = { at: now(), msg }; log(msg) }
  const skip = (why) => { state.stats.skipped[why] = (state.stats.skipped[why] || 0) + 1 }
  const tried = new Set(), skipItems = new Set()
  const have = (n) => bot.inventory.items().filter(i => i.name === n).reduce((s, i) => s + i.count, 0)
  const oreDef = () => ORES[state.job.ore]
  const oreSet = () => new Set(oreDef().blocks)
  const curMine = () => (state.mines || []).find(m => m.id === state.mineId) || null

  // ---------- the target ----------
  function begin(ore, amount) {
    const def = ORES[ore]
    state.job = { ore, amount, drop: def.drop, gained: 0, lastHave: have(def.drop), startedAt: new Date(now()).toISOString(), craftAsks: {}, navAsks: 0, said: 0, finished: false }
    state.active = true; state.pauseReason = null; state.auto = false; state.announced = false
    state.mineId = null                      // pick the mine again for this ore
    tried.clear(); skipItems.clear()
    save()
  }
  function refreshGained() {
    const j = state.job
    if (!j) return 0
    const h = have(j.drop), d = h - j.lastHave
    if (d > 0) j.gained += d
    j.lastHave = h
    return j.gained
  }
  const goalMet = () => !!state.job && refreshGained() >= state.job.amount

  // ---------- danger ----------
  function danger() {
    if (bot.health < L.minHealth) return `my health is ${Math.round(bot.health)}/20`
    const me = bot.entity.position
    for (const e of Object.values(bot.entities || {})) {
      if (!HOSTILE.test(e.name || '') || e.position.distanceTo(me) > L.hostileRadius) continue
      if (sight.see(e)) return `a ${e.name} is near`        // a mob behind rock is not a threat we can see
    }
    return null
  }
  function dangerCheck(ctx) {
    const d = danger()
    if (!d) { ctx.state.dangerRetries = 0; return }
    ctx.state.dangerRetries = (ctx.state.dangerRetries || 0) + 1
    if (ctx.state.dangerRetries === 1) say(`Pausing the mining: ${d}. I will carry on when it is clear.`)
    if (ctx.state.dangerRetries > L.dangerRetries) throw new Pause('park', `Pausing the mining: ${d}.`)
    throw new Pause('retry', null, L.dangerRetryMs)
  }

  // ---------- protected ground ----------
  const pad = (config.protect && config.protect.pad) || 0
  const boxes = ((config.protect && config.protect.boxes) || []).map(b => ({ min: b.min.map(v => v - pad), max: b.max.map(v => v + pad), label: b.label }))
  // the base is protected, except the ladder shaft's own column (below its top) and, if Walter chose a stair mine, below the shaft bottom
  const protectedAt = (p) => ((SC.enabled && (shaft.inColumn(p) || shaft.stairExempt(p))) ? null : baseProtected(p))
  const baseProtected = (p) => boxes.find(b => p.x >= b.min[0] && p.x <= b.max[0] && p.y >= b.min[1] && p.y <= b.max[1] && p.z >= b.min[2] && p.z <= b.max[2]) || null

  // ---------- movement ----------
  const canReach = (b) => (typeof bot.canDigBlock === 'function' ? bot.canDigBlock(b) : sight.eye().distanceTo(b.position.offset(0.5, 0.5, 0.5)) <= 4.5)
  async function moveTo(ctx, cell, ms = 15000) {
    try { bot.setControlState('sneak', false) } catch {}
    const r = await mover.goto(ctx, new goals.GoalBlock(cell.x, cell.y, cell.z), 'the hallway', ms)
    const d = bot.entity.position.distanceTo(ctr(cell))
    return d < 1.4 || !!(r && r.ok && d < 2)
  }
  async function ensureAt(ctx, cell) {
    const p = bot.entity.position
    if (Math.floor(p.x) === cell.x && Math.floor(p.z) === cell.z && Math.abs(p.y - cell.y) < 0.9) return true
    return moveTo(ctx, cell, 30000)
  }
  async function retreat(ctx, to) {
    try { await mover.goto(ctx, new goals.GoalBlock(to.x, to.y, to.z), 'back off', 20000) } catch (e) { if (e && e.name === 'AbortError') throw e }
  }

  // anything within one block of the bot's own cell is always in sight (a wall beside the ladder, the block ahead): no ray needed
  const adjacentToBot = (b) => { const c = floorVec(bot.entity.position), p = b.position; return Math.abs(p.x - c.x) <= 1 && Math.abs(p.z - c.z) <= 1 && p.y >= c.y - 1 && p.y <= c.y + 2 }
  const inSight = (b) => sight.see(b) || adjacentToBot(b) || !!(torches && torches.seeThroughLadders && torches.seeThroughLadders(b))
  // ---------- digging ----------
  async function digBlock(ctx, b) {
    if (!inSight(b)) return { ok: false, why: 'no-line-of-sight' }              // fail closed: no ray, no dig (a neighbouring block is always in sight)
    if (!canReach(b)) return { ok: false, why: 'out-of-reach' }
    if (!(await tools.equipFor(b))) return { ok: false, why: 'no-tool' }
    ctx.checkpoint()
    const fresh = sight.block(b.position)
    if (!fresh || fresh.name !== b.name) return { ok: false, why: 'changed' }
    if (!inSight(fresh)) return { ok: false, why: 'no-line-of-sight' }
    try { await bot.dig(fresh, true) } catch (e) { ctx.checkpoint(); log(`dig error ${k3(b.position)}: ${e.message}`); return { ok: false, why: 'dig-error' } }
    state.stats.dug++
    return { ok: true }
  }

  // Make `cell` passable: nothing to do if open, else dig it (natural filler only, never beside visible liquid). { ok } | { stop: why }
  async function clearCell(ctx, cell) {
    for (let i = 0; i < 14; i++) {                          // gravel and sand columns refill the cell as they fall: dig, wait, look again
      ctx.checkpoint()
      const b = sight.block(cell)
      if (!b) return { stop: 'unloaded' }
      if (sight.isLiquid(b)) return { stop: 'liquid' }
      if (sight.isOpen(b)) return { ok: true }
      if (sight.supportsLadder(cell)) return { stop: 'ladder-wall' }        // never the wall a ladder hangs on
      if (protectedAt(cell)) return { stop: 'protected' }
      if (!sight.isDiggable(b)) return { stop: `obstacle:${b.name}` }
      if (sight.liquidNear(sight.look().liquids, cell)) return { stop: 'liquid' }
      const r = await digBlock(ctx, b)
      if (!r.ok) return { stop: r.why }
      const up = sight.block(cell.offset(0, 1, 0))
      if (sight.isGravity(b) || (up && sight.isGravity(up) && sight.see(up))) await ctx.sleep(i < 4 ? 220 : 400)      // sand or gravel falls into the hole: wait, look again
    }
    return { stop: 'refilling' }
  }

  // Anything in view that says "get out": lava within 5 / water within 3 / liquid within 2 of the cell, or standing in liquid.
  function hazardAt(cell, lk = null) {
    const l = lk || sight.look()
    const here = sight.block(floorVec(bot.entity.position))
    if (here && sight.isLiquid(here)) return 'liquid'
    return sight.liquidNear(l.liquids, cell) ? 'liquid' : null
  }

  // ---------- ore in view ----------
  async function approach(ctx, b) {
    for (const f of los.viewpoints(bot, b.position, { reach: 4.2, max: 8 })) {
      ctx.checkpoint()
      if (f.x === b.position.x && f.z === b.position.z && f.y > b.position.y) continue     // never stand on an ore and dig down
      if (!sight.standOk(f).ok) continue
      if (!(await moveTo(ctx, f, 15000))) continue
      const fresh = sight.block(b.position)
      if (fresh && sight.see(fresh) && canReach(fresh)) return true
    }
    return false
  }
  async function mineOre(ctx, b, lk) {
    if (lk.liquids.some(l => sight.cheb(l.pos, b.position) <= 1)) { skip('ore-beside-liquid'); return { ok: false } }
    if (protectedAt(b.position)) { skip('protected'); return { ok: false } }
    if (sight.supportsLadder(b.position)) { skip('ladder-wall'); return { ok: false } }
    if (!tools.canHarvest(b)) { skip('tool-too-weak'); return { ok: false } }
    if (!canReach(b) || !sight.see(b)) {
      if (!(await approach(ctx, b))) { skip('unreachable'); return { ok: false } }
    }
    const fresh = sight.block(b.position)
    if (!fresh || fresh.name !== b.name) return { ok: false }
    const r = await digBlock(ctx, fresh)
    if (!r.ok) { skip(r.why); return { ok: false } }
    state.stats.ores++
    return { ok: true, hazard: !!hazardAt(floorVec(bot.entity.position)) }
  }
  // Mine every ore that is in view right now (and what the holes reveal), then pick up the drops. { ok } | { stop }
  async function harvest(ctx) {
    for (let i = 0; i < 40; i++) {
      ctx.checkpoint()
      if (goalMet()) break
      const lk = sight.look({ ores: state.job ? oreSet() : null })       // no job (leaving the mine): liquids only
      if (hazardAt(floorVec(bot.entity.position), lk)) return { stop: 'liquid' }
      const o = lk.ores.find(x => !tried.has(k3(x.block.position)))
      if (!o) break
      tried.add(k3(o.block.position))
      if (isFloor(o.block.position)) { floors.set(k3(o.block.position), o.block.position.clone()); continue }     // digging it would open a hole in a walkable floor: later, from the side
      const r = await mineOre(ctx, o.block, lk)
      if (r.hazard) return { stop: 'liquid' }
      if (r.ok) tried.delete(k3(o.block.position))
    }
    await collectDrops(ctx)
    return { ok: true }
  }
  // Ore that is the floor of a walkable cell: taking it out would leave a pit in the hallway we still walk (and means digging down), so
  // it is only taken once the hallway is finished with, standing beside it (never above it).
  const floors = new Map()
  function isFloor(p) {
    const a = sight.block(p.offset(0, 1, 0)), b = sight.block(p.offset(0, 2, 0))
    return !!a && !!b && sight.isOpen(a) && sight.isOpen(b)
  }
  async function mineFloors(ctx, { trunk = false } = {}) {
    const m = curMine()
    const onTrunk = (p) => !!m && p.y === m.y - 1 && ((m.dir[0] !== 0 && p.z === m.origin[2]) || (m.dir[1] !== 0 && p.x === m.origin[0]))
    const todo = [...floors.values()].filter(p => trunk || !onTrunk(p))
    for (const p of todo) {
      ctx.checkpoint()
      if (goalMet()) break
      floors.delete(k3(p))
      const b = sight.block(p)
      if (!b || !oreSet().has(b.name)) continue
      const lk = sight.look({ ores: state.job ? oreSet() : null })       // no job (leaving the mine): liquids only
      const r = await mineOre(ctx, b, lk)
      if (r.hazard) break
    }
    await collectDrops(ctx)
  }
  async function collectDrops(ctx) {
    for (let i = 0; i < 8; i++) {
      ctx.checkpoint()
      if (bot.inventory.emptySlotCount() < 2) return
      const me = bot.entity.position
      const item = Object.values(bot.entities || {}).filter(e => isItem(e) && !skipItems.has(e.id) && e.position.distanceTo(me) < 8 && e.position.distanceTo(me) > 1.2)
        .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0]
      if (!item) return
      skipItems.add(item.id)
      const cell = floorVec(item.position)
      if (!sight.see(item) || !sight.standOk(cell).ok) continue          // only what can be seen and stood on safely; never into the dark
      await mover.goto(ctx, new goals.GoalBlock(cell.x, cell.y, cell.z), 'a drop', 6000)
    }
    if (skipItems.size > 300) skipItems.clear()
  }
  const groundItems = () => { const me = bot.entity.position; return Object.values(bot.entities || {}).filter(e => isItem(e) && e.position.distanceTo(me) < L.itemRadius).length }

  // ---------- torches (Walter authorized torches, and only torches: placed on the floor of the cell the bot stands in, floor in view) ----------
  async function torchSupply(ctx) {
    const j = state.job
    if (!j) return false
    j.torchAsks = (j.torchAsks || 0) + 1
    if (j.torchAsks > TC.maxAsks || !dispatch) return false
    save()
    if (j.torchAsks === 1) say('Out of torches; making some first.')
    dispatch(owner, `craft ${TC.craftCount} torch`)
    const craftOn = () => { try { const st = scheduler.status(); return (st.running && st.running.name === 'craft') || st.queue.some(t => t.name === 'craft') } catch { return false } }
    if (craftOn()) await ctx.sleep(10 * 60000)
    return torches.count() > 0
  }
  async function lightCheck(ctx) {
    if (!torches || !TC.enabled) return
    state.sinceTorch = (state.sinceTorch || 0) + 1
    const feet = floorVec(bot.entity.position)
    const light = torches.lightOf(feet)
    const need = light === null ? state.sinceTorch >= TC.spacing : (light < TC.placeBelow && state.sinceTorch >= TC.minGap)
    if (!need) return
    if (torches.count() === 0 && !(await torchSupply(ctx))) return
    const r = await torches.place(ctx, sight.block(feet.offset(0, -1, 0)))
    state.sinceTorch = 0
    if (r.ok) { state.stats.torches = (state.stats.torches || 0) + 1; log(`torch at ${k3(r.at)}`) } else log(`no torch at ${k3(feet)}: ${r.why}`)
  }

  // ---------- one hallway cell ----------
  // The bot stands at `from`. Opens `to` (feet + head), checks what the opening reveals, steps in and mines what is in view. { ok } | { stop }
  async function extendOne(ctx, from, to, opts = {}) {
    if (!opts.intoLadder && (sight.isLadder(sight.block(to)) || sight.isLadder(sight.block(to.offset(0, 1, 0))))) return { stop: 'ladder-column' }      // a hallway never runs through the ladder
    logPos(`extending ${k3(from)} -> ${k3(to)}`)
    if (!(await ensureAt(ctx, from))) return { stop: 'unreachable' }
    const pre = hazardAt(from)
    if (pre) return { stop: pre }
    for (let round = 0; round < 3; round++) {               // falling sand or gravel can fill a cell again: look until both are open
      for (const c of [to, to.offset(0, 1, 0)]) { const r = await clearCell(ctx, c); if (r.stop) return r }
      if (sight.isOpen(sight.block(to)) && sight.isOpen(sight.block(to.offset(0, 1, 0)))) break
    }
    // sand/gravel above the new cells: take it down from here (it falls into the hole), clear the hole again, repeat until the ceiling is stable
    for (let g = 0; g < 10; g++) {
      const roofCell = to.offset(0, 2, 0), roof = sight.block(roofCell)
      if (!roof || !sight.isGravity(roof) || !sight.see(roof)) break
      const dr = await digBlock(ctx, roof)
      if (!dr.ok) break
      await ctx.sleep(300)
      for (const c of [to, to.offset(0, 1, 0)]) { const r = await clearCell(ctx, c); if (r.stop) return r }
    }
    const hz = hazardAt(to)
    if (hz) return { stop: hz }
    let st = sight.standOk(to)
    // The floor is missing and the drop under it is more than 2 (a ravine or cave below): never step there. Plug the opening with cobblestone so nothing walks into it or falls, and end this hallway here.
    if (!st.ok && st.why === 'no-floor' && sight.dropUnder(to) > 2) {
      const sealed = await seal(ctx, from, to)
      log(`void ahead at ${k3(to)} (drop ${sight.dropUnder(to)}): ${sealed ? 'plugged with cobblestone' : 'left open'}`)
      return { stop: 'void' }
    }
    if (!st.ok && st.why === 'no-floor' && torches && torches.placeSupport) {            // a hole in the floor: bridge it with cobblestone from here (Walter allowed patching), then look again
      let under = sight.block(from.offset(0, -1, 0))
      const ladderHere = sight.block(from)
      if ((!under || !sight.isSolid(under)) && sight.isLadder(ladderHere)) {         // the ladder itself hangs over the cave: a block under it first
        const inf = shaft.ladderInfo(ladderHere)
        if (inf) { await shaft.supportUnder(ctx, inf.back, inf.face); under = sight.block(from.offset(0, -1, 0)) }
      }
      const face = new Vec3(to.x - from.x, 0, to.z - from.z)
      if (under && sight.isSolid(under)) { const pr = await torches.placeSupport(ctx, under, face); log(`floor patch at ${k3(to.offset(0, -1, 0))}: ${pr.ok ? 'placed' : pr.why}`); if (pr.ok) { state.stats.support = (state.stats.support || 0) + 1; st = sight.standOk(to) } }
    }
    if (!st.ok) return { stop: `floor:${st.why}` }
    if (!(await moveTo(ctx, to))) return { stop: 'stuck' }
    await lightCheck(ctx)
    return harvest(ctx)
  }

  // Close the hole a dig has just opened into a void: cobblestone into the feet cell and the head cell of `to`, placed from `from` against a solid neighbour of that cell (ray required).
  async function seal(ctx, from, to) {
    if (!torches || !torches.placeSupport) return false
    const dir = [to.x - from.x, to.z - from.z], left = G.leftOf(dir), right = G.rightOf(dir)
    let done = 0
    for (const c of [to, to.offset(0, 1, 0)]) {
      const here = sight.block(c)
      if (!here || !sight.isOpen(here)) { done++; continue }
      const refs = [[c.offset(left[0], 0, left[1]), left], [c.offset(right[0], 0, right[1]), right], [c.offset(0, 1, 0), [0, -1]], [c.offset(dir[0], 0, dir[1]), dir]]
      for (const [rp, fromRef] of refs) {
        const ref = sight.block(rp)
        if (!ref || !sight.isSolid(ref)) continue
        const face = Array.isArray(fromRef) && fromRef.length === 2 && rp.y === c.y ? new Vec3(-fromRef[0], 0, -fromRef[1]) : new Vec3(0, -1, 0)
        const r = await torches.placeSupport(ctx, ref, face)
        if (r.ok) { done++; state.stats.support = (state.stats.support || 0) + 1; break }
      }
    }
    return done === 2
  }

  // ---------- stairs (never straight down) ----------
  async function stairs(ctx, targetY, prefer) {
    let dir = prefer || G.CARDINALS[0], turns = 0
    for (let guard = 0; guard < 600; guard++) {
      ctx.checkpoint(); dangerCheck(ctx)
      const feet = floorVec(bot.entity.position)
      if (feet.y === targetY) return true
      if (goalMet()) return true
      await makeRoom(ctx); await ensureSupplies(ctx)
      const vdir = targetY < feet.y ? -1 : 1
      const step = G.stairStep(feet, dir, vdir)
      let blocked = null
      for (const c of step.dig) { const r = await clearCell(ctx, c); if (r.stop) { blocked = r.stop; break } }
      if (!blocked) { const st = sight.standOk(step.land); if (!st.ok) blocked = `floor:${st.why}` }
      if (!blocked) blocked = hazardAt(step.land)
      if (blocked) {
        if (blocked === 'protected') throw new Pause('park', 'The stairs would run into Walter\'s base area; I will not dig there. Walk me somewhere else (go to <place>) and say mine again.')
        if (++turns > L.maxStairTurns) throw new Pause('park', `The stairs are blocked (${blocked}). Tell me where to dig down, or say "go to <waypoint>" and mine again.`)
        note(`stairs blocked (${blocked}); turning`)
        dir = G.rightOf(dir)
        continue
      }
      if (!(await moveTo(ctx, step.land))) throw new Pause('park', 'I got stuck on my own stairs. Stopping the mining.')
      await lightCheck(ctx)
      const h = await harvest(ctx)
      if (h.stop) { blocked = h.stop; if (++turns > L.maxStairTurns) throw new Pause('park', `Liquid in view on the way down. Stopping the mining.`); dir = G.rightOf(dir) }
    }
    throw new Pause('park', 'The stairs are taking too long; stopping.')
  }

  // First direction with natural rock in view straight ahead (feet and head)
  // A wall the hallway can start in: anything diggable that is in view, gravel, sand, dirt and the like included (the ladder panels of a shaft do not count as in the way).
  // `why` (optional array) collects what was seen per direction, for the log and the park message.
  function pickDir(feet, prefer = null, { why = null, only = null } = {}) {
    const order = (prefer ? [prefer, ...G.CARDINALS.filter(d => d[0] !== prefer[0] || d[1] !== prefer[1])] : G.CARDINALS).filter(d => !only || only.some(o => o[0] === d[0] && o[1] === d[1]))
    const vis = (b) => inSight(b)
    for (const d of order) {
      const a = sight.block(feet.offset(d[0], 0, d[1])), b = sight.block(feet.offset(d[0], 1, d[1]))
      const ok = !!(a && b && sight.isDiggable(a) && sight.isDiggable(b) && vis(a) && vis(b))
      if (why) why.push(`${d[0]},${d[1]}: ${a ? a.name : 'unloaded'}${a && !vis(a) ? '(not in view)' : ''} / ${b ? b.name : 'unloaded'}${b && !vis(b) ? '(not in view)' : ''}`)
      if (ok) return d
    }
    return null
  }
  // Number of walkable hallway cells ahead (open feet+head, solid floor in view), up to max
  function openRun(feet, d, max = 48) {
    let n = 0
    for (let k = 1; k <= max; k++) {
      const c = feet.offset(d[0] * k, 0, d[1] * k)
      const f = sight.block(c), h = sight.block(c.offset(0, 1, 0)), fl = sight.block(c.offset(0, -1, 0))
      if (!f || !h || !fl || !sight.isOpen(f) || !sight.isOpen(h) || !sight.isSolid(fl) || !sight.see(fl)) break
      n = k
    }
    return n
  }

  // ---------- choosing / making the mine ----------
  const inRange = (y, def) => y >= def.range[0] && y <= def.range[1]
  function register(mine) {
    state.mines = state.mines || []
    mine.id = `m${(state.mineSeq = (state.mineSeq || 0) + 1)}`
    state.mines.push(mine)
    state.mineId = mine.id
    return mine
  }
  function recordWaypoint(mine) {
    if (!waypoints || config.recordWaypoint === false) return
    try {
      const name = waypoints.add(`mine ${mine.ore}`, { x: mine.origin[0], y: mine.origin[1], z: mine.origin[2] })
      if (name) mine.name = name
    } catch (e) { log('waypoint: ' + e.message) }
  }

  async function startNew(ctx, prefer = null, reason = '') {
    const def = oreDef()
    let feet = floorVec(bot.entity.position)
    const box = protectedAt(feet)
    if (box) throw new Pause('park', `I am inside ${box.label || 'a protected area'}, so I will not dig a new mine here. Send me somewhere with natural rock (go to <place>), or set a waypoint called "mine ${state.job.ore}" where I should start, then say mine again.`)
    const targetY = inRange(feet.y, def) ? feet.y : def.y
    let dir = prefer
    if (feet.y !== targetY) {
      say(`Digging stairs down to y${targetY} for ${state.job.ore}; no straight drops.`)
      dir = await stairsDir(ctx, targetY)
      feet = floorVec(bot.entity.position)
    }
    ctx.checkpoint()
    const d = pickDir(feet, dir)
    if (!d) throw new Pause('park', 'I see no solid rock ahead to start a mine in (open cave or water around). Move me to a rock wall and say mine again.')
    const mine = register(G.newMine({ origin: [feet.x, feet.y, feet.z], dir: d, y: feet.y, spacing: baseConfig.pattern.spacing, trunkLen: (config.pattern || baseConfig.pattern).trunkLength, branchLen: (config.pattern || baseConfig.pattern).branchLength, ore: state.job.ore, now: now() }))
    recordWaypoint(mine)
    save()
    say(`Starting a strip mine for ${state.job.ore} at y${mine.y}${mine.name ? ` ("${mine.name}")` : ''}: 1x2 hallways, branches every 3 blocks.${reason}`.slice(0, 230))
    note(`NEW MINE ${mine.id} at ${k3(feet)} dir ${mine.dir}`)
    return mine
  }
  // ladder shaft -> ladders down to the ore's depth -> the strip starts there (or, on Walter's word, a stair mine from the shaft bottom)
  async function useShaft(ctx) {
    const def = oreDef(), a = shaft.A()
    const t = shaft.top()
    // already on the shaft's ladders (resuming deep down): carry on from here, not back up to the top
    if (!shaft.onLadder() && !(await travel(ctx, { x: t.x, y: t.y, z: t.z }, { exact: true, name: SC.waypoint }))) throw new Pause('park', 'I could not get to the ladder shaft (say "go to ladder shaft" if you can send me).')
    const bo = shaft.bottom()
    if (!bo) throw new Pause('park', `I see no ladder at the shaft top (${SC.top.join(',')}). Tell me where the shaft is.`)
    if (a.approval === 'stairs') {
      await shaft.descend(ctx, bo.y, { extend: false })                 // down the ladders that exist ...
      a.stairsFrom = floorVec(bot.entity.position).y
      save()
      say('Stair mine from the bottom of the shaft, as you said.')
      return startNew(ctx)                                               // ... then stairs, the base protection lifted below the shaft bottom
    }
    // Walter ("for now, set up an iron mine at the ladder's current terminating point"): when the bottom of the existing ladders is already inside the ore's depth band, mine there, no extension
    const targetY = (SC.preferExistingBottom && inRange(bo.y, def)) ? bo.y : def.y
    const need = Math.max(0, bo.y - targetY)
    log(`shaft: top ${SC.top.join(',')}, lowest ladder y${bo.y}, ore ${state.job.ore} wants y${def.y} (band ${def.range.join('..')}); mining level y${targetY}, ${need} ladders to add, bag has ${shaft.count('ladder')}`)
    await shaft.supply(ctx, need)
    if (need > 0) say(`Extending the ladder from y${bo.y} down to y${targetY} (${need} ladders), then a strip mine for ${state.job.ore} off the shaft.`)
    else say(`The ladder already reaches y${bo.y}, which is good for ${state.job.ore}: down the ladder and a strip mine off it.`.slice(0, 200))
    let face, fallback = null
    try { ({ face } = await shaft.descend(ctx, targetY)) }
    catch (e) {
      // The shaft broke into a cave (or its floor/wall is missing) before the ore's depth. Iron etc. is plentiful across a whole band: if the bot is already in it,
      // start the strip here; otherwise stairs from here. Water, lava and the like still stop the job.
      const kind = e && e.shaftKind, at = floorVec(bot.entity.position)
      if (!(e instanceof Pause) || !['cave', 'void', 'wall', 'ladder'].includes(kind) || at.y >= bo.y) throw e
      const info = shaft.ladderInfo(sight.block(at))
      if (!info) throw e
      if (inRange(at.y, def)) { face = info.face; fallback = 'strip' }
      else {
        a.approval = 'stairs'; a.stairsFrom = at.y; save()
        say(`The shaft stopped at y${at.y} (${(e.reason || '').split('.')[0]}). Stairs from here down to y${def.y}.`.slice(0, 220))
        return startNew(ctx)
      }
      note(`shaft stopped at y${at.y} (${kind}); iron band reached, starting the strip here`)
    }
    let feet = floorVec(bot.entity.position)
    const info = shaft.ladderInfo(sight.block(feet)) || { face, back: new Vec3(-face.x, 0, -face.z) }
    await shaft.supportUnder(ctx, info.back, info.face)                  // a gap under the lowest ladder gets a block (Walter allowed it)
    // Mines are messy: try the side away from the ladder's wall first, then the other sides, the wall side last. Whatever is there gets dug (gravel, dirt, sand, planks ...),
    // a missing floor is bridged, open ground is walked. Only lava/water and unbreakable blocks stop a side; the first side that works becomes the trunk.
    { const me = bot.entity.position; const far = Object.values(bot.entities || {}).find(e => HOSTILE.test(e.name || '') && e.position.distanceTo(me) < 16 && sight.see(e)); if (far && !ctx.state.startWaited) { ctx.state.startWaited = true; say(`A ${far.name} is in view at the bottom of the shaft; waiting before I start the hallway.`); throw new Pause('retry', null, 15000) } }
    const fv = [face.x, face.z]
    const base4 = [fv, G.leftOf(fv), G.rightOf(fv)]                                // never the wall the ladder hangs on (it would take the ladder with it)
    const tried = []
    let dir = null
    const feet0 = feet
    for (let lvl = 0; lvl <= (SC.maxRungs ?? 8) && !dir; lvl++) {                  // nothing works at this level: try the rung above (up to maxRungs)
      if (lvl > 0) {
        const up = sight.block(feet0.offset(0, lvl, 0))
        if (!up || !sight.isLadder(up)) break
        try { await exit.climbTo(ctx, feet0.y + lvl) } catch (e) { if (e && e.name === 'AbortError') throw e; break }
        tried.push(`-> rung y${feet0.y + lvl}`)
      }
      feet = floorVec(bot.entity.position)
      // rock that can be dug first (it has walls to mine), open cave ground second, the rest last; the order above breaks ties
      const rank = (d) => { const a0 = sight.block(feet.offset(d[0], 0, d[1])), b0 = sight.block(feet.offset(d[0], 1, d[1])); if (!a0 || !b0) return 3; if (sight.isDiggable(a0) && sight.isDiggable(b0)) return 0; if (sight.isOpen(a0) && sight.isOpen(b0)) return 1; if ((sight.isOpen(a0) || sight.isDiggable(a0)) && (sight.isOpen(b0) || sight.isDiggable(b0))) return 1; return 2 }
      const cands = base4.map((d, i) => ({ d, i, r: rank(d) })).sort((x, y) => x.r - y.r || x.i - y.i).map(x => x.d)
      for (const d of cands) {
        ctx.checkpoint()
        const to = feet.offset(d[0], 0, d[1])
        const here = floorVec(bot.entity.position)
        if (here.x !== feet.x || here.z !== feet.z || here.y !== feet.y) await ensureAt(ctx, feet)
        if (sight.isLadder(sight.block(feet))) { try { bot.setControlState('sneak', true) } catch {} }      // hold the rung while digging from it
        const a0 = sight.block(to), b0 = sight.block(to.offset(0, 1, 0))
        const names = `y${feet.y} ${d[0]},${d[1]}: ${a0 ? a0.name : 'unloaded'} / ${b0 ? b0.name : 'unloaded'}`
        const r = await extendOne(ctx, feet, to)
        tried.push(`${names} -> ${r.ok ? 'ok' : r.stop}`)
        if (r.ok) { dir = d; break }
        if (r.stop === 'liquid') break                                            // safety is the one thing that ends it
      }
      if (tried.length && /liquid$/.test(tried[tried.length - 1])) break
    }
    log(`shaft start at ${k3(feet)}: ${tried.join(' | ')}`)
    if (!dir) throw new Pause('park', `I am in the shaft at y${feet.y} and could not start a hallway on any side (${tried.join('; ')}).`.slice(0, 230))
    const mine = register(G.newMine({ origin: [feet.x, feet.y, feet.z], dir, y: feet.y, spacing: baseConfig.pattern.spacing, trunkLen: (config.pattern || baseConfig.pattern).trunkLength, branchLen: (config.pattern || baseConfig.pattern).branchLength, ore: state.job.ore, now: now() }))
    mine.shaft = true
    mine.trunk = 1; mine.frontier = [feet.x + dir[0], feet.y, feet.z + dir[1]]          // the first cell is already open and walked
    for (const side of ['L', 'R']) { const sv = G.sideVec(dir, side); if (sv[0] === info.back.x && sv[1] === info.back.z) mine.branches[G.keyOf(0, side)] = { len: 0, done: true, why: 'ladder wall' } }      // the branch into the wall the ladder hangs on stays closed
    recordWaypoint(mine)
    save()
    say(`Starting a strip mine for ${state.job.ore} at y${mine.y} off the ladder shaft${fallback ? ' (the shaft opened into a cave here)' : ''}${mine.name ? ` ("${mine.name}")` : ''}.`.slice(0, 230))
    note(`SHAFT MINE ${mine.id} at ${k3(feet)} dir ${mine.dir}`)
    return mine
  }
  async function stairsDir(ctx, targetY) {
    const start = G.CARDINALS[0]
    let lastDir = start
    // stairs() keeps its own direction; read the heading from the last two positions afterwards
    const before = floorVec(bot.entity.position)
    await stairs(ctx, targetY, start)
    const after = floorVec(bot.entity.position)
    const dx = Math.sign(after.x - before.x), dz = Math.sign(after.z - before.z)
    lastDir = Math.abs(dx) >= Math.abs(dz) && dx !== 0 ? [dx, 0] : (dz !== 0 ? [0, dz] : start)
    return lastDir
  }

  // Follow an existing hallway to its end (mining what is in view on the way), then start our pattern from there.
  async function adopt(ctx, wp) {
    const def = oreDef()
    let feet = floorVec(bot.entity.position)
    if (!inRange(feet.y, def) && (wp.y == null || !inRange(wp.y, def))) { await stairsDir(ctx, def.y); feet = floorVec(bot.entity.position) }
    let best = null, bestN = 0
    for (const d of G.CARDINALS) { const n = openRun(feet, d); if (n > bestN) { bestN = n; best = d } }
    let cur = feet
    if (best && bestN >= 2) {
      for (let k = 1; k <= bestN; k++) {
        const to = cur.offset(best[0], 0, best[1])
        const r = await extendOne(ctx, cur, to)
        if (!r.ok) break
        cur = to
      }
    }
    const d = best && bestN >= 2 ? best : pickDir(cur)
    if (!d) throw new Pause('park', `I reached ${wp.name} but see no hallway or rock wall to mine from. Tell me where to dig.`)
    const mine = register(G.newMine({ origin: [cur.x, cur.y, cur.z], dir: d, y: cur.y, spacing: baseConfig.pattern.spacing, trunkLen: (config.pattern || baseConfig.pattern).trunkLength, branchLen: (config.pattern || baseConfig.pattern).branchLength, ore: state.job.ore, name: wp.name, now: now() }))
    save()
    note(`ADOPTED ${wp.name} -> ${mine.id} at ${k3(cur)} dir ${mine.dir}`)
    return mine
  }

  // Is there a mine to go to for this ore (own unfinished strip at a fitting depth, or a fitting "mine ..." waypoint)? Used by the idle routine.
  function knownMineFor(ore) {
    const def = ORES[ore]
    if ((state.mines || []).some(m => m.dim === 'overworld' && G.nextSegment(m) && m.y >= def.range[0] - 6 && m.y <= def.range[1] + 6)) return true
    try { return (waypoints ? waypoints.list() : []).some(w => fit(w, ore, def) > 0) } catch { return false }
  }
  async function selectMine(ctx) {
    const def = oreDef(), here = bot.entity.position
    const hd = (x, z) => Math.hypot(here.x - x, here.z - z)
    // 1. a mine of ours that still has hallways to dig at a fitting depth
    const own = (state.mines || []).filter(m => m.dim === 'overworld' && G.nextSegment(m) && m.y >= def.range[0] - 6 && m.y <= def.range[1] + 6)
      .sort((a, b) => hd(a.origin[0], a.origin[2]) - hd(b.origin[0], b.origin[2]))[0]
    if (own) {
      state.mineId = own.id; save()
      say(`Going back to my ${own.name || 'mine'} at ${own.origin.join(',')} to dig more hallways.`.slice(0, 200))
      return own
    }
    // 2. Walter's "mine ..." waypoints (or one we recorded earlier), best fit first
    const known = (state.mines || []).filter(m => G.nextSegment(m))
    let wps = []
    try { wps = (waypoints ? waypoints.list() : []) } catch (e) { log('waypoints: ' + e.message) }
    const scored = wps.map(w => ({ w, f: fit(w, state.job.ore, def), d: hd(w.x, w.z) })).filter(s => s.f > 0 && !known.some(m => Math.hypot(m.origin[0] - s.w.x, m.origin[2] - s.w.z) < 6))
      .sort((a, b) => b.f - a.f || a.d - b.d)
    if (scored.length) {
      const wp = scored[0].w
      say(`Heading to the "${wp.name}" waypoint to mine ${state.job.ore} along its hallways.`.slice(0, 200))
      const inShaftColumn = SC.enabled && SC.top && Math.floor(wp.x) === SC.top[0] && Math.floor(wp.z) === SC.top[2] && typeof wp.y === 'number' && wp.y < SC.top[1]
      if (inShaftColumn) { await shaft.descend(ctx, wp.y, { extend: false }); return adopt(ctx, wp) }       // the waypoint is on the shaft's ladders: slide down to it
      if (!(await travel(ctx, wp, { name: wp.name }))) throw new Pause('park', `I could not get to "${wp.name}". Say "go to ${wp.name}" yourself or tell me where to mine.`)
      return adopt(ctx, wp)
    }
    // 3. nothing known: Walter's ladder shaft is the entry when the ore lies below it (new mines may not start inside the base), else our own stairs
    if (SC.enabled && SC.top && def.y < SC.top[1] && hd(SC.top[0], SC.top[2]) <= SC.useWithin) return useShaft(ctx)
    return startNew(ctx)
  }

  // Walk (or ask the nav module for long trips) to a position. true when there.
  async function travel(ctx, target, { name, exact = false } = {}) {
    const j = state.job
    // a mine's depth matters: 112 blocks down a shaft is not "near" the entrance; relaxed = the exact cell could not be reached, close enough
    const near = (relaxed = false) => { const p = bot.entity.position; return Math.hypot(p.x - target.x, p.z - target.z) < (exact ? 1.5 : 6) && (target.y == null || Math.abs(p.y - target.y) < (relaxed ? 8 : 0.9)) }
    if (near()) return true
    const p = bot.entity.position, d = Math.hypot(p.x - target.x, p.z - target.z)
    if (d > L.walkMax && dispatch && name) {
      if ((j.navAsks || 0) >= 2) return false
      j.navAsks = (j.navAsks || 0) + 1; save()
      const handled = dispatch(owner, `go to ${name}`)
      const navOn = () => { try { const s = scheduler.status(); return (s.running && s.running.name === 'nav') || s.queue.some(t => t.name === 'nav') } catch { return false } }
      if (handled && navOn()) await ctx.sleep(10 * 60000)            // the nav task preempts us; we carry on from the top when it is done
      if (near()) { j.navAsks = 0; return true }
      return false
    }
    const hops = async () => {
    for (let hop = 0; hop < 5 && !near(); hop++) {
      const goal = exact ? new goals.GoalBlock(Math.floor(target.x), target.y, Math.floor(target.z)) : (target.y == null ? new goals.GoalNear(target.x, bot.entity.position.y, target.z, 3) : new goals.GoalNear(target.x, target.y, target.z, 1))
      const r = await mover.goto(ctx, goal, name || 'the mine', 90000)
      if (!r.ok && !near()) break
      if (!exact && target.y != null && near(true) && !near()) {          // close by but not at the right depth (a ladder shaft): the exact cell
        const e = await mover.goto(ctx, new goals.GoalBlock(Math.floor(target.x), target.y, Math.floor(target.z)), name || 'the mine', 90000)
        if (!e.ok) break
      }
    }
    }
    await hops()
    // the direct walk did not get there (a long way round through the base, a stuck spot): hand the trip to the nav module ("go to <waypoint>": doors, ladders, stuck recovery), then the last few blocks ourselves
    if (!near() && !(!exact && near(true)) && dispatch && name && (j.navAsks || 0) < 2) {
      j.navAsks = (j.navAsks || 0) + 1; save()
      const handled = dispatch(owner, `go to ${name}`)
      const navOn = () => { try { const st = scheduler.status(); return (st.running && st.running.name === 'nav') || st.queue.some(t => t.name === 'nav') } catch { return false } }
      if (handled && navOn()) await ctx.sleep(10 * 60000)
      await hops()
    }
    if (near() || (!exact && near(true))) { j.navAsks = 0; return true }
    return false
  }
  async function returnToMine(ctx) {
    const m = curMine()
    const f = new Vec3(m.frontier[0], m.frontier[1], m.frontier[2])
    const p = bot.entity.position
    if (Math.hypot(p.x - f.x, p.z - f.z) < 40 && Math.abs(p.y - f.y) < 6) return true     // in the mine (the segment walks to its own cell)
    if (m.shaft && SC.enabled && SC.top) {                                                // a shaft mine: down the shaft's ladders (no keys pressed), not a pathfinder search
      note(`back to the shaft mine at ${k3(f)}: down the ladder`)
      await shaft.descend(ctx, m.y, { extend: false })
      if (Math.abs(bot.entity.position.y - m.y) < 1.5) return true
    }
    note(`walking back to the mine at ${k3(f)}`)
    return travel(ctx, { x: f.x, y: f.y, z: f.z }, { name: m.name || null })
  }

  // ---------- supplies ----------
  async function stashJunk(ctx) {
    const chests = config.storageChests || []
    if (!chests.length) return
    const junk = new Set(config.junk || baseConfig.junk)
    for (const c of chests) {
      ctx.checkpoint()
      if (bot.inventory.emptySlotCount() > L.fullSlots) return
      const pos = new Vec3(c[0], c[1], c[2])
      if (!(await mover.near(ctx, pos, 3, 'a storage chest'))) continue
      const blk = sight.block(pos)
      if (!blk || !/chest|barrel/.test(blk.name) || !sight.see(blk)) continue
      let win
      try {
        win = await bot.openContainer(blk)
        for (const it of bot.inventory.items().filter(i => junk.has(i.name))) { try { await win.deposit(it.type, null, it.count) } catch (e) { log(`stash ${it.name}: ${e.message}`) } }
      } catch (e) { log('storage chest: ' + e.message) } finally { try { win && win.close() } catch {} }
    }
  }
  async function makeRoom(ctx) {
    if (bot.inventory.emptySlotCount() > L.fullSlots) return
    refreshGained()
    // Walter's time economy: far from the final chests, put the haul in a work-site chest here and carry it once at the end
    if (WC.enabled && torches && curMine() && state.job && !state.job.worksiteOff && worksite.far()) {
      await worksite.fill(ctx)
      if (worksite.nearlyFull()) await worksite.haul(ctx, { final: false })
      if (bot.inventory.emptySlotCount() > L.fullSlots) return
    }
    if (deposit) {
      const r = await deposit({ ctx, quiet: true })
      refreshGained()
      if (r && r.full) throw new Pause('park', 'The furnace input chests are full or out of reach, so I cannot unload the ore. Empty them or tell me where to put things.')
    }
    if (bot.inventory.emptySlotCount() > L.minFreeSlots) return
    await stashJunk(ctx)
    if (bot.inventory.emptySlotCount() > L.minFreeSlots) return
    throw new Pause('park', 'My inventory is nearly full of things the furnace chests do not take (dirt, gravel, stone types). I will not leave a pile; tell me where to put them (set storageChests) or empty me.')
  }
  async function ensureSupplies(ctx) {
    const sh = tools.shortage(oreDef())
    const j = state.job
    if (!sh) { j.craftAsks = {}; return }
    j.craftAsks = j.craftAsks || {}
    j.craftAsks[sh.item] = (j.craftAsks[sh.item] || 0) + 1
    save()
    if (j.craftAsks[sh.item] > L.maxCraftAsks || !dispatch) throw new Pause('park', `${cap(sh.why)} and I could not make a ${pretty(sh.item)} (crafting table, cobblestone/iron and sticks or planks needed). Give me one, or say "craft ${pretty(sh.item)}", then "resume mining".`)
    say(`${cap(sh.why)}; making a ${pretty(sh.item)} first.`)
    dispatch(owner, `craft ${pretty(sh.item)}`)
    const craftOn = () => { try { const s = scheduler.status(); return (s.running && s.running.name === 'craft') || s.queue.some(t => t.name === 'craft') } catch { return false } }
    if (craftOn()) await ctx.sleep(10 * 60000)                 // the craft task preempts us; we resume from the saved progress afterwards
    else if (tools.shortage(oreDef())) throw new Pause('park', `${cap(sh.why)} and the crafting module did not start on a ${pretty(sh.item)} (see its message). Give me one, or say "craft ${pretty(sh.item)}", then "resume mining".`)
  }

  // ---------- segments ----------
  // where the bot is, at least every 5 s while mining (so a live failure shows the path it took)
  let lastPosLog = 0
  function logPos(what = '') {
    const t = now()
    if (t - lastPosLog < 5000) return
    lastPosLog = t
    const p = bot.entity.position, m = curMine(), j = state.job
    log(`pos ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} hp ${Math.round(bot.health)} food ${Math.round(bot.food || 0)} ${j ? `${j.gained}/${j.amount} ${j.ore}` : ''} ${m ? `mine y${m.y} trunk ${m.trunk}` : ''} ${what}`.trim())
  }
  async function between(ctx) {
    ctx.checkpoint()
    logPos()
    dangerCheck(ctx)
    if (groundItems() > L.maxGroundItems) {
      await collectDrops(ctx)
      if (groundItems() > L.maxGroundItems) throw new Pause('park', `Pausing: ${groundItems()} items are lying around me and I cannot pick them up (inventory nearly full?). I will not leave a pile.`)
    }
    await makeRoom(ctx)
    await ensureSupplies(ctx)
  }
  function report() {
    const j = state.job, q = Math.floor(4 * j.gained / j.amount)
    if (j.amount >= 8 && q > j.said && j.gained < j.amount) { j.said = q; say(`Mining ${j.ore}: ${j.gained}/${j.amount}.`) }
  }
  const rec = (m, t, side) => (m.branches[G.keyOf(t, side)] = m.branches[G.keyOf(t, side)] || { len: 0, done: false })

  async function runSegment(ctx, seg) {
    const mine = curMine()
    const setFrontier = (c) => { mine.frontier = [c.x, c.y, c.z] }
    if (seg.type === 'trunk') {
      let prev = G.trunkCell(mine, seg.from)
      for (let t = seg.from + 1; t <= seg.to; t++) {
        const to = G.trunkCell(mine, t)
        const r = await extendOne(ctx, prev, to)
        if (!r.ok) {
          mine.trunkLen = mine.trunk; mine.endedWhy = r.stop; save()
          note(`trunk ends at ${mine.trunk}: ${r.stop}`)
          if (r.stop === 'liquid') await retreat(ctx, G.trunkCell(mine, Math.max(0, mine.trunk - 3)))
          return
        }
        mine.trunk = t; prev = to; setFrontier(to); save()
        ctx.progress(`${state.job.gained}/${state.job.amount} ${state.job.ore}`)
        report()
        if (goalMet()) return
        await between(ctx)
      }
      return
    }
    const r0 = rec(mine, seg.t, seg.side)
    const j = G.trunkCell(mine, seg.t)
    let prev = r0.len ? G.branchCell(mine, seg.t, seg.side, r0.len) : j
    if (!(await ensureAt(ctx, prev))) { r0.done = true; r0.why = 'unreachable'; save(); return }
    for (let k = r0.len + 1; k <= mine.branchLen; k++) {
      const to = G.branchCell(mine, seg.t, seg.side, k)
      const r = await extendOne(ctx, prev, to)
      if (!r.ok) {
        r0.done = true; r0.why = r.stop; save()
        note(`branch ${G.keyOf(seg.t, seg.side)} ends at ${r0.len}: ${r.stop}`)
        if (r.stop === 'liquid') await retreat(ctx, j)
        else await mineFloors(ctx)
        return
      }
      r0.len = k; prev = to; setFrontier(to); save()
      ctx.progress(`${state.job.gained}/${state.job.amount} ${state.job.ore}`)
      report()
      if (goalMet()) return
      await between(ctx)
    }
    r0.done = true; r0.why = 'full'; save()
    await mineFloors(ctx)
  }

  // ---------- the job ----------
  // Finish a haul on its own (after a stopped job or a restart): the ledger in the state file says where the chest is.
  async function haulOnly(ctx) {
    if (running) return { status: 'done' }
    running = true
    try {
      if (!state.worksite) { say('There is no work-site chest to haul.'); return { status: 'done' } }
      await safehand.stow()
      const ok = await worksite.haul(ctx, { final: true })
      if (!ok && state.worksite) say(`I could not finish the haul from the work-site chest at ${state.worksite.pos.join(',')}.`.slice(0, 200))
      return { status: 'done' }
    } catch (e) {
      if (e && e.name === 'AbortError') throw e
      if (e instanceof Pause) return park(e.reason)
      log(`ERROR ${e && e.stack || e}`); say(`The haul stopped: ${e && e.message}`.slice(0, 180)); return park(`error: ${e && e.message}`, true)
    } finally { running = false; save() }
  }
  function statusLine() {
    const j = state.job
    if (!j) return 'I am not mining. Say "mine diamonds 5" (or iron, coal, gold, redstone, lapis, copper).'
    const m = curMine()
    const prog = `${j.gained}/${j.amount} ${pretty(j.drop)}`
    const ws = state.worksite ? ` Work-site chest at ${state.worksite.pos.join(',')}: ${state.worksite.slots}/${state.worksite.cap} slots.` : ''
    const where = m ? `strip at y${m.y}: ${G.doneCells(m)}/${G.plannedCells(m)} hallway cells, ${state.stats.ores} ore blocks mined` : 'looking for a place to mine'
    if (j.finished) return `Finished: ${prog}. ${where}.${ws}`
    if (running) return `Mining ${j.ore}: ${prog}; ${where}.${ws}`
    if (state.pauseReason) return `Mining paused at ${prog}: ${state.pauseReason} Say "resume mining" to continue.${ws}`
    return `Mining ${j.ore} is queued/idle at ${prog}; ${where}.${ws}`
  }
  function snapshot() {
    const j = state.job, m = curMine()
    return {
      running, active: !!state.active, ore: j && j.ore, gained: j && j.gained, amount: j && j.amount, finished: !!(j && j.finished), pauseReason: state.pauseReason,
      mine: m && { id: m.id, name: m.name, y: m.y, dir: m.dir, trunk: m.trunk, cells: `${G.doneCells(m)}/${G.plannedCells(m)}`, origin: m.origin },
      mines: (state.mines || []).length, stats: { dug: state.stats.dug, ores: state.stats.ores, torches: state.stats.torches || 0, skipped: { ...state.stats.skipped } },
      last: last && { agoS: Math.round((now() - last.at) / 1000), msg: last.msg }
    }
  }

  async function job(ctx) {
    const j = state.job
    if (!j) return { status: 'done' }
    if (String((bot.game && bot.game.dimension) || 'overworld').replace('minecraft:', '') !== 'overworld') throw new Pause('park', 'I only strip mine in the overworld.')
    await safehand.stow()
    if (!sight.available()) throw new Pause('park', 'I cannot check what I can see (no raycast), so I will not dig.')
    state.active = true; state.pauseReason = null; j.finished = false; save()
    if (!ctx.resumed && !state.announced) { say(`OK, mining ${things(j.drop, j.amount)}. I only dig what I can see.`); state.announced = true }
    ctx.progress(`${j.gained}/${j.amount} ${j.ore}`)
    let idle = 0
    while (true) {
      ctx.checkpoint()
      dangerCheck(ctx)
      if (goalMet()) break
      await between(ctx)
      if (!curMine()) { await selectMine(ctx); continue }
      if (!(await returnToMine(ctx))) throw new Pause('park', 'I could not get back to the mine. Tell me where it is (go to <waypoint>) and say resume mining.')
      const seg = G.nextSegment(curMine())
      if (!seg) { state.stripsDone = (state.stripsDone || 0) + 1; await mineFloors(ctx, { trunk: true }); break }
      const before = state.stats.dug + G.doneCells(curMine())
      await runSegment(ctx, seg)
      idle = (state.stats.dug + G.doneCells(curMine()) === before) ? idle + 1 : 0
      if (idle > 40) throw new Pause('park', 'I am not getting anywhere in this mine; stopping.')
    }
    refreshGained()
    if (state.worksite) {
      const done = await worksite.haul(ctx, { final: true })
      if (!done && state.worksite) say(`The work-site chest at ${state.worksite.pos.join(',')} (waypoint "${worksite.NAME}") is not emptied yet. Say "haul mining" to finish.`.slice(0, 230))
    }
    await leaveIfDeep(ctx, 'finished')
    state.active = false; state.pauseReason = null; j.finished = true; state.announced = false
    const got = things(j.drop, j.gained)
    if (j.gained >= j.amount) say(`Done: ${got} (wanted ${j.amount}).`)
    else say(`This strip is finished: ${got} of ${j.amount}. Nothing more in view along the hallways. Say "mine ${j.ore}" again to dig on from the end.`.slice(0, 230))
    note(`DONE ${got}; dug ${state.stats.dug}, ores ${state.stats.ores}`)
    save()
    return { status: 'done' }
  }

  async function run(ctx) {
    if (running) return { status: 'done' }
    running = true
    try { return await job(ctx) }
    catch (e) {
      if (e && e.name === 'AbortError') throw e
      if (e instanceof Pause) {
        if (e.kind === 'retry') return { status: 'retry', afterMs: e.afterMs || L.dangerRetryMs }
        await leaveIfDeep(ctx, 'parked')
        return park(e.reason)
      }
      log(`ERROR ${e && e.stack || e}`)
      say(`Mining stopped by an error: ${e && e.message}`.slice(0, 200))
      return park(`error: ${e && e.message}`, true)
    } finally {
      running = false
      save()
      try { await safehand.stow() } catch {}
    }
  }
  // Never leave the bot stranded underground: when a job parks or ends deep in a shaft mine, go back up the ladders (errors here never change the outcome)
  const usesShaft = () => { const m = curMine(); return !!(SC.enabled && ((m && m.shaft) || (state.ladder && state.ladder.placed > 0))) }
  async function leaveIfDeep(ctx, why) {
    if (!SC.enabled || !SC.top || !SC.exitOn || !SC.exitOn.includes(why) || !usesShaft() || !exit.belowSurface()) return
    try { const r = await exit.leaveMine(ctx, { announce: true }); if (!r.ok) note(`could not leave the mine: ${r.how}`) }
    catch (e) { if (e && e.name === 'AbortError') throw e; log(`leave the mine failed: ${e && e.message}`) }
  }
  // "come up" / "leave the mine" (its own scheduler task, see index.js)
  async function leaveOnly(ctx) {
    if (running) { say('I am busy with a mining job; say "stop mining" first, then "come up".'); return { status: 'done' } }
    running = true
    try {
      await safehand.stow()
      const r = await exit.leaveMine(ctx, { announce: true })
      say(r.ok ? (r.how === 'already at the top' ? 'I am not in the mine.' : 'I am back at the top of the shaft.') : `I could not get out of the mine: ${r.how}.`.slice(0, 200))
      return { status: 'done' }
    } catch (e) {
      if (e && e.name === 'AbortError') throw e
      if (e instanceof Pause) { say(e.reason.slice(0, 200)); return { status: 'done' } }
      log(`ERROR ${e && e.stack || e}`); say(`Leaving the mine stopped by an error: ${e && e.message}`.slice(0, 200)); return { status: 'done' }
    } finally { running = false; save() }
  }
  function park(reason, quiet = false) {
    state.active = false; state.pauseReason = reason; save()
    note(`PAUSED ${reason}`)
    // the pilot watches this: every park that is not a safety pause asks for someone to resolve it
    if (events && !/^Pausing the mining:/.test(reason)) { const p = bot.entity.position; try { events.emit('park', { module: 'mining', reason, pos: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) }, at: now() }) } catch {} }
    const lonely = state.auto && now() - (state.autoSaidAt || 0) < 6 * 3600000          // a routine job that parks says it at most every 6 h
    const tail = /Say "(yes|resume mining)/.test(reason) ? '' : ' Say "resume mining" when ready.'
    if (!quiet && !lonely) { state.autoSaidAt = now(); say(`${reason}${tail}`.slice(0, 235)) }
    return { status: 'park', reason }
  }
  function abort(reason) {
    try { stopNav() } catch {}
    try { bot.stopDigging && bot.stopDigging() } catch {}
    if (reason !== 'preempted') { state.active = false; state.pauseReason = reason === 'user-stop' ? 'stopped by Walter.' : `stopped (${reason}).`; save() }
  }

  const shaft = createShaft({ bot, sight, torches, say, state, save, SC, log, dispatch, scheduler, owner, stock, E: { Pause, floorVec, cap, travel, moveTo, clearCell, harvest, hazardAt, dangerCheck, protectedOk: (p) => !protectedAt(p), sleep: (c, ms) => c.sleep(ms) } })
  const exit = createExit({ bot, sight, goals, mover, torches, shaft, say, state, save, SC, log, E: { Pause, floorVec, travel, moveTo, clearCell, hazardAt, extendOne, stairs, safe: () => safehand.ensureSafeForMove() } })
  const worksite = createWorksite({ bot, sight, mover, goals, torches, say, state, save, L, WC, config, log, dispatch, scheduler, owner, waypoints, deposit, stashJunk, refreshGained, curMine, G, travel, Pause, now })
  return { run, abort, begin, haulOnly, leaveOnly, exit, worksite, shaft, useShaft, statusLine, snapshot, isRunning: () => running, sight, tools, goalMet, refreshGained, curMine, Pause, protectedAt, selectMine, stairs, openRun, pickDir, mineOre, knownMineFor, lightCheck }
}
module.exports.Pause = Pause
