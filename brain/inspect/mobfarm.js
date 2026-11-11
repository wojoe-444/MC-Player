// brain/inspect/mobfarm.js: the inspection of a built mob farm against its own design (brain/mobfarm/geometry.js) and against what the design is FOR.
// Two questions, both answered from the blocks alone:
//   conformance  is every cell the design says is open open, is the shell around them solid, are the chest and the hopper there, is the water what it should be
//   function     would it work: a spawning room monsters can spawn in (block light 0 on the pads), a one-block slit the bot can hit through, a drop that ends in the pocket
// A human sees most of these in a second; the bot never looked at its own work (PR #263 built the farm, nothing ever checked it, 2026-11-10: zero kills).
// Pure: takes a layout L and a grid, returns findings. The caller decides what to do with them (brain/inspect/index.js).
'use strict'
const MF = require('../mobfarm/geometry')
const { sources, spread, blockLight } = require('./light')
const { LIGHT_SOURCE, AIR } = require('./grid')

const key = MF.key
const SIX = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
const sample = (cells, n = 6) => cells.slice(0, n).map(c => c.join(','))

// the layout of a registered room: the registry stores the box and the platform level, not the direction, so the three directions the builder can choose are
// tried and the one whose box is the room's box wins
function layoutOfRoom(room, shaft) {
  if (!room || !room.box || !shaft || !shaft.entry || room.platformY == null) return null
  const wall = shaft.wall || [1, 0], d0 = [-wall[0], -wall[1]]
  for (const d of [d0, [d0[1], -d0[0]], [-d0[1], d0[0]], [wall[0], wall[1]]]) {
    const L = MF.layout({ ox: shaft.entry[0], oz: shaft.entry[2], d, yPlatform: room.platformY })
    const a = L.box, b = room.box
    if (a.x0 === b.x0 && a.x1 === b.x1 && a.y0 === b.y0 && a.y1 === b.y1 && a.z0 === b.z0 && a.z1 === b.z1) return L
  }
  return null
}

// every spawnable pad: a solid floor, two cells of air over it. `light` is a Map of block light.
function pads(L, grid) {
  const out = []
  for (const f of L.platform.pads) {
    const [x, y, z] = f
    if (!grid.has(x, y, z) || !grid.has(x, y + 1, z) || !grid.has(x, y + 2, z)) continue
    out.push({ floor: f, feet: [x, y + 1, z], solid: grid.isSolid(x, y, z), open: grid.isAir(x, y + 1, z) && grid.isAir(x, y + 2, z) })
  }
  return out
}

