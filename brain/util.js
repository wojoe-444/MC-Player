// Small helpers shared by the brain modules.
const { AbortError } = require('./scheduler')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const dimOf = (bot) => String((bot.game && bot.game.dimension) || '').replace('minecraft:', '')
const fmt = (p) => `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`

// Walk next to `pos` through the existing tryGoto (quiet, never digs). Returns true when within `reach` blocks of the
// block centre afterwards. Aborts promptly when the scheduler cancels/preempts the task (ctx may be null).
async function gotoNear({ bot, goals, tryGoto, ctx, pos, radius = 3, reach = 4.6, label = 'there', ms = 60000, stop }) {
  if (ctx) ctx.checkpoint()
  const center = { x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 }
  const dist = () => bot.entity.position.distanceTo(center)
  if (dist() <= reach) return true    // already within arm's reach: never start a long path search for a chest we can already open
  bot._lastGotoErr = null
  const work = tryGoto(new goals.GoalNear(pos.x, pos.y, pos.z, radius), label, ms)
  let res
  if (ctx) {
    let dispose
    const aborted = new Promise((_, rej) => { dispose = ctx.onAbort(rej) })
    try { res = await Promise.race([work, aborted]) }
    catch (e) { try { stop && stop() } catch {} ; await work.catch(() => {}); throw e }
    finally { dispose() }
  } else res = await work
  ctx && ctx.checkpoint()
  if (res && !res.ok) bot._lastGotoErr = res.err
  return !!(res && res.ok) || dist() <= reach
}

module.exports = { sleep, fmt, gotoNear, dimOf, AbortError }
