// Mine off Walter's ladder shaft (his go, 2026-10-26): the shaft at about -1042,128,2281 is the entry, because new mines must start below the base
// (y100). The ladder is extended downward to the ore's depth and the strip begins where the shaft reaches it.
//
// Rules kept here (tests in test/mining.shaft.test.js):
//  - ladders are placed one per block, on the shaft's back wall, with a clear ray to that wall block and normal reach (torches.placeLadder);
//    nothing else is placed;
//  - the shaft is 1x1: the cell below is dug from the ladder (it is in view; filler only), what the opening shows is checked BEFORE stepping
//    (lava or water in view, a cave opening beside it or an open void under it -> stop and park, never follow unseen caves);
//  - the wood for ~1 ladder per block is crafted through the crafting module; when that is a lot of wood (config.shaft.askAbovePlanks) the job
//    parks and asks Walter first (his answer: yes, use the wood / stair mine instead);
//  - only the shaft column below the top is exempt from the base protection (engine.protectedAt); a stair mine from the shaft bottom (his
//    alternative) is exempt below the bottom of the existing ladders only.
const { Vec3 } = require('vec3')

const FACING = { west: [-1, 0, 0], east: [1, 0, 0], north: [0, 0, -1], south: [0, 0, 1] }
const key = (p) => `${p.x},${p.y},${p.z}`

