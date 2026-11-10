// The animal pen as an ordered list of placements (pure: no bot, no world).
//
// Origin O = (ox, oy, oz) is the north-west cell of the pen's INTERIOR, at feet level: the ground surface block is y = oy-1, the fence stands at y = oy.
// Interior x = 0..w-1, z = 0..d-1 (x east, z south). The fence ring is the cells at x or z in {-1, w|d}. The gate is the middle cell of the south side.
// Torches stand on top of fence posts (light 14 from y = oy+1): corners and every 4th post, never above the gate, so the pen is lit and no hostile spawns in it.
//
// Step: { id, key, x, y, z, block, item, face:{x,y,z}, ref:{x,y,z}, kind: 'fence'|'gate'|'torch', outward:{x,z} }
//   ref  = the block it is placed against (ground under a fence, the fence post under a torch); the piece lands at ref + face
//   outward = which way the bot stands off from the ring (away from the pen), so it never stands in the cell it places and never inside the pen
// Order: fences clockwise from the north-west corner, then the gate (last, from outside), then the torches. Every ref is natural ground or an earlier step.
const UP = { x: 0, y: 1, z: 0 }

function ringCells(w, d) {
  const out = []
  for (let x = -1; x <= w; x++) out.push([x, -1])
  for (let z = 0; z <= d; z++) out.push([w, z])
  for (let x = w - 1; x >= -1; x--) out.push([x, d])
  for (let z = d - 1; z >= 0; z--) out.push([-1, z])
  return out
}
const gateCell = (w, d) => [Math.floor(w / 2), d]

function outwardOf(x, z, w, d) {
  if (z === -1) return { x: 0, z: -1 }
  if (z === d) return { x: 0, z: 1 }
  if (x === -1) return { x: -1, z: 0 }
  return { x: 1, z: 0 }
}

// torch posts: both corners of a side and every 4th post between them, minus the gate post; around the gate the nearest posts two cells on each side take over
function torchPosts(w, d) {
  const gate = gateCell(w, d)
  const picked = []
  const side = (cells) => {                                           // cells in order along one side, corner to corner
    const L = cells.length, idx = [0]
    for (let i = 4; i < L - 1; i += 4) idx.push(i)
    if (L - 1 - idx[idx.length - 1] < 3 && idx.length > 1) idx.pop()          // keep torches 3 apart: the corner wins over a post next to it
    idx.push(L - 1)
    return idx.map(i => cells[i])
  }
  const N = [], E = [], S = [], W = []
  for (let x = -1; x <= w; x++) { N.push([x, -1]); S.push([x, d]) }
  for (let z = -1; z <= d; z++) { W.push([-1, z]); E.push([w, z]) }
  for (const cells of [N, E, S, W]) for (const c of side(cells)) if (!picked.some(p => p[0] === c[0] && p[1] === c[1])) picked.push(c)
  const isGate = (c) => c[0] === gate[0] && c[1] === gate[1]
  const out = picked.filter(c => !isGate(c))
  if (picked.some(isGate)) for (const dx of [-2, 2]) {
    const c = [gate[0] + dx, d]
    if (c[0] > -1 && c[0] < w && !out.some(p => Math.abs(p[0] - c[0]) + Math.abs(p[1] - c[1]) < 3)) out.push(c)
  }
  return out
}

function pen(origin, { w = 7, d = 7, wood = 'birch', torches = true } = {}) {
  const { x: ox, y: oy, z: oz } = origin
  const steps = []
  const abs = (x, z) => ({ x: ox + x, z: oz + z })
  const gate = gateCell(w, d)
  const add = (s) => { s.id = steps.length; s.key = `${s.x},${s.y},${s.z}`; steps.push(s) }
  for (const [x, z] of ringCells(w, d)) {
    if (x === gate[0] && z === gate[1]) continue
    const a = abs(x, z)
    add({ x: a.x, y: oy, z: a.z, block: `${wood}_fence`, item: `${wood}_fence`, face: UP, ref: { x: a.x, y: oy - 1, z: a.z }, kind: 'fence', outward: outwardOf(x, z, w, d) })
  }
  const g = abs(gate[0], gate[1])
  add({ x: g.x, y: oy, z: g.z, block: `${wood}_fence_gate`, item: `${wood}_fence_gate`, face: UP, ref: { x: g.x, y: oy - 1, z: g.z }, kind: 'gate', outward: { x: 0, z: 1 } })
  if (torches) for (const [x, z] of torchPosts(w, d)) {
    const a = abs(x, z)
    add({ x: a.x, y: oy + 1, z: a.z, block: 'torch', item: 'torch', face: UP, ref: { x: a.x, y: oy, z: a.z }, kind: 'torch', outward: outwardOf(x, z, w, d) })
  }
  return steps
}

// what the pen needs in the bag: { birch_fence: 31, birch_fence_gate: 1, torch: 8 } (counting only steps not yet standing when `standing(step)` is given)
function materials(steps, standing = () => false) {
  const need = {}
  for (const s of steps) if (!standing(s)) need[s.item] = (need[s.item] || 0) + 1
  return need
}

// the interior box of a pen record { ox, oy, oz, w, d }
function boxOf(p) { return { x0: p.ox, x1: p.ox + p.w - 1, z0: p.oz, z1: p.oz + p.d - 1, y0: p.oy, y1: p.oy + 1 } }
const areaOf = (p) => p.w * p.d
const gateOf = (p) => { const g = gateCell(p.w, p.d); return { x: p.ox + g[0], y: p.oy, z: p.oz + g[1] } }
// the cell just inside the gate and the one just outside it
const insideGate = (p) => { const g = gateOf(p); return { x: g.x, y: g.y, z: g.z - 1 } }
const outsideGate = (p) => { const g = gateOf(p); return { x: g.x, y: g.y, z: g.z + 1 } }

// Every interior cell should be within `reach` torch steps (Manhattan) of a torch: block light falls 1 per step from 14, so 7 steps still gives light 7.
function litEverywhere(steps, w, d, ox, oz, reach = 7) {
  const ts = steps.filter(s => s.kind === 'torch')
  for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) {
    if (!ts.some(t => Math.abs(t.x - (ox + x)) + Math.abs(t.z - (oz + z)) <= reach)) return false
  }
  return true
}

module.exports = { pen, ringCells, gateCell, torchPosts, materials, boxOf, areaOf, gateOf, insideGate, outsideGate, litEverywhere }
