// Tree farming engine: find a full-grown tree, chop all of it (tall ones from a temporary dirt pillar that is dug away again),
// pick up the drops, replant a sapling on every trunk base, and put logs/saplings away. See README.md.
// Walter's rules: only trees are cut (natural leaves, standing on soil) and only blocks in plain view are touched (line of sight for
// every dig, placement and chest), a pillar block is only ever removed if we placed it, nothing is left lying on the ground, the lava
// bucket is never in hand while moving, chat only when something changed.
const { Vec3 } = require('vec3')
const T = require('./trees')
const util = require('../util')
const L = require('./layout')
const createFarm = require('./farm')
const createTorches = require('../lighting/torches')
const motor = require('../motor')

const HOSTILE = /^(zombie|skeleton|creeper|spider|cave_spider|husk|drowned|witch|pillager|vindicator|phantom|slime|silverfish|enderman|zombie_villager|stray|bogged|breeze)$/
const CHEST_NAMES = new Set(['chest', 'trapped_chest', 'barrel'])
const AXE_RANK = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']
const plainSleep = (ms) => new Promise(r => setTimeout(r, ms))
const key = T.key
const isItem = (e) => !!e && (e.name === 'item' || e.displayName === 'Item')

class Danger extends Error { constructor(why) { super(why); this.why = why } }
class Full extends Error { constructor(storageFull) { super('inventory full'); this.storageFull = storageFull } }

