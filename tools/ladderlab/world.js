// Ladder lab world: test/nav.helpers.js makeSim (real prismarine blocks + real prismarine-physics, virtual time, no server, no sockets) plus
// the pieces a ladder BUILDER needs and the nav tests switch off: an inventory, bot.placeBlock and bot.dig with the vanilla rules that matter here.
//   placeBlock(ref, face)  the target cell must be empty and within reach (4.5 from the eye to the face centre), the eye must have a clear ray
//                          to the face (line of sight, Walter's rule 1), a ladder needs a FULL solid block behind it and a horizontal face,
//                          a solid block may not be put where the player stands; each placement is logged with the tick (sim.placed)
//   dig(block)             reach + line of sight, takes ticks by block hardness, returns the drop to the inventory (sim.dug)
// It is a model, not the game: it is only as right as these rules and prismarine-physics.
const { Vec3 } = require('vec3')
const H = require('../../test/nav.helpers')

const FACE_DIRS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }
const dirFacing = (dx, dz) => Object.keys(FACE_DIRS).find(k => FACE_DIRS[k][0] === dx && FACE_DIRS[k][1] === dz)
const DROP = { stone: 'cobblestone', cobblestone: 'cobblestone', dirt: 'dirt', grass_block: 'dirt', deepslate: 'cobbled_deepslate', ladder: 'ladder' }
const HARD = { stone: 1.5, cobblestone: 2, dirt: 0.5, grass_block: 0.6, deepslate: 3, ladder: 0.4, oak_planks: 2, andesite: 1.5, gravel: 0.6 }
const PICK_NEEDED = /^(stone|cobblestone|deepslate|andesite)$/

function makeLab(opts = {}) {
  const sim = H.makeSim({ bounds: { x0: -20, x1: 40, y0: 0, y1: 120, z0: -20, z1: 40 }, ...opts })
  const bot = sim.bot, mcData = H.mcData
  sim.placed = []; sim.dug = []; sim.refused = []
  // ---- inventory ----
  const items = []
  const find = (n) => items.find(i => i.name === n)
  bot.inventory = { slots: [], items: () => items.filter(i => i.count > 0) }
  sim.give = (name, count = 1) => { let it = find(name); if (!it) { it = { name, count: 0, type: (mcData.itemsByName[name] || {}).id, stackSize: 64 }; items.push(it) } it.count += count; return it }
  sim.count = (name) => (find(name) || { count: 0 }).count
  sim.inv = () => Object.fromEntries(items.filter(i => i.count > 0).map(i => [i.name, i.count]))
  for (const [n, c] of Object.entries(opts.inv || {})) sim.give(n, c)
  bot.equip = async (item) => { bot.heldItem = typeof item === 'string' ? find(item) : item; bot.emit('heldItemChanged', bot.heldItem) }

  const eye = () => bot.entity.position.offset(0, 1.62, 0)
  // is the ray eye -> point blocked by a collision shape before reaching `target` cell?
  const rayHit = (to, targetCell) => {
    const from = eye(), d = to.minus(from), len = d.norm(), dir = d.scaled(1 / len)
    const hit = bot.world.raycast(from, dir, len + 0.01)
    return !hit || (hit.position.x === targetCell.x && hit.position.y === targetCell.y && hit.position.z === targetCell.z)
  }
  const refuse = (why, extra = {}) => { sim.refused.push({ tick: sim.ticks, why, ...extra }); throw new Error('refused: ' + why) }
  const aabbOverlapsCell = (c) => {
    const p = bot.entity.position
    return p.x - 0.3 < c.x + 1 && p.x + 0.3 > c.x && p.y < c.y + 1 && p.y + 1.8 > c.y && p.z - 0.3 < c.z + 1 && p.z + 0.3 > c.z
  }
  const isAir = (b) => !b || b.name === 'air' || b.name === 'cave_air'
  const fullSolid = (b) => b && b.shapes && b.shapes.length === 1 && b.shapes[0].join() === '0,0,0,1,1,1'

  bot.placeBlock = async (ref, face) => {
    const held = bot.heldItem
    if (!held || held.count <= 0) refuse('nothing-in-hand')
    const target = ref.position.plus(face)
    if (!isAir(bot.blockAt(target))) refuse('cell-not-empty', { at: target.toString() })
    const faceC = ref.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5)
    if (eye().distanceTo(faceC) > 4.5) refuse('out-of-reach', { d: +eye().distanceTo(faceC).toFixed(2) })
    if (!rayHit(faceC.minus(face.scaled(0.01)), ref.position)) refuse('no-line-of-sight', { at: ref.position.toString() })
    const name = held.name
    if (name === 'ladder') {
      if (face.y !== 0) refuse('ladder-needs-a-side-face')
      if (!fullSolid(ref)) refuse('ladder-needs-a-full-block-behind', { ref: ref.name })
      sim.set(target.x, target.y, target.z, 'ladder', { facing: dirFacing(face.x, face.z), waterlogged: false })
    } else {
      const b = mcData.blocksByName[name]
      if (!b) refuse('not-a-block:' + name)
      if (aabbOverlapsCell(target)) refuse('player-in-the-way', { at: target.toString() })
      sim.set(target.x, target.y, target.z, name)
    }
    held.count--
    sim.placed.push({ tick: sim.ticks, name, at: [target.x, target.y, target.z] })
    bot.emit('blockUpdate', null, bot.blockAt(target))
  }

  bot.canDigBlock = (b) => !!b && b.name !== 'air' && b.name !== 'bedrock' && eye().distanceTo(b.position.offset(0.5, 0.5, 0.5)) <= 4.5
  bot.dig = async (b) => {
    if (!bot.canDigBlock(b)) refuse('cannot-dig', { at: b.position.toString() })
    if (!rayHit(b.position.offset(0.5, 0.5, 0.5), b.position)) refuse('dig-no-line-of-sight', { at: b.position.toString() })
    const hand = bot.heldItem
    const pick = hand && /pickaxe/.test(hand.name)
    const ticks = Math.ceil((HARD[b.name] || 1) * (PICK_NEEDED.test(b.name) && !pick ? 5 * 5 : 5) * 1.5 / (pick ? 4 : 1))
    for (let i = 0; i < ticks; i++) await new Promise(r => { const f = () => r(); bot.once('physicsTick', f) })
    const at = b.position
    sim.clear(at.x, at.y, at.z)
    sim.dug.push({ tick: sim.ticks, name: b.name, at: [at.x, at.y, at.z] })
    const drop = DROP[b.name]; if (drop && (!PICK_NEEDED.test(b.name) || pick)) sim.give(drop, 1)
    bot.emit('blockUpdate', null, bot.blockAt(at))
  }
  sim.stoneCols = () => {}
  return sim
}

// ---- a tiny scenario DSL ----
// Ground at y=63 (stone) so the standing level is 64. A "column" is (x,z) with the wall behind it on `wall` (the side the ladder is mounted on).
const WALL = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }   // key = direction FROM the ladder cell TO its wall
const FACE_OF_WALL = { north: 'south', south: 'north', east: 'west', west: 'east' } // ladder `facing` = away from the wall

module.exports = { makeLab, WALL, FACE_OF_WALL, dirFacing, FACE_DIRS, H }
