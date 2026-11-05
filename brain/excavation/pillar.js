// Vertical access for the upper layers (Walter allowed temporary blocks for this job): a cobblestone pillar built under the bot's own feet by
// jump-and-place, then taken down again from the top. The pillar never gets higher than `maxBlocks` (feet at floorY+maxBlocks), every placement
// needs a clear line to the block it is placed on, and the cells are written to the saved state while it stands, so a crash or restart can
// remove exactly those blocks again (cleanup()).
const { Vec3 } = require('vec3')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const key = (x, y, z) => `${x},${y},${z}`

module.exports = function makePillar({ bot, goals, mover, los, state, save, floorY, maxBlocks = 4, danger = () => null, stepMs = 30, landMs = 120, log = () => {}, equipBest = null, dig = null, aim = 0 }) {
  const feetY = () => bot.entity.position.y
  const colOf = (p) => ({ x: Math.floor(p.x), z: Math.floor(p.z) })
  const cobbleItem = () => bot.inventory.items().find(i => i.name === 'cobblestone')
  const standingIn = (col) => { const c = colOf(bot.entity.position); return c.x === col.x && c.z === col.z }

  // One block: look down, jump, and when the feet have cleared the cell place a block on the one below it.
  async function placeUnderfoot(ctx, col, cellY) {
    const ref = bot.blockAt(new Vec3(col.x, cellY - 1, col.z))
    if (!ref || ref.boundingBox === 'empty') return false
    if (!los.canSee(ref)) return false
    try { await bot.look(bot.entity.yaw, -Math.PI / 2, true) } catch {}
    bot.setControlState('jump', true)
    try {
      for (let t = 0; t < 40; t++) {
        await sleep(stepMs)
        ctx && ctx.checkpoint()
        if (feetY() >= cellY + 1.0) {
          try { await bot.placeBlock(ref, new Vec3(0, 1, 0)) } catch (e) { log(`pillar place ${key(col.x, cellY, col.z)}: ${e.message}`) }
          const b = bot.blockAt(new Vec3(col.x, cellY, col.z))
          if (b && b.name === 'cobblestone') return true
        }
      }
      return false
    } finally { bot.setControlState('jump', false) }
  }

  // Builds from the floor cell of `col` up to feet at floorY+blocks. { ok, why, height }
  async function build(ctx, col, blocks) {
    const n = Math.min(blocks, maxBlocks)
    if (!standingIn(col) || feetY() > floorY + 0.3) return { ok: false, why: 'not standing on the floor of the pillar column', height: 0 }
    const cells = []
    state.pillar = { x: col.x, z: col.z, cells }; save()
    for (let y = floorY; y < floorY + n; y++) {
      ctx && ctx.checkpoint()
      const d = danger(); if (d) return { ok: false, why: d, height: y - floorY }
      const it = cobbleItem(); if (!it) return { ok: false, why: 'out of cobblestone', height: y - floorY }
      await bot.equip(it, 'hand')
      if (!(await placeUnderfoot(ctx, col, y))) return { ok: false, why: 'could not place the block under my feet', height: y - floorY }
      cells.push(key(col.x, y, col.z)); save()
      await sleep(landMs)                                        // land on it
      if (feetY() < y + 0.9) return { ok: false, why: 'did not land on the pillar', height: y - floorY + 1 }
    }
    return { ok: true, height: n }
  }

  // Takes the recorded pillar down. On top of it: dig the block under the feet one at a time. Anywhere else: from the side, top first.
  // Never throws for an abort (no checkpoints): it is the thing that gets the bot back down.
  async function dismantle(ctx) {
    const p = state.pillar
    if (!p || !p.cells || !p.cells.length) { state.pillar = null; return 0 }
    const col = { x: p.x, z: p.z }
    let removed = 0
    const live = () => p.cells.map(c => c.split(',').map(Number)).filter(([x, y, z]) => { const b = bot.blockAt(new Vec3(x, y, z)); return b && b.name === 'cobblestone' }).sort((a, b) => b[1] - a[1])
    for (let guard = 0; guard < 12; guard++) {
      const cells = live()
      if (!cells.length) break
      const onTop0 = (y0) => standingIn(col) && feetY() >= y0 + 0.9
      let pick = cells[0]
      if (!onTop0(pick[1])) {
        // from the side, on the floor: any recorded block that is in plain view (cobblestone does not fall), the highest one first
        try { await mover.goto(null, new goals.GoalNear(col.x, floorY, col.z, 2), 'the pillar', 15000) } catch {}
        pick = cells.find(([x, y, z]) => los.canSee(bot.blockAt(new Vec3(x, y, z)))) || null
        if (!pick && await los.ensure(null, bot.blockAt(new Vec3(cells[0][0], cells[0][1], cells[0][2])), 'the pillar')) pick = cells[0]
        if (!pick) { log(`pillar ${key(...cells[0])} not in sight`); break }
      } else { try { await bot.look(bot.entity.yaw, -Math.PI / 2, true) } catch {} }
      const [x, y, z] = pick
      const target = bot.blockAt(new Vec3(x, y, z))
      const onTop = onTop0(y)
      // Walter: use the right tool for what you are breaking. Placing cobblestone leaves cobblestone in the hand, so equip the best pickaxe first.
      if (equipBest && target) { try { await equipBest(target) } catch (e) { log(`pillar equip: ${e.message}`) } }
      try { if (dig) await dig(target, { why: 'pillar-down', aim: onTop ? aim : 0 }); else await bot.dig(target, true); removed++ } catch (e) { log(`pillar dig ${key(x, y, z)}: ${e.message}`); await sleep(100) }
      await sleep(onTop ? landMs : stepMs)                       // fall one block
    }
    if (!live().length) state.pillar = null
    save()
    return removed
  }

  return { build, dismantle, standingIn }
}
