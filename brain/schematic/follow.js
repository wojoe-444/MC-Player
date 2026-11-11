// brain/schematic/follow.js: FOLLOWING a schematic, as pure functions (no bot, no files). The build is judged by the world, never by a routine saying "done".
//
//   progress(schem, get, at, opt) -> { pct, complete, verified, required, checked, matched, unknown, counts, work, layers, settle, forbidden, ... }
//        the cell by cell diff, turned into WORK: each cell that is not what the schematic says is one of
//          dig       open space wanted, something is there (rock, a stray torch)                        -> break it
//          place     a block wanted (a wall, a hopper, a slab, a torch), the cell is open               -> place it
//          replace   a block wanted, the wrong block is there                                           -> break it, place the right one
//          fluid     a water source wanted, the cell is dry or holds the wrong level of a source         -> bucket
//          toggle    the right trapdoor, the wrong open/closed state                                    -> use it
//          drain     open space wanted, water or lava is there                                          -> seal it, then break the seal (a hazard: the executor may refuse)
//          settle    flowing water wanted: follows from its source, so it is listed but not counted wrong
//          forbidden lava wanted and absent: the bots never place lava (rule 2), so this build cannot be complete without a person
//   order(work, get, opt) -> work in a safe order: digs outward from an open cell, then placements bottom up each against something that already stands,
//        then torches and ladders, then water last. `orphans` are digs no open cell reaches.
//   recipe(entry, cell, ctx) -> how one block is put down: { item, ref, face, half?, stand?, after? }
//   needs(work, have) -> what is still missing from the bag.
//   findAt(schem, get, near, opt) -> where in the rock this build fits at the least digging, never into lava, an unloaded chunk, a no-dig area or something we made.
//
// Walter 2026-11-11: "following a schematic should be in the recursive loop when appropriate ... it makes verifying construction success much easier and more reliable."
'use strict'
const B = require('./blocks')
const F = require('./format')

const DIR = { north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0], up: [0, 1, 0], down: [0, -1, 0] }
const OPP = { north: 'south', south: 'north', west: 'east', east: 'west', up: 'down', down: 'up' }
const SIX = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const key = (c) => c[0] + ',' + c[1] + ',' + c[2]
const faceOf = (v) => Object.keys(DIR).find(k => DIR[k][0] === v[0] && DIR[k][1] === v[1] && DIR[k][2] === v[2])

// what a placement just goes into (no digging first)
const REPLACEABLE = /^(air|cave_air|void_air|water|lava|short_grass|tall_grass|fern|large_fern|snow|vine|glow_lichen|dead_bush|seagrass|tall_seagrass|light|moss_carpet|leaf_litter)$/
const FILLER = ['cobblestone', 'cobbled_deepslate', 'stone', 'netherrack', 'dirt', 'andesite', 'diorite', 'granite', 'tuff']
const isFluid = (n) => B.isWater(n) || B.isLava(n)
const replaceable = (n) => REPLACEABLE.test(B.strip(n))
const lvl = (p) => String((p && p.level) != null ? p.level : 0)

// A cell of the world against the entry that wants to be there. -> 'ok' | 'dig' | 'place' | 'replace' | 'fluid' | 'toggle' | 'drain' | 'settle' | 'forbidden' | 'unknown'
function classify(entry, got) {
  if (!entry || entry.role === 'any' || entry.scenery) return 'ok'
  if (!got) return 'unknown'
  const n = B.strip(got.name)
  if (entry.role === 'water' && B.isWater(n) && entry.level != null && String(entry.level) !== '0' && lvl(got.props) !== String(entry.level)) return 'settle'
  if (B.matches(entry, n, got.props)) return 'ok'
  switch (entry.role) {
    case 'air': return isFluid(n) ? 'drain' : 'dig'
    case 'solid': return replaceable(n) ? 'place' : 'replace'
    case 'lava': return 'forbidden'
    case 'water': {
      const source = entry.level == null || String(entry.level) === '0'
      if (!source) return B.isLava(n) ? 'dig' : replaceable(n) ? 'settle' : 'dig'          // flowing water follows from its source; a block there is dug and the water finds it
      return replaceable(n) || B.isWater(n) ? 'fluid' : 'replace'
    }
    case 'block': {
      if (/_trapdoor$/.test(entry.block) && n === entry.block && got.props && entry.props && ['facing', 'half'].every(k => entry.props[k] == null || String(got.props[k]) === String(entry.props[k]))) return 'toggle'
      return replaceable(n) ? 'place' : 'replace'
    }
    default: return 'unknown'
  }
}