// sitesFn() -> [{ name, x, y, z, radius }]; canSee(block) / ensureLineOfSight({ctx,target,label}) are the shared api helpers (INTERFACE section 10).
module.exports = function createEngine({ bot, say, goals, tryGoto, safehand, stopNav = () => {}, gotoNear = null, canSee = null, ensureLineOfSight = null, depositSmeltables = null, requestChest = null, config: C, state: S, save, sitesFn = () => [], now = Date.now, log = () => {} }) {
  let running = false, stopFlag = false, noAxeLogged = false, last = null
  const note = (m) => { last = { at: now(), msg: m }; log(m) }
  const halt = () => { try { stopNav() } catch { /* nothing to stop */ } }

  // ---------- small helpers ----------
  const counts = () => { const o = {}; for (const i of bot.inventory.items()) o[i.name] = (o[i.name] || 0) + i.count; return o }
  const have = (n) => bot.inventory.items().filter(i => i.name === n).reduce((s, i) => s + i.count, 0)
  const countWhere = (pred) => bot.inventory.items().filter(i => pred(i.name)).reduce((s, i) => s + i.count, 0)
  const logsInBag = () => countWhere(n => !!T.logSpecies(n))
  const eye = () => bot.entity.position.offset(0, 1.62, 0)
  const inReach = (p) => eye().distanceTo(p.offset(0.5, 0.5, 0.5)) <= C.reach
  const isNight = () => !!(bot.time && bot.time.timeOfDay >= C.dayEnd)
  const addPending = (p, species, strict = false) => { if (!S.pending.some(e => e.x === p.x && e.y === p.y && e.z === p.z)) S.pending.push({ x: p.x, y: p.y, z: p.z, species, at: now(), ...(strict ? { strict: true } : {}) }) }
  const dropPending = (e) => { S.pending = S.pending.filter(x => x !== e) }
  const seeNow = (b) => !!b && !!canSee && canSee(b)        // Walter's rule: no clear ray from the eye, no action (and without the helper, no action at all)

  function danger() {
    if (bot.health < C.minHealth) return `my health is ${Math.round(bot.health)}/20`
    const m = bot.nearestEntity && bot.nearestEntity(e => HOSTILE.test(e.name || '') && e.position.distanceTo(bot.entity.position) < C.dangerRadius)
    return m ? `a ${m.name} is near` : null
  }
  const guard = () => { const d = danger(); if (d) throw new Danger(d) }

  // ---------- movement (abortable; the hand is made safe first) ----------
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
  async function near(ctx, pos, radius, label, ms = 60000) {
    await safehand.ensureSafeForMove()
    return (gotoNear || ((o) => util.gotoNear({ bot, goals, tryGoto, stop: stopNav, ...o })))({ pos, radius, label, ctx, ms })
  }
  // A view of the block: walks to a spot with a clear ray (never digs). While standing on the pillar we do not walk anywhere.
  async function see(ctx, block, label) {
    if (!block || !canSee) return false
    if (canSee(block)) return true
    if (S.pillar || !ensureLineOfSight) return false
    await safehand.ensureSafeForMove()
    return !!(await ensureLineOfSight({ ctx, target: block, label }))
  }

  // ---------- tools and items ----------
  async function equipAxe() {
    const axes = bot.inventory.items().filter(i => /_axe$/.test(i.name))
    axes.sort((a, b) => AXE_RANK.indexOf(a.name.replace('_axe', '')) - AXE_RANK.indexOf(b.name.replace('_axe', '')))
    const want = axes[0]
    if (want && (!bot.heldItem || bot.heldItem.name !== want.name)) await bot.equip(want, 'hand')
    return !!want
  }
  async function equipShovel() {
    const sh = bot.inventory.items().find(i => /_shovel$/.test(i.name))
    if (sh && (!bot.heldItem || bot.heldItem.name !== sh.name)) { try { await bot.equip(sh, 'hand') } catch { /* dig by hand */ } }
  }
  const scaffoldItem = () => { for (const n of C.scaffold) { const it = bot.inventory.items().find(i => i.name === n); if (it) return it } return null }
  const scaffoldCount = () => countWhere(n => C.scaffold.includes(n))

  // ---------- chests ----------
  const chestBlock = (pos) => { const b = bot.blockAt(new Vec3(pos[0], pos[1], pos[2])); return b && CHEST_NAMES.has(b.name) ? b : null }
  async function openChest(ctx, pos) {
    const chest = chestBlock(pos)
    if (!chest) return { why: `no chest at ${pos.join(', ')}` }
    if (!(await near(ctx, chest.position, 3, 'the wood chest', 90000))) return { why: `could not reach the chest at ${pos.join(', ')}` }
    if (!(await see(ctx, chest, 'the wood chest'))) return { why: `no clear line to the chest at ${pos.join(', ')}` }
    try { return { chest, win: await bot.openContainer(chest) } } catch (e) { return { why: `could not open the chest at ${pos.join(', ')}: ${e.message}` } }
  }
  // Take up to n items whose name satisfies pred out of the storage chests.
  const fetchMiss = new Map()                                                  // what kind of item the chests did not have, so a far job does not walk to them again and again
  async function fetch(ctx, pred, n, kind = null) {
    if (kind && (fetchMiss.get(kind) || 0) > now()) return 0
    if (C.takeFromChests === false) return 0                                   // Walter can switch fetching (saplings, dirt for the pillar) off in config.json
    const before = countWhere(pred)
    for (const pos of C.storage) {
      if (countWhere(pred) - before >= n) break
      const o = await openChest(ctx, pos)
      if (!o.win) { log(o.why); continue }
      try {
        for (const it of o.win.containerItems().filter(i => pred(i.name))) {
          const need = n - (countWhere(pred) - before); if (need <= 0) break
          try { await o.win.withdraw(it.type, null, Math.min(need, it.count)) } catch (e) { log(`withdraw ${it.name}: ${e.message}`) }
        }
      } finally { try { o.win.close() } catch { /* already closed */ } }
    }
    const got = countWhere(pred) - before
    if (kind && got === 0) fetchMiss.set(kind, now() + 30 * 60000)           // the chests had none: do not walk there again for 30 minutes
    return got
  }
  // Put `want` ({name: n}) into the first storage chest with room. Returns { moved, left }.
  async function storeInChests(ctx, want, positions = C.storage) {
    const moved = {}, left = { ...want }
    for (const pos of positions) {
      if (!Object.keys(left).length) break
      const o = await openChest(ctx, pos)
      if (!o.win) { log(o.why); continue }
      try {
        for (const [name, n] of Object.entries({ ...left })) {
          const it = bot.inventory.items().find(i => i.name === name); if (!it) { delete left[name]; continue }
          const before = have(name)
          try { await o.win.deposit(it.type, null, n) } catch (e) { log(`chest refused ${name}: ${e.message}`) }
          const d = before - have(name)
          if (d > 0) { moved[name] = (moved[name] || 0) + d; left[name] = n - d; if (left[name] <= 0) delete left[name] }
        }
      } finally { try { o.win.close() } catch { /* already closed */ } }
    }
    return { moved, left }
  }

  // Logs above keepLogs go to the furnace input chests through the shared helper (it also decides what else is smeltable); whatever
  // that leaves, plus saplings and sticks above the keep amounts, goes to the wood chests. Nothing is ever dropped on the ground.
  async function unload(ctx, sum) {
    let plan = T.planUnload(counts(), C)
    if (plan.logCount && depositSmeltables) {
      try {
        const r = await depositSmeltables({ ctx, force: true, quiet: true })
        for (const [n, c] of Object.entries((r && r.moved) || {})) if (T.logSpecies(n)) sum.toFurnace += c
        if (r && (r.full || r.cantReach)) sum.furnaceFull = true
      } catch (e) { if (e && e.name === 'AbortError') throw e; log(`depositSmeltables: ${e.message}`) }
      plan = T.planUnload(counts(), C)
    }
    const want = { ...plan.saplings, ...plan.logs, ...plan.leaves }
    if (plan.sticks) want.stick = plan.sticks
    if (!Object.keys(want).length) return { ok: true }
    const r = await storeInChests(ctx, want)
    for (const [n, c] of Object.entries(r.moved)) {
      if (T.logSpecies(n)) sum.toChest += c
      else if (T.SAPLING_NAMES.has(n)) sum.saplingsStored += c
    }
    const stuckLogs = Object.keys(r.left).some(n => T.logSpecies(n))
    if (stuckLogs) sum.storageFull = true
    return { ok: !Object.keys(r.left).length }
  }

  // ---------- drops ----------
  async function collectDrops(ctx, center, radius = 8, max = 14, extra = null) {
    const ignore = new Set()
    for (let i = 0; i < max; i++) {
      ctx.checkpoint()
      if (bot.inventory.emptySlotCount() < 1) return
      const it = bot.nearestEntity(e => isItem(e) && !ignore.has(e.id) && (T.WANTED_DROP(T.droppedName(e)) || (!!extra && extra.includes(T.droppedName(e)))) && e.position.distanceTo(center) <= radius)
      if (!it) return
      ignore.add(it.id)
      await goto(ctx, new goals.GoalNear(it.position.x, it.position.y, it.position.z, 0.7), 'a drop', 5000)
    }
  }

  // ---------- the work-site chest (Walter's time-economy rule) ----------
  // On a job far from the final chests, a chest in the bag is placed next to the trees, wood goes into it when the bag fills, and one
  // haul to the final chests happens at the end (the chest is picked up again). The ledger lives in the state file so a restart can finish.
  const W = C.worksite || {}
  const chestInBag = () => bot.inventory.items().find(i => i.name === 'chest')
  const storageDistance = (from = bot.entity.position) => C.storage.reduce((m, pos) => Math.min(m, from.distanceTo(new Vec3(pos[0], pos[1], pos[2]))), Infinity)
  const useWorksite = () => !!W.enabled && (!!S.worksite || !!chestInBag()) && storageDistance() > (W.minDistance ?? 40)

  async function placeWorksite(ctx) {
    const item = chestInBag(); if (!item) return false
    const me = bot.entity.position.floored(), cands = []
    for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) for (let dy = -1; dy <= 1; dy++) {
      const d = Math.hypot(dx, dz); if (d < 2 || d > 5) continue
      const floor = me.offset(dx, dy - 1, dz), cell = floor.offset(0, 1, 0)
      const fb = bot.blockAt(floor)
      if (!fb || fb.boundingBox === 'empty' || T.isLeaves(fb) || T.logSpecies(fb.name)) continue
      if (!T.isAir(bot.blockAt(cell)) || !T.isAir(bot.blockAt(cell.offset(0, 1, 0)))) continue
      if (S.pending.some(e => e.x === cell.x && e.y === cell.y && e.z === cell.z)) continue
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => T.logSpecies((bot.blockAt(cell.offset(a, 0, b)) || {}).name))) continue     // out of the way of the trunk
      cands.push({ floor, cell, d })
    }
    cands.sort((a, b) => a.d - b.d)
    for (const c of cands.slice(0, 6)) {
      ctx.checkpoint()
      const fb = bot.blockAt(c.floor)
      if (!(await see(ctx, fb, 'a spot for the work-site chest'))) continue          // placing needs a clear line like everything else
      try { await bot.equip(item, 'hand'); await bot.placeBlock(fb, new Vec3(0, 1, 0)) } catch (e) { log(`worksite place: ${e.message}`) }
      await ctx.sleep(C.plantWaitMs)
      const b = bot.blockAt(c.cell)
      if (b && b.name === 'chest') { S.worksite = { x: c.cell.x, y: c.cell.y, z: c.cell.z, ledger: {}, at: now() }; save(); note(`work-site chest at ${key(c.cell)}`); return true }
    }
    return false
  }
  // Put the wood we can spare into the work-site chest. true when something went in.
  async function toWorksite(ctx, sum) {
    if (!S.worksite && !(await placeWorksite(ctx))) return false
    const plan = T.planUnload(counts(), C), want = { ...plan.saplings, ...plan.logs }
    if (plan.sticks) want.stick = plan.sticks
    if (!Object.keys(want).length) return false
    const w = S.worksite
    const r = await storeInChests(ctx, want, [[w.x, w.y, w.z]])
    for (const [n, c] of Object.entries(r.moved)) w.ledger[n] = (w.ledger[n] || 0) + c
    save()
    if (Object.keys(r.moved).length) sum.worksiteUsed = true
    return Object.keys(r.moved).length > 0
  }
  // Take everything back out; once the chest is empty, pick it up again. true when the work site is gone.
  async function haulWorksite(ctx, sum) {
    const w = S.worksite; if (!w) return true
    const pos = [w.x, w.y, w.z], block = chestBlock(pos)
    if (!block) { S.worksite = null; save(); return true }                       // the chest is gone: nothing to haul
    const o = await openChest(ctx, pos)
    if (!o.win) { log(o.why); return false }
    let rest = []
    try {
      for (const it of o.win.containerItems()) {
        try { await o.win.withdraw(it.type, null, it.count) } catch (e) { log(`worksite withdraw ${it.name}: ${e.message}`) }
      }
      rest = o.win.containerItems()
    } finally { try { o.win.close() } catch { /* already closed */ } }
    w.ledger = {}; for (const it of rest) w.ledger[it.name] = (w.ledger[it.name] || 0) + it.count
    save()
    if (rest.length) return false                                                // the bag filled up: unload, then come back for the rest
    if (!(await see(ctx, block, 'the work-site chest'))) return false
    await equipAxe()
    try { await bot.dig(block, true) } catch (e) { ctx.checkpoint(); log(`worksite pick up: ${e.message}`); return false }
    await ctx.sleep(C.dropWaitMs)
    await collectDrops(ctx, block.position.offset(0.5, 0, 0.5), 4, 4)
    S.worksite = null; save()
    sum.hauled = true
    return true
  }
  // End of a job: bring the work-site chest's contents to the final chests (as often as the bag needs), then unload the rest.
  async function finalUnload(ctx, sum) {
    for (let i = 0; S.worksite && i < 4; i++) { await haulWorksite(ctx, sum); await unload(ctx, sum) }
    if (S.worksite) sum.worksiteLeft = true
    else await unload(ctx, sum)
  }

  // ---------- planting ----------
  // strict: only that species (a tree farm is one species; a grove in the woods takes what it has)
  function pickSapling(species, strict = false) {
    const items = bot.inventory.items().filter(i => T.SAPLING_NAMES.has(i.name))
    return items.find(i => i.name === T.SAPLING[species]) || (strict ? null : items.filter(i => !T.BIG.has(T.saplingSpecies(i.name))).sort((a, b) => b.count - a.count)[0]) || null
  }
  async function ensureSapling(ctx, species, strict = false) {
    if (pickSapling(species, strict)) return true
    if (!(await fetch(ctx, n => n === T.SAPLING[species], C.keepSaplings, 'sapling:' + species)) && !strict) await fetch(ctx, n => T.SAPLING_NAMES.has(n) && !T.BIG.has(T.saplingSpecies(n)), C.keepSaplings, 'sapling:any')
    return !!pickSapling(species, strict)
  }
  // Stand next to the soil under `p` (never inside the cell we plant in).
  async function standNear(ctx, p) {
    if (!(await near(ctx, p.offset(0, -1, 0), 3, 'a sapling spot', 60000))) return false
    const f = bot.entity.position.floored()
    if (f.x === p.x && f.z === p.z && Math.abs(f.y - p.y) <= 1) {
      for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
        const r = await goto(ctx, new goals.GoalNear(p.x + dx, p.y, p.z + dz, 1), 'a sapling spot', 15000)
        const g = bot.entity.position.floored()
        if (r.ok && !(g.x === p.x && g.z === p.z)) return true
      }
      return false
    }
    return true
  }
  // Plant `species` (or any sapling we have) on the soil under p. true | false | 'nosapling'
  async function plantAt(ctx, p, species, { strict = false } = {}) {
    if (!(await ensureSapling(ctx, species, strict))) return 'nosapling'
    const floor = bot.blockAt(p.offset(0, -1, 0))
    if (!floor || !T.isSoil(floor)) { log(`plant ${key(p)}: floor is ${floor && floor.name}`); return false }
    if (!(await standNear(ctx, p))) { log(`plant ${key(p)}: no standing place (${bot._lastGotoErr || 'no path'}; bot at ${bot.entity.position.floored()})`); return false }
    for (let i = 0; i < C.replantTries; i++) {
      ctx.checkpoint()
      const cur = bot.blockAt(p)
      if (cur && T.saplingSpecies(cur.name)) return true
      if (!cur || !T.isAir(cur)) { log(`plant ${key(p)}: cell holds ${cur && cur.name}`); return false }
      if (!(await see(ctx, floor, 'a sapling spot'))) { log(`plant ${key(p)}: no clear line to the soil`); return false }          // no clear line to the soil: do not place through anything
      const sap = pickSapling(species, strict); if (!sap) return 'nosapling'
      try { await bot.equip(sap, 'hand'); await bot.placeBlock(floor, new Vec3(0, 1, 0)) } catch (e) { log(`plant ${key(p)}: ${e.message}`) }
      await ctx.sleep(C.plantWaitMs)
      const after = bot.blockAt(p)
      if (after && T.saplingSpecies(after.name)) { S.stats.planted++; return true }
      log(`plant ${key(p)}: try ${i + 1} left ${after && after.name}`)
    }
    return false
  }
  async function replantPending(ctx, sum) {
    for (const e of [...S.pending]) {
      ctx.checkpoint()
      if (now() - (e.at || 0) > 7 * 86400000) { dropPending(e); continue }
      const p = new Vec3(e.x, e.y, e.z)
      const cur = bot.blockAt(p), floor = bot.blockAt(p.offset(0, -1, 0))
      if (!cur || !floor) continue                                   // chunk not loaded now: keep it for later
      if (T.saplingSpecies(cur.name) || !T.isAir(cur) || !T.isSoil(floor)) { dropPending(e); continue }   // already planted, or something else is there now
      const r = await plantAt(ctx, p, e.species, { strict: !!e.strict })
      if (r === true) { sum.planted++; dropPending(e) } else if (r === 'nosapling') { sum.noSapling++; break } else sum.failedPlant++
      save()
    }
  }

  // ---------- the pillar (a way up for tall trees; dug away again from the top) ----------
  // Jump and put a block under our feet at the top of the jump. true when we are one block higher.
  async function pillarUp(ctx) {
    const mat = scaffoldItem(); if (!mat) return false
    const cell = bot.entity.position.floored()
    const ref = bot.blockAt(cell.offset(0, -1, 0))
    if (!ref || ref.boundingBox === 'empty') return false
    const startY = bot.entity.position.y
    const eq = await motor.equip(bot, mat); if (!eq.ok) { log(`pillar: ${eq.reason}`); return false }
    // the one jump-and-place implementation (brain/motor); an abort inside it propagates as the task's own AbortError
    const r = await motor.jumpPlaceUnder(bot, { ref, feetY: Math.floor(startY + 1e-6), held: eq.value, reequip: () => motor.equip(bot, mat), checkpoint: () => ctx.checkpoint(), log })
    if (!r.ok) log(`pillar place: ${r.reason}`)
    const nb = bot.blockAt(cell)
    if (nb && nb.name === mat.name && bot.entity.position.y >= startY + 0.9) { S.pillar.placed.push(key(cell)); save(); return true }
    return false
  }
  // Dig our own pillar blocks away from the top, falling one block each time. ctx may be null (aborted task: bounded, not abortable).
  async function descend(ctx) {
    const pl = S.pillar; if (!pl) return true
    const sleep = ctx ? (ms) => ctx.sleep(ms) : plainSleep
    const until = Date.now() + C.descendMaxMs
    while (pl.placed.length && Date.now() < until) {
      if (ctx) ctx.checkpoint()
      const under = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
      if (!under || !pl.placed.includes(key(under.position))) break          // not standing on a block we placed
      const y0 = bot.entity.position.y
      await equipShovel()
      try { await bot.dig(under, true) } catch (e) { log(`pillar dig: ${e.message}`); break }
      pl.placed = pl.placed.filter(k => k !== key(under.position))
      for (let i = 0; i < 60 && bot.entity.position.y > y0 - 0.9 && Date.now() < until; i++) await sleep(50)      // the fall is ~0.3 s; a slow server or a loaded machine gets up to 3 s before the next block is dug
      save()
    }
    // forget placed blocks that are gone (picked up by someone, fell off) so a stale list never makes us dig natural ground
    pl.placed = pl.placed.filter(k => { const [x, y, z] = k.split(',').map(Number); const b = bot.blockAt(new Vec3(x, y, z)); return b && C.scaffold.includes(b.name) })
    if (!pl.placed.length) S.pillar = null
    save()
    return !S.pillar
  }

  // One step up inside the trunk column. false when we cannot (no blocks, no room, too high).
  async function raise(ctx, tree, sum, col = tree.trunk) {
    if (!S.pillar) {
      const base = bot.blockAt(col)
      if (!base || !T.isAir(base)) return false                                // the base log is still there: not diggable from here
      const need = Math.min(C.maxPillar, Math.max(2, tree.logs[tree.logs.length - 1].y - col.y - 2))
      if (scaffoldCount() < need) await fetch(ctx, n => C.scaffold.includes(n), need - scaffoldCount(), 'scaffold')
      if (!scaffoldItem()) { sum.noScaffold = true; return false }
      const r = await goto(ctx, new goals.GoalBlock(col.x, col.y, col.z), 'inside the trunk', 15000)
      const f = bot.entity.position.floored()
      if (!r.ok || f.x !== col.x || f.z !== col.z) return false
      S.pillar = { x: col.x, y: col.y, z: col.z, placed: [] }; save()
    }
    if (S.pillar.placed.length >= C.maxPillar) return false
    const f = bot.entity.position.floored()
    if (f.x !== S.pillar.x || f.z !== S.pillar.z) return false
    for (const dy of [1, 2]) {                                                // two free cells above the head for the jump
      const b = bot.blockAt(f.offset(0, dy, 0))
      if (T.isAir(b)) continue
      if (b && b.name === tree.logName && seeNow(b) && await digLog(ctx, b.position)) continue
      if (b && T.naturalLeaves(b) && inReach(b.position) && seeNow(b)) {            // the tree's own canopy in the way of the jump
        try { await equipAxe(); await bot.dig(b, true); sum.leaves++; continue } catch (e) { ctx.checkpoint(); log(`leaf above ${key(b.position)}: ${e.message}`) }
      }
      return false
    }
    if (!scaffoldItem()) { sum.noScaffold = true; return false }
    return pillarUp(ctx)
  }

  // ---------- chopping ----------
  async function digLog(ctx, p) {
    const b = bot.blockAt(p)
    if (!b || !T.logSpecies(b.name)) return false
    if (!(await equipAxe()) && !noAxeLogged) { noAxeLogged = true; log('no axe: chopping by hand') }
    try { await bot.dig(b, true) } catch (e) { ctx.checkpoint(); log(`dig ${b.name} ${key(p)}: ${e.message}`); return false }
    return true
  }

  // The block a crosshair would hit first on the way from the eye to the log's centre.
  function firstBlockTo(p) {
    const from = eye(), c = p.offset(0.5, 0.5, 0.5), d = c.minus(from), dist = d.norm()
    if (dist < 1e-6 || !bot.world || !bot.world.raycast) return null
    const hit = bot.world.raycast(from, d.scaled(1 / dist), dist)
    return hit && hit.position ? bot.blockAt(hit.position) : null
  }
  // A log of the tree that is in reach but hidden behind the tree's own natural leaves: break the leaf the crosshair would hit first
  // (leaves are part of the tree, and they let the rest of the canopy decay). Never anything else, never a leaf that is out of reach.
  async function clearLeaf(ctx, cands) {
    for (const p of cands) {
      const b = firstBlockTo(p)
      if (!b || !T.naturalLeaves(b) || !inReach(b.position) || !seeNow(b)) continue
      try { await equipAxe(); await bot.dig(b, true) } catch (e) { ctx.checkpoint(); log(`leaf ${key(b.position)}: ${e.message}`); continue }
      return true
    }
    return false
  }

  // ---------- the canopy: break the leaves that have lost their tree ----------
  // After the last log is gone the leaves of the tree have `distance` 7 and would decay on their own. Walter: do not wait for that, stay and
  // break them by hand. Only natural leaves that are already doomed (distance 7) are touched, so the leaves of a tree next door that still
  // has logs are safe; every break is a block the crosshair hits first (line of sight).
  const leafDistance = (b) => { const p = b && typeof b.getProperties === 'function' ? b.getProperties() : null; const d = p ? Number(p.distance) : NaN; return Number.isFinite(d) ? d : NaN }
  const isDoomed = (b) => T.naturalLeaves(b) && leafDistance(b) >= 7
  function doomedLeaves(box) {
    const out = []
    for (let x = box.x0; x <= box.x1; x++) for (let y = box.y0; y <= box.y1; y++) for (let z = box.z0; z <= box.z1; z++) {
      const b = bot.blockAt(new Vec3(x, y, z))
      if (isDoomed(b)) out.push(b.position)
    }
    return out
  }
  // shears and hoes are the fast tools for leaves; a hoe (like a bare hand) lets the leaves drop saplings, sticks and apples, shears only give the leaf block.
  async function equipLeafTool() {
    for (const kind of C.leafTools || ['hoe', 'shears', 'hand']) {
      if (kind === 'hand') { if (bot.heldItem) { try { await bot.unequip('hand') } catch { /* keep what is in hand */ } } return 'hand' }
      const re = kind === 'hoe' ? /_hoe$/ : /^shears$/
      const items = bot.inventory.items().filter(i => re.test(i.name))
      items.sort((a, b) => AXE_RANK.indexOf(a.name.replace('_hoe', '')) - AXE_RANK.indexOf(b.name.replace('_hoe', '')))
      if (items[0]) { if (!bot.heldItem || bot.heldItem.name !== items[0].name) await bot.equip(items[0], 'hand'); return kind }
    }
    return null
  }
  async function breakLeaf(ctx, p) {
    const b = bot.blockAt(p)
    if (!isDoomed(b)) return false
    try { await equipLeafTool(); await bot.dig(b, true) } catch (e) { ctx.checkpoint(); log(`leaf ${key(p)}: ${e.message}`); return false }
    return true
  }
  async function clearCanopy(ctx, tree, sum) {
    if (C.clearLeaves === false || !tree.box) return
    const settle = C.leafSettleMs ?? 500, box = tree.box
    await ctx.sleep(settle)
    const dist = (p) => eye().distanceTo(p.offset(0.5, 0.5, 0.5))
    const tried = new Set()
    let budget = C.canopyBudget ?? 300, viewBudget = 10, rescans = 0, broken = 0, sinceCollect = 0
    let list = doomedLeaves(box)
    const gather = async () => { await collectDrops(ctx, bot.entity.position, 8, 12, C.leafTools && C.leafTools.includes('shears') ? ['oak_leaves', 'spruce_leaves', 'birch_leaves', 'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves', 'cherry_leaves', 'pale_oak_leaves'] : null) }
    try {
      while (budget-- > 0) {
        ctx.checkpoint(); guard()
        list = list.filter(p => isDoomed(bot.blockAt(p)))
        if (!list.length) {
          if (rescans++ < 2) { await ctx.sleep(settle); list = doomedLeaves(box); if (list.length) continue }
          break
        }
        let did = false
        for (const p of list.filter(inReach).sort((a, b) => dist(a) - dist(b)).slice(0, 12)) {
          if (!seeNow(bot.blockAt(p))) continue
          if (await breakLeaf(ctx, p)) { broken++; sinceCollect++; did = true; list = list.filter(x => !x.equals(p)); break }
        }
        if (did) {
          if (sinceCollect >= 12 && !S.pillar) { sinceCollect = 0; await gather() }       // no piles: pick the drops up as we go
          continue
        }
        if (!S.pillar && viewBudget > 0) {
          const t = list.filter(p => !tried.has(key(p)) && Math.abs(p.y - bot.entity.position.y) <= 6).sort((a, b) => dist(a) - dist(b))[0]
          if (t) { tried.add(key(t)); viewBudget--; await see(ctx, bot.blockAt(t), 'a leaf'); continue }
        }
        if (!(await raise(ctx, tree, sum, tree.trunk))) break                           // the rest is out of reach: it decays by itself
      }
    } finally { sum.leavesCleared += broken }
    if (S.pillar) { await descend(ctx); await collectDrops(ctx, bot.entity.position, 4, 12, C.scaffold) }
    await ctx.sleep(C.dropWaitMs)
    await collectDrops(ctx, new Vec3(tree.trunk.x + 0.5, tree.trunk.y, tree.trunk.z + 0.5), Math.max(10, box.x1 - box.x0), 30, null)
  }

  // Chop every log of the tree we can get to, replant its bases. Returns the number of logs cut.
  async function chopTree(ctx, tree, sum, atSite = false, siteSpecies = null) {
    const present = () => tree.logs.filter(p => { const b = bot.blockAt(p); return b && b.name === tree.logName })
    const dist = (p) => eye().distanceTo(p.offset(0.5, 0.5, 0.5))
    const byY = (a, b) => a.y - b.y || dist(a) - dist(b)
    if (!present().length) return 0
    // where its leaves can be (for the canopy pass after the felling)
    tree.box = tree.logs.reduce((b, p) => ({ x0: Math.min(b.x0, p.x - 4), x1: Math.max(b.x1, p.x + 4), y0: Math.min(b.y0, p.y - 1), y1: Math.max(b.y1, p.y + 3), z0: Math.min(b.z0, p.z - 4), z1: Math.max(b.z1, p.z + 4) }), { x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9, z0: 1e9, z1: -1e9 })
    if (!(await near(ctx, tree.trunk, 2, 'a tree', 60000))) { sum.unreachable++; return 0 }
    const viewTried = new Set()
    let cut = 0, steps = 0, viewBudget = 6, leafBudget = C.leafBudget ?? 40, usedPillar = !!S.pillar
    const maxSteps = tree.logs.length * 3 + 60 + (C.leafBudget ?? 40)
    // One pass from one column: cut what is in reach and in view, clear a hiding leaf, climb a block, repeat until nothing more can be done from here.
    async function work(col) {
      while (steps++ < maxSteps) {
        ctx.checkpoint(); guard()
        const rem = present()
        if (!rem.length) return
        let dug = false
        for (const p of rem.filter(inReach).sort(byY)) {
          if (!seeNow(bot.blockAt(p))) continue                                 // behind a leaf or another block from here
          if (await digLog(ctx, p)) { cut++; dug = true; await ctx.sleep(C.logWaitMs ?? 40); break }
        }
        if (dug) continue
        if (!S.pillar && viewBudget > 0) {                                      // on the ground: a better spot for the lowest log we have not tried
          const next = rem.slice().sort(byY).find(p => !viewTried.has(key(p)) && Math.abs(p.y - bot.entity.position.y) <= 7)
          if (next) {
            viewTried.add(key(next)); viewBudget--
            await see(ctx, bot.blockAt(next), 'a tree')
            continue                                                            // re-evaluate from the new spot
          }
        }
        if (leafBudget > 0 && await clearLeaf(ctx, rem.filter(inReach).sort(byY))) { leafBudget--; sum.leaves++; continue }
        // climbing only helps if a log that is left can ever come into reach from this column (a limb 8 blocks away cannot): otherwise stop and let the next column be picked
        { const cx = S.pillar ? S.pillar.x : col.x, cz = S.pillar ? S.pillar.z : col.z
          if (!rem.some(p => Math.hypot(p.x - cx, p.z - cz) <= C.reach - 0.3 && p.y >= bot.entity.position.y - 3)) return }
        if (!(await raise(ctx, tree, sum, col))) return
        usedPillar = usedPillar || !!S.pillar
      }
    }
    // A free ground cell near the lowest log that is still up there (a long branch is out of reach from the trunk): climb from there.
    function pickColumn(rem, tried) {
      const L = rem.slice().sort((a, b) => a.y - b.y)[0], y0 = tree.trunk.y, best = []
      for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (const dy of [0, -1, 1]) {
        const cell = new Vec3(L.x + dx, y0 + dy, L.z + dz)
        if (tried.has(key(cell))) continue
        const floor = bot.blockAt(cell.offset(0, -1, 0))
        if (!floor || floor.boundingBox === 'empty' || T.isLeaves(floor) || T.logSpecies(floor.name)) continue
        if (!T.isAir(bot.blockAt(cell)) || !T.isAir(bot.blockAt(cell.offset(0, 1, 0)))) continue
        best.push({ cell, d: Math.hypot(dx, dz) + Math.abs(dy) * 0.5 })
      }
      best.sort((a, b) => a.d - b.d)
      return best[0] ? best[0].cell : null
    }
    try {
      const triedCols = new Set([key(tree.trunk)])
      let col = tree.trunk
      for (let round = 0; round < 5; round++) {
        await work(col)
        const rem = present()
        if (!rem.length || sum.noScaffold || steps >= maxSteps) break
        if (S.pillar) { await descend(ctx); await ctx.sleep(C.fallSettleMs ?? 300); await collectDrops(ctx, bot.entity.position, 4, 12, C.scaffold) }      // the pillar blocks are needed again for the next column
        const next = pickColumn(rem, triedCols)
        if (!next) break
        triedCols.add(key(next)); col = next; viewBudget = 3
        if (!(await near(ctx, next, 1, 'under a branch', 30000))) break
      }
    } finally {
      cut && (sum.logs += cut)
    }
    ctx.checkpoint()
    const left = present().length
    if (S.pillar) { await descend(ctx); await ctx.sleep(C.fallSettleMs ?? 300) }
    ctx.checkpoint()
    if (left) sum.leftLogs += left
    log(`chopTree ${key(tree.trunk)} ${tree.species}: ${tree.logs.length} logs, cut ${cut}, left ${left}, steps ${steps}/${maxSteps}${S.pillar ? ', still on the pillar' : ''}`)
    await ctx.sleep(C.dropWaitMs)
    await collectDrops(ctx, new Vec3(tree.trunk.x + 0.5, tree.trunk.y, tree.trunk.z + 0.5), 10, 14, usedPillar ? C.scaffold : null)
    if (cut && !left) await clearCanopy(ctx, tree, sum)         // before replanting: the sapling would stand in the way of the pillar column
    const regrow = siteSpecies || (atSite && C.preferSpecies ? C.preferSpecies : tree.species)          // a lit tree farm is replanted with its own species (birch), other sites with the preferred one (spruce), the woods with what grew there
    for (const p of tree.bases) if (T.isAir(bot.blockAt(p))) addPending(p, regrow, !!siteSpecies)
    save()
    await replantPending(ctx, sum)
    if (cut) {
      sum.trees++; S.stats.trees++; S.stats.logs += cut
      if (!S.decay.some(e => e.x === tree.trunk.x && e.z === tree.trunk.z)) S.decay.push({ x: tree.trunk.x, y: tree.trunk.y, z: tree.trunk.z, at: now(), visits: 0, lastVisit: 0 })     // leaves decay on their own: come back for the saplings and apples
      save()
    }
    return cut
  }

  // The leaves of a felled tree decay by themselves a minute or two after the last log is gone and drop saplings, sticks and apples.
  // Visit every felled tree again once it has had `decayWaitMs`, up to `decayVisits` times or `decayGiveUpMs` after the felling.
  async function collectDecayed(ctx, sum) {
    const wait = C.decayWaitMs ?? 120000
    for (const e of [...S.decay]) {
      ctx.checkpoint()
      const age = now() - e.at
      if (age > (C.decayGiveUpMs ?? 1500000) || e.visits >= (C.decayVisits ?? 3)) { S.decay = S.decay.filter(x => x !== e); continue }
      if (age < wait || now() - (e.lastVisit || 0) < wait) continue
      const center = new Vec3(e.x + 0.5, e.y, e.z + 0.5)
      e.lastVisit = now(); e.visits++
      if (bot.entity.position.distanceTo(center) > 8) {
        const r = await goto(ctx, new goals.GoalNear(center.x, center.y, center.z, 5), 'a felled tree', 60000)
        if (!r.ok) continue
      }
      const before = countWhere(n => T.SAPLING_NAMES.has(n) || n === 'apple' || n === 'stick')
      await collectDrops(ctx, center, 12, 14)
      sum.decayPicked += Math.max(0, countWhere(n => T.SAPLING_NAMES.has(n) || n === 'apple' || n === 'stick') - before)
      if (e.visits >= (C.decayVisits ?? 3)) S.decay = S.decay.filter(x => x !== e)
      save()
    }
  }

  // ---------- finding trees ----------
  function discover(center, radius) {
    const ids = T.LOG_NAMES.map(n => bot.registry.blocksByName[n] && bot.registry.blocksByName[n].id).filter(Boolean)
    const pts = bot.findBlocks({ point: center, matching: ids, maxDistance: radius, count: 800 })
    const seen = new Set(), trees = []
    let skipped = 0
    for (const p of pts) {
      if (seen.has(key(p))) continue
      const t = T.scanTree(bot, p, C)
      seen.add(key(p)); for (const l of t.logs) seen.add(key(l))
      if (t.ok) trees.push(t); else skipped++
    }
    const me = bot.entity.position
    trees.sort((a, b) => a.trunk.distanceTo(me) - b.trunk.distanceTo(me))
    return { trees, skipped }
  }

  function areas(manual, center, radius) {
    if (center) return [{ name: 'here', pos: center, radius: radius || C.naturalRadius }]
    const me = bot.entity.position
    const list = (sitesFn() || []).map(s => ({ name: s.name, pos: new Vec3(s.x, s.y, s.z), radius: s.radius || C.siteRadius, site: true, species: s.species || null, farm: s.farm ? (S.farms || []).find(f => f.id === s.farm) || null : null }))
    list.sort((a, b) => a.pos.distanceTo(me) - b.pos.distanceTo(me))
    if (manual) list.push({ name: 'the woods', pos: me.floored(), radius: C.naturalRadius, natural: true })
    return list
  }

  function askForSite() {
    if (now() - (S.askedAt || 0) < C.askEveryHours * 3600000) return
    S.askedAt = now(); save()
    say('I do not know of a tree farm. Show me one (save a waypoint called "tree farm", or stand at it and say "tree farm here"), or say "chop trees" for the woods or "plant a grove" and I will start one.'.slice(0, 230))
  }

  // ---------- the job ----------
  const newSum = () => ({ trees: 0, logs: 0, planted: 0, noSapling: 0, failedPlant: 0, unreachable: 0, leftLogs: 0, skipped: 0, toFurnace: 0, toChest: 0, saplingsStored: 0, noScaffold: false, leaves: 0, leavesCleared: 0, decayPicked: 0, worksiteUsed: false, worksiteLeft: false, hauled: false, storageFull: false, furnaceFull: false, found: 0 })

  async function run(ctx, { manual = false, count = null, wantLogs = null, center = null, radius = null, followUp = false, farmOnly = false } = {}) {
    if (running) return { status: 'done' }
    running = true; stopFlag = false
    const sum = newSum()
    try {
      if (util.dimOf(bot) !== 'overworld') { if (manual) say('I only chop trees in the overworld.'); return manual ? { status: 'done' } : { status: 'retry', afterMs: 600000 } }
      await safehand.stow()
      if (!followUp) { S.lastRun = now(); save() }                      // a follow-up visit (leftover pillar, work-site chest, decay drops) does not restart the 45-minute clock
      const wasUp = !!S.pillar
      await descend(ctx)                                     // an earlier stop may have left us on the pillar
      if (wasUp) { await ctx.sleep(C.fallSettleMs ?? 300); await collectDrops(ctx, bot.entity.position, 5, 8, C.scaffold) }      // the pillar blocks fall as items and need a moment to land
      guard()
      await replantPending(ctx, sum)
      await collectDecayed(ctx, sum)
      if (farm.has() && !stopFlag) {                                           // lit farm upkeep first: empty lattice spots get a sapling, dark torch spots a torch
        try { await farm.tend(ctx, { quiet: true, sum, harvest: !followUp }) } catch (e) { if (e && (e.name === 'AbortError' || e instanceof Danger)) throw e; log(`farm tend: ${e && e.message}`) }
      }
      if (followUp) { if (!stopFlag) await finalUnload(ctx, sum); return finish(sum, false) }
      const targets = areas(manual, center, radius).filter(a => !farmOnly || a.farm)
      if (!targets.length) { if (!farmOnly) askForSite(); return { status: 'done' } }
      const cap = count || (manual ? C.maxTreesManual : C.maxTreesIdle)
      // A job far from the final chests and no chest in the bag: ask the crafting module for one (once), and come back when it is done.
      // Walter OK'd temporary chests near the tree farm. If it cannot make one the job goes ahead without (final chests as before).
      if (W.enabled && W.craft !== false && requestChest && !chestInBag() && !S.worksite && !ctx.state.chestRequested && storageDistance(targets[0].pos) > (W.minDistance ?? 40)) {
        ctx.state.chestRequested = true
        let asked = false
        try { asked = await requestChest() } catch (e) { log(`requestChest: ${e.message}`) }
        if (asked) return { status: 'retry', afterMs: W.craftWaitMs ?? 20000 }
      }
      for (const area of targets) {
        if (stopFlag || sum.trees >= cap || (wantLogs && sum.logs >= wantLogs)) break
        if (area.site && bot.entity.position.distanceTo(area.pos) > C.walkToSiteDistance) {
          const r = await goto(ctx, new goals.GoalNear(area.pos.x, area.pos.y, area.pos.z, 6), `the ${area.name}`, 90000)
          if (!r.ok) continue
        }
        const found = discover(area.natural ? bot.entity.position.floored() : area.pos, area.radius)
        if (area.farm) {                                                       // a lit lattice farm: only its own trees are cut, a natural tree next to it stays standing
          const before = found.trees.length
          found.trees = found.trees.filter(t => L.isSpot(area.farm, t.trunk.x, t.trunk.z))
          found.skipped += before - found.trees.length
        }
        sum.found += found.trees.length; sum.skipped += found.skipped
        if (area.site && !area.farm && !found.trees.length && !stopFlag) await plantEmptySite(ctx, area, sum)
        for (const tree of found.trees) {
          if (stopFlag || sum.trees >= cap || (wantLogs && sum.logs >= wantLogs)) break
          if (!manual && isNight()) { stopFlag = true; break }
          ctx.checkpoint(); guard()
          if (bot.inventory.emptySlotCount() <= C.minFreeSlots) {
            if (useWorksite()) await toWorksite(ctx, sum)                       // far from the final chests: drop it here, haul once at the end
            if (bot.inventory.emptySlotCount() <= C.minFreeSlots) await unload(ctx, sum)
            if (bot.inventory.emptySlotCount() <= C.minFreeSlots) throw new Full(sum.storageFull)
          }
          await chopTree(ctx, tree, sum, !!area.site, area.species)
        }
        if (!stopFlag) for (const a of targets.filter(x => x.site)) await collectDrops(ctx, a.pos, Math.min(a.radius, 30), 8)   // saplings/apples from decayed leaves
      }
      ctx.checkpoint()
      ctx.state.dangerRetries = 0
      if (!stopFlag) await collectDecayed(ctx, sum)
      if (!stopFlag || sum.trees || S.worksite || sum.decayPicked) await finalUnload(ctx, sum)
      if (!manual && logsInBag() >= C.stopLogsInBag) sum.storageFull = true
      return finish(sum, manual)
    } catch (e) {
      if (e && e.name === 'AbortError') throw e
      if (e instanceof Danger) {
        ctx.state.dangerRetries = (ctx.state.dangerRetries || 0) + 1
        if (ctx.state.dangerRetries > C.dangerRetries) { say(`Stopping the tree run: ${e.why}.`); finish(sum, true); return { status: 'done' } }
        if (ctx.state.dangerRetries === 1) say(`Pausing the tree run: ${e.why}. I will pick it up again shortly.`)
        return { status: 'retry', afterMs: C.dangerRetryMs }
      }
      if (e instanceof Full) {
        finish(sum, true)
        say(e.storageFull ? 'Stopping the tree run: my inventory is nearly full and the chests for wood are full. I will not leave logs on the ground; tell me where to put them.' : 'Stopping the tree run: my inventory is nearly full and I could not empty it into the chests.')
        return { status: 'done' }
      }
      log(`TREEFARM_ERROR ${e && e.stack || e}`)
      say(`Tree run stopped: ${e && e.message}`.slice(0, 200))
      return { status: 'done' }
    } finally {
      running = false
      if (S.pillar) { try { await descend(null) } catch (e) { log(`descend failed: ${e.message}`) } }     // never stay up on a pillar, even when aborted
      save()
      try { await safehand.stow() } catch { /* hand already safe */ }
    }
  }

  function finish(sum, manual) {
    S.lastResult = { at: now(), trees: sum.trees, logs: sum.logs, planted: sum.planted, noSapling: sum.noSapling, left: sum.leftLogs, pending: S.pending.length }
    note(`TREEFARM ${JSON.stringify(S.lastResult)}`)
    if (!sum.trees) {
      if (sum.decayPicked) say(`Picked up ${sum.decayPicked} sapling/apple/stick item${sum.decayPicked > 1 ? 's' : ''} where the leaves decayed.`)
      if (manual) say(sum.found ? 'I found trees but could not get to them.' : `I do not see a full-grown tree within ${C.naturalRadius} blocks${sum.skipped ? ` (${sum.skipped} log clusters were not trees: houses, stripped or too small)` : ''}.`)
      return { status: 'done' }
    }
    const parts = [`Chopped ${sum.trees} tree${sum.trees > 1 ? 's' : ''} (${sum.logs} logs), planted ${sum.planted} sapling${sum.planted === 1 ? '' : 's'}`]
    if (sum.toFurnace) parts.push(`${sum.toFurnace} logs to the furnace chests`)
    if (sum.toChest) parts.push(`${sum.toChest} logs to the wood chest`)
    if (sum.saplingsStored) parts.push(`${sum.saplingsStored} spare saplings stored`)
    if (sum.leavesCleared) parts.push(`${sum.leavesCleared} leaves cleared by hand`)
    if (sum.decayPicked) parts.push(`${sum.decayPicked} saplings/apples/sticks from decayed leaves`)
    let msg = parts.join('; ') + `. Logs on me: ${logsInBag()}.`
    if (S.pending.length) msg += ` ${S.pending.length} spot(s) still need a sapling.`
    if (sum.leftLogs) msg += ` ${sum.leftLogs} log(s) were out of reach.`
    if (sum.noScaffold) msg += ' I had no dirt to climb with.'
    if (sum.storageFull) msg += ' The wood chests are full.'
    if (sum.worksiteLeft && S.worksite) msg += ` Some wood is still in my work-site chest at ${S.worksite.x}, ${S.worksite.y}, ${S.worksite.z}.`
    say(msg.slice(0, 235))
    return { status: 'done' }
  }

  // Plant a small grove (saplings on a grid, spacing 4) around where I stand and remember it as a tree farm site.
  // Plant saplings on a grid (spacing 4) around `center` (default: where I stand). Returns how many were planted.
  async function growGrove(ctx, center, { quiet = false } = {}) {
    const G = C.grove
    if (center && bot.entity.position.distanceTo(center) > 6) {
      const r = await goto(ctx, new goals.GoalNear(center.x, center.y, center.z, 4), 'the tree farm', 90000)
      if (!r.ok) { log(`grove: could not walk to ${key(center)}: ${r.err}`); return 0 }
    }
    const c = (center || bot.entity.position).floored()                       // fixed before fetching: the chests may be elsewhere
    const pref = C.preferSpecies || 'oak'
    if (countWhere(n => n === T.SAPLING[pref]) < G.count) await fetch(ctx, n => n === T.SAPLING[pref], G.count - countWhere(n => n === T.SAPLING[pref]))
    if (!countWhere(n => T.SAPLING_NAMES.has(n))) await fetch(ctx, n => T.SAPLING_NAMES.has(n) && !T.BIG.has(T.saplingSpecies(n)), G.count)
    if (!pickSapling(pref)) { if (!quiet) say('I have no saplings for a grove. Put some in the wood chest or give me some.'); else log('grove: no saplings'); return 0 }
    if (bot.entity.position.distanceTo(c) > 8) {
      const r = await goto(ctx, new goals.GoalNear(c.x, c.y, c.z, 3), 'the tree farm', 90000)
      if (!r.ok) return 0
    }
    const spots = []
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) spots.push({ x: c.x + i * G.spacing, z: c.z + j * G.spacing })
    spots.sort((a, b) => Math.hypot(a.x - c.x, a.z - c.z) - Math.hypot(b.x - c.x, b.z - c.z))
    let planted = 0
    for (const s of spots) {
      if (planted >= G.count || stopFlag) break
      ctx.checkpoint(); guard()
      let spot = null
      for (let y = c.y + 3; y >= c.y - 4 && !spot; y--) {
        const floor = bot.blockAt(new Vec3(s.x, y, s.z)), at = bot.blockAt(new Vec3(s.x, y + 1, s.z))
        if (!T.isSoil(floor) || !T.isAir(at)) continue
        let clear = true
        for (let h = 2; h <= G.height && clear; h++) clear = T.isAir(bot.blockAt(new Vec3(s.x, y + h, s.z)))
        if (clear) spot = new Vec3(s.x, y + 1, s.z)
      }
      if (!spot) continue
      const sap = pickSapling(pref); if (!sap) break
      if ((await plantAt(ctx, spot, T.saplingSpecies(sap.name))) === true) planted++
    }
    if (planted) {
      say(`Planted ${planted} sapling${planted > 1 ? 's' : ''} ${center ? `at the tree farm (${c.x}, ${c.z})` : 'in a grove here'}. I will chop them when they have grown.`.slice(0, 230))
    } else if (!quiet) say('I could not find a good open spot to plant here.')
    else log(`grove at ${key(c)}: no open spot`)
    return planted
  }
  // "plant a grove": around where I stand, registered as a tree farm site.
  async function plantGrove(ctx) {
    if (running) return { status: 'done' }
    running = true; stopFlag = false
    try {
      if (util.dimOf(bot) !== 'overworld') { say('I only plant groves in the overworld.'); return { status: 'done' } }
      await safehand.stow()
      await descend(ctx)
      const c = bot.entity.position.floored(), planted = await growGrove(ctx, null)
      if (planted) {
        const near = S.sites.find(x => Math.hypot(x.x - c.x, x.z - c.z) < 10)
        if (near) near.at = now(); else S.sites.push({ name: 'grove', x: c.x, y: c.y, z: c.z, radius: C.grove.spacing * 3 + 4, at: now() })
        save()
      }
      return { status: 'done' }
    } catch (e) {
      if (e && e.name === 'AbortError') throw e
      if (e instanceof Danger) { say(`Stopping the grove: ${e.why}.`); return { status: 'done' } }
      log(`TREEFARM_GROVE_ERROR ${e && e.stack || e}`)
      say(`Grove stopped: ${e && e.message}`.slice(0, 200))
      return { status: 'done' }
    } finally { running = false; save(); try { await safehand.stow() } catch { /* hand already safe */ } }
  }

  // A known tree farm site with no trees and no saplings anywhere near its centre gets a grove (at most every 6 hours per site).
  async function plantEmptySite(ctx, area, sum) {
    const id = `${area.name}@${Math.round(area.pos.x)},${Math.round(area.pos.z)}`
    S.groveAt = S.groveAt || {}
    if (now() - (S.groveAt[id] || 0) < 6 * 3600000) return
    const ids = [...T.LOG_NAMES, ...Object.values(T.SAPLING)].map(n => bot.registry.blocksByName[n] && bot.registry.blocksByName[n].id).filter(Boolean)
    if (bot.findBlocks({ point: area.pos, matching: ids, maxDistance: C.grove.radius, count: 1 }).length) return        // something is growing or standing there already
    S.groveAt[id] = now(); save()
    sum.planted += await growGrove(ctx, area.pos.floored(), { quiet: true })
  }

  function abort() { stopFlag = true; halt() }

  // ---------- the lit lattice farm (farm.js, layout.js) ----------
  const torches = createTorches({ bot, canSee, log, now })
  const farm = createFarm({
    bot, say, goals, config: C, state: S, save, now, log, torches, T, L, Danger,
    eng: { goto, near, see, plantAt, pickSapling, fetch, collectDrops, guard, countWhere, isReach: inReach, unload, finalUnload, run: (ctx, o) => run(ctx, o), isRunning: () => running, halt, abortFlag: () => stopFlag }
  })

  // Routine due check (daytime, overworld). 'trees': the regular run, every `intervalMinutes` (45; Walter), or once a day to ask when no site is known.
  // 'followup': something is left to finish (a pillar to take down, a work-site chest to haul, drops where a felled tree stood): that visit
  // does not chop anything and does not restart the 45-minute clock. Manual commands never wait for any of this.
  function dueKind() {
    if (util.dimOf(bot) !== 'overworld' || !bot.time || isNight()) return null
    if (now() - (S.lastRun || 0) >= C.intervalMinutes * 60000) {
      if ((sitesFn() || []).length) return 'trees'
      if (now() - (S.askedAt || 0) >= C.askEveryHours * 3600000) return 'trees'
    }
    if (S.pillar || S.worksite) return 'followup'
    if (farm.tendDue()) return 'followup'                                     // a lit farm: replant and relight every few minutes of daylight
    const wait = C.decayWaitMs ?? 120000
    if (S.decay.some(e => now() - e.at >= wait && now() - e.at < (C.decayGiveUpMs ?? 1500000) && now() - (e.lastVisit || 0) >= wait)) return 'followup'
    return null
  }
  const due = () => dueKind() !== null

  function markSite(name = 'tree farm') {
    const p = bot.entity.position.floored()
    const near = S.sites.find(s => Math.hypot(s.x - p.x, s.z - p.z) < 12)
    if (near) { near.x = p.x; near.y = p.y; near.z = p.z; near.name = name } else S.sites.push({ name, x: p.x, y: p.y, z: p.z, radius: C.siteRadius, at: now() })
    save()
    return p
  }
  function forgetSites() { const n = S.sites.length; S.sites = []; save(); return n }

  function snapshot() {
    return {
      running, farms: S.farms.map(f => farm.status(f)), sites: (sitesFn() || []).map(s => `${s.name} (${s.x}, ${s.z})`), pendingReplants: S.pending.length, decayWatch: S.decay.length, onPillar: !!S.pillar, worksite: S.worksite ? `${S.worksite.x}, ${S.worksite.y}, ${S.worksite.z}` : null,
      lastRunAgoS: S.lastRun ? Math.round((now() - S.lastRun) / 1000) : null, lastResult: S.lastResult, stats: S.stats,
      logsInBag: logsInBag(), saplingsInBag: countWhere(n => T.SAPLING_NAMES.has(n)), last: last && { agoS: Math.round((now() - last.at) / 1000), msg: last.msg }
    }
  }

  return { run, plantGrove, growGrove, dueKind, abort, due, snapshot, markSite, forgetSites, descend, replantPending, unload, discover, farm, isRunning: () => running }
}
module.exports.Danger = Danger
module.exports.Full = Full
