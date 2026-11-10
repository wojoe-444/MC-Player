// brain/lightup/world.js: adapts a mineflayer bot to the `world` interface of plan.js (see there). Reads the block data the client already holds for the loaded
// chunks, plus block light from brain/autopilot/light.js (the server's own light data is scrambled on this build, so light is flooded from the visible sources).
'use strict'
const { DENY } = require('../lighting/torches')
const { NOFLOOR } = require('../autopilot/light')

const LIQUID = /^(water|lava|bubble_column)$/

// L: the object brain/autopilot/light.js makes ({ cost }); lv: the result of L.compute(...) ({ level })
function makeWorld(bot, Vec3, L, lv) {
  const reg = bot.registry
  const scratch = new Vec3(0, 0, 0)
  const cache = new Map()                                  // stateId -> { open, floor, torchFloor }
  const sidAt = (x, y, z) => { scratch.x = x; scratch.y = y; scratch.z = z; try { return bot.world.getBlockStateId(scratch) } catch { return null } }
  const info = (s) => {
    let c = cache.get(s)
    if (c) return c
    const b = reg.blocksByStateId[s]
    if (!b) c = { open: false, pass: false, floor: false, torchFloor: false }
    else {
      const liquid = LIQUID.test(b.name) || (b.name === 'water')
      c = { open: b.boundingBox === 'empty' && !liquid, pass: (b.boundingBox === 'empty' && b.name !== 'lava') || /^(ladder|scaffolding|.*_door|.*_trapdoor|.*_fence_gate)$/.test(b.name), floor: b.boundingBox === 'block' && !liquid && !NOFLOOR.test(b.name), torchFloor: b.boundingBox === 'block' && !liquid && !DENY.test(b.name) }
    }
    cache.set(s, c); return c
  }
  const loadedCols = new Map()
  const loaded = (x, z) => {
    const k = (x >> 4) * 65536 + (z >> 4)
    let v = loadedCols.get(k)
    if (v === undefined) { try { v = !!(bot.world.getColumn ? bot.world.getColumn(x >> 4, z >> 4) : true) } catch { v = false } loadedCols.set(k, v) }
    return v
  }
  const stat = (x, y, z) => { if (!loaded(x, z)) return null; const s = sidAt(x, y, z); return s == null ? null : info(s) }
  const top = (bot.game && bot.game.height ? bot.game.height + (bot.game.minY || 0) : 320)
  const skyCache = new Map()
  return {
    loaded,
    open: (x, y, z) => { const c = stat(x, y, z); return !!c && c.open },
    pass: (x, y, z) => { const c = stat(x, y, z); return !!c && c.pass },
    floor: (x, y, z) => { const c = stat(x, y, z); return !!c && c.floor },
    torchFloor: (x, y, z) => { const c = stat(x, y, z); return !!c && c.torchFloor },
    level: (x, y, z) => lv.level({ x, y, z }),
    cost: (x, y, z) => (loaded(x, z) ? L.cost(x, y, z) : 99),
    // open sky: nothing solid or liquid above, to the build limit (cached per column and the lowest cell found clear)
    sky: (x, y, z) => {
      const k = x * 65536 + z, c = skyCache.get(k)
      if (c !== undefined && y >= c.y && c.open) return true
      if (c !== undefined && !c.open && y <= c.y) return false
      for (let yy = y + 2; yy < top; yy++) {
        const s = sidAt(x, yy, z); if (s == null) break
        const b = reg.blocksByStateId[s]
        if (b && (b.boundingBox === 'block' || LIQUID.test(b.name))) { skyCache.set(k, { y: yy, open: false }); return false }
      }
      skyCache.set(k, { y, open: true }); return true
    },
  }
}
module.exports = makeWorld
