// Pickaxe handling for the excavation: pick the fastest tool for a block, craft stone pickaxes when they wear out.
module.exports = function makeTools({ bot, goals, mover, limits, craft = null, getCrafting = null, say = () => {}, log = () => {} }) {
  const have = (pred) => bot.inventory.items().filter(pred).reduce((s, i) => s + i.count, 0)
  const durLeft = (it) => { const max = bot.registry.items[it.type].maxDurability; return max ? max - (it.durabilityUsed || 0) : 999 }
  const usable = () => bot.inventory.items().filter(i => /_(pickaxe|shovel|axe)$/.test(i.name) && durLeft(i) >= 3)
  const pickaxeUses = () => bot.inventory.items().filter(i => /_pickaxe$/.test(i.name)).reduce((s, i) => s + durLeft(i), 0)

  async function equipBest(block) {
    let best = null, bestT = Infinity
    for (const it of usable()) {
      const t = block.digTime(it.type, false, false, false, [], {})
      if (t < bestT) { bestT = t; best = it }
    }
    if (!best) return false
    if (!bot.heldItem || bot.heldItem.type !== best.type) await bot.equip(best, 'hand')
    return true
  }

  // Walter: breaking a block while airborne is about 5x slower, so wait until the feet are on the ground (a fall after the block under us went, a jump, a
  // step off a ledge). Returns whether the bot is grounded afterwards.
  async function waitGrounded(maxMs = 1000) {
    const t0 = Date.now()
    while (bot.entity && bot.entity.onGround === false && Date.now() - t0 < maxMs) await new Promise(r => setTimeout(r, 30))
    return !bot.entity || bot.entity.onGround !== false
  }

  // Every dig of this module goes through here: grounded first, then dig, timed against what the block should take with the tool in hand.
  // Slow digs (more than twice the expected time) and all "pillar-down" digs are logged so the cause can be seen; stats go to status().
  const stats = { count: 0, totalMs: 0, slow: 0, airborne: 0, slowest: null }
  async function dig(block, { why = '', aim = 0 } = {}) {
    const grounded = await waitGrounded()
    if (!grounded) stats.airborne++
    const held = bot.heldItem
    let expected = null
    try { expected = block.digTime(held ? held.type : null, false, false, !grounded, [], {}) } catch {}
    const t0 = Date.now()
    if (aim) {              // optional experiment: aim at a point off the block centre (the server does not care, the client's idea of the ray might)
      try { await bot.lookAt(block.position.offset(0.5 + aim, 0.5, 0.5), true) } catch {}
      await bot.dig(block, 'ignore')
    } else await bot.dig(block, true)
    const ms = Date.now() - t0
    stats.count++; stats.totalMs += ms
    const slow = expected != null && ms > 2 * expected + 400
    if (slow) { stats.slow++; if (!stats.slowest || ms > stats.slowest.ms) stats.slowest = { ms, block: block.name, at: `${block.position.x},${block.position.y},${block.position.z}` } }
    if (slow || why === 'pillar-down') log(`${slow ? 'SLOW ' : ''}dig ${block.name} at ${block.position.x},${block.position.y},${block.position.z}${why ? ' (' + why + ')' : ''}: ${ms} ms, expected ~${expected == null ? '?' : Math.round(expected)} ms, onGround=${bot.entity ? bot.entity.onGround : '?'}, held=${held ? held.name : 'nothing'}`)
    return ms
  }

  // Ask the crafting module (knows the crafting table, planks, chests and taking only what it needs) to make something, wait until `done()`.
  // It runs as a higher priority task, so we are usually paused while it works and carry on afterwards. At most 2 asks per job and thing.
  // false = it did not handle the request or it did not produce the item: the caller falls back.
  async function craftVia(ctx, text, done, what) {
    if (!craft || !craft.dispatch) return false
    ctx.state.craftAsks = ctx.state.craftAsks || {}
    const n = ctx.state.craftAsks[what] = (ctx.state.craftAsks[what] || 0) + 1
    if (n > 2) return false
    let handled = false
    try { handled = !!craft.dispatch(text) } catch (e) { log(`craft dispatch: ${e.message}`) }
    if (!handled) return false
    say(`Making ${what} (crafting module).`)
    for (let i = 0; i < (limits.craftPolls || 120); i++) {
      await ctx.sleep(limits.craftPollMs || 1000)
      if (done()) return true
      if (craft.busy && !craft.busy()) break
    }
    return !!done()
  }

  // true when there are enough pickaxe uses left; otherwise tries to craft some. { ok } or { ok:false, reason }
  async function restock(ctx) {
    if (pickaxeUses() >= limits.minPickaxeUses) return { ok: true }
    const cobble = have(i => i.name === 'cobblestone')
    const planks = have(i => i.name.endsWith('_planks'))
    const sticks = have(i => i.name === 'stick')
    const want = Math.min(8, Math.floor(cobble / 3), Math.floor((sticks + Math.floor(planks / 2) * 4) / 2))
    // the crafting module's own API: it checks the bag again at every step (sticks first, then the pickaxes) and finds the table itself
    const crafting = getCrafting && getCrafting()
    if (crafting && typeof crafting.craft === 'function') {
      if (want < 1) return { ok: false, reason: 'My pickaxes are worn out and I am out of materials for more (need cobblestone plus planks or sticks).' }
      try {
        const r = await crafting.craft(ctx, 'stone_pickaxe', want, { chests: false, tableRadius: 96 })
        if (r && r.made > 0) { log(`crafted ${r.made} stone pickaxes (crafting module)`); return { ok: true, crafted: r.made } }
        return { ok: false, reason: `Could not craft pickaxes: ${(r && r.text) || 'no result'}`.slice(0, 200) }
      } catch (e) { if (e && e.name === 'AbortError') throw e; log(`crafting module failed (${e.message}); doing it myself`) }
    }
    if (await craftVia(ctx, 'craft stone pickaxe 4', () => pickaxeUses() >= limits.minPickaxeUses, 'pickaxes')) return { ok: true }
    if (want < 1) return { ok: false, reason: 'My pickaxes are worn out and I am out of materials for more (need cobblestone plus planks or sticks).' }
    const tableId = bot.registry.blocksByName.crafting_table.id
    const table = bot.findBlock({ matching: tableId, maxDistance: 96 })
    if (!table) return { ok: false, reason: 'My pickaxes are nearly worn out and I cannot find a crafting table within 96 blocks to make more.' }
    const r = await mover.goto(ctx, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 'the crafting table', 60000)
    if (!r.ok) return { ok: false, reason: `Could not reach a crafting table to make more pickaxes (${r.err}).` }
    const craft = async (name, n) => { const rec = bot.recipesFor(bot.registry.itemsByName[name].id, null, 1, table)[0]; if (!rec) throw new Error('no recipe ' + name); await bot.craft(rec, n, table) }
    try {
      const needSticks = want * 2 - sticks
      if (needSticks > 0) await craft('stick', Math.ceil(needSticks / 4))
      for (let i = 0; i < want; i++) await craft('stone_pickaxe', 1)
      log(`crafted ${want} stone pickaxes`)
      return { ok: true, crafted: want }
    } catch (e) { return { ok: false, reason: `Could not craft pickaxes: ${e.message}`.slice(0, 200) } }
  }

  return { equipBest, restock, craftVia, pickaxeUses, usable, dig, waitGrounded, stats }
}