// a schematic as a list of the cells that are checked: [lx, ly, lz, entry]
function required(schem) {
  const cells = F.cellsOf(schem), out = []
  const [W, H, D] = schem.size
  for (let y = 0; y < H; y++) for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
    const e = schem.palette[cells[x + W * (z + D * y)]]
    if (!e || e.role === 'any' || e.scenery) continue
    out.push([x, y, z, e])
  }
  return out
}

// Compare the world with the schematic placed with its min corner at `at`. opt.max caps the work list (the counts stay exact).
function progress(schem, get, at = schem.origin, opt = {}) {
  const req = opt.req || required(schem), cap = opt.max || 20000
  const res = { id: schem.id, at: [...at], size: schem.size, required: req.length, checked: 0, matched: 0, unknown: 0, counts: {}, work: [], settle: 0, forbidden: 0, layers: [], blocks: {} }
  const layers = new Map()
  for (const [lx, ly, lz, e] of req) {
    const wx = at[0] + lx, wy = at[1] + ly, wz = at[2] + lz
    const got = get(wx, wy, wz)
    const kind = classify(e, got)
    const L = layers.get(wy) || { y: wy, required: 0, matched: 0 }; layers.set(wy, L)
    if (kind === 'unknown') { res.unknown++; continue }
    res.checked++; L.required++
    if (kind === 'ok' || kind === 'settle') { res.matched++; L.matched++; if (kind === 'settle') res.settle++; continue }
    res.counts[kind] = (res.counts[kind] || 0) + 1
    if (kind === 'forbidden') res.forbidden++
    if (res.work.length < cap) res.work.push({ x: wx, y: wy, z: wz, kind, want: B.label(e), got: got ? B.strip(got.name) : null, entry: e })
  }
  res.layers = [...layers.values()].sort((a, b) => a.y - b.y)
  res.pct = res.checked ? Math.round((res.matched / res.checked) * 1000) / 10 : 0
  res.verified = res.unknown === 0 && res.checked > 0
  res.complete = res.verified && res.work.length === 0 && res.matched === res.checked
  res.off = res.checked - res.matched
  for (const w of res.work) { if (w.kind === 'place' || w.kind === 'replace') { const b = w.entry.block || w.entry.role; res.blocks[b] = (res.blocks[b] || 0) + 1 } }
  return res
}

// ---------------------------------------------------------------------------------------------------------------------------- ordering
const isTorch = (e) => e && e.role === 'block' && /(^|_)(torch|wall_torch|soul_torch|soul_wall_torch|redstone_torch|redstone_wall_torch|lantern|ladder)$/.test(e.block)
const rank = (w) => (w.kind === 'fluid' || w.entry.role === 'water' ? 4 : isTorch(w.entry) ? 3 : w.kind === 'toggle' ? 5 : 2)

