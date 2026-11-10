// brain/husbandry engine: build a fenced, lit pen; lure animals into it with food; breed, shear and cull them; grow and harvest a glow lichen light farm.
// Walter's rules, as everywhere: survival-legit (a clear ray to every block and animal touched, reach limits, no digging or placing outside the agreed job:
// the pen's own fence ring, gate and torches, and glow lichen on the farm wall), the lava bucket is never in hand while moving (safehand), no item piles
// (drops of a cull are collected), chat only when something changed. Everything the engine decides from is the loaded world, never a remembered guess.
const { Vec3 } = require('vec3')
const bp = require('./blueprint')
const herd = require('./herd')
const sv = require('./survey')

const HOSTILE = /^(zombie|skeleton|creeper|spider|cave_spider|husk|drowned|witch|pillager|vindicator|phantom|slime|silverfish|enderman|zombie_villager|stray|bogged|breeze)$/
const SWORDS = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword']
const FACES = ['up', 'down', 'north', 'south', 'east', 'west']
const plainSleep = (ms) => new Promise(r => setTimeout(r, ms))
const AIRISH = sv.SOFT

class Danger extends Error { constructor(why) { super(why); this.why = why; this.name = 'Danger' } }
class Missing extends Error { constructor(needs) { super('missing ' + Object.entries(needs).map(([k, v]) => `${v} ${k}`).join(', ')); this.needs = needs; this.name = 'Missing' } }

