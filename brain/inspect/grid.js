// brain/inspect/grid.js: a block grid the inspector reads. Pure data: a Map of "x,y,z" -> { n: block name, p: the few properties that matter }.
// A grid comes from the live bot (fromBot, only when every chunk of the box is loaded), from a function (tests) or from a fixture file
// (a world-save dump, test/fixtures/mobfarm-live-2026-11-10.json). A cell that is not in the grid is UNKNOWN, never air: every check treats unknown as "cannot say".
'use strict'

const key = (x, y, z) => x + ',' + y + ',' + z
const AIR = /^(air|cave_air|void_air)$/
// blocks light passes through (and mobs walk through): everything else is an opaque full block as far as light and spawning go
const TRANSPARENT = /^(air|cave_air|void_air|water|lava|torch|wall_torch|soul_torch|soul_wall_torch|redstone_torch|redstone_wall_torch|ladder|vine|short_grass|tall_grass|fern|large_fern|dead_bush|[a-z_]*flower|dandelion|poppy|cornflower|oxeye_daisy|azure_bluet|lily_of_the_valley|[a-z_]*tulip|allium|blue_orchid|[a-z_]*sapling|leaf_litter|[a-z_]*carpet|snow|[a-z_]*pressure_plate|[a-z_]*button|lever|tripwire|rail|powered_rail|detector_rail|activator_rail|[a-z_]*sign|[a-z_]*door|[a-z_]*trapdoor|[a-z_]*fence|[a-z_]*fence_gate|[a-z_]*glass|[a-z_]*glass_pane|[a-z_]*leaves|cobweb|fire|[a-z_]*bed|lantern|soul_lantern|glow_lichen|[a-z_]*slab|[a-z_]*stairs|[a-z_]*candle|hopper|chest|trapped_chest)$/
// what gives off light, and how much (block light at the source)
const EMIT = { torch: 14, wall_torch: 14, soul_torch: 10, soul_wall_torch: 10, redstone_torch: 7, redstone_wall_torch: 7, lantern: 15, soul_lantern: 10, glowstone: 15, sea_lantern: 15, shroomlight: 15, lava: 15, fire: 15, soul_fire: 10, campfire: 15, jack_o_lantern: 15, end_rod: 14, magma_block: 3, glow_lichen: 7, ochre_froglight: 15, verdant_froglight: 15, pearlescent_froglight: 15, crying_obsidian: 10, beacon: 15, conduit: 15, respawn_anchor: 0, sculk_catalyst: 6, amethyst_cluster: 5, large_amethyst_bud: 4, medium_amethyst_bud: 2, small_amethyst_bud: 1 }
const LIGHT_SOURCE = /^(torch|wall_torch|soul_torch|soul_wall_torch|redstone_torch|redstone_wall_torch|lantern|soul_lantern|glowstone|sea_lantern|shroomlight|lava|fire|soul_fire|campfire|jack_o_lantern|end_rod|glow_lichen|[a-z]+_froglight|crying_obsidian|beacon|conduit|magma_block)$/

function makeGrid(meta = {}) {
  const cells = new Map()
  const g = {
    meta, cells,
    set(x, y, z, n, p) { cells.set(key(x, y, z), p && Object.keys(p).length ? { n, p } : { n }) },
    get(x, y, z) { return cells.get(key(x, y, z)) || null },
    name(x, y, z) { const c = cells.get(key(x, y, z)); return c ? c.n : null },
    has(x, y, z) { return cells.has(key(x, y, z)) },
    isAir(x, y, z) { const c = cells.get(key(x, y, z)); return !!c && AIR.test(c.n) },
    // an opaque full block: stops light, mobs and water. Unknown is neither solid nor open.
    isSolid(x, y, z) { const c = cells.get(key(x, y, z)); return !!c && !TRANSPARENT.test(c.n) },
    isTransparent(x, y, z) { const c = cells.get(key(x, y, z)); return !!c && TRANSPARENT.test(c.n) },
    prop(x, y, z, k) { const c = cells.get(key(x, y, z)); return c && c.p ? c.p[k] : undefined },
    size: () => cells.size,
  }
  return g
}

// from a function (x, y, z) -> { name, props } | null, over a box with a margin. `yieldEvery` lets a live caller give the event loop back between layers.
async function fromFunction(blockAt, box, margin = 0, opt = {}) {
  const g = makeGrid({ box, margin })
  const m = typeof margin === 'number' ? { x: margin, y: margin, z: margin } : margin
  for (let y = box.y0 - m.y; y <= box.y1 + m.y; y++) {
    for (let x = box.x0 - m.x; x <= box.x1 + m.x; x++) for (let z = box.z0 - m.z; z <= box.z1 + m.z; z++) {
      const b = blockAt(x, y, z); if (b) g.set(x, y, z, b.name, b.props)
    }
    if (opt.yieldEvery && opt.sleep) await opt.sleep(0)
  }
  return g
}

// the live bot: every chunk column of the (margined) box must be loaded, otherwise the answer would be half air. Returns null when it is not.
function columnsLoaded(bot, box, margin = 0) {
  const m = typeof margin === 'number' ? { x: margin, y: margin, z: margin } : margin
  for (let cx = (box.x0 - m.x) >> 4; cx <= (box.x1 + m.x) >> 4; cx++) for (let cz = (box.z0 - m.z) >> 4; cz <= (box.z1 + m.z) >> 4; cz++) {
    let col = null; try { col = bot.world.getColumn(cx, cz) } catch { col = null }
    if (!col) return false
  }
  return true
}
const PROPS = ['level', 'facing', 'type', 'waterlogged', 'half', 'open', 'axis', 'hinge', 'face', 'attached', 'shape']
// properties are read for every block that is not air and not a plain solid cube (water levels, hoppers, slabs, trapdoors, ladders ...): the exact check
// (brain/inspect/exact.js) needs them, and plain rock has none that matter
const PLAIN = /^(air|cave_air|void_air|stone|cobblestone|deepslate|cobbled_deepslate|dirt|grass_block|tuff|granite|diorite|andesite|gravel|sand|netherrack|[a-z_]+_ore|bedrock)$/
function liveBlockAt(bot) {
  const Vec3 = require('vec3').Vec3
  return (x, y, z) => {
    const b = bot.blockAt(new Vec3(x, y, z)); if (!b) return null
    let p = null
    if (!PLAIN.test(b.name)) { try { const all = b.getProperties ? b.getProperties() : {}; p = {}; for (const k of PROPS) if (all[k] !== undefined) p[k] = String(all[k]) } catch { p = null } }
    return { name: b.name, props: p }
  }
}
async function fromBot(bot, box, margin = 0, opt = {}) {
  if (!columnsLoaded(bot, box, margin)) return null
  return fromFunction(liveBlockAt(bot), box, margin, opt)
}

// the fixture format written by the world-save dump: rows['y,z'] = one palette char per x from x0
function fromFixture(f) {
  const g = makeGrid({ box: { x0: f.x0, x1: f.x1, y0: f.y0, y1: f.y1, z0: f.z0, z1: f.z1 }, margin: 0, fixture: true })
  for (const [yz, s] of Object.entries(f.rows)) {
    const [y, z] = yz.split(',').map(Number)
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]; if (ch === ' ') continue
      const x = f.x0 + i, k = key(x, y, z)
      g.set(x, y, z, f.palette[ch], f.props && f.props[k])
    }
  }
  return g
}

module.exports = { makeGrid, fromFunction, fromBot, fromFixture, columnsLoaded, liveBlockAt, key, AIR, TRANSPARENT, EMIT, LIGHT_SOURCE }