// work -> { steps: [{ ...cell, phase: 'dig'|'place'|'fluid'|'toggle', ref?, face?, ... }], orphans, unsupported }
//   get(x,y,z) the world now (null = unknown); opt.starts: cells known open and reachable (where the bot can stand); opt.have: bag for item choice.
function order(work, get, opt = {}) {
  const isOpenNow = (c) => { const b = get(c[0], c[1], c[2]); return !!b && B.isOpenish(b.name) && !B.isSolid(b.name) && !/(_slab|_stairs|_wall|_fence|hopper|chest|barrel|_pane|_bed|cobweb)$/.test(B.strip(b.name)) }
  const dug = new Set()
  const digs = work.filter(w => w.kind === 'dig' || w.kind === 'replace' || w.kind === 'drain').map(w => ({ ...w, phase: 'dig' }))
  const todo = new Map(digs.map(d => [key([d.x, d.y, d.z]), d]))
  const isOpen = (c) => dug.has(key(c)) || (opt.starts || []).some(s => s[0] === c[0] && s[1] === c[1] && s[2] === c[2]) || isOpenNow(c)
  const steps = []
  let last = (opt.starts && opt.starts[0]) || (digs[0] ? [digs[0].x, digs[0].y, digs[0].z] : [0, 0, 0])
  let frontier = []
  const refresh = () => { frontier = [...todo.values()].filter(d => SIX.some(s => isOpen(add3([d.x, d.y, d.z], s)))) }
  refresh()
  while (todo.size) {
    if (!frontier.length) break
    let best = null, bd = Infinity
    for (const d of frontier) { const dist = Math.abs(d.x - last[0]) + Math.abs(d.y - last[1]) * 1.5 + Math.abs(d.z - last[2]); if (dist < bd) { bd = dist; best = d } }
    const k = key([best.x, best.y, best.z]); todo.delete(k); dug.add(k); steps.push(best); last = [best.x, best.y, best.z]
    frontier = frontier.filter(d => d !== best)
    for (const s of SIX) { const nb = todo.get(key(add3([best.x, best.y, best.z], s))); if (nb && !frontier.includes(nb)) frontier.push(nb) }
  }
  const orphans = [...todo.values()]
  // placements: after the digs (a cell that is dug then filled with the right block is both), bottom up, each against a block that stands by then
  const places = work.filter(w => ['place', 'replace', 'fluid', 'toggle'].includes(w.kind)).map(w => ({ ...w, phase: w.kind === 'fluid' || w.entry.role === 'water' ? 'fluid' : w.kind === 'toggle' ? 'toggle' : 'place' }))
  const standing = (c) => {
    const k = key(c)
    if (placedSolid.has(k)) return true
    if (dug.has(k)) return false
    const b = get(c[0], c[1], c[2]); return !!b && !replaceable(b.name)           // anything that is there and is not air, a fluid or a plant can be clicked
  }
  const placedSolid = new Set()
  let pending = places.sort((a, b) => rank(a) - rank(b) || a.y - b.y || a.x - b.x || a.z - b.z)
  const outPlaces = [], unsupported = []
  for (let pass = 0; pass < 200 && pending.length; pass++) {
    const next = []
    for (const p of pending) {
      const r = p.phase === 'toggle' ? { item: null, ref: [p.x, p.y, p.z], face: [0, 1, 0] } : recipe(p.entry, [p.x, p.y, p.z], { standing, have: opt.have, get })
      if (!r) { next.push(p); continue }
      outPlaces.push({ ...p, ...r }); if (p.entry.role === 'solid' || (p.entry.role === 'block' && !isTorch(p.entry))) placedSolid.add(key([p.x, p.y, p.z]))
    }
    if (next.length === pending.length) { unsupported.push(...next); break }
    pending = next
  }
  return { steps: [...steps, ...outPlaces], digs: steps.length, places: outPlaces.length, orphans, unsupported }
}

