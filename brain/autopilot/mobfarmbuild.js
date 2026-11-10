// brain/autopilot/mobfarmbuild.js: builds the underground mob farm (Walter 2026-11-10, ROADMAP Phase 2 item 8; benchmark: Smeo's farm in the prior
// world). It hangs off the laddered shaft at two levels 22 blocks apart: a dark diamond-shaped spawning platform with a water trench through its
// middle that washes the mobs into a one-block drop, and under it a kill chamber where they land (1 to 2 HP left, so the kill and its XP are the
// bot's) on a hopper that feeds a chest. The shape is brain/mobfarm/geometry.js (pure, tested, and checked against vanilla physics by
// tools/trial/mobfarm-lab.js); this file only walks the lists.
//
// Survival-legit: every block is dug by hand in view (S.clearCell), the shell is sealed with the bot's own stone, the farm's last act is to plug the
// platform corridor with stone (a dark room nothing can walk into, and no torch light in it: monsters spawn only at block light 0). The drop column has
// no ladder in it (a ladder would cancel the fall). Nothing outside the farm's own cells is ever dug; a no-dig zone, an established build, lava or
// water next to a cell stops the build there.
//
// It works in phases that survive a restart (st.mobFarmBuild.phase):
//   chamber   corridor at the kill level, the stair, the chest and hopper cells
//   platform  corridor, the diamond room, the trench and the hole
//   column    down the hole, one block at a time, sealing cave openings on the way; out through the chamber
//   fit       chest and hopper (hopper facing down, placed on the chest), torches in the corridor, the slit
//   water     the two sources at the trench tips, placed from the pads beside them; then the plug in the corridor
//   done      registry rooms + brain/state/mobfarm.json for the kill routine (brain/autopilot/mobfarm.js) and the roadmap predicate 2.8
//
// Think-brain: the skill `mob_farm` (action build|work|status) in think.js; fallback routine step `mob-farm-build` (below).
const fs = require('fs')
const MF = require('../mobfarm/geometry')

