// Abortable movement for the routines. Every walk first makes the hand safe (Walter's rule: never move holding lava).
const { gotoNear } = require('../util')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

module.exports = function makeMover({ bot, goals, tryGoto, safehand, stopNav = () => {} }) {
  const halt = () => { try { stopNav() } catch {} }

  // Walk onto / next to a position. Throws AbortError when the scheduler stops the task. Resolves {ok, err}.
  async function goto(ctx, goal, label, ms = 30000) {
    ctx && ctx.checkpoint()
    await safehand.ensureSafeForMove()
    const work = Promise.resolve(tryGoto(goal, label, ms))
    let res
    if (ctx) {
      let dispose
      const aborted = new Promise((_, rej) => { dispose = ctx.onAbort(rej) })
      try { res = await Promise.race([work, aborted]) }
      catch (e) { halt(); await Promise.race([work.catch(() => {}), sleep(2000)]); throw e }
      finally { dispose() }
      ctx.checkpoint()
    } else res = await work
    return res || { ok: false, err: 'no result' }
  }

  // Walk next to a block (chests, beds). true when within reach afterwards.
  async function near(ctx, pos, radius, label, ms = 60000) {
    await safehand.ensureSafeForMove()
    return gotoNear({ bot, goals, tryGoto, ctx, pos, radius, label, ms, stop: stopNav })
  }

  return { goto, near, halt }
}
