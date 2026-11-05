// What the bot may act on: only what a player standing here could see. Every decision in brain/mining goes through this file.
//
//   - look(): one pass over the cube around the eye. Block NAMES are read there only to pre-filter candidates (ore, liquid);
//     a candidate is returned only when it has an exposed face AND a clear ray from the eye (api.canSee / bot.world.raycast).
//     Nothing that fails the ray test leaves this file, so it can never steer a decision (no x-ray).
//   - bot.findBlocks / bot.findBlock are never used for ores or liquids (they are the x-ray API).
//   - If bot.world.raycast is missing nothing can be verified and nothing is seen (fail closed).
const { Vec3 } = require('vec3')
const los = require('../los')

const LIQUID = new Set(['water', 'lava', 'bubble_column'])
const GRAVITY = /(^|_)(sand|gravel|concrete_powder)$/
// Only natural filler is ever dug; everything else (Walter's builds, planks and rails of old mineshafts, chests, spawners ...) is left alone.
const NATURAL = /^(stone|cobblestone|dirt|grass_block|coarse_dirt|podzol|rooted_dirt|mud|clay|gravel|sand|red_sand|andesite|diorite|granite|deepslate|cobbled_deepslate|tuff|calcite|dripstone_block|smooth_basalt|basalt|sandstone|red_sandstone|snow_block)$|_ore$/
// Mines are messy (Walter): at the bottom of a shaft anything that can be dug is dug (gravel, sand, dirt, planks and rails of an old mineshaft, cobwebs ...). Only what must not be broken stays:
// containers and workstations (their contents), beds, doors and redstone parts, glass, brick/stone-brick builds, the unbreakable blocks and fluids.
const KEEP = /(^|_)(chest|barrel|shulker_box|furnace|smoker|hopper|dropper|dispenser|brewing_stand|lectern|jukebox|crafting_table|enchanting_table|anvil|grindstone|loom|stonecutter|smithing_table|cartography_table|fletching_table|bed|banner|lever|button|repeater|comparator|piston|observer|note_block|door|trapdoor|fence_gate|bookshelf|beacon|conduit|sign)$|glass|bricks?$|_bricks|bedrock|barrier|obsidian|end_portal|end_gateway|command_block|structure_block|jigsaw|reinforced_deepslate|nether_portal|^fire$|soul_fire|powder_snow|lava|water|bubble_column|redstone_(lamp|torch|wire|block)/
const BAD_FEET = /^(cobweb|fire|soul_fire|sweet_berry_bush|powder_snow|magma_block|cactus|wither_rose|campfire|soul_campfire)$/
const BAD_FLOOR = /^(magma_block|cactus|campfire|soul_campfire|powder_snow|honey_block|slime_block|cobweb)$/
const SIX = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]

const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z))

