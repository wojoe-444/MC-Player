// brain/autopilot/light.js: block light computed from the light sources the bot can see.
// The per-block light that mineflayer reports on this server (1.21.6) is scrambled (a torch block reads 0, buried stone reads 14),
// so it cannot tell where mobs spawn. Block light is deterministic: each source emits a level that drops by at least 1 per block
// and cannot pass opaque blocks. This floods it the way the game does (one pass, brightest first) around a center.
// Monsters (1.18+) spawn only where block light is 0, on a solid full floor with two free cells above.
const EMIT = { torch: 14, wall_torch: 14, lantern: 15, soul_lantern: 10, soul_torch: 10, soul_wall_torch: 10, glowstone: 15, sea_lantern: 15,
  jack_o_lantern: 15, campfire: 15, lava: 15, shroomlight: 15, end_rod: 14, beacon: 15, redstone_torch: 7, redstone_wall_torch: 7 }
const NOFLOOR = /air|water|lava|leaves|glass|slab|stairs|farmland|dirt_path|carpet|fence|wall|torch|bed|chest|door|trapdoor|ice|bedrock|berry|_crop|wheat|snow$/

module.exports = function makeLight(bot, Vec3) {
  const reg = bot.registry
  const byState = (s) => reg.blocksByStateId[s]
  const opaque = new Map()
  // light passes cells with no full collision box, plus leaves/glass/ice (filterLight from the data, at least 1 per step)
  const cost = (s) => { if (opaque.has(s)) return opaque.get(s); const b = byState(s); let c = 1
    if (!b) c = 99; else if (b.boundingBox === 'block' && !b.transparent && !/leaves|glass|ice|slab|stairs/.test(b.name)) c = 99; else c = Math.max(1, b.filterLight || 0)
    opaque.set(s, c); return c }
  const sid = (x, y, z) => { try { return bot.world.getBlockStateId(new Vec3(x, y, z)) } catch { return null } }

  // returns { level(p), spawnable(p) } for cells within r (horizontal) of center; sources up to r+15 away are included
  // opts.exclude: a Set of "x,y,z" sources to leave out (what the light would be without those torches)
  async function compute(center, r = 40, dy = 24, opts = {}) {
    const R = r + 15, key = (x, y, z) => ((x - center.x + 128) * 512 + (y - center.y + 256)) * 512 + (z - center.z + 128)
    const lvl = new Map(), buckets = Array.from({ length: 16 }, () => [])
    const ids = Object.keys(EMIT).filter(n => reg.blocksByName[n]).map(n => reg.blocksByName[n].id)
    const src = bot.findBlocks({ matching: ids, point: center, maxDistance: R, count: 4000 })
    for (const p of src) { const b = bot.blockAt(p); const e = b && EMIT[b.name]; if (!e) continue
      if (opts.exclude && opts.exclude.has(p.x + ',' + p.y + ',' + p.z)) continue
      if (b.name === 'campfire' && b.getProperties && b.getProperties().lit === false) continue
      const k = key(p.x, p.y, p.z); if ((lvl.get(k) || 0) < e) { lvl.set(k, e); buckets[e].push([p.x, p.y, p.z]) } }
    let n = 0
    for (let L = 15; L >= 2; L--) for (const [x, y, z] of buckets[L]) {
      if (lvl.get(key(x, y, z)) !== L) continue
      for (const [ax, ay, az] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const nx = x + ax, ny = y + ay, nz = z + az
        if (Math.abs(ny - center.y) > dy + 15) continue
        const s = sid(nx, ny, nz); if (s == null) continue
        const nl = L - cost(s); if (nl <= 0) continue
        const k = key(nx, ny, nz); if ((lvl.get(k) || 0) >= nl) continue
        lvl.set(k, nl); buckets[nl].push([nx, ny, nz])
      }
      if (++n % 800 === 0) await new Promise(r => setImmediate(r))   // short slices: combat must keep ticking during a big light flood
    }
    const level = (p) => lvl.get(key(p.x, p.y, p.z)) || 0
    const spawnable = (p) => { const b = bot.blockAt(p), up = bot.blockAt(p.offset(0, 1, 0)), g = bot.blockAt(p.offset(0, -1, 0))
      return !!(b && up && g && level(p) === 0 && b.boundingBox === 'empty' && up.boundingBox === 'empty' && !/water|lava/.test(b.name + up.name) && g.boundingBox === 'block' && !NOFLOOR.test(g.name)) }
    return { level, spawnable, sources: src.length, cells: lvl.size }
  }
  return { compute, EMIT }
}
