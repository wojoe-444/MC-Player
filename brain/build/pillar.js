// The tower's temporary scaffold: a cobblestone pillar in the middle column, raised one block at a time under the bot's own feet
// (jump-and-place, same idea as brain/excavation/pillar.js) and taken down again from the top. Every cell is written to the saved state
// BEFORE it is placed, so a crash or restart can remove exactly those blocks again (dismantle() on the recorded cells).
// Only cobblestone cells of the recorded column are ever dug, always with the best pickaxe in hand.
const { Vec3 } = require('vec3')
const motor = require('../motor')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const key = (x, y, z) => `${x},${y},${z}`

// col: {x, z} the pillar column (absolute), baseY: the y of the first pillar block (= oy)
module.exports = function makePillar({ bot, canSee, state, save, col, baseY, maxBlocks = 11, equipBest = null, mover = null, goals = null, log = () => {}, stepMs = 30, landMs = 120 }) {
  const feetY = () => bot.entity.position.y
  const standingIn = () => Math.floor(bot.entity.position.x) === col.x && Math.floor(bot.entity.position.z) === col.z
  const cobbleItem = () => bot.inventory.items().find(i => i.name === 'cobblestone')
  const cells = () => (state.pillar && state.pillar.cells) || []
  const blockAt = (x, y, z) => { try { return bot.blockAt(new Vec3(x, y, z)) || null } catch { return null } }
  const record = (y) => {
    if (!state.pillar) state.pillar = { x: col.x, z: col.z, cells: [] }
    const k = key(col.x, y, col.z)
    if (!state.pillar.cells.includes(k)) state.pillar.cells.push(k)
    save()
  }
  // recorded cells that still hold cobblestone, highest first
  const live = () => cells().map(c => c.split(',').map(Number)).filter(([x, y, z]) => {
    if (x !== col.x || z !== col.z || y < baseY) return false          // never anything outside the recorded column
    const b = blockAt(x, y, z)
    return !!b && b.name === 'cobblestone'
  }).sort((a, b) => b[1] - a[1])

  // One block: look down, jump, and when the feet have cleared the cell place a block on the one below it.
  async function placeUnderfoot(ctx, cellY) {
    const ref = blockAt(col.x, cellY - 1, col.z)
    if (!ref || ref.boundingBox === 'empty') return false
    if (!canSee || !canSee(ref)) return false
    // the one jump-and-place implementation (brain/motor)
    const eq = await motor.equip(bot, 'cobblestone'); if (!eq.ok) { log(`pillar ${key(col.x, cellY, col.z)}: ${eq.reason}`); return false }
    const r = await motor.jumpPlaceUnder(bot, { ref, feetY: cellY, held: eq.value, reequip: () => motor.equip(bot, 'cobblestone'), tick: () => sleep(stepMs), minRise: 1.0, checkpoint: ctx ? () => ctx.checkpoint() : undefined, log })
    if (!r.ok) log(`pillar place ${key(col.x, cellY, col.z)}: ${r.reason}`)
    const b = blockAt(col.x, cellY, col.z)
    return !!b && b.name === 'cobblestone'
  }

  // Adds one block under the feet. { ok } | { ok:false, why }
  async function raiseOne(ctx) {
    if (!standingIn()) return { ok: false, why: 'not standing in the pillar column' }
    const y = Math.round(feetY())
    if (Math.abs(feetY() - y) > 0.3) return { ok: false, why: 'not standing still on a block' }
    if (y - baseY >= maxBlocks) return { ok: false, why: `the pillar is at its ${maxBlocks} block cap` }
    const it = cobbleItem()
    if (!it) return { ok: false, why: 'out of cobblestone' }
    if (!bot.heldItem || bot.heldItem.name !== 'cobblestone') await bot.equip(it, 'hand')
    record(y)
    if (!(await placeUnderfoot(ctx, y))) return { ok: false, why: 'could not place the block under my feet' }
    await sleep(landMs)                                          // land on it
    if (feetY() < y + 0.9) return { ok: false, why: 'did not land on the pillar' }
    return { ok: true }
  }

  // Takes the recorded pillar down. On top of it: dig the block under the feet, one at a time (the bot drops one block each time).
  // Anywhere else: from the side, whatever is in plain view and within reach, highest first.
  // Never throws for an abort (no checkpoints): it is the thing that gets the bot back down.
  async function dismantle(ctx) {
    if (!cells().length) { state.pillar = null; return 0 }
    let removed = 0, stuck = 0
    for (let guard = 0; guard < 40; guard++) {
      const lv = live()
      if (!lv.length) break
      const top = lv[0]
      const onTop = standingIn() && feetY() >= top[1] + 0.9
      let pick = top
      if (onTop) { try { await bot.look(bot.entity.yaw, -Math.PI / 2, true) } catch {} }
      else {
        if (mover && goals && stuck === 0) { try { await mover.goto(null, new goals.GoalNear(col.x, baseY, col.z, 2), 'the pillar', 15000) } catch {} }
        pick = lv.find(([x, y, z]) => { const b = blockAt(x, y, z); return b && canSee && canSee(b) && bot.entity.position.offset(0, 1.62, 0).distanceTo(new Vec3(x + 0.5, y + 0.5, z + 0.5)) <= 4.5 }) || null
        if (!pick) { log(`pillar ${key(...top)} not in sight or out of reach`); break }
      }
      const [x, y, z] = pick
      const target = blockAt(x, y, z)
      if (!target || target.name !== 'cobblestone') continue
      if (equipBest) { try { await equipBest(target) } catch (e) { log(`pillar equip: ${e.message}`) } }
      try { await bot.dig(target, true); removed++ } catch (e) { log(`pillar dig ${key(x, y, z)}: ${e.message}`); stuck++; if (stuck > 6) break; await sleep(100) }
      await sleep(onTop ? landMs : stepMs)                       // fall one block
    }
    if (!live().length) state.pillar = null
    save()
    return removed
  }

  return { raiseOne, dismantle, standingIn, live, cells, placeUnderfoot }
}
