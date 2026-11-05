// Placing, limited to what Walter authorized (2026-10-26): torches, a work-site chest for long jobs (his "haul at the end" rule), the ladders of the
// shaft he asked to extend, and a cobblestone support block in that shaft (a backing wall for a ladder, a block under its foot, a pillar step to get out).
// Line of sight to the block the item stands on, every placement logged. Shared by brain/lighting (dark spots on the routes the bot walks) and brain/mining (hallways).
//
//   const t = createTorches({ bot, canSee, log })
//   t.count()                 torches in the bag
//   t.lightOf(cell)           block light at a cell (null when the server sent none)
//   t.floorOk(floorBlock, aboveBlock)   a plain solid floor with air above it
//   t.torchNear(cell, r)      is there already a torch within r blocks
//   await t.place(ctx, floorBlock)      torch on top of floorBlock: { ok } | { ok:false, why }
//   await t.placeChest(ctx, floorBlock) the work-site chest on top of floorBlock (same rules, never next to another chest)
//   await t.placeLadder(ctx, wall, face) / t.placeSupport(ctx, ref, face)   shaft ladder / cobblestone support against `face` of `ref`; the thin ladder panels of the shaft itself do not count as a wall in the way
// Nothing else is ever placed. Without a clear ray to the floor block nothing is placed.
const { Vec3 } = require('vec3')

const TORCH = /^(torch|wall_torch|soul_torch|soul_wall_torch)$/
const DENY = /(farmland|dirt_path|soul_sand|soul_soil|glass|ice|leaves|slab|stairs|fence|_wall$|gate|trapdoor|door|carpet|snow|cactus|chest|barrel|hopper|bed$|rail|water|lava|magma|honey|slime|sculk|cauldron|composter|lectern|pot|campfire|torch|lantern|sign|button|plate|piston|bamboo|vine|ladder|scaffolding|pickle|kelp|seagrass|lily|cake|anvil|table|grindstone|stonecutter|loom|furnace|smoker|brewing|bell|head|skull|banner|candle|coral|moss_carpet|powder_snow|bubble|spawner|portal|end_rod|conduit|beacon|amethyst_cluster|dripstone|farm)/
const AIR = /^(air|cave_air|void_air)$/
const key = (p) => `${p.x},${p.y},${p.z}`

