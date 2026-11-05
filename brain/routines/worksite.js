// Work-site chest (Walter's "time economy" rule, 2026-10-26): on a long job do not walk to the far final chests every time the bag fills.
// A chest stands next to the work; what would be hauled goes into it when the bag fills; ONE haul to the final place happens at the end
// (or when the chest is nearly full), then the chest is picked up again. A ledger in the saved state lets a restart finish the haul.
//
// Same helper in brain/excavation and brain/routines (the two folders carry identical copies); the job supplies what differs:
//   chooseSpot()        -> { cell: Vec3 (where the chest goes), stand: Vec3 (where the bot stands to place it) } | null
//   stashList()         -> [{ name, count }] of what goes into the chest now (the job's keep rules)
//   forwardable(items)  -> [{ name, count }] out of the chest's contents that the final place can take
//   forward(ctx)        -> async, empties the bag towards the final place; may return { full: true }
//   craftChest(ctx)     -> async, true when a chest is in the bag afterwards
//   equipBest(block)    -> picks the right tool before the chest is broken
// Rules kept: the chest is only placed with a clear line to the floor block, only opened with a clear line, only OUR chest (position from
// the ledger) is ever opened or broken, nothing is ever thrown away, and every failure falls back to the job's old way (no chest, no change).
const { Vec3 } = require('vec3')

const CHEST_NAMES = new Set(['chest', 'trapped_chest', 'barrel'])
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