module.exports = function createShaft({ bot, sight, torches, say, state, save, SC, log, dispatch, scheduler, owner, stock, E }) {
  const { Pause, floorVec, cap } = E
  const count = (n) => bot.inventory.items().filter(i => i.name === n).reduce((s, i) => s + i.count, 0)
  const top = () => new Vec3(SC.top[0], SC.top[1], SC.top[2])
  const A = () => (state.ladder = state.ladder || { approval: null, asking: false, askedAt: 0, placed: 0, stairsFrom: null, asks: 0 })

  // facing of a ladder block -> { face (out of the wall, into the shaft), back (towards the wall) }
  function ladderInfo(b) {
    if (!b || b.name !== 'ladder') return null
    let f = null
    try { f = b.getProperties && b.getProperties().facing } catch {}
    const v = FACING[f]
    if (!v) return null
    return { face: new Vec3(v[0], v[1], v[2]), back: new Vec3(-v[0], 0, -v[2]) }
  }
  // lowest consecutive ladder cell under the top: { y, info } | null
  // The bot may be deep in the shaft (the top, 100 blocks up, is not even loaded): the lowest ladder is found from the cell the bot stands in when it is on a ladder.
  function bottom() {
    const t = top()
    const me = floorVec(bot.entity.position)
    const start = onLadder() ? me : t
    const info = ladderInfo(sight.block(start))
    if (!info) return null
    let y = start.y
    for (let yy = start.y - 1; yy > -64; yy--) { const b = sight.block(new Vec3(t.x, yy, t.z)); if (!b || b.name !== 'ladder') break; y = yy }
    return { y, info }
  }
  // standing in a ladder cell of the shaft column: resume from here, never back to the top
  function onLadder() {
    const c = floorVec(bot.entity.position), t = top()
    const b = sight.block(c)
    return c.x === t.x && c.z === t.z && c.y <= t.y && !!b && b.name === 'ladder'
  }
  const inColumn = (p) => p.x === SC.top[0] && p.z === SC.top[2] && p.y < SC.top[1]
  const stairExempt = (p) => { const a = state.ladder; return !!a && a.stairsFrom != null && p.y <= a.stairsFrom + 2 }

  // ---------- wood ----------
  const planksFor = (ladders) => Math.ceil(ladders * 7 / 3 / 2)
  function askWood(need, lack) {
    const a = A()
    const st = stock ? stock() : {}
    const planks = Math.ceil(planksFor(lack)), logs = Math.ceil(planks / 4), sticks = Math.ceil(lack * 7 / 3)
    const have = `${count('ladder')} ladders, ${count('stick') + (st.stick || 0)} sticks, ${count('stick') ? '' : ''}${planksTotal(st)} planks, ${logsTotal(st)} logs`
    a.asking = true; a.askedAt = Date.now(); save()
    throw new Pause('park', `The iron mine off the ladder shaft needs about ${need} ladders; I still need to make ${lack}, which is about ${sticks} sticks = ${planks} planks = ${logs} logs. I have ${have} (bag + chests). OK to use that wood? Say "yes, use the wood" or "stair mine instead".`)
  }
  const planksTotal = (st) => bot.inventory.items().filter(i => /_planks$/.test(i.name)).reduce((s, i) => s + i.count, 0) + Object.entries(st).filter(([n]) => /_planks$/.test(n)).reduce((s, [, c]) => s + c, 0)
  const logsTotal = (st) => bot.inventory.items().filter(i => /_log$/.test(i.name)).reduce((s, i) => s + i.count, 0) + Object.entries(st).filter(([n]) => /_log$/.test(n)).reduce((s, [, c]) => s + c, 0)

  // Make sure `need` ladders are in the bag before the descent starts. Returns when they are; asks Walter first when it is a lot of wood.
  async function supply(ctx, need) {
    const a = A()
    for (let round = 0; round < 6; round++) {
      const have = count('ladder')
      if (have >= need) { a.asks = 0; return true }
      const lack = need - have
      if (a.approval !== 'wood' && planksFor(lack) > SC.askAbovePlanks) askWood(need, lack)
      a.asks = (a.asks || 0) + 1
      if (a.asks > SC.maxAsks + 1 || !dispatch) throw new Pause('park', `I need ${lack} more ladders (7 sticks make 3) and the crafting module could not make them: wood is short. Give me sticks/planks or wait for the tree farm, then say "resume mining".`)
      const batch = Math.min(lack, SC.batch)
      say(`Making ${batch} ladders for the shaft.`)
      dispatch(owner, `craft ${batch} ladder`)
      const craftOn = () => { try { const s = scheduler.status(); return (s.running && s.running.name === 'craft') || s.queue.some(t => t.name === 'craft') } catch { return false } }
      if (craftOn()) await E.sleep(ctx, 10 * 60000)           // the craft task preempts us; the job comes back here afterwards
    }
    return count('ladder') >= need
  }

  // ---------- the descent ----------
  function openingAround(cell, back) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (dx === back.x && dz === back.z) continue
      const n = sight.block(cell.offset(dx, 0, dz))
      if (n && !sight.isLadder(n) && (sight.isOpen(n) || sight.isLiquid(n)) && sight.see(n)) return `${n.name} beside the shaft`
    }
    return null
  }
  // Ladder physics (Walter watched it): on a ladder, pressing nothing slides you down; holding forward or sneak stalls the slide. So going down is "release every key and wait",
  // sneak is used only to stay put on the lowest ladder cell while the bot checks the next cell, and every key is released before any move.
  const releaseControls = () => { try { bot.clearControlStates() } catch {} try { bot.setControlState('sneak', false) } catch {} }
  const moveTo = (ctx, cell, ms) => { releaseControls(); return E.moveTo(ctx, cell, ms) }
  async function slideDown(ctx, target) {
    releaseControls()
    const t0 = Date.now()
    while (Date.now() - t0 < 4000) {
      ctx.checkpoint()
      if (bot.entity.position.y <= target.y + 0.25) return true
      await E.sleep(ctx, 80)
    }
    return false
  }
  // kind: 'liquid' | 'cave' | 'void' | 'wall' | 'ladder' | 'supplies' | 'other' - the caller may carry on with a strip at this depth for cave/void/wall/ladder
  const stop = (why, kind = 'other') => Object.assign(new Pause('park', `${why}. I stopped extending the ladder (I do not follow unseen caves, water or lava). Tell me what to do, then say "resume mining".`), { shaftKind: kind })

  // cobblestone in the missing wall cell behind `cell` so that the ladder has something to hang on (Walter allowed backing blocks). The bot stands in `cell`.
  async function backing(ctx, cell, back, face) {
    const wallPos = cell.plus(back)
    const wallCell = sight.block(wallPos)
    if (!wallCell || !sight.isOpen(wallCell) || sight.isLiquid(wallCell)) return { ok: false, why: 'not-an-empty-wall-cell' }
    const tries = [[sight.block(wallPos.offset(0, -1, 0)), new Vec3(0, 1, 0)], [sight.block(wallPos.plus(back)), face]]
    for (const [ref, f] of tries) {
      if (!ref || !sight.isSolid(ref)) continue
      const r = await torches.placeSupport(ctx, ref, f)
      if (r.ok) { log(`shaft: backing block at ${key(wallPos)}`); state.stats.support = (state.stats.support || 0) + 1; return r }
    }
    return { ok: false, why: 'no-reference-for-the-wall' }
  }
  // the cell under the lowest ladder is open (a gap between the ladder and the ground): put a block under it
  async function supportUnder(ctx, back, face) {
    if (!SC.supportUnder) return false
    const feet = floorVec(bot.entity.position)
    const under = sight.block(feet.offset(0, -1, 0))
    if (!under || !sight.isOpen(under) || sight.isLiquid(under) || !sight.see(under)) return false
    const ref = sight.block(feet.offset(0, -1, 0).plus(back))
    if (!ref || !sight.isSolid(ref)) return false
    const r = await torches.placeSupport(ctx, ref, face)
    if (r.ok) { log(`shaft: block under the ladder at ${key(under.position)}`); state.stats.support = (state.stats.support || 0) + 1 }
    return r.ok
  }

  // From wherever the bot is: to the shaft top, down the existing ladders, then extend. Ends with the bot on the ladder at `targetY`.
  async function descend(ctx, targetY, opts = {}) {
    try { return await descendInner(ctx, targetY, opts) } finally { releaseControls() }
  }
  async function descendInner(ctx, targetY, { extend = true } = {}) {
    const t = top()
    const onShaft = onLadder()
    if (!onShaft) {
      const ok = await E.travel(ctx, { x: t.x, y: t.y, z: t.z }, { exact: true, name: SC.waypoint })
      if (!ok) throw new Pause('park', 'I could not get to the ladder shaft (say "go to ladder shaft" if you can send me).')
    }
    const bo = bottom()
    if (!bo) throw new Pause('park', `I see no ladder at the shaft top (${SC.top.join(',')}), so I cannot tell which wall to put the new ladders on.`)
    const back = bo.info.back, face = bo.info.face
    log(`shaft descend: from y${floorVec(bot.entity.position).y} to y${targetY}, lowest ladder y${bo.y}, ladders in bag ${count('ladder')}, facing ${face.x},${face.z}, extend=${extend}`)
    for (let guard = 0; guard < 400; guard++) {
      ctx.checkpoint(); E.dangerCheck(ctx)
      const feet = floorVec(bot.entity.position)
      if (feet.y <= targetY) return { face, back }
      const below = new Vec3(t.x, feet.y - 1, t.z)
      let b = sight.block(below)
      for (let w = 0; w < 20 && !b; w++) { await E.sleep(ctx, 150); b = sight.block(below) }      // chunks load a moment late
      if (!b) throw stop('The shaft below is not loaded')
      if (sight.isLiquid(b)) throw stop(`There is ${b.name} in the shaft below`, 'liquid')
      if (!extend && !sight.isLadder(b)) return { face, back }
      // an existing ladder: just climb down (what shows up on the way is checked like everywhere else)
      if (sight.isLadder(b)) {
        if (E.hazardAt(below)) throw stop('Liquid in view in the shaft', 'liquid')
        if (!(await slideDown(ctx, below)) && !(await moveTo(ctx, below, 20000))) throw stop('I could not climb down my own ladder')
        if (feet.y % 10 === 0) log(`shaft: sliding down, now y${floorVec(bot.entity.position).y}`)
        const lowest = !sight.isLadder(sight.block(below.offset(0, -1, 0)))
        if (lowest) { try { bot.setControlState('sneak', true) } catch {} }            // hold still on the lowest ladder while the next cell is checked
        continue
      }
      const wasAir = sight.isOpen(b)
      log(`shaft: extend at y${feet.y}: below ${b.name} (${wasAir ? 'open' : 'solid'}), ladders ${count('ladder')}, bot at ${bot.entity.position.x.toFixed(2)},${bot.entity.position.y.toFixed(2)},${bot.entity.position.z.toFixed(2)}`)
      if (!wasAir) {
        releaseControls()
        const r = await E.clearCell(ctx, below)                 // filler only, never beside liquid, protection exempt for the shaft column
        log(`shaft: dig below y${below.y}: ${r.stop ? 'stopped ' + r.stop : 'ok'}`)
        if (r.stop) throw stop(r.stop === 'liquid' ? 'Lava or water is in view just below' : `The shaft is blocked below (${r.stop})`, r.stop === 'liquid' ? 'liquid' : 'other')
      }
      // what the opening shows, before anyone steps into it
      if (E.hazardAt(below)) throw stop('Lava or water showed up in view below', 'liquid')
      const side = openingAround(below, back)
      if (side) throw stop(`The shaft broke into a cave opening (${side})`, 'cave')
      const under = sight.block(below.offset(0, -1, 0))
      if (!wasAir && under && (sight.isOpen(under) || sight.isLiquid(under)) && sight.see(under)) throw stop('An open void shows below the shaft', 'void')
      if (!E.protectedOk(below)) throw new Pause('park', 'The shaft would leave its column inside the base. Stopping.')
      releaseControls()
      if (count('ladder') === 0) throw stop('Out of ladders in the shaft. Make some (craft ladder)', 'supplies')
      // Step down first when the floor under the new cell is solid (a one block drop onto it), then hang the ladder in the cell the bot stands in, so a missing
      // back wall can be backed with a block from inside; a hole that continues below gets its ladder from above instead.
      const floorOk = under && sight.isSolid(under)
      if (floorOk) {
        if (!(await moveTo(ctx, below, 20000))) throw stop('I could not step down into the new cell')
      } else if (!wasAir) throw stop('There is no floor under the next cell', 'void')
      let wall = sight.block(below.plus(back))
      if (!wall || !sight.isSolid(wall)) {
        if (!floorOk) throw stop('There is no solid back wall to put the next ladder on', 'wall')
        const bk = await backing(ctx, below, back, face)
        if (!bk.ok) throw stop(`There is no solid back wall to put the next ladder on (${bk.why})`, 'wall')
        wall = sight.block(below.plus(back))
      }
      const r = await torches.placeLadder(ctx, wall, face)
      log(`shaft: ladder at y${below.y} on ${wall.name}: ${r.ok ? 'placed' : r.why}`)
      if (!r.ok) throw stop(`I could not place the next ladder (${r.why})`, 'ladder')
      A().placed++; state.stats.ladders = (state.stats.ladders || 0) + 1
      if (!floorOk && !(await moveTo(ctx, below, 20000))) throw stop('I could not climb onto the new ladder')
      if (guard % 8 === 0) save()
      const h = await E.harvest(ctx)
      if (h.stop) throw stop('Lava or water showed up in view', 'liquid')
    }
    throw stop('The shaft is taking too long')
  }

  return { descend, supply, bottom, onLadder, ladderInfo, inColumn, stairExempt, planksFor, top, A, count, key, supportUnder, backing, openingAround }
}
