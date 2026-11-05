// brain/pilot-kit/place.js: place a block at a cell from whichever face works, walking closer when needed.
//   const r = await placeAnyFace(bot, { pos: {x,y,z}, item: 'cobblestone', goals, approach: true })   -> { ok, note, face, tried, walked }
//
// Order tried: below the target (a block under it), then the four sides, then above. For each solid, non-liquid neighbour: if it cannot
// be reached or seen from here, walk to within 3 blocks (only when `approach`, never digging: it uses the Movements already set on the
// bot), look at the target, place. mineflayer's placeBlock sometimes reports a timeout although the block went down, so the world is
// checked before the next face is tried. Honest play: only neighbours the bot can see are used; it never places through walls.
const { Vec3 } = require('vec3')
const sight = require('./sight')

const FACES = [
  { name: 'below', ref: [0, -1, 0], face: [0, 1, 0] },    // reference block sits under the target; click its top face
  { name: 'north', ref: [0, 0, -1], face: [0, 0, 1] },
  { name: 'south', ref: [0, 0, 1], face: [0, 0, -1] },
  { name: 'east', ref: [1, 0, 0], face: [-1, 0, 0] },
  { name: 'west', ref: [-1, 0, 0], face: [1, 0, 0] },
  { name: 'above', ref: [0, 1, 0], face: [0, -1, 0] }
]
const EMPTY = new Set(['air', 'cave_air', 'void_air', 'water', 'lava', 'short_grass', 'tall_grass', 'fire', 'snow'])
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function placeAnyFace(bot, o) {
  const target = new Vec3(Math.floor(o.pos.x), Math.floor(o.pos.y), Math.floor(o.pos.z))
  const out = { ok: false, note: '', face: null, tried: [], walked: false, errors: [] }
  const fail = (code, note) => { out.note = note; out.error = { code, message: note }; return out }

  const here = bot.blockAt(target)
  if (!here) return fail('NO_PATH', 'target cell is not loaded')
  if (!EMPTY.has(here.name)) return fail('FAILED', `cell already holds ${here.name}`)
  const feet = bot.entity.position.floored()
  if (target.equals(feet) || target.equals(feet.offset(0, 1, 0))) return fail('FAILED', 'target is where the bot stands')

  if (o.item) {
    const it = bot.inventory.items().find(i => i.name === o.item)
    if (!it) return fail('NO_ITEM', `no ${o.item} in the bag`)
    try { await bot.equip(it, 'hand') } catch (e) { return fail('FAILED', `cannot hold ${o.item}: ${e.message}`) }
  }
  if (!bot.heldItem) return fail('NO_ITEM', 'nothing in hand to place')

  const goalsLib = o.goals
  for (const f of FACES) {
    const refPos = target.plus(new Vec3(...f.ref))
    const ref = bot.blockAt(refPos)
    if (!ref || EMPTY.has(ref.name) || ref.boundingBox === 'empty') continue
    out.tried.push(f.name)
    const far = bot.entity.position.distanceTo(refPos.offset(0.5, 0.5, 0.5)) > 4.4
    let visible = !far
    if (visible) visible = sight.blockVisible(bot, refPos)
    if (!visible) {
      if (!o.approach || !goalsLib || !bot.pathfinder) continue
      try {
        await bot.pathfinder.goto(new goalsLib.GoalNear(refPos.x, refPos.y, refPos.z, 3))
        out.walked = true
      } catch (e) { continue }
      if (!sight.blockVisible(bot, refPos)) continue
    }
    try { await bot.lookAt(target.offset(0.5, 0.5, 0.5), true) } catch (e) {}
    try {
      await bot.placeBlock(ref, new Vec3(...f.face))
    } catch (e) {
      out.errors.push(`${f.name}: ${e.message}`)
      await sleep(250)   // the server may still be applying it
    }
    await sleep(120)
    const after = bot.blockAt(target)
    if (after && !EMPTY.has(after.name)) { out.ok = true; out.face = f.name; out.note = `placed ${after.name} at ${target.x},${target.y},${target.z} from ${f.name}`; return out }
  }
  return fail(out.tried.length ? 'FAILED' : 'NO_PATH', out.tried.length ? `could not place from ${out.tried.join(', ')}${out.errors.length ? ' (' + out.errors[out.errors.length - 1] + ')' : ''}` : 'no solid neighbour to place against')
}

module.exports = { placeAnyFace, FACES }
module.exports.meta = { name: 'place', version: 1 }
