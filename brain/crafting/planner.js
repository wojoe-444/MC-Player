// Crafting planner: pure arithmetic over registry recipes, no bot, no I/O. Decides what to craft in which order, how much of
// each ingredient comes from the inventory and how much has to be taken from chests ("only take what is needed"), and what is
// still missing when it cannot be done.
//
//   const p = plan({ registry, recipesOf, target, count, inventory: Map(id->n), chests: Map(id->n) })
//   p.ok, p.steps [{id, recipe, times}], p.take Map(id->n) from chests, p.useInv Map, p.missing Map, p.needsTable, p.yield
//
// `recipesOf(itemId)` returns prismarine-recipe style recipes: { result:{id,count}, delta:[{id,count}], requiresTable }.
// Ingredients are looked up in this order: items the plan itself made in excess, the inventory, then the chests. When an
// ingredient is not there but has a recipe (logs -> planks -> sticks) it is crafted, up to `maxDepth` levels deep.

const DEFAULTS = { maxDepth: 3, budget: 6000 }

function plan(opts) {
  const { registry, recipesOf, target, count = 1 } = opts
  const maxDepth = opts.maxDepth ?? DEFAULTS.maxDepth
  let budget = opts.budget ?? DEFAULTS.budget
  const nameOf = (id) => (registry.items[id] && registry.items[id].name) || String(id)
  const idOf = (name) => registry.itemsByName[name] && registry.itemsByName[name].id
  const forbidden = new Set((opts.forbidden || ['lava_bucket', 'water_bucket', 'milk_bucket', 'powder_snow_bucket']).map(idOf).filter(x => x != null))
  const chestOk = opts.chestAllowed || (() => true)

  const base = { inv: new Map(opts.inventory || []), chest: new Map(opts.chests || []), extra: new Map(), take: new Map(), useInv: new Map(), missing: new Map(), steps: [] }
  const clone = (s) => ({ inv: new Map(s.inv), chest: new Map(s.chest), extra: new Map(s.extra), take: new Map(s.take), useInv: new Map(s.useInv), missing: new Map(s.missing), steps: s.steps.slice() })
  const adopt = (dst, src) => { for (const k of Object.keys(src)) dst[k] = src[k] }
  const bump = (m, id, n) => m.set(id, (m.get(id) || 0) + n)
  const chestAvail = (s, id) => chestOk(id) ? (s.chest.get(id) || 0) : 0
  const avail = (s, id) => (s.extra.get(id) || 0) + (s.inv.get(id) || 0) + chestAvail(s, id)

  // takes up to n of `id` from surplus, then inventory, then chests; returns what is still needed
  function takeFrom(s, id, n) {
    for (const [pool, rec] of [[s.extra, null], [s.inv, s.useInv]]) {
      const have = pool.get(id) || 0
      if (have > 0 && n > 0) { const t = Math.min(have, n); pool.set(id, have - t); if (rec) bump(rec, id, t); n -= t }
    }
    const c = chestAvail(s, id)
    if (c > 0 && n > 0) { const t = Math.min(c, n); s.chest.set(id, c - t); bump(s.take, id, t); n -= t }
    return n
  }

  // Crafting an item back out of its storage block ("uncrafting" iron_block into 9 ingots) is only done when asked for outright.
  const decompressCache = new Map()
  function isDecompress(rec) {
    const ins = rec.delta.filter(d => d.count < 0)
    if (ins.length !== 1 || ins[0].count !== -1) return false
    const src = ins[0].id, res = rec.result.id
    const key = `${src}>${res}`
    if (decompressCache.has(key)) return decompressCache.get(key)
    const back = recipesOf(src).some(r => r.delta.filter(d => d.count < 0).length === 1 && r.delta.find(d => d.count < 0).id === res)
    decompressCache.set(key, back)
    return back
  }

  // when nothing separates the variants (all ingredients missing), report the ordinary one: oak before cherry, cobblestone before blackstone
  const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'bamboo', 'crimson', 'warped', 'cobblestone', 'cobbled_deepslate', 'blackstone']
  const pref = (rec) => Math.min(99, ...rec.delta.filter(d => d.count < 0).map(d => { const n = nameOf(d.id); const i = WOODS.findIndex(w => n === w || n.startsWith(w + '_')); return i < 0 ? 50 : i }))

  const obtainMemo = new Map()
  function obtainable(s, id, depth) {
    if (avail(s, id) > 0) return true
    if (depth >= maxDepth) return false
    const key = `${id}|${depth}`
    if (obtainMemo.has(key)) return obtainMemo.get(key)
    obtainMemo.set(key, false)   // cycle guard
    const ok = recipesOf(id).some(r => usable(r, true) && r.delta.filter(d => d.count < 0).every(d => obtainable(s, d.id, depth + 1)))
    obtainMemo.set(key, ok)
    return ok
  }
  function usable(rec, sub) {
    if (rec.delta.some(d => d.count < 0 && forbidden.has(d.id))) return false
    if (sub && isDecompress(rec)) return false
    return true
  }

  // Try the recipe variants (13 kinds of planks make sticks, coal or charcoal make torches): the ones the bot can actually
  // supply go first. Returns the number of items still missing (0 = done) and updates `s`.
  function craftIt(s, id, n, depth, sub) {
    const all = recipesOf(id).filter(r => usable(r, sub))
    if (!all.length || depth >= maxDepth + (sub ? 0 : 1)) { bump(s.missing, id, n); return n }
    const feasible = all.filter(r => r.delta.filter(d => d.count < 0).every(d => obtainable(s, d.id, depth + 1)))
    const cands = (feasible.length ? feasible : all).map((r, i) => {
      const times = Math.ceil(n / r.result.count)
      const cover = r.delta.filter(d => d.count < 0).reduce((a, d) => a + Math.min(avail(s, d.id), -d.count * times), 0)
      return { r, i, times, cover, pref: pref(r) }
    }).sort((a, b) => b.cover - a.cover || a.pref - b.pref || a.i - b.i)
    let best = null
    for (const c of cands) {
      if (--budget < 0) break
      const t = clone(s)
      let miss = 0
      for (const d of c.r.delta) if (d.count < 0) miss += need(t, d.id, -d.count * c.times, depth + 1)
      if (miss === 0) {
        t.steps.push({ id, recipe: c.r, times: c.times })
        const made = c.times * c.r.result.count
        if (made > n) bump(t.extra, id, made - n)
        adopt(s, t)
        return 0
      }
      if (!best || miss < best.miss) best = { t, miss }
    }
    if (best) { adopt(s, best.t); return best.miss }
    bump(s.missing, id, n)
    return n
  }
  // an ingredient: surplus / inventory / chests first, then crafted
  function need(s, id, n, depth) {
    n = takeFrom(s, id, n)
    if (n <= 0) return 0
    return craftIt(s, id, n, depth, true)
  }

  const s = base
  const miss = craftIt(s, target, count, 0, false)
  const top = s.steps.length ? s.steps[s.steps.length - 1] : null
  const topRec = top && top.id === target ? top : null
  const made = topRec ? topRec.times * topRec.recipe.result.count : 0
  const out = {
    ok: miss === 0 && !!topRec, target, wanted: count, yield: made, steps: s.steps,
    take: s.take, useInv: s.useInv, missing: s.missing,
    needsTable: s.steps.some(st => st.recipe.requiresTable), exhausted: budget < 0
  }
  if (!out.ok && !out.missing.size) out.missing = new Map([[target, count]])
  return out
}

// Largest count (1..max) the plan can do right now, 0 when not even one is possible. Feasibility only shrinks as count grows.
function maxFeasible(args, max = 2304) {
  if (!plan({ ...args, count: 1 }).ok) return 0
  let lo = 1, hi = Math.max(1, max)
  if (plan({ ...args, count: hi }).ok) return hi
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (plan({ ...args, count: mid }).ok) lo = mid; else hi = mid }
  return lo
}

const tally = (m, nameOf) => [...m.entries()].filter(([, n]) => n > 0).map(([id, n]) => `${n} ${String(nameOf(id)).replace(/_/g, ' ')}`)

module.exports = { plan, maxFeasible, tally }
