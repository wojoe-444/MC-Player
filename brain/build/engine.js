// The tower job (see README.md): survey -> materials -> foundation -> pillar + courses -> dismantle -> ladder, fills, furnishing -> door.
//
// Runs as ONE scheduler task (brain/scheduler.js): ctx.checkpoint() between every atomic step, progress and the pillar cells are saved as they
// happen, so a pause / preempt / crash / restart resumes from the world (what already stands is never placed again).
//
// Hard rules (Walter's, see brain/INTERFACE.md):
//  - fair play: before EVERY placement api.canSee(reference block) must be true and the face within reach (4.5); otherwise it is deferred or skipped, never placed
//  - only blueprint blocks, only cells inside the blueprint volume; only the recorded cobblestone pillar is ever dug, with the best pickaxe in hand
//  - safehand.ensureSafeForMove() before every walk; coming down from the pillar first whenever the job stops for any reason
//  - pauses (retry) when health < minHealth or a hostile within hostileRadius is in view
const { Vec3 } = require('vec3')
const util = require('../util')
const blueprint = require('./blueprint')
const surveyMod = require('./survey')
const makePillar = require('./pillar')

const HOSTILE = /^(zombie|skeleton|creeper|spider|cave_spider|husk|drowned|witch|pillager|vindicator|evoker|ravager|phantom|slime|silverfish|enderman|zombie_villager|stray|bogged|breeze|vex|blaze|ghast|hoglin|zoglin|piglin_brute|warden)$/
const AIR = /^(air|cave_air|void_air)$/
const REPLACEABLE = /^(short_grass|grass|tall_grass|fern|large_fern|dead_bush|snow)$/
const EYE = 1.62
const DEFAULT_LIMITS = { minHealth: 8, hostileRadius: 6, reach: 4.5, pillarMax: 11, spareCobble: 6, dangerRetries: 6, dangerRetryMs: 20000, surveyRetries: 3, surveyRetryMs: 10000 }
const ITEM_ORDER = ['stone_bricks', 'spruce_log', 'spruce_planks', 'spruce_door', 'ladder', 'torch', 'cobblestone', 'pickaxe']
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const keyOf = (p) => `${p.x},${p.y},${p.z}`

// Thrown inside the job to stop it cleanly: kind 'park' = needs Walter (or materials), 'retry' = try again shortly.
class Pause extends Error {
  constructor(kind, reason, afterMs) { super(reason || kind); this.kind = kind; this.reason = reason; this.afterMs = afterMs }
}