module.exports = function createEngine({ bot, say = () => {}, goals, tryGoto, safehand, stopNav = () => {}, gotoNear = null, canSee = null, ensureLineOfSight = null, craft = null, foodPoints = null, config: C, state, save = () => {}, now = Date.now, log = () => {} }) {
  let running = false, stopFlag = false, last = null
  const fedAt = {}                                   // entity id -> ms it was last fed (breeding cooldown)
  const note = (m) => { last = { at: now(), msg: m }; log(m) }
  const halt = () => { try { stopNav() } catch { /* nothing to stop */ } }
  const wait = (ctx, ms) => (ctx ? ctx.sleep(ms) : plainSleep(ms))

  // ---------- small helpers ----------
  const blockAt = (p) => { try { return bot.blockAt(p instanceof Vec3 ? p : new Vec3(p.x, p.y, p.z)) || null } catch { return null } }
  const have = (n) => bot.inventory.items().filter(i => i.name === n).reduce((s, i) => s + i.count, 0)
  const eye = () => bot.entity.position.offset(0, 1.62, 0)
  const dist = (p) => bot.entity.position.distanceTo(new Vec3(p.x + 0.5, p.y + 0.5, p.z + 0.5))
  const isNight = () => !!(bot.time && bot.time.timeOfDay >= C.dayEnd)
  const winter = () => state.winter !== false
  const seeNow = (t) => !!t && !!canSee && canSee(t)                 // no clear ray from the eye, no action (without the helper, no action at all)

  function danger({ night = false } = {}) {
    if (bot.health < C.minHealth) return `my health is ${Math.round(bot.health)}/20`
    const m = bot.nearestEntity && bot.nearestEntity(e => HOSTILE.test(e.name || '') && e.position.distanceTo(bot.entity.position) < C.dangerRadius)
    if (m) return `a ${m.name} is near`
    if (night && isNight()) return 'it is night'
    return null
  }
  const guard = (o) => { const d = danger(o); if (d) throw new Danger(d) }

  async function goto(ctx, goal, label, ms = 30000) {
    ctx && ctx.checkpoint()
    await safehand.ensureSafeForMove()
    const work = Promise.resolve(tryGoto(goal, label, ms))
    let res
    if (ctx) {
      let dispose
      const aborted = new Promise((_, rej) => { dispose = ctx.onAbort(rej) })
      try { res = await Promise.race([work, aborted]) }
      catch (e) { halt(); await Promise.race([work.catch(() => {}), plainSleep(2000)]); throw e }
      finally { dispose() }
      ctx.checkpoint()
    } else res = await work
    return res || { ok: false, err: 'no result' }
  }
  async function near(ctx, pos, radius, label, ms = 40000) {
    await safehand.ensureSafeForMove()
    if (gotoNear) return gotoNear({ pos, radius, label, ctx, ms })
    const r = await goto(ctx, new goals.GoalNear(pos.x, pos.y, pos.z, radius), label, ms)
    return !!r.ok || dist(pos) <= radius + 1.5
  }
  async function see(ctx, target, label) {
    if (!target || !canSee) return false
    if (canSee(target)) return true
    if (!ensureLineOfSight) return false
    await safehand.ensureSafeForMove()
    return !!(await ensureLineOfSight({ ctx, target, label }))
  }
  async function equip(name) {
    const it = bot.inventory.items().find(i => i.name === name)
    if (!it) return false
    if (!bot.heldItem || bot.heldItem.name !== name) await bot.equip(it, 'hand')
    return true
  }
  // put the lure food away: a tool in hand (or an empty hand), so animals lose interest in the bot
  async function pocketFood() {
    const foods = new Set(herd.NAMES.flatMap(n => herd.SPECIES[n].foods))
    if (bot.heldItem && !foods.has(bot.heldItem.name)) return
    const other = bot.inventory.items().find(i => !foods.has(i.name) && /_(pickaxe|sword|axe|shovel)$/.test(i.name)) || bot.inventory.items().find(i => !foods.has(i.name))
    try { if (other) await bot.equip(other, 'hand'); else if (bot.unequip) await bot.unequip('hand') } catch { /* hand stays as it is */ }
  }
  const statusOf = (pen) => {
    const c = herd.counts(herd.census(bot.entities, bp.boxOf(pen)))
    return c
  }

  // ---------- materials ----------
  async function ensureMaterials(need) {
    const missing = {}
    for (const [item, n] of Object.entries(need)) {
      const short = n - have(item)
      if (short <= 0) continue
      if (craft) { try { await craft(item, short) } catch (e) { log(`craft ${item}: ${e.message}`) } }
      const still = n - have(item)
      if (still > 0) missing[item] = still
    }
    if (Object.keys(missing).length) throw new Missing(missing)
  }

  // ======================================================================= the pen
  // Place the fence ring, the gate and the torches. What stands is decided from the world, so a restart or a pause resumes where it stopped.
  async function buildPen(ctx, pen) {
    const steps = bp.pen({ x: pen.ox, y: pen.oy, z: pen.oz }, { w: pen.w, d: pen.d, wood: pen.wood })
    const standing = (s) => { const b = blockAt(s); return !!b && b.name === s.block }
    await ensureMaterials(bp.materials(steps, standing))
    let placed = 0, blocked = 0
    const skipped = new Set()
    for (let pass = 0; pass < 3; pass++) {
      let progress = 0
      for (const s of steps) {
        if (standing(s) || skipped.has(s.key)) continue
        ctx && ctx.checkpoint(); guard({ night: true })
        const cell = blockAt(s)
        if (!cell || !AIRISH.test(cell.name)) { skipped.add(s.key); blocked++; note(`pen: ${s.key} holds ${cell ? cell.name : 'unloaded'}, left alone`); continue }
        const ref = blockAt(s.ref)
        if (!ref || ref.boundingBox !== 'block') continue                      // a torch waits for its post; retried on the next pass
        const out = { x: s.x + s.outward.x * 2, y: pen.oy, z: s.z + s.outward.z * 2 }
        await near(ctx, out, 1, 'pen ' + s.kind, 30000)
        if (!(await see(ctx, ref, 'pen ' + s.kind))) continue
        if (eye().distanceTo(new Vec3(s.ref.x + 0.5 + s.face.x * 0.5, s.ref.y + 0.5 + s.face.y * 0.5, s.ref.z + 0.5 + s.face.z * 0.5)) > C.reach) continue
        await equip(s.item)
        try { await bot.placeBlock(ref, new Vec3(s.face.x, s.face.y, s.face.z)) } catch (e) { log(`placeBlock ${s.key}: ${e.message}`) }
        await wait(ctx, 120)
        if (standing(s)) { placed++; progress++; state.stats.placed++ }
      }
      if (!progress) break
    }
    const left = steps.filter(s => !standing(s) && !skipped.has(s.key)).length
    const done = steps.every(standing)
    pen.built = steps.filter(s => s.kind !== 'torch').every(standing)
    pen.lit = steps.filter(s => s.kind === 'torch').every(standing)
    pen.builtAt = pen.built ? (pen.builtAt || now()) : null
    save()
    return { placed, left, blocked, done, built: pen.built, lit: pen.lit, total: steps.length }
  }

  // ---------- the gate ----------
  async function setGate(ctx, pen, open) {
    const g = bp.gateOf(pen)
    let b = blockAt(g)
    if (!b || !/fence_gate$/.test(b.name)) throw new Error('the pen has no gate yet')
    const isOpen = () => { const x = blockAt(g); return !!x && !!x.getProperties && x.getProperties().open === true }
    if (isOpen() === open) return true
    for (let i = 0; i < 3 && isOpen() !== open; i++) {
      ctx && ctx.checkpoint()
      if (dist(g) > C.reach - 0.5) await near(ctx, g, 2, 'pen gate', 20000)
      b = blockAt(g)
      if (!(await see(ctx, b, 'pen gate'))) { await wait(ctx, 200); continue }
      await bot.activateBlock(b)
      await wait(ctx, 250)
    }
    return isOpen() === open
  }
  const insidePen = (pen, p = bot.entity.position) => herd.inBox(p, bp.boxOf(pen))
  async function enterPen(ctx, pen) {
    if (insidePen(pen)) return true
    const out = bp.outsideGate(pen), inn = bp.insideGate(pen)
    await near(ctx, out, 1, 'pen gate', 40000)
    if (!(await setGate(ctx, pen, true))) throw new Error('could not open the pen gate')
    try { await goto(ctx, new goals.GoalBlock(inn.x, inn.y, inn.z), 'into the pen', 15000) } catch (e) { try { if (!insidePen(pen)) await setGate(null, pen, false) } catch { /* the gate stays as it is */ } throw e }
    await setGate(ctx, pen, false)
    return insidePen(pen)
  }
  async function leavePen(ctx, pen) {
    if (!insidePen(pen)) return true
    const out = bp.outsideGate(pen)
    await pocketFood()
    if (!(await setGate(ctx, pen, true))) throw new Error('could not open the pen gate to leave')
    await goto(ctx, new goals.GoalBlock(out.x, out.y, out.z), 'out of the pen', 15000)
    await setGate(ctx, pen, false)
    return !insidePen(pen)
  }

  // ======================================================================= animals
  const censusOf = (pen) => herd.census(bot.entities, bp.boxOf(pen))
  const adultsIn = (pen, species) => censusOf(pen)[species].adults

  async function feed(ctx, e, foodName) {
    ctx && ctx.checkpoint()
    if (!bot.entities[e.id]) return false
    if (bot.entity.position.distanceTo(e.position) > C.entityReach) {
      await near(ctx, { x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z) }, 1, 'animal', 15000)
    }
    if (bot.entity.position.distanceTo(e.position) > C.entityReach + 0.6 || !seeNow(e)) return false
    if (!(await equip(foodName))) return false
    try { await bot.lookAt(e.position.offset(0, (e.height || 1) * 0.6, 0), true) } catch { /* aim is best effort */ }
    await bot.activateEntity(e)
    fedAt[e.id] = now()
    await wait(ctx, 150)
    return true
  }

  // pairs of the nearest breedable adults, fed together: love lasts 30 s, so both of a pair are fed within seconds of each other
  async function breed(ctx, pen, species, pairs) {
    const ready0 = herd.breedable(adultsIn(pen, species), fedAt, now(), C.herd.loveCooldownMs)
    const food0 = herd.foodFor(species, bot.inventory.items())
    if (!food0) throw new Missing({ [herd.SPECIES[species].foods[0]]: 2 * pairs })
    if (ready0.length < 2) return { fed: 0, babies: 0, why: 'no pair ready (cooldown)' }
    const babiesBefore = censusOf(pen)[species].babies.length
    let fed = 0, used = 0
    const taken = new Set()
    for (let p = 0; p < pairs; p++) {
      const food = herd.foodFor(species, bot.inventory.items()); if (!food || food.count < 2) break
      const ready = herd.breedable(adultsIn(pen, species), fedAt, now(), C.herd.loveCooldownMs).filter(e => !taken.has(e.id))
      if (ready.length < 2) break
      const a = ready[0]
      const b = ready.slice(1).sort((x, y) => x.position.distanceTo(a.position) - y.position.distanceTo(a.position))[0]
      if (!(await feed(ctx, a, food.name))) { taken.add(a.id); p--; continue }
      if (!(await feed(ctx, b, food.name))) { taken.add(b.id); p--; continue }
      taken.add(a.id); taken.add(b.id); fed += 2; used++
    }
    // babies appear within a few seconds of the second feeding
    let babies = 0
    for (let i = 0; i < C.breedWatch.tries && fed; i++) {
      babies = censusOf(pen)[species].babies.length - babiesBefore
      if (babies >= used) break
      await wait(ctx, C.breedWatch.ms)
    }
    babies = Math.max(0, censusOf(pen)[species].babies.length - babiesBefore)
    state.stats.bred += babies
    const pb = (pen.noBaby = pen.noBaby || {})
    if (fed) {
      if (babies > 0) { pb[species] = 0; if (pen.breedBlocked) delete pen.breedBlocked[species] } else {
        pb[species] = (pb[species] || 0) + 1
        if (pb[species] >= C.herd.noBabyRunsBeforeBlocked) {
          pen.breedBlocked = pen.breedBlocked || {}; pen.breedBlocked[species] = now()
          note(`pen: ${species} did not breed ${pb[species]} times in a row (season? food? room?), holding off for a while`)
        }
      }
    }
    save()
    return { fed, babies }
  }

  async function bestSword() {
    for (const n of SWORDS) if (have(n)) { await equip(n); return n }
    return null
  }
  function itemsNear(p, r) {
    return Object.values(bot.entities).filter(e => e && e.position && (e.name === 'item' || e.displayName === 'Item') && e.position.distanceTo(p) <= r)
  }
  // nothing is left lying on the ground: walk over the drops around a spot
  async function collect(ctx, p, r = 8) {
    let n = 0
    for (let i = 0; i < 8; i++) {
      ctx && ctx.checkpoint()
      const drops = itemsNear(p, r); if (!drops.length) break
      const e = drops.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
      await goto(ctx, new goals.GoalNear(Math.floor(e.position.x), Math.floor(e.position.y), Math.floor(e.position.z), 0), 'pick up', 8000)
      await wait(ctx, 200); n++
    }
    return n
  }

  // kill n adults of a species inside the pen (never babies, never below the breeding pair), from inside the pen so the fence is not in the way
  async function cull(ctx, pen, species, n) {
    let killed = 0
    const sword = await bestSword()
    for (let k = 0; k < n; k++) {
      ctx && ctx.checkpoint(); guard()
      const adults = adultsIn(pen, species)
      if (adults.length <= C.herd.minStock) { note(`pen: keeping the last ${adults.length} ${species}`); break }
      const victim = herd.pickVictims(adults, 1, fedAt)[0]; if (!victim) break
      const t0 = now()
      while (bot.entities[victim.id] && now() - t0 < C.cullMsPerAnimal) {
        ctx && ctx.checkpoint(); guard()
        if (bot.entity.position.distanceTo(victim.position) > C.entityReach) await near(ctx, { x: Math.floor(victim.position.x), y: Math.floor(victim.position.y), z: Math.floor(victim.position.z) }, 1, 'animal', 10000)
        if (bot.entity.position.distanceTo(victim.position) <= C.entityReach + 0.6 && seeNow(victim)) {
          try { await bot.lookAt(victim.position.offset(0, (victim.height || 1) * 0.5, 0), true) } catch { /* aim is best effort */ }
          bot.attack(victim)
        }
        await wait(ctx, C.swingMs)
      }
      if (!bot.entities[victim.id]) { killed++; state.stats.culled++ }
    }
    if (killed) await collect(ctx, new Vec3(pen.ox + pen.w / 2, pen.oy, pen.oz + pen.d / 2), Math.max(pen.w, pen.d))
    save()
    return { killed, sword }
  }

  async function shear(ctx, pen) {
    if (!have('shears')) return { sheared: 0, why: 'no shears' }
    let sheared = 0
    const todo = adultsIn(pen, 'sheep').filter(e => !herd.isSheared(e))
    for (const e of todo) {
      ctx && ctx.checkpoint(); guard()
      if (!bot.entities[e.id]) continue
      if (bot.entity.position.distanceTo(e.position) > C.entityReach) await near(ctx, { x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z) }, 1, 'sheep', 10000)
      if (bot.entity.position.distanceTo(e.position) > C.entityReach + 0.6 || !seeNow(e)) continue
      await equip('shears')
      try { await bot.lookAt(e.position.offset(0, (e.height || 1) * 0.6, 0), true) } catch { /* aim is best effort */ }
      await bot.activateEntity(e)
      await wait(ctx, 200)
      if (herd.isSheared(bot.entities[e.id] || e)) { sheared++; state.stats.sheared++ }
    }
    await collect(ctx, bot.entity.position, 6)
    save()
    return { sheared }
  }

  // Lure animals of a species that stand outside the pen: hold their food, walk toward the gate in short hops and let them follow, go in, come out without the food.
  async function lure(ctx, pen, species) {
    const food = herd.foodFor(species, bot.inventory.items())
    if (!food) throw new Missing({ [herd.SPECIES[species].foods[0]]: 2 })
    const box = bp.boxOf(pen)
    const boxes = state.pens.map(bp.boxOf)                                   // animals in any of our pens are not wild
    const outside = () => Object.values(bot.entities).filter(e => herd.isAnimal(e) && e.name === species && !boxes.some(b => herd.inBox(e.position, b)) && e.position.distanceTo(bot.entity.position) <= C.lure.sightRadius && seeNow(e))
    let cands = outside()
    if (!cands.length) return { lured: 0, why: 'no ' + species + ' in sight outside the pen' }
    const t0 = now(), followers = () => Object.values(bot.entities).filter(e => herd.isAnimal(e) && e.name === species && !herd.inBox(e.position, box) && e.position.distanceTo(bot.entity.position) <= C.lure.followWithin)
    await equip(food.name)
    // go to the nearest one, then back toward the gate in hops
    cands = cands.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
    const first = cands[0]
    await near(ctx, { x: Math.floor(first.position.x), y: Math.floor(first.position.y), z: Math.floor(first.position.z) }, 2, 'lure ' + species, 30000)
    const out = bp.outsideGate(pen)
    const gate = new Vec3(out.x, out.y, out.z)
    for (let hop = 0; hop < C.lure.maxHops && now() - t0 < C.lure.ms; hop++) {
      ctx && ctx.checkpoint(); guard({ night: true })
      await equip(food.name)
      const here = bot.entity.position, d = here.distanceTo(gate)
      if (d <= 1.5) break
      const f = followers()
      if (!f.length && hop > 0) {                                           // lost them: step back toward the nearest one
        const c2 = outside(); if (!c2.length) break
        const e = c2.sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))[0]
        await near(ctx, { x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z) }, 2, 'lure ' + species, 15000)
        continue
      }
      const step = Math.min(C.lure.hopBlocks, d), t = here.plus(gate.minus(here).scaled(step / d))
      await goto(ctx, new goals.GoalNear(Math.floor(t.x), Math.floor(t.y), Math.floor(t.z), 0), 'lure ' + species, 12000)
      await wait(ctx, C.lure.hopWaitMs)
    }
    // through the gate with them behind, to the middle of the pen
    let lured = 0
    if (bot.entity.position.distanceTo(gate) <= 3.5) {
      if (bot.entity.position.distanceTo(gate.offset(0.5, 0, 0.5)) > 0.8) await goto(ctx, new goals.GoalBlock(out.x, out.y, out.z), 'pen gate', 10000)        // exactly in front of the gate, so the walk in is straight
      if (!(await setGate(ctx, pen, true))) throw new Error('could not open the pen gate')
      const mid = { x: Math.floor(pen.ox + pen.w / 2), y: pen.oy, z: Math.floor(pen.oz + pen.d / 2) }
      await goto(ctx, new goals.GoalBlock(mid.x, mid.y, mid.z), 'into the pen', 20000)
      await wait(ctx, C.lure.hopWaitMs)
      lured = Object.values(bot.entities).filter(e => herd.isAnimal(e) && e.name === species && herd.inBox(e.position, box) && e.position.distanceTo(bot.entity.position) <= C.lure.followWithin).length
      await pocketFood()
      const o2 = bp.outsideGate(pen)
      await goto(ctx, new goals.GoalBlock(o2.x, o2.y, o2.z), 'out of the pen', 20000)
      await setGate(ctx, pen, false)
    } else await pocketFood()
    state.stats.lured += lured
    save()
    return { lured }
  }

  // ---------- one visit to a pen: shear, breed, thin out; lure what is missing ----------
  async function tendPen(ctx, pen) {
    guard({ night: true })
    const res = { pen: pen.id, lured: {}, bred: {}, culled: {}, sheared: 0 }
    const capacity = Math.max(2, Math.floor(bp.areaOf(pen) / C.pen.minAreaPerAnimal))
    try {
      // 1. species the pen lacks (fewer than a pair) and that are in sight outside: bring them
      for (const sp of herd.NAMES) {
        if (adultsIn(pen, sp).length >= 2) continue
        if (!herd.foodFor(sp, bot.inventory.items())) continue
        const r = await lure(ctx, pen, sp).catch(e => { if (e.name === 'Danger' || (ctx && ctx.aborted)) throw e; log(`lure ${sp}: ${e.message}`); return { lured: 0 } })
        if (r.lured) res.lured[sp] = r.lured
      }
      // 2. inside the pen
      const c0 = censusOf(pen)
      const fl = foodPoints ? foodPoints() < C.herd.foodLowPoints : false
      const plan = herd.decide(c0, { cfg: C.herd, winter: winter(), capacity, foodLow: fl, breedBlocked: activeBlocks(pen) })
      res.plan = plan
      if (plan.breed.length || plan.cull.length || (plan.shear && have('shears'))) {
        await enterPen(ctx, pen)
        if (plan.shear && have('shears')) res.sheared = (await shear(ctx, pen)).sheared
        for (const b of plan.breed) {
          try { const r = await breed(ctx, pen, b.species, b.pairs); res.bred[b.species] = r.babies } catch (e) { if (e.name === 'Missing') { res.missing = Object.assign(res.missing || {}, e.needs) } else throw e }
        }
        for (const c of plan.cull) { const r = await cull(ctx, pen, c.species, c.n); if (r.killed) res.culled[c.species] = r.killed }
      }
    } finally {
      try { await leavePen(null, pen) } catch (e) { log('leave pen: ' + e.message) }
    }
    pen.last = { at: now(), counts: statusOf(pen), winter: winter() }
    save()
    return res
  }
  // breed blocks last 30 minutes, then it tries again (a season changes or the food was missing)
  const activeBlocks = (pen) => { const o = {}; for (const [sp, t] of Object.entries(pen.breedBlocked || {})) if (now() - t < 30 * 60000) o[sp] = true; return o }

  // ======================================================================= glow lichen
  // The farm is a plain stone wall (site: lower middle block x,y,z; fx,fz = the way the open air is; w x h blocks). Lichen blocks sit in the air layers in front of it.
  const lichenBox = (s) => {
    const alongX = s.fz !== 0, pad = 2
    const xs = [s.x, s.x + s.fx * 2], zs = [s.z, s.z + s.fz * 2]
    const half = Math.floor(s.w / 2)
    return {
      x0: Math.min(...xs) - (alongX ? half + pad : pad), x1: Math.max(...xs) + (alongX ? half + pad : pad),
      z0: Math.min(...zs) - (alongX ? pad : half + pad), z1: Math.max(...zs) + (alongX ? pad : half + pad),
      y0: s.y - pad, y1: s.y + s.h - 1 + pad
    }
  }
  function lichenBlocks(s) {
    const b = lichenBox(s), out = []
    for (let x = b.x0; x <= b.x1; x++) for (let y = b.y0; y <= b.y1; y++) for (let z = b.z0; z <= b.z1; z++) {
      const blk = blockAt({ x, y, z })
      if (!blk || blk.name !== 'glow_lichen') continue
      const props = blk.getProperties ? blk.getProperties() : {}
      out.push({ block: blk, pos: blk.position, faces: Math.max(1, FACES.filter(f => props[f] === true).length) })
    }
    return out
  }
  const lichenCount = (s) => { const l = lichenBlocks(s); return { blocks: l.length, faces: l.reduce((a, x) => a + x.faces, 0) } }
  const lichenStand = (s) => ({ x: s.x + s.fx * 2, y: s.y, z: s.z + s.fz * 2 })

  async function lichenSeed(ctx, s) {
    if (!have('glow_lichen')) throw new Missing({ glow_lichen: 1 })
    const wall = blockAt({ x: s.x, y: s.y, z: s.z })
    if (!wall || !sv.WALL.test(wall.name)) throw new Error('the lichen wall is gone')
    await near(ctx, lichenStand(s), 1, 'lichen wall', 30000)
    if (!(await see(ctx, wall, 'lichen wall'))) throw new Error('no line of sight to the lichen wall')
    await equip('glow_lichen')
    try { await bot.placeBlock(wall, new Vec3(s.fx, 0, s.fz)) } catch (e) { log('place lichen: ' + e.message) }
    await wait(ctx, 150)
    return lichenCount(s).blocks > 0
  }

  async function lichenGrow(ctx, s) {
    let used = 0, stalls = 0
    while (used < C.lichen.maxBoneMealPerRun && stalls < 3 && have('bone_meal') > 0) {
      ctx && ctx.checkpoint(); guard()
      const c = lichenCount(s)
      if (c.faces >= C.lichen.target) break
      const list = lichenBlocks(s).sort((a, b) => a.faces - b.faces)           // the thinnest patch first: that is where it spreads
      const t = list[used % list.length]
      if (dist(t.pos) > C.reach - 0.5) await near(ctx, lichenStand(s), 1, 'lichen', 30000)
      const blk = blockAt(t.pos)
      if (!blk || !(await see(ctx, blk, 'lichen'))) { stalls++; continue }
      await equip('bone_meal')
      try { await bot.lookAt(t.pos.offset(0.5, 0.5, 0.5), true) } catch { /* aim is best effort */ }
      await bot.activateBlock(blk)
      used++
      await wait(ctx, 200)
      const after = lichenCount(s)
      if (after.faces > c.faces) { stalls = 0; state.stats.lichenGrown += after.faces - c.faces } else stalls++
    }
    return { used }
  }

  // shear everything but the `keep` blocks nearest the middle of the wall (they are the seed), then walk over the drops
  async function lichenHarvest(ctx, s) {
    if (!have('shears')) return { harvested: 0, why: 'no shears' }
    const list = lichenBlocks(s)
    if (list.length <= C.lichen.keep) return { harvested: 0 }
    const mid = new Vec3(s.x + s.fx + 0.5, s.y + (s.h - 1) / 2 + 0.5, s.z + s.fz + 0.5)
    list.sort((a, b) => b.pos.offset(0.5, 0.5, 0.5).distanceTo(mid) - a.pos.offset(0.5, 0.5, 0.5).distanceTo(mid))        // farthest first
    const toCut = list.slice(0, list.length - C.lichen.keep)
    let cut = 0, faces = 0
    await near(ctx, lichenStand(s), 1, 'lichen wall', 30000)
    for (const t of toCut) {
      ctx && ctx.checkpoint(); guard()
      const blk = blockAt(t.pos); if (!blk || blk.name !== 'glow_lichen') continue
      if (dist(t.pos) > C.reach - 0.5) await near(ctx, lichenStand(s), 1, 'lichen wall', 20000)
      if (!(await see(ctx, blk, 'lichen'))) continue
      await equip('shears')
      try { await bot.dig(blk, true) } catch (e) { log('shear lichen: ' + e.message); continue }
      cut++; faces += t.faces
    }
    await collect(ctx, lichenStand(s), 6)
    state.stats.lichenHarvested += faces
    return { harvested: cut, faces }
  }

  async function tendLichen(ctx, s) {
    guard()
    const res = { site: s.id, seeded: false, grown: 0, harvested: 0 }
    if (lichenCount(s).blocks === 0) { try { res.seeded = await lichenSeed(ctx, s) } catch (e) { if (e.name === 'Missing') res.missing = e.needs; else throw e } }
    if (lichenCount(s).blocks > 0) {
      const before = lichenCount(s).faces
      await lichenGrow(ctx, s)
      res.grown = Math.max(0, lichenCount(s).faces - before)
      if (lichenCount(s).faces >= C.lichen.target) res.harvested = (await lichenHarvest(ctx, s)).harvested
    }
    s.last = { at: now(), ...lichenCount(s) }
    save()
    return res
  }

  // ======================================================================= planning, running
  function planPen(opts = {}) {
    const avoid = state.pens.map(p => { const b = bp.boxOf(p); return { x0: b.x0 - 1, x1: b.x1 + 1, z0: b.z0 - 1, z1: b.z1 + 1 } })
    const site = sv.findPenSite(bot, { w: C.pen.w, d: C.pen.d, radius: C.pen.siteRadius, maxDy: C.pen.maxDy, minGrass: C.pen.minGrass, center: opts.center, avoid })
    if (!site) return { ok: false, why: sv.penSiteWhy() }
    const pen = { id: `pen${state.pens.length + 1}`, ox: site.ox, oy: site.oy, oz: site.oz, w: site.w, d: site.d, wood: opts.wood || C.pen.wood, built: false, lit: false, createdAt: now() }
    state.pens.push(pen); save()
    return { ok: true, pen }
  }
  function planLichen(opts = {}) {
    const wall = sv.findLichenWall(bot, { w: C.lichen.wallW, h: C.lichen.wallH, radius: C.lichen.siteRadius, center: opts.center })
    if (!wall) return { ok: false, why: 'no plain stone wall with open air in front nearby' }
    const site = { id: `lichen${state.lichen.length + 1}`, x: wall.x, y: wall.y, z: wall.z, fx: wall.fx, fz: wall.fz, w: wall.w, h: wall.h, createdAt: now() }
    state.lichen.push(site); save()
    return { ok: true, site }
  }

  async function guardedRun(fn) {
    if (running) return { ok: false, why: 'already running' }
    running = true; stopFlag = false
    try { return await fn() } catch (e) {
      if (e.name === 'Danger') { note('husbandry paused: ' + e.why); return { ok: false, why: e.why, danger: true } }
      if (e.name === 'Missing') { note(e.message); return { ok: false, why: e.message, needs: e.needs } }
      if (e.name === 'AbortError' || (e && e.aborted)) throw e
      log('husbandry error: ' + (e.stack || e.message)); return { ok: false, why: e.message }
    } finally { running = false; state.lastRun = now(); save() }
  }

  // task entry points (they all take the scheduler ctx)
  const runBuild = (ctx, opts = {}) => guardedRun(async () => {
    let pen = state.pens.find(p => !p.built)
    if (!pen && state.pens.length && !opts.another) return { ok: false, why: `${state.pens[0].id} is already standing (say "build another animal pen" for a second one)` }
    if (!pen) { const r = planPen(); if (!r.ok) return { ok: false, why: 'no pen site: ' + r.why }; pen = r.pen; note(`pen: site ${pen.ox},${pen.oy},${pen.oz} (${pen.w}x${pen.d})`) }
    const r = await buildPen(ctx, pen)
    return { ok: true, pen: pen.id, ...r }
  })
  // a run that was cut short by danger is retried soon; any other end (done, nothing to do, missing items) waits for the interval
  const runTend = async (ctx) => {
    const r = await guardedRun(async () => {
      const pens = state.pens.filter(p => p.built)
      if (!pens.length) return { ok: false, why: 'no built pen' }
      const out = []
      for (const p of pens) out.push(await tendPen(ctx, p))
      state.lastResult = { at: now(), pens: out.map(o => ({ pen: o.pen, lured: o.lured, bred: o.bred, culled: o.culled, sheared: o.sheared, missing: o.missing })) }
      return { ok: true, pens: out }
    })
    if (!r.danger) { state.lastRunTend = now(); save() }
    return r
  }
  const runLichen = async (ctx) => {
    const r = await guardedRun(async () => {
      if (!state.lichen.length) { const p = planLichen(); if (!p.ok) return { ok: false, why: p.why } }
      const out = []
      for (const s of state.lichen) out.push(await tendLichen(ctx, s))
      return { ok: true, sites: out }
    })
    if (!r.danger) { state.lastRunLichen = now(); save() }
    return r
  }

  const dueTend = () => !running && !isNight() && state.pens.some(p => p.built) && now() - (state.lastRunTend || 0) >= C.routineIntervalMs
  // lichen is worth a visit when bone meal or shears are in the bag, at most every routine interval
  const dueLichen = () => !running && state.lichen.length > 0 && (have('bone_meal') > 0 || have('glow_lichen') > 0) && now() - (state.lastRunLichen || 0) >= C.routineIntervalMs

  function snapshot() {
    return {
      running, winter: winter(), pens: state.pens.map(p => ({ id: p.id, at: [p.ox, p.oy, p.oz], size: `${p.w}x${p.d}`, built: !!p.built, lit: !!p.lit, counts: p.last ? p.last.counts : null, blocked: Object.keys(activeBlocks(p)) })),
      lichen: state.lichen.map(s => ({ id: s.id, at: [s.x, s.y, s.z], last: s.last || null })),
      stats: state.stats, last, lastResult: state.lastResult,
      bag: { fence: bot.inventory.items().filter(i => /_fence$/.test(i.name)).reduce((a, i) => a + i.count, 0), wheat: have('wheat'), shears: have('shears') > 0, bone_meal: have('bone_meal'), glow_lichen: have('glow_lichen') }
    }
  }

  return {
    buildPen, tendPen, enterPen, leavePen, lure, breed, cull, shear, tendLichen, lichenCount, lichenBlocks, lichenSeed, lichenGrow, lichenHarvest, planPen, planLichen,
    runBuild, runTend, runLichen, dueTend, dueLichen, snapshot, census: censusOf,
    abort() { stopFlag = true; halt() }, isRunning: () => running, fedAt, danger
  }
}
module.exports.Danger = Danger
module.exports.Missing = Missing
