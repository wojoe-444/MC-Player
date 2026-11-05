// The lookout tower as an ordered list of placements (pure: no bot, no world).
//
// Coordinates relative to the origin O = (ox, oy, oz): x east, z south, y = oy is the first wall course (the ground surface block is y = oy-1).
//   ring R   : x,z in 0..4 with x or z in {0,4}; courses 0..8; corners spruce_log, the rest stone_bricks; door gap (2,0..1,4); window slits at
//              courses 2 and 6 on the four face centres
//   floor    : course 4, spruce_planks on the interior except the pillar centre (2,2) and the ladder cell (1,1)
//   deck     : course 9, spruce_planks on the 7x7 area x,z in -1..5 minus its four corners (45 cells) except the ladder hole (1,1) and the centre (2,2)
//   parapet  : course 10, stone_bricks on the outer edge of the octagon (20 cells); torches at course 11 on the four edge midpoints
//   ladder   : (1, 0..9, 1) against the west wall; centre fills (2,9,2) and (2,4,2) once the pillar is gone; furnishing; the door goes in last
//
// Every step: { id, key, x, y, z, block, item, face:{x,y,z}, refKind:'ground'|'below'|'side', ref:{x,y,z}, course, phase, stage, feet, stand, optional }
//   face  = the face of the reference block the piece is placed against (the piece lands at ref + face)
//   ref   = the reference block: natural ground / earlier foundation ('ground'), the block under the target ('below') or a same-level neighbour ('side')
//   stage = which standing place builds it: 'foundation' | 'pillar' (feet = height of the bot's feet above oy) | 'ladder' | 'fill-deck' | 'fill-floor' | 'furnish' | 'door'
//   stand = where the bot stands for ground stages (absolute feet cell)
// The order guarantees that the reference block of every step is natural ground or an earlier step.

const WHITELIST = ['stone_bricks', 'spruce_log', 'spruce_planks', 'spruce_door', 'ladder', 'torch', 'cobblestone', 'bed', 'chest', 'crafting_table']
const BED = /_bed$/
const TORCH = /^(torch|wall_torch)$/
const allowedItem = (name) => WHITELIST.includes(name) || BED.test(name)

const UP = [0, 1, 0]
// the ring, clockwise from the north-west corner
const RING = []
for (let x = 0; x <= 4; x++) RING.push([x, 0])
for (let z = 1; z <= 4; z++) RING.push([4, z])
for (let x = 3; x >= 0; x--) RING.push([x, 4])
for (let z = 3; z >= 1; z--) RING.push([0, z])
const WINDOWS = [[2, 0], [4, 2], [2, 4], [0, 2]]
const WINDOW_COURSES = [2, 6]
const DOOR = [2, 4]
const INTERIOR = [[1, 2], [1, 3], [2, 1], [2, 3], [3, 1], [3, 2], [3, 3]]   // all interior cells but the ladder cell (1,1) and the pillar centre (2,2)
// the octagon's outer edge (x or z in {-1,5}, corners removed), going around: north, east, south, west
const OUTER = []
for (let x = 0; x <= 4; x++) OUTER.push([x, -1])
for (let z = 0; z <= 4; z++) OUTER.push([5, z])
for (let x = 4; x >= 0; x--) OUTER.push([x, 5])
for (let z = 4; z >= 0; z--) OUTER.push([-1, z])
const EDGE_MIDS = [[-1, 2], [5, 2], [2, -1], [2, 5]]
const COURSES = 9                  // wall courses 0..8
const DECK = 9, PARAPET = 10, TORCH_Y = 11, HEIGHT = 13

const isCorner = (x, z) => (x === 0 || x === 4) && (z === 0 || z === 4)
const isWindow = (x, c, z) => WINDOW_COURSES.includes(c) && WINDOWS.some(([wx, wz]) => wx === x && wz === z)
const isDoor = (x, c, z) => c <= 1 && x === DOOR[0] && z === DOOR[1]
function wallBlock(x, c, z) {
  if (isDoor(x, c, z) || isWindow(x, c, z)) return null
  return isCorner(x, z) ? 'spruce_log' : 'stone_bricks'
}
// the ring neighbour an interior cell is placed against: [ring x, ring z, face]
function interiorRef(x, z) {
  if (x === 1) return [0, z, [1, 0, 0]]
  if (x === 3) return [4, z, [-1, 0, 0]]
  if (z === 1) return [x, 0, [0, 0, 1]]
  return [x, 4, [0, 0, -1]]
}
// the inner ring cell an outer cell is placed against: [ring x, ring z, face]
function outerRef(x, z) {
  if (z === -1) return [x, 0, [0, 0, -1]]
  if (x === 5) return [4, z, [1, 0, 0]]
  if (z === 5) return [x, 4, [0, 0, 1]]
  return [0, z, [-1, 0, 0]]
}

