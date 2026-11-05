// Site survey for the tower (read-only, pure apart from bot.blockAt): where is there a flat, dry, tree-free 7x7 patch?
//
//   findSite(bot, { center:{x,z}, radius, maxDy, protect, y, yRange }) -> { ox, oy, oz, score, ... } | null
//   survey(bot, opts) -> { site, reason, counts, scanned }        (same search, with the reason it found nothing)
//
// Candidate origin O = the north-west corner of the 5x5 ring; the footprint is x,z in -1..5 (the deck), read with a 2 block margin.
// Ground = the highest solid natural block of a column (leaves and logs are looked through and counted as obstacles). A candidate needs:
//   - every column of the 11x11 area loaded (a missing block means "unknown", never "suitable"), dry and with natural ground
//   - the 7x7 ground within maxDy, the centre column (the pillar stands there) at the highest level, base level oy-1 = the highest ground
//   - nothing above the ground inside the volume x -1..5, y oy..oy+12, z -1..5 (no leaves, logs, vines, player blocks)
//   - not inside a protected box (Walter's base)
// Score (lower is better): flat first, then the highest ground (view), then the closest to the centre.
const { Vec3 } = require('vec3')

const AIR = /^(air|cave_air|void_air)$/
const PLANT = /^(short_grass|grass|tall_grass|fern|large_fern|dead_bush|snow|dandelion|poppy|blue_orchid|allium|azure_bluet|red_tulip|orange_tulip|white_tulip|pink_tulip|oxeye_daisy|cornflower|lily_of_the_valley|pink_petals|brown_mushroom|red_mushroom)$/
const LIQUID = /^(water|lava|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/
const LEAF = /_leaves$/
const LOG = /(_log|_wood|_stem|_hyphae|mangrove_roots|muddy_mangrove_roots|bamboo)$/
const NATURAL = /^(grass_block|dirt|coarse_dirt|rooted_dirt|podzol|mycelium|mud|clay|gravel|sand|red_sand|sandstone|red_sandstone|stone|granite|diorite|andesite|deepslate|tuff|calcite|terracotta|snow_block|moss_block|dripstone_block|smooth_basalt|basalt)$/
const MARGIN = 3                       // columns read around the origin: -3..7 (the 7x7 footprint -1..5 plus 2)
const VOLUME_TOP = 12                  // oy .. oy+12

function columnInfo(bot, x, z, yTop, yBot) {
  let obsY = Infinity
  for (let y = yTop; y >= yBot; y--) {
    let b = null
    try { b = bot.blockAt(new Vec3(x, y, z)) } catch { b = null }
    if (!b) return { kind: 'unknown' }
    const n = b.name
    if (AIR.test(n) || PLANT.test(n)) continue
    if (LIQUID.test(n)) return { kind: 'liquid' }
    if (LEAF.test(n) || LOG.test(n)) { obsY = y; continue }
    if (b.boundingBox === 'block') {
      if (NATURAL.test(n)) return { kind: 'ok', ground: y, obsY, name: n }
      return { kind: 'player', name: n }
    }
    obsY = y                                          // a torch, vine, sign...: not ground, and in the way
  }
  return { kind: 'none' }
}

const intersects = (a, b) => a.min[0] <= b.max[0] && a.max[0] >= b.min[0] && a.min[1] <= b.max[1] && a.max[1] >= b.min[1] && a.min[2] <= b.max[2] && a.max[2] >= b.min[2]

function survey(bot, opts = {}) {
  const center = opts.center || { x: Math.round(bot.entity.position.x), z: Math.round(bot.entity.position.z) }
  const radius = opts.radius ?? 14
  const maxDy = opts.maxDy ?? 1
  const protect = opts.protect || []
  const yMid = Math.round(opts.y ?? (bot.entity && bot.entity.position ? bot.entity.position.y : 64))
  const yRange = opts.yRange ?? 48
  const yTop = Math.min(yMid + yRange, 319), yBot = Math.max(yMid - yRange, -64)
  const cache = new Map()
  const col = (x, z) => {
    const k = `${x},${z}`
    let c = cache.get(k)
    if (!c) { c = columnInfo(bot, x, z, yTop, yBot); cache.set(k, c) }
    return c
  }
  const counts = {}
  const reject = (why) => { counts[why] = (counts[why] || 0) + 1; return null }
  let best = null, scanned = 0
  for (let ox = Math.round(center.x - radius); ox <= Math.round(center.x + radius); ox++) {
    for (let oz = Math.round(center.z - radius); oz <= Math.round(center.z + radius); oz++) {
      const dist = Math.hypot(ox - center.x, oz - center.z)
      if (dist > radius) continue
      scanned++
      // 11x11 read: any unloaded / wet / player-built / groundless column rules the candidate out
      let bad = null
      const cols = new Map()
      for (let dx = -MARGIN; dx <= MARGIN + 4 && !bad; dx++) for (let dz = -MARGIN; dz <= MARGIN + 4 && !bad; dz++) {
        const c = col(ox + dx, oz + dz)
        if (c.kind !== 'ok') bad = c.kind === 'unknown' ? 'unloaded' : c.kind === 'liquid' ? 'water' : c.kind === 'player' ? 'player-block' : 'no-ground'
        else cols.set(`${dx},${dz}`, c)
      }
      if (bad) { reject(bad); continue }
      let base = -Infinity, low = Infinity
      for (let dx = -1; dx <= 5; dx++) for (let dz = -1; dz <= 5; dz++) { const g = cols.get(`${dx},${dz}`).ground; if (g > base) base = g; if (g < low) low = g }
      if (base - low > maxDy) { reject('slope'); continue }
      if (cols.get('2,2').ground !== base) { reject('centre-low'); continue }
      const oy = base + 1
      let tree = false
      for (let dx = -1; dx <= 5 && !tree; dx++) for (let dz = -1; dz <= 5 && !tree; dz++) if (cols.get(`${dx},${dz}`).obsY <= oy + VOLUME_TOP) tree = true
      if (tree) { reject('obstacle'); continue }
      const volume = { min: [ox - 1, low, oz - 1], max: [ox + 5, oy + VOLUME_TOP, oz + 5] }
      if (protect.some(p => intersects(volume, p))) { reject('protected'); continue }
      const flat = base - low
      const score = flat * 1e6 - base * 1e3 + dist
      if (!best || score < best.score) {
        const lowCells = []
        for (let dx = 0; dx <= 4; dx++) for (let dz = 0; dz <= 4; dz++) { const g = cols.get(`${dx},${dz}`).ground; if (g < base) lowCells.push([dx, dz, g]) }
        best = { ox, oy, oz, score, flat, ground: base, dist: Math.round(dist * 10) / 10, low: lowCells }
      }
    }
  }
  let reason = null
  if (!best) {
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${v} ${k}`).join(', ')
    reason = `no flat, dry, tree-free 7x7 patch within ${radius} blocks of ${Math.round(center.x)}, ${Math.round(center.z)}${top ? ` (rejected: ${top})` : ''}`
  }
  return { site: best, reason, counts, scanned }
}

const findSite = (bot, opts) => survey(bot, opts).site

module.exports = { findSite, survey, columnInfo, intersects, MARGIN, VOLUME_TOP }
