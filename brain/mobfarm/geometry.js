// brain/mobfarm/geometry.js: the pure shape of the underground mob farm (Walter 2026-11-10, ROADMAP Phase 2 item 8). No bot, no world, no I/O:
// everything here is arithmetic on cells, so it can be tested offline and the build routine (brain/autopilot/mobfarmbuild.js) only walks the lists.
//
// The farm hangs off the laddered shaft (brain/autopilot/ladder.js) at two levels, `drop` blocks apart, and uses the shaft's own ladder to get
// between them. Frame (same as the storage room): k = cells away from the shaft along d, j = across (p = d turned right), y = world y.
//
//   PLATFORM level Yp (mobs stand with their feet at Yp on a floor of natural rock, Yp-1)
//     corridor k=1,2 (plugged once the farm is done, so the room is dark and mob-proof)
//     a DIAMOND room |k-kc|+|j| <= R, two cells high, no light inside it (monsters spawn only at block light 0)
//     a TRENCH along j through the centre: cells (kc, j, Yp-1) with the floor dug out one block; a water SOURCE at each tip (kc, +-T, Yp-1)
//     with T = 8, so the last flowing cell next to the HOLE (kc, 0, Yp-1) is at the lowest water level, pushes mobs into the hole, and never
//     spills a waterfall down it. Mobs wander on the pads, cross a trench now and then (random strolls pick targets up to 10 blocks away,
//     half of them across the water), and the water carries them to the hole.
//   DROP column (kc, 0, y) for y = Y0 .. Yp-1: one cell wide, no ladder in it (a ladder would cancel the fall damage). `drop` = Yp - Y0.
//     A 20 HP mob that falls ~22 blocks lands with about 1 HP: the kill at the end is the bot's (XP orbs only drop for a player's hit).
//   KILL level Y0
//     L = (kc, 0, Y0..Y0+1) is the pocket the mobs land in, on a HOPPER H1 (kc, 0, Y0-1) that faces down into a CHEST C (kc, 0, Y0-2).
//     Walls are the natural rock, left in place. The bot stands at K = (kc-3, 0, Y0) in a corridor that comes from the shaft and hits through a
//     one-cell SLIT (kc-1, 0, Y0+1) (rock below it and above it, so nothing taller than one block can come through; spiders do not survive the fall).
//     3 blocks from the landing cell is exactly where a creeper does not start its fuse (it swells inside 3.0) and still inside sword reach to the
//     hitbox. A short stair down in the lane beside the corridor (j = 1) leads to (kc, 1, Y0-2), from where the bot opens the chest to its north.
//
// All coordinates are absolute once `layout()` has the shaft's entry cell and the direction.
'use strict'

const DEFAULTS = { R: 9, T: 8, drop: 22, corridor: 2, height: 2 }

const key = (c) => c[0] + ',' + c[1] + ',' + c[2]

