// brain/lightup/plan.js: the pure half of the light-up task (Walter 2026-11-10). No bot, no I/O: everything works on a `world` object, so it is tested offline.
//
// Why: monsters spawn only where block light is 0, on a solid floor with two free cells above. Every dark cave within spawn range competes with the mob
// farm for the same mob cap, so the farm needs the dark spots around it lit. Walter allows ONE scan through blocks for this purpose (an exception to the
// no-x-ray rule, 2026-11-10): the list of dark spawnable spots in the loaded chunks. Nothing else is learnt that way; placing a torch still needs a view of
// the floor, and the bot still walks there like any player.
//
// world = {
//   loaded(x, z)            is the chunk column there loaded
//   open(x, y, z)           a cell nothing collides with and that holds no liquid
//   pass(x, y, z)           optional: a cell the bot can be in or move through (open, or a ladder, vine, door, shallow water); defaults to open
//   floor(x, y, z)          a block monsters spawn on (full solid block, not slab/glass/leaves ...)
//   torchFloor(x, y, z)     a block a torch stands on (plain full block)
//   level(x, y, z)          block light from the sources the bot knows (0 = monsters may spawn)
//   cost(x, y, z)           how much light loses entering that cell (1 open, 99 opaque or unloaded)
//   sky(x, y, z)            open sky above the cell (surface: only dark at night)
// }
// Cells are [x, y, z]. A torch goes INTO a cell, on the floor block under it.
'use strict'

const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
const TORCH_LIGHT = 14
const SPACING = 3        // Walter 2026-11-10: torch, air, air, torch is the closest allowed: some axis differs by 3 or more

const keyer = (c) => { const [cx, cy, cz] = c; return (x, y, z) => ((x - cx + 1024) * 4096 + (y - cy + 2048)) * 2048 + (z - cz + 1024) }
const noop = async () => {}

// can a torch go at `t` when torches stand at `others`? (same rule as S.torchCrowded: crowded = within 2 on every axis)
const spaced = (t, others, spacing = SPACING) => {
  for (const o of others) if (Math.abs(o[0] - t[0]) < spacing && Math.abs(o[1] - t[1]) < spacing && Math.abs(o[2] - t[2]) < spacing) return false
  return true
}

// The dark spawn spots: open cell with an open cell above it, on a spawn floor, block light 0.
//   opts.r / opts.dy   horizontal radius and vertical half-range around `center`
//   opts.exclude(x,y,z) cells that are meant to be dark (the farm's own platform and kill chamber) or must not be touched
//   opts.sky           include cells under open sky (default false: by day they never spawn anything)
//   opts.tick          awaited every few columns so a big scan does not freeze combat
async function scan(w, center, opts = {}) {
  const r = opts.r || 48, dy = opts.dy || 40, exclude = opts.exclude || null, tick = opts.tick || noop
  const cx = Math.floor(center[0]), cy = Math.floor(center[1]), cz = Math.floor(center[2])
  const out = []; let sky = 0, excluded = 0, columns = 0
  for (let x = cx - r; x <= cx + r; x++) {
    for (let z = cz - r; z <= cz + r; z++) {
      const ddx = x - cx, ddz = z - cz
      if (ddx * ddx + ddz * ddz > r * r || !w.loaded(x, z)) continue
      for (let y = cy - dy; y <= cy + dy; y++) {
        if (!w.floor(x, y - 1, z) || !w.open(x, y, z) || !w.open(x, y + 1, z)) continue
        if (w.level(x, y, z) > 0) continue
        if (exclude && exclude(x, y, z)) { excluded++; continue }
        if (w.sky(x, y, z)) { sky++; if (!opts.sky) continue }
        out.push([x, y, z])
      }
    }
    if (++columns % 8 === 0) await tick()
  }
  return { cells: out, sky, excluded }
}

// Light from one torch placed at `src`, the way the game spreads it (loses at least 1 per cell, stops at opaque ones).
// Returns { lvl: Map key -> level, cells: every lit cell as [x, y, z] }.
function flood(w, src, key, maxLevel = TORCH_LIGHT) {
  const lvl = new Map(), buckets = Array.from({ length: maxLevel + 1 }, () => []), cells = [src]
  lvl.set(key(src[0], src[1], src[2]), maxLevel); buckets[maxLevel].push(src)
  for (let L = maxLevel; L >= 2; L--) {
    for (const [x, y, z] of buckets[L]) {
      if (lvl.get(key(x, y, z)) !== L) continue
      for (const [ax, ay, az] of DIRS) {
        const nx = x + ax, ny = y + ay, nz = z + az
        const nl = L - w.cost(nx, ny, nz)
        if (nl <= 0) continue
        const k = key(nx, ny, nz)
        if ((lvl.get(k) || 0) >= nl) continue
        if (!lvl.has(k)) cells.push([nx, ny, nz])
        lvl.set(k, nl); buckets[nl].push([nx, ny, nz])
      }
    }
  }
  return { lvl, cells }
}

