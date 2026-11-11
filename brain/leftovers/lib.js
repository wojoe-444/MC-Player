// brain/leftovers/lib.js: the pure core of the leftovers detector (no bot, no timers, no files). Two kinds of mess a bot leaves behind that Walter should
// never have to point out (2026-11-11 screenshot at -6007,72,-2361: cobble and dirt scaffolding pillars that were never taken down, and trees cut only
// part of the way up, the logs that stayed keeping a whole canopy of leaves alive):
//
//   scaffold(...)  clusters of plain filler blocks that one of our bots PLACED (the ledger says so), that are still exactly as placed, outside any named space
//                  (shaft, room, farm, pen), open to the sky, and older than a few minutes: pillars, towers and strays.
//   trees(...)     clusters of natural logs that stand on nothing: a tree whose lower logs were cut and whose upper logs and limbs stayed. No ledger is needed
//                  for this one (a cut tree is recognisable from the world alone: every living tree has a log on soil), the ledger only says who last cut near it.
//
// Both return plain data: { clusters: [{ id, ... }], ... }. `read(x, y, z)` returns a block name, or null when the chunk is not loaded.
'use strict'

const AIR = /^(air|cave_air|void_air)$/
const FLUID = /^(water|lava|bubble_column)$/
const LOG = /^(oak|spruce|birch|jungle|acacia|dark_oak|cherry|pale_oak)_log$/          // mangrove roots stand in water, stripped logs and wood blocks are builds
const LEAVES = /_leaves$/
// filler a bot places to climb or bridge (the same set the tidy step takes down: autopilot/plan.js SCAFFOLD, plus what nav's Reach may place)
const SCAFFOLD = /^(cobblestone|cobbled_deepslate|dirt|coarse_dirt|andesite|diorite|granite|tuff|netherrack|stone|sandstone|blackstone)$/
// what makes a cluster part of a house instead of scaffolding: it touches one of these
const HOUSE = /_planks$|_door$|_bed$|^(chest|barrel|trapped_chest|crafting_table|furnace|smoker|blast_furnace|glass|glass_pane|ladder|hopper|farmland|lantern)$|_slab$|_stairs$|_fence|_wall$|_trapdoor$|_sign$|bricks?$|^smooth_|^polished_/
// blocks a body walks through (nothing solid): covers for "is there rock over this?"
const SOFT = /^(air|cave_air|void_air|water|lava|short_grass|tall_grass|fern|large_fern|dead_bush|vine|snow|torch|wall_torch|poppy|dandelion|azure_bluet|cornflower|oxeye_daisy|lily_of_the_valley|allium|blue_orchid|sweet_berry_bush|lily_pad|seagrass|tall_seagrass|kelp|kelp_plant|glow_lichen|moss_carpet|bush|firefly_bush|leaf_litter|wildflowers|pink_petals|.*_tulip|.*_sapling|.*_leaves|.*_log|.*_wood)$/

const SIX = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
const key = (x, y, z) => `${x},${y},${z}`
const solid = (name) => !!name && !SOFT.test(name)

const DEFAULTS = {
  minAgeMs: 10 * 60000,       // a block placed less than this long ago may still be in use (a climb in progress)
  coverMax: 8,                // rock within this many blocks above means under ground: tunnel plugs and cave walls are not scaffolding
  pillarMinH: 3,              // a stack this tall (and at most 2x2 wide) is a pillar; wider stacks are towers
  maxClusterCells: 400,
  treeMaxLogs: 160, treeBox: 14,
  cutMinAgeMs: 3 * 60000, cutReach: 4,   // a log dug less than 3 minutes ago may be a felling in progress
}

// ---- scaffold ----
// `cells`: ledger cells { x, y, z, op, block, by, t, space, via }. `isOurs(name)`: is that bot one of ours (a block a player placed is never reported: not ours to take down).
// `read`: block name at a cell (null = chunk not loaded). `skipCell(x, y, z)`: cells that belong to a structure the caller knows (the shelter).
// Why a placed block is NOT a leftover is counted in `reasons`, so a detector that finds nothing can say why (2026-11-11 the first version found 0 where 74 columns stood).
// What decides: ours + placed + filler + still there + open to the sky + old enough. A named space does NOT exempt a cell (the crop plot, a tree farm or a pen box covers the ground
// round the base, and a pillar left in one is as much a leftover as any other), only a build job inside a named space does (the schematic's or the tower's own walls).
const BUILD_VIA = /^(build|schematic|mobfarm|excavation|husbandry)$/
// a placed dirt block turns into grass_block (or podzol, mycelium) under the sky: still the block we placed
const SAME = { dirt: /^(dirt|grass_block|podzol|mycelium)$/, coarse_dirt: /^(coarse_dirt|dirt)$/ }
const still = (placed, now) => placed === now || (SAME[placed] ? SAME[placed].test(now || '') : false)