module.exports = function makeWorksite({ bot, goals, mover, los, say, state, save, label = 'the work-site chest', chooseSpot, stashList, forwardable, forward, craftChest, equipBest = null, nearlyFullAt = 0.85, minFreeAfterHaul = 1, now = Date.now, log = () => {} }) {
  const have = (n) => bot.inventory.items().filter(i => i.name === n).reduce((s, i) => s + i.count, 0)
  const ws = () => state.worksite || null
  const vec = (w) => new Vec3(w.pos[0], w.pos[1], w.pos[2])
  const tally = (items) => { const t = {}; for (const i of items) t[i.name] = (t[i.name] || 0) + i.count; return t }
  const total = (t) => Object.values(t).reduce((a, b) => a + b, 0)

  // our chest, if it is still standing where the ledger says
  function chestBlock() {
    const w = ws(); if (!w) return null
    const b = bot.blockAt(vec(w))
    return b && CHEST_NAMES.has(b.name) ? b : null
  }
  const cell = () => { const w = ws(); return w ? { x: w.pos[0], y: w.pos[1], z: w.pos[2] } : null }

  // Makes sure the chest stands. Returns its block, or null (no chest item, no spot, no clear line, ...): the caller then does what it always did.
  async function place(ctx) {
    const existing = chestBlock()
    if (existing) return existing
    if (ws()) { log(`work-site chest at ${ws().pos} is gone; ledger dropped`); state.worksite = null; save() }
    const spot = chooseSpot()
    if (!spot) return null
    if (have('chest') < 1 && !(await craftChest(ctx))) return null
    const item = bot.inventory.items().find(i => i.name === 'chest'); if (!item) return null
    const r = await mover.goto(ctx, new goals.GoalBlock(spot.stand.x, spot.stand.y, spot.stand.z), 'the work site', 30000)
    if (!r.ok) return null
    const floor = bot.blockAt(spot.cell.offset(0, -1, 0)), here = bot.blockAt(spot.cell)
    if (!floor || floor.boundingBox === 'empty' || !here || here.boundingBox !== 'empty') return null
    if (!(await los.ensure(ctx, floor, 'the work site'))) return null
    try { await bot.equip(item, 'hand'); await bot.placeBlock(floor, new Vec3(0, 1, 0)) } catch (e) { log(`work-site chest place: ${e.message}`) }
    await sleep(50)
    const b = bot.blockAt(spot.cell)
    if (!b || !CHEST_NAMES.has(b.name)) return null
    state.worksite = { pos: [spot.cell.x, spot.cell.y, spot.cell.z], items: {}, slots: 27, used: 0, placedAt: new Date(now()).toISOString(), hauledUsed: 0 }
    save()
    say(`Set up a work-site chest at ${spot.cell.x}, ${spot.cell.y}, ${spot.cell.z}: I stash things there while I work and haul once at the end.`.slice(0, 230))
    return b
  }

  // Walks next to the chest, makes sure it is in view and opens it. { win, block } | { why }
  async function open(ctx) {
    const b = chestBlock(); if (!b) return { why: 'no chest' }
    const reached = await mover.near(ctx, b.position, 3, label, 60000)
    if (!reached) return { why: 'unreachable' }
    if (!(await los.ensure(ctx, b, label))) return { why: 'no clear line' }
    try { return { win: await bot.openContainer(b), block: b } } catch (e) { return { why: e.message } }
  }
  function record(win) {
    const items = win.containerItems(); const w = ws(); if (!w) return
    w.items = tally(items); w.slots = win.inventoryStart; w.used = items.length; save()
  }

  // Puts what the job says into the chest. { ok, moved, full, why }. ok:false = no chest to use, the caller falls back.
  async function stash(ctx) {
    const list = stashList()
    if (!list.length) return { ok: true, moved: {}, full: false }          // nothing to put away: no chest is made for that
    const b = await place(ctx)
    if (!b) return { ok: false, why: 'no work-site chest' }
    const o = await open(ctx)
    if (!o.win) return { ok: false, why: o.why }
    const moved = {}; let full = false
    try {
      for (const t of list) {
        const it = bot.inventory.items().find(i => i.name === t.name); if (!it) continue
        const before = have(t.name)
        try { await o.win.deposit(it.type, null, t.count) } catch (e) { full = true; log(`work-site chest refused ${t.name}: ${e.message}`) }
        const d = before - have(t.name); if (d > 0) moved[t.name] = d
        if (full) break
      }
      record(o.win)
    } finally { try { o.win.close() } catch {} }
    return { ok: true, moved, full }
  }

  // Has the chest filled up since it was last hauled? (Junk that cannot be forwarded must not make us haul over and over.)
  function nearlyFull() {
    const w = ws(); if (!w || !w.slots) return false
    return w.used / w.slots >= nearlyFullAt && w.used >= (w.hauledUsed || 0) + 5
  }

  // Hauls what the final place can take: out of the chest into the bag in batches, forward, repeat. { done, left, full, picked }
  async function haul(ctx, { quiet = false } = {}) {
    if (!ws()) return { done: true }
    let hauled = 0
    { const f0 = await forward(ctx); if (f0 && f0.full) return { done: false, full: true, hauled } }          // first empty the bag itself: a full bag cannot take anything out of the chest
    for (let trip = 0; trip < 12; trip++) {
      const o = await open(ctx)
      if (!o.win) { if (o.why === 'no chest') { state.worksite = null; save(); return { done: true, lost: true } } return { done: false, why: o.why } }
      let got = 0, forwardList = []
      try {
        const items = o.win.containerItems()
        forwardList = forwardable(items.map(i => ({ name: i.name, count: i.count })))
        const freeSlots = () => Math.max(0, bot.inventory.emptySlotCount() - minFreeAfterHaul)
        for (const t of forwardList) {
          if (freeSlots() <= 0) break
          const room = freeSlots() * 64
          const n = Math.min(t.count, room)
          const before = have(t.name)
          try { await o.win.withdraw(bot.registry.itemsByName[t.name].id, null, n) } catch (e) { log(`work-site withdraw ${t.name}: ${e.message}`) }
          got += have(t.name) - before
        }
        record(o.win)
      } finally { try { o.win.close() } catch {} }
      if (got === 0) break
      hauled += got
      const f = await forward(ctx)
      if (f && f.full) return { done: false, full: true, hauled }
    }
    const w = ws()
    if (w) { w.hauledUsed = w.used; save() }
    const left = w ? w.items : {}
    if (w && total(left) === 0) { const picked = await pickup(ctx); if (!quiet && hauled) say(`Hauled ${hauled} items from the work-site chest to the final place${picked ? ' and picked the chest up' : ''}.`.slice(0, 230)); return { done: true, hauled, picked } }
    if (!quiet && hauled) say(`Hauled ${hauled} items from the work-site chest to the final place.`.slice(0, 230))
    return { done: true, hauled, left }
  }

  // Breaks and takes the empty chest back (right tool first). Never touches a chest that still holds something or is not ours.
  async function pickup(ctx) {
    const b = chestBlock(); if (!b) { state.worksite = null; save(); return true }
    const w = ws()
    if (total(w.items || {}) > 0) return false
    const o = await open(ctx)                      // look inside first: the ledger may be stale
    if (!o.win) return false
    let empty = false
    try { empty = o.win.containerItems().length === 0; record(o.win) } finally { try { o.win.close() } catch {} }
    if (!empty) return false
    if (!(await los.ensure(ctx, b, label))) return false
    if (equipBest) { try { await equipBest(b) } catch (e) { log(`work-site equip: ${e.message}`) } }
    try { await bot.dig(b, true) } catch (e) { log(`work-site chest dig: ${e.message}`); return false }
    await sleep(60)
    try { const it = bot.nearestEntity && bot.nearestEntity(e => e.name === 'item' && e.position.distanceTo(b.position.offset(0.5, 0.5, 0.5)) < 3); if (it) await mover.goto(ctx, new goals.GoalNear(it.position.x, it.position.y, it.position.z, 0.8), 'the chest', 4000) } catch (e) { if (e && e.name === 'AbortError') throw e }
    state.worksite = null; save()
    return true
  }

  function snapshot() {
    const w = ws()
    return w ? { pos: w.pos, items: total(w.items || {}), used: w.used, slots: w.slots, standing: !!chestBlock() } : null
  }

  return { place, stash, haul, pickup, nearlyFull, chestBlock, cell, snapshot }
}
