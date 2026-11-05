// Unloads the inventory into the station input chests (the furnaces smelt it). Preferred path: the integrator's shared helper
// api.depositSmeltables (all smeltables, cobblestone above the 48 reserve, line of sight, never throws anything away). Without it (older
// brain, tests) a built-in fallback puts only cobblestone into the configured input chests, with the same rules.
const { Vec3 } = require('vec3')

const CHEST_NAMES = new Set(['chest', 'trapped_chest', 'barrel'])
const key = (p) => `${p.x},${p.y},${p.z}`

// inputs: [[x,y,z], ...]
module.exports = function makeDumper({ bot, mover, say, limits, inputs, los, depositSmeltables = null, now = Date.now, log = () => {} }) {
  const chests = inputs.map(a => { const pos = new Vec3(a[0], a[1], a[2]); return { pos, key: key(pos) } })
  const failedUntil = new Map()
  const have = (n) => bot.inventory.items().filter(i => i.name === n).reduce((s, i) => s + i.count, 0)
  const dist = (p) => bot.entity.position.distanceTo(p)
  const fail = (c, why) => { failedUntil.set(c.key, now() + limits.chestRetryMs); log(`input chest ${c.key}: ${why}`) }

  // Spare cobblestone = everything above the reserve we keep for crafting pickaxes.
  const spare = () => Math.max(0, have('cobblestone') - limits.reserveCobble)

  // is there anything that could be unloaded? (the shared helper decides for itself and does nothing when there is nothing to do)
  const canUnload = () => !!depositSmeltables || spare() > 0

  // { moved, full, ... }  full = every input chest is full or out of reach: the job must pause and wait for Walter
  async function dump(ctx, opts = {}) {
    if (depositSmeltables) {
      let r
      try { r = await depositSmeltables({ ctx, force: !!opts.force }) } catch (e) { if (e && e.name === 'AbortError') throw e; log(`depositSmeltables failed: ${e.message}`); return { moved: 0, full: false, why: e.message } }
      const moved = Object.values((r && r.moved) || {}).reduce((a, b) => a + b, 0)
      return { moved, items: (r && r.moved) || {}, left: (r && r.left) || [], full: !!(r && r.full), cantReach: r && r.cantReach, skipped: !!(r && r.skipped) }
    }
    if (spare() <= 0) return { moved: 0, tried: 0, why: 'nothing spare' }
    const t = now()
    const cands = chests.filter(c => !(failedUntil.get(c.key) > t)).sort((a, b) => dist(a.pos) - dist(b.pos))
    if (!cands.length) return { moved: 0, tried: 0, why: 'no input chest is usable right now' }
    const cobbleId = bot.registry.itemsByName.cobblestone.id
    let moved = 0, tried = 0
    for (const c of cands) {
      const left = spare()
      if (left <= 0) break
      ctx && ctx.checkpoint()
      tried++
      let reached = false
      try { reached = await mover.near(ctx, c.pos, 3, 'an input chest') }
      catch (e) { if (e && e.name === 'AbortError') throw e; log(`input chest ${c.key}: ${e.message}`) }
      if (!reached) { fail(c, 'unreachable'); continue }
      const blk = bot.blockAt(c.pos)
      if (!blk || !CHEST_NAMES.has(blk.name)) { fail(c, `expected a chest, found ${blk ? blk.name : 'unloaded block'}`); continue }
      if (los && !(await los.ensure(ctx, blk, 'an input chest'))) { fail(c, 'no clear line of sight to it'); continue }     // never open a chest through a wall
      let win, before = have('cobblestone')
      try {
        win = await bot.openContainer(blk)
        const items = win.containerItems()
        const room = (win.inventoryStart - items.length) * 64 + items.filter(i => i.name === 'cobblestone').reduce((s, i) => s + (64 - i.count), 0)
        if (room <= 0) fail(c, 'full')
        else await win.deposit(cobbleId, null, Math.min(left, room))
      } catch (e) { log(`input chest ${c.key}: ${e.message}`); if (have('cobblestone') === before) fail(c, e.message) }
      finally { try { win && win.close() } catch {} }
      moved += before - have('cobblestone')
    }
    if (moved > 0) say(`Put ${moved} cobblestone into the station input chests.`)
    return { moved, tried }
  }

  return { dump, spare, canUnload, chests, failedUntil }
}