module.exports = function makeSight({ bot, canSee: ext = null, config = {}, log = () => {} }) {
  const S = { scanRadius: 7, liquidRadius: 6, lavaKeepout: 5, waterKeepout: 3, cellKeepout: 2, ...(config.sight || {}) }
  const available = () => !!(bot.world && typeof bot.world.raycast === 'function')
  const eye = () => los.eyeOf(bot)

  const block = (p) => { try { return bot.blockAt(p instanceof Vec3 ? p : new Vec3(p.x, p.y, p.z)) || null } catch { return null } }
  const isLiquid = (b) => {
    if (!b) return false
    if (LIQUID.has(b.name)) return true
    try { const pr = b.getProperties && b.getProperties(); if (pr && (pr.waterlogged === true || pr.waterlogged === 'true')) return true } catch {}
    return false
  }
  const isLadder = (b) => !!b && b.name === 'ladder'
  // A block that a ladder hangs on (Walter's screenshot: the hallway was dug "where the ladder used to be", into the wall behind it): breaking it drops the ladder.
  const FACING = { west: [-1, 0], east: [1, 0], north: [0, -1], south: [0, 1] }
  function supportsLadder(cell) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = block(new Vec3(cell.x + dx, cell.y, cell.z + dz))
      if (!n || n.name !== 'ladder') continue
      let f = null
      try { f = n.getProperties && n.getProperties().facing } catch {}
      const v = FACING[f]
      if (v && n.position.x - v[0] === cell.x && n.position.z - v[1] === cell.z) return true      // the ladder faces v, so its wall is at ladder - v
    }
    return false
  }
  const isOpen = (b) => !!b && (b.boundingBox === 'empty' || isLadder(b)) && !isLiquid(b) && !BAD_FEET.test(b.name)      // a ladder is climbable, not an obstacle
  const isSolid = (b) => !!b && b.boundingBox === 'block' && !isLiquid(b)
  const isNatural = (b) => !!b && NATURAL.test(b.name)
  const isDiggable = (b) => !!b && !isLiquid(b) && !KEEP.test(b.name) && b.diggable !== false && !/^(air|cave_air|void_air)$/.test(b.name)
  const isGravity = (b) => !!b && GRAVITY.test(b.name)

  // Is `target` (a block, an entity or a Vec3 block position) in plain view of the eye? Fails closed.
  function see(target, at) {
    if (!target || !available()) return false
    try {
      if (ext && !at) return !!ext(target)
      return los.canSee(bot, target, at)
    } catch (e) { log('canSee failed: ' + e.message); return false }
  }

  // At least one face touches something that is not solid (air, liquid, torch ...). Unloaded neighbours do not count as open.
  function exposed(p) {
    for (const [dx, dy, dz] of SIX) {
      const n = block(new Vec3(p.x + dx, p.y + dy, p.z + dz))
      if (n && n.boundingBox === 'empty') return true
    }
    return false
  }

  // { ores:[{block, d}], liquids:[{block, pos, d, lava}] }, nearest first. Only things that can be seen.
  function look({ ores = null, radius = S.scanRadius, liquidRadius = S.liquidRadius } = {}) {
    const out = { ores: [], liquids: [] }
    if (!available()) return out
    const me = bot.entity.position, e = eye()
    const R = Math.max(ores ? radius : 0, liquidRadius)
    const cx = Math.floor(me.x), cy = Math.floor(me.y + 1), cz = Math.floor(me.z)
    for (let y = cy - R; y <= cy + R; y++) for (let x = cx - R; x <= cx + R; x++) for (let z = cz - R; z <= cz + R; z++) {
      const p = new Vec3(x, y, z)
      const b = block(p)
      if (!b) continue
      const oreHit = ores && ores.has(b.name)
      const liq = !oreHit && isLiquid(b) && (b.name === 'lava' || b.name === 'water')
      if (!oreHit && !liq) continue
      const d = e.distanceTo(new Vec3(x + 0.5, y + 0.5, z + 0.5))
      if (d > (oreHit ? radius : liquidRadius) + 1) continue
      if (!exposed(p)) continue                  // an ore with every face buried cannot be seen
      if (!see(b)) continue                      // the ray decides: pockets behind walls do not count either
      if (oreHit) out.ores.push({ block: b, d })
      else out.liquids.push({ block: b, pos: p, d, lava: b.name === 'lava' })
    }
    out.ores.sort((a, b) => a.d - b.d)
    out.liquids.sort((a, b) => a.d - b.d)
    return out
  }

  // A visible liquid close enough to `cell` that digging or standing there is not worth it. lava: 5 blocks, water: 3, anything within 2 of the cell.
  function liquidNear(liquids, cell) {
    const c = new Vec3(cell.x + 0.5, cell.y + 0.5, cell.z + 0.5)
    return liquids.find(l => cheb(l.pos, cell) <= S.cellKeepout || l.pos.offset(0.5, 0.5, 0.5).distanceTo(c) <= (l.lava ? S.lavaKeepout : S.waterKeepout)) || null
  }

  // Can the bot stand on `feet`? Everything is checked on what is in view: headroom, a solid dry floor that can be seen, no sand overhead.
  function standOk(feet) {
    const f = block(feet), h = block(feet.offset(0, 1, 0)), fl = block(feet.offset(0, -1, 0))
    if (!f || !h || !fl) return { ok: false, why: 'unloaded' }
    if (isLiquid(f) || isLiquid(h)) return { ok: false, why: 'liquid' }
    if (!isOpen(f) || !isOpen(h)) return { ok: false, why: 'blocked' }
    if (isLadder(f)) return { ok: true }                      // standing on a ladder needs no floor
    if (isLiquid(fl)) return { ok: false, why: 'liquid-floor' }
    if (!isSolid(fl)) return { ok: false, why: 'no-floor' }
    if (BAD_FLOOR.test(fl.name)) return { ok: false, why: `bad-floor:${fl.name}` }
    const me = bot.entity.position
    const own = Math.floor(me.x) === feet.x && Math.floor(me.y) === feet.y && Math.floor(me.z) === feet.z
    const mc = new Vec3(Math.floor(me.x), Math.floor(me.y + 0.01), Math.floor(me.z))
    const nearFloor = Math.abs(fl.position.x - mc.x) <= 1 && Math.abs(fl.position.z - mc.z) <= 1 && Math.abs(fl.position.y - (mc.y - 1)) <= 1      // the floor beside or under my own cell is always in sight
    if (!own && !nearFloor && !see(fl)) return { ok: false, why: 'floor-not-in-view' }
    const roof = block(feet.offset(0, 2, 0))
    // sand or gravel overhead is not a reason to stop (Walter: dig it, wait for the fall, dig again): the caller lets it fall before stepping in
    return { ok: true, gravelAbove: !!(roof && isGravity(roof) && see(roof)) }
  }

  // How far is the drop under a cell whose floor is missing: the number of non-solid cells below it before something solid (99 = unknown or liquid). A drop of more than 2 is never stepped into.
  function dropUnder(cell) {
    let n = 0
    for (let i = 1; i <= 16; i++) { const b = block(cell.offset(0, -i, 0)); if (!b || isLiquid(b)) return 99; if (isSolid(b)) return n; n++ }
    return 99
  }
  return { available, eye, block, see, look, dropUnder, supportsLadder, exposed, liquidNear, standOk, isLiquid, isLadder, isOpen, isSolid, isNatural, isDiggable, isGravity, cheb, S }
}
module.exports.NATURAL = NATURAL
module.exports.GRAVITY = GRAVITY
