// Work-site chest (Walter's "time economy" rule, 2026-10-26): on a long job, do not walk to the far final chests every time the bag fills.
// A chest is put next to the work (legit placement: in view, on a plain floor, in a finished hallway where nobody walks), everything that would
// be hauled goes in there when the bag fills, and ONE haul to the furnace / storage chests happens at the end of the job (or when the chest is
// nearly full). The chest is picked up again afterwards. A ledger in the state file lets a restart finish the haul.
//
// Rules kept: the chest is only ever placed with a clear ray to the floor block (torches.placeChest), only opened with a clear ray, never
// opened or broken when it is not our chest (position from the ledger), items are never thrown away, bag keeps tools/food/torches/coal.
const { Vec3 } = require('vec3')
const los = require('../los')
const smelt = require('../smeltables')

const NAME = 'worksite mining'

module.exports = function createWorksite({ bot, sight, mover, goals, torches, say, state, save, L, WC, config, log, dispatch, scheduler, owner, waypoints, deposit, stashJunk, refreshGained, curMine, G, travel, Pause, now }) {
  const have = (n) => bot.inventory.items().filter(i => i.name === n).reduce((s, i) => s + i.count, 0)
  const junk = new Set(config.junk || [])
  const k3 = (p) => `${p.x},${p.y},${p.z}`
  const chestVec = () => { const w = state.worksite; return w ? new Vec3(w.pos[0], w.pos[1], w.pos[2]) : null }
  const near = (p, d) => Math.hypot(bot.entity.position.x - p.x, bot.entity.position.z - p.z) <= d && Math.abs(bot.entity.position.y - p.y) < 6

  // What goes into the chest now: everything smeltable (rules of brain/smeltables.js, cobble above the 48 reserve) plus the junk and valuables list.
  function stashList() {
    const items = bot.inventory.items()
    const total = {}
    for (const i of items) total[i.name] = (total[i.name] || 0) + i.count
    const out = new Map()
    for (const p of smelt.plan(items, { reserveCobble: 48 })) out.set(p.name, p.count)
    for (const [n, c] of Object.entries(total)) if (junk.has(n)) out.set(n, c)
    return [...out.entries()].map(([name, count]) => ({ name, count })).filter(x => x.count > 0)
  }
  const far = () => !WC.home || Math.hypot(bot.entity.position.x - WC.home[0], bot.entity.position.z - WC.home[2]) > WC.minDistance

  // ---------- the chest ----------
  async function ensureChestItem(ctx) {
    if (have('chest') > 0) return true
    const j = state.job
    j.chestAsks = (j.chestAsks || 0) + 1
    if (j.chestAsks > WC.maxAsks || !dispatch) return false
    save()
    say('Making a chest for a work site in the mine, so I only haul once at the end.')
    dispatch(owner, 'craft chest')
    const craftOn = () => { try { const s = scheduler.status(); return (s.running && s.running.name === 'craft') || s.queue.some(t => t.name === 'craft') } catch { return false } }
    if (craftOn()) await ctx.sleep(10 * 60000)
    return have('chest') > 0
  }
  // a finished hallway's first cell, next to its junction: out of the way, nobody walks there again
  function spot() {
    const m = curMine()
    if (!m) return null
    const me = bot.entity.position
    const c = []
    for (const [key, r] of Object.entries(m.branches || {})) {
      if (!r.done || (r.len || 0) < 2) continue
      const [t, side] = key.split(':')
      const cell = G.branchCell(m, +t, side, 1), stand = G.trunkCell(m, +t)
      const floor = sight.block(cell.offset(0, -1, 0)), air = sight.block(cell), head = sight.block(cell.offset(0, 1, 0))
      if (!floor || !air || !head || !/^(air|cave_air)$/.test(air.name) || !/^(air|cave_air)$/.test(head.name) || !torches.floorOk(floor, air)) continue
      c.push({ cell, stand, floor, d: me.distanceTo(cell) })
    }
    return c.sort((a, b) => a.d - b.d)[0] || null
  }
  async function setup(ctx) {
    if (state.worksite) return true
    const j = state.job
    if (j.worksiteOff) return false
    const s = spot()
    if (!s) return false                                              // no finished hallway yet: the normal route
    if (!(await ensureChestItem(ctx))) { j.worksiteOff = true; save(); log('worksite: no chest to place; falling back to hauling normally'); return false }
    const again = spot() || s
    if (!(await mover.goto(ctx, new goals.GoalBlock(again.stand.x, again.stand.y, again.stand.z), 'the junction', 20000)).ok && bot.entity.position.distanceTo(new Vec3(again.stand.x + 0.5, again.stand.y, again.stand.z + 0.5)) > 1.5) return false
    const r = await torches.placeChest(ctx, sight.block(again.floor.position))
    if (!r.ok) { log(`worksite chest not placed: ${r.why}`); j.worksiteOff = true; save(); return false }
    state.worksite = { pos: [r.at.x, r.at.y, r.at.z], stand: [again.stand.x, again.stand.y, again.stand.z], items: {}, slots: 0, cap: 27, jobStartedAt: j.startedAt, placedAt: new Date(now()).toISOString() }
    try { if (waypoints && waypoints.add) waypoints.add(NAME, { x: r.at.x, y: r.at.y, z: r.at.z }) } catch (e) { log('worksite waypoint: ' + e.message) }
    save()
    say('Work-site chest is down in the mine; I will haul everything at the end.')
    return true
  }

  // walk to the chest and open it (line of sight required). { win, blk } | null
  async function open(ctx) {
    const pos = chestVec()
    if (!pos) return null
    const w = state.worksite
    if (!near(pos, 3)) {
      const ok = await travel(ctx, { x: w.stand[0], y: w.stand[1], z: w.stand[2] }, { name: NAME, exact: true })
      if (!ok) return null
    }
    let blk = sight.block(pos)
    if (!blk || blk.name !== 'chest') { log(`worksite chest missing at ${k3(pos)} (found ${blk ? blk.name : 'nothing'}); forgetting it`); say('The work-site chest is gone; I will not look for it again.'); state.worksite = null; save(); return null }
    if (!sight.see(blk)) {
      let seen = false
      for (const f of los.viewpoints(bot, pos, { reach: 4.2, max: 6 })) {
        if (!sight.standOk(f).ok) continue
        await mover.goto(ctx, new goals.GoalBlock(f.x, f.y, f.z), 'a view of the chest', 15000)
        blk = sight.block(pos)
        if (blk && sight.see(blk)) { seen = true; break }
      }
      if (!seen) return null
    }
    try { return { win: await bot.openContainer(blk), blk } } catch (e) { log('worksite open: ' + e.message); return null }
  }
  const ledger = (win) => {
    const t = {}
    for (const it of win.containerItems()) t[it.name] = (t[it.name] || 0) + it.count
    state.worksite.items = t; state.worksite.slots = win.containerItems().length; save()
  }

  // ---------- fill ----------
  // Put the stash list into the chest. true when something went in.
  async function fill(ctx) {
    if (!state.worksite && !(await setup(ctx))) return false
    refreshGained()
    const list = stashList()
    if (!list.length) return false
    const o = await open(ctx)
    if (!o) return false
    let moved = 0
    try {
      for (const it of list) {
        ctx.checkpoint()
        const before = have(it.name)
        try { await o.win.deposit(bot.registry.itemsByName[it.name].id, null, it.count) } catch (e) { log(`worksite deposit ${it.name}: ${e.message}`) }
        moved += before - have(it.name)
      }
      ledger(o.win)
    } finally { try { o.win.close() } catch {} }
    refreshGained()
    if (moved > 0) log(`worksite: stored ${moved} items (${state.worksite.slots}/${state.worksite.cap} slots)`)
    return moved > 0
  }
  const nearlyFull = () => !!state.worksite && state.worksite.slots >= Math.floor(state.worksite.cap * WC.haulAt)

  // ---------- haul ----------
  async function unloadBag(ctx) {
    if (!deposit) throw new Pause('park', 'I have a work-site chest to empty but no way to reach the furnace chests. Tell me where to put the haul.')
    const r = await deposit({ ctx, force: true, quiet: true })
    refreshGained()
    if (r && r.full) throw new Pause('park', 'The furnace input chests are full or out of reach, so I cannot finish the haul from the work-site chest. Empty them or tell me where to put things.')
    await stashJunk(ctx)
    refreshGained()
  }
  // Take the contents out (as much as the bag takes), carry them to the final chests, repeat until it is empty; the last time also pick the chest up.
  async function haul(ctx, { final = false } = {}) {
    if (!state.worksite) return true
    for (let round = 0; round < 8; round++) {
      ctx.checkpoint()
      const o = await open(ctx)
      if (!o) return false
      let left = 0
      try {
        const items = o.win.containerItems().slice().sort((a, b) => b.count - a.count)
        for (const it of items) {
          if (bot.inventory.emptySlotCount() <= L.minFreeSlots + 1) { left++; continue }
          try { await o.win.withdraw(it.type, null, it.count) } catch (e) { log(`worksite withdraw ${it.name}: ${e.message}`); left++ }
        }
        ledger(o.win)
      } finally { try { o.win.close() } catch {} }
      refreshGained()
      if (stashList().length) await unloadBag(ctx)
      if (!state.worksite.slots) break
    }
    const empty = !state.worksite.slots
    if (empty && final) return pickUp(ctx)
    return empty
  }
  async function pickUp(ctx) {
    const o = await open(ctx)
    if (!o) return false
    const empty = o.win.containerItems().length === 0
    try { o.win.close() } catch {}
    if (!empty) return false
    let blk = sight.block(chestVec())
    if (!blk || blk.name !== 'chest' || !sight.see(blk)) return false
    const tool = bot.inventory.items().find(i => /_(pickaxe|axe)$/.test(i.name))
    try { if (tool) await bot.equip(tool, 'hand'); await bot.dig(blk, true) } catch (e) { log('worksite pickup: ' + e.message); return false }
    // the drop lands next to us; walking onto it is the pickup
    const drop = Object.values(bot.entities || {}).find(e => (e.name === 'item') && e.position.distanceTo(chestVec().offset(0.5, 0.5, 0.5)) < 2)
    if (drop && bot.entity.position.distanceTo(drop.position) > 1.2) { const c = new Vec3(Math.floor(drop.position.x), Math.floor(drop.position.y + 0.01), Math.floor(drop.position.z)); if (sight.standOk(c).ok) await mover.goto(ctx, new goals.GoalBlock(c.x, c.y, c.z), 'the chest', 6000) }
    try { if (waypoints && waypoints.remove) waypoints.remove(NAME) } catch (e) { log('worksite waypoint: ' + e.message) }
    state.worksite = null; save()
    say('Hauled the work-site chest contents to the furnace and storage chests and picked the chest up again.')
    return true
  }

  return { fill, haul, setup, nearlyFull, far, stashList, pickUp, NAME }
}
module.exports.NAME = NAME
