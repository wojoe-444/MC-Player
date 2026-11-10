// Farm routine: harvest ripe crops at the known farm sites, always replant, store the extras in the house chest.
// Walter's rules: only mature crops over farmland are touched (replanting is the one allowed placing), keep ~1 stack of food and 16 of each
// seed, no item piles on the ground (stop and tell him instead), never walk with lava in hand, chat only when something changes.
const { Vec3 } = require('vec3')
const crops = require('./crops')
const common = require('./common')
const makeMover = require('./move')
const makeLos = require('./los')
const makeWorksite = require('./worksite')

const CHEST_NAMES = new Set(['chest', 'trapped_chest', 'barrel'])
const key = (p) => `${p.x},${p.y},${p.z}`

// sitesFn() -> [{ name, x, y, z }]  (farm waypoints + config sites); waypointFn(name) -> {x,y,z}|null
module.exports = function createFarm({ bot, say, goals, tryGoto, safehand, stopNav = () => {}, config, state, save, sitesFn, waypointFn = () => null, canSee = null, craft = null, now = Date.now, log = () => {} }) {
  const F = config.farm
  const mover = makeMover({ bot, goals, tryGoto, safehand, stopNav })
  const los = makeLos({ bot, goals, mover, canSee, log })     // Walter's survival-legit rule: a clear line to every block we break/place on or chest we open
  const farmState = state.farm
  let running = false, stopFlag = false, last = null
  const note = (m) => { last = { at: now(), msg: m }; log(m) }
  const have = (n) => bot.inventory.items().filter(i => i.name === n).reduce((s, i) => s + i.count, 0)
  const foodCount = () => crops.foodTotal(common.counts(bot))
  const dayNow = () => Math.floor((bot.time && bot.time.age || 0) / 24000)
  const houseChestPos = () => new Vec3(F.houseChest[0], F.houseChest[1], F.houseChest[2])

  // ---------- sites ----------
  function sites() {
    const list = (sitesFn() || []).map(s => ({ name: s.name, pos: new Vec3(s.x, s.y, s.z), radius: F.radius }))
    if (!list.length) list.push({ name: 'here', pos: bot.entity.position.floored(), radius: F.fallbackRadius })   // no known farm: legacy behaviour, look around me
    const me = bot.entity.position
    return list.sort((a, b) => a.pos.distanceTo(me) - b.pos.distanceTo(me))
  }
  const cropIds = () => Object.keys(crops.CROPS).map(n => bot.registry.blocksByName[n] && bot.registry.blocksByName[n].id).filter(Boolean)
  function ripeAt(site) {
    return bot.findBlocks({ point: site.pos, matching: cropIds(), maxDistance: site.radius, count: 400 })
      .filter(p => crops.isRipe(bot.blockAt(p), bot.blockAt(p.offset(0, -1, 0))))
  }

  // ---------- small steps ----------
  async function collectNear(ctx, p) {
    for (let i = 0; i < 6; i++) {
      ctx.checkpoint()
      if (bot.inventory.emptySlotCount() < 1) return
      const it = bot.nearestEntity(e => common.isItem(e) && e.position.distanceTo(p) < 5)
      if (!it) return
      await mover.goto(ctx, new goals.GoalNear(it.position.x, it.position.y, it.position.z, 0.7), 'a drop', 4000)
    }
  }

  // Plant `seed` on the farmland at p's column and check the crop really is there (placeBlock often reports a timeout even when it worked).
  async function plant(ctx, p, seed) {
    const crop = crops.SEED_TO_CROP[seed]
    for (let i = 0; i < F.replantTries; i++) {
      ctx.checkpoint()
      const cur = bot.blockAt(p)
      if (cur && cur.name === crop) return true
      const item = bot.inventory.items().find(x => x.name === seed)
      const floor = bot.blockAt(p.offset(0, -1, 0))
      if (!item || !floor || floor.name !== 'farmland' || (cur && cur.boundingBox !== 'empty')) return false
      if (!(await los.ensure(ctx, floor, 'a crop'))) return false          // no clear line to the farmland: do not place through anything
      try { await bot.equip(item, 'hand'); await bot.placeBlock(floor, new Vec3(0, 1, 0)) } catch (e) { log(`replant ${key(p)}: ${e.message}`) }
      await ctx.sleep(F.plantWaitMs ?? 120)
      const after = bot.blockAt(p)
      if (after && after.name === crop) return true
    }
    return false
  }

  const seedFor = (cropName) => crops.CROPS[cropName].seed
  const clearPending = (p) => { farmState.pending = farmState.pending.filter(e => !(e.x === p.x && e.y === p.y && e.z === p.z)) }
  const addPending = (p, cropName) => { if (!farmState.pending.some(e => e.x === p.x && e.y === p.y && e.z === p.z)) farmState.pending.push({ x: p.x, y: p.y, z: p.z, crop: cropName }) }

  // ---------- the house chest ----------
  function findChest() {
    const exact = bot.blockAt(houseChestPos())
    if (exact && CHEST_NAMES.has(exact.name)) return exact
    const w = waypointFn('house'); const ref = w ? new Vec3(w.x, w.y, w.z) : houseChestPos()
    const ids = [...CHEST_NAMES].map(n => bot.registry.blocksByName[n] && bot.registry.blocksByName[n].id).filter(Boolean)
    const pts = bot.findBlocks({ point: ref, matching: ids, maxDistance: F.houseChestSearchRadius, count: 100 }).filter(p => Math.abs(p.y - ref.y) <= 8)
    pts.sort((a, b) => a.distanceTo(ref) - b.distanceTo(ref))
    return pts[0] ? bot.blockAt(pts[0]) : null
  }
  async function openChest(ctx) {
    const chest = findChest()
    if (!chest) return { why: 'I could not find the house chest.' }
    const reached = await mover.near(ctx, chest.position, 3, 'the house chest', 90000)
    if (!reached) return { why: 'I could not reach the house chest.' }
    if (!(await los.ensure(ctx, chest, 'the house chest'))) return { why: 'I cannot get a clear line to the house chest (something solid is in the way).' }
    try { return { chest, win: await bot.openContainer(chest) } } catch (e) { return { why: `Could not open the house chest: ${e.message}` } }
  }

  // Put the extras in the house chest, keeping a stack of food and 16 of each seed. {ok, moved, full}
  async function storeCrops(ctx) {
    const plan = crops.planStore(common.counts(bot), { keepFood: F.keepFood, keepSeed: F.keepSeed, keepBamboo: (F.bamboo && F.bamboo.keep) ?? 4 })
    if (!Object.keys(plan.deposit).length) return { ok: true, moved: {}, nothing: true }
    const o = await openChest(ctx)
    if (!o.win) { say(o.why); return { ok: false } }
    const moved = {}; let full = false
    try {
      for (const [name, n] of Object.entries(plan.deposit)) {
        const it = bot.inventory.items().find(i => i.name === name); if (!it) continue
        const before = have(name)
        try { await o.win.deposit(it.type, null, n) } catch (e) { full = true; log(`house chest refused ${name}: ${e.message}`) }
        const d = before - have(name); if (d > 0) moved[name] = d
        if (full) break
      }
    } finally { try { o.win.close() } catch {} }
    const p = o.chest.position, txt = Object.entries(moved).map(([n, c]) => `${c} ${n}`).join(', ')
    if (txt) say(`Stored in the house chest at ${p.x}, ${p.y}, ${p.z}: ${txt}. I kept ${Math.min(F.keepFood, foodCount())} food.`.slice(0, 230))
    if (full && farmState.fullWarnedDay !== dayNow()) { farmState.fullWarnedDay = dayNow(); say('The house chest is full, so some crops stay with me. Tell me where else to put them.') }
    save()
    return { ok: !full, moved, full }
  }

  // Take missing seeds (up to keepSeed each) back out of the house chest so every harvested spot can be replanted.
  async function fetchSeeds(ctx, wanted) {
    const need = {}
    for (const s of wanted) if (have(s) < F.keepSeed) need[s] = F.keepSeed - have(s)
    if (!Object.keys(need).length) return 0
    const o = await openChest(ctx)
    if (!o.win) { log(o.why); return 0 }
    let got = 0
    try {
      for (const [s, n] of Object.entries(need)) {
        const inChest = o.win.containerItems().filter(i => i.name === s).reduce((a, i) => a + i.count, 0)
        if (!inChest) continue
        const take = Math.min(n, inChest), before = have(s)
        try { await o.win.withdraw(bot.registry.itemsByName[s].id, null, take) } catch (e) { log(`seed withdraw ${s}: ${e.message}`) }
        got += have(s) - before
      }
    } finally { try { o.win.close() } catch {} }
    return got
  }

  // ---------- replanting what an earlier run could not ----------
  async function replantPending(ctx, sum) {
    if (!farmState.pending.length) return
    const missing = [...new Set(farmState.pending.map(e => seedFor(e.crop)).filter(s => have(s) === 0))]
    if (missing.length) await fetchSeeds(ctx, missing)
    for (const e of [...farmState.pending]) {
      ctx.checkpoint()
      const p = new Vec3(e.x, e.y, e.z)
      const cur = bot.blockAt(p), floor = bot.blockAt(p.offset(0, -1, 0))
      const drop = () => { farmState.pending = farmState.pending.filter(x => x !== e) }
      if (!cur || !floor || floor.name !== 'farmland' || cur.boundingBox !== 'empty') { drop(); continue }   // already planted, or no farmland any more
      const seed = seedFor(e.crop)
      const r = await mover.goto(ctx, new goals.GoalNear(p.x, p.y, p.z, 2), 'a crop', 15000)
      if (!r.ok) continue
      await collectNear(ctx, p.offset(0.5, 0, 0.5))      // the seed may still be lying there (a run that was interrupted before it picked it up)
      if (!have(seed)) { sum.noSeed++; continue }
      if (await plant(ctx, p, seed)) { sum.replanted[e.crop] = (sum.replanted[e.crop] || 0) + 1; drop() } else sum.noSeed++
      save()
    }
  }

  // ---------- harvesting ----------
  async function harvestOne(ctx, p, sum) {
    const b = bot.blockAt(p)
    if (!crops.isRipe(b, bot.blockAt(p.offset(0, -1, 0)))) return
    const name = b.name
    const r = await mover.goto(ctx, new goals.GoalNear(p.x, p.y, p.z, 2), 'a crop', 15000)
    if (!r.ok) { sum.unreachable++; return }
    if (!(await los.ensure(ctx, bot.blockAt(p), 'a crop'))) { sum.noSight++; return }     // not harvested: no clear line to it
    try { await bot.dig(bot.blockAt(p), true) } catch (e) { ctx.checkpoint(); log(`dig crop ${key(p)}: ${e.message}`); return }
    sum.got[name] = (sum.got[name] || 0) + 1; sum.actions++
    addPending(p, name); save()          // the spot counts as "needs a seed" until it is really replanted, so a stop or restart cannot lose it
    await ctx.sleep(F.dropWaitMs)
    await collectNear(ctx, p.offset(0.5, 0, 0.5))
    const seed = seedFor(name)
    if (!have(seed)) { sum.noSeed++; return }
    if (await plant(ctx, p, seed)) { sum.replanted[name] = (sum.replanted[name] || 0) + 1; clearPending(p); save() }
    else sum.failedPlant++
  }

  // Walter: use the right tool for what is being broken (a sword or axe for bamboo and cane, whichever the table says is fastest; hand when there is none).
  async function equipFor(block, prefer = null) {
    const pool = bot.inventory.items().filter(i => /_(sword|axe|shovel|pickaxe|hoe)$/.test(i.name))
    const preferred = prefer ? pool.filter(i => new RegExp(prefer).test(i.name)) : []
    const best = require('../motor/tooltier').minimumTool(block, preferred.length ? preferred : pool, { allowSword: true, fallback: true })      // lowest tier that beats the hand; failing that the lowest tier of the preferred kind (an axe on bamboo is no faster than a fist in the data, but it is what was asked for)
    if (best && (!bot.heldItem || bot.heldItem.type !== best.type)) { try { await bot.equip(best, 'hand') } catch (e) { log(`equip ${best.name}: ${e.message}`) } }
  }

  // ---------- sugar cane: cut everything above the bottom block, so the stalk keeps growing ----------
  const isCane = (b) => !!b && b.name === 'sugar_cane'
  function caneStalks(site) {
    const id = bot.registry.blocksByName.sugar_cane && bot.registry.blocksByName.sugar_cane.id
    if (!id) return []
    const bases = new Map()
    for (const p of bot.findBlocks({ point: site.pos, matching: id, maxDistance: site.radius, count: 600 })) {
      let y = p.y; while (isCane(bot.blockAt(new Vec3(p.x, y - 1, p.z)))) y--
      bases.set(`${p.x},${y},${p.z}`, new Vec3(p.x, y, p.z))
    }
    const out = []
    for (const base of bases.values()) {
      let h = 1; while (isCane(bot.blockAt(base.offset(0, h, 0)))) h++
      if (h >= F.caneMinHeight) out.push({ base, height: h })
    }
    return out
  }
  async function cutCane(ctx, stalk, sum) {
    const target = stalk.base.offset(0, 1, 0)          // the second block: everything above it comes down with it, the bottom block stays
    let b = bot.blockAt(target)
    if (!isCane(b) || !isCane(bot.blockAt(stalk.base))) return
    const r = await mover.goto(ctx, new goals.GoalNear(stalk.base.x, stalk.base.y, stalk.base.z, 2), 'sugar cane', 15000)
    if (!r.ok) { sum.unreachable++; return }
    b = bot.blockAt(target)
    if (!isCane(b)) return
    if (!(await los.ensure(ctx, b, 'sugar cane'))) { sum.noSight++; return }
    const before = have('sugar_cane')
    await equipFor(b)
    try { await bot.dig(b, true) } catch (e) { ctx.checkpoint(); log(`dig cane ${key(target)}: ${e.message}`); return }
    sum.actions++
    await ctx.sleep(F.dropWaitMs)
    await collectNear(ctx, stalk.base.offset(0.5, 1, 0.5))
    sum.cane += Math.max(0, have('sugar_cane') - before)
  }
  async function harvestCane(ctx, site, sum) {
    const list = caneStalks(site)
    sum.caneFound += list.length
    while (list.length && !stopFlag) {
      ctx.checkpoint()
      if (sum.actions >= F.maxActionsPerRun) { sum.capped = true; return }
      const d = common.danger(bot, { minHealth: 8, radius: 8 })
      if (d) throw new Danger(d)
      await makeRoom(ctx, sum)
      const me = bot.entity.position
      let bi = 0
      for (let i = 1; i < list.length; i++) if (list[i].base.distanceTo(me) < list[bi].base.distanceTo(me)) bi = i
      await cutCane(ctx, list.splice(bi, 1)[0], sum)
    }
  }

  // ---------- bamboo: a small patch (8-10 stalks), planted when missing, cut like sugar cane (everything above the bottom block) ----------
  const BB = F.bamboo || {}
  const isBamboo = (b) => !!b && b.name === 'bamboo'
  const isBambooPlant = (b) => !!b && (b.name === 'bamboo' || b.name === 'bamboo_sapling')
  const bambooState = () => farmState.bamboo || (farmState.bamboo = { cells: [], askedDay: null })
  const anchorOf = () => { const st = bambooState(); const a = st.anchor || BB.anchor; return a ? new Vec3(a[0], a[1], a[2]) : null }
  // Walter's own patch: every bamboo (stalk or sapling) around the registered spot is part of it; the cells are the bottom blocks, found again on every run
  // (so shoots he adds later join in). Nothing is chosen or planted by us there; with a registered patch the bot never asks for bamboo.
  function discoverPatch(anchor) {
    const st = bambooState()
    const ids = ['bamboo', 'bamboo_sapling'].map(n => bot.registry.blocksByName[n] && bot.registry.blocksByName[n].id).filter(Boolean)
    const have = new Set(st.cells.map(c => c.join(',')))
    let added = 0
    for (const p of bot.findBlocks({ point: anchor, matching: ids, maxDistance: BB.discoverRadius || 7, count: 200 })) {
      let y = p.y; while (isBamboo(bot.blockAt(new Vec3(p.x, y - 1, p.z)))) y--
      const k = `${p.x},${y},${p.z}`
      if (!have.has(k)) { have.add(k); st.cells.push([p.x, y, p.z]); added++ }
    }
    if (added) { st.fixed = true; save(); log(`bamboo patch: ${added} new cell(s), ${st.cells.length} in all (around ${anchor.x},${anchor.y},${anchor.z})`) }
    return added
  }
  // one visit to the patch: walk there if it is far, take in Walter's stalks, replant gaps from the bag, cut the tall ones (bottom block stays)
  async function bambooRun(ctx, sum) {
    const anchor = anchorOf()
    if (!BB.stalks && !anchor) return
    const st = bambooState()
    const site = sites()[0]
    if (anchor) {
      st.anchor = [anchor.x, anchor.y, anchor.z]; st.fixed = true
      if (bot.entity.position.distanceTo(anchor) > F.walkToSiteDistance) {
        const r = await mover.goto(ctx, new goals.GoalNear(anchor.x, anchor.y, anchor.z, 6), 'the bamboo patch', 90000)
        if (!r.ok) { sum.unreachableSites.push('bamboo patch'); return }
      }
      discoverPatch(anchor)
    }
    await plantBamboo(ctx, site, sum)
    await cutBambooPatch(ctx, sum)
  }

  const plantableFloor = (b) => !!b && (BB.floors || []).includes(b.name)
  const isOpenAir = (b) => !!b && b.boundingBox === 'empty' && !isLiquidish(b) && !crops.isCrop(b) && !isBambooPlant(b) && b.name !== 'sugar_cane'

  // free cells for the patch: dirt-like floor, 3 blocks of air above, not on or next to farmland or crops; the nearest ones around the best spot near the field
  function pickBambooCells(site, n) {
    const c = site.pos, R = BB.radius || 12, side = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    const ok = (x, y, z) => {
      if (!plantableFloor(bot.blockAt(new Vec3(x, y - 1, z)))) return false
      for (let dy = 0; dy < 3; dy++) if (!isOpenAir(bot.blockAt(new Vec3(x, y + dy, z)))) return false
      return !side.some(([dx, dz]) => { const f = bot.blockAt(new Vec3(x + dx, y - 1, z + dz)), a = bot.blockAt(new Vec3(x + dx, y, z + dz)); return (f && f.name === 'farmland') || crops.isCrop(a) })
    }
    const cand = []
    for (let x = c.x - R; x <= c.x + R; x++) for (let z = c.z - R; z <= c.z + R; z++) for (let y = c.y - 3; y <= c.y + 3; y++) if (ok(x, y, z)) cand.push(new Vec3(x, y, z))
    if (!cand.length) return []
    const anchor = cand.slice().sort((a, b) => a.distanceTo(c) - b.distanceTo(c))[0]
    return cand.sort((a, b) => a.distanceTo(anchor) - b.distanceTo(anchor)).slice(0, n)
  }

  // Plant what is missing (needs bamboo in the bag; it is taken back out of the house chest if there is some). Returns the number planted.
  async function plantBamboo(ctx, site, sum) {
    const st = bambooState()
    if (!BB.stalks && !st.fixed) return 0
    const missing = () => st.cells.filter(([x, y, z]) => { const b = bot.blockAt(new Vec3(x, y, z)); return b && isOpenAir(b) && plantableFloor(bot.blockAt(new Vec3(x, y - 1, z))) })
    const standing = () => st.cells.filter(([x, y, z]) => isBambooPlant(bot.blockAt(new Vec3(x, y, z)))).length
    const need = st.cells.length ? missing().length : (st.fixed ? 0 : BB.stalks)
    if (need <= 0) return 0
    if (have('bamboo') < 1) await fetchBamboo(ctx, Math.min(need, BB.fetch || 10))
    if (have('bamboo') < 1 && st.fixed) return 0               // Walter's patch: nothing to ask for
    if (have('bamboo') < 1) {
      const day = dayNow()
      if (st.askedDay !== day) { st.askedDay = day; save(); say(`I'd like a small bamboo patch (${BB.stalks} stalks), but I have no bamboo to plant. Put a few in the house chest, or tell me where some grows.`.slice(0, 230)) }
      return 0
    }
    if (!st.cells.length) {
      const cells = pickBambooCells(site, BB.stalks)
      if (!cells.length) { if (st.askedDay !== dayNow()) { st.askedDay = dayNow(); save(); say('I found no free dirt or grass near the farm for a bamboo patch. Tell me where it should go.') } return 0 }
      st.cells = cells.map(c => [c.x, c.y, c.z]); st.site = site.name; save()
    }
    let planted = 0
    for (const [x, y, z] of missing()) {
      ctx.checkpoint()
      const item = bot.inventory.items().find(i => i.name === 'bamboo'); if (!item) break
      const cell = new Vec3(x, y, z), floor = bot.blockAt(cell.offset(0, -1, 0))
      const r = await mover.goto(ctx, new goals.GoalNear(x, y, z, 2), 'the bamboo patch', 15000)
      if (!r.ok) continue
      if (!(await los.ensure(ctx, floor, 'the bamboo patch'))) { sum.noSight++; continue }
      try { await bot.equip(item, 'hand'); await bot.placeBlock(floor, new Vec3(0, 1, 0)) } catch (e) { log(`plant bamboo ${x},${y},${z}: ${e.message}`) }
      await ctx.sleep(F.plantWaitMs ?? 120)
      if (isBambooPlant(bot.blockAt(cell))) planted++
    }
    sum.bambooPlanted += planted
    log(`bamboo patch: ${standing()} of ${st.cells.length} standing, planted ${planted}`)
    return planted
  }
  async function fetchBamboo(ctx, n) {
    const o = await openChest(ctx)
    if (!o.win) { log(o.why); return 0 }
    let got = 0
    try {
      const inChest = o.win.containerItems().filter(i => i.name === 'bamboo').reduce((a, i) => a + i.count, 0)
      if (inChest) {
        const take = Math.min(n, inChest), before = have('bamboo')
        try { await o.win.withdraw(bot.registry.itemsByName.bamboo.id, null, take) } catch (e) { log(`bamboo withdraw: ${e.message}`) }
        got = have('bamboo') - before
      }
    } finally { try { o.win.close() } catch {} }
    return got
  }

  // the patch's stalks that are tall enough: cut at the second block, the base stays
  function bambooStalks() {
    const out = []
    for (const [x, y, z] of bambooState().cells) {
      const base = new Vec3(x, y, z)
      if (!isBamboo(bot.blockAt(base))) continue
      let h = 1; while (isBamboo(bot.blockAt(base.offset(0, h, 0)))) h++
      if (h >= (BB.minHeight || 4)) out.push({ base, height: h })
    }
    return out
  }
  async function cutBamboo(ctx, stalk, sum) {
    const target = stalk.base.offset(0, 1, 0)
    let b = bot.blockAt(target)
    if (!isBamboo(b) || !isBamboo(bot.blockAt(stalk.base))) return
    const r = await mover.goto(ctx, new goals.GoalNear(stalk.base.x, stalk.base.y, stalk.base.z, 2), 'the bamboo', 15000)
    if (!r.ok) { sum.unreachable++; return }
    b = bot.blockAt(target)
    if (!isBamboo(b)) return
    if (!(await los.ensure(ctx, b, 'the bamboo'))) { sum.noSight++; return }
    const before = have('bamboo')
    await equipFor(b, BB.prefer || '_axe$')            // Walter: an axe for bamboo
    try { await bot.dig(b, true) } catch (e) { ctx.checkpoint(); log(`dig bamboo ${key(target)}: ${e.message}`); return }
    sum.actions++
    await ctx.sleep(F.dropWaitMs)
    await collectNear(ctx, stalk.base.offset(0.5, 1, 0.5))
    sum.bamboo += Math.max(0, have('bamboo') - before)
  }
  async function cutBambooPatch(ctx, sum) {
    const list = bambooStalks()
    while (list.length && !stopFlag) {
      ctx.checkpoint()
      if (sum.actions >= F.maxActionsPerRun) { sum.capped = true; return }
      const d = common.danger(bot, { minHealth: 8, radius: 8 })
      if (d) throw new Danger(d)
      await makeRoom(ctx, sum)
      const me = bot.entity.position
      let bi = 0
      for (let i = 1; i < list.length; i++) if (list[i].base.distanceTo(me) < list[bi].base.distanceTo(me)) bi = i
      await cutBamboo(ctx, list.splice(bi, 1)[0], sum)
    }
  }

  // ---------- work-site chest (Walter's time-economy rule): stash next to the field, haul to the house chest once at the end ----------
  const WS = F.worksite || {}
  let curSite = null
  function farmSpot() {
    if (WS.enabled === false || !curSite) return null
    const c = curSite.pos, R = WS.radius || 12, me = bot.entity.position
    const solid = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); return !!b && b.boundingBox !== 'empty' && !isLiquidish(b) && !crops.isCrop(b) && b.name !== 'farmland' }
    const air = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); return !!b && b.boundingBox === 'empty' && !isLiquidish(b) && !crops.isCrop(b) && b.name !== 'sugar_cane' }
    let best = null
    for (let x = c.x - R; x <= c.x + R; x++) for (let z = c.z - R; z <= c.z + R; z++) for (let y = c.y - 3; y <= c.y + 3; y++) {
      if (!air(x, y, z) || !air(x, y + 1, z) || !solid(x, y - 1, z)) continue
      const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      if (!sides.some(([dx, dz]) => solid(x + dx, y, z + dz))) continue                       // against a wall
      const st = sides.find(([dx, dz]) => air(x + dx, y, z + dz) && air(x + dx, y + 1, z + dz) && solid(x + dx, y - 1, z + dz))
      if (!st) continue
      const d = c.distanceTo(new Vec3(x, y, z)) + me.distanceTo(new Vec3(x, y, z)) * 0.01       // as close to the field as it gets, then close to me
      if (!best || d < best.d) best = { d, cell: new Vec3(x, y, z), stand: new Vec3(x + st[0], y, z + st[1]) }
    }
    return best
  }
  const isLiquidish = (b) => b.name === 'water' || b.name === 'lava'
  const wsStash = () => { const plan = crops.planStore(common.counts(bot), { keepFood: F.keepFood, keepSeed: F.keepSeed, keepBamboo: (F.bamboo && F.bamboo.keep) ?? 4 }); return Object.entries(plan.deposit).map(([name, count]) => ({ name, count })) }
  const wsForwardable = (items) => items.filter(i => crops.CROP_ITEMS.has(i.name))
  const ws = makeWorksite({
    bot, goals, mover, los, say, state: farmState, save, now, log, label: 'the work-site chest',
    chooseSpot: farmSpot, stashList: wsStash, forwardable: wsForwardable,
    forward: async (ctx) => { const r = await storeCrops(ctx); return { full: !!r.full } },
    craftChest: (ctx) => craftVia(ctx, 'craft chest', () => bot.inventory.items().some(i => i.name === 'chest'), 'a work-site chest')
  })
  // ask the crafting module for a chest (it knows the table and the planks); at most 2 asks per run
  async function craftVia(ctx, text, done, what) {
    if (!craft || !craft.dispatch) return false
    ctx.state.craftAsks = ctx.state.craftAsks || {}
    const n = ctx.state.craftAsks[what] = (ctx.state.craftAsks[what] || 0) + 1
    if (n > 2) return false
    let handled = false
    try { handled = !!craft.dispatch(text) } catch (e) { log(`craft dispatch: ${e.message}`) }
    if (!handled) return false
    for (let i = 0; i < (F.craftPolls || 120); i++) {
      await ctx.sleep(F.craftPollMs || 1000)
      if (done()) return true
      if (craft.busy && !craft.busy()) break
    }
    return !!done()
  }
  // the bag is filling up: into the work-site chest if there is (or can be) one, else straight to the house chest as before
  async function unloadCrops(ctx) {
    if (WS.enabled !== false) {
      let r = await ws.stash(ctx)
      if (r.ok && r.full) { await ws.haul(ctx, { quiet: true }); r = await ws.stash(ctx) }
      if (r.ok && !r.full) { if (ws.nearlyFull()) await ws.haul(ctx, { quiet: true }); return { ok: true, viaWorksite: true } }
    }
    return storeCrops(ctx)
  }
  async function makeRoom(ctx, sum) {
    if (bot.inventory.emptySlotCount() > F.minFreeSlots) return
    const s = await unloadCrops(ctx)
    if (bot.inventory.emptySlotCount() <= F.minFreeSlots) { sum.stoppedFull = true; throw new Full(s.full) }
  }
  // end of the run: one haul of the work-site chest, then whatever the bag still carries
  async function finalHaul(ctx) {
    if (farmState.worksite) {
      const h = await ws.haul(ctx)
      if (h.done && h.left && Object.keys(h.left).length) say(`The work-site chest at ${farmState.worksite.pos.join(', ')} still holds ${Object.entries(h.left).slice(0, 3).map(([n, c]) => `${c} ${n}`).join(', ')}.`.slice(0, 200))
    }
    await storeCrops(ctx)
  }

  async function harvestSite(ctx, site, sum) {
    if (bot.entity.position.distanceTo(site.pos) > F.walkToSiteDistance) {
      const r = await mover.goto(ctx, new goals.GoalNear(site.pos.x, site.pos.y, site.pos.z, 6), `the ${site.name}`, 90000)
      if (!r.ok) { sum.unreachableSites.push(site.name); return }
    }
    curSite = site
    const list = ripeAt(site)
    sum.found += list.length
    while (list.length && !stopFlag) {
      ctx.checkpoint()
      if (sum.actions >= F.maxActionsPerRun) { sum.capped = true; return }
      const d = common.danger(bot, { minHealth: 8, radius: 8 })
      if (d) throw new Danger(d)
      await makeRoom(ctx, sum)
      const me = bot.entity.position
      let bi = 0
      for (let i = 1; i < list.length; i++) if (list[i].distanceTo(me) < list[bi].distanceTo(me)) bi = i
      const p = list.splice(bi, 1)[0]
      await harvestOne(ctx, p, sum)
    }
    if (!stopFlag) await harvestCane(ctx, site, sum)
  }

  class Danger extends Error { constructor(why) { super(why); this.why = why } }
  class Full extends Error { constructor(chestFull) { super('inventory full'); this.chestFull = chestFull } }

  // ---------- the job ----------
  async function run(ctx, { manual = false, store = true } = {}) {
    if (running) return { status: 'done' }
    running = true; stopFlag = false
    const sum = { got: {}, replanted: {}, noSeed: 0, failedPlant: 0, unreachable: 0, unreachableSites: [], noSight: 0, found: 0, cane: 0, caneFound: 0, actions: 0, capped: false, stoppedFull: false }
    try {
      if (common.dimOf(bot) !== 'overworld') return { status: 'retry', afterMs: 120000 }
      await safehand.stow()
      farmState.lastRun = now(); save()
      await replantPending(ctx, sum)
      for (const site of sites()) {
        if (stopFlag) break
        await harvestSite(ctx, site, sum)
      }
      if (!stopFlag) await bambooRun(ctx, sum)
      ctx.checkpoint()          // stopped or preempted: say nothing, the scheduler resumes or cancels us
      ctx.state.dangerRetries = 0
      if (store && !stopFlag) await finalHaul(ctx)
      return finish(sum, manual)
    } catch (e) {
      if (e && e.name === 'AbortError') throw e
      if (e instanceof Danger) {
        ctx.state.dangerRetries = (ctx.state.dangerRetries || 0) + 1
        if (ctx.state.dangerRetries > F.dangerRetries) { say(`Stopping the farm run: ${e.why}.`); finish(sum, true); return { status: 'done' } }
        if (ctx.state.dangerRetries === 1) say(`Pausing the farm run: ${e.why}. I will pick it up again shortly.`)
        return { status: 'retry', afterMs: F.dangerRetryMs }
      }
      if (e instanceof Full) {
        finish(sum, true)
        say(e.chestFull ? 'Stopping the farm run: my inventory is full and the house chest is full. I will not leave crops on the ground; tell me where to put them.' : 'Stopping the farm run: my inventory is nearly full and I could not empty it into the house chest.')
        return { status: 'done' }
      }
      log(`FARM_ERROR ${e && e.stack || e}`)
      say(`Harvest stopped: ${e && e.message}`.slice(0, 200))
      return { status: 'done' }
    } finally {
      running = false
      save()
      try { await safehand.stow() } catch {}
    }
  }

  function finish(sum, manual) {
    const g = Object.entries(sum.got).map(([n, c]) => `${c} ${n}`).join(', ')
    const rp = Object.entries(sum.replanted).map(([n, c]) => `${c} ${n}`).join(', ') || 'nothing'
    farmState.lastResult = { at: now(), got: sum.got, cane: sum.cane, replanted: sum.replanted, noSeed: sum.noSeed, pending: farmState.pending.length, found: sum.found }
    note(`FARM ${JSON.stringify(farmState.lastResult)}`)
    const unreach = (sum.unreachableSites.length ? ` I could not walk to: ${sum.unreachableSites.join(', ')}.` : '') + (sum.noSight ? ` ${sum.noSight} crop(s) had no clear line to them, so I left them.` : '')
    if (!g && !sum.cane) {
      if (manual && !unreach) say(sum.found || sum.caneFound ? 'I found ripe crops but could not get to them.' : 'I do not see any ripe crops near the farm.')
      if (unreach) say(unreach.trim().slice(0, 200))
      return { status: 'done' }
    }
    const left = farmState.pending.length
    const caneText = sum.cane ? `${g ? ' ' : ''}Cut ${sum.cane} sugar cane (the bottom block of each stalk stays).` : ''
    const cropText = g ? `Picked ${g}; replanted ${rp}${left ? `; ${left} spot(s) still need seeds` : ''}.` : ''
    say(`Harvest done. ${cropText}${caneText} Food on me: ${foodCount()}.${unreach}`.slice(0, 230))
    return { status: 'done' }
  }

  function abort() { stopFlag = true; try { stopNav() } catch {} }

  // Routine due check: daytime, every 45 minutes (Walter), every 15 only when food is really low (under 8).
  function due() {
    if (common.dimOf(bot) !== 'overworld' || !bot.time || bot.time.timeOfDay >= 12000) return false
    const every = (foodCount() < F.lowFood ? F.lowFoodIntervalMinutes : F.intervalMinutes) * 60000
    return now() - (farmState.lastRun || 0) > every
  }

  function snapshot() {
    return {
      enabled: !!farmState.enabled, running, lastRunAgoS: farmState.lastRun ? Math.round((now() - farmState.lastRun) / 1000) : null,
      pendingReplants: farmState.pending.length, worksite: ws.snapshot(), food: foodCount(), lastResult: farmState.lastResult, last: last && { agoS: Math.round((now() - last.at) / 1000), msg: last.msg },
      sites: (sitesFn() || []).map(s => s.name)
    }
  }

  // chat: "bamboo patch at x y z"; takes effect at once (the cells are found on the next run)
  function registerBamboo(x, y, z) { const st = bambooState(); st.anchor = [x, y, z]; st.fixed = true; st.cells = []; save() }
  return { registerBamboo, run, abort, storeCrops, due, snapshot, replantPending, fetchSeeds, sites, isRunning: () => running, foodCount }
}
