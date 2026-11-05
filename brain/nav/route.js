// Long-distance routes.
//
// The pathfinder only knows the chunks that are loaded (about 100-160 blocks around the bot). For anything further away this module
//   1. plans a COARSE route on Walter's Xaero world map (planRoute): 16-block cells, cheap on explored land, expensive on water, steep
//      slopes and unexplored ground, forbidden on lava; the map is a top-down picture so it is only a guide, never the truth
//   2. walks it leg by leg (travel): each leg is a normal nav.goto() to a point ~64-96 blocks ahead; chunks load as the bot arrives,
//      a leg that fails is retried shorter / sideways / re-planned around the trouble spot
//   3. in the Nether (no usable map) it explores straight at the target with probes of the loaded chunks (frontier legs)
// planTravel() adds the dimension logic: walk to an overworld portal, hop, walk in the Nether (1:8), hop back, walk on.
const { Vec3 } = require('vec3')

const hdist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)

// ---------------------------------------------------------------- terrain classes from the Xaero picture
function classify(s) {
  if (!s || !s.explored) return 'unknown'
  const [r, g, b] = s.rgb || [0, 0, 0]
  const biome = s.biome || ''
  if (r > 170 && g < 135 && b < 75) return 'lava'                              // orange: lava lakes
  if (/frozen|ice_spikes/.test(biome) && b > r + 40) return 'ice'
  if (b > r + 40 && b > g + 18) return 'water'                                // blue-ish: sea, river, lake
  return 'land'
}

// ---------------------------------------------------------------- tiny binary heap
class Heap {
  constructor() { this.a = [] }
  get size() { return this.a.length }
  push(item) { const a = this.a; a.push(item); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p].f <= a[i].f) break;[a[p], a[i]] = [a[i], a[p]]; i = p } }
  pop() {
    const a = this.a, top = a[0], last = a.pop()
    if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l].f < a[m].f) m = l; if (r < a.length && a[r].f < a[m].f) m = r; if (m === i) break;[a[m], a[i]] = [a[i], a[m]]; i = m } }
    return top
  }
}