// frame: { ox, oz (the shaft cell), d: [dx, dz] away from the shaft, no ladder on that side }
function layout(frame, opt = {}) {
  const o = { ...DEFAULTS, ...opt }
  const { R, T, drop } = o
  const d = frame.d, p = [d[1], -d[0]]
  const at = (k, j, y) => [frame.ox + d[0] * k + p[0] * j, y, frame.oz + d[1] * k + p[1] * j]
  const kc = o.corridor + 1 + R
  const o0 = at(0, 0, 0)                 // k of the hole: the diamond's west tip is at k = corridor + 1
  const Yp = frame.yPlatform, Y0 = Yp - drop
  const L = {
    opt: o, frame, d, p, at, kc, Yp, Y0,
    kj: (c) => [Math.round((c[0] - o0[0]) * d[0] + (c[2] - o0[2]) * d[1]), Math.round((c[0] - o0[0]) * p[0] + (c[2] - o0[2]) * p[1])],
    // ----- platform
    platform: { pads: [], trench: [], hole: at(kc, 0, Yp - 1), sources: [at(kc, T, Yp - 1), at(kc, -T, Yp - 1)], air: [], corridor: [], plug: [] },
    column: [],
    chamber: {},
  }
  const P = L.platform
  for (let k = kc - R; k <= kc + R; k++) for (let j = -R; j <= R; j++) {
    if (Math.abs(k - kc) + Math.abs(j) > R) continue
    const onTrench = k === kc && j !== 0 && Math.abs(j) <= T
    if (onTrench) P.trench.push(at(k, j, Yp - 1)); else if (!(k === kc && j === 0)) P.pads.push(at(k, j, Yp - 1))   // the floor block's cell
    for (let h = 0; h < o.height; h++) P.air.push(at(k, j, Yp + h))
  }
  // trench cells and the hole are dug out of the floor row as well
  for (let k = 1; k <= o.corridor; k++) for (let h = 0; h < o.height; h++) P.corridor.push(at(k, 0, Yp + h))
  P.plug = [at(o.corridor, 0, Yp), at(o.corridor, 0, Yp + 1)]
  P.alcoves = [at(kc - 1, T, Yp), at(kc + 1, T, Yp), at(kc - 1, -T, Yp), at(kc + 1, -T, Yp)]   // pad cells beside the tips: the bot places the sources from here
  P.tips = [{ src: at(kc, T, Yp - 1), stand: at(kc - 1, T, Yp) }, { src: at(kc, -T, Yp - 1), stand: at(kc - 1, -T, Yp) }]
  P.entry = at(o.corridor + 1, 0, Yp)
  P.standBeforeHole = at(kc - 1, 0, Yp)
  // ----- the drop column, top to bottom
  for (let y = Yp - 1; y >= Y0; y--) L.column.push(at(kc, 0, y))
  // ----- the kill level
  const C = {}
  C.corridor = []                                  // 2 high from the shaft to just before the stair
  for (let k = 1; k <= kc - 2; k++) for (let h = 0; h < 2; h++) C.corridor.push(at(k, 0, Y0 + h))
  C.K = at(kc - 3, 0, Y0)
  // The way down to the chest runs in the lane beside the corridor (j = 1), so the wall in front of the pocket stays whole. Each step down needs the
  // two cells of the player's height at the level it enters from, so the cells are 3 high where it drops.
  C.stairs = [at(kc - 3, 1, Y0 + 1), at(kc - 3, 1, Y0), at(kc - 3, 1, Y0 - 1),
    at(kc - 2, 1, Y0), at(kc - 2, 1, Y0 - 1), at(kc - 2, 1, Y0 - 2),
    at(kc - 1, 1, Y0 - 1), at(kc - 1, 1, Y0 - 2),
    at(kc, 1, Y0 - 1), at(kc, 1, Y0 - 2)]
  C.chest = at(kc, 0, Y0 - 2)
  C.hopper = at(kc, 0, Y0 - 1)
  C.standAtChest = at(kc, 1, Y0 - 2)
  C.pocket = [at(kc, 0, Y0), at(kc, 0, Y0 + 1)]
  C.slit = at(kc - 1, 0, Y0 + 1)
  C.wallBelowSlit = at(kc - 1, 0, Y0)              // must stay rock
  C.wallAboveSlit = at(kc - 1, 0, Y0 + 2)
  C.torches = []
  for (let k = 2; k <= kc - 4; k += 3) C.torches.push(at(k, 0, Y0))   // floor level of the corridor, against the floor block below (placed upward)
  L.chamber = C
  // ----- everything that must be open air for the farm to work (the build digs these; nothing else is dug)
  L.dig = []
  const dig = (c) => L.dig.push(c)
  C.corridor.forEach(dig); C.stairs.forEach(dig); dig(C.chest); dig(C.slit)
  P.corridor.forEach(dig); P.air.forEach(dig); P.trench.forEach(dig); dig(P.hole)
  L.column.slice(1).forEach(dig)                   // the first column cell is the hole, already listed
  // column cells at Y0 and Y0+1 are the pocket; the hopper cell is dug too (the hopper goes in it)
  dig(C.hopper)
  // de-duplicate
  const seen = new Set(); L.dig = L.dig.filter(c => !seen.has(key(c)) && seen.add(key(c)))
  L.digSet = seen
  L.isOpen = (c) => seen.has(key(c))
  // the box that is "the farm" for the registry
  const all = L.dig, xs = all.map(c => c[0]), ys = all.map(c => c[1]), zs = all.map(c => c[2])
  L.box = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), z0: Math.min(...zs), z1: Math.max(...zs) }
  L.platformBox = boxOf(P.air.concat(P.trench, [P.hole]))
  L.chamberBox = boxOf(C.corridor.concat(C.stairs, [C.chest, C.hopper, C.slit], C.pocket))
  return L
}
function boxOf(cells) {
  const xs = cells.map(c => c[0]), ys = cells.map(c => c[1]), zs = cells.map(c => c[2])
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), z0: Math.min(...zs), z1: Math.max(...zs) }
}

