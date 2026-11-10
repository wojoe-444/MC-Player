// brain/treefarm/layout.js: the lit sapling lattice, as pure geometry. No bot, no side effects: every function takes a block accessor
// get(x, y, z) -> block-like { name, boundingBox } | null (null = chunk not loaded).
//
// Walter's design (2026-11-04/10): saplings with 3 blocks between them (a lattice of period 4), a torch in the middle of every lattice square
// (offset +2,+2 from a sapling, so torches are 4 apart: 3 air blocks between any two, which keeps "torch, air, air, torch" spacing), and every
// sapling needs open space above for the tree. Light: a torch is light 14 and loses 1 per block, so the worst cell of the lattice (a sapling
// spot, 2+2 blocks from the nearest torch) still has light 10; saplings grow at 9 and up and nothing spawns at block light 1 and up.
//
// Surface mode plants on soil that is already there. Underground mode (the farm moved into a cave or a dug hall later) is the same lattice
// with a dirt block put down first where the floor is stone ("lift"), the sky is not needed, only room above. The farm record says which.
'use strict'

const PERIOD = 4            // sapling to sapling: 3 blocks between them
const TORCH_OFFSET = 2      // torch cell = sapling cell + (2, 2): the middle of four saplings
const CLEAR = 7             // free blocks above a sapling (a birch is 5 to 7 tall, plus one for the crown)
const SOIL = /^(grass_block|dirt|podzol|coarse_dirt|rooted_dirt|moss_block|mud)$/    // farmland is a crop bed, never a tree bed
const AIR = /^(air|cave_air|void_air)$/
const SMALL_PLANT = /^(short_grass|tall_grass|fern|large_fern|dead_bush|snow|vine|glow_lichen|sweet_berry_bush|dandelion|poppy|azure_bluet|cornflower|oxeye_daisy|lily_of_the_valley|lilac|rose_bush|peony|[a-z]+_tulip|blue_orchid|allium)$/
const SAPLING = /_sapling$/
const LOG = /_log$/
const WATERISH = /^(water|lava|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/
const LEAVES = /_leaves$/

const isAir = (b) => !!b && AIR.test(b.name)
const isLeaves = (b) => !!b && LEAVES.test(b.name)
// a cell a tree (or a bot) can occupy: air, leaves, a sapling or a small plant
const isFree = (b) => !!b && (AIR.test(b.name) || LEAVES.test(b.name) || SAPLING.test(b.name) || SMALL_PLANT.test(b.name))
const NOT_GROUND = /^(torch|wall_torch|soul_torch|soul_wall_torch|[a-z_]*sapling|short_grass|tall_grass|fern|large_fern|dead_bush|vine)$/
const isSolid = (b) => !!b && b.boundingBox === 'block' && !LEAVES.test(b.name) && !WATERISH.test(b.name) && !NOT_GROUND.test(b.name)

function makeFarm({ id = 'farm', x, y, z, cols = 4, rows = 3, species = 'birch', mode = 'surface', at = Date.now() }) {
  return { id, x: Math.floor(x), y: Math.floor(y), z: Math.floor(z), cols, rows, spacing: PERIOD, species, mode, spotY: {}, at }
}

// Sapling cells in snake order (row by row, direction alternating), so a walk along them never doubles back. y comes from farm.spotY.
function spots(farm) {
  const out = []
  for (let j = 0; j < farm.rows; j++) {
    for (let k = 0; k < farm.cols; k++) {
      const i = j % 2 ? farm.cols - 1 - k : k
      const x = farm.x + i * farm.spacing, z = farm.z + j * farm.spacing
      out.push({ i, j, x, z, y: farm.spotY && farm.spotY[`${x},${z}`] !== undefined ? farm.spotY[`${x},${z}`] : farm.y })
    }
  }
  return out
}
// Torch cells: the middle of every lattice square, plus one ring around the outside, so every sapling has a torch on all four diagonals.
function torchCells(farm) {
  const out = []
  for (let j = -1; j < farm.rows; j++) for (let i = -1; i < farm.cols; i++) {
    out.push({ i, j, x: farm.x + i * farm.spacing + TORCH_OFFSET, z: farm.z + j * farm.spacing + TORCH_OFFSET })
  }
  return out
}
// The ground box of the farm, torches included.
function bounds(farm) {
  return { x0: farm.x - TORCH_OFFSET, x1: farm.x + (farm.cols - 1) * farm.spacing + TORCH_OFFSET, z0: farm.z - TORCH_OFFSET, z1: farm.z + (farm.rows - 1) * farm.spacing + TORCH_OFFSET }
}
const inBounds = (farm, x, z) => { const b = bounds(farm); return x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 }
const isSpot = (farm, x, z) => spots(farm).some(s => s.x === x && s.z === z)
const centre = (farm) => { const b = bounds(farm); return { x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2 } }

// What stands in the column (x, z)? Looks from yHint + up down to yHint - down for the first cell that something could stand or grow in.
// -> { ok, state, y, floor, lift, reason }
//   state  'empty' (nothing planted yet), 'sapling', 'tree' (a log stands there: a grown tree, or someone else's)
//   y      the cell of the sapling (for 'tree' the lowest log); with lift the sapling goes one above the dirt that gets put at y
//   reason when not ok: 'unloaded' | 'water' | 'lava' | 'not-soil' | 'blocked-above' | 'no-ground' | 'tree'
function column(get, x, z, { yHint = 64, mode = 'surface', up = 4, down = 6, clear = CLEAR } = {}) {
  for (let y = yHint + up; y >= yHint - down; y--) {
    const cell = get(x, y, z), floor = get(x, y - 1, z)
    if (!cell || !floor) return { ok: false, reason: 'unloaded', y }
    if (LEAVES.test(cell.name) || LEAVES.test(floor.name)) continue                      // a canopy: look under it
    if (WATERISH.test(floor.name)) return { ok: false, reason: /lava/.test(floor.name) ? 'lava' : 'water', y }
    if (LOG.test(floor.name) && isFree(cell)) return { ok: false, state: 'tree', reason: 'tree', y: y - 1, floor: floor.name }   // looking down from above a trunk
    if (LOG.test(cell.name) && SOIL.test(floor.name)) return { ok: false, state: 'tree', reason: 'tree', y, floor: floor.name }
    if (!isFree(cell) || !isSolid(floor)) continue
    // `cell` is where something stands; `floor` is what it stands on
    const lift = !SOIL.test(floor.name) && mode === 'underground'
    if (!SOIL.test(floor.name) && !lift) return { ok: false, reason: 'not-soil', y, floor: floor.name }
    const sy = lift ? y + 1 : y
    for (let h = 1; h <= clear; h++) {
      const c = get(x, sy + h, z)
      if (!c) return { ok: false, reason: 'unloaded', y: sy }
      if (!isFree(c)) return { ok: false, reason: 'blocked-above', y: sy, floor: floor.name }
    }
    return { ok: true, state: SAPLING.test(cell.name) ? 'sapling' : 'empty', y: sy, floor: floor.name, lift }
  }
  return { ok: false, reason: 'no-ground', y: yHint }
}

// Scan a square of columns once (radius around cx, cz) so that candidate rectangles are plain look-ups afterwards.
function scanGrid(get, cx, cz, radius, opts = {}) {
  const grid = new Map()
  for (let x = cx - radius; x <= cx + radius; x++) for (let z = cz - radius; z <= cz + radius; z++) grid.set(`${x},${z}`, column(get, x, z, opts))
  return grid
}

// The best place for a farm of cols x rows around `home`: a rectangle (torch ring included) where nearly every sapling spot is free soil with
// room above, with no natural tree, water or lava inside it (natural trees above ground are kept, so the lattice goes round them), not inside an
// `avoid` box ({x0,x1,z0,z1}), at a walking distance of minRing..maxRing from home, on level ground.
// -> { x, y, z, ok, cols, rows, score, ySpread } | null
function pickRect(grid, home, { cols = 4, rows = 3, minFrac = 0.75, minRing = 6, maxRing = 28, avoid = [], flat = 3, pad = 2 } = {}) {
  const f = makeFarm({ x: 0, y: 0, z: 0, cols, rows })
  const w = (cols - 1) * PERIOD + 2 * TORCH_OFFSET, d = (rows - 1) * PERIOD + 2 * TORCH_OFFSET
  let best = null
  const keys = [...grid.keys()].map(k => k.split(',').map(Number))
  const xs = keys.map(k => k[0]), zs = keys.map(k => k[1])
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs)
  for (let ox = minX + TORCH_OFFSET; ox + w - TORCH_OFFSET <= maxX; ox++) {
    for (let oz = minZ + TORCH_OFFSET; oz + d - TORCH_OFFSET <= maxZ; oz++) {
      f.x = ox; f.z = oz
      const b = bounds(f)
      const mx = (b.x0 + b.x1) / 2, mz = (b.z0 + b.z1) / 2, dist = Math.hypot(mx - home.x, mz - home.z)
      if (dist < minRing || dist > maxRing) continue
      if (avoid.some(a => b.x1 + pad >= a.x0 && b.x0 - pad <= a.x1 && b.z1 + pad >= a.z0 && b.z0 - pad <= a.z1)) continue
      let bad = false, okN = 0, ymin = 1e9, ymax = -1e9
      for (let x = b.x0; x <= b.x1 && !bad; x++) for (let z = b.z0; z <= b.z1; z++) {
        const c = grid.get(`${x},${z}`)
        if (!c) { bad = true; break }
        if (c.state === 'tree' || c.reason === 'water' || c.reason === 'lava' || c.reason === 'unloaded') { bad = true; break }
      }
      if (bad) continue
      for (const s of spots(f)) {
        const c = grid.get(`${s.x},${s.z}`)
        if (c && c.ok) { okN++; ymin = Math.min(ymin, c.y); ymax = Math.max(ymax, c.y) }
      }
      if (okN < Math.ceil(minFrac * cols * rows)) continue
      const ySpread = ymax - ymin
      if (ySpread > flat) continue
      const score = okN * 10 - Math.abs(dist - 12) - ySpread * 3
      if (!best || score > best.score) best = { x: ox, z: oz, y: ymin, ok: okN, cols, rows, score, ySpread }
    }
  }
  return best
}

