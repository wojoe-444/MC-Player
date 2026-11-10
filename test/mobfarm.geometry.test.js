// The mob farm's shape (brain/mobfarm/geometry.js): pure arithmetic, so the design promises are checked here for all four directions with a small
// voxel model (open cells = the dig list; everything else is rock). The physics (water, fall damage, hopper) is checked on a vanilla server by
// tools/trial/mobfarm-lab.js and mobfarm-build-lab.js.
const test = require('node:test')
const assert = require('node:assert/strict')
const G = require('../brain/mobfarm/geometry')

const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]]
const mk = (d, Yp = 60, o = {}) => G.layout({ ox: 100, oz: -40, d, yPlatform: Yp }, o)
const K = G.key

// what a 2 high mob can stand and walk in: the open cells except the chest and the hopper (solid for walking)
function walker(L) {
  const solid = new Set([K(L.chamber.chest), K(L.chamber.hopper)])
  const open = (c) => L.isOpen(c) && !solid.has(K(c))
  const reach = (start) => {
    const seen = new Map([[K(start), start]]), q = [start]
    const push = (c) => { if (!seen.has(K(c))) { seen.set(K(c), c); q.push(c) } }
    while (q.length) {
      const [x, y, z] = q.shift()
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz
        const ups = open([x, y + 2, z]) ? [y + 1, y] : [y]            // a jump up one block needs the head room above the start
        for (let ny of ups) {
          if (!open([nx, ny, nz]) || !open([nx, ny + 1, nz])) continue
          if (ny === y + 1 && open([nx, ny - 1, nz])) continue         // stepping up needs something to step onto
          while (open([nx, ny - 1, nz])) ny--                          // falls
          push([nx, ny, nz])
          break
        }
      }
    }
    return seen
  }
  return { open, reach }
}

for (const d of DIRS) {
  const tag = `direction ${d}`
  test(`${tag}: the drop is 22 blocks, one cell wide, hopper under the landing cell, chest under the hopper`, () => {
    const L = mk(d)
    assert.equal(L.Yp - L.Y0, 22)
    assert.deepEqual(L.column.map(c => [c[0], c[2]]).filter((c, i, a) => c[0] !== a[0][0] || c[1] !== a[0][1]), [])
    assert.equal(L.column[0][1], L.Yp - 1)
    assert.equal(L.column[L.column.length - 1][1], L.Y0)
    assert.deepEqual(L.chamber.hopper, [L.chamber.pocket[0][0], L.Y0 - 1, L.chamber.pocket[0][2]])
    assert.deepEqual(L.chamber.chest, [L.chamber.hopper[0], L.Y0 - 2, L.chamber.hopper[2]])
    assert.equal(L.chamber.pocket.length, 2)
  })

  test(`${tag}: the kill spot is 3 cells from the landing cell and sees it only through a one-cell slit with rock above and below`, () => {
    const L = mk(d), C = L.chamber
    const horiz = Math.hypot(C.K[0] - C.pocket[0][0], C.K[2] - C.pocket[0][2])
    assert.equal(horiz, 3)
    assert.ok(L.isOpen(C.slit))
    assert.ok(!L.isOpen(C.wallBelowSlit) && !L.isOpen(C.wallAboveSlit), 'rock below and above the slit')
    // the sight line from the eye to the mob's chest crosses only open cells (the slit among them)
    const eye = [C.K[0] + 0.5, C.K[1] + 1.62, C.K[2] + 0.5], tgt = [C.pocket[0][0] + 0.5, C.pocket[0][1] + 1.2, C.pocket[0][2] + 0.5]
    const crossed = new Set()
    for (let t = 0; t <= 1.0001; t += 0.01) crossed.add(K([Math.floor(eye[0] + (tgt[0] - eye[0]) * t), Math.floor(eye[1] + (tgt[1] - eye[1]) * t), Math.floor(eye[2] + (tgt[2] - eye[2]) * t)]))
    for (const k of crossed) assert.ok(L.digSet.has(k), 'sight line crosses rock at ' + k)
    assert.ok(crossed.has(K(C.slit)), 'sight line goes through the slit')
  })

  test(`${tag}: a mob that lands in the pocket cannot reach the corridor, the kill spot or the stair; a mob on the platform reaches the pocket`, () => {
    const L = mk(d), C = L.chamber, W = walker(L)
    const fromPocket = W.reach(C.pocket[0])
    for (const c of C.corridor.concat(C.stairs, [C.K])) assert.ok(!fromPocket.has(K(c)), 'pocket mob reaches ' + c)
    // a 1-high mob (spider-sized) could take the slit, but the fall kills or hurts it: the model here is the 2-high mob only
    const pad = L.at(L.kc - 3, 2, L.Yp)                   // a pad in the west half
    assert.ok(L.isOpen(pad))
    const fromPad = W.reach(pad)
    assert.ok(fromPad.has(K(C.pocket[0])), 'a mob wandering on the platform can fall into the pocket')
    assert.ok(!fromPad.has(K(C.K)), 'and not into the corridor')
  })

  test(`${tag}: the bot can walk from the shaft through the corridor to the kill spot and down the stair to the chest, and back`, () => {
    const L = mk(d), C = L.chamber, W = walker(L)
    const start = C.corridor[0]
    const r = W.reach(start)
    assert.ok(r.has(K(C.K)), 'kill spot')
    assert.ok(r.has(K(C.standAtChest)), 'chest spot')
    // standing at the chest spot the chest is a neighbour (north of it) and the hopper cell is open above it
    assert.equal(Math.abs(C.standAtChest[0] - C.chest[0]) + Math.abs(C.standAtChest[2] - C.chest[2]), 1)
    assert.equal(C.standAtChest[1], C.chest[1])
    const back = W.reach(C.standAtChest)
    assert.ok(back.has(K(start)), 'and back up')
    // the platform is reachable from the platform corridor, the hole is not an escape for the bot except by falling
    const pr = W.reach(L.platform.corridor[0])
    assert.ok(pr.has(K(L.platform.standBeforeHole)))
  })

  test(`${tag}: water settles as designed: the trench is wet, the cell beside the hole is at the lowest level, the hole and the pads stay dry`, () => {
    const L = mk(d), lv = G.waterLevels(L), P = L.platform
    for (const c of P.trench) assert.ok(lv.has(K(c)), 'dry trench cell ' + c)
    for (const s of P.sources) assert.equal(lv.get(K(s)), 8)
    assert.ok(!lv.has(K(P.hole)), 'no water in the hole')
    for (const c of L.column) assert.ok(!lv.has(K(c)), 'no water in the column')
    for (const c of P.pads) assert.ok(!lv.has(K(c)), 'no water on a pad')
    const beside = [L.at(L.kc, 1, L.Yp - 1), L.at(L.kc, -1, L.Yp - 1)]
    for (const c of beside) assert.equal(lv.get(K(c)), 1, 'lowest level next to the hole: no spill down the column')
    // the sources sit at distance 8 from the hole (7 flow steps and no more)
    for (const s of P.sources) assert.equal(Math.abs(L.kj(s)[1]), 8)
  })

  test(`${tag}: the platform is dark by design (no torch cell on it), 2 high, with a pad beside each source, and the corridor plug closes it`, () => {
    const L = mk(d), P = L.platform
    assert.ok(P.pads.length > 120, 'spawn area ' + P.pads.length)
    for (const t of L.chamber.torches) assert.ok(!P.air.some(c => K(c) === K(t)))
    for (const t of P.tips) { assert.ok(L.isOpen(t.stand)); assert.ok(!L.isOpen([t.src[0], t.src[1] - 1, t.src[2]])) }
    assert.equal(P.plug.length, 2)
    for (const c of P.plug) assert.ok(L.isOpen(c))
    // everything on the platform is at least 2 high
    for (const c of P.air) if (c[1] === L.Yp) assert.ok(L.isOpen([c[0], c[1] + 1, c[2]]))
  })

  test(`${tag}: the shell is rock-only by construction (no shell cell is open) and the dig list has no duplicates`, () => {
    const L = mk(d)
    assert.equal(new Set(L.dig.map(K)).size, L.dig.length)
    for (const q of G.shell(L)) assert.ok(!L.isOpen(q))
    assert.ok(G.shell(L).length > 400)
  })
}