// the cells that touch the open ones and are not open themselves: where the shell must be solid (a cave opening there needs a block)
function shell(L) {
  const out = new Map()
  for (const c of L.dig) for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const q = [c[0] + dx, c[1] + dy, c[2] + dz]
    if (!L.isOpen(q) && !out.has(key(q))) out.set(key(q), q)
  }
  return [...out.values()]
}

// the pieces that go into the world, with what the bot needs for them
function pieces(L) {
  const C = L.chamber
  return [
    { id: 'chest', cell: C.chest, item: 'chest', face: [0, 1, 0], onto: [C.chest[0], C.chest[1] - 1, C.chest[2]] },
    { id: 'hopper', cell: C.hopper, item: 'hopper', face: [0, 1, 0], onto: C.chest },
  ]
}

// water cells as the game would settle them: BFS level from each source over the trench, 7 flow steps at most. Pure, and used by the test and by
// the build's "did the water settle" check. Returns Map key -> level (8 = source, 1 = last flowing cell).
function waterLevels(L) {
  const trench = new Set(L.platform.trench.map(key))
  const lv = new Map()
  const q = []
  for (const s of L.platform.sources) { lv.set(key(s), 8); q.push(s) }
  while (q.length) {
    const c = q.shift(), cur = lv.get(key(c)); if (cur <= 1) continue
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = [c[0] + dx, c[1], c[2] + dz]; if (!trench.has(key(n))) continue
      if ((lv.get(key(n)) || 0) < cur - 1) { lv.set(key(n), cur - 1); q.push(n) }
    }
  }
  return lv
}


// ---- choosing where it goes. The shaft record is { entry:[x,y,z] (top cell, surface), wall:[dx,dz] (the ladder side), bottom:[x,y,z] }.
// The farm leaves the shaft away from the ladder wall (turn 0), or to one of the two sides (turns 1, 2): never back through the ladder wall.
// `rooms` are the registry's other rooms ({box:{...}}): a candidate with an open cell within 1 block of one of them is skipped (the farm's own
// bounding box is tall, so cell by cell is the honest test).
const boxHit = (a, b, m = 1) => a.x0 - m <= b.x1 && a.x1 + m >= b.x0 && a.y0 - m <= b.y1 && a.y1 + m >= b.y0 && a.z0 - m <= b.z1 && a.z1 + m >= b.z0
function candidates(sh, rooms = [], opt = {}) {
  const o = { ...DEFAULTS, ...opt }
  const wall = sh.wall || [1, 0], d0 = [0 - wall[0], 0 - wall[1]]
  const dirs = [d0, [d0[1], 0 - d0[0]], [0 - d0[1], d0[0]]]
  const entry = sh.entry, bottom = sh.bottom
  if (!bottom) return { list: [], why: 'the shaft has no recorded bottom' }
  const cover = 6                                              // the platform air ends at Yp + 1, the ceiling block is Yp + 2: 4 rock blocks between the room and the surface
  const hi = entry[1] - cover - o.drop                          // highest kill level
  const lo = bottom[1] + 2                                      // lowest: the shaft has a rung there
  if (hi < lo) return { list: [], why: `the shaft is too shallow: it needs to reach y${entry[1] - cover - o.drop - 2} or lower (it ends at y${bottom[1]})`, needBottom: entry[1] - cover - o.drop - 2 }
  const list = []
  for (const shift of [0, 6, 12, 18]) {
    const Y0 = hi - shift; if (Y0 < lo) break
    dirs.forEach((d, turn) => {
      const L = layout({ ox: entry[0], oz: entry[2], d, yPlatform: Y0 + o.drop }, o)
      if (rooms.some(r => r.box && L.dig.some(c => c[0] >= r.box.x0 - 1 && c[0] <= r.box.x1 + 1 && c[1] >= r.box.y0 - 1 && c[1] <= r.box.y1 + 1 && c[2] >= r.box.z0 - 1 && c[2] <= r.box.z1 + 1))) return
      list.push({ turn, shift, d, Y0, Yp: Y0 + o.drop })
    })
  }
  return { list, why: list.length ? '' : 'every spot along the shaft is taken by other rooms' }
}

module.exports = { candidates, boxHit,  DEFAULTS, layout, shell, pieces, waterLevels, key }