// Record the ground level of every lattice spot of a farm from a grid (or from get) into farm.spotY.
function surveyFarm(farm, get, opts = {}) {
  const res = []
  for (const s of spots(farm)) {
    const c = column(get, s.x, s.z, { yHint: s.y, mode: farm.mode, ...opts })
    if (c.ok) farm.spotY[`${s.x},${s.z}`] = c.y
    res.push({ ...s, ...c })
  }
  return res
}

// Which torch cells are lit and which are not. The torch stands on the ground at the cell, so look for the free cell with solid ground
// under it close to the farm's level. -> [{ x, y, z, has, floorOk }]
const TORCH = /^(torch|wall_torch|soul_torch|soul_wall_torch)$/
function torchState(farm, get, { reach = 3 } = {}) {
  const y0 = farm.y
  return torchCells(farm).map(t => {
    for (let y = y0 + reach; y >= y0 - reach; y--) {
      const c = get(t.x, y, t.z), f = get(t.x, y - 1, t.z)
      if (!c || !f) return { ...t, y, has: false, floorOk: false, reason: 'unloaded' }
      if (TORCH.test(c.name)) return { ...t, y, has: true, floorOk: true }
      if (isFree(c) && !isLeaves(c) && isSolid(f) && !SAPLING.test(c.name)) return { ...t, y, has: false, floorOk: true }
    }
    return { ...t, y: y0, has: false, floorOk: false, reason: 'no-ground' }
  })
}

// One summary of a farm for status lines and the think prompt.
function summarize(farm, get) {
  const sp = surveyFarm({ ...farm, spotY: { ...farm.spotY } }, get)
  const n = { spots: sp.length, empty: 0, saplings: 0, trees: 0, blocked: 0, unloaded: 0 }
  for (const s of sp) {
    if (s.state === 'tree') n.trees++
    else if (s.ok && s.state === 'sapling') n.saplings++
    else if (s.ok) n.empty++
    else if (s.reason === 'unloaded') n.unloaded++
    else n.blocked++
  }
  const ts = torchState(farm, get)
  n.torches = ts.filter(t => t.has).length
  n.torchSpots = ts.length
  n.unlit = ts.filter(t => !t.has && t.floorOk).length
  return n
}

module.exports = { PERIOD, TORCH_OFFSET, CLEAR, SOIL, makeFarm, spots, torchCells, bounds, inBounds, isSpot, centre, column, scanGrid, pickRect, surveyFarm, torchState, summarize, isFree, isSolid, isAir }