// ---------------------------------------------------------------- coarse route on the map
// map: anything with at(x, z) -> { explored, height, rgb, biome } (Xaero map or a fake). Returns { ok, points:[{x,z}], cost, expanded }.
function planRoute({ map, from, to, cell = 16, margin = 192, maxExpand = 90000, avoid = [], unknownCost = 2.2, waterCost = 6, iceCost = 1.4, maxSlope = 1.4 }) {
  const G = cell
  const dist = Math.hypot(to.x - from.x, to.z - from.z)
  if (dist < G * 2) return { ok: true, points: [{ x: from.x, z: from.z }, { x: to.x, z: to.z }], cost: dist, expanded: 0 }
  const x0 = Math.min(from.x, to.x) - margin, x1 = Math.max(from.x, to.x) + margin
  const z0 = Math.min(from.z, to.z) - margin, z1 = Math.max(from.z, to.z) + margin
  const cx0 = Math.floor(x0 / G), cx1 = Math.floor(x1 / G), cz0 = Math.floor(z0 / G), cz1 = Math.floor(z1 / G)
  const W = cx1 - cx0 + 1, H = cz1 - cz0 + 1
  const id = (cx, cz) => (cx - cx0) * H + (cz - cz0)
  const info = new Map()
  const cellInfo = (cx, cz) => {
    const k = id(cx, cz)
    let v = info.get(k)
    if (v) return v
    const x = cx * G + G / 2, z = cz * G + G / 2
    // three samples (centre + two corners) so a thin river does not hide a lake and a single pixel does not make a wall
    const ss = [map.at(x, z), map.at(x - G / 3, z - G / 3), map.at(x + G / 3, z + G / 3)]
    const kinds = ss.map(classify)
    let kind = kinds[0]
    if (kinds.includes('lava')) kind = 'lava'
    else if (kinds.filter(q => q === 'water').length >= 2) kind = 'water'
    else if (kinds.every(q => q === 'unknown')) kind = 'unknown'
    else if (kind === 'unknown') kind = kinds.find(q => q !== 'unknown')
    const hs = ss.filter(s => s && s.explored && typeof s.height === 'number').map(s => s.height)
    v = { x, z, kind, h: hs.length ? hs.reduce((a, b) => a + b, 0) / hs.length : null }
    info.set(k, v)
    return v
  }
  const penalty = (x, z) => { let p = 0; for (const a of avoid) if (Math.hypot(a.x - x, a.z - z) <= a.r) p += a.w; return p }
  const kindCost = { land: 1, ice: iceCost, unknown: unknownCost, water: waterCost, lava: Infinity }
  const sc = { cx: Math.floor(from.x / G), cz: Math.floor(from.z / G) }, gc = { cx: Math.floor(to.x / G), cz: Math.floor(to.z / G) }
  const hfun = (cx, cz) => Math.hypot((cx - gc.cx) * G, (cz - gc.cz) * G)
  const open = new Heap(), best = new Map(), parent = new Map()
  best.set(id(sc.cx, sc.cz), 0); open.push({ cx: sc.cx, cz: sc.cz, g: 0, f: hfun(sc.cx, sc.cz) })
  let expanded = 0, found = null, closest = { d: Infinity, cx: sc.cx, cz: sc.cz }
  const closed = new Set()
  while (open.size && expanded < maxExpand) {
    const n = open.pop(), nk = id(n.cx, n.cz)
    if (closed.has(nk)) continue
    closed.add(nk); expanded++
    const hd = hfun(n.cx, n.cz)
    if (hd < closest.d) closest = { d: hd, cx: n.cx, cz: n.cz }
    if (n.cx === gc.cx && n.cz === gc.cz) { found = n; break }
    const a = cellInfo(n.cx, n.cz)
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dz) continue
      const mx = n.cx + dx, mz = n.cz + dz
      if (mx < cx0 || mx > cx1 || mz < cz0 || mz > cz1) continue
      const mk = id(mx, mz)
      if (closed.has(mk)) continue
      const b = cellInfo(mx, mz)
      const kc = kindCost[b.kind]
      if (kc === Infinity && !(mx === gc.cx && mz === gc.cz)) continue
      const len = Math.hypot(dx, dz) * G
      let slope = 0
      if (a.h !== null && b.h !== null) slope = Math.abs(a.h - b.h) / len
      if (slope > maxSlope && a.kind !== 'water' && b.kind !== 'water') continue
      const step = len * (kc === Infinity ? 1 : kc) * (1 + Math.max(0, slope - 0.25) * 4) + penalty(b.x, b.z)
      // diagonal moves must not squeeze between two lava/impassable cells
      if (dx && dz && (kindCost[cellInfo(n.cx + dx, n.cz).kind] === Infinity || kindCost[cellInfo(n.cx, n.cz + dz).kind] === Infinity)) continue
      const g = n.g + step
      if (best.has(mk) && best.get(mk) <= g) continue
      best.set(mk, g); parent.set(mk, nk)
      open.push({ cx: mx, cz: mz, g, f: g + hfun(mx, mz) })
    }
  }
  const end = found || { cx: closest.cx, cz: closest.cz }
  const cells = []
  let k = id(end.cx, end.cz)
  const unid = (key) => ({ cx: Math.floor(key / H) + cx0, cz: (key % H) + cz0 })
  while (k !== undefined) { const c = unid(k); cells.push({ x: c.cx * G + G / 2, z: c.cz * G + G / 2 }); k = parent.get(k) }
  cells.reverse()
  const points = [{ x: from.x, z: from.z }, ...cells.slice(1, -1), { x: found ? to.x : cells[cells.length - 1].x, z: found ? to.z : cells[cells.length - 1].z }]
  return { ok: !!found, partial: !found, points: simplify(points, (a, b) => lineOk(a, b, cellInfo, G, kindCost, maxSlope)), cost: found ? found.g : null, expanded }
}

