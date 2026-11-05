// brain/pilot-kit/sight.js: honest line-of-sight helpers (a ray from the eyes with nothing solid in between). No seeing through walls.
// bot.canSeeBlock is not used: it measures the range to a block's corner and often answers "no" for blocks plainly in view.
const EYE = 1.62
const OFF = [[0.5, 0.5, 0.5], [0.5, 0.97, 0.5], [0.5, 0.03, 0.5], [0.97, 0.5, 0.5], [0.03, 0.5, 0.5], [0.5, 0.5, 0.97], [0.5, 0.5, 0.03]]

const eyePos = (bot) => bot.entity.position.offset(0, EYE, 0)

// first solid thing between the eyes and `point`, or null when the way is clear
function firstHit(bot, point) {
  const eye = eyePos(bot), d = point.minus(eye), dist = d.norm()
  if (dist < 0.05) return null
  try { return bot.world.raycast(eye, d.scaled(1 / dist), dist) } catch (e) { return null }
}

// can the bot see this point (an entity, a spot in the air)?
const pointVisible = (bot, point) => !firstHit(bot, point)

// what does the bot see of the cell at `pos`? 'near' (too close to test), 'air' (open space in view), 'solid' (a block face in view), 'hidden'
function cellView(bot, pos) {
  const eye = eyePos(bot)
  let anySolid = false
  for (const [ox, oy, oz] of OFF) {
    const c = pos.offset(ox, oy, oz), d = c.minus(eye), dist = d.norm()
    if (dist < 0.8) return 'near'
    let hit = null
    try { hit = bot.world.raycast(eye, d.scaled(1 / dist), dist + 0.01) } catch (e) { return 'near' }
    if (!hit) return 'air'
    if (hit.position.equals(pos)) anySolid = true
    if (anySolid) return 'solid'
  }
  return 'hidden'
}

// is the block at `pos` in view (a face of it can be reached by a ray)?
const blockVisible = (bot, pos) => { const v = cellView(bot, pos); return v === 'solid' || v === 'near' }

module.exports = { eyePos, firstHit, pointVisible, cellView, blockVisible, EYE }
module.exports.meta = { name: 'sight', version: 1 }
