// Survival-legit rule (Walter): before breaking, placing or opening anything, there must be a clear line from the bot's eye to the target.
// The server does not check walls for these actions, so we do. Uses bot.world.raycast; if that is missing we cannot verify and do not act.
// If the integrator provides api.canSee, it is used instead of our own ray test.
const { Vec3 } = require('vec3')

const EYE = 1.62
const THICK = 0.08
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]

module.exports = function makeLos({ bot, goals, mover, canSee: external = null, log = () => {} }) {
  const eye = () => bot.entity.position.offset(0, bot.entity.eyeHeight ?? EYE, 0)

  // A ray from `from` to the block centre or to a point just inside the middle of any of its faces; the first thing hit must be the block
  // itself (or nothing, for blocks without collision such as crops). Diagonal corners and one-block walls therefore do not count.
  function clear(from, to, p) {
    const d = to.minus(from), range = d.norm()
    if (range < 1e-6) return true
    let hit
    try { hit = bot.world.raycast(from, d.scaled(1 / range), range) } catch (e) { log(`raycast failed: ${e.message}`); return false }
    return !hit || !!(hit.position && hit.position.equals(p))
  }

  function visibleFrom(from, block) {
    if (!bot.world || typeof bot.world.raycast !== 'function') return false
    const p = block.position
    const samples = [new Vec3(p.x + 0.5, p.y + 0.5, p.z + 0.5)]
    for (const [dx, dy, dz] of FACES) samples.push(new Vec3(p.x + 0.5 + dx * 0.45, p.y + 0.5 + dy * 0.45, p.z + 0.5 + dz * 0.45))
    for (const s of samples) {
      const d = s.minus(from), range = d.norm()
      if (range < 1e-6) return true
      const dir = d.scaled(1 / range)
      // a thin ray can slip exactly through the corner where two blocks touch diagonally, so the ray is thickened: it must also be clear
      // when shifted a little to every side (tight peeks around corners do not count)
      const up = Math.abs(dir.y) > 0.95 ? new Vec3(1, 0, 0) : new Vec3(0, 1, 0)
      const u = dir.cross(up).normalize(), v = dir.cross(u).normalize()
      const origins = [from, ...[[1, 0], [-1, 0], [0, 1], [0, -1]].map(([a, b]) => from.plus(u.scaled(a * THICK)).plus(v.scaled(b * THICK)))]
      if (origins.every(o => clear(o, s, p))) return true
    }
    return false
  }
  const canSee = (block) => (external ? !!external(block) : visibleFrom(eye(), block))

  // Reposition until the block is in plain view, or give up (false). Nothing is touched here.
  async function ensure(ctx, block, label = 'a better spot') {
    if (canSee(block)) return true
    const p = block.position
    if (goals && goals.GoalLookAtBlock) {
      try { await mover.goto(ctx, new goals.GoalLookAtBlock(p, bot.world, { reach: 4 }), label, 20000) } catch (e) { if (e && e.name === 'AbortError') throw e }
      if (canSee(block)) return true
    }
    for (const r of [2, 1]) {
      try { await mover.near(ctx, p, r, label, 20000) } catch (e) { if (e && e.name === 'AbortError') throw e }
      if (canSee(block)) return true
    }
    return false
  }

  return { canSee, ensure, visibleFrom, eye }
}
