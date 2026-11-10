// brain/autopilot/discard.js: getting rid of junk (Walter 2026-11-10: "they should be discarding wooden tools ... typically you'd put the thing in
// a place you won't pick back up so that it just despawns ... maybe for a bot the best thing is like a closet exclusively for this purpose").
//
// Junk policy (S.junk): a wooden tool once a stone-or-better tool of the same kind is in the bag; poisonous potatoes. Never a tool that is
// the best of its kind, never anything else.
// Where it goes, in order:
//   1. furnace fuel: S.fuelPlan burns a junk wooden tool first when it covers the job (one item smelted each); that uses it up.
//   2. the junk chest, a single chest by the entrance of the storage room, recorded in the room (room.junk) and never taken from. Items on
//      the ground are against rule 4 (no item piles) and the bots would pick them back up; a lava pit can take over the burning once the
//      Act 2 lava farm exists.
module.exports = function discard(G, S, M, api, log) {
  const bot = S.bot, { goals } = S, v = S.v, st = G.state
  const note = (m) => { try { G.note(m) } catch { log('DISCARD', m) } }
  const SM = require('../storage-model')
  const KINDS = ['pickaxe', 'axe', 'shovel', 'sword', 'hoe']
  const TIER = (n) => /netherite/.test(n) ? 6 : /diamond/.test(n) ? 5 : /iron/.test(n) ? 4 : /stone/.test(n) ? 3 : /golden/.test(n) ? 2 : /wooden/.test(n) ? 1 : 0
  S.junk = () => {
    const items = bot.inventory.items(), out = []
    for (const k of KINDS) {
      const all = items.filter(i => new RegExp('_' + k + '$').test(i.name) && !(k === 'axe' && /pickaxe/.test(i.name)))
      if (all.some(i => TIER(i.name) >= 3)) for (const i of all) if (/^wooden_/.test(i.name)) out.push(i)
    }
    for (const i of items) if (i.name === 'poisonous_potato') out.push(i)
    return out
  }
  const LD = () => M.LD
  // the junk chest's spot: a single-chest spot of the room (brain/storage-model.js singleSpot), spots where opening failed are skipped (room.junkBad)
  async function junkChest(room, P) {
    if (room.junk) { const b = S.block(v(...room.junk)); if (b && b.name === 'chest') return b }
    const c = SM.singleSpot(P, (q) => S.block(q), (room.junkBad || []).concat(room.reset ? [room.reset] : [])); if (!c) return null
    if (!S.has('chest')) await S.craft('chest', 1).catch(() => false)
    if (!S.has('chest')) return null
    const g = S.block(c.offset(0, -1, 0))
    if (!(await S.placeAgainst(g, v(0, 1, 0), 'chest').catch(() => false))) return null
    SM.setJunk(room, c); LD().putRoom(room)
    note('discard: junk chest set up at ' + c + ' by the storage room entrance (never taken from)')
    return S.block(c)
  }
  return {
    id: 'discard', budget: 180000, cool: 600000,
    need: () => !S.isNight() && S.junk().length > 0 && !!(G.storageRoom && G.storageRoom()) && !!G.storagePlan,
    run: async () => {
      const room = G.storageRoom(), P = G.storagePlan(); if (!room || !P) return false
      if (!(await G.storageGo())) { note('discard: could not get into the storage room'); return false }
      const ch = await junkChest(room, P); if (!ch) { note('discard: no junk chest (no chest to place, or no spot)'); return false }
      let n = 0
      if (G.storageClearAbove) await G.storageClearAbove(ch.position).catch(() => false)
      try {
        const w = await bot.openContainer(S.block(ch.position) || ch)
        for (const it of S.junk()) { try { await w.deposit(it.type, null, it.count); n += it.count } catch {} }
        w.close()
      } catch (e) {
        // it would not open (covered, or a ghost block): this spot is dropped and the next try sets up a junk chest elsewhere in the room
        note('discard: the junk chest at ' + ch.position + ' would not open (' + e.message.slice(0, 60) + '), a new spot next time')
        room.junkBad = (room.junkBad || []).concat([[ch.position.x, ch.position.y, ch.position.z]]); SM.forget(room, ch.position); LD().putRoom(room)
        return false
      }
      note('discard: ' + n + ' junk item(s) put away in the junk chest')
      return n > 0
    }
  }
}