function scaffold({ cells, read, isOurs, now, skipCell = () => false, opt = {} }) {
  const o = { ...DEFAULTS, ...opt }
  const cand = new Map()
  const reasons = { placed: 0, notFiller: 0, notOurs: 0, young: 0, buildJob: 0, shelter: 0, unloaded: 0, changed: 0, houseWall: 0, covered: 0 }
  for (const c of cells) {
    if (c.op !== 'p') continue
    reasons.placed++
    if (!SCAFFOLD.test(c.block || '')) { reasons.notFiller++; continue }
    if (!isOurs(c.by)) { reasons.notOurs++; continue }
    if (now - c.t < o.minAgeMs) { reasons.young++; continue }
    if (c.space && BUILD_VIA.test(c.via || '')) { reasons.buildJob++; continue }
    if (skipCell(c.x, c.y, c.z)) { reasons.shelter++; continue }
    const cur = read(c.x, c.y, c.z)
    if (cur == null) { reasons.unloaded++; continue }
    if (!still(c.block, cur)) { reasons.changed++; continue }                       // gone, or something else stands there now
    cand.set(key(c.x, c.y, c.z), c)
  }
  // a cell that touches a wall, door, glass, fence... belongs to the structure it touches (the cell, not its whole cluster: a pillar the go-to left against a wall is still a pillar)
  for (const [k, c] of [...cand]) {
    let wall = false
    for (const [dx, dy, dz] of SIX) { const n = read(c.x + dx, c.y + dy, c.z + dz); if (n && HOUSE.test(n)) { wall = true; break } }
    if (wall) { cand.delete(k); reasons.houseWall++ }
  }
  // open to the sky: no natural rock within coverMax above (our own stacked blocks do not count as cover)
  for (const [k, c] of [...cand]) {
    let covered = false
    for (let dy = 1; dy <= o.coverMax; dy++) {
      const n = read(c.x, c.y + dy, c.z)
      if (n == null) break
      if (solid(n) && !cand.has(key(c.x, c.y + dy, c.z))) { covered = true; break }
    }
    if (covered) { cand.delete(k); reasons.covered++ }
  }
  const seen = new Set(), clusters = []
  for (const [k0, c0] of cand) {
    if (seen.has(k0)) continue
    const cells2 = [], q = [c0]; seen.add(k0)
    while (q.length && cells2.length < o.maxClusterCells) {
      const c = q.pop(); cells2.push(c)
      for (const [dx, dy, dz] of SIX) { const k = key(c.x + dx, c.y + dy, c.z + dz); if (seen.has(k)) continue; const n = cand.get(k); if (n) { seen.add(k); q.push(n) } }
    }
    const b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity }
    let t0 = Infinity, t1 = 0
    const by = {}, blocks = {}, via = {}
    for (const c of cells2) {
      b.x0 = Math.min(b.x0, c.x); b.x1 = Math.max(b.x1, c.x); b.y0 = Math.min(b.y0, c.y); b.y1 = Math.max(b.y1, c.y); b.z0 = Math.min(b.z0, c.z); b.z1 = Math.max(b.z1, c.z)
      t0 = Math.min(t0, c.t); t1 = Math.max(t1, c.t)
      by[c.by] = (by[c.by] || 0) + 1; blocks[c.block] = (blocks[c.block] || 0) + 1; if (c.via) via[c.via] = (via[c.via] || 0) + 1
    }
    const h = b.y1 - b.y0 + 1, w = b.x1 - b.x0 + 1, d = b.z1 - b.z0 + 1
    const kind = h >= o.pillarMinH ? (w <= 2 && d <= 2 ? 'pillar' : 'tower') : 'stray'
    const top = (m) => Object.entries(m).sort((a, z) => z[1] - a[1])[0]
    const id = `scaffold@${b.x0},${b.y0},${b.z0}`
    clusters.push({ id, what: 'scaffold', kind, n: cells2.length, h, w, d, box: b, pos: [b.x0, b.y0, b.z0], top: [b.x0, b.y1, b.z0], block: (top(blocks) || [null])[0], by: (top(by) || [null])[0], via: Object.keys(via).sort((a, z) => via[z] - via[a])[0] || null,
      ageMin: Math.round((now - t1) / 60000), firstAgeMin: Math.round((now - t0) / 60000), cells: cells2.map(c => [c.x, c.y, c.z]) })
  }
  clusters.sort((a, b) => (b.h - a.h) || (b.n - a.n))
  return { clusters, candidates: cand.size, reasons, blocks: clusters.reduce((s, c) => s + c.n, 0) }
}