// straight segment passes only cheap cells?
function lineOk(a, b, cellInfo, G, kindCost, maxSlope) {
  const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (G / 2))
  const stepLen = Math.hypot(b.x - a.x, b.z - a.z) / (n || 1)
  let prevH = null
  for (let i = 1; i < n; i++) {
    const x = a.x + (b.x - a.x) * i / n, z = a.z + (b.z - a.z) * i / n
    const c = cellInfo(Math.floor(x / G), Math.floor(z / G))
    if (c.kind === 'water' || c.kind === 'lava' || c.kind === 'unknown' && kindCost.unknown > 1.5) return false
    if (c.h !== null) { if (prevH !== null && Math.abs(c.h - prevH) / stepLen > maxSlope) return false; prevH = c.h }
  }
  return true
}
// string pulling: drop points when the straight line between their neighbours is fine
function simplify(pts, ok) {
  if (pts.length <= 2) return pts
  const out = [pts[0]]
  let i = 0
  while (i < pts.length - 1) {
    let j = pts.length - 1
    while (j > i + 1 && !ok(pts[i], pts[j])) j--
    out.push(pts[j]); i = j
  }
  return out
}

// ---------------------------------------------------------------- walking a planned route
// Next point to aim for: `len` blocks further along the polyline than the bot's closest position on it.
function nextTarget(points, pos, len) {
  let bestI = 0, bestD = Infinity, bestT = 0
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1]
    const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz || 1
    const t = Math.max(0, Math.min(1, ((pos.x - a.x) * dx + (pos.z - a.z) * dz) / l2))
    const d = Math.hypot(a.x + dx * t - pos.x, a.z + dz * t - pos.z)
    if (d < bestD) { bestD = d; bestI = i; bestT = t }
  }
  let remaining = len
  let i = bestI, a = points[i], b = points[i + 1]
  let cur = { x: a.x + (b.x - a.x) * bestT, z: a.z + (b.z - a.z) * bestT }
  for (;;) {
    const segLeft = Math.hypot(b.x - cur.x, b.z - cur.z)
    if (segLeft >= remaining) { const f = remaining / (segLeft || 1); return { x: cur.x + (b.x - cur.x) * f, z: cur.z + (b.z - cur.z) * f, last: false } }
    remaining -= segLeft; cur = { x: b.x, z: b.z }; i++
    if (i >= points.length - 1) return { x: b.x, z: b.z, last: true }
    b = points[i + 1]
  }
}

// How far ahead the bot can currently see blocks (loaded chunks), probing along a bearing.
function loadedReach(bot, bearing, max = 160) {
  const p = bot.entity.position
  let r = 0
  for (let d = 16; d <= max; d += 16) {
    const b = bot.blockAt(new Vec3(Math.floor(p.x + Math.sin(bearing) * d * -1), Math.floor(p.y), Math.floor(p.z + Math.cos(bearing) * d * -1)))
    if (!b) break
    r = d
  }
  return r
}

// Standable cell near (x, z) in the loaded world: solid floor, 2 free cells above, no hazard. Searches y around `aroundY` and a small
// ring so a leg never ends inside a wall, a tree or lava. null when the area is not loaded or nothing fits.
function probeStandable(bot, x, z, aroundY, radius = 4) {
  const ok = (cx, cy, cz) => {
    const f = bot.blockAt(new Vec3(cx, cy - 1, cz)), a = bot.blockAt(new Vec3(cx, cy, cz)), b = bot.blockAt(new Vec3(cx, cy + 1, cz))
    if (!f || !a || !b) return false
    if (f.boundingBox !== 'block' || a.boundingBox !== 'empty' || b.boundingBox !== 'empty') return false
    for (const n of [f.name, a.name, b.name]) if (/lava|fire|cactus|magma|campfire|water|powder_snow|berry/.test(n)) return false
    return true
  }
  const fx = Math.floor(x), fz = Math.floor(z)
  let best = null
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
    const flat = Math.hypot(dx, dz)
    if (best && flat >= best.score) continue
    for (let dy = 0; dy <= 24; dy++) for (const s of dy ? [1, -1] : [1]) {
      const y = Math.floor(aroundY) + dy * s
      const score = flat + dy * 0.7
      if ((!best || score < best.score) && ok(fx + dx, y, fz + dz)) best = { score, x: fx + dx + 0.5, y, z: fz + dz + 0.5 }
    }
  }
  return best ? { x: best.x, y: best.y, z: best.z } : null
}