function check(L, grid, opt = {}) {
  const P = L.platform, C = L.chamber
  const F = []
  const add = (id, sev, zone, msg, cells = [], extra = {}) => F.push({ id, sev, zone, msg, count: cells.length, cells: sample(cells), ...extra })
  const set = (a) => new Set(a.map(key))
  const stats = {}

  // ---- zones: which part of the farm a cell belongs to
  const zoneOf = new Map()
  const tag = (cells, z) => { for (const c of cells) zoneOf.set(key(c), z) }
  tag(C.corridor, 'corridor'); tag(C.stairs, 'chamber'); tag([C.chest, C.hopper], 'pocket'); tag(C.pocket, 'pocket'); tag([C.slit], 'pocket')
  tag(L.column, 'column'); tag(P.corridor, 'platform-corridor'); tag(P.air, 'platform'); tag(P.trench, 'platform'); tag([P.hole], 'platform')
  for (const c of C.pocket) zoneOf.set(key(c), 'pocket')
  // the cells beside the kill spot are the bot's own safety
  for (const c of C.corridor) if (Math.abs(c[0] - C.K[0]) + Math.abs(c[2] - C.K[2]) <= 3) zoneOf.set(key(c), 'killspot')
  const trench = set(P.trench), pieceCells = new Map([[key(C.chest), 'chest'], [key(C.hopper), 'hopper']])
  const torchOk = set(C.torches)

  // ---- 1. design-open cells that are not open
  const blocked = [], stray = [], unknown = []
  for (const c of L.dig) {
    const k = key(c)
    if (trench.has(k) || pieceCells.has(k)) continue
    if (!grid.has(c[0], c[1], c[2])) { unknown.push(c); continue }
    const n = grid.name(c[0], c[1], c[2])
    if (AIR.test(n)) continue
    if (LIGHT_SOURCE.test(n)) { if (!torchOk.has(k)) stray.push({ c, n }); continue }
    if (grid.isSolid(c[0], c[1], c[2]) || n === 'water' || n === 'lava') blocked.push({ c, n })
  }
  stats.unknownCells = unknown.length
  // the corridor and its plug are closed on purpose once the farm is done
  const plugSet = set(P.plug), corridorSet = set(P.corridor)
  const plugSolid = P.plug.every(c => grid.isSolid(c[0], c[1], c[2]))
  const real = blocked.filter(b => !(corridorSet.has(key(b.c)) && (plugSolid || plugSet.has(key(b.c)))))
  const sealedMore = blocked.filter(b => corridorSet.has(key(b.c)) && !plugSet.has(key(b.c)) && plugSolid)
  if (real.length) add('blocked', 'fault', 'any', `${real.length} cell(s) the design needs open are solid or wet: ${[...new Set(real.map(b => b.n))].join(', ')}`, real.map(b => b.c))
  if (sealedMore.length) add('corridor-filled', 'note', 'platform-corridor', `the platform corridor is filled beyond the 2 plug blocks (${sealedMore.length} extra cell(s)); harmless, but the way back in needs more digging`, sealedMore.map(b => b.c))
  if (opt.done !== false && !plugSolid && P.plug.every(c => grid.has(c[0], c[1], c[2]))) add('plug-open', 'warn', 'platform-corridor', 'the platform corridor plug is not in place: the room is not closed off from the shaft', P.plug)

  // ---- 2. light inside the spawning room (a torch in a 17 wide room is the whole farm gone)
  const platformCells = P.air.concat(P.trench, [P.hole])
  const strayInPlatform = stray.filter(s => zoneOf.get(key(s.c)) === 'platform')
  if (strayInPlatform.length) add('stray-light', 'fault', 'platform', `${strayInPlatform.length} light source(s) INSIDE the spawning room (${strayInPlatform.map(s => s.n + ' at ' + s.c.join(',')).join('; ')}). Monsters spawn only at block light 0, and a torch lights up to 13 blocks around it`, strayInPlatform.map(s => s.c), { fix: { kind: 'break', cells: strayInPlatform.map(s => s.c) } })
  const strayElse = stray.filter(s => zoneOf.get(key(s.c)) !== 'platform' && zoneOf.get(key(s.c)) !== 'platform-corridor')
  if (strayElse.length && opt.strictLight) add('stray-light-elsewhere', 'warn', 'any', `${strayElse.length} light source(s) where the design has none`, strayElse.map(s => s.c))
  const light = blockLight(grid)
  const ps = pads(L, grid)
  const spawnable = ps.filter(p => p.solid && p.open)
  const dark = spawnable.filter(p => !(light.get(key(p.feet)) > 0))
  stats.pads = ps.length; stats.spawnable = spawnable.length; stats.dark = dark.length
  stats.darkFrac = spawnable.length ? +(dark.length / spawnable.length).toFixed(2) : null
  const lightMax = spawnable.reduce((m, p) => Math.max(m, light.get(key(p.feet)) || 0), 0)
  if (ps.length && spawnable.length < ps.length * 0.9) add('pad-floor', 'fault', 'platform', `only ${spawnable.length} of ${ps.length} pads have a solid floor and 2 air cells above them`, ps.filter(p => !(p.solid && p.open)).map(p => p.floor))
  if (spawnable.length) {
    if (stats.darkFrac < 0.5) {
      // which light sources do it: each source alone, counted over the pads it reaches
      const by = []
      for (const s of sources(grid)) {
        if (Math.abs(s.at[0] - L.platform.hole[0]) > 30 || Math.abs(s.at[2] - L.platform.hole[2]) > 30 || Math.abs(s.at[1] - L.Yp) > 16) continue
        const one = spread(grid, [s]); let n = 0
        for (const p of spawnable) if (one.get(key(p.feet)) > 0) n++
        if (n) by.push({ at: s.at, name: s.name, pads: n })
      }
      by.sort((a, b) => b.pads - a.pads)
      add('platform-lit', 'fault', 'platform', `${Math.round((1 - stats.darkFrac) * 100)}% of the ${spawnable.length} spawnable pads are lit (block light up to ${lightMax}); only ${dark.length} are dark enough for a monster to spawn on` + (by.length ? `. Lit by: ${by.slice(0, 3).map(b => `${b.name} at ${b.at.join(',')} (${b.pads} pads)`).join('; ')}` : ''), by.map(b => b.at), { litBy: by.slice(0, 5) })
    } else if (stats.darkFrac < 0.9) add('platform-lit', 'warn', 'platform', `${Math.round((1 - stats.darkFrac) * 100)}% of the spawnable pads are lit; ${dark.length} of ${spawnable.length} are dark`, [])
  }

  // the corridor torches the design lists (the corridor is where the bot waits: dark floor there is spawn room right beside it)
  const noTorch = C.torches.filter(c => grid.has(c[0], c[1], c[2]) && !LIGHT_SOURCE.test(grid.name(c[0], c[1], c[2])))
  if (noTorch.length) add('torch-missing', 'warn', 'corridor', `${noTorch.length} of the ${C.torches.length} corridor torches the design lists are not there (${noTorch.map(c => c.join(',')).join('; ')}): the kill corridor is dark in places`, noTorch)

  // ---- 3. water: levels as the design settles them, sources only at the tips, a dry hole and column
  const lv = MF.waterLevels(L), wrong = [], missing = [], middleSource = []
  for (const c of P.trench) {
    if (!grid.has(c[0], c[1], c[2])) continue
    if (grid.name(c[0], c[1], c[2]) !== 'water') { missing.push(c); continue }
    const want = lv.get(key(c)), got = Number(grid.prop(c[0], c[1], c[2], 'level'))
    if (!Number.isFinite(got) || !want) continue
    const wantLevel = want === 8 ? 0 : 8 - want
    if (got !== wantLevel) { wrong.push({ c, got, wantLevel }); if (got === 0) middleSource.push(c) }
  }
  for (const s of P.sources) { if (grid.has(s[0], s[1], s[2]) && grid.name(s[0], s[1], s[2]) !== 'water') missing.push(s) }
  if (missing.length) add('water-missing', 'fault', 'platform', `${missing.length} trench cell(s) without water: the trench does not carry mobs to the hole`, missing)
  if (middleSource.length) add('water-still', 'fault', 'platform', `${middleSource.length} water SOURCE block(s) in the middle of the trench: still water does not push mobs`, middleSource)
  else if (wrong.length) add('water-levels', 'warn', 'platform', `${wrong.length} trench cell(s) with a water level other than the design's (${wrong.slice(0, 3).map(w => `${w.c.join(',')} is ${w.got}, wanted ${w.wantLevel}`).join('; ')})`, wrong.map(w => w.c))
  const wetCol = L.column.filter(c => grid.name(c[0], c[1], c[2]) === 'water' || grid.name(c[0], c[1], c[2]) === 'lava')
  if (wetCol.length) add('column-wet', 'fault', 'platform', `liquid in the drop column (${wetCol.length} cell(s)): a waterfall cancels the fall damage, so nothing arrives with 1 HP`, wetCol)

  // ---- 4. pieces
  const hop = grid.get(C.hopper[0], C.hopper[1], C.hopper[2]), ch = grid.get(C.chest[0], C.chest[1], C.chest[2])
  if (hop && hop.n !== 'hopper') add('piece-missing', 'fault', 'pocket', `no hopper at ${C.hopper.join(',')} (found ${hop.n})`, [C.hopper])
  else if (hop && hop.p && hop.p.facing && hop.p.facing !== 'down') add('piece-wrong', 'fault', 'pocket', `the hopper at ${C.hopper.join(',')} faces ${hop.p.facing}, not down into the chest`, [C.hopper])
  if (ch && !/chest$/.test(ch.n)) add('piece-missing', 'fault', 'pocket', `no chest at ${C.chest.join(',')} (found ${ch.n})`, [C.chest])

  // ---- 5. leaks: shell cells that are open (cave mouths, old tunnels) by zone
  const leaks = new Map()
  const order = { 'killspot': 0, 'pocket': 1, 'platform': 2, 'column': 3, 'platform-corridor': 4, 'corridor': 5, 'chamber': 6 }
  for (const c of L.dig) {
    const z = zoneOf.get(key(c)); if (!z) continue
    for (const [dx, dy, dz] of SIX) {
      const q = [c[0] + dx, c[1] + dy, c[2] + dz], k = key(q)
      if (L.isOpen(q) || !grid.has(q[0], q[1], q[2])) continue
      const n = grid.name(q[0], q[1], q[2])
      if (n === 'ladder' || grid.isSolid(q[0], q[1], q[2])) continue
      const have = leaks.get(k)
      if (!have || order[z] < order[have.zone]) leaks.set(k, { q, zone: z, n, from: c })
    }
  }
  const byZone = {}
  for (const l of leaks.values()) (byZone[l.zone] = byZone[l.zone] || []).push(l)
  stats.leaks = Object.fromEntries(Object.entries(byZone).map(([z, a]) => [z, a.length]))
  const slitWalls = [C.wallAboveSlit, C.wallBelowSlit].filter(c => leaks.has(key(c)))
  if (slitWalls.length) add('slit-wide', 'fault', 'pocket', `the slit is more than one block high (${slitWalls.map(c => c.join(',')).join(' and ')} is open, not rock): a zombie or a creeper walks out of the pocket instead of waiting 1 to 2 HP away from the bot's sword`, slitWalls)
  const rest = (z) => (byZone[z] || []).filter(l => !slitWalls.some(c => key(c) === key(l.q)))
  if (rest('killspot').length) add('killspot-exposed', 'fault', 'killspot', `${rest('killspot').length} open cell(s) in the wall of the kill corridor next to the kill spot: mobs from the caves behind them reach the bot's back`, rest('killspot').map(l => l.q))
  if (rest('pocket').length) add('pocket-leak', 'fault', 'pocket', `${rest('pocket').length} open cell(s) around the landing pocket: landed mobs can leave other than through the slit, and cave mobs walk in`, rest('pocket').map(l => l.q))
  if (rest('platform').length) add('platform-leak', 'fault', 'platform', `${rest('platform').length} open cell(s) in the shell of the spawning room (${[...new Set(rest('platform').map(l => l.n))].join(', ')}): not dark and sealed`, rest('platform').map(l => l.q))
  if (rest('column').length) {
    const ys = [...new Set(rest('column').map(l => l.q[1]))].sort((a, b) => b - a)
    add('column-open', 'warn', 'column', `the drop column is open to ${rest('column').length} side cell(s) at y ${ys.join(', ')}: it crosses old tunnels, so cave mobs fall in and the farm shares the mob cap with every dark tunnel it touches`, rest('column').map(l => l.q))
  }
  if (rest('platform-corridor').length) add('corridor-leak', 'warn', 'platform-corridor', `${rest('platform-corridor').length} open cell(s) around the plugged platform corridor`, rest('platform-corridor').map(l => l.q))
  if (rest('corridor').length + rest('chamber').length) add('chamber-leak', 'warn', 'chamber', `${rest('corridor').length + rest('chamber').length} open cell(s) in the walls of the kill corridor and stair`, rest('corridor').concat(rest('chamber')).map(l => l.q))

  // ---- 6. can the bot hit what lands: a straight line from the eye at the kill spot to the landing cell through air only
  const eye = [C.K[0] + 0.5, C.K[1] + 1.62, C.K[2] + 0.5], tgt = [C.pocket[0][0] + 0.5, C.pocket[0][1] + 0.9, C.pocket[0][2] + 0.5]
  let sight = true, hit = null
  const dist = Math.hypot(tgt[0] - eye[0], tgt[1] - eye[1], tgt[2] - eye[2]), steps = Math.ceil(dist / 0.1)
  for (let i = 0; i <= steps && sight; i++) {
    const t = i / steps, x = Math.floor(eye[0] + (tgt[0] - eye[0]) * t), y = Math.floor(eye[1] + (tgt[1] - eye[1]) * t), z = Math.floor(eye[2] + (tgt[2] - eye[2]) * t)
    if (grid.has(x, y, z) && grid.isSolid(x, y, z)) { sight = false; hit = [x, y, z] }
  }
  stats.sightToLanding = sight
  if (!sight) add('no-sight', 'fault', 'pocket', `the bot at the kill spot cannot see the landing cell: a ${grid.name(hit[0], hit[1], hit[2])} block at ${hit.join(',')} is in the way (the slit is not open)`, [hit])
  return summarise(F, stats, grid)
}

const RANK = { fault: 0, warn: 1, note: 2 }
function summarise(findings, stats, grid) {
  findings.sort((a, b) => RANK[a.sev] - RANK[b.sev])
  const faults = findings.filter(f => f.sev === 'fault'), warns = findings.filter(f => f.sev === 'warn')
  return { ok: faults.length === 0, faults: faults.length, warns: warns.length, findings, stats, headline: faults.concat(warns).slice(0, 4).map(f => f.msg.length > 200 ? f.msg.slice(0, 197) + '...' : f.msg) }
}

module.exports = { layoutOfRoom, check, pads, summarise }
