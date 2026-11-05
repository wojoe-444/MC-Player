// Line of sight (Walter's "survival-legit" rule): before a container open, block interaction, attack or shot there must be a
// clear ray from the bot's eye to the target, as if the crosshair could point at it. Shared by every module through
// api.canSee / api.ensureLineOfSight (brain/index.js); join.js has its own guard around bot.attack.
const { Vec3 } = require('vec3')

const EYE = 1.62

const isBlockLike = (t) => t instanceof Vec3 || (t && 'boundingBox' in t)   // blocks carry a boundingBox, entities do not
const eyeOf = (bot, at) => { const p = at || bot.entity.position; return new Vec3(p.x, p.y + EYE, p.z) }

// First block on the segment from -> to, or null when the way is clear.
function firstBlock(bot, from, to) {
  const d = to.minus(from), dist = d.norm()
  if (dist < 1e-6) return null
  return bot.world.raycast(from, d.scaled(1 / dist), dist) || null
}

// Can an eye at `eye` see (part of) the block at `pos`? True when a ray to the block centre or to a point just inside any face
// reaches that block first (a hopper or wall in front of a chest blocks it, like it blocks a real click).
function blockVisibleFrom(bot, eye, pos) {
  const c = new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5)
  const pts = [c]
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) pts.push(c.offset(dx * 0.45, dy * 0.45, dz * 0.45))
  for (const p of pts) {
    const hit = firstBlock(bot, eye, p)
    if (!hit || (hit.position && hit.position.x === pos.x && hit.position.y === pos.y && hit.position.z === pos.z)) return true
  }
  return false
}

// target: an entity ({position, height}), a block ({position, name}) or a Vec3 block position.
function canSee(bot, target, at) {
  if (!target) return false
  const eye = eyeOf(bot, at)
  if (isBlockLike(target)) return blockVisibleFrom(bot, eye, target.position || target)
  const p = target.position, h = target.height || 1.8
  for (const y of [0.1, h * 0.5, h * 0.9]) {
    if (!firstBlock(bot, eye, new Vec3(p.x, p.y + y, p.z))) return true
  }
  return false
}

// Standable cells (solid below, two empty above) near a block from which it can be seen within arm's reach.
function viewpoints(bot, pos, { reach = 4.2, max = 6 } = {}) {
  const out = [], c = new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5), me = bot.entity.position
  for (let dx = -4; dx <= 4; dx++) for (let dy = -4; dy <= 2; dy++) for (let dz = -4; dz <= 4; dz++) {
    const f = new Vec3(Math.floor(pos.x) + dx, Math.floor(pos.y) + dy, Math.floor(pos.z) + dz)
    const feet = bot.blockAt(f), head = bot.blockAt(f.offset(0, 1, 0)), floor = bot.blockAt(f.offset(0, -1, 0))
    if (!feet || !head || !floor) continue
    if (feet.boundingBox !== 'empty' || head.boundingBox !== 'empty' || floor.boundingBox === 'empty') continue
    const stand = new Vec3(f.x + 0.5, f.y, f.z + 0.5)
    if (eyeOf(bot, stand).distanceTo(c) > reach) continue
    if (!blockVisibleFrom(bot, eyeOf(bot, stand), pos)) continue
    out.push({ f, d: stand.distanceTo(me) })
  }
  return out.sort((a, b) => a.d - b.d).slice(0, max).map(o => o.f)
}

// Make sure `target` can be seen. For blocks it walks to a viewpoint if needed; for entities it only reports (the caller
// repositions). Returns true/false; never throws except for task aborts coming from tryGoto/ctx.
async function ensureLineOfSight({ bot, goals, tryGoto, ctx, target, label = 'a spot with a clear view', stop }) {
  if (canSee(bot, target)) return true
  const pos = target.position || target
  if (!isBlockLike(target)) return false
  for (const f of viewpoints(bot, pos)) {
    if (ctx) ctx.checkpoint()
    const res = await tryGoto(new goals.GoalBlock(f.x, f.y, f.z), label, 20000)
    if (ctx) ctx.checkpoint()
    if ((res && res.ok) || bot.entity.position.distanceTo(new Vec3(f.x + 0.5, f.y, f.z + 0.5)) < 1.2) { if (canSee(bot, target)) return true }
  }
  return canSee(bot, target)
}

module.exports = { canSee, ensureLineOfSight, viewpoints, blockVisibleFrom, eyeOf, EYE }
