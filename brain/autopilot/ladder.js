// brain/autopilot/ladder.js: the one laddered mineshaft per area (Walter 2026-11-10, Act 2 "taste"). A 1x1 shaft straight down with a
// ladder on one wall, recorded in a registry both bots share and reused by anyone within 250 blocks, instead of a new staircase per trip.
// Survival-legit: every block is dug by hand in view, every ladder is crafted from sticks and placed on a wall; no digging into liquid or
// open caves (the shaft stops above them and that depth is its bottom).
//
// Registry: Downloads/bot-shared/registry.json  { worlds: { "<world key>": { shafts: [...], rooms: [...] } } }
//   world key = the world's spawn point (stable for a world, unlike the LAN port)
//   shaft = { id, by, entry:[x,y,z] (the top cell, feet level), wall:[dx,dz] (the ladder hangs on this side), bottom:[x,y,z], at, levels:[] }
//   room  = { id, type:'storage'|'mining-storage'|'farm'|..., by, shaft, box:{x0,x1,y0,y1,z0,z1}, chests:[[x,y,z],...], at }
const fs = require('fs'), path = require('path')
const FILE = process.env.BOT_REGISTRY || path.join(__dirname, '..', '..', '..', 'bot-shared', 'registry.json')

module.exports = function ladder(bot, S, goals, v, log) {
  const L = {}
  L.file = FILE
  L.worldKey = () => { const sp = bot.spawnPoint; return sp ? `spawn ${Math.floor(sp.x)},${Math.floor(sp.z)}` : 'unknown' }
  L.load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return { worlds: {} } } }
  L.save = (reg) => { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify(reg, null, 1)); fs.renameSync(FILE + '.tmp', FILE) } catch (e) { log('LADDER', 'registry write failed: ' + e.message) } }
  L.world = (reg) => { const k = L.worldKey(); reg.worlds[k] = reg.worlds[k] || { shafts: [], rooms: [] }; return reg.worlds[k] }
  L.shafts = () => L.world(L.load()).shafts
  L.rooms = () => L.world(L.load()).rooms
  L.nearestShaft = (p, r = 250) => L.shafts().filter(s => s.bottom && Math.hypot(s.entry[0] - p.x, s.entry[2] - p.z) <= r).sort((a, b) => Math.hypot(a.entry[0] - p.x, a.entry[2] - p.z) - Math.hypot(b.entry[0] - p.x, b.entry[2] - p.z))[0] || null
  L.putShaft = (sh) => { const reg = L.load(), w = L.world(reg), i = w.shafts.findIndex(s => s.id === sh.id); if (i >= 0) w.shafts[i] = sh; else w.shafts.push(sh); L.save(reg) }
  L.putRoom = (rm) => { const reg = L.load(), w = L.world(reg), i = w.rooms.findIndex(s => s.id === rm.id); if (i >= 0) w.rooms[i] = rm; else w.rooms.push(rm); L.save(reg) }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  // a full block a ladder can hang on (not leaves, glass or anything see-through)
  const solid = (p) => { const b = S.block(p); return !!b && b.boundingBox === 'block' && !S.isLiquid(b) && !/leaves|glass|ice|slab|stairs|fence|wall$|_log$|_wood$/.test(b.name) }
  const liquidNear = (p) => { for (const [dx, dy, dz] of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, 1, 0]]) { const b = S.block(p.offset(dx, dy, dz)); if (b && (S.isLiquid(b) || S.isWaterish(b) || /lava/.test(b.name))) return true } return false }
  const ladders = () => S.count('ladder')
  // 7 sticks -> 3 ladders; sticks from planks from logs (S.craft fills in the intermediates)
  L.ensureLadders = async (n) => {
    for (let k = 0; k < 8 && ladders() < n; k++) { const before = ladders(); await S.craft('ladder', Math.min(ladders() + 9, n)).catch(() => false); if (ladders() <= before) break }
    return ladders()
  }
  // place a ladder in cell c, hung on the wall at c+wall (that wall block must be solid)
  // The ladder's plate sits against the wall; the server refuses it while the player's box overlaps the plate, i.e. while the bot stands in
  // that column pressed toward the wall (04:36: 'refused to place ladder at (-6018, 50, -2355)', the bot in that very cell, off centre). So a bot
  // in the column first steps to the side away from the wall, and if the wall it has is open, any other solid side of the cell will do.
  async function awayFromWall(c, wall) {
    const e = bot.entity.position
    if (Math.floor(e.x) !== c.x || Math.floor(e.z) !== c.z || e.y > c.y + 1 || e.y + 1.8 < c.y) return
    const tgt = v(c.x + 0.5 - wall[0] * 0.28, e.y, c.z + 0.5 - wall[1] * 0.28)
    try {
      for (let i = 0; i < 12 && Math.hypot(tgt.x - bot.entity.position.x, tgt.z - bot.entity.position.z) > 0.06; i++) {
        await bot.lookAt(tgt.offset(0, 1.6, 0), true); bot.setControlState('sneak', true); bot.setControlState('forward', true); await sleep(50)
      }
    } catch {} finally { bot.setControlState('forward', false); bot.setControlState('sneak', false) }
  }
  async function hang(c, wall) {
    const cur = S.block(c); if (cur && cur.name === 'ladder') return true
    const sides = [wall, ...[[1, 0], [0, 1], [-1, 0], [0, -1]].filter(([x, z]) => x !== wall[0] || z !== wall[1])]
    for (const w0 of sides) {
      const w = S.block(c.offset(w0[0], 0, w0[1])); if (!w || w.boundingBox !== 'block' || !solid(w.position)) continue
      await awayFromWall(c, w0)
      if (await S.placeAgainst(w, v(-w0[0], 0, -w0[1]), 'ladder').catch(() => false)) return true
    }
    return false
  }

  // the shaft column (entry down to the bottom): no torches or other blocks go in it
  L.isShaftCell = (p) => L.shafts().some(sh => sh.bottom && p.x === sh.entry[0] && p.z === sh.entry[2] && p.y < sh.entry[1] && p.y >= sh.bottom[1])
  // Repair the ladder within reach: every shaft cell from the bottom up to the feet + 3 gets its ladder back. A torch (or anything see-through)
  // in the cell goes first, a missing wall block is filled with the bot's own stone. OzoGo444's shaft had no ladder at y50-51 (a torch in the
  // bottom cell, 'ladder would not hang at y50'), so neither bot could climb out from the bottom (04:29, 04:34) and one dug up into lava.
  L.repair = async (sh) => {
    if (!sh || !sh.bottom) return 0
    const wall = sh.wall || [1, 0], me = bot.entity.position, top = Math.min(sh.entry[1] - 1, Math.floor(me.y) + 3)
    let n = 0
    for (let y = sh.bottom[1]; y <= top; y++) {
      const c = v(sh.entry[0], y, sh.entry[2]), cur = S.block(c)
      if (!cur || cur.name === 'ladder') continue
      if (S.dist(c.offset(0.5, 0.5, 0.5)) > 4.5) continue
      if (cur.boundingBox === 'empty' && !/^(air|cave_air)$/.test(cur.name) && !S.isLiquid(cur)) { try { await bot.dig(cur, true) } catch {} await sleep(250) }
      const wb = c.offset(wall[0], 0, wall[1])
      if (!solid(wb)) { const f = S.items().find(i => /^(cobblestone|cobbled_deepslate|dirt|stone)$/.test(i.name)); const g = S.block(wb.offset(0, -1, 0)); if (f && g && g.boundingBox === 'block') await S.placeAgainst(g, v(0, 1, 0), f.name).catch(() => false) }
      if (ladders() < 1) await L.ensureLadders(4)
      if (await hang(c, wall)) n++
    }
    if (n) log('LADDER', 'repaired ' + n + ' ladder(s) in ' + sh.id)
    return n
  }

  // Ride the ladder by hand to level y, the bot already in the shaft column: up = face the wall and hold jump+forward; down = let go and slide
  // (about 3 blocks a second), sneaking the moment the feet reach y so it holds there. The pathfinder has no ladder moves, so a go-to from
  // inside the shaft to a level in it failed both ways (storage room: Smeo444 04:29 from below, OzoGo444 04:43 from above).
  L.inColumn = (sh) => { const e = bot.entity.position; return Math.hypot(e.x - sh.entry[0] - 0.5, e.z - sh.entry[2] - 0.5) < 0.9 }
  L.rideTo = async (sh, y, ms = 40000) => {
    if (!L.inColumn(sh)) return false
    const w = sh.wall || [1, 0], t0 = Date.now(), at = () => bot.entity.position.y
    try {
      if (at() < y - 0.2) {
        await L.repair(sh).catch(() => 0)
        await bot.lookAt(v(sh.entry[0] + 0.5 + w[0], at() + 1.6, sh.entry[2] + 0.5 + w[1]), true)
        bot.setControlState('jump', true); bot.setControlState('forward', true)
        while (Date.now() - t0 < ms && at() < y + 0.05) await sleep(50)
      } else if (at() > y + 0.2) {
        bot.clearControlStates()
        while (Date.now() - t0 < ms && at() > y + 0.1) await sleep(50)
      }
      bot.clearControlStates(); bot.setControlState('sneak', true); await sleep(300)
    } catch {} finally { bot.clearControlStates() }
    return Math.abs(at() - y) < 0.8
  }

  // dig a new laddered shaft down from entry (the bot's feet cell at the top) to targetY. Returns the shaft record (also saved).
  L.dig = async (entry, targetY, { wall = null, by = bot.username, into = null } = {}) => {
    // the ladder wall: a solid side all the way is checked as we go; start with the first solid side of the entry's column
    const sides = [[1, 0], [0, 1], [-1, 0], [0, -1]]
    wall = wall || sides.find(([dx, dz]) => solid(entry.offset(dx, -1, dz))) || [1, 0]
    if (into) wall = into.wall || wall
    const sh = into || { id: `${by}-${entry.x},${entry.z}`, by, entry: [entry.x, entry.y, entry.z], wall, bottom: null, at: Date.now(), levels: [], digging: true }
    sh.digging = true
    L.putShaft(sh)
    await S.goto(new goals.GoalBlock(entry.x, entry.y, entry.z), { dig: false, ms: 30000, escalate: false })
    if (S.flo(bot.entity.position).x !== entry.x || S.flo(bot.entity.position).z !== entry.z) { log('LADDER', 'could not stand on the shaft entry ' + entry); return null }
    let y = entry.y, why = 'target'
    for (let steps = 0; y > targetY && steps < 160; steps++) {
      S.check()
      if (ladders() < 2) { await L.ensureLadders(12); if (ladders() < 1) { why = 'no ladders'; break } }
      const c = v(entry.x, y, entry.z), below = c.offset(0, -1, 0), below2 = c.offset(0, -2, 0)
      if (liquidNear(below) || liquidNear(below2)) { why = 'liquid below'; break }
      // a cave right under the next step: the shaft ends here (falling into it is how bots died)
      const b2 = S.block(below2); if (!b2 || (b2.boundingBox === 'empty' && !solid(below2.offset(0, -1, 0)))) { why = 'open below'; break }
      // the ladder wall must be solid at the next level; if not, set a block there (its own cobblestone)
      const wb = below.offset(wall[0], 0, wall[1]); if (!solid(wb)) { const f = S.items().find(i => /^(cobblestone|cobbled_deepslate|dirt|stone)$/.test(i.name)); if (!f || !(await S.placeAgainst(S.block(wb.offset(0, -1, 0)) || S.block(wb.offset(0, 1, 0)), v(0, 1, 0), f.name).catch(() => false))) { why = 'no ladder wall'; break } }
      // dig the block under the feet, drop one block into it, then hang the ladder in that cell on the wall (the top cell is the
      // surface the bot stands on: no wall there, the ladders start one below)
      const bb = S.block(below)
      if (bb && bb.boundingBox !== 'empty') { if (!(await S.digBlock(bb, { force: true }).catch(() => false))) { why = 'could not dig y' + (y - 1); break } }
      const t0 = Date.now(); while (Date.now() - t0 < 3000 && Math.floor(bot.entity.position.y) > y - 1) await sleep(100)
      if (Math.floor(bot.entity.position.y) > y - 1) { why = 'did not drop'; break }
      y -= 1
      if (!(await hang(v(entry.x, y, entry.z), wall))) { why = 'ladder would not hang at y' + y; break }
      if (steps % 6 === 5) await S.pickup(3, 1500).catch(() => {})
    }
    sh.bottom = [entry.x, y, entry.z]; sh.digging = false; sh.end = why; sh.at = Date.now()
    L.putShaft(sh)
    if (into) sh.levels = (sh.levels || []).concat([y])
    log('LADDER', `shaft ${sh.id}: from y${entry.y} down to y${y} (${why})`)
    return sh
  }

  // ride a shaft: down to its bottom or up to its entry (the pathfinder climbs ladders; a plain walk only, never escalation)
  L.down = async (sh) => {
    const e = v(...sh.entry), b = v(...sh.bottom)
    await S.goto(new goals.GoalNear(e.x, e.y, e.z, 1), { dig: false, ms: 90000, escalate: false })
    const r = await S.goto(new goals.GoalBlock(b.x, b.y, b.z), { dig: false, ms: 90000, escalate: false })
    return r.ok || S.dist(b.offset(0.5, 0, 0.5)) < 2
  }
  L.up = async (sh) => {
    const e = v(...sh.entry), b = v(...sh.bottom)
    if (S.dist(b) > 3 && Math.abs(bot.entity.position.y - b.y) <= 3) await S.goto(new goals.GoalNear(b.x, b.y, b.z, 1), { dig: false, ms: 90000, escalate: false })
    await L.repair(sh).catch(() => 0)
    const r = await S.goto(new goals.GoalBlock(e.x, e.y, e.z), { dig: false, ms: 90000, escalate: false })
    if (r.ok || S.dist(e.offset(0.5, 0, 0.5)) < 2) return true
    // by hand: on the ladder, look at the wall and hold jump
    try { await bot.lookAt(v(e.x + 0.5 + sh.wall[0], bot.entity.position.y + 1.6, e.z + 0.5 + sh.wall[1]), true); bot.setControlState('jump', true); bot.setControlState('forward', true); const t0 = Date.now(); while (Date.now() - t0 < 40000 && bot.entity.position.y < e.y - 0.1) await sleep(100) } catch {} finally { bot.clearControlStates() }
    return S.dist(e.offset(0.5, 0, 0.5)) < 3
  }
  return L
}