// ---------------------------------------------------------------------------------------------------------------------------- placing
// The game's own rules (1.21): a hopper faces the opposite of the face you click (down when you click a top or bottom face); a trapdoor clicked on a SIDE face faces
// that face and takes top/bottom from the height of the click, clicked on a top/bottom face it faces back at the player; stairs and chests face where the player looks.
// recipe() names the block to click (ref), the face of it, and what the click needs: half ('top'|'bottom' for a slab, trapdoor or stairs), stand (a cell the bot
// should look from when the player's own facing decides the block's), after ('open' for a trapdoor that is drawn open).
// -> null when nothing the block can attach to stands yet (the planner tries again after more has been placed).
function recipe(entry, cell, ctx) {
  const standing = ctx.standing || (() => true)
  const at = (d) => add3(cell, DIR[d])
  const against = (f) => standing(at(f))           // the neighbour in direction f is a block we can click
  const out = (item, refDir, extra = {}) => { const rc = at(refDir); return { item, ref: rc, face: DIR[OPP[refDir]], ...extra } }
  const have = ctx.have
  const pick = (names) => { if (!have) return names[0]; return names.find(n => (have[n] || 0) > 0) || names[0] }
  if (entry.role === 'water') { const d = ['down', 'north', 'south', 'east', 'west', 'up'].find(against); return d ? out('water_bucket', d, { fluid: true }) : null }
  // the entry shows stone, but any solid block is right: cobblestone first (what the bot has), stone only when it is in the bag
  if (entry.role === 'solid') { const item = pick([...new Set([...FILLER, entry.block])].filter(n => n && B.isSolid(n))); const d = ['down', 'north', 'south', 'east', 'west', 'up'].find(against); return d ? out(item, d) : null }
  if (entry.role !== 'block') return null
  const blk = B.strip(entry.block), p = entry.props || {}
  const item = pick([blk, ...(entry.alt || []).map(B.strip)])
  const sideRef = (pref) => (pref ? [pref] : []).concat(['north', 'south', 'east', 'west']).find(d => against(d))
  // torches and ladders hang on a wall or stand on the floor
  if (/^(torch|soul_torch|redstone_torch)$/.test(blk)) return against('down') ? out(item, 'down') : null
  if (/^(wall_torch|soul_wall_torch|redstone_wall_torch)$/.test(blk)) { const f = p.facing; if (!f || !DIR[f]) return null; return against(OPP[f]) ? out(item.replace('wall_', ''), OPP[f]) : null }
  if (blk === 'ladder') { const f = p.facing; if (!f || !DIR[f]) return null; return against(OPP[f]) ? out(item, OPP[f]) : null }
  if (/_slab$/.test(blk)) {
    const t = p.type || 'bottom'
    if (t === 'bottom' && against('down')) return out(item, 'down', { half: 'bottom' })
    if (t === 'top' && against('up')) return out(item, 'up', { half: 'top' })
    const d = sideRef(); return d ? out(item, d, { half: t === 'top' ? 'top' : 'bottom' }) : null
  }
  if (/_trapdoor$/.test(blk)) {
    const f = p.facing, half = p.half || 'bottom', after = String(p.open) === 'true' ? 'open' : undefined
    if (f && DIR[f] && against(OPP[f])) return out(item, OPP[f], { half, after })                       // click the side of the block it is hinged to: faces f, half by the height of the click
    const d = half === 'bottom' ? (against('down') ? 'down' : null) : (against('up') ? 'up' : null)
    if (d) return out(item, d, { half, after, stand: f && DIR[f] ? at(f) : undefined })                // top/bottom click: faces back at the player, so stand on the facing side
    const s = sideRef(); return s ? out(item, s, { half, after }) : null
  }
  if (blk === 'hopper') {
    const f = p.facing || 'down'
    if (f === 'down') return against('down') ? out(item, 'down') : null                                // click the top of what it empties into
    return against(f) ? out(item, f) : null                                                              // click the face of the block it empties into
  }
  if (/_stairs$/.test(blk)) { const f = p.facing, half = p.half || 'bottom'; const d = half === 'bottom' ? (against('down') ? 'down' : sideRef()) : (against('up') ? 'up' : sideRef()); return d ? out(item, d, { half, stand: f && DIR[f] ? at(OPP[f]) : undefined }) : null }
  if (/^(chest|trapped_chest|barrel|furnace|blast_furnace|smoker|dispenser|dropper|observer)$/.test(blk)) { const f = p.facing; const d = ['down', 'north', 'south', 'east', 'west'].find(against); return d ? out(item, d, { stand: f && DIR[f] ? at(f) : undefined }) : null }
  const d = ['down', 'north', 'south', 'east', 'west', 'up'].find(against)
  return d ? out(item, d) : null
}

// what the bag lacks for the placements still to do: { item -> missing }, `have` = { item -> count }. A bucket is reused: one is enough for any number of sources.
function needs(steps, have = {}) {
  const want = {}
  for (const s of steps) {
    if (s.phase === 'dig' || s.phase === 'toggle' || !s.item) continue
    if (s.item === 'water_bucket') { want.water_bucket = 1; continue }
    want[s.item] = (want[s.item] || 0) + 1
  }
  // any solid filler is interchangeable: pool them
  let fillWant = 0
  for (const [k, n] of Object.entries(want)) if (FILLER.includes(k)) { fillWant += n; delete want[k] }
  const fillHave = FILLER.reduce((a, k) => a + (have[k] || 0), 0)
  const out = {}
  for (const [k, n] of Object.entries(want)) { const m = n - (have[k] || 0); if (m > 0) out[k] = m }
  if (fillWant > fillHave) out.filler = fillWant - fillHave
  return out
}

