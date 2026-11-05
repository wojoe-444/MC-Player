// Getting out of the mine (Walter: "put a block under the ladder", "pillaring up with cobble is a fallback"): a bot that is deep underground must never be
// stranded. leaveMine() brings it back to the top of the ladder shaft, in this order:
//   1. already in the shaft column -> climb the ladders directly (jump held while on the ladder), not through the pathfinder;
//   2. walk to the shaft's ladders (nav pathfinder; over open ground and through our own hallways);
//   3. cut off (no way found, e.g. a pit or cave beyond a ledge): dig a 1x2 hallway at the bot's own level straight to the shaft column and
//      enter the ladder from the side. Every cell goes through the usual checks (filler only, nothing next to visible liquid, floor in view);
//   4. below the lowest ladder: first rise to it with stairs up, else pillar up (dig the cell above the head, jump, put a cobblestone under the feet).
// Walter allowed placing blocks for this. The only things ever placed here are cobblestone steps while pillaring.
const { Vec3 } = require('vec3')

module.exports = function createExit({ bot, sight, goals, mover, torches, shaft, say, state, save, SC, log, E }) {
  const { Pause, floorVec } = E
  const XC = { belowY: 100, maxTunnel: 120, maxPillar: 40, climbMs: 4 * 60000, ...(SC.exit || {}) }
  const sleepMs = (ctx, ms) => (ctx ? ctx.sleep(ms) : new Promise(r => setTimeout(r, ms)))
  const cellOf = () => floorVec(bot.entity.position)
  const top = () => shaft.top()
  const inColumn = (c) => c.x === top().x && c.z === top().z
  const releaseKeys = () => { try { bot.setControlState('jump', false); bot.setControlState('forward', false); bot.setControlState('sneak', false) } catch {} }

  // ---------- 1. the ladders themselves ----------
  async function climb(ctx, targetY = null) {
    const t = top()
    const goalY = targetY === null ? t.y - 0.2 : targetY
    const start = Date.now()
    let lastY = bot.entity.position.y, lastMove = Date.now(), pushed = false
    await E.safe()
    try {
      while (bot.entity.position.y < goalY) {
        ctx.checkpoint()
        if (Date.now() - start > XC.climbMs) throw new Pause('park', 'The ladder climb is taking too long; stopping.')
        const c = cellOf()
        if (!inColumn(c)) throw new Pause('park', 'I slipped off the shaft ladders while climbing. Stopping.')
        const here = sight.block(c)
        if (!here || !sight.isLadder(here)) throw new Pause('park', 'There is no ladder under me in the shaft. Stopping.')
        bot.setControlState('jump', true)
        await sleepMs(ctx, 250)
        const y = bot.entity.position.y
        if (y > lastY + 0.05) { lastY = y; lastMove = Date.now(); pushed = false }
        else if (Date.now() - lastMove > 2500 && !pushed) {              // not climbing: face the wall the ladder hangs on and push into it
          const info = shaft.ladderInfo(here)
          if (info) { try { await bot.lookAt(new Vec3(c.x + 0.5 + info.back.x, c.y + 1.0, c.z + 0.5 + info.back.z)) } catch {} }
          bot.setControlState('forward', true); pushed = true
        } else if (Date.now() - lastMove > 12000) throw new Pause('park', 'I cannot climb this ladder (no progress for 12 s). Stopping.')
      }
    } finally { releaseKeys() }
    if (targetY !== null) { try { bot.setControlState('sneak', true) } catch {} }          // stay on that rung (a ladder with no key pressed slides down)
    return true
  }

  // ---------- 3. a hallway to the shaft ----------
  async function tunnel(ctx) {
    const t = top()
    let cur = cellOf(), steps = 0
    const orders = [['x', 'z'], ['z', 'x']].sort((a, b) => Math.abs(t[b[0]] - cur[b[0]]) - Math.abs(t[a[0]] - cur[a[0]]))
    for (const order of orders) {
      let blocked = null
      cur = cellOf()
      for (const axis of order) {
        while (cur[axis] !== t[axis]) {
          ctx.checkpoint()
          if (++steps > XC.maxTunnel) throw new Pause('park', 'The hallway to the shaft is getting too long; stopping.')
          const next = cur.clone(); next[axis] += Math.sign(t[axis] - cur[axis])
          const r = await E.extendOne(ctx, cur, next, { intoLadder: true })
          if (!r.ok) { blocked = r.stop; break }
          cur = next
        }
        if (blocked) break
      }
      if (!blocked && inColumn(cur)) return true
      log(`exit: tunnel ${order.join('')} blocked (${blocked}); ${orders.indexOf(order) === 0 ? 'trying the other way round' : 'giving up'}`)
      if (blocked === 'liquid') return false
    }
    return false
  }

  // ---------- 4. up to the lowest ladder ----------
  async function pillarUp(ctx, toY) {
    for (let i = 0; i < XC.maxPillar; i++) {
      ctx.checkpoint()
      const feet = cellOf()
      if (feet.y >= toY) return true
      const above = feet.offset(0, 2, 0)
      const b = sight.block(above)
      if (!b) throw new Pause('park', 'The rock above me is not loaded; stopping the climb.')
      if (!sight.isOpen(b)) {                                            // dig the cell over the head first (filler only, never beside liquid, protection applies)
        const r = await E.clearCell(ctx, above)
        if (r.stop) { log(`exit: pillar blocked above (${r.stop})`); return false }
      }
      if (E.hazardAt(feet.offset(0, 1, 0))) { log('exit: liquid in view above while pillaring'); return false }
      const floor = sight.block(feet.offset(0, -1, 0))
      if (!floor || !sight.isSolid(floor)) return false
      bot.setControlState('jump', true)
      const t0 = Date.now()
      while (bot.entity.position.y < feet.y + 0.99 && Date.now() - t0 < 1200) await sleepMs(ctx, 40)
      const r = await torches.placeSupport(ctx, floor, new Vec3(0, 1, 0))
      releaseKeys()
      if (!r.ok) { log(`exit: could not put a step down (${r.why})`); return false }
      const t1 = Date.now()
      while (cellOf().y < feet.y + 1 && Date.now() - t1 < 1500) await sleepMs(ctx, 40)
      if (cellOf().y < feet.y + 1) return false
    }
    return cellOf().y >= toY
  }
  async function riseTo(ctx, toY) {
    const start = cellOf()
    if (start.y >= toY) return true
    try {
      const t = top()
      const dir = Math.abs(t.x - start.x) >= Math.abs(t.z - start.z) ? [Math.sign(t.x - start.x) || 1, 0] : [0, Math.sign(t.z - start.z) || 1]
      await E.stairs(ctx, toY, dir)
      if (cellOf().y >= toY) return true
    } catch (e) { if (e && e.name === 'AbortError') throw e; log(`exit: stairs up failed (${e && e.message})`) }
    return pillarUp(ctx, toY)
  }

  // ---------- the whole way ----------
  async function leaveMine(ctx, { announce = true } = {}) {
    if (!SC.enabled || !SC.top) return { ok: false, how: 'no shaft is configured' }
    const t = top()
    let here = cellOf()
    if (here.y >= t.y - 1) return { ok: true, how: 'already at the top' }
    if (announce) say('Leaving the mine: back up the ladder shaft.')
    state.leaving = true; save()
    try {
      await E.safe()
      // the ladders may be out of loaded range: walk towards the shaft first (nav)
      let bo = shaft.bottom()
      if (!inColumn(here)) {
        if (bo) {
          const y = Math.max(bo.y, Math.min(here.y, t.y))
          const ladder = new Vec3(t.x, y, t.z)
          const ok = here.y >= bo.y && await E.travel(ctx, { x: ladder.x, y: ladder.y, z: ladder.z }, { exact: true, name: null })
          if (!ok) {
            log('exit: no walkable way to the shaft; cutting a hallway to it')
            if (here.y < bo.y) { if (!(await riseTo(ctx, bo.y))) return { ok: false, how: 'I could not rise to the bottom of the ladder' } }
            if (!(await tunnel(ctx))) {
              if (!(await pillarUp(ctx, cellOf().y + 1))) return { ok: false, how: 'the hallway to the shaft is blocked' }
              if (!(await tunnel(ctx))) return { ok: false, how: 'the hallway to the shaft is blocked' }
            }
          }
        } else {
          const ok = await E.travel(ctx, { x: t.x, y: t.y, z: t.z }, { exact: true, name: SC.waypoint })      // too far to see the ladders: let nav bring us back
          if (!ok) return { ok: false, how: 'no way back to the shaft found' }
          return { ok: true, how: 'walked' }
        }
      }
      here = cellOf()
      if (!inColumn(here)) return { ok: false, how: 'not in the shaft column' }
      bo = shaft.bottom()
      if (bo && here.y < bo.y) { if (!(await riseTo(ctx, bo.y))) return { ok: false, how: 'below the lowest ladder' } }
      await climb(ctx)
      return { ok: true, how: 'climbed' }
    } finally { releaseKeys(); state.leaving = false; save() }
  }

  return { leaveMine, climb, climbTo: (ctx, y) => climb(ctx, y), tunnel, pillarUp, riseTo, belowSurface: () => bot.entity.position.y < XC.belowY, XC }
}
