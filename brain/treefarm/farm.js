// brain/treefarm/farm.js: the lit sapling lattice farm (Walter: a lit, self-sustaining birch farm next to the base, saplings with 3 blocks
// between them, natural trees above ground left standing, movable underground later). The geometry is in layout.js (pure); this file is the
// bot work, built from primitives of the tree farm engine (goto, line of sight, plantAt, collectDrops, fetch):
//
//   create(ctx, { home })       pick a level, clear rectangle near home (no natural tree, water or lava inside), record the farm
//   saplings(ctx, farm, want)   get birch saplings: the bag, drops on the ground, the wood chests, then LEAVES of standing natural birch trees
//                               (by hand, a few per tree; no trunk is ever cut for a sapling)
//   plant(ctx, farm)            a sapling on every free lattice spot (one species, strictly)
//   light(ctx, farm)            a torch in the middle of every lattice square (clears the grass in the cell first), line of sight for every block
//   tend(ctx, { farm })         pick up drops, replant every empty spot, relight what is dark
//   build(ctx, opts)            create (once) + saplings + plant + light, in one or several visits (`more:true` = call again)
//   harvest(ctx, opts)          fell the grown lattice trees (engine.run with farmOnly), replanting each one
//   naturalPolicy(opts)         may a natural tree outside the farm be felled? (no, once the farm has grown trees; only a bootstrap supply before)
//   status(farm)                counts for the think prompt and the chat line
//
// Nothing here decides WHEN: the think-brain picks the skill (tree_farm in autopilot/think.js) and the idle routine calls tend + harvest.
// Every placement and every dig goes through a clear ray from the eye (engine.see); torches through brain/lighting/torches.js.
const { Vec3 } = require('vec3')

const DEFAULTS = {
  cols: 4, rows: 3, species: 'birch', mode: 'surface',
  startSaplings: 4,          // plant this many first; the farm grows itself from there (every felled tree drops saplings from its decaying leaves)
  searchRadius: 30, minRing: 6, maxRing: 26, minFrac: 0.75,
  leafRadius: 40, leavesPerTree: 10, leafBudget: 60,
  bootstrapLogs: 16,         // natural trees may be felled only while the bag holds fewer logs than this and the farm has no grown tree yet
  workMs: 150000,            // one visit's time box
  maxFarms: 1,
  tendMinutes: 15
}
const GRASS = /^(short_grass|tall_grass|fern|large_fern)$/