// opts.ground(dx, dz) -> absolute y of the ground surface block under the 5x5 footprint cell (default: oy-1 everywhere = no foundation)
function tower(origin, opts = {}) {
  const { ox, oy, oz } = origin
  const ground = opts.ground || (() => oy - 1)
  const steps = []
  const add = (s) => {
    const [x, y, z] = s.at
    const step = {
      id: steps.length, key: `${ox + x},${oy + y},${oz + z}`, x: ox + x, y: oy + y, z: oz + z, block: s.block, item: s.item || s.block,
      face: { x: s.face[0], y: s.face[1], z: s.face[2] }, refKind: s.refKind, ref: { x: ox + s.ref[0], y: oy + s.ref[1], z: oz + s.ref[2] },
      course: s.course, phase: s.phase, stage: s.stage, feet: s.feet === undefined ? null : s.feet,
      stand: s.stand ? { x: ox + s.stand[0], y: oy + s.stand[1], z: oz + s.stand[2] } : null, optional: !!s.optional
    }
    if (s.extra) step.extra = s.extra.map(([ex, ey, ez]) => ({ x: ox + ex, y: oy + ey, z: oz + ez }))
    steps.push(step)
  }
  const pillar = (phase, course, feet) => ({ phase, course, stage: 'pillar', feet })

  // ---- foundation: cobblestone under the 5x5 cells whose ground is below oy-1, farthest from the centre first (so no placed block hides a later one) ----
  const found = []
  for (let dx = 0; dx <= 4; dx++) for (let dz = 0; dz <= 4; dz++) {
    if (dx === 2 && dz === 2) continue           // the pillar column stands on natural ground (the survey insists on it)
    const g = ground(dx, dz)
    for (let y = g + 1; y <= oy - 1; y++) found.push({ dx, dz, y: y - oy, d: (dx - 2) * (dx - 2) + (dz - 2) * (dz - 2) })
  }
  found.sort((a, b) => (b.d - a.d) || (a.y - b.y) || (a.dx - b.dx) || (a.dz - b.dz))
  // a pit one block deep cannot be seen into from two blocks away: stand on the neighbouring cell (natural base-level ground) nearest the centre and look down
  const isLow = (x, z) => x >= 0 && x <= 4 && z >= 0 && z <= 4 && ground(x, z) < oy - 1
  const standFor = (dx, dz) => {
    const c = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([a, b]) => [dx + a, dz + b]).filter(([x, z]) => x >= 0 && x <= 4 && z >= 0 && z <= 4 && !isLow(x, z))
    c.sort((a, b) => ((a[0] - 2) ** 2 + (a[1] - 2) ** 2) - ((b[0] - 2) ** 2 + (b[1] - 2) ** 2))
    return c.length ? [c[0][0], 0, c[0][1]] : [2, 0, 2]
  }
  for (const f of found) add({ at: [f.dx, f.y, f.dz], block: 'cobblestone', face: UP, refKind: 'ground', ref: [f.dx, f.y - 1, f.dz], course: -1, phase: 'foundation', stage: 'foundation', stand: standFor(f.dx, f.dz) })

  // ---- walls (+ the first floor at course 4), then the deck, parapet and torches ----
  for (let c = 0; c < COURSES; c++) {
    for (let i = 0; i < RING.length; i++) {
      const [x, z] = RING[i]
      const block = wallBlock(x, c, z)
      if (!block) continue
      let ref, face, refKind
      if (c === 0) { ref = [x, -1, z]; face = UP; refKind = 'ground' }
      else if (wallBlock(x, c - 1, z)) { ref = [x, c - 1, z]; face = UP; refKind = 'below' }
      else {
        const [px, pz] = RING[(i + RING.length - 1) % RING.length]          // above a window or the door gap: against the previous ring block of this course
        if (!wallBlock(px, c, pz)) throw new Error(`blueprint: no side reference for ${x},${c},${z}`)
        ref = [px, c, pz]; face = [x - px, 0, z - pz]; refKind = 'side'
      }
      add({ at: [x, c, z], block, face, refKind, ref, ...pillar('walls', c, c) })
    }
    if (c === 4) for (const [x, z] of INTERIOR) {
      const [rx, rz, face] = interiorRef(x, z)
      add({ at: [x, 4, z], block: 'spruce_planks', face, refKind: 'side', ref: [rx, 4, rz], ...pillar('floor', 4, 4) })
    }
  }
  for (const [x, z] of RING) add({ at: [x, DECK, z], block: 'spruce_planks', face: UP, refKind: 'below', ref: [x, DECK - 1, z], ...pillar('deck', DECK, DECK) })
  for (const [x, z] of INTERIOR) {
    const [rx, rz, face] = interiorRef(x, z)
    add({ at: [x, DECK, z], block: 'spruce_planks', face, refKind: 'side', ref: [rx, DECK, rz], ...pillar('deck', DECK, DECK) })
  }
  for (const [x, z] of OUTER) {
    const [rx, rz, face] = outerRef(x, z)
    add({ at: [x, DECK, z], block: 'spruce_planks', face, refKind: 'side', ref: [rx, DECK, rz], ...pillar('deck', DECK, DECK) })
  }
  for (const [x, z] of OUTER) add({ at: [x, PARAPET, z], block: 'stone_bricks', face: UP, refKind: 'below', ref: [x, DECK, z], ...pillar('parapet', PARAPET, PARAPET) })
  for (const [x, z] of EDGE_MIDS) add({ at: [x, TORCH_Y, z], block: 'torch', face: UP, refKind: 'below', ref: [x, PARAPET, z], ...pillar('torches', TORCH_Y, PARAPET) })

  // ---- after the pillar is gone: ladder bottom-up (each rung placed from the rung below), centre fills, furnishing, door ----
  for (let y = 0; y <= 9; y++) add({ at: [1, y, 1], block: 'ladder', face: [1, 0, 0], refKind: 'side', ref: [0, y, 1], course: y, phase: 'ladder', stage: 'ladder', stand: [1, Math.max(0, y - 1), 1] })
  add({ at: [2, DECK, 2], block: 'spruce_planks', face: [1, 0, 0], refKind: 'side', ref: [1, DECK, 2], course: DECK, phase: 'fill', stage: 'fill-deck', stand: [1, DECK + 1, 2] })
  add({ at: [2, 4, 2], block: 'spruce_planks', face: [1, 0, 0], refKind: 'side', ref: [1, 4, 2], course: 4, phase: 'fill', stage: 'fill-floor', stand: [1, 5, 2] })
  // furnishing: only what is in the bag (the engine skips the rest silently); the bed's head lies north of its foot
  add({ at: [3, 0, 2], block: 'bed', face: UP, refKind: 'ground', ref: [3, -1, 2], course: 0, phase: 'furnish', stage: 'furnish', stand: [3, 0, 3], optional: true, extra: [[3, 0, 1]] })
  add({ at: [1, 0, 3], block: 'crafting_table', face: UP, refKind: 'ground', ref: [1, -1, 3], course: 0, phase: 'furnish', stage: 'furnish', stand: [2, 0, 3], optional: true })
  add({ at: [3, 0, 3], block: 'chest', face: UP, refKind: 'ground', ref: [3, -1, 3], course: 0, phase: 'furnish', stage: 'furnish', stand: [2, 0, 3], optional: true })
  add({ at: [1, 2, 3], block: 'torch', face: [1, 0, 0], refKind: 'side', ref: [0, 2, 3], course: 2, phase: 'furnish', stage: 'furnish', stand: [2, 0, 3], optional: true })
  // the door goes in last, from outside, on the ground block under the gap (so the pathfinder never has to open it while the job runs)
  add({ at: [DOOR[0], 0, DOOR[1]], block: 'spruce_door', face: UP, refKind: 'ground', ref: [DOOR[0], -1, DOOR[1]], course: 0, phase: 'door', stage: 'door', stand: [DOOR[0], 0, DOOR[1] + 1] })
  return steps
}

// is `blockName` what `step` should have put at its cell?
function satisfied(step, blockName) {
  if (step.item === 'bed') return BED.test(blockName)
  if (step.item === 'torch') return TORCH.test(blockName)
  return blockName === step.block
}

// The volume the tower may touch: the 7x7 area (x,z -1..5), from two below the base (foundation) to 12 above the first course.
function box(origin) {
  return { min: { x: origin.ox - 1, y: origin.oy - 2, z: origin.oz - 1 }, max: { x: origin.ox + 5, y: origin.oy + HEIGHT - 1, z: origin.oz + 5 } }
}
function inBox(origin, p) {
  const b = box(origin)
  return p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y && p.z >= b.min.z && p.z <= b.max.z
}
function count(steps, { optional = false } = {}) {
  const out = {}
  for (const s of steps) if (optional || !s.optional) out[s.item] = (out[s.item] || 0) + 1
  return out
}

module.exports = { tower, satisfied, allowedItem, box, inBox, count, WHITELIST, RING, OUTER, INTERIOR, EDGE_MIDS, WINDOWS, WINDOW_COURSES, DOOR, COURSES, DECK, PARAPET, TORCH_Y, HEIGHT, wallBlock, BED, TORCH }