// Flood-fill the LOADED world around the bot over standable cells (steps up 1, drops up to 3, no hazards) and pick the reachable cell
// that gets closest to `target`. Unlike a straight-line aim this knows about walls and dead ends, so it finds the way round a corner
// in a Nether tunnel or out of a bay. `visited` ([{x,z}]) are places already used as leg ends: cells near them are discouraged so the
// bot does not ping-pong. Returns { x, y, z, d } (d = straight distance from that cell to the target) or null.
function reachableFrontier(bot, target, { radius = 56, visited = [], maxCells = 24000 } = {}) {
  const p = bot.entity.position
  const sx = Math.floor(p.x), sz = Math.floor(p.z)
  const bad = /lava|fire|cactus|magma|campfire|water|powder_snow|berry|web|portal|sculk|pointed_dripstone|tripwire/
  const cellAt = (x, y, z) => {
    const f = bot.blockAt(new Vec3(x, y - 1, z)), a = bot.blockAt(new Vec3(x, y, z)), b = bot.blockAt(new Vec3(x, y + 1, z))
    if (!f || !a || !b) return null
    if (f.boundingBox !== 'block' || a.boundingBox !== 'empty' || b.boundingBox !== 'empty') return false
    if (bad.test(f.name) || bad.test(a.name) || bad.test(b.name)) return false
    return true
  }
  const key = (x, y, z) => x + ',' + y + ',' + z
  const seen = new Set()
  const start = { x: sx, y: Math.floor(p.y + 1e-3), z: sz }
  const queue = [start]
  seen.add(key(start.x, start.y, start.z))
  let best = null, edge = null            // edge: best cell that touches the unloaded part of the world (the real frontier)
  for (let qi = 0; qi < queue.length && queue.length < maxCells; qi++) {
    const c = queue[qi]
    const d = Math.hypot(c.x + 0.5 - target.x, c.z + 0.5 - target.z)
    let pen = 0
    for (const v of visited) if (Math.hypot(v.x - c.x, v.z - c.z) < 14) pen += 25
    const score = d + pen
    if (qi > 0 && (!best || score < best.score)) best = { score, x: c.x + 0.5, y: c.y, z: c.z + 0.5, d }
    let touchesUnloaded = false
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = c.x + dx, nz = c.z + dz
      if (Math.abs(nx - sx) > radius || Math.abs(nz - sz) > radius) { touchesUnloaded = true; continue }   // search limit counts as frontier too
      for (const dy of [0, 1, -1, -2, -3]) {
        const ny = c.y + dy
        if (seen.has(key(nx, ny, nz))) continue
        if (dy === 1 && cellAt(c.x, c.y + 1, c.z) !== true) continue                 // headroom to step up
        const ok = cellAt(nx, ny, nz)
        if (ok === null) { seen.add(key(nx, ny, nz)); touchesUnloaded = true; continue }  // edge of the loaded world
        if (!ok) continue
        if (dy < 0) { let clear = true; for (let k = 0; k > dy; k--) if (cellAt(nx, c.y + k, nz) === false && k !== 0) { /* column must be open */ } ; if (!bot.blockAt(new Vec3(nx, c.y, nz)) || bot.blockAt(new Vec3(nx, c.y, nz)).boundingBox !== 'empty' || bot.blockAt(new Vec3(nx, c.y + 1, nz)).boundingBox !== 'empty') continue }
        seen.add(key(nx, ny, nz)); queue.push({ x: nx, y: ny, z: nz })
        break
      }
    }
    if (touchesUnloaded && qi > 0 && (!edge || score < edge.score)) edge = { score, x: c.x + 0.5, y: c.y, z: c.z + 0.5, d }
  }
  best = edge || best
  return best ? { x: best.x, y: best.y, z: best.z, d: best.d, cells: queue.length } : null
}