module.exports = function mobfarmbuild(G, S, M, api, log) {
  const bot = S.bot, { goals } = S, v = S.v, st = G.state
  const note = (m) => { try { G.note(m) } catch { log('MOBFARMBUILD', m) } }
  const LD = () => M.LD
  const sleep = (ms) => S.wait(ms)
  const cnt = (n) => S.count(n)
  const cv = (c) => v(c[0], c[1], c[2])
  const here = () => S.flo(bot.entity.position)
  const B = () => (st.mobFarmBuild = st.mobFarmBuild || {})
  const FILLER = /^(cobblestone|cobbled_deepslate|dirt|stone|netherrack|andesite|diorite|granite|tuff)$/
  const PHASES = ['chamber', 'platform', 'column', 'fit', 'water', 'done']

  const air = (c) => { const b = S.block(cv(c)); return !!b && b.boundingBox === 'empty' && !S.isLiquid(b) }
  const solid = (c) => { const b = S.block(cv(c)); return !!b && b.boundingBox === 'block' && !S.isLiquid(b) }
  let lastWhy = ''
  const stop = (why) => { lastWhy = why + ' (bot at ' + here() + ')'; return false }

  // ------------------------------------------------------------------ where
  const shaftOf = () => { const b = B(); const all = LD().shafts(); return (b.shaft && all.find(s => s.id === b.shaft)) || (st.mine && st.mine.ladder ? all.find(s => s.id === st.mine.shaft) : null) }
  function layoutFor(sh, b) {
    const wall = sh.wall || [1, 0], d0 = [-wall[0], -wall[1]]
    const d = b.turn === 1 ? [d0[1], -d0[0]] : b.turn === 2 ? [-d0[1], d0[0]] : d0
    return MF.layout({ ox: sh.entry[0], oz: sh.entry[2], d, yPlatform: b.Yp })
  }
  // the first spot that does not touch another room; remembered so every later call finds the same one
  function choose(sh) {
    const b = B()
    if (b.shaft === sh.id && b.Yp != null) return layoutFor(sh, b)
    const rooms = LD().rooms().filter(r => r.shaft === sh.id || !r.shaft)
    const c = MF.candidates(sh, rooms)
    for (const cand of c.list) {
      const L = layoutFor(sh, { turn: cand.turn, Yp: cand.Yp })
      // never plan into a no-dig area or an established build
      if (L.dig.some(q => S.noDigAt && S.noDigAt({ x: q[0], y: q[1], z: q[2] }))) continue
      if ((b.skip || []).includes(cand.turn + ':' + cand.shift)) continue
      st.mobFarmBuild = { phase: 'chamber', shaft: sh.id, turn: cand.turn, shift: cand.shift, Y0: cand.Y0, Yp: cand.Yp, skip: b.skip || [], fails: b.fails || 0, at: Date.now() }
      G.save(); return L
    }
    lastWhy = c.why || 'no spot clear of other rooms and no-dig areas'
    if (c.needBottom != null) b.needBottom = c.needBottom
    return null
  }

  // ------------------------------------------------------------------ bag
  const water = () => cnt('water_bucket')
  const needs = () => {
    const n = {}
    if (!bot.inventory.items().some(i => /_pickaxe$/.test(i.name))) n.pickaxe = 1
    if (cnt('hopper') < 1) n.hopper = 1
    if (cnt('chest') < 1 && cnt('hopper') < 1) n.chest = 1
    if (water() < 2) n.water_bucket = 2 - water()
    if (cnt('torch') < 4) n.torch = 4 - cnt('torch')
    const filler = S.count(FILLER) - 0
    if (filler < 24) n.filler = 24 - filler
    return n
  }
  // hopper = 5 iron + chest; bucket = 3 iron; chest = 8 planks. The bot crafts what it can; water comes from a lake it has seen.
  async function stock() {
    if (cnt('hopper') < 1) {
      if (cnt('chest') < 1) { await S.craft('chest', 1).catch(() => false) }
      await S.craft('hopper', 1).catch(() => false)
    }
    if (water() < 2) {
      const empty = cnt('bucket')
      if (empty + water() < 2) await S.craft('bucket', 2 - empty - water()).catch(() => false)
      await fillBuckets(2 - water()).catch((e) => { if (S.isAbort(e)) throw e; return 0 })
    }
    if (!S.has('chest') && cnt('hopper') < 1) await S.craft('chest', 1).catch(() => false)
    return Object.keys(needs()).length === 0
  }
  // scoop water with empty buckets from the nearest water source block it can see and walk to
  async function fillBuckets(n) {
    let got = 0
    for (let i = 0; i < n; i++) {
      S.check()
      const bk = S.items().find(x => x.name === 'bucket'); if (!bk) break
      const src = bot.findBlock({ matching: (b) => b && b.name === 'water' && b.metadata === 0, maxDistance: 64 })
      if (!src) { note('mob farm: no water source in sight to fill a bucket'); break }
      const near = src.position.offset(0, 1, 0), before = water()
      await S.goto(new goals.GoalNear(near.x, near.y, near.z, 3), { dig: false, ms: 60000, escalate: false })
      try { await bot.equip(bk, 'hand'); await bot.lookAt(src.position.offset(0.5, 0.9, 0.5), true); bot.activateItem(); await sleep(600) } catch (e) { if (S.isAbort(e)) throw e }
      if (water() > before) got++
    }
    return got
  }

  // ------------------------------------------------------------------ moving and digging
  async function nudge(c, ms = 2500) {
    const t0 = Date.now(), tgt = cv(c).offset(0.5, 0, 0.5)
    try {
      while (Date.now() - t0 < ms) {
        const e = bot.entity.position; if (Math.hypot(tgt.x - e.x, tgt.z - e.z) < 0.35) break
        await bot.lookAt(tgt.offset(0, 1.6, 0), true); bot.setControlState('forward', true); await new Promise(r => setTimeout(r, 100))
      }
    } finally { bot.setControlState('forward', false) }
    return here().equals(cv(c))
  }
  async function walk(c, ms = 20000) {
    if (here().equals(cv(c))) return true
    if ((await S.goto(new goals.GoalBlock(c[0], c[1], c[2]), { dig: false, ms, escalate: false })).ok) return true
    return nudge(c)
  }
  // The ladder cell has a 'block' bounding box in this data set, so from a rung the eye's own ray starts inside a solid and S.canSee never passes;
  // a player on a ladder digs the wall beside the rung without any trouble, so the two cells next to the shaft are dug straight from the rung
  // (same hazard checks as clearCell: no lava or water next to the cell).
  async function digFromRung(c) {
    const b = S.block(cv(c)); if (!b) return false
    if (S.passable(b)) return true
    const h = S.hazardNear(cv(c), 1)
    if (h.lava || h.water || S.isLiquid(b)) { lastWhy = 'liquid at ' + c; return false }
    if (S.noDigAt && S.noDigAt(b.position, b.name)) { lastWhy = 'no-dig area at ' + c; return false }
    if (!(await S.equipFor(b))) return false
    try { await bot.lookAt(cv(c).offset(0.5, 0.5, 0.5), true); await bot.dig(b, true) } catch { return false }
    await sleep(200)
    return S.passable(S.block(cv(c)))
  }
  // Dig one cell of the farm. S.clearCell/S.approach are not used here: when a block is out of sight they dig "whatever the crosshair hits" and
  // pathfind with digging on, which in a sealed room means tunnelling out through the ceiling (the first lab run surfaced 5 blocks up). Here the
  // bot only ever stands in cells that are already open (viewpoints), and only the wanted block is broken.
  const SIX = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
  async function mine(c) {
    const p = cv(c); let b = S.block(p)
    if (!b) return 'fail'
    if (S.passable(b)) return 'ok'
    if (b.name === 'lava') return 'lava'
    if (S.isWaterish(b)) return 'water'
    const h = S.hazardNear(p, 1)
    if (h.lava) return 'lava'
    if (h.water && SIX.some(([dx, dy, dz]) => S.isWaterish(S.block(p.offset(dx, dy, dz))))) return 'water'
    if (S.noDigAt && S.noDigAt(b.position, b.name)) return 'nodig'
    const los = require('../los')
    const reachOk = () => S.eye().distanceTo(p.offset(0.5, 0.5, 0.5)) <= 3.8
    if (!(reachOk() && S.canSee(b))) {
      for (const f of los.viewpoints(bot, p, { reach: 3.5, max: 4 })) {
        const r = await S.goto(new goals.GoalBlock(f.x, f.y, f.z), { dig: false, ms: 15000, escalate: false })
        if ((r.ok || S.dist(f.offset(0.5, 0, 0.5)) < 1.2) && reachOk() && S.canSee(b)) break
      }
      if (!(reachOk() && S.canSee(b))) return 'fail'
    }
    const havePick = () => bot.inventory.items().some(i => /_pickaxe$/.test(i.name))
    const makePick = async () => {
      // a stone pickaxe lasts 131 blocks and the farm is some 800: make the next one (3 cobblestone and 2 sticks)
      if (!S.has('stick', 2) && S.planks() + S.logs() * 4 >= 2) await S.craft('stick', 4).catch(() => false)
      await S.craft('stone_pickaxe', 1).catch(() => false)
      if (!havePick()) await S.craft('wooden_pickaxe', 1).catch(() => false)
      await S.reclaim().catch(() => false)                  // the portable crafting table it set down for the recipe
      return havePick()
    }
    if (S.freeSlots() < 2) { lastWhy = 'the bag is full'; return 'bagfull' }
    let dug = false
    for (let attempt = 0; attempt < 3 && !dug; attempt++) {
      // a pickaxe can break in the middle of a block: look again each time
      if (!havePick() && !(await makePick())) { lastWhy = 'no pickaxe left and cannot make one (3 cobblestone, 2 sticks)'; return 'nopick' }
      dug = await S.digBlock(S.block(p) || b, { force: true })
      if (!dug) {
        // once more from the nearest spot with a view (a dig that starts at the edge of reach can be refused)
        const vp = los.viewpoints(bot, p, { reach: 3.0, max: 1 })[0]
        if (vp && S.dist(vp.offset(0.5, 0, 0.5)) > 1.2) await S.goto(new goals.GoalBlock(vp.x, vp.y, vp.z), { dig: false, ms: 10000, escalate: false })
      }
    }
    if (!dug) return 'fail'
    // a gravel or sand column above refills the cell as it falls: keep digging until it stays open
    for (let i = 0; i < 12; i++) {
      await sleep(300)
      const nb = S.block(p)
      if (!nb || S.passable(nb)) return 'ok'
      if (!/gravel|sand|concrete_powder|suspicious/.test(nb.name)) return 'ok'
      if (!(await S.digBlock(nb, { force: true }))) return 'fail'
    }
    return S.passable(S.block(p)) ? 'ok' : 'fail'
  }
  async function open(c) {
    if (air(c)) return true
    const r = await mine(c)
    if (r !== 'ok') { if (r === 'nopick' || r === 'bagfull') return false; const b0 = S.block(cv(c)); lastWhy = r + ' at ' + c + ' from ' + here() + (b0 ? ' (' + b0.name + ', seen ' + S.canSee(b0) + ')' : ''); return false }
    return true
  }
  async function digList(cells) {
    for (const c of cells) { S.check(); if (!(await open(c))) return false }
    return true
  }

  async function stepIntoShaft(sh) {
    const w = sh.wall || [1, 0], side = [sh.entry[0] - w[0], sh.entry[1], sh.entry[2] - w[1]]
    await S.goto(new goals.GoalBlock(side[0], side[1], side[2]), { dig: false, ms: 60000, escalate: S.dist(cv(side)) > 8 })
    const mid = v(sh.entry[0] + 0.5, sh.entry[1], sh.entry[2] + 0.5), t0 = Date.now()
    try {
      while (Date.now() - t0 < 4000 && bot.entity.position.y > sh.entry[1] - 0.6) {
        await bot.lookAt(mid.offset(0, 1.6, 0), true); bot.setControlState('forward', true); await new Promise(r => setTimeout(r, 60))
        if (Math.hypot(bot.entity.position.x - mid.x, bot.entity.position.z - mid.z) < 0.25) bot.setControlState('forward', false)
      }
    } finally { bot.setControlState('forward', false) }
    return bot.entity.position.y < sh.entry[1] - 0.5
  }
  // into the shaft and to the level, then one step into the corridor (like the storage room)
  async function goLevel(sh, y, firstCell) {
    const col = v(sh.entry[0], y, sh.entry[2])
    const at = bot.entity.position
    if (Math.abs(at.y - y) <= 1.5 && Math.hypot(at.x - col.x - 0.5, at.z - col.z - 0.5) < 14) return true
    // The shaft: from the surface step in over the open top cell from the side opposite the ladder wall; from inside the mine get into the column;
    // then ride by hand (down = let go and slide, up = hold jump and forward) to the level.
    const inTight = () => Math.hypot(bot.entity.position.x - sh.entry[0] - 0.5, bot.entity.position.z - sh.entry[2] - 0.5) < 0.3
    if (!inTight()) {
      if (at.y >= sh.entry[1] - 1) await stepIntoShaft(sh)
      else if (!LD().inColumn(sh)) await LD().enterColumn(sh)
    }
    if (inTight() || LD().inColumn(sh)) await LD().rideTo(sh, y)
    if (Math.abs(bot.entity.position.y - y) > 1.5) return stop('could not ride the shaft to y' + y + ' (at ' + here() + ')')
    // the pathfinder stops on the top of the rung cell: settle with the feet at the level (the eye must see the corridor cells)
    if (LD().inColumn(sh) && bot.entity.position.y > y + 0.25) await LD().rideTo(sh, y)
    const w = firstCell
    // from the ladder the head cell is the one in plain view (the eye is a block and a half above the feet): dig it first, then the feet cell,
    // holding still on the rung with sneak meanwhile
    if (!air(w) || !air([w[0], w[1] + 1, w[2]])) {
      const inCol = LD().inColumn(sh); if (inCol) bot.setControlState('sneak', true)
      try { for (const q of [[w[0], w[1] + 1, w[2]], w]) { if (air(q)) continue; if (inCol ? !(await digFromRung(q)) : !(await open(q))) return stop('fail at ' + q) } } finally { if (inCol) bot.setControlState('sneak', false) }
    }
    await walk(w, 8000)
    return true
  }

  // Pickaxes for the job in hand, made at the shaft before going into the rock (a stone pickaxe is good for 131 blocks; the chamber is ~100 blocks,
  // the platform ~380, the column 22). The crafting table the recipe needs is picked up again, not left in the room.
  async function ensurePicks(n) {
    const have = () => bot.inventory.items().filter(i => /_pickaxe$/.test(i.name)).reduce((a, i) => a + i.count, 0)
    for (let t = 0; t < n + 2 && have() < n; t++) {
      if (!S.has('stick', 2) && S.planks() + S.logs() * 4 >= 2) await S.craft('stick', 4).catch(() => false)
      const before = have()
      await S.craft('stone_pickaxe', Math.min(n, S.count('stone_pickaxe') + 1)).catch(() => false)
      if (have() <= before) break
    }
    await S.reclaim().catch(() => false)
  }
  // The walker may bridge a one-block gap with a cobblestone now and then (a trench cell is a gap to it). Anything solid left in the trench or the
  // hole would dam the water: dig it out again before the sources go in.
  async function cleanTrench(L) {
    let n = 0
    for (const c of L.platform.trench.concat([L.platform.hole])) {
      const b = S.block(cv(c)); if (!b || S.passable(b) || S.isLiquid(b)) continue
      if (await open(c)) n++
    }
    if (n) note(`mob farm: ${n} stray block(s) taken out of the trench`)
    return n
  }

  // ------------------------------------------------------------------ phases
  async function phaseChamber(L, sh) {
    const C = L.chamber
    if (!(await goLevel(sh, L.Y0, C.corridor[0]))) return false
    // corridor, feet cell then head cell, then the stair beside it and the chest and hopper cells
    if (!(await digList(C.corridor))) return false
    if (!(await digList(C.stairs))) return false
    if (!(await walk(C.standAtChest, 15000))) return stop('cannot stand at the chest spot ' + C.standAtChest)
    if (!(await open(C.chest)) || !(await open(C.hopper))) return false
    await sealShell(L, chamberCells(L))
    return true
  }
  const chamberCells = (L) => L.chamber.corridor.concat(L.chamber.stairs, [L.chamber.chest, L.chamber.hopper])

  // Every cell has to be dug from a cell that is already open and next to it (the eye must see it from where the bot can stand): grow from the
  // given open cells, always taking the nearest open-adjacent cell to the last one dug, same level first, head cells after the feet cells under them.
  function frontierOrder(cells, starts, lastAt, floorY = null) {
    const todo = new Map(cells.map(c => [MF.key(c), c]))
    const isOpen = new Set(starts.map(MF.key)); for (const [k, c] of todo) if (air(c)) isOpen.add(k)
    const out = []; let last = starts.length ? starts[starts.length - 1] : cells[0]
    const nbs = (c) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map(([dx, dy, dz]) => MF.key([c[0] + dx, c[1] + dy, c[2] + dz]))
    while (todo.size) {
      let best = null, bc = Infinity
      for (const c of todo.values()) {
        if (!nbs(c).some(k => isOpen.has(k))) continue
        const cost = Math.abs(c[0] - last[0]) + Math.abs(c[2] - last[2]) + 1.5 * Math.abs(c[1] - last[1]) + (floorY != null ? (c[1] > floorY ? 0.4 : c[1] < floorY ? 2.5 : 0) : 0)
        if (cost < bc) { bc = cost; best = c }
      }
      if (!best) { for (const c of todo.values()) out.push(c); break }       // not reachable (should not happen); the dig will say so
      out.push(best); todo.delete(MF.key(best)); isOpen.add(MF.key(best)); last = best
    }
    return out
  }
  // The platform one column at a time: a column (k, j) is entered only from a finished column next to it, feet cell, head cell, then the floor cell
  // of a trench or hole column. Each target is then next to the cell the bot stands in, at eye or foot height, so it can always be seen.
  function platformOrder(L) {
    const P = L.platform, cols = new Map()
    for (const c of P.air.concat(P.trench, [P.hole])) { const kj = L.kj(c), key = kj.join(','); if (!cols.has(key)) cols.set(key, { kj, cells: [] }); cols.get(key).cells.push(c) }
    for (const col of cols.values()) col.cells.sort((a, b) => (a[1] >= L.Yp ? 0 : 1) - (b[1] >= L.Yp ? 0 : 1) || a[1] - b[1])
    const done = new Set(['1,0', '2,0'].filter(k => cols.has(k) === false)), out = []
    for (const k of ['1,0', '2,0']) done.add(k)
    let last = [2, 0]
    while (cols.size) {
      let best = null, bc = Infinity
      for (const col of cols.values()) {
        const [k, j] = col.kj
        if (![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dk, dj]) => done.has((k + dk) + ',' + (j + dj)))) continue
        const cost = Math.abs(k - last[0]) + Math.abs(j - last[1])
        if (cost < bc) { bc = cost; best = col }
      }
      if (!best) { for (const col of cols.values()) out.push(...col.cells); break }
      out.push(...best.cells); done.add(best.kj.join(',')); cols.delete(best.kj.join(',')); last = best.kj
    }
    return out
  }
  async function phasePlatform(L, sh) {
    const P = L.platform
    if (!(await goLevel(sh, L.Yp, P.corridor[0]))) return false
    if (!(await digList(P.corridor))) return false
    const order = platformOrder(L)
    let n = 0
    for (const c of order) {
      S.check()
      if (air(c)) continue
      if (!(await open(c))) { note(`mob farm: the platform stops at ${c} (${lastWhy})`); return false }
      if (++n % 25 === 0) { S.progress && S.progress('mob farm platform'); await S.pickup(4, 800).catch(() => {}) }
    }
    const sealed = await sealShell(L, P.air.concat(P.trench, [P.hole], P.corridor))
    note(`mob farm: platform dug (${order.length} cells), ${sealed} openings sealed`)
    return true
  }

  // seal every opening in the shell around the given open cells that the bot can reach (cave mouths, old tunnels)
  async function sealShell(L, cells) {
    const set = new Set(cells.map(MF.key)); let n = 0, bad = 0
    const shell = new Map()
    for (const c of cells) for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) { const q = [c[0] + dx, c[1] + dy, c[2] + dz]; if (!set.has(MF.key(q)) && !L.isOpen(q)) shell.set(MF.key(q), q) }
    for (const q of shell.values()) {
      const b = S.block(cv(q)); if (!b || b.boundingBox === 'block') continue
      if (/torch|ladder/.test(b.name)) continue
      if (S.isLiquid(b)) { bad++; continue }
      if (S.dist(cv(q)) > 4.5) await S.goto(new goals.GoalNear(q[0], q[1], q[2], 3), { dig: false, ms: 10000, escalate: false })
      if (await M.fill(cv(q)).catch(() => false)) n++; else bad++
    }
    if (bad) note(`mob farm: ${bad} shell openings could not be sealed`)
    return n
  }
  // down the hole, one block at a time; the column is the farm's only vertical, with no ladder
  async function phaseColumn(L, sh) {
    const P = L.platform
    if (!(await goLevel(sh, L.Yp, P.corridor[0]))) return false
    if (!(await walk(P.standBeforeHole, 30000))) return stop('cannot reach the hole from the corridor')
    // already below? (a restart in the middle)
    const col = L.column.concat([L.chamber.hopper, L.chamber.chest])
    const idx = () => { const p = bot.entity.position; if (Math.floor(p.x) === P.hole[0] && Math.floor(p.z) === P.hole[2]) return col.findIndex(c => c[1] === Math.floor(p.y)); return -1 }
    // step into the hole cell (its floor is gone: the bot drops one block)
    if (idx() < 0) {
      const tgt = [P.hole[0], L.Yp, P.hole[2]]
      await nudge(tgt, 3000)
      await sleep(600)
    }
    for (let guard = 0; guard < 40; guard++) {
      S.check()
      let i = idx()
      if (i < 0) { if (Math.abs(bot.entity.position.y - L.chamber.chest[1]) < 1.5) break; return stop('left the column at ' + here()) }
      if (col[i][1] <= L.chamber.chest[1]) break
      const nxt = col[i + 1]; if (!nxt) break
      if (air(nxt)) { await sleep(500); if (idx() === i) { await nudge(nxt, 1500) } continue }
      // lava or water next to or under the next cell: stop and climb out
      const h = S.hazardNear(cv(nxt), 1)
      const under = S.block(cv([nxt[0], nxt[1] - 1, nxt[2]]))
      if (h.lava || h.water || (under && (under.name === 'lava' || S.isLiquid(under)))) { note(`mob farm: liquid by the column at y${nxt[1]}; climbing out`); await climbOut(i); return stop('liquid by the column at y' + nxt[1]) }
      const b = S.block(cv(nxt))
      if (S.noDigAt && S.noDigAt(b.position, b.name)) { await climbOut(i); return stop('no-dig area at the column') }
      if (!(await S.digBlock(b, { force: true }))) { await climbOut(i); return stop('could not dig the column at y' + nxt[1]) }
      for (let t = 0; t < 12 && idx() === i; t++) await sleep(150)
      i = idx(); if (i < 0) { await sleep(400); i = idx() }
      // seal what the new cell opened to the sides
      if (i >= 0) await sealAround(col[i])
    }
    // out through the chamber: the column's bottom is the chest cell; the stair leads up to the corridor
    if (!(await walk(L.chamber.K, 40000))) return stop('cannot get out of the column bottom to the kill spot')
    note('mob farm: the drop column is dug (' + L.column.length + ' blocks)')
    return true
  }
  async function sealAround(c) {
    const column = (q) => q[0] === c[0] && q[2] === c[2]
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1]) {
      const q = [c[0] + dx, c[1] + dy, c[2] + dz]; if (column(q) || bot.entity.position.y > c[1] + 3) continue
      if (typeof G._mfOpen === 'function' && G._mfOpen(q)) continue
      const b = S.block(cv(q)); if (!b || b.boundingBox === 'block' || S.isLiquid(b)) continue
      await M.fill(cv(q)).catch(() => false)
    }
  }
  // out of a half-dug column: stack blocks under the feet until the platform is reached, or fall back to digging on down (the bottom is open)
  async function climbOut(i) {
    const motor = require('../motor')
    for (let k = 0; k < 24; k++) {
      S.check()
      const mat = ['cobblestone', 'dirt', 'cobbled_deepslate', 'stone', 'netherrack', 'andesite', 'diorite', 'granite'].find(m => S.has(m)); if (!mat) return false
      const base = here(); const ref = S.block(base.offset(0, -1, 0)); if (!ref) return false
      const eq = await motor.equip(bot, bot.inventory.items().find(x => x.name === mat)); if (!eq.ok) return false
      await motor.jumpPlaceUnder(bot, { ref, feetY: base.y, held: eq.value, reequip: () => motor.equip(bot, bot.inventory.items().find(x => x.name === mat)), checkpoint: () => S.check() })
      if (Math.floor(bot.entity.position.y) >= (B().Yp || 0)) return true
    }
    return false
  }

  // chest, then the hopper on top of it (a hopper placed on a chest's top face points down into it), torches, the slit
  async function phaseFit(L, sh) {
    const C = L.chamber
    if (cnt('hopper') < 1 && !(await stock()) && cnt('hopper') < 1) return stop('need a hopper (5 iron and a chest)')
    if (!(await goLevel(sh, L.Y0, C.corridor[0]))) return false
    if (!(await walk(C.standAtChest, 40000))) return stop('cannot stand at the chest spot')
    if (!bot.inventory.items().some(i => /^chest$/.test(i.name)) && !(await S.craft('chest', 1).catch(() => false))) return stop('no chest to place')
    const cb = S.block(cv(C.chest))
    if (!cb || !/^chest$/.test(cb.name)) {
      const floor = S.block(cv([C.chest[0], C.chest[1] - 1, C.chest[2]]))
      if (!floor || floor.boundingBox !== 'block') return stop('no floor under the chest spot')
      if (!(await S.placeAgainst(floor, v(0, 1, 0), 'chest'))) return stop('the chest would not go down at ' + C.chest)
      await sleep(300)
    }
    const hb = S.block(cv(C.hopper))
    if (!hb || hb.name !== 'hopper') {
      const chest = S.block(cv(C.chest)); if (!chest || chest.name !== 'chest') return stop('the chest is not there')
      if (cnt('hopper') < 1) return stop('no hopper')
      // clicking a chest opens it; sneaking makes the click a placement
      bot.setControlState('sneak', true); await sleep(250)
      let placed = false
      try { placed = await S.placeAgainst(chest, v(0, 1, 0), 'hopper') } finally { bot.setControlState('sneak', false) }
      if (!placed) return stop('the hopper would not go down at ' + C.hopper)
      await sleep(300)
    }
    // torches along the kill corridor (never near the platform: only this level, and the drop column is 22 high)
    for (const t of C.torches) {
      if (!S.has('torch')) break
      const g = S.block(cv([t[0], t[1] - 1, t[2]])), at = S.block(cv(t))
      if (!g || g.boundingBox !== 'block' || !at || !S.isAir(at)) continue
      if (S.dist(cv(t)) > 4) await walk(t, 8000)
      await S.placeAgainst(g, v(0, 1, 0), 'torch').catch(() => false)
    }
    // the slit, from the kill spot
    if (!(await walk(C.K, 20000))) return stop('cannot stand at the kill spot')
    if (!air(C.slit) && !(await open(C.slit))) return false
    return true
  }

  // the sources go in from the pads beside the tips; the corridor plug closes the room
  async function phaseWater(L, sh) {
    const P = L.platform
    if (water() < 2) { await stock(); if (water() < 2) return stop('need 2 water buckets, have ' + water()) }
    if (!(await goLevel(sh, L.Yp, P.corridor[0]))) return false
    if (!(await walk(P.entry, 20000))) return stop('cannot walk into the platform')
    await cleanTrench(L)
    for (let s = 0; s < P.sources.length; s++) {
      const src = P.sources[s]
      const have = S.block(cv(src)); if (have && have.name === 'water') continue
      const tip = P.tips.find(t => MF.key(t.src) === MF.key(src)), stand = tip && tip.stand
      if (!stand) return stop('no pad beside the tip at ' + src)
      if (!(await walk(stand, 60000))) return stop('cannot reach the pad at ' + stand)
      const floor = S.block(cv([src[0], src[1] - 1, src[2]]))
      if (!floor || floor.boundingBox !== 'block') return stop('no floor under the water spot ' + src)
      // a bucket is a "use item" (the server ray-casts from the eye), not a block placement: look at the floor's top face and use it
      const wbk = S.items().find(i => i.name === 'water_bucket'); if (!wbk) return stop('no water bucket')
      await bot.equip(wbk, 'hand').catch(() => {})
      for (let t = 0; t < 3; t++) {
        await bot.lookAt(cv(src).offset(0.5, 0.02, 0.5), true); await sleep(150)
        bot.activateItem(); await sleep(900)
        const w0 = S.block(cv(src)); if (w0 && w0.name === 'water') break
      }
      const wb = S.block(cv(src)); if (!wb || wb.name !== 'water') return stop('no water at ' + src + ' after placing it')
    }
    for (let t = 0; t < 12; t++) { await sleep(1500); if (L.platform.trench.every(c => { const b = S.block(cv(c)); return b && b.name === 'water' })) break }
    // did it settle as designed: the cell next to the hole is wet (lowest level) and the column is dry
    const lv = MF.waterLevels(L)
    const wetOk = [...lv.keys()].filter(k => lv.get(k) <= 2).every(k => { const [x, y, z] = k.split(',').map(Number); const b = S.block(v(x, y, z)); return b && b.name === 'water' })
    const colWet = L.column.slice(0, 6).some(c => { const b = S.block(cv(c)); return b && b.name === 'water' })
    if (colWet) { note('mob farm: WATER IN THE DROP COLUMN. The trench is wrong, taking the sources out is the next step'); return stop('water in the column') }
    if (!wetOk) note('mob farm: the trench did not fill all the way yet')
    // out along the dry pads, then plug the corridor from the shaft side
    if (!(await walk(P.corridor[0], 60000))) return stop('cannot get back to the corridor')
    let plugged = 0
    for (const c of P.plug) { if (solid(c)) { plugged++; continue } if (await M.fill(cv(c)).catch(() => false)) plugged++ }
    if (plugged < P.plug.length) note('mob farm: the corridor plug is missing ' + (P.plug.length - plugged) + ' block(s)')
    return plugged === P.plug.length
  }

  function finish(L, sh) {
    const C = L.chamber, P = L.platform
    const pocket = C.pocket[0]
    const cfg = {
      builder: 'mobfarmbuild', world: LD().worldKey(), built: Date.now(),
      killSpot: C.K, killBox: { x0: pocket[0], x1: pocket[0], y0: C.pocket[0][1], y1: C.pocket[1][1], z0: pocket[2], z1: pocket[2] },
      chests: [C.chest], chestSpot: C.standAtChest, overflow: [], overflowSpots: [],
      platform: { y: L.Yp, centre: P.hole, radius: L.opt.R }, rest: L.at(2, 0, L.Y0), shaft: sh.id,
    }
    const file = api.statePath('mobfarm.json')
    try { const old = JSON.parse(fs.readFileSync(file, 'utf8')); if (old && old.builder !== 'mobfarmbuild') fs.writeFileSync(api.statePath('mobfarm.old.json'), JSON.stringify(old, null, 1)); if (old && old.overflow && old.builder === 'mobfarmbuild') { cfg.overflow = old.overflow; cfg.overflowSpots = old.overflowSpots || [] } } catch {}
    fs.writeFileSync(file, JSON.stringify(cfg, null, 1))
    LD().putRoom({ id: 'mobfarm-' + sh.id, type: 'mobfarm', by: bot.username, shaft: sh.id, box: L.box, y: L.Y0, platformY: L.Yp, chests: [C.chest], at: Date.now() })
    B().phase = 'done'; B().doneAt = Date.now(); G.save()
  }

  // ------------------------------------------------------------------ the entry
  async function run() {
    const sh = shaftOf(); if (!sh || !sh.bottom) { return stop('no laddered shaft to hang the farm on') }
    let L = choose(sh); if (!L) { note('mob farm: ' + lastWhy); return false }
    const b = B()
    G._mfOpen = (q) => L.isOpen(q)
    if (b.phase === 'done') return false
    const order = [['chamber', phaseChamber], ['platform', phasePlatform], ['column', phaseColumn], ['fit', phaseFit], ['water', phaseWater]]
    const t0 = Date.now()
    for (const [name, fn] of order) {
      if (PHASES.indexOf(b.phase) > PHASES.indexOf(name)) continue
      b.phase = name; G.save()
      note(`mob farm: ${name} (platform y${L.Yp}, kill level y${L.Y0}, direction ${L.d})`)
      if (name === 'chamber' || name === 'platform' || name === 'column') await ensurePicks(name === 'platform' ? 4 : 2).catch((e) => { if (S.isAbort(e)) throw e })
      let ok = false
      try { ok = await fn(L, sh) } catch (e) { if (S.isAbort(e) || e.name === 'StepTimeout') throw e; lastWhy = 'error ' + e.message; log('MOBFARMBUILD', e.stack || e.message) }
      if (!ok) {
        b.fails = (b.fails || 0) + 1; b.lastWhy = lastWhy; b.restUntil = Date.now() + Math.min(30, 3 * b.fails) * 60000
        // liquid or a cave in this spot: the next try picks another side or level
        if (/lava|water|liquid|no-dig/.test(lastWhy) && PHASES.indexOf(name) <= 1) { b.skip = (b.skip || []).concat([b.turn + ':' + b.shift]); b.shaft = null; b.Yp = null }
        note(`mob farm: ${name} stopped (${lastWhy}); trying again later`)
        G.save(); try { await LD().up(sh) } catch {}
        return Date.now() - t0 > 20000
      }
      b.fails = 0
      const nxt = PHASES[PHASES.indexOf(name) + 1]; b.phase = nxt; G.save()
    }
    finish(L, sh)
    note(`mob farm built: platform y${L.Yp}, kill spot ${L.chamber.K}, chest ${L.chamber.chest}. Wait away from the platform (24+ blocks) so mobs can spawn there.`)
    try { await LD().up(sh) } catch {}
    return true
  }

  function status() {
    const b = B(), sh = shaftOf()
    let cfg = null; try { cfg = JSON.parse(fs.readFileSync(api.statePath('mobfarm.json'), 'utf8')) } catch {}
    return { phase: b.phase || 'not started', done: b.phase === 'done', fails: b.fails || 0, why: b.lastWhy || '', needs: needs(), shaft: sh ? sh.id : null, needBottom: b.needBottom, farm: cfg && cfg.builder === 'mobfarmbuild' ? { killSpot: cfg.killSpot, chests: cfg.chests, rest: cfg.rest } : null }
  }
  G.mobFarmBuild = { run, status, needs, stock }

  return {
    id: 'mob-farm-build', budget: 1200000, cool: 300000,
    need: () => {
      const b = B()
      if (b.phase === 'done' || Date.now() < (b.restUntil || 0)) return false
      if (S.isNight() && !S.underground()) return false
      if (!st.mine || !st.mine.ladder) return false
      const sh = shaftOf(); if (!sh || !sh.bottom) return false
      if (!(LD().rooms() || []).some(r => r.type === 'storage' && r.shaft === sh.id)) return false      // the storage room comes first (Phase 2 item 2)
      return Object.keys(needs()).length === 0 && S.freeSlots() >= 4
    },
    run: async () => run(),
  }
}