test('candidates: leaves through the side away from the ladder wall first, never through the wall; a shallow shaft is refused with the depth it needs', () => {
  const sh = { entry: [0, 80, 0], wall: [1, 0], bottom: [0, 20, 0] }
  const c = G.candidates(sh, [])
  assert.ok(c.list.length >= 3)
  assert.deepEqual(c.list[0].d, [-1, 0])
  assert.ok(c.list.every(x => !(x.d[0] === 1 && x.d[1] === 0)))
  assert.equal(c.list[0].Yp - c.list[0].Y0, 22)
  // cover: at least 4 rock blocks (the ceiling among them) between the platform air and the surface
  assert.ok(80 - c.list[0].Yp - 2 >= 4)
  const shallow = G.candidates({ entry: [0, 80, 0], wall: [1, 0], bottom: [0, 60, 0] }, [])
  assert.equal(shallow.list.length, 0)
  assert.match(shallow.why, /too shallow/)
  assert.equal(shallow.needBottom, 80 - 6 - 22 - 2)
})

test('candidates: a room in the way (the storage room off the same shaft) moves the farm to another side, and nothing it picks overlaps', () => {
  const sh = { entry: [0, 80, 0], wall: [1, 0], bottom: [0, 20, 0] }
  const first = G.candidates(sh, []).list[0]
  assert.deepEqual(first.d, [-1, 0])
  // a flat room at y70 on the first side: it cuts through the drop column of the first choice
  const storage = { box: { x0: -12, x1: -3, y0: 70, y1: 72, z0: -3, z1: 3 } }
  const cut = G.layout({ ox: 0, oz: 0, d: first.d, yPlatform: first.Yp })
  assert.ok(cut.dig.some(c => c[0] >= -13 && c[0] <= -2 && c[1] >= 69 && c[1] <= 73 && c[2] >= -4 && c[2] <= 4), 'the drop column cuts through the storage box')
  const next = G.candidates(sh, [storage]).list[0]
  assert.ok(next && next.turn !== first.turn, 'moves to another side')
  assert.ok(!G.layout({ ox: 0, oz: 0, d: next.d, yPlatform: next.Yp }).dig.some(c => c[0] >= -13 && c[0] <= -2 && c[1] >= 69 && c[1] <= 73 && c[2] >= -4 && c[2] <= 4))
  // everything taken: an honest reason
  const all = G.candidates(sh, [{ box: { x0: -40, x1: 40, y0: 0, y1: 100, z0: -40, z1: 40 } }])
  assert.equal(all.list.length, 0)
  assert.match(all.why, /taken/)
})
