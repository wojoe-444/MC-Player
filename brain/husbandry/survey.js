// Site finders for brain/husbandry. Pure apart from bot.blockAt: they read the loaded world, never a hidden one (an unloaded column makes a site unsuitable).
//   findPenSite(bot, opts)    -> { ox, oy, oz, w, d, grass, dist, score } | null      a flat, natural, dry patch for the pen plus its fence ring
//   penSiteWhy(bot, opts)     -> short reason text when there is none
//   findLichenWall(bot, opts) -> { x, y, z, fx, fz, w, h, dist } | null              a plain stone wall w wide, h high with open air in front (x,y,z = its lower middle block)
const { Vec3 } = require('vec3')

const AIR = /^(air|cave_air|void_air)$/
const SOFT = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|snow|dead_bush|dandelion|poppy|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|allium|blue_orchid|red_tulip|orange_tulip|white_tulip|pink_tulip|sunflower|lilac|rose_bush|peony)$/
const GROUND = /^(grass_block|dirt|coarse_dirt|podzol|rooted_dirt|moss_block)$/
const WALL = /^(stone|andesite|diorite|granite|tuff|deepslate|cobbled_deepslate|smooth_stone|stone_bricks|calcite|dripstone_block|netherrack|blackstone)$/
const LIQUID = /^(water|lava|bubble_column)$/

const at = (bot, x, y, z) => { try { return bot.blockAt(new Vec3(x, y, z)) || null } catch { return null } }

// the ground of a column near cy: { y, name } of the topmost non-soft block with soft cells above it, or null (unloaded / liquid / not open)
function groundAt(bot, x, z, cy, cache) {
  const k = `${x},${z}`
  if (cache && cache.has(k)) return cache.get(k)
  let res = null
  for (let y = cy + 8; y >= cy - 8; y--) {
    const b = at(bot, x, y, z)
    if (!b) break                                                   // unloaded
    if (LIQUID.test(b.name)) break
    if (SOFT.test(b.name)) continue
    const a1 = at(bot, x, y + 1, z), a2 = at(bot, x, y + 2, z)
    if (b.boundingBox === 'block' && a1 && a2 && SOFT.test(a1.name) && SOFT.test(a2.name)) res = { y, name: b.name }
    break
  }
  if (cache) cache.set(k, res)
  return res
}

// avoid: [{ x0, x1, z0, z1 }] boxes (existing pens, with a margin) the new ring must stay clear of
function evaluate(bot, ox, oz, cy, w, d, opts, cache) {
  const maxDy = opts.maxDy || 0
  let y0 = null, grass = 0, n = 0
  for (let x = ox - 1; x <= ox + w; x++) for (let z = oz - 1; z <= oz + d; z++) {
    const g = groundAt(bot, x, z, cy, cache)
    if (!g) return { ok: false, why: 'ground is not open, dry and loaded' }
    if (!GROUND.test(g.name)) return { ok: false, why: `${g.name} in the way` }
    if (y0 === null) y0 = g.y
    if (Math.abs(g.y - y0) > maxDy) return { ok: false, why: 'ground is not flat' }
    const inside = x >= ox && x < ox + w && z >= oz && z < oz + d
    if (inside) { n++; if (g.name === 'grass_block') grass++ }
  }
  for (const b of opts.avoid || []) if (ox - 1 <= b.x1 && ox + w >= b.x0 && oz - 1 <= b.z1 && oz + d >= b.z0) return { ok: false, why: 'too close to another pen' }
  const frac = n ? grass / n : 0
  if (frac < (opts.minGrass == null ? 0.6 : opts.minGrass)) return { ok: false, why: 'not enough grass for sheep to regrow wool' }
  return { ok: true, oy: y0 + 1, grass: frac }
}

// Candidate NW interior corners on a stride-2 grid around `center` (default: the bot), nearest first. Searches `radius` blocks.
function findPenSite(bot, opts = {}) {
  const w = opts.w || 7, d = opts.d || 7, radius = opts.radius || 40
  const c = opts.center || bot.entity.position
  const cx = Math.floor(c.x), cz = Math.floor(c.z), cy = Math.floor(c.y)
  const cache = new Map(), cands = []
  for (let dx = -radius; dx <= radius; dx += 2) for (let dz = -radius; dz <= radius; dz += 2) cands.push([dx, dz, Math.hypot(dx, dz)])
  cands.sort((a, b) => a[2] - b[2])
  const deny = []
  for (const [dx, dz, dist] of cands) {
    const r = evaluate(bot, cx + dx - Math.floor(w / 2), cz + dz - Math.floor(d / 2), cy, w, d, opts, cache)
    if (r.ok) return { ox: cx + dx - Math.floor(w / 2), oy: r.oy, oz: cz + dz - Math.floor(d / 2), w, d, grass: r.grass, dist: Math.round(dist), score: r.grass - dist / 100 }
    if (deny.length < 6 && !deny.includes(r.why)) deny.push(r.why)
  }
  findPenSite.lastWhy = deny
  return null
}
const penSiteWhy = () => (findPenSite.lastWhy && findPenSite.lastWhy.length ? findPenSite.lastWhy.join('; ') : 'nothing flat enough nearby')

const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]]          // the face direction the open air is in: north, east, south, west
// A plain wall: w wide (along the wall), h high, every block a WALL stone, the two layers of cells in front of it air (the bot stands there), no liquid or lava near the front.
function findLichenWall(bot, opts = {}) {
  const w = opts.w || 3, h = opts.h || 2, radius = opts.radius || 30
  const c = opts.center || bot.entity.position
  const cx = Math.floor(c.x), cy = Math.floor(c.y), cz = Math.floor(c.z)
  const best = []
  const solid = (x, y, z) => { const b = at(bot, x, y, z); return !!b && WALL.test(b.name) }
  const air = (x, y, z) => { const b = at(bot, x, y, z); return !!b && AIR.test(b.name) }
  const hazard = (x, y, z) => { for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) { const b = at(bot, x + dx, y + dy, z + dz); if (b && LIQUID.test(b.name)) return true } return false }
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) for (let dy = -6; dy <= 6; dy++) {
    const x = cx + dx, y = cy + dy, z = cz + dz
    if (!solid(x, y, z)) continue
    for (const [fx, fz] of DIRS) {
      if (!air(x + fx, y, z + fz)) continue
      const ax = fz === 0 ? [0, 1] : [1, 0]                                // along the wall
      let ok = true
      for (let i = -Math.floor(w / 2); i <= Math.floor((w - 1) / 2) && ok; i++) for (let j = 0; j < h && ok; j++) {
        const bx = x + ax[0] * i, bz = z + ax[1] * i, by = y + j
        ok = solid(bx, by, bz) && air(bx + fx, by, bz + fz) && air(bx + 2 * fx, by, bz + 2 * fz)
      }
      if (!ok || hazard(x + fx, y, z + fz)) continue
      best.push({ x, y, z, fx, fz, w, h, dist: Math.hypot(dx, dy, dz) })
    }
  }
  best.sort((a, b) => a.dist - b.dist)
  return best[0] || null
}

module.exports = { findPenSite, penSiteWhy, findLichenWall, groundAt, AIR, SOFT, GROUND, WALL }