// ---------------------------------------------------------------- executor
// deps: { nav, bot, goals, say, log, map (may be null), isAborted }
// target: { x, z, y? }  opts: { legLen, arriveRadius, maxLegs, maxMs, finalGoal }
async function travel(deps, target, opts = {}) {
  const { nav, bot, goals, log = () => {}, isAborted = () => false, map = null } = deps
  const cfg = { gotoOpts: {}, legLen: 72, minLeg: 12, arriveRadius: 6, maxLegs: 160, maxMs: 25 * 60000, legMs: 60000, maxFailures: 7, ...opts }
  const t0 = Date.now()
  const result = { ok: false, legs: 0, failures: 0, err: null, replans: 0 }
  const avoid = [], visited = []
  const pos = () => bot.entity.position
  const planFromHere = () => {
    if (!map) return { points: [{ x: pos().x, z: pos().z }, { x: target.x, z: target.z }], ok: true, straight: true }
    const r = planRoute({ map, from: { x: pos().x, z: pos().z }, to: target, avoid })
    return r
  }
  let plan = planFromHere()
  let frontierMode = false, modeBest = Infinity     // without a map, once a straight aim has failed we keep exploring frontiers until we beat the distance we had then
  const frontierStep = async () => {
    const f = reachableFrontier(bot, target, { visited })
    if (!f) return false
    visited.push({ x: f.x, z: f.z })
    log(`frontier: heading for ${Math.round(f.x)}, ${Math.round(f.z)} (${Math.round(f.d)} from the target, ${f.cells} cells searched)`)
    const fr = await nav.goto(new goals.GoalNear(f.x, f.y, f.z, 1), { label: 'route frontier', ms: 45000, isAborted, escalate: false, ...cfg.gotoOpts })
    log(`frontier leg ${fr.ok ? 'ok' : 'failed: ' + fr.err} at ${Math.round(pos().x)}, ${Math.round(pos().z)}`)
    return true
  }
  let consecutiveFail = 0, len = cfg.legLen
  const arrived = () => hdist(pos(), target) <= cfg.arriveRadius
  while (!arrived()) {
    if (isAborted()) { result.err = 'aborted'; return result }
    if (Date.now() - t0 > cfg.maxMs) { result.err = 'route took too long'; return result }
    if (result.legs >= cfg.maxLegs) { result.err = 'too many legs'; return result }
    if (frontierMode) {
      if (!(await frontierStep()) || visited.length > 40) { result.err = `blocked near ${Math.round(pos().x)}, ${Math.round(pos().z)} (nowhere left to explore)`; return result }
      if (hdist(pos(), target) < modeBest - 10) { frontierMode = false; consecutiveFail = 0; len = cfg.legLen }
      continue
    }
    const p = pos()
    let tgt = nextTarget(plan.points, p, len)
    // keep the leg inside what is loaded, but at least minLeg: the pathfinder's partial paths do the rest as chunks arrive
    const bearing = Math.atan2(-(tgt.x - p.x), -(tgt.z - p.z))
    // snap the leg end to something standable when the area is loaded (so we do not aim into a wall, a tree or lava)
    const st = probeStandable(bot, tgt.x, tgt.z, p.y, 5)
    const goal = st ? new goals.GoalNear(st.x, st.y, st.z, 2) : new goals.GoalNearXZ(tgt.x, tgt.z, 3)
    result.legs++
    const before = hdist(p, target)
    const r = await nav.goto(goal, { label: 'route leg', ms: cfg.legMs, isAborted, escalate: false, ...cfg.gotoOpts })
    if (r.err === 'aborted') { result.err = 'aborted'; return result }
    const gained = before - hdist(pos(), target)
    if (r.ok || gained >= Math.min(len * 0.5, 20)) { consecutiveFail = 0; len = Math.min(cfg.legLen, len * 1.5); continue }
    // ---- recovery ----
    consecutiveFail++; result.failures++
    log(`route leg failed (${r.err}), ${Math.round(hdist(pos(), target))} blocks to go; attempt ${consecutiveFail}`)
    if (consecutiveFail > cfg.maxFailures) { result.err = `blocked near ${Math.round(pos().x)}, ${Math.round(pos().z)} (${r.err})`; return result }
    if (consecutiveFail % 3 === 1) { len = Math.max(cfg.minLeg, len / 2); continue }                         // shorter leg first
    if (consecutiveFail % 3 === 2) {                                                                          // look for a real way on in the loaded world
      if (!map) { frontierMode = true; modeBest = hdist(pos(), target); continue }
      await frontierStep()
      continue
    }
    avoid.push({ x: tgt.x, z: tgt.z, r: 40, w: 400 })                                                         // plan around the trouble spot
    plan = planFromHere(); result.replans++
  }
  result.ok = true
  return result
}