module.exports = function createTorches({ bot, canSee = null, log = () => {}, now = Date.now, eyeHeight = 1.62, reach = 4.5, sleep = (ms) => new Promise(r => setTimeout(r, ms)) }) {
  const count = () => bot.inventory.items().filter(i => i.name === 'torch').reduce((s, i) => s + i.count, 0)
  const blockAt = (p) => { try { return bot.blockAt(p instanceof Vec3 ? p : new Vec3(p.x, p.y, p.z)) || null } catch { return null } }
  const lightOf = (cell) => { const b = blockAt(cell); return b && typeof b.light === 'number' ? b.light : null }

  // plain solid full block with air above (crops, rails, doors, fluids and containers are left alone)
  function floorOk(floor, above) {
    if (!floor || !above) return false
    if (floor.boundingBox !== 'block' || DENY.test(floor.name)) return false
    return AIR.test(above.name)
  }
  function torchNear(cell, r = 3) {
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
      const b = blockAt(new Vec3(cell.x + dx, cell.y + dy, cell.z + dz))
      if (b && TORCH.test(b.name)) return true
    }
    return false
  }
  const eye = () => bot.entity.position.offset(0, eyeHeight, 0)

  // the one place where anything is put down: `item` against the `face` of `ref`. The bot must see that block and be within reach; nothing here moves the bot.
  async function placeAgainst(ctx, ref, face, item, isIt) {
    const dest = ref.position.plus(face)
    ctx && ctx.checkpoint()
    const have = bot.inventory.items().find(i => i.name === item)
    try {
      if (!bot.heldItem || bot.heldItem.name !== item) await bot.equip(have, 'hand')
      await bot.placeBlock(ref, face)
    } catch (e) {
      // placeBlock often reports a timeout although the block went down: look before giving up (same as the farm's replant)
      log(`placeBlock ${key(dest)}: ${e.message}`)
    }
    for (let i = 0; i < 6; i++) {
      const b = blockAt(dest)
      if (b && isIt.test(b.name)) { log(`${item.toUpperCase()} placed at ${key(dest)} on ${ref.name}`); return { ok: true, at: dest } }
      await sleep(80)
    }
    return { ok: false, why: 'not-placed' }
  }
  // can the eye see `ref` when ladders (the thin panels of our own shaft) are not counted as obstacles? Same sampling as brain/los.js: the centre and a point just inside each face
  function seeThroughLadders(ref) {
    const p = ref.position, e = eye(), c = new Vec3(p.x + 0.5, p.y + 0.5, p.z + 0.5)
    const pts = [c]
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) pts.push(c.offset(dx * 0.45, dy * 0.45, dz * 0.45))
    const solid = (b) => b.boundingBox === 'block' && b.name !== 'ladder'
    for (const t of pts) {
      const d = t.minus(e), r = d.norm()
      if (r < 1e-6) return true
      let hit = null
      try { hit = bot.world.raycast(e, d.scaled(1 / r), r, solid) } catch { return false }
      if (!hit || (hit.position && hit.position.equals(p))) return true
    }
    return false
  }
  const viewOk = (ref, spot, throughLadders = false) => {
    if (!bot.world || typeof bot.world.raycast !== 'function') return { ok: false, why: 'cannot-verify-view' }
    if (!(throughLadders ? seeThroughLadders(ref) : (canSee ? canSee(ref) : false))) return { ok: false, why: 'no-line-of-sight' }
    if (eye().distanceTo(spot) > reach) return { ok: false, why: 'out-of-reach' }
    return { ok: true }
  }
  // `item` on the top face of `floor` (torch, work-site chest)
  async function placeOn(ctx, floor, item, isIt) {
    if (!floor) return { ok: false, why: 'no-block' }
    if (!bot.inventory.items().find(i => i.name === item)) return { ok: false, why: item === 'torch' ? 'no-torches' : `no-${item}` }
    const above = blockAt(floor.position.offset(0, 1, 0))
    if (!floorOk(floor, above)) return { ok: false, why: 'bad-floor' }
    const v = viewOk(floor, floor.position.offset(0.5, 1, 0.5))
    if (!v.ok) return v
    return placeAgainst(ctx, floor, new Vec3(0, 1, 0), item, isIt)
  }
  // a ladder in the shaft cell in front of `wall` (face = the horizontal direction from the wall into the shaft)
  async function placeLadder(ctx, wall, face) {
    if (!wall) return { ok: false, why: 'no-wall' }
    if (!bot.inventory.items().find(i => i.name === 'ladder')) return { ok: false, why: 'no-ladders' }
    if (wall.boundingBox !== 'block' || DENY.test(wall.name) || face.y !== 0 || Math.abs(face.x) + Math.abs(face.z) !== 1) return { ok: false, why: 'bad-wall' }
    const dest = blockAt(wall.position.plus(face))
    if (!dest || !AIR.test(dest.name)) return { ok: false, why: 'cell-not-empty' }
    const v = viewOk(wall, wall.position.offset(0.5 + face.x * 0.5, 0.5, 0.5 + face.z * 0.5), true)
    if (!v.ok) return v
    return placeAgainst(ctx, wall, face, 'ladder', /^ladder$/)
  }
  // cobblestone against `face` of `ref` (the cell in front of that face must be empty)
  async function placeSupport(ctx, ref, face) {
    if (!ref) return { ok: false, why: 'no-block' }
    if (!bot.inventory.items().find(i => i.name === 'cobblestone')) return { ok: false, why: 'no-cobblestone' }
    if (ref.boundingBox !== 'block' || DENY.test(ref.name)) return { ok: false, why: 'bad-support-wall' }
    const dest = blockAt(ref.position.plus(face))
    if (!dest || !AIR.test(dest.name)) return { ok: false, why: 'cell-not-empty' }
    const v = viewOk(ref, ref.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5), true)
    if (!v.ok) return v
    return placeAgainst(ctx, ref, face, 'cobblestone', /^cobblestone$/)
  }
  const place = (ctx, floor) => placeOn(ctx, floor, 'torch', TORCH)
  // the work-site chest: a single chest (never joined to another one, so the ledger stays simple)
  function placeChest(ctx, floor) {
    if (floor) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const n = blockAt(floor.position.offset(dx, 1, dz)); if (n && /chest/.test(n.name)) return Promise.resolve({ ok: false, why: 'next-to-a-chest' }) }
    return placeOn(ctx, floor, 'chest', /^chest$/)
  }

  return { count, lightOf, floorOk, torchNear, place, placeChest, placeLadder, placeSupport, seeThroughLadders, TORCH }
}
module.exports.TORCH = TORCH
module.exports.DENY = DENY
