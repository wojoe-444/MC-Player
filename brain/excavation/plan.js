// Pure planning and safety checks for the excavation. Works on anything with blockAt(Vec3); never acts on the world.
const { Vec3 } = require('vec3')

const GRAVITY = /(^|_)(sand|gravel|concrete_powder)$/
const LIQUID = new Set(['water', 'lava', 'bubble_column'])
// Only natural filler is ever dug. Anything else (Walter's builds, containers, stone bricks, dripstone, ...) is left alone and reported.
const NATURAL = /^(stone|cobblestone|dirt|grass_block|coarse_dirt|podzol|rooted_dirt|mud|clay|gravel|sand|red_sand|andesite|diorite|granite|deepslate|cobbled_deepslate|tuff|calcite|dripstone_block|moss_block|smooth_basalt|basalt|amethyst_block)$|_ore$/
const SIX = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
const HARD_MAX_Y = 150          // never configurable: the hall begins at y151
const ROOM_HEIGHT = 10          // y136..y145 (the hall floor is y150, so y146..149 stays as ceiling)

const key = (x, z) => `${x},${z}`
const isGravity = (b) => !!b && GRAVITY.test(b.name)
function isLiquid(b) {
  if (!b) return false
  if (LIQUID.has(b.name)) return true
  try { const p = b.getProperties && b.getProperties(); if (p && (p.waterlogged === true || p.waterlogged === 'true')) return true } catch {}
  return false
}
const isOpen = (b) => !!b && b.boundingBox === 'empty' && !isLiquid(b)

function makeGeometry(config) {
  const { x1, x2, z1, z2 } = config.box
  const floorY = config.floorY
  const hallMinY = Math.min(config.hallMinY ?? 151, HARD_MAX_Y + 1)
  const digFrom = Math.max(config.digFrom, floorY + 2)
  const digTo = Math.min(config.digTo, hallMinY - 1, HARD_MAX_Y, floorY + ROOM_HEIGHT - 1)
  const boxes = (config.protectedBoxes || []).map(b => ({ min: b.min, max: b.max }))
  const inBox = (x, z) => x >= x1 && x <= x2 && z >= z1 && z <= z2
  const protectedAt = (x, y, z) => y >= hallMinY || boxes.some(b => x >= b.min[0] && x <= b.max[0] && y >= b.min[1] && y <= b.max[1] && z >= b.min[2] && z <= b.max[2])
  const inVolume = (x, y, z) => inBox(x, z) && y >= digFrom && y <= digTo && !protectedAt(x, y, z)
  const extra = new Set(config.extraDiggable || [])
  // layer bands, each with its own done-set in the saved state (the first one is the old y138-141 job, so its progress is kept)
  const defs = config.bands || [{ id: 'base', from: digFrom, to: digTo, access: 'floor', key: 'done' }]
  const bands = defs.map(d => ({ ...d, from: Math.max(d.from, digFrom), to: Math.min(d.to, digTo) })).filter(d => d.from <= d.to)
  return { box: config.box, floorY, digFrom, digTo, hallMinY, bands, groupSize: config.groupSize || 3, inBox, protectedAt, inVolume, extra }
}

// Open columns at the floor: solid dry floor below, two open dry blocks above. `unloaded` counts box columns we could not look at
// because their chunk is not loaded (right after a restart only the chunks around the bot are): a scan with unloaded columns is partial and
// must never be taken for "that is the whole room".
function scanColumns(world, geo, opts = {}) {
  const chestCols = opts.chestCols || null          // columns whose floor cell holds our work-site chest: still part of the room
  const cols = []
  let unloaded = 0
  const { x1, x2, z1, z2 } = geo.box
  for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) {
    const f = world.blockAt(new Vec3(x, geo.floorY - 1, z)), a = world.blockAt(new Vec3(x, geo.floorY, z)), b = world.blockAt(new Vec3(x, geo.floorY + 1, z))
    if (!f || !a || !b) { unloaded++; continue }
    const aOpen = isOpen(a) || (chestCols && chestCols.has(`${x},${z}`) && a.name === 'chest')
    if (f.boundingBox !== 'empty' && !isLiquid(f) && aOpen && isOpen(b)) cols.push({ x, z })
  }
  return { cols, unloaded }
}
const footprint = (world, geo) => scanColumns(world, geo).cols