// ---------------------------------------------------------------- dimensions
// steps for getting from `from` to `to` ({x,z,dim}); portals: [{ ow, nether }] (waypoint pairs, see WaypointBook.portalPairs)
function planTravel({ from, to, portals = [], shortcutMin = 900, netherCost = 2.2 }) {
  const walk = (dim, p, label) => ({ type: 'walk', dim, to: { x: p.x, y: p.y, z: p.z }, label })
  const hop = (toDim, via, arrival = null) => ({ type: 'portal', to: toDim === -1 ? 'the_nether' : 'overworld', toDim, via, arrival })
  const direct = hdist(from, to)
  if (from.dim === to.dim) {
    if (from.dim === 0 && direct >= shortcutMin && portals.length >= 2) {
      let best = null
      for (const a of portals) for (const b of portals) {
        if (a === b) continue
        // the nether side is measured in nether blocks (1/8 of the overworld distance), weighted by how risky/slow it is to walk
        const total = hdist(from, a.ow) + hdist(a.nether, b.nether) * netherCost + hdist(b.ow, to)
        if (!best || total < best.total) best = { a, b, total }
      }
      if (best && best.total < direct * 0.75) {
        return { kind: 'nether-shortcut', estimate: Math.round(best.total), direct: Math.round(direct), steps: [
          walk(0, best.a.ow, 'portal'), hop(-1, best.a.ow.name, best.a.nether), walk(-1, best.b.nether, 'nether portal'), hop(0, best.b.nether.name), walk(0, to, 'destination')] }
      }
    }
    return { kind: 'walk', estimate: Math.round(direct), direct: Math.round(direct), steps: [walk(from.dim, to, 'destination')] }
  }
  // different dimensions: use the portal pair whose overworld side is closest to where we need to be
  if (!portals.length) return { kind: 'no-portal', steps: [], err: 'no known portals' }
  if (from.dim === 0 && to.dim === -1) {
    let best = null
    for (const p of portals) { const c = hdist(from, p.ow) + netherCost * hdist(p.nether, to); if (!best || c < best.c) best = { p, c } }
    return { kind: 'to-nether', estimate: Math.round(best.c), steps: [walk(0, best.p.ow, 'portal'), hop(-1, best.p.ow.name, best.p.nether), walk(-1, to, 'destination')] }
  }
  if (from.dim === -1 && to.dim === 0) {
    let best = null
    for (const p of portals) { const c = netherCost * hdist(from, p.nether) + hdist(p.ow, to); if (!best || c < best.c) best = { p, c } }
    return { kind: 'to-overworld', estimate: Math.round(best.c), steps: [walk(-1, best.p.nether, 'nether portal'), hop(0, best.p.nether.name), walk(0, to, 'destination')] }
  }
  return { kind: 'unsupported', steps: [], err: `no route from dimension ${from.dim} to ${to.dim}` }
}

module.exports = { classify, planRoute, nextTarget, probeStandable, reachableFrontier, loadedReach, travel, planTravel, simplify, Heap }