module.exports = function createFarm({ bot, say, goals, config: C, state: S, save, now, log, torches, T, L, Danger, eng }) {
  const F = () => ({ ...DEFAULTS, ...(C.farm || {}) })
  const get = (x, y, z) => { try { return bot.blockAt(new Vec3(x, y, z)) } catch { return null } }
  const farms = () => S.farms
  const has = () => S.farms.length > 0
  const sapName = (f) => T.SAPLING[f.species]
  const inBag = (n) => eng.countWhere(x => x === n)
  const bagSaplings = (f) => inBag(sapName(f))
  const centreVec = (f) => { const c = L.centre(f); return new Vec3(Math.floor(c.x) + 0.5, f.y, Math.floor(c.z) + 0.5) }
  const timeUp = (deadline) => !!deadline && now() >= deadline
  const overworld = () => !bot.game || bot.game.dimension === undefined || /overworld/.test(String(bot.game.dimension))

  // ---------- status ----------
  function status(f) {
    const n = L.summarize(f, get)
    const needs = []
    if (n.unloaded) needs.push('far part not loaded: walk there')
    if (n.empty && !bagSaplings(f)) needs.push(`${n.empty} empty spot(s) and no ${f.species} sapling`)
    if (n.unlit && !torches.count()) needs.push(`${n.unlit} unlit torch spot(s) and no torches`)
    return { id: f.id, at: [f.x, f.y, f.z], species: f.species, mode: f.mode, ...n, bag: { saplings: bagSaplings(f), torches: torches.count() }, needs }
  }
  function line(f) {
    const s = status(f)
    return `${f.species} farm at ${f.x}, ${f.z}: ${s.saplings} saplings, ${s.trees} grown, ${s.empty} empty spots, ${s.torches}/${s.torchSpots} torches.`
  }

  // ---------- site ----------
  function register(f) {
    const c = L.centre(f)
    const site = { name: `tree farm ${f.id}`, x: Math.floor(c.x), y: f.y, z: Math.floor(c.z), radius: 16, farm: f.id, species: f.species, at: now() }
    const i = S.sites.findIndex(x => x.farm === f.id)
    if (i >= 0) S.sites[i] = site; else S.sites.push(site)
  }
  // Walk near home (so the chunks around it are loaded), scan the ground once, pick the best rectangle, record it.
  async function create(ctx, { home = null, cols, rows, species, mode, avoid = [] } = {}) {
    const o = F()
    if (S.farms.length >= o.maxFarms) return { ok: true, farm: S.farms[0], existing: true }
    const h = home ? new Vec3(Math.floor(home.x), Math.floor(home.y), Math.floor(home.z)) : bot.entity.position.floored()
    if (bot.entity.position.distanceTo(h) > 10) {
      const r = await eng.goto(ctx, new goals.GoalNear(h.x, h.y, h.z, 4), 'home', 120000)
      if (!r.ok) return { ok: false, why: `cannot walk home (${r.err || 'no path'})` }
    }
    ctx.checkpoint()
    const m = mode || o.mode
    const grid = L.scanGrid(get, h.x, h.z, o.searchRadius, { yHint: h.y, mode: m })
    const keep = [{ x0: h.x - 7, x1: h.x + 7, z0: h.z - 9, z1: h.z + 7 }, ...avoid, ...S.farms.map(L.bounds)]     // the base itself and any farm already there
    const rect = L.pickRect(grid, h, { cols: cols || o.cols, rows: rows || o.rows, minFrac: o.minFrac, minRing: o.minRing, maxRing: o.maxRing, avoid: keep })
    if (!rect) return { ok: false, why: 'no level clear ground of that size near home (natural trees, water, buildings or unloaded chunks in the way)', hint: 'try another side of the base, or scout for an open meadow and set a new home' }
    const id = `farm${S.farms.length + 1}`
    const f = L.makeFarm({ id, x: rect.x, y: rect.y, z: rect.z, cols: rect.cols, rows: rect.rows, species: species || o.species, mode: m, at: now() })
    L.surveyFarm(f, get, { yHint: rect.y, mode: m })
    S.farms.push(f); register(f); save()
    log(`TREEFARM_FARM created ${f.id} at ${f.x},${f.y},${f.z} ${f.cols}x${f.rows} ${f.species} (${rect.ok} of ${f.cols * f.rows} spots clear)`)
    return { ok: true, farm: f, spotsClear: rect.ok }
  }

  // ---------- saplings ----------
  const inReach = (b) => eng.isReach(b.position)
  // Natural leaves of the farm species that are alive (a tree still holds them): [{ block, cluster }] nearest tree first, lowest leaves first.
  function leafCandidates(f) {
    const o = F(), id = bot.registry.blocksByName[`${f.species}_leaves`]
    if (!id) return []
    const pts = bot.findBlocks({ point: bot.entity.position, matching: [id.id], maxDistance: o.leafRadius, count: 600 })
    const me = bot.entity.position
    const live = []
    for (const p of pts) {
      const b = bot.blockAt(p)
      if (!T.naturalLeaves(b)) continue
      const pr = typeof b.getProperties === 'function' ? b.getProperties() : {}
      if (pr.distance !== undefined && Number(pr.distance) >= 7) continue         // doomed anyway (its tree is gone): the engine's canopy pass owns those
      live.push(b)
    }
    // one group per tree: leaves that touch (within 2 blocks) belong together
    const at = new Map(live.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    const seen = new Set(), groups = new Map()
    for (const b of live) {
      const k0 = `${b.position.x},${b.position.y},${b.position.z}`
      if (seen.has(k0)) continue
      const list = [], q = [b]; seen.add(k0)
      while (q.length) {
        const c = q.pop(); list.push(c)
        for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
          const k = `${c.position.x + dx},${c.position.y + dy},${c.position.z + dz}`
          if (!seen.has(k) && at.has(k)) { seen.add(k); q.push(at.get(k)) }
        }
      }
      groups.set(k0, list)
    }
    const out = []
    for (const [, list] of [...groups.entries()].sort((a, b) => Math.min(...a[1].map(x => x.position.distanceTo(me))) - Math.min(...b[1].map(x => x.position.distanceTo(me))))) {
      list.sort((a, b) => a.position.y - b.position.y || a.position.distanceTo(me) - b.position.distanceTo(me))
      for (const b of list.slice(0, o.leavesPerTree)) out.push(b)
    }
    return out
  }
  // Break natural leaves by hand (shears would give leaf blocks, not saplings) until `want` saplings are in the bag. The tree itself stays.
  async function breakLeaves(ctx, f, want, deadline) {
    const o = F()
    const res = { broken: 0, got: 0, noLeaves: false }
    const start = bagSaplings(f)
    let cands = leafCandidates(f)
    if (!cands.length) { res.noLeaves = true; return res }
    for (const b0 of cands) {
      if (res.broken >= o.leafBudget || bagSaplings(f) >= want || timeUp(deadline)) break
      ctx.checkpoint(); eng.guard()
      let b = bot.blockAt(b0.position)
      if (!T.naturalLeaves(b)) continue
      if (!inReach(b)) { if (!(await eng.near(ctx, b.position, 3, 'a leaf', 40000))) continue; b = bot.blockAt(b0.position); if (!T.naturalLeaves(b)) continue }
      if (!inReach(b) || !(await eng.see(ctx, b, 'a leaf'))) continue
      try { if (bot.heldItem) await bot.unequip('hand') } catch { /* keep what is in hand */ }
      try { await bot.dig(b, true) } catch (e) { ctx.checkpoint(); log(`leaf ${b.position}: ${e.message}`); continue }
      res.broken++; S.stats.leavesBroken = (S.stats.leavesBroken || 0) + 1
      if (res.broken % 6 === 0) await eng.collectDrops(ctx, bot.entity.position, 6, 10)
    }
    await ctx.sleep(C.dropWaitMs ?? 350)
    await eng.collectDrops(ctx, bot.entity.position, 8, 14)
    res.got = bagSaplings(f) - start
    save()
    return res
  }
  // Order: the bag, saplings lying around, the wood chests, then leaves. -> { have, want, source, hint }
  async function saplings(ctx, f, want, { deadline = null, leaves = true } = {}) {
    const out = { have: bagSaplings(f), want, sources: [], hint: null }
    if (out.have >= want) return out
    await eng.collectDrops(ctx, bot.entity.position, 12, 8)
    out.have = bagSaplings(f)
    if (out.have >= want) { out.sources.push('ground'); return out }
    if (await eng.fetch(ctx, n => n === sapName(f), want - out.have, `sapling:${f.species}`)) out.sources.push('chest')
    out.have = bagSaplings(f)
    if (out.have >= want || !leaves) return out
    const r = await breakLeaves(ctx, f, want, deadline)
    out.have = bagSaplings(f)
    if (r.broken) out.sources.push(`${r.broken} leaves`)
    if (r.noLeaves) out.hint = `no natural ${f.species} leaves within ${F().leafRadius} blocks: scout for a birch wood (leaves only, the trees stay), or put ${f.species} saplings in the wood chest`
    else if (out.have < want) out.hint = `${r.broken} leaves gave ${r.got} sapling(s): the drop chance is about 5 percent per leaf; call again, or try another birch tree`
    return out
  }

  // ---------- planting ----------
  async function liftSoil(ctx, s) {               // underground mode: a dirt block on the stone floor, the sapling goes on top of it
    const dirt = bot.inventory.items().find(i => i.name === 'dirt')
    const ref = bot.blockAt(new Vec3(s.x, s.y - 2, s.z)), at = bot.blockAt(new Vec3(s.x, s.y - 1, s.z))
    if (!dirt || !ref || !at || !L.isFree(at)) return false
    if (!(await eng.see(ctx, ref, 'a soil spot'))) return false
    try { await bot.equip(dirt, 'hand'); await bot.placeBlock(ref, new Vec3(0, 1, 0)) } catch (e) { log(`lift ${s.x},${s.z}: ${e.message}`) }
    await ctx.sleep(C.plantWaitMs ?? 150)
    const nb = bot.blockAt(new Vec3(s.x, s.y - 1, s.z))
    return !!nb && /^(dirt|grass_block)$/.test(nb.name)
  }
  async function plant(ctx, f, { max = 99, deadline = null, keep = 0 } = {}) {
    const sp = L.surveyFarm(f, get)
    const todo = sp.filter(s => s.ok && s.state === 'empty')
    const res = { planted: 0, empty: todo.length, noSapling: false, failed: 0 }
    // two passes: a spot that failed (no clear ray from where the bot stood, a path that did not work out) is tried once more from wherever the bot is by then
    let queue = todo
    for (let pass = 0; pass < 2 && queue.length; pass++) {
      const again = []
      for (const s of queue) {
        if (res.planted >= max || timeUp(deadline)) break
        ctx.checkpoint(); eng.guard()
        if (!eng.pickSapling(f.species, true)) { res.noSapling = true; break }
        if (bagSaplings(f) <= keep) break                                      // the rest is kept for the trees about to be felled
        if (s.lift && !(await liftSoil(ctx, s))) { again.push(s); continue }
        const r = await eng.plantAt(ctx, new Vec3(s.x, s.y, s.z), f.species, { strict: true })
        if (r === true) res.planted++
        else if (r === 'nosapling') { res.noSapling = true; break }
        else again.push(s)
      }
      queue = res.noSapling ? [] : again
      res.failed = queue.length
    }
    if (res.planted) { f.plantedAt = now(); save() }
    return res
  }

  // ---------- light ----------
  // Within arm's reach of the cell's floor and never standing in the cell itself (the server refuses a block inside the player).
  async function approach(ctx, cell, label) {
    const me = bot.entity.position
    if (Math.hypot(me.x - (cell.x + 0.5), me.z - (cell.z + 0.5)) > 2.8 || Math.abs(me.y - cell.y) > 2) {
      const r = await eng.goto(ctx, new goals.GoalNear(cell.x, cell.y, cell.z, 2), label, 40000)       // not eng.near: that one stops at 4.6 blocks, too far to place from
      if (!r.ok) return false
    }
    const f = bot.entity.position.floored()
    if (f.x === cell.x && f.z === cell.z && Math.abs(f.y - cell.y) <= 1) {
      for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
        const r = await eng.goto(ctx, new goals.GoalNear(cell.x + dx, cell.y, cell.z + dz, 1), label, 15000)
        const g = bot.entity.position.floored()
        if (r.ok && !(g.x === cell.x && g.z === cell.z)) return true
      }
      return false
    }
    return true
  }
  async function clearGrass(ctx, cell) {
    const b = bot.blockAt(cell)
    if (!b || !GRASS.test(b.name)) return !!b && L.isAir(b)
    if (!(await eng.see(ctx, b, 'grass'))) return false
    try { if (bot.heldItem) await bot.unequip('hand') } catch { /* keep what is in hand */ }
    try { await bot.dig(b, true) } catch (e) { ctx.checkpoint(); log(`grass ${cell}: ${e.message}`); return false }
    return true
  }
  async function light(ctx, f, { max = 99, deadline = null, requestTorches = null } = {}) {
    const todo = L.torchState(f, get).filter(t => !t.has && t.floorOk)
    const res = { placed: 0, unlit: todo.length, noTorches: false, failed: 0 }
    if (!todo.length) return res
    if (!torches.count()) {
      if (requestTorches) { try { await requestTorches() } catch { /* the crafting module is optional */ } }
      if (!torches.count()) { res.noTorches = true; return res }
    }
    // nearest first, always the closest remaining one to where the bot stands
    const left = todo.slice()
    while (left.length && res.placed < max && !timeUp(deadline)) {
      ctx.checkpoint(); eng.guard()
      if (!torches.count()) { res.noTorches = true; break }
      const me = bot.entity.position
      left.sort((a, b) => Math.hypot(a.x + 0.5 - me.x, a.z + 0.5 - me.z) - Math.hypot(b.x + 0.5 - me.x, b.z + 0.5 - me.z))
      const t = left.shift(), cell = new Vec3(t.x, t.y, t.z)
      const there = bot.blockAt(cell), floor = bot.blockAt(cell.offset(0, -1, 0))
      if (!there || !floor) { res.failed++; continue }
      if (torches.torchNear(cell, 1)) continue                                   // somebody's torch is right here already
      if (!(await approach(ctx, cell, 'a torch spot'))) { res.failed++; continue }
      if (!(await clearGrass(ctx, cell))) { res.failed++; continue }
      if (!(await eng.see(ctx, floor, 'a torch spot'))) { res.failed++; continue }
      const r = await torches.place(ctx, bot.blockAt(floor.position))
      if (r.ok) { res.placed++; S.stats.lit = (S.stats.lit || 0) + 1 } else { res.failed++; log(`torch ${t.x},${t.y},${t.z}: ${r.why}`) }
    }
    if (res.placed) save()
    return res
  }

  // ---------- upkeep ----------
  async function tend(ctx, { farm = null, deadline = null, quiet = true, sum = null, requestTorches = null, harvest = false } = {}) {
    const list = farm ? [farm] : farms()
    const out = []
    for (const f of list) {
      ctx.checkpoint()
      f.tendedAt = now()                                                        // set first: a farm that cannot be reached is not retried every minute
      const c = centreVec(f)
      if (bot.entity.position.distanceTo(c) > 14) {
        const r = await eng.goto(ctx, new goals.GoalNear(c.x, c.y, c.z, 6), 'the tree farm', 120000)
        if (!r.ok) { out.push({ id: f.id, ok: false, why: `cannot reach the farm (${r.err || 'no path'})` }); continue }
      }
      await eng.collectDrops(ctx, c, 16, 10)                                     // saplings and apples from decayed leaves
      const p = await plant(ctx, f, { deadline, keep: harvest ? L.summarize(f, get).trees : 0 })      // before a harvest: one sapling stays in the bag for every tree that is about to be felled
      const l = await light(ctx, f, { deadline, requestTorches })
      f.tendedAt = now(); save()
      if (sum) sum.planted += p.planted
      out.push({ id: f.id, ok: true, planted: p.planted, lit: l.placed, noSapling: p.noSapling, noTorches: l.noTorches, status: status(f) })
    }
    return out
  }
  const tendDue = () => has() && farms().some(f => now() - (f.tendedAt || 0) >= F().tendMinutes * 60000)

  // The whole job, bounded: returns what is done and what is still missing, `more` when another call would make progress.
  async function build(ctx, opts = {}) {
    const o = F(), deadline = now() + (opts.ms || o.workMs)
    const out = { ok: false, created: false, planted: 0, lit: 0, needs: [], more: false }
    if (!overworld()) return { ...out, why: 'only in the overworld' }
    let f = opts.farm || farms()[0]
    if (!f) {
      const c = await create(ctx, opts)
      if (!c.ok) return { ...out, why: c.why, hint: c.hint }
      f = c.farm; out.created = !c.existing
    }
    out.farm = f.id
    const c = centreVec(f)
    if (bot.entity.position.distanceTo(c) > 14) {
      const r = await eng.goto(ctx, new goals.GoalNear(c.x, c.y, c.z, 6), 'the tree farm', 120000)
      if (!r.ok) return { ...out, why: `cannot reach the farm (${r.err || 'no path'})` }
    }
    // saplings for the first planting; later ones come from the farm itself
    const s0 = L.surveyFarm(f, get)
    const empty = s0.filter(s => s.ok && s.state === 'empty').length
    const planted0 = s0.filter(s => s.state === 'sapling').length + s0.filter(s => s.state === 'tree').length
    const want = Math.min(empty, Math.max(0, o.startSaplings - planted0))
    if (want > 0 && bagSaplings(f) < want) {
      const g = await saplings(ctx, f, want, { deadline })
      if (g.hint && !bagSaplings(f)) out.needs.push(g.hint)
    }
    const p = await plant(ctx, f, { max: Math.max(want, 0) || 99, deadline })
    out.planted = p.planted
    const l = await light(ctx, f, { deadline, requestTorches: opts.requestTorches })
    out.lit = l.placed
    if (l.noTorches) out.needs.push(`craft torches (${l.unlit} torch spots are dark)`)
    f.tendedAt = now(); save()
    const st = status(f)
    out.status = st
    out.ok = st.saplings + st.trees > 0 || out.planted > 0
    out.more = !timeUp(deadline) ? false : true
    if (!bagSaplings(f) && st.empty && !out.needs.length) out.needs.push(`${st.empty} empty spots: get ${f.species} saplings`)
    if (!has()) return out
    if (!opts.quiet && (out.created || out.planted || out.lit)) say(`${out.created ? 'Started a lit ' + f.species + ' tree farm' : 'Tree farm'} at ${f.x}, ${f.z}: planted ${out.planted}, lit ${out.lit} torch spots. ${st.saplings + st.trees}/${st.spots} spots in use.`.slice(0, 230))
    return out
  }

  // ---------- harvest ----------
  async function harvest(ctx, { logs = null, count = null } = {}) {
    if (!has()) return { ok: false, why: 'no tree farm yet' }
    const before = eng.countWhere(n => !!T.logSpecies(n))
    const r = await eng.run(ctx, { manual: true, farmOnly: true, wantLogs: logs || null, count })
    return { ok: true, status: r && r.status, logs: eng.countWhere(n => !!T.logSpecies(n)) - before, result: S.lastResult }
  }

  // The preserve-trees rule (Walter 2026-11-10): natural trees stay. Felling one is only allowed while there is no grown tree in the farm and the
  // bag is short of wood (the bootstrap), and then it is replanted like any other. `logs` = logs in the bag (planks count a quarter).
  function naturalPolicy({ logs = null } = {}) {
    const o = F()
    const have = logs === null ? eng.countWhere(n => !!T.logSpecies(n)) : logs
    if (!has()) return { natural: true, farm: false, why: 'no tree farm yet: build one (tree_farm build) so natural trees can be kept' }
    const grown = farms().reduce((n, f) => n + L.summarize(f, get).trees, 0)
    if (grown > 0) return { natural: false, farm: true, grown, why: `the tree farm has ${grown} grown tree(s): harvest those (tree_farm harvest); natural trees are kept` }
    if (have >= o.bootstrapLogs) return { natural: false, farm: true, grown, why: `already ${have} logs on me and the farm is still growing: natural trees are kept` }
    return { natural: true, farm: true, grown, why: 'bootstrap wood while the farm grows' }
  }

  return { has, farms, status, line, create, saplings, breakLeaves, plant, light, tend, tendDue, build, harvest, naturalPolicy, register, defaults: F }
}