// ---- trees ----
// `seeds`: positions of standing natural logs (bot.findBlocks). Flood-fills each log's connected tree (26 neighbours, same species, as treefarm/trees.js does) and
// keeps the ones with no log on solid ground: the trunk is gone from the soil up. `get(x, y, z)`: the ledger's record of a cell or null (only to say who cut there
// and to skip logs a bot placed itself).
function trees({ seeds, read, get = () => null, dug = [], isOurs = () => false, now, opt = {} }) {
  const o = { ...DEFAULTS, ...opt }
  const seen = new Set(), clusters = []
  const claimed = new Set()                                                            // logs already part of an ungrounded cluster
  for (const s of seeds) {
    if (seen.has(key(s.x, s.y, s.z))) continue
    const first = read(s.x, s.y, s.z)
    if (!first || !LOG.test(first)) continue
    const logs = [], q = [{ x: s.x, y: s.y, z: s.z }]
    const local = new Set([key(s.x, s.y, s.z)])
    let partial = false
    while (q.length && logs.length < o.treeMaxLogs) {
      const p = q.shift(); logs.push(p)
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        if (!dx && !dy && !dz) continue
        const x = p.x + dx, y = p.y + dy, z = p.z + dz, k = key(x, y, z)
        if (local.has(k)) continue
        if (Math.abs(x - s.x) > o.treeBox || Math.abs(z - s.z) > o.treeBox || Math.abs(y - s.y) > 40) continue
        local.add(k)
        const n = read(x, y, z)
        if (n == null) { partial = true; continue }                                     // an unloaded neighbour: cannot say what is there
        if (n === first) q.push({ x, y, z })
      }
    }
    for (const p of logs) seen.add(key(p.x, p.y, p.z))
    if (partial || q.length) continue                                                    // the tree runs into unloaded ground or is bigger than we follow: do not guess
    if (logs.some(p => { const r = get(p.x, p.y, p.z); return r && r.op === 'p' && isOurs(r.by) })) continue      // a bot placed this log: a build, not a tree
    // grounded: some log has solid, non-wood, non-leaf ground right under it (or the chunk below is not loaded: unknown counts as grounded)
    let grounded = false
    for (const p of logs) {
      const below = read(p.x, p.y - 1, p.z)
      if (below == null) { grounded = true; break }
      if (solid(below) && !FLUID.test(below)) { grounded = true; break }
    }
    if (grounded) continue
    for (const p of logs) claimed.add(key(p.x, p.y, p.z))
    const b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity }
    for (const p of logs) { b.x0 = Math.min(b.x0, p.x); b.x1 = Math.max(b.x1, p.x); b.y0 = Math.min(b.y0, p.y); b.y1 = Math.max(b.y1, p.y); b.z0 = Math.min(b.z0, p.z); b.z1 = Math.max(b.z1, p.z) }
    // the leaves the remaining logs keep alive (within 2 blocks of a log; a leaf needs a log within 6 steps to stay, so this is the visible part)
    let leaves = 0
    const lseen = new Set()
    for (const p of logs) for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
      const k = key(p.x + dx, p.y + dy, p.z + dz); if (lseen.has(k)) continue; lseen.add(k)
      const n = read(p.x + dx, p.y + dy, p.z + dz); if (n && LEAVES.test(n)) leaves++
    }
    // who last cut a log next to this (the ledger records every dig)
    let cut = null
    for (const p of logs) for (let dx = -1; dx <= 1; dx++) for (let dy = -2; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const r = get(p.x + dx, p.y + dy, p.z + dz)
      if (r && r.op === 'd' && LOG.test(r.block || '') && (!cut || r.t > cut.t)) cut = r
    }
    const low = logs.reduce((m, p) => (p.y < m.y ? p : m), logs[0])
    clusters.push({ id: `tree@${low.x},${low.y},${low.z}`, what: 'tree', kind: 'ungrounded', n: logs.length, species: first.replace(/_log$/, ''), leaves, h: b.y1 - b.y0 + 1, box: b, pos: [low.x, low.y, low.z],
      by: cut ? cut.by : null, via: cut ? cut.via : null, space: cut ? cut.space : null, cutAgeMin: cut ? Math.round((now - cut.t) / 60000) : null, logs: logs.map(p => [p.x, p.y, p.z]) })
  }
  // Second rule: a tree a bot cut into but left standing on its stump, or cut in the middle, or with a limb left. Its logs are grounded (the stump) or joined to a neighbour's crown, so
  // the rule above cannot see them; the ledger can: a log one of our bots dug (nothing stands in that cell now) with logs of the same tree beside it or above it. A tree that was felled
  // and has grown back has logs in the cells the ledger says were dug, and is skipped.
  const cuts = dug.filter(d => LOG.test(d.block || '') && isOurs(d.by) && now - d.t >= o.cutMinAgeMs)
  if (cuts.length) {
    const cutAt = new Map(); for (const d of cuts) cutAt.set(key(d.x, d.y, d.z), d)
    const done = new Set()
    for (const s of seeds) {
      const k0 = key(s.x, s.y, s.z)
      if (seen.has(k0) && claimed.has(k0) || done.has(k0)) continue
      const first = read(s.x, s.y, s.z); if (!first || !LOG.test(first)) continue
      if (!cuts.some(d => Math.abs(d.x - s.x) <= o.cutReach + 2 && Math.abs(d.z - s.z) <= o.cutReach + 2)) continue      // nowhere near a cut (cheap test before the flood)
      // the whole connected tree (grounded logs included), to tell a regrown tree from a cut one
      const F = [], q = [{ x: s.x, y: s.y, z: s.z }], local = new Set([k0])
      let partial = false
      while (q.length && F.length < o.treeMaxLogs) {
        const p = q.shift(); F.push(p)
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
          if (!dx && !dy && !dz) continue
          const x = p.x + dx, y = p.y + dy, z = p.z + dz, k = key(x, y, z)
          if (local.has(k)) continue
          if (Math.abs(x - s.x) > o.treeBox || Math.abs(z - s.z) > o.treeBox || Math.abs(y - s.y) > 40) continue
          local.add(k)
          const n = read(x, y, z)
          if (n == null) { partial = true; continue }
          if (n === first) q.push({ x, y, z })
        }
      }
      for (const p of F) done.add(key(p.x, p.y, p.z))
      if (partial || q.length) continue
      if (F.some(p => cutAt.has(key(p.x, p.y, p.z)))) continue                          // a log stands where we dug one: it grew back
      if (F.some(p => { const r = get(p.x, p.y, p.z); return r && r.op === 'p' && isOurs(r.by) })) continue
      // The cut this tree is joined to: a dug log of ours right next to (or one cell off) a log of the tree. What stands above that cut is the remnant; the stump below it is a stump.
      const R = [], cutBy = []
      let lowCut = null
      for (const p of F) for (let dx = -1; dx <= 1; dx++) for (let dy = -2; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const d = cutAt.get(key(p.x + dx, p.y + dy, p.z + dz))
        if (d && (!lowCut || d.y < lowCut.y)) lowCut = d
      }
      if (!lowCut) continue
      for (const p of F) if (!claimed.has(key(p.x, p.y, p.z)) && p.y > lowCut.y) { R.push(p); cutBy.push(lowCut) }
      if (!R.length) continue
      for (const p of R) claimed.add(key(p.x, p.y, p.z))
      const b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity }
      for (const p of R) { b.x0 = Math.min(b.x0, p.x); b.x1 = Math.max(b.x1, p.x); b.y0 = Math.min(b.y0, p.y); b.y1 = Math.max(b.y1, p.y); b.z0 = Math.min(b.z0, p.z); b.z1 = Math.max(b.z1, p.z) }
      let leaves = 0; const lseen = new Set()
      for (const p of R) for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
        const k = key(p.x + dx, p.y + dy, p.z + dz); if (lseen.has(k)) continue; lseen.add(k)
        const n = read(p.x + dx, p.y + dy, p.z + dz); if (n && LEAVES.test(n)) leaves++
      }
      const cut = cutBy.reduce((m, d) => (!m || d.t > m.t ? d : m), null)
      const low = R.reduce((m, p) => (p.y < m.y ? p : m), R[0])
      clusters.push({ id: `tree@${low.x},${low.y},${low.z}`, what: 'tree', kind: 'cut', n: R.length, species: first.replace(/_log$/, ''), leaves, h: b.y1 - b.y0 + 1, box: b, pos: [low.x, low.y, low.z],
        by: cut.by, via: cut.via, space: cut.space || null, cutAgeMin: Math.round((now - cut.t) / 60000), logs: R.map(p => [p.x, p.y, p.z]) })
    }
  }
  clusters.sort((a, b) => (b.leaves - a.leaves) || (b.n - a.n))
  return { clusters, logs: clusters.reduce((s, c) => s + c.n, 0), leaves: clusters.reduce((s, c) => s + c.leaves, 0) }
}

// ---- taking scaffolding down ----
// A column comes down top first. Of the blocks `eligible` (objects with x, y, z) keep those whose upper neighbour is passable (`passableAbove(x, y, z)`: air, a torch, a plant)
// or is itself eligible, highest first. The old tidy rule (nothing at all on top) let one block off each pillar per pass and the rest stood for good.
function topFirst(eligible, passableAbove) {
  const ok = new Set(eligible.map(p => key(p.x, p.y, p.z)))
  return eligible.filter(p => passableAbove(p.x, p.y + 1, p.z) || ok.has(key(p.x, p.y + 1, p.z))).sort((a, b) => b.y - a.y)
}

module.exports = { scaffold, trees, topFirst, SCAFFOLD, LOG, LEAVES, HOUSE, DEFAULTS, solid }