// 3x3 sections in a serpentine order. Section ids ("gx,gz" of the north-west corner) are what exc-state.json stored, so old progress still matches.
function groupsOf(cols, geo, opts = {}) {
  const avoid = opts.avoid || null                  // columns that cannot be stood in (the work-site chest)
  const set = new Map(cols.map(c => [key(c.x, c.z), c]))
  const { x1, x2, z1, z2 } = geo.box, n = geo.groupSize
  const groups = []
  let flip = false
  for (let gx = x1; gx <= x2; gx += n) {
    const row = []
    for (let gz = z1; gz <= z2; gz += n) {
      const members = []
      for (let x = gx; x < gx + n; x++) for (let z = gz; z < gz + n; z++) { const c = set.get(key(x, z)); if (c) members.push(c) }
      if (!members.length) continue
      const cx = gx + (n - 1) / 2, cz = gz + (n - 1) / 2
      const free = avoid ? members.filter(m => !avoid.has(key(m.x, m.z))) : members
      const stand = (free.length ? free : members).slice().sort((a, b) => Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz))[0]
      row.push({ id: `${gx},${gz}`, members, stand })
    }
    groups.push(...(flip ? row.reverse() : row)); flip = !flip
  }
  return groups
}

// Decide whether the block at x,y,z may be dug right now. Called again immediately before every dig.
//   { ok:true } | { ok:false, why, quiet? }   (quiet = nothing to dig, not worth counting)
function checkCell(world, x, y, z, geo) {
  if (!geo.inVolume(x, y, z)) return { ok: false, why: 'outside-volume' }
  const b = world.blockAt(new Vec3(x, y, z))
  if (!b) return { ok: false, why: 'unloaded' }
  if (isLiquid(b)) return { ok: false, why: b.name === 'lava' ? 'lava' : 'liquid' }
  if (b.boundingBox === 'empty') return { ok: false, why: 'air', quiet: true }
  if (!NATURAL.test(b.name) && !geo.extra.has(b.name)) return { ok: false, why: `protected:${b.name}` }
  if (b.diggable === false) return { ok: false, why: `undiggable:${b.name}` }
  for (const [dx, dy, dz] of SIX) {
    const n = world.blockAt(new Vec3(x + dx, y + dy, z + dz))
    if (!n) return { ok: false, why: 'unloaded-neighbour' }
    if (isLiquid(n)) return { ok: false, why: n.name === 'lava' ? 'lava-adjacent' : 'liquid-adjacent' }
  }
  return { ok: true }
}

// A column is skipped when sand/gravel sits anywhere in the dig range or just above it (it would fall on the bot).
function columnHasGravity(world, x, z, geo) {
  for (let y = geo.digFrom; y <= geo.digTo + 1; y++) if (isGravity(world.blockAt(new Vec3(x, y, z)))) return true
  return false
}

// What is inside the volume to be dug and which hazards sit next to it (read-only; used for the plan line and tests).
function prescan(world, cols, geo) {
  const tally = {}, hazards = { liquidAdjacent: 0, gravityColumns: 0, unknownBlocks: 0 }
  for (const c of cols) {
    if (columnHasGravity(world, c.x, c.z, geo)) hazards.gravityColumns++
    for (let y = geo.digFrom; y <= geo.digTo; y++) {
      const b = world.blockAt(new Vec3(c.x, y, c.z)); if (!b) continue
      tally[b.name] = (tally[b.name] || 0) + 1
      const r = checkCell(world, c.x, y, c.z, geo)
      if (!r.ok && /adjacent$/.test(r.why)) hazards.liquidAdjacent++
      else if (!r.ok && /^protected:/.test(r.why)) hazards.unknownBlocks++
    }
  }
  return { tally, hazards }
}

module.exports = { makeGeometry, footprint, scanColumns, groupsOf, checkCell, columnHasGravity, prescan, isLiquid, isOpen, isGravity, NATURAL, HARD_MAX_Y, SIX }
