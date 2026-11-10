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
  L.save = (reg) => { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); const tmp = FILE + '.' + (bot.username || 'bot') + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(reg, null, 1)); fs.renameSync(tmp, FILE) } catch (e) { log('LADDER', 'registry write failed: ' + e.message) } }
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
  // fill the missing wall cell `wb` from a solid neighbour: the cell below it (placing on its top face), else the cell above it (placing on its bottom face). The old code
  // took whichever block object existed (an air block is an object too) and always used the top face (docs/BUG-HUNT-2026-11-10.md, finding 16).
  const wallFill = async (wb, name) => {
    const below = S.block(wb.offset(0, -1, 0)), above = S.block(wb.offset(0, 1, 0))
    const ref = below && below.boundingBox === 'block' ? { b: below, face: v(0, 1, 0) } : above && above.boundingBox === 'block' ? { b: above, face: v(0, -1, 0) } : null
    if (!ref) return false
    return await S.placeAgainst(ref.b, ref.face, name).catch(() => false)
  }
  const passable = (c) => { const b = S.block(c); return !!b && b.boundingBox === 'empty' && !S.isLiquid(b) }
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
  // Into the shaft column at the bot's own level. The pathfinder treats a cell holding a ladder as solid, so a go-to aimed at the shaft cell
  // never finds a path (OzoGo444 04:58, looping 'not out at the top' every 3 s two blocks from the shaft). Instead: walk to a side cell of the
  // column (digging it open if it is rock, with the usual liquid checks), then step in with the movement keys.
  L.enterColumn = async (sh) => {
    if (L.inColumn(sh)) return true
    const y = Math.floor(bot.entity.position.y), col = v(sh.entry[0], y, sh.entry[2]), w = sh.wall || [1, 0]
    if (y >= sh.entry[1] || y < sh.bottom[1]) return false
    const me = bot.entity.position
    const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dz]) => dx !== w[0] || dz !== w[1]).map(([dx, dz]) => col.offset(dx, 0, dz))
      .sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
    const open = (c) => passable(c) && passable(c.offset(0, 1, 0)) && solid(c.offset(0, -1, 0))
    // too far from the shaft to work a side cell: tunnel across at this level to within reach of it first (a level walk is the safe way to
    // the ladder; Smeo444 05:15 was 8 blocks off at y59 and the climb was skipped)
    if (sides.every(c => S.dist(c.offset(0.5, 0.5, 0.5)) > 4.5) && S.dist(col.offset(0.5, 0.5, 0.5)) < 24) {
      await S.goto(new goals.GoalNear(col.x, col.y, col.z, 2), { dig: true, ms: 45000, escalate: false }).catch(() => {})
      if (Math.abs(bot.entity.position.y - y) > 1.5) return false
    }
    for (const n of [...sides.filter(open), ...sides.filter(c => !open(c))]) {
      if (!open(n)) {
        if (S.dist(n.offset(0.5, 0.5, 0.5)) > 4.5 || !solid(n.offset(0, -1, 0))) continue
        if ((await S.clearCell(n)) !== 'ok' || (await S.clearCell(n.offset(0, 1, 0))) !== 'ok') continue
      }
      const fl = bot.entity.position.floored()
      if (!(fl.x === n.x && fl.z === n.z)) await S.goto(new goals.GoalBlock(n.x, n.y, n.z), { dig: false, ms: 20000, escalate: false }).catch(() => {})
      const f2 = bot.entity.position.floored(); if (!(f2.x === n.x && f2.z === n.z) && S.dist(n.offset(0.5, 0, 0.5)) > 1.2) continue
      const t0 = Date.now()
      try { while (Date.now() - t0 < 2500 && !L.inColumn(sh)) { await bot.lookAt(col.offset(0.5, 1.6, 0.5), true); bot.setControlState('forward', true); await sleep(50) } } catch {} finally { bot.setControlState('forward', false) }
      if (L.inColumn(sh)) return true
    }
    return L.inColumn(sh)
  }
  // Into the column from the surface: to a floored cell beside the shaft top, then step in (the entry cell has no floor of its own)
  L.enterTop = async (sh) => {
    if (L.inColumn(sh)) return true
    const ex = L.exits(sh)[0], far = S.dist(v(...sh.entry)) > 6
    if (ex) await S.goto(new goals.GoalBlock(ex.x, ex.y, ex.z), { dig: false, ms: 90000, escalate: far }).catch(() => {})
    else await S.goto(new goals.GoalNear(sh.entry[0], sh.entry[1], sh.entry[2], 1), { dig: false, ms: 90000, escalate: far }).catch(() => {})
    const c = v(...sh.entry), t0 = Date.now()
    try { while (Date.now() - t0 < 2500 && !L.inColumn(sh)) { await bot.lookAt(c.offset(0.5, 0.5, 0.5), true); bot.setControlState('forward', true); await sleep(50) } } catch {} finally { bot.setControlState('forward', false) }
    return L.inColumn(sh)
  }
  L.rideTo = async (sh, y, ms = 40000) => {
    if (!L.inColumn(sh)) return false
    const w = sh.wall || [1, 0], t0 = Date.now(), at = () => bot.entity.position.y
    try {
      if (at() < y - 0.2) {
        await L.repair(sh).catch(() => 0)
        await bot.lookAt(v(sh.entry[0] + 0.5 + w[0], at() + 1.6, sh.entry[2] + 0.5 + w[1]), true)
        bot.setControlState('jump', true); bot.setControlState('forward', true)
        let lastLog = Date.now(), y0 = at()
        while (Date.now() - t0 < ms && at() < y + 0.05) {
          await sleep(50)
          // the keys are held again every tick: another layer clears the controls mid-climb (logged 05:23-05:24: 'keys ' empty, collided with
          // the wall, feet in the ladder, not rising for 25 s at the shaft bottom)
          const cs = bot.controlState || {}
          if (!cs.jump || !cs.forward || cs.sneak) { try { bot.setControlState('sneak', false); bot.setControlState('jump', true); bot.setControlState('forward', true) } catch {} }
          // a climb that does not rise: say what the body sees (feet block, collision, keys) every 5 s, and press the keys again
          if (Date.now() - lastLog > 5000) {
            lastLog = Date.now()
            if (at() - y0 < 0.5) {
              const fb = S.block(bot.entity.position.floored()), cs = bot.controlState || {}
              log('LADDER', 'climb not rising at y' + at().toFixed(2) + ': feet ' + (fb && fb.name) + ', collidedH ' + !!bot.entity.isCollidedHorizontally + ', ground ' + bot.entity.onGround + ', keys ' + Object.keys(cs).filter(k => cs[k]).join('+') + ', yaw ' + bot.entity.yaw.toFixed(2))
              try { await bot.lookAt(v(sh.entry[0] + 0.5 + w[0], at() + 1.6, sh.entry[2] + 0.5 + w[1]), true); bot.setControlState('sneak', false); bot.setControlState('jump', true); bot.setControlState('forward', true) } catch {}
            }
            y0 = at()
          }
        }
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
      const wb = below.offset(wall[0], 0, wall[1]); if (!solid(wb)) { const f = S.items().find(i => /^(cobblestone|cobbled_deepslate|dirt|stone)$/.test(i.name)); if (!f || !(await wallFill(wb, f.name))) { why = 'no ladder wall'; break } }
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
  // Up and out (bug hunt 2026-11-10 #6): the entry cell has no floor (the first ladder hangs one below it), so a go-to aimed at it counted as
  // reached on the top rung and the bot slid back down when the keys were let go: ladder bobbing. Now the bot climbs by hand past the top and
  // steps off onto a floored cell beside the entry; success only when it stands on ground at entry level or above.
  L.exits = (sh) => {
    const e = v(...sh.entry), w = sh.wall || [1, 0]
    // the wall side first: holding forward against the wall at the top walks the bot straight onto it
    // at the entry's level or up to two above it: the ground beside the shaft can be higher than the entry cell (OzoGo444's shaft top at y65 has grass
    // at y65 beside it, so the way out is the cell at y66, and "exits 0" looped the climb 3 times a second)
    const out = []
    for (let dy = 0; dy <= 2; dy++) for (const [dx, dz] of [w, [-w[1], w[0]], [w[1], -w[0]], [-w[0], -w[1]]]) { const c = e.offset(dx, dy, dz); if (passable(c) && passable(c.offset(0, 1, 0)) && solid(c.offset(0, -1, 0))) out.push(c) }
    return out
  }
  const outAt = (sh) => bot.entity.onGround && bot.entity.position.y >= sh.entry[1] - 0.01 && !L.inColumn(sh) && !/ladder/.test((S.block(bot.entity.position.floored()) || {}).name || '')
  L.up = async (sh) => {
    const e = v(...sh.entry), b = v(...sh.bottom)
    if (outAt(sh)) return true
    if (S.dist(b) > 3 && Math.abs(bot.entity.position.y - b.y) <= 3) await S.goto(new goals.GoalNear(b.x, b.y, b.z, 1), { dig: false, ms: 90000, escalate: false })
    await L.repair(sh).catch(() => 0)
    if (!L.inColumn(sh)) await L.enterColumn(sh)
    const exits = L.exits(sh)
    if (L.inColumn(sh)) {
      await L.rideTo(sh, Math.max(e.y, exits.length ? exits[0].y : e.y) + 0.4, 45000)
      // step off: face an exit and walk onto it, jumping (the last rung tops out a little under the floor level)
      for (const x of exits) {
        if (outAt(sh)) break
        const t0 = Date.now()
        try {
          while (Date.now() - t0 < 2500 && !(outAt(sh) && Math.floor(bot.entity.position.x) === x.x && Math.floor(bot.entity.position.z) === x.z)) {
            await bot.lookAt(x.offset(0.5, 1.6, 0.5), true); bot.setControlState('forward', true); bot.setControlState('jump', true); await sleep(50)
          }
        } catch {} finally { bot.clearControlStates() }
      }
    }
    if (!outAt(sh) && exits.length) await S.goto(new goals.GoalBlock(exits[0].x, exits[0].y, exits[0].z), { dig: false, ms: 20000, escalate: false }).catch(() => {})
    const ok = outAt(sh)
    if (!ok) log('LADDER', 'up ' + sh.id + ': not out at the top (at ' + bot.entity.position.floored() + ', exits ' + exits.length + ')')
    return ok
  }
  return L
}