// ---------------------------------------------------------------------------------------------------------------------------- where
// Try the schematic at anchors around `near` ([x,y,z] a world cell, e.g. the shaft entry), nearest first. opt: { radius (xz, default 24), dy: [from, to] relative to near.y (default -30..0), step (default 2),
// dyStep (default 1), noDig(x,y,z), established(x,y,z) true for something we made or a build (never dug), max (anchors tried), ms (time budget, default 3000: the best so far is returned) }.
// A site is refused when a required cell is unloaded, lava is inside or touching the build, the build would dig a no-dig area or an established block, or a water cell of the
// design touches a cave. Cost: 1 per dig, 2 per placement, 3 per replacement, 1 per source.
function findAt(schem, get, near, opt = {}) {
  const req = opt.req || required(schem)
  const R = opt.radius != null ? opt.radius : 24, step = opt.step || 2
  const [dy0, dy1] = opt.dy || [-30, 0]
  const cost = { dig: 1, place: 2, replace: 3, fluid: 1, toggle: 0, settle: 0, drain: 50, ok: 0, forbidden: 1e6 }
  let best = null, tried = 0
  const reasons = {}
  const anchors = []
  for (let dy = dy1; dy >= dy0; dy -= (opt.dyStep || 1)) for (let dx = -R; dx <= R; dx += step) for (let dz = -R; dz <= R; dz += step) anchors.push([Math.round(near[0] - schem.size[0] / 2 + dx), near[1] + dy, Math.round(near[2] - schem.size[2] / 2 + dz)])
  anchors.sort((a, b) => (Math.abs(a[0] - near[0] + schem.size[0] / 2) + Math.abs(a[2] - near[2] + schem.size[2] / 2) + Math.abs(a[1] - near[1])) - (Math.abs(b[0] - near[0] + schem.size[0] / 2) + Math.abs(b[2] - near[2] + schem.size[2] / 2) + Math.abs(b[1] - near[1])))
  const maxTry = opt.max || 20000, t0 = Date.now(), budget = opt.ms || 3000          // a bounded time: the bot's own loop must not stall on a search
  for (const at of anchors) {
    if (tried++ >= maxTry || (tried % 50 === 0 && Date.now() - t0 > budget)) break
    let c = 0, bad = null
    for (const [lx, ly, lz, e] of req) {
      const wx = at[0] + lx, wy = at[1] + ly, wz = at[2] + lz
      const got = get(wx, wy, wz)
      if (!got) { bad = 'unloaded'; break }
      const k = classify(e, got)
      if (k === 'ok') continue
      if (k === 'forbidden' || k === 'drain') { bad = k; break }
      if ((k === 'dig' || k === 'replace') && opt.noDig && opt.noDig(wx, wy, wz)) { bad = 'no-dig'; break }
      if ((k === 'dig' || k === 'replace') && opt.established && opt.established(wx, wy, wz, got)) { bad = 'established'; break }
      if (e.role === 'air' || e.role === 'water') { for (const s of SIX) { const nb = get(wx + s[0], wy + s[1], wz + s[2]); if (nb && B.isLava(nb.name)) { bad = 'lava'; break } } if (bad) break }
      c += cost[k] || 1
      if (best && c >= best.cost) { bad = 'worse'; break }
    }
    if (bad) { reasons[bad] = (reasons[bad] || 0) + 1; continue }
    if (!best || c < best.cost) best = { at, cost: c }
  }
  return best ? { ok: true, at: best.at, cost: best.cost, tried, reasons } : { ok: false, why: `no fitting place within ${R} blocks of ${near.join(',')} (tried ${tried}; refused for ${Object.entries(reasons).filter(([k]) => k !== 'worse').map(([k, n]) => `${k} x${n}`).join(', ') || 'nothing'})`, tried, reasons }
}

const summary = (p) => `${p.pct}% of ${p.checked} checked cells are right (${p.off} off${p.unknown ? ', ' + p.unknown + ' not loaded' : ''}${Object.keys(p.counts).length ? ': ' + Object.entries(p.counts).map(([k, n]) => `${n} ${k}`).join(', ') : ''})`

module.exports = { classify, required, progress, order, recipe, needs, findAt, summary, DIR, OPP, FILLER, REPLACEABLE, key }
