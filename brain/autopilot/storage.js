// brain/autopilot/storage.js: the central storage room off the laddered shaft (Walter 2026-11-10, Act 2 "structure"). One room per shaft,
// shared by both bots and recorded in the registry as a tracked entity (type 'storage'); double chests in a row along its walls, added in
// order as they fill. The room is dug by hand from the shaft, its walls, floor and ceiling are sealed against caves with the bot's own
// stone, and it is lit with torches (two blocks apart at least).
//
// Layout, seen from the shaft (d = away from the ladder wall, p = across):
//   shaft cell -> 2-cell corridor -> room 5 across x 7 along x 3 high; chest rows against the two long walls (across = -2 and +2),
//   pairs (k, k+1) along the room = one double chest each.
module.exports = function storage(G, S, M, api, log) {
  const bot = S.bot, { goals } = S, v = S.v, st = G.state
  const note = (m) => { try { G.note(m) } catch { log('STORAGE', m) } }
  const LD = () => M.LD
  const W = 5, LEN = 7, H = 3
  const cnt = (n) => S.count(n)

  // the room's geometry for a shaft record
  const ROT = [[1, 0], [0, 1], [-1, 0], [0, -1]]
  const turnOf = (sh) => ((st.storageTurn || {})[sh.id] || 0) % 4
  function plan(sh) {
    const wall = sh.wall || [1, 0], d0 = [-wall[0], -wall[1]], t = turnOf(sh)
    // turn 0 = straight out from the ladder wall; then the two sides; never back into the ladder wall itself
    const d = t === 0 ? d0 : t === 1 ? [d0[1], -d0[0]] : t === 2 ? [-d0[1], d0[0]] : d0, p = [d[1], -d[0]]
    const y = Math.max(sh.bottom[1] + 2, sh.entry[1] - 10)
    const s = v(sh.entry[0], y, sh.entry[2])
    const at = (k, j, h = 0) => s.offset(d[0] * k + p[0] * j, h, d[1] * k + p[1] * j)
    const corridor = [at(1, 0), at(2, 0)]
    const cells = []
    for (let k = 3; k < 3 + LEN; k++) for (let j = -2; j <= 2; j++) for (let h = 0; h < H; h++) cells.push(at(k, j, h))
    // chest spots: along both long walls, in pairs, the near end first
    const chestSpots = []
    for (const j of [-2, 2]) for (let k = 4; k + 1 < 3 + LEN; k += 3) chestSpots.push([at(k, j), at(k + 1, j)])
    const torches = [at(3, 0), at(6, 0), at(9, 0)]
    const xs = cells.map(c => c.x), zs = cells.map(c => c.z)
    const box = { x0: Math.min(...xs), x1: Math.max(...xs), y0: y, y1: y + H - 1, z0: Math.min(...zs), z1: Math.max(...zs) }
    return { y, s, d, p, at, corridor, cells, chestSpots, torches, box }
  }
  const roomOf = (sh) => (LD().rooms() || []).find(r => r.type === 'storage' && r.shaft === sh.id)
  G.storageRoom = () => { try { const sh = st.mine && st.mine.ladder ? LD().shafts().find(s => s.id === st.mine.shaft) : null; return sh ? roomOf(sh) : null } catch { return null } }

  const air = (c) => { const b = S.block(c); return b && b.boundingBox === 'empty' && !S.isLiquid(b) }
  let lastWhy = ''
  async function clear(c) { const r = await S.clearCell(c); if (r !== 'ok') lastWhy = r; return r === 'ok' }
  async function nudge(c, ms = 2500) {
    const t0 = Date.now(), tgt = c.offset(0.5, 0, 0.5)
    try {
      while (Date.now() - t0 < ms) {
        const e = bot.entity.position; if (Math.hypot(tgt.x - e.x, tgt.z - e.z) < 0.35) break
        await bot.lookAt(tgt.offset(0, 1.6, 0), true); bot.setControlState('forward', true); await new Promise(r => setTimeout(r, 100))
      }
    } finally { bot.setControlState('forward', false) }
    return bot.entity.position.floored().equals(c)
  }
  async function walk(c, ms = 15000) {
    if (bot.entity.position.floored().equals(c)) return true
    if ((await S.goto(new goals.GoalBlock(c.x, c.y, c.z), { dig: true, ms, escalate: false })).ok) return true
    return nudge(c)
  }

  async function digRoom(sh, P) {
    // down the ladder to the room's level (the shaft cell at that height has a ladder in it)
    await LD().down({ ...sh, bottom: [sh.entry[0], P.y, sh.entry[2]] })
    if (Math.abs(bot.entity.position.y - P.y) > 1.5) { note('storage: could not get down the ladder to y' + P.y); return false }
    // corridor, then the room cell by cell: the middle line first (walked along), each slice across and up
    for (const c of P.corridor) { if (!(await clear(c)) || !(await clear(c.offset(0, 1, 0)))) { note('storage: corridor blocked at ' + c + ' (' + lastWhy + ')'); if (/water|lava/.test(lastWhy)) P.liquid = true; return false }; await walk(c) }
    await walk(P.corridor[1])
    for (let k = 3; k < 3 + LEN; k++) {
      S.check()
      for (const j of [0, -1, 1, -2, 2]) for (let h = 0; h < H; h++) { const c = P.at(k, j, h); if (!air(c) && !(await clear(c))) { note('storage: could not clear ' + c + ' (' + lastWhy + '), the room stops at ' + (k - 3) + ' long'); if (/water|lava/.test(lastWhy)) P.liquid = true; return k - 3 >= 3 } }
      await walk(P.at(k, 0))
    }
    return true
  }
  // walls, floor and ceiling: any opening outside the room's shell gets a block (caves, holes), so nothing walks in
  async function seal(P) {
    let n = 0
    const inRoom = (c) => P.cells.some(q => q.equals(c)) || P.corridor.some(q => q.equals(c) || q.offset(0, 1, 0).equals(c))
    const shell = new Map()
    for (const c of P.cells) for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) { const q = c.offset(dx, dy, dz); if (!inRoom(q)) shell.set(q.toString(), q) }
    for (const q of shell.values()) {
      const b = S.block(q); if (!b || b.boundingBox === 'block') continue
      if (/torch|ladder/.test(b.name)) continue
      if (S.dist(q) > 4.5) await S.goto(new goals.GoalNear(q.x, q.y, q.z, 3), { dig: false, ms: 10000, escalate: false })
      if (await M.fill(q).catch(() => false)) n++
    }
    return n
  }
  async function light(P) {
    let n = 0
    for (const t of P.torches) {
      if (!S.has('torch')) break
      const g = S.block(t.offset(0, -1, 0)), c = S.block(t)
      if (!g || g.boundingBox !== 'block' || !c || !S.isAir(c)) continue
      if (S.dist(t) > 4) await walk(t.offset(0, 0, 0)).catch(() => false)
      if (await S.placeAgainst(g, v(0, 1, 0), 'torch').catch(() => false)) n++
    }
    return n
  }
  // into the room from wherever the bot is: by the shaft (the pathfinder climbs the ladder, up or down), then the corridor. A chest went
  // unplaced with the bot 5 blocks under the room in the mine (Smeo444 04:24), where no walk-only path reached it
  const inRoom = (P) => { const q = bot.entity.position.floored(), b = P.box; return q.x >= b.x0 - 1 && q.x <= b.x1 + 1 && q.z >= b.z0 - 1 && q.z <= b.z1 + 1 && Math.abs(q.y - P.y) <= 1 }
  async function goRoom(sh, P) {
    if (inRoom(P)) return true
    const cell = v(sh.entry[0], P.y, sh.entry[2]), me = bot.entity.position
    // into the shaft column: at the bot's own level when it is down in the mine next to the shaft, else at the top (nav's escalation from far
    // off: a walk-only path failed from 40 blocks out, Smeo444 04:28)
    if (!LD().inColumn(sh)) {
      if (me.y < sh.entry[1] - 2 && S.dist(v(cell.x, me.y, cell.z)) < 12) await LD().enterColumn(sh)
      else {
        // from the surface: to a floored cell beside the shaft top, then step into the column (the entry cell has no floor of its own)
        const ex = LD().exits(sh)[0]
        if (ex) await S.goto(new goals.GoalBlock(ex.x, ex.y, ex.z), { dig: false, ms: 90000, escalate: S.dist(v(...sh.entry)) > 6 }).catch(() => {})
        else await S.goto(new goals.GoalNear(sh.entry[0], sh.entry[1], sh.entry[2], 1), { dig: false, ms: 90000, escalate: S.dist(v(...sh.entry)) > 6 }).catch(() => {})
        const c = v(sh.entry[0], sh.entry[1], sh.entry[2]), t0 = Date.now()
        try { while (Date.now() - t0 < 2500 && !LD().inColumn(sh)) { await bot.lookAt(c.offset(0.5, 0.5, 0.5), true); bot.setControlState('forward', true); await new Promise(r => setTimeout(r, 50)) } } catch {} finally { bot.setControlState('forward', false) }
      }
    }
    // then the ladder by hand to the room's level, and off into the corridor
    await LD().rideTo(sh, P.y)
    for (const c of P.corridor) { await clear(c); await clear(c.offset(0, 1, 0)); await walk(c, 8000) }
    await walk(P.at(3, 0), 8000)
    return inRoom(P)
  }
  // dig out the room slices that hold a chest pair (and any slice between it and the open part), cell by cell as when the room was dug
  const sliceOf = (P, c) => Math.round((c.x - P.s.x) * P.d[0] + (c.z - P.s.z) * P.d[1])
  async function grow(P, pr) {
    const kEnd = Math.max(sliceOf(P, pr[0]), sliceOf(P, pr[1]))
    let dug = 0
    for (let k = 3; k <= kEnd; k++) {
      S.check()
      for (const j of [0, -1, 1, -2, 2]) for (let h = 0; h < H; h++) {
        const c = P.at(k, j, h); if (air(c)) continue
        { const b = S.block(c); if (b && /chest|barrel|torch|ladder/.test(b.name)) continue }
        if (!(await clear(c))) { note('storage: the room cannot grow past ' + (k - 3) + ' long (' + lastWhy + ')'); return false }
        dug++
      }
      await walk(P.at(k, 0), 8000)
    }
    if (dug) { const n = await seal(P); note('storage: the room grew to ' + (kEnd - 2) + ' long (' + dug + ' blocks dug, ' + n + ' openings sealed)') }
    return true
  }
  // a double chest at the next free pair of spots
  async function addDouble(room, P) {
    { const sh = LD().shafts().find(q => q.id === room.shaft); if (sh && !(await goRoom(sh, P))) { note('storage: could not get into the storage room (at ' + bot.entity.position.floored() + ')'); return false } }
    if (!S.has('chest') || cnt('chest') < 2) {
      const lg = (S.items().find(i => /_(log|wood)$/.test(i.name)) || {}).name
      if (S.planks() < 16 && lg) await S.craft(lg.replace(/^stripped_/, '').replace(/_(log|wood)$/, '_planks'), Math.min(16, S.planks() + S.logs() * 4)).catch(() => false)
      await S.craft('chest', 2).catch(() => false)
    }
    if (cnt('chest') < 2) { note('storage: no chests to add (' + cnt('chest') + ' in the bag)'); return false }
    const used = new Set((room.chests || []).map(c => c.join()))
    // a spot counts only while its cell is open on a solid floor (the room may be shorter than planned)
    const usable = (c) => { const g = S.block(c.offset(0, -1, 0)); return g && g.boundingBox === 'block' && air(c) }
    let pair = P.chestSpots.find(pr => !used.has([pr[0].x, pr[0].y, pr[0].z].join()) && usable(pr[0]) && usable(pr[1]))
    // the room grows: the next planned pair still in rock gets its slices dug out (the first room came out 3 long; OzoGo444 04:56 had chests
    // to store and no spot left)
    if (!pair) {
      const next = P.chestSpots.find(pr => !used.has([pr[0].x, pr[0].y, pr[0].z].join()))
      if (next && await grow(P, next)) pair = usable(next[0]) && usable(next[1]) ? next : null
    }
    if (!pair) { note('storage: no open pair of chest spots left in the room'); return false }
    let ok = 0
    for (const c of pair) {
      if (!usable(c)) continue
      // too far and no path: the room's middle line at the spot's slice (the floor face is in sight from there)
      if (S.dist(c) > 3.5) { const r = await S.goto(new goals.GoalNear(c.x, c.y, c.z, 2), { dig: false, ms: 15000, escalate: false }); if (!r.ok) await walk(P.at(Math.round((c.x - P.s.x) * P.d[0] + (c.z - P.s.z) * P.d[1]), 0)).catch(() => false) }
      const g = S.block(c.offset(0, -1, 0))
      if (await S.placeAgainst(g, v(0, 1, 0), 'chest').catch(() => false)) { ok++; room.chests = (room.chests || []).concat([[c.x, c.y, c.z]]) }
      else note('storage: a chest would not go down at ' + c + ' (standing ' + bot.entity.position.floored() + ')')
    }
    room.at = Date.now(); LD().putRoom(room)
    return ok === 2
  }
  G.storageGo = async () => { const room = G.storageRoom(); if (!room) return false; const sh = LD().shafts().find(q => q.id === room.shaft); return sh ? goRoom(sh, plan(sh)) : false }
  G.storageAddDouble = async () => { const room = G.storageRoom(); if (!room) return false; const sh = LD().shafts().find(s => s.id === room.shaft); return sh ? addDouble(room, plan(sh)) : false }

  return {
    id: 'storage-room', budget: 900000, cool: 300000,
    need: () => {
      if (S.isNight() || !st.mine || !st.mine.ladder || Date.now() < (st.storageRestUntil || 0)) return false
      const sh = LD().shafts().find(s => s.id === st.mine.shaft); if (!sh || !sh.bottom) return false
      if (roomOf(sh)) return false
      return cnt('torch') >= 4 && S.planks() + S.logs() * 4 >= 40 && S.count(/^(cobblestone|cobbled_deepslate|dirt|stone)$/) >= 24 && S.freeSlots() >= 6
    },
    run: async () => {
      const sh = LD().shafts().find(s => s.id === st.mine.shaft); if (!sh) return false
      const P = plan(sh)
      note(`storage: digging the storage room off the shaft at y${P.y} (${W}x${LEN}x${H})`)
      const dug = await digRoom(sh, P)
      if (!dug) {
        if (P.liquid) { st.storageTurn = st.storageTurn || {}; st.storageTurn[sh.id] = turnOf(sh) + 1; note('storage: liquid on this side, the next try turns the room') }
        st.storageRestUntil = Date.now() + (P.liquid ? 5 : 30) * 60000; G.save(); await LD().up(sh); return false
      }
      const sealed = await seal(P), lit = await light(P)
      const room = { id: 'storage-' + sh.id, type: 'storage', by: bot.username, shaft: sh.id, box: P.box, y: P.y, chests: [], at: Date.now() }
      LD().putRoom(room)
      let doubles = 0
      for (let i = 0; i < 2; i++) if (await addDouble(room, P)) doubles++
      note(`storage: room done at ${P.at(3, 0)} to ${P.at(2 + LEN, 0)} (y${P.y}): ${sealed} openings sealed, ${lit} torches, ${doubles} double chests`)
      G.save()
      await LD().up(sh)
      return true
    }
  }
}