module.exports = function createEngine({ bot, say = () => {}, goals, tryGoto, safehand, stopNav = () => {}, config = {}, state, save, canSee = null, ensureLineOfSight = null, now = Date.now, log = () => {} }) {
  const L = { ...DEFAULT_LIMITS, ...(config.limits || {}) }
  const T = { stepMs: 30, landMs: 120, confirmMs: 80, ...(config.timing || {}) }
  let running = false, pillar = null, cachedSteps = null, cachedKey = null, last = null
  let placedSet = new Set(state.placed || [])
  let skipSeen = new Set()

  const note = (msg) => { last = { at: now(), msg }; log(msg) }
  const blockAt = (p) => { try { return bot.blockAt(p instanceof Vec3 ? p : new Vec3(p.x, p.y, p.z)) || null } catch { return null } }
  const origin = () => (state.site ? { ox: state.site.ox, oy: state.site.oy, oz: state.site.oz } : null)
  const centre = () => { const o = origin(); return { x: o.ox + 2, z: o.oz + 2 } }

  // ---------- blueprint for the saved site ----------
  function steps() {
    const s = state.site
    if (!s) return null
    const k = `${s.ox},${s.oy},${s.oz}|${JSON.stringify(s.low || [])}`
    if (cachedKey !== k) {
      const low = new Map((s.low || []).map(([dx, dz, g]) => [`${dx},${dz}`, g]))
      cachedSteps = blueprint.tower(origin(), { ground: (dx, dz) => (low.has(`${dx},${dz}`) ? low.get(`${dx},${dz}`) : s.oy - 1) })
      cachedKey = k
    }
    return cachedSteps
  }
  const isDone = (st) => { const b = blockAt(st); return !!b && blueprint.satisfied(st, b.name) }

  // ---------- inventory ----------
  const countOf = (name) => bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
  const itemFor = (st) => bot.inventory.items().find(i => (st.item === 'bed' ? blueprint.BED.test(i.name) : i.name === st.item))
  const durLeft = (it) => { const max = bot.registry && bot.registry.items[it.type] ? bot.registry.items[it.type].maxDurability : 0; return max ? max - (it.durabilityUsed || 0) : 999 }
  const usable = () => bot.inventory.items().filter(i => /_(pickaxe|shovel|axe)$/.test(i.name) && durLeft(i) >= 3)
  const hasPickaxe = () => usable().some(i => /_pickaxe$/.test(i.name))
  async function equipBest(block) {          // placing leaves a block in the hand: the right tool before every dig (same idea as excavation/tools.js)
    let best = null, bestT = Infinity
    for (const it of usable()) {
      let t = Infinity
      try { t = block.digTime(it.type, false, false, false, [], {}) } catch { t = /_pickaxe$/.test(it.name) ? 1 : 2 }
      if (t < bestT) { bestT = t; best = it }
    }
    if (!best) return false
    if (!bot.heldItem || bot.heldItem.type !== best.type) await bot.equip(best, 'hand')
    return true
  }

  // What is missing for the part of the tower that still has to be built. [{ name, count }]
  function missing() {
    const all = steps() || blueprint.tower({ ox: 0, oy: 0, oz: 0 })          // no site yet: the whole tower (without any foundation)
    const done = state.site ? isDone : () => false
    const need = {}
    for (const st of all) { if (st.optional || done(st)) continue; need[st.item] = (need[st.item] || 0) + 1 }
    const pst = all.filter(s => s.stage === 'pillar' && !done(s))
    if (pst.length) need.cobblestone = (need.cobblestone || 0) + Math.max(...pst.map(s => s.feet)) + 2 + L.spareCobble
    const out = []
    for (const [name, n] of Object.entries(need)) { const h = countOf(name); if (n > h) out.push({ name, count: n - h }) }
    if (!hasPickaxe()) out.push({ name: 'pickaxe', count: 1 })
    return out.sort((a, b) => ITEM_ORDER.indexOf(a.name) - ITEM_ORDER.indexOf(b.name))
  }
  // What blocks STARTING (or going on): a pickaxe, cobblestone for the pillar, or an item the remaining steps need and the bag has none of.
  // A partial shortage (112 of 118 stone bricks) is no reason to stand still: it builds what it can and parks at the real end of the stock.
  function hardMissing() {
    const hard = missing().filter(m => m.name === 'pickaxe' || m.name === 'cobblestone' || countOf(m.name) === 0)
    return hard
  }
  const needText = (list) => `need ${list.map(m => `${m.count} x ${m.name}`).join(', ')}`

  // ---------- safety ----------
  function danger() {
    if (typeof bot.health === 'number' && bot.health < L.minHealth) return `my health is ${Math.round(bot.health)}/20`
    const me = bot.entity.position
    for (const e of Object.values(bot.entities || {})) {
      if (!e || !e.position || !HOSTILE.test(e.name || '')) continue
      if (e.position.distanceTo(me) >= L.hostileRadius) continue
      if (canSee) { let seen = true; try { seen = !!canSee(e) } catch { seen = true }; if (!seen) continue }   // only what is in view
      return `a ${e.name} is near`
    }
    return null
  }
  function dangerCheck(ctx) {
    const d = danger()
    if (!d) { ctx.state.dangerRetries = 0; return }
    ctx.state.dangerRetries = (ctx.state.dangerRetries || 0) + 1
    if (ctx.state.dangerRetries === 1) say(`Tower paused: ${d}.`.slice(0, 200))
    if (ctx.state.dangerRetries > L.dangerRetries) throw new Pause('park', `Tower paused: ${d}.`)
    throw new Pause('retry', null, L.dangerRetryMs)
  }

  // ---------- movement (abortable; hand made safe first) ----------
  async function goto(ctx, goal, label, ms = 30000) {
    ctx && ctx.checkpoint()
    await safehand.ensureSafeForMove()
    const work = Promise.resolve(tryGoto(goal, label, ms))
    let res
    if (ctx) {
      let dispose
      const aborted = new Promise((_, rej) => { dispose = ctx.onAbort(rej) })
      try { res = await Promise.race([work, aborted]) }
      catch (e) { try { stopNav() } catch {} await Promise.race([work.catch(() => {}), sleep(2000)]); throw e }
      finally { dispose() }
      ctx.checkpoint()
    } else res = await work
    return res || { ok: false, err: 'no result' }
  }
  const mover = { goto }
  const at = (p, tol = 0.7) => Math.abs(bot.entity.position.x - (p.x + 0.5)) <= tol && Math.abs(bot.entity.position.z - (p.z + 0.5)) <= tol && Math.abs(bot.entity.position.y - p.y) <= 0.4

  // Walk to a feet cell; for a cell higher up a ladder column fall back to climbing with the controls when the pathfinder cannot do it.
  async function moveTo(ctx, p, label) {
    if (at(p)) return true
    let res = await goto(ctx, new goals.GoalBlock(p.x, p.y, p.z), label, 30000)
    if (at(p, 0.9)) return true
    const o = origin()
    if (p.x === o.ox + 1 && p.z === o.oz + 1 && p.y > bot.entity.position.y + 0.3 && Math.abs(bot.entity.position.x - (p.x + 0.5)) < 0.9) {
      await safehand.ensureSafeForMove()
      bot.setControlState('jump', true)
      try { for (let i = 0; i < 60 && bot.entity.position.y < p.y - 0.2; i++) { await ctx.sleep(50) } } finally { bot.setControlState('jump', false) }
      if (at(p, 0.9)) return true
    }
    log(`could not reach ${label} ${keyOf(p)}: ${res && res.err}`)
    return false
  }

  // ---------- placing ----------
  const faceCentre = (st) => new Vec3(st.ref.x + 0.5 + st.face.x * 0.5, st.ref.y + 0.5 + st.face.y * 0.5, st.ref.z + 0.5 + st.face.z * 0.5)
  function viewOk(ref, st) {
    if (!canSee) return false
    let seen = false
    try { seen = !!canSee(ref) } catch { seen = false }
    if (!seen) return false
    return bot.entity.position.offset(0, EYE, 0).distanceTo(faceCentre(st)) <= L.reach
  }
  function markPlaced(st, real) {
    if (!placedSet.has(st.key)) { placedSet.add(st.key); state.placed.push(st.key) }
    if (real) state.blocks = (state.blocks || 0) + 1
    save()
  }
  const skip = (why, st) => {
    const k = `${why}|${st.key}`
    if (skipSeen.has(k)) return
    skipSeen.add(k); state.skipped[why] = (state.skipped[why] || 0) + 1
  }

  // Puts one piece down. Returns 'have' | 'placed' | 'blocked' | 'forbidden' | 'no-ref' | 'no-view' | 'no-item' | 'unloaded' | 'failed'.
  async function placeStep(ctx, st, { move = false } = {}) {
    ctx && ctx.checkpoint()
    const cell = new Vec3(st.x, st.y, st.z)
    const cur = blockAt(cell)
    if (!cur) return 'unloaded'
    if (blueprint.satisfied(st, cur.name)) { if (!placedSet.has(st.key)) markPlaced(st, false); return 'have' }
    if (!AIR.test(cur.name) && !REPLACEABLE.test(cur.name)) return 'blocked'              // somebody else's block (or a leftover): never touched
    const o = origin()
    if (!blueprint.allowedItem(st.item) || !blueprint.inBox(o, cell)) return 'forbidden'
    const ref = blockAt(st.ref)
    if (!ref) return 'unloaded'
    if (ref.boundingBox !== 'block') return 'no-ref'
    for (const ex of [{ x: st.x, y: st.y + (st.item === 'spruce_door' ? 1 : 0), z: st.z }, ...(st.extra || [])]) {
      if (ex.x === st.x && ex.y === st.y && ex.z === st.z) continue
      const b = blockAt(ex)
      if (!b) return 'unloaded'
      if (!AIR.test(b.name) && !REPLACEABLE.test(b.name)) return 'blocked'
    }
    const item = itemFor(st)
    if (!item) return 'no-item'
    if (!viewOk(ref, st) && move && ensureLineOfSight) {
      try { await ensureLineOfSight({ ctx, target: ref, label: 'a spot to see the tower' }) } catch (e) { if (e && e.name === 'AbortError') throw e }
    }
    if (!viewOk(ref, st)) return 'no-view'                                                  // fair play: never place what cannot be seen
    try {
      if (!bot.heldItem || bot.heldItem.name !== item.name) await bot.equip(item, 'hand')
      try { await bot.lookAt(faceCentre(st), true) } catch {}
      await bot.placeBlock(ref, new Vec3(st.face.x, st.face.y, st.face.z))
    } catch (e) {
      if (e && e.name === 'AbortError') throw e
      log(`placeBlock ${st.key}: ${e.message}`)               // often reports a timeout although the block went down: look before giving up
    }
    for (let i = 0; i < 6; i++) {
      const b = blockAt(cell)
      if (b && blueprint.satisfied(st, b.name)) { markPlaced(st, true); return 'placed' }
      await sleep(T.confirmMs)
    }
    return 'failed'
  }

  // A list of steps in order. `before(st)` may move the bot (false = could not get to the standing place). Returns how many were left undone.
  async function placeAll(ctx, list, { move = false, before = null } = {}) {
    let pending = list.filter(st => !isDone(st))
    let reasons = new Map()
    for (let pass = 0; pass < 3 && pending.length; pass++) {
      const next = []
      for (const st of pending) {
        ctx.checkpoint(); dangerCheck(ctx)
        if (before && !(await before(st))) { reasons.set(st.key, 'no-stand'); next.push(st); continue }
        const r = await placeStep(ctx, st, { move })
        if (r === 'placed' || r === 'have') continue
        if (r === 'no-item') {
          if (st.optional) continue                                                         // furnishing: only what is in the bag
          const miss = missing()
          throw new Pause('park', miss.length ? needText(miss) : `I have no ${st.item} left`)
        }
        if (r === 'blocked' || r === 'forbidden') { skip(r, st); reasons.set(st.key, r); continue }
        reasons.set(st.key, r); next.push(st)
      }
      pending = next
    }
    for (const st of pending) skip(reasons.get(st.key) || 'failed', st)
    return pending.length + [...reasons.values()].filter(r => r === 'blocked' || r === 'forbidden').length
  }

  // ---------- the pillar ----------
  function getPillar() {
    const o = origin(), c = centre()
    if (!pillar || pillar.col.x !== c.x || pillar.col.z !== c.z) {
      const p = makePillar({ bot, canSee, state, save, col: c, baseY: o.oy, maxBlocks: L.pillarMax, equipBest, mover, goals, log, stepMs: T.stepMs, landMs: T.landMs })
      pillar = Object.assign(p, { col: c })
    }
    return pillar
  }
  async function toCentre(ctx) {
    const o = origin(), c = centre()
    const p = bot.entity.position
    if (Math.floor(p.x) === c.x && Math.floor(p.z) === c.z && Math.abs(p.y - o.oy) < 0.3) return
    const r = await goto(ctx, new goals.GoalBlock(c.x, o.oy, c.z), 'the tower site', 60000)
    const q = bot.entity.position
    if (!(Math.floor(q.x) === c.x && Math.floor(q.z) === c.z && Math.abs(q.y - o.oy) < 0.5)) throw new Pause('retry', null, 30000)
    if (r && r.ok === false) log(`tower site: ${r.err}`)
  }
  async function raiseTo(ctx, targetFeet) {
    const pl = getPillar()
    if (!(pl.standingIn() && pl.cells().length)) await toCentre(ctx)           // already up on the pillar: never walk
    for (let guard = 0; bot.entity.position.y < targetFeet - 0.3; guard++) {
      ctx.checkpoint(); dangerCheck(ctx)
      const r = await pl.raiseOne(ctx)
      if (!r.ok) throw new Pause('park', `Tower paused: ${r.why}.`)
      if (guard > 14) throw new Pause('park', 'Tower paused: the pillar will not go up.')
    }
  }
  // Collect what the pillar dropped (the bot stands where it fell; this only matters when something rolled away).
  async function collectDrops(ctx) {
    for (let i = 0; i < 6; i++) {
      if (ctx) ctx.checkpoint()
      const it = bot.nearestEntity && bot.nearestEntity(e => e && e.name === 'item' && e.position.distanceTo(bot.entity.position) < 8)
      if (!it) return
      await goto(ctx, new goals.GoalNear(it.position.x, it.position.y, it.position.z, 0.8), 'a drop', 5000)
    }
  }
  // Down from wherever the bot is: the recorded pillar first, a ladder or floor otherwise. Never throws, never checks for aborts.
  async function standDown() {
    try { stopNav() } catch {}
    try { bot.setControlState('jump', false); bot.setControlState('forward', false) } catch {}
    if (!state.site) return
    try {
      if (state.pillar && state.pillar.cells && state.pillar.cells.length) await getPillar().dismantle(null)
      const o = origin()
      if (bot.entity.position.y > o.oy + 0.7 && !(state.pillar && state.pillar.cells.length)) {
        const c = centre()
        await safehand.ensureSafeForMove()
        await Promise.race([Promise.resolve(tryGoto(new goals.GoalNear(c.x, o.oy, c.z, 2), 'down from the tower', 15000)).catch(() => {}), sleep(16000)])
      }
    } catch (e) { log(`stand down: ${e.message}`) }
  }

  // ---------- the job ----------
  const incompleteText = (list) => {
    const why = Object.entries(state.skipped).map(([k, v]) => `${v} ${k}`).join(', ')
    return `Tower: ${list.length} block(s) are not placed yet${why ? ` (${why})` : ''}.`
  }
  async function ensureSite(ctx) {
    if (state.site) return
    const cfg = config.site || {}
    const c = state.centre || { x: cfg.x, z: cfg.z }
    const me = bot.entity.position
    if (Math.hypot(me.x - c.x, me.z - c.z) > 30) {
      await goto(ctx, new goals.GoalNearXZ(Math.round(c.x), Math.round(c.z), 8), 'the tower site', 120000)
      await ctx.sleep(1500)
    }
    const r = surveyMod.survey(bot, { center: c, radius: cfg.radius ?? 14, maxDy: cfg.maxDy ?? 1, yRange: cfg.yRange ?? 48, protect: config.protect || [], y: Math.round(bot.entity.position.y) })
    if (!r.site) {
      ctx.state.surveyTries = (ctx.state.surveyTries || 0) + 1
      if (r.counts.unloaded && ctx.state.surveyTries <= L.surveyRetries) throw new Pause('retry', null, L.surveyRetryMs)
      throw new Pause('park', `Tower: ${r.reason}.`)
    }
    state.site = r.site; state.centre = c; state.placed = []; placedSet = new Set(); cachedKey = null
    save()
    note(`SITE ${r.site.ox},${r.site.oy},${r.site.oz} flat=${r.site.flat} low=${(r.site.low || []).length}`)
  }

  // The site is a flower meadow: the server refuses to place a block into a cell that holds a flower, so (like a player) pick the plants first.
  // Only small plants inside the tower's footprint at the first two levels, only with a clear line of sight, by hand, never anything else.
  const PLANT = /(flower|bluet|tulip|poppy|dandelion|orchid|allium|cornflower|lily_of_the_valley|rose_bush|peony|lilac|sunflower|short_grass|^grass$|tall_grass|fern|dead_bush|^bush$|sapling|mushroom|wildflowers|torchflower|pink_petals|leaf_litter|firefly_bush|bamboo_sapling)/
  async function clearPlants(ctx) {
    const o = origin(); let cleared = 0, skipped = 0
    // the job may start far away (a saved site is not walked to by ensureSite): get to the footprint first, or nothing is in sight and nothing gets picked
    const c0 = centre(), me0 = bot.entity.position
    if (Math.hypot(me0.x - (c0.x + 0.5), me0.z - (c0.z + 0.5)) > 6 || Math.abs(me0.y - o.oy) > 3) {
      try { await goto(ctx, new goals.GoalNear(c0.x, o.oy, c0.z, 3), 'the tower site', 120000) } catch (e) { if (e && e.name === 'AbortError') throw e; log(`clear plants: could not get to the site: ${e.message}`) }
    }
    for (let dz = -1; dz <= 5; dz++) for (let dx = -1; dx <= 5; dx++) for (let dy = 0; dy <= 1; dy++) {
      ctx && ctx.checkpoint()
      const b = blockAt({ x: o.ox + dx, y: o.oy + dy, z: o.oz + dz })
      if (!b || b.boundingBox !== 'empty' || !PLANT.test(b.name) || /^(wheat|carrots|potatoes|beetroots)$/.test(b.name)) continue
      try {
        if ((!canSee || !canSee(b)) && ensureLineOfSight) await ensureLineOfSight({ ctx, target: b, label: 'a flower in the way' })
        if (canSee && !canSee(b)) { skipped++; log(`clear plant ${b.name} at ${b.position}: not in sight`); continue }
        if (typeof bot.canDigBlock === 'function' && !bot.canDigBlock(b)) { skipped++; log(`clear plant ${b.name} at ${b.position}: cannot dig from here`); continue }
        try { if (bot.heldItem) await bot.unequip('hand') } catch {}
        await bot.dig(b, true); cleared++
      } catch (e) { if (e && e.name === 'AbortError') throw e; log(`clear plant ${b.name} at ${b.position}: ${e.message}`) }
    }
    if (cleared || skipped) note(`cleared ${cleared} plant(s) from the footprint${skipped ? `, ${skipped} out of reach` : ''}`)
    return cleared
  }
  function setPhase(p, ctx) { state.phase = p; save(); if (ctx) ctx.progress(statusLine()) }

  async function pillarPhase(ctx, all) {
    const o = origin()
    const pst = all.filter(s => s.stage === 'pillar')
    const feets = [...new Set(pst.map(s => s.feet))].sort((a, b) => a - b)
    let left = 0
    for (const f of feets) {
      const group = pst.filter(s => s.feet === f)
      if (group.every(isDone)) continue
      setPhase(group[0].phase, ctx)
      await raiseTo(ctx, o.oy + f)
      left += await placeAll(ctx, group)
    }
    return left
  }

  async function stagePhase(ctx, all, stage, phase) {
    const list = all.filter(s => s.stage === stage)
    if (list.every(isDone)) return 0
    setPhase(phase, ctx)
    return placeAll(ctx, list, { move: true, before: async (st) => {
      if (st.optional && !itemFor(st)) return true            // nothing to place: placeAll skips it silently
      return moveTo(ctx, st.stand, `tower ${st.stage}`)
    } })
  }

  async function job(ctx) {
    skipSeen = new Set(); state.skipped = {}
    if (state.holdUntil && now() < state.holdUntil) return { status: 'retry', afterMs: Math.max(5000, state.holdUntil - now()) }
    state.holdUntil = 0
    if (util.dimOf(bot) !== 'overworld') return { status: 'retry', afterMs: 120000 }
    await safehand.stow()
    if (!state.site && ctx.state.cleanup) return { status: 'done' }
    // a pillar left by a crash or restart comes down first (before anything else)
    if (state.site && state.pillar && state.pillar.cells && state.pillar.cells.length) {
      note('removing a pillar left from an earlier run')
      await getPillar().dismantle(ctx)
      await collectDrops(ctx)
      if (state.pillar && state.pillar.cells.length) throw new Pause('park', 'Tower paused: some pillar blocks are out of my reach, I could not take them down.')
    }
    if (ctx.state.cleanup) { return { status: 'done' } }
    dangerCheck(ctx)
    await ensureSite(ctx)
    const all = steps()
    const miss = hardMissing()
    if (miss.length) throw new Pause('park', `Tower: ${needText(miss)}.`)
    const first = !state.startedAt
    if (first) state.startedAt = new Date(now()).toISOString()
    if (!ctx.resumed || first) { const o = origin(); say(`${first ? 'Starting' : 'Back to'} my tower at ${o.ox}, ${o.oy}, ${o.oz}.`) }
    state.active = true; state.pauseReason = null; state.finished = false; save()
    ctx.progress(statusLine())

    await clearPlants(ctx)
    // foundation (cobblestone under the low cells of the 5x5), each from the neighbouring cell, looking down into the pit
    await stagePhase(ctx, all, 'foundation', 'foundation')
    // walls, floor, deck, parapet, torches from the pillar; then always down again
    try { await pillarPhase(ctx, all) }
    finally { await getPillar().dismantle(null) }
    await collectDrops(ctx)
    if (state.pillar && state.pillar.cells.length) throw new Pause('park', 'Tower paused: some pillar blocks are out of my reach, I could not take them down.')
    const undone = all.filter(s => (s.stage === 'foundation' || s.stage === 'pillar') && !isDone(s))
    if (undone.length) throw new Pause('park', incompleteText(undone))                // down from the pillar, nothing more can hang on what is missing
    ctx.checkpoint()
    // ladder, centre fills, furnishing, the door last
    await stagePhase(ctx, all, 'ladder', 'ladder')
    await stagePhase(ctx, all, 'fill-deck', 'fill')
    await stagePhase(ctx, all, 'fill-floor', 'fill')
    await stagePhase(ctx, all, 'furnish', 'furnish')
    await stagePhase(ctx, all, 'door', 'door')
    const rest = all.filter(s => !s.optional && !isDone(s))
    if (rest.length) throw new Pause('park', incompleteText(rest))
    state.finished = true; state.active = false; state.phase = 'done'; state.pauseReason = null
    state.finishedAt = new Date(now()).toISOString(); save()
    const o = origin()
    say(`My tower is finished at ${o.ox}, ${o.oy}, ${o.oz}.`)
    note(`DONE blocks=${state.blocks} skipped=${JSON.stringify(state.skipped)}`)
    return { status: 'done' }
  }

  async function run(ctx) {
    if (running) return { status: 'done' }
    running = true
    try { return await job(ctx) }
    catch (e) {
      await standDown()                                               // off the pillar before anything else
      if (e && e.name === 'AbortError') throw e
      if (e instanceof Pause) {
        if (e.kind === 'retry') return { status: 'retry', afterMs: e.afterMs || L.dangerRetryMs }
        return park(e.reason)
      }
      log(`ERROR ${e && e.stack || e}`)
      say(`Tower stopped by an error: ${e && e.message}`.slice(0, 200))
      return park(`error: ${e && e.message}`, true)
    } finally {
      running = false
      save()
      try { await safehand.stow() } catch {}
    }
  }
  // Loop breaker: the same park reason again and again with no block placed in between (auto-repair resumes it each time) holds the job for a few minutes.
  const LOOP = { n: 3, windowMs: 10 * 60 * 1000, holdMs: 3 * 60 * 1000 }
  function park(reason, quiet = false) {
    state.active = false; state.pauseReason = reason
    const t = now(), blocks = state.blocks || 0
    state.parkLog = (state.parkLog || []).filter(p => t - p.at < LOOP.windowMs && p.blocks === blocks && p.reason === String(reason)).concat([{ at: t, reason: String(reason), blocks }])
    let looped = false
    if (state.parkLog.length >= LOOP.n) { state.holdUntil = t + LOOP.holdMs; state.parkLog = []; looped = true }
    save()
    note(`PAUSED ${reason}${looped ? ' (repeated; holding for 3 minutes)' : ''}`)
    if (looped) say(`The tower keeps stopping for the same reason: ${String(reason).slice(0, 150)} I will not try again for a few minutes.`.slice(0, 230))
    else if (!quiet) say(String(reason).slice(0, 230))
    return { status: 'park', reason }
  }

  // Scheduler abort hook (preempt / Walter's stop). The running step is interrupted; progress is already on disk, the job itself comes down in its catch.
  function abort(reason) {
    try { stopNav() } catch {}
    try { bot.setControlState('jump', false) } catch {}
    try { bot.stopDigging && bot.stopDigging() } catch {}
    if (reason !== 'preempted') { state.active = false; state.pauseReason = reason === 'user-stop' ? 'stopped by Walter.' : `stopped (${reason}).`; save() }
  }

  // ---------- reports ----------
  function courseDone() {
    const all = steps()
    if (!all) return 0
    let c = 0
    for (; c < blueprint.COURSES; c++) if (!all.filter(s => s.phase === 'walls' && s.course === c).every(s => placedSet.has(s.key))) break
    return c
  }
  function total() { const all = steps(); return all ? all.filter(s => !s.optional).length : 0 }
  function statusLine() {
    const s = state.site
    if (!s) return state.pauseReason ? `No tower site yet. ${state.pauseReason}` : 'No tower yet. Say "build tower" and I will look for a site.'
    const where = `${s.ox}, ${s.oy}, ${s.oz}`
    if (state.finished) return `My tower is finished at ${where}.`
    const done = steps().filter(x => !x.optional && placedSet.has(x.key)).length
    const body = `phase ${state.phase || 'start'}, course ${courseDone()}/${blueprint.COURSES}, ${done}/${total()} blocks placed, site ${where}`
    if (running) return `Tower: ${body}.`
    return `Tower (not running): ${body}.${state.pauseReason ? ` Paused: ${state.pauseReason}` : ''}${state.active ? '' : ' Say "resume building" to continue.'}`
  }
  function snapshot() {
    return {
      running, active: !!state.active, finished: !!state.finished, phase: state.phase, site: state.site ? { ox: state.site.ox, oy: state.site.oy, oz: state.site.oz } : null,
      courses: courseDone(), placed: state.blocks || 0, steps: state.site ? `${steps().filter(x => !x.optional && placedSet.has(x.key)).length}/${total()}` : null,
      pillarCells: state.pillar ? state.pillar.cells.length : 0, skipped: { ...state.skipped }, pauseReason: state.pauseReason, startedAt: state.startedAt, updatedAt: state.updatedAt,
      last: last && { agoS: Math.round((now() - last.at) / 1000), msg: last.msg }
    }
  }
  const resync = () => { placedSet = new Set(state.placed || []); cachedKey = null }

  return { run, abort, statusLine, snapshot, missing, needText, steps, isDone, courseDone, isRunning: () => running, standDown, resync, Pause, danger }
}
module.exports.Pause = Pause