// Open cells connected to `start` through 6-neighbour moves inside the scan box. An over-estimate of what the bot can walk (it counts a long drop as a
// way), but it drops sealed pockets, which the bot cannot reach without digging and may not dig for this job.
async function connected(w, start, center, opts = {}) {
  const r = opts.r || 48, dy = opts.dy || 40, tick = opts.tick || noop
  const cx = Math.floor(center[0]), cy = Math.floor(center[1]), cz = Math.floor(center[2])
  const pass = w.pass || w.open
  const key = keyer(center), seen = new Set(), stack = [[Math.floor(start[0]), Math.floor(start[1]), Math.floor(start[2])]]
  if (!pass(stack[0][0], stack[0][1], stack[0][2])) return seen
  seen.add(key(...stack[0])); let n = 0
  while (stack.length) {
    const [x, y, z] = stack.pop()
    for (const [ax, ay, az] of DIRS) {
      const nx = x + ax, ny = y + ay, nz = z + az
      if (Math.abs(ny - cy) > dy) continue
      const ddx = nx - cx, ddz = nz - cz
      if (ddx * ddx + ddz * ddz > r * r) continue
      const k = key(nx, ny, nz)
      if (seen.has(k) || !w.loaded(nx, nz) || !pass(nx, ny, nz)) continue
      seen.add(k); stack.push([nx, ny, nz])
    }
    if (++n % 4000 === 0) await tick()
  }
  return seen
}

// Choose torch cells for `dark`. Greedy set cover: the cell whose light reaches the most still-dark spots goes first, never closer than the spacing rule
// to a torch that stands or was already chosen, never where its light would reach a cell in `keepDark` (the farm's platform: it must stay dark).
//   opts.torches   existing torch cells; opts.max torches at most; opts.prefer(cell) a small penalty (< 1) to break ties, e.g. distance from the bot
async function plan(w, dark, opts = {}) {
  const torches = (opts.torches || []).map(t => [t[0], t[1], t[2]]), max = opts.max || 24, tick = opts.tick || noop, keepDark = opts.keepDark || null
  const prefer = opts.prefer || (() => 0), spacing = opts.spacing || SPACING
  if (!dark.length) return { torches: [], leftover: [], covered: 0, rejected: { leak: 0, floor: 0, spacing: 0 } }
  const center = dark[0], key = keyer(center), idx = new Map(dark.map((c, i) => [key(c[0], c[1], c[2]), i]))
  // candidates: the dark cells themselves (a torch in a dark cell lights it), thinned out when there are very many
  const cap = opts.maxCandidates || 700, step = Math.max(1, Math.ceil(dark.length / cap))
  const rejected = { leak: 0, floor: 0, spacing: 0 }
  const cands = []; let n = 0
  for (let i = 0; i < dark.length; i += (i % 7 === 0 ? 1 : step)) {          // thinned, but every 7th cell is always a candidate (small pockets stay coverable)
    const c = dark[i]
    if (!w.torchFloor(c[0], c[1] - 1, c[2])) { rejected.floor++; continue }
    if (!spaced(c, torches, spacing)) { rejected.spacing++; continue }
    const lit = flood(w, c, key)
    if (keepDark && lit.cells.some(q => keepDark(q[0], q[1], q[2]))) { rejected.leak++; continue }
    const cover = []
    for (const q of lit.cells) { const j = idx.get(key(q[0], q[1], q[2])); if (j !== undefined) cover.push(j) }
    cands.push({ c, cover })
    if (++n % 40 === 0) await tick()
  }
  const chosen = [], covered = new Set(), stand = torches.slice()
  while (chosen.length < max) {
    let best = null
    for (const cd of cands) {
      if (!spaced(cd.c, stand, spacing)) continue
      let gain = 0
      for (const j of cd.cover) if (!covered.has(j)) gain++
      if (gain <= 0) continue
      const score = gain - Math.min(0.99, prefer(cd.c))
      if (!best || score > best.score) best = { cd, gain, score }
    }
    if (!best) break
    chosen.push({ at: best.cd.c, gain: best.gain }); stand.push(best.cd.c)
    for (const j of best.cd.cover) covered.add(j)
    if (covered.size === dark.length) break
  }
  const leftover = []; for (let i = 0; i < dark.length; i++) if (!covered.has(i)) leftover.push(dark[i])
  return { torches: chosen, leftover, covered: covered.size, rejected }
}

// Order the chosen torches into a route that starts near `from` (nearest next), so the bot is in and out of a cave once.
function route(chosen, from) {
  const left = chosen.slice(), out = []; let cur = from
  while (left.length) {
    let bi = 0, bd = Infinity
    for (let i = 0; i < left.length; i++) { const a = left[i].at, d = Math.abs(a[0] - cur[0]) + Math.abs(a[1] - cur[1]) * 2 + Math.abs(a[2] - cur[2]); if (d < bd) { bd = d; bi = i } }
    const [p] = left.splice(bi, 1); out.push(p); cur = p.at
  }
  return out
}

module.exports = { scan, flood, connected, plan, route, spaced, keyer, SPACING, TORCH_LIGHT }
