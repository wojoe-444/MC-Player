// brain/autopilot/resetgear.js: the reset-gear chest and the lean kit (ROADMAP Phase 2, item 2; Walter 2026-11-10, Act 2 "structure").
//
// The reset-gear chest is a single chest by the entrance of the storage room (a role in the room record, see brain/storage-model.js), holding the
// lean kit: a stone pickaxe, a stone sword, food, torches and cobblestone for walls. Two steps:
//   reset-chest   when the bag has a surplus of kit items (above what it keeps for itself), they go into the chest until it holds the full kit; the
//                 chest is set up first if the room has none, and the missing stone tools are crafted from surplus cobblestone and wood.
//   reset-restock when the bag is short of an essential (no pickaxe, no sword, almost no food or torches), usually after a death: walk to the
//                 storage room and take the gap from the chest. Only the gap: nothing is taken while the bag has the kit.
// The chest is reserved (brain/storage-model.js reservedKeys): crafting recipes, the planner's "fetch" and the stash never take from it or fill it with
// general goods. No armor ever goes in (the armor rule); iron and diamond tools stay with whoever holds them.
// Both steps are routines that do an ordinary player's chores; neither takes the bot's free-time slot (they are ordinary steps the picker weighs).
module.exports = function resetgear(G, S, M, api, log) {
  const bot = S.bot, { goals } = S, v = S.v, st = G.state
  const SM = require('../storage-model')
  const note = (m) => { try { G.note(m) } catch { log('RESETGEAR', m) } }
  const LD = () => M.LD
  const asItems = () => S.items().map(i => ({ name: i.name, count: i.count }))
  const bagCounts = () => SM.kitCounts(asItems())
  const roomAndPlan = () => { const room = G.storageRoom && G.storageRoom(); const P = G.storagePlan && G.storagePlan(); return room && P ? { room, P } : null }
  const chestBlock = (room) => { if (!room.reset) return null; const b = S.block(v(...room.reset)); return b && b.name === 'chest' ? b : null }
  async function openAt(b) {
    S.closeWindows()
    try { return await bot.openContainer(S.block(b.position) || b) } catch (e) { return { err: String(e && e.message || e).slice(0, 60) } }
  }

  // set up the chest: place it on a free single spot of the room (storage-model singleSpot), record it, remember failures
  async function ensureChest(room, P) {
    const have = chestBlock(room); if (have) return have
    if (room.reset) { note('reset chest: the chest recorded at ' + room.reset + ' is gone; forgetting it'); SM.forget(room, room.reset); LD().putRoom(room) }
    const c = SM.singleSpot(P, (q) => S.block(q), (room.resetBad || []).concat(room.junk ? [room.junk] : []))
    if (!c) { note('reset chest: no free single spot in the room'); return null }
    if (!S.has('chest')) await S.craft('chest', 1).catch(() => false)
    if (!S.has('chest')) { note('reset chest: no chest in the bag and none can be crafted'); return null }
    if (G.storageClearAbove) await G.storageClearAbove(c).catch(() => false)
    const g = S.block(c.offset(0, -1, 0))
    if (!(await S.placeAgainst(g, v(0, 1, 0), 'chest').catch(() => false))) { room.resetBad = (room.resetBad || []).concat([[c.x, c.y, c.z]]); LD().putRoom(room); note('reset chest: would not go down at ' + c); return null }
    SM.setReset(room, c); LD().putRoom(room)
    note('reset chest set up at ' + c + ' by the storage room entrance (the lean kit lives here)')
    return S.block(c)
  }

  // craft the stone tools the chest lacks, but only from surplus: cobblestone beyond the bag's own filler and wood beyond the wood-stock floor
  async function craftMissing(chestCounts) {
    let made = 0
    for (const m of SM.craftable(chestCounts)) {
      const e = SM.kitEntry(m.id), mine = bagCounts()[m.id] || 0
      // a tool is "surplus" when the bag already holds the keep amount plus what the chest still needs; else make one more if the materials are spare
      if (mine >= e.keep + m.missing) continue
      const cobble = S.count(/^(cobblestone|cobbled_deepslate)$/), wood = S.planks() + S.logs() * 4 + S.count('stick')
      if (cobble < SM.kitEntry('filler').keep + 3 || wood < 8) continue
      const before = S.count(m.item)
      await S.craft(m.item, before + 1).catch(() => false)
      if (S.count(m.item) > before) made++
    }
    return made
  }

  const resetChestStep = {
    id: 'reset-chest', budget: 240000, cool: 20 * 60000,
    need: () => {
      if (S.isNight() || Date.now() < (st.resetChestRestUntil || 0)) return false
      const r = roomAndPlan(); if (!r) return false
      // set up the chest as soon as the room exists and a chest can be had; after that only when the bag has something to put in
      if (!r.room.reset) return S.has('chest') || S.planks() + S.logs() * 4 >= 8
      const known = SM.chestItems(r.room, r.room.reset) || {}
      return SM.stockGive(asItems(), SM.kitCounts(Object.entries(known).map(([name, count]) => ({ name, count })))).length > 0
    },
    run: async () => {
      const r = roomAndPlan(); if (!r) return false
      const { room, P } = r
      if (!(await G.storageGo())) { note('reset chest: could not get into the storage room'); st.resetChestRestUntil = Date.now() + 10 * 60000; return false }
      const b = await ensureChest(room, P)
      if (!b) { st.resetChestRestUntil = Date.now() + 15 * 60000; G.save(); return false }
      const w = await openAt(b)
      if (w.err) {
        note('reset chest: would not open (' + w.err + ')')
        room.resetBad = (room.resetBad || []).concat([room.reset]); SM.forget(room, room.reset); LD().putRoom(room); st.resetChestRestUntil = Date.now() + 5 * 60000; return false
      }
      let gave = 0, made = 0
      const counts = (items) => SM.kitCounts(Object.entries(SM.tally(items)).map(([name, count]) => ({ name, count })))
      try {
        // craft first (a crafting window cannot be open beside the chest), then open it again and deposit
        const before = counts(w.containerItems()); w.close()
        made = await craftMissing(before)
        const w2 = await openAt(b); if (w2.err) throw new Error(w2.err)
        try {
          for (const g of SM.stockGive(asItems(), counts(w2.containerItems()))) {
            const it = S.items().find(i => i.name === g.name); if (!it) continue
            try { await w2.deposit(it.type, null, g.n); gave += g.n } catch { /* chest full or item gone */ }
          }
          SM.observe(room, room.reset, w2.containerItems())
        } finally { try { w2.close() } catch {} }
      } catch (e) { try { w.close() } catch {} note('reset chest: ' + String(e && e.message || e).slice(0, 80)) }
      room.at = Date.now(); LD().putRoom(room)
      const kit = SM.kitCounts(Object.entries(SM.chestItems(room, room.reset) || {}).map(([name, count]) => ({ name, count })))
      note(`reset chest: +${gave} items (${made} crafted); it holds ${Object.entries(kit).map(([k, n]) => k + ' ' + n).join(', ')}`)
      st.resetChestRestUntil = Date.now() + (gave ? 10 : 30) * 60000; G.save()
      return gave > 0 || made > 0
    }
  }

  const restockStep = {
    id: 'reset-restock', budget: 240000, cool: 5 * 60000,
    need: () => {
      if (Date.now() < (st.resetTakeAt || 0)) return false
      const r = roomAndPlan(); if (!r || !r.room.reset) return false
      const rec = (r.room.chestInfo || {})[SM.key(r.room.reset)]
      // known to be bare of anything we lack: don't walk there (a change shows up the next time anyone stocks it)
      const short = SM.kitShort(bagCounts()); if (!short.length) return false
      if (rec && rec.at && rec.items) {
        const chestC = SM.kitCounts(Object.entries(rec.items).map(([name, count]) => ({ name, count })))
        if (!short.some(id => (chestC[id] || 0) > 0)) return false
      }
      return true
    },
    run: async () => {
      const r = roomAndPlan(); if (!r) return false
      const { room } = r
      st.resetTakeAt = Date.now() + 10 * 60000
      if (!(await G.storageGo())) { note('reset restock: could not get into the storage room'); return false }
      const b = chestBlock(room); if (!b) { note('reset restock: no reset chest at ' + room.reset); SM.forget(room, room.reset); LD().putRoom(room); return false }
      const w = await openAt(b); if (w.err) { note('reset restock: would not open (' + w.err + ')'); return false }
      let took = 0
      try {
        for (const t of SM.restockTake(w.containerItems().map(i => ({ name: i.name, count: i.count })), bagCounts())) {
          const it = w.containerItems().find(i => i.name === t.name); if (!it) continue
          try { await w.withdraw(it.type, null, t.n); took += t.n } catch { /* the bag is full or the item moved */ }
        }
        SM.observe(room, room.reset, w.containerItems())
      } finally { try { w.close() } catch {} }
      LD().putRoom(room)
      note(`reset restock: took ${took} kit items from the reset chest`)
      if (took) st.resetTakeAt = 0
      return took > 0
    }
  }

  // the planner's and the dashboard's view of the room (G.storageSummary), and the stash's record of what it deposited (G.storageObserve)
  G.storageSummary = () => { try { const room = G.storageRoom && G.storageRoom(); return room ? SM.summary(room) : null } catch { return null } }
  G.storageObserve = (pos, items) => { try { const room = G.storageRoom && G.storageRoom(); if (!room) return; SM.observe(room, pos, items.map(i => ({ name: i.name, count: i.count }))); LD().putRoom(room) } catch { /* the record is a convenience */ } }
  return { resetChestStep, restockStep }
}
