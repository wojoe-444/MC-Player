// brain/autopilot/mining.js: staircase descents and strip-mining tunnels. Survival-legit: only ores in plain view are mined, lava/water are never opened.
const { Vec3 } = require('vec3')
const { SIX, HORIZ, ORE_RE } = require('./skills').consts

const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]]
const IRON_TIER = /^(deepslate_)?(diamond|gold|redstone|emerald)_ore$/   // ores a stone pickaxe cannot harvest

module.exports = function makeMining(S, api, log) {
  const { goals } = S
  const v = S.v
  const bot = S.bot
  const M = {}

  const floorOk = (p) => { const b = S.block(p.offset(0, -1, 0)); return !!b && S.solid(b) && b.name !== 'magma_block' }
  const cellOk = (p) => { const b = S.block(p); if (!b) return false; const h = S.hazardNear(p, 1); return !h.lava && !h.water }

  // Place a block (cobble/dirt/...) at cell p from a neighbour; used to patch holes in a tunnel floor. Returns true if p is solid afterwards.
  M.fill = async (p) => {
    if (S.solid(S.block(p))) return true
    const mat = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'stone', 'andesite', 'diorite', 'granite', 'tuff'].find(n => S.has(n))
    if (!mat) return false
    for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
      const ref = S.block(p.offset(dx, dy, dz))
      if (!ref || !S.solid(ref)) continue
      if (await S.placeAgainst(ref, v(-dx, -dy, -dz), mat)) { await S.wait(150); if (S.solid(S.block(p))) return true }
    }
    return false
  }

  // Seal the corridor around the bot with filler blocks (feet + head cell on every open side).
  M.seal = async () => {
    const me = S.flo(bot.entity.position); let n = 0
    for (const [dx, dz] of HORIZ) for (const dy of [0, 1]) {
      const c = me.offset(dx, dy, dz), b = S.block(c)
      if (b && S.passable(b) && !S.isLiquid(b)) { if (await M.fill(c)) n++ }
    }
    return n
  }
  // Mobs close or health low: fight a lone weak mob, otherwise wall in, eat and recover. Returns 'ok' | 'sealed'.
  M.defend = async (hs) => {
    const creeper = hs.find(e => e.name === 'creeper' && e.position.distanceTo(bot.entity.position) < 7)
    const strong = hs.length > 2 || bot.health < 10 || creeper
    if (!strong) {
      for (const e of hs.slice(0, 2)) { if (S.canSee(e) || e.position.distanceTo(bot.entity.position) < 4) await S.kill(e, { ms: 12000 }) }
      return 'ok'
    }
    const n = await M.seal()
    api.log('autopilot', `DEFEND sealed ${n} cells; hostiles ${hs.map(e => e.name).join(',')} hp ${Math.round(bot.health)}`)
    const t0 = Date.now()
    while (Date.now() - t0 < 45000 && (bot.health < 18 || S.hostilesNear(7).length)) {
      S.check()
      if (bot.food < 18 && S.foodPoints() > 0) await S.eat()
      await S.wait(1500)
    }
    return 'sealed'
  }

  // Torch every few blocks when it is dark and we have some.
  M.torch = async () => {
    if (!S.has('torch')) return false
    const me = S.flo(bot.entity.position)
    const light = (S.block(me) || {}).light
    if (light != null && light > 6) return false
    // place on the floor next to us
    const here = me
    for (const [dx, dz] of HORIZ) {
      const c = here.offset(dx, 0, dz), fl = S.block(c.offset(0, -1, 0)), cell = S.block(c)
      if (fl && S.solid(fl) && cell && S.isAir(cell)) { if (await S.placeAgainst(fl, v(0, 1, 0), 'torch')) return true }
    }
    return false
  }

  // Staircase down to targetY. Returns {ok, y, reason}.
  M.descend = async (targetY, { maxSteps = 150, dir0 = null } = {}) => {
    let dirIdx = dir0 != null ? dir0 : Math.floor(Math.random() * 4)
    let steps = 0, turns = 0
    while (Math.floor(bot.entity.position.y) > targetY && steps < maxSteps) {
      S.check()
      if (S.hostilesNear(7).length) { await S.wait(500) }
      const p = S.flo(bot.entity.position)
      let moved = false; const why = []
      for (let t = 0; t < 4 && !moved; t++) {
        const [dx, dz] = DIRS[(dirIdx + t) % 4]
        const c1 = p.offset(dx, 1, dz), c0 = p.offset(dx, 0, dz), n = p.offset(dx, -1, dz), under = n.offset(0, -1, 0)
        let bu = S.block(under)
        // air under the next stair (a cave below): set a block there and keep the staircase going, instead of calling the whole shaft
        // 'blocked' after a few steps (three shafts in a row stopped at y62-70, 10:24-11:07). Never over lava or water.
        if (bu && !S.solid(bu) && !S.isLiquid(bu) && !S.hazardNear(under, 1).lava && t === 3 && S.count(/^(cobblestone|cobbled_deepslate|dirt|stone|andesite|diorite|granite|tuff)$/) > 8) { try { if (await M.fill(under)) bu = S.block(under) } catch {} }
        if (!bu || !S.solid(bu) || bu.name === 'magma_block') { why.push('no floor (' + (bu && bu.name) + ')'); continue }          // would drop into a cave/lava: try another way
        const nb = S.block(n), c0b = S.block(c0), c1b = S.block(c1)
        if (!nb || !c0b || !c1b) { why.push('unloaded'); continue }
        if (S.hazardNear(n, 1).lava || S.hazardNear(c0, 1).lava || S.isLiquid(nb) || S.isLiquid(c0b) || S.isLiquid(c1b)) { why.push('lava/liquid'); continue }
        if (S.hazardNear(n, 1).water || S.hazardNear(c0, 1).water) { why.push('water near'); continue }
        let ok = true
        for (const c of [c1, c0, n]) { const r = await S.clearCell(c); if (r !== 'ok') { ok = false; break } }
        if (!ok) { why.push('cell would not clear'); continue }
        // one stair down: walk onto it directly (the pathfinder took up to a minute per stair on this machine, timing out and escalating,
        // so a whole shaft ran past the step's 10-minute budget at y34, 09:29); the pathfinder only when the direct step does not land
        let r = { ok: false }
        try {
          await bot.lookAt(v(n.x + 0.5, n.y + 1.6, n.z + 0.5), true); bot.setControlState('forward', true)
          const t0 = Date.now(); while (Date.now() - t0 < 1500) { await S.wait(100); const q = bot.entity.position; if (Math.hypot(q.x - (n.x + 0.5), q.z - (n.z + 0.5)) < 0.45 && Math.floor(q.y) === n.y) { r = { ok: true }; break } }
        } catch {} finally { bot.setControlState('forward', false) }
        // (the old escalating go-to stays the fallback: without it every shaft since #89 stopped at y62-70 with 'step did not land')
        if (!r.ok) r = await S.goto(new goals.GoalBlock(n.x, n.y, n.z), { dig: false, ms: 12000 })
        if (!r.ok) { why.push('step did not land'); await S.wait(200); continue }
        moved = true; dirIdx = (dirIdx + t) % 4
        if (t) turns++
      }
      if (!moved) return { ok: false, y: Math.floor(bot.entity.position.y), reason: 'blocked', why: why.join('; ') }
      steps++
      if (steps % 6 === 0) await S.pickup(5, 2500)
      if (steps % 10 === 0) await M.torch()
    }
    await S.pickup(6, 3000)
    return { ok: Math.floor(bot.entity.position.y) <= targetY, y: Math.floor(bot.entity.position.y), steps }
  }

  // Dig straight along `dir` for `len` blocks, mining visible ores of `targets` (regex) on the way.
  // stop(): optional predicate to end early. Returns {len, mined, reason}.
  M.tunnel = async (dirIdx, len, { targets = ORE_RE, stop = null, torchEvery = 7, minY = -999 } = {}) => {
    const [dx, dz] = DIRS[dirIdx % 4]
    let done = 0, mined = 0, reason = 'length', plugged = 0
    for (let i = 0; i < len; i++) {
      S.check()
      if (stop && stop()) { reason = 'stop'; break }
      // a spawner in sight is written down; a tunnel never goes on toward one (st from the plan via M.st)
      if (M.st) { S.noteSpawners(M.st); if (S.nearSpawner(M.st, bot.entity.position, 12)) { reason = 'spawner'; break } }
      if (S.freeSlots() <= 2) { reason = 'full'; break }
      { const hs = S.hostilesNear(8).filter(e => Math.abs(e.position.y - bot.entity.position.y) <= 3)
        if (hs.length || bot.health < 12) { const r = await M.defend(hs); if (r === 'sealed') {
          const p0 = S.flo(bot.entity.position); for (const dy of [0, 1]) { const b = S.block(p0.offset(dx, dy, dz)); if (b && /cobble/.test(b.name)) await S.digBlock(b, { force: true }) } } } }
      const p = S.flo(bot.entity.position)
      const c0 = p.offset(dx, 0, dz), c1 = p.offset(dx, 1, dz)
      const b0 = S.block(c0), b1 = S.block(c1)
      if (!b0 || !b1) { reason = 'unloaded'; break }
      // never open lava/water
      const h0 = S.hazardNear(c0, 2), h1 = S.hazardNear(c1, 2)
      if (h0.sculk || h1.sculk) { reason = 'sculk'; break }
      if (c0.y < minY) { reason = 'minY'; break }
      if (h0.lava || h1.lava) { reason = 'lava'; break }
      // water only matters where opening the two cells lets it in: a face of c0 or c1. Water flows through faces only, so a pocket two
      // blocks off or on a diagonal stays behind its wall (the old 2-block box gave up three shafts in a row at y20, 2026-11-05)
      if ((h0.water || h1.water) && [c0, c1].some(c => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([x, y, z]) => S.isWaterish(S.block(c.offset(x, y, z)))))) { reason = 'water'; break }
      let r = await S.clearCell(c1); if (r !== 'ok') { reason = 'clear-' + r; break }
      r = await S.clearCell(c0); if (r !== 'ok') { reason = 'clear-' + r; break }
      if (!floorOk(c0)) { const f = await M.fill(c0.offset(0, -1, 0)); if (!f) { reason = 'nofloor'; break } }
      // one block forward, walked directly (the pathfinder timed out on the single step again and again and every tunnel ended 'stuck'
      // after 3-7 blocks, 12:19-14:00); the go-to only as the fallback
      let g = { ok: false }
      try {
        await bot.lookAt(v(c0.x + 0.5, c0.y + 1.6, c0.z + 0.5), true); bot.setControlState('forward', true)
        // a hop when it has not moved after 0.7 s: standing in a cell with a floor torch the bot sat at onGround false, held in place
        // (TUNNEL stuck at 165.5,21.0,-368.7 'here torch', 15:00)
        const t0 = Date.now(), p0 = bot.entity.position.clone(); let hopped = false
        while (Date.now() - t0 < 2200) { await S.wait(100); const q = bot.entity.position; if (Math.hypot(q.x - (c0.x + 0.5), q.z - (c0.z + 0.5)) < 0.45 && Math.floor(q.y) === c0.y) { g = { ok: true }; break }
          if (!hopped && Date.now() - t0 > 700 && q.distanceTo(p0) < 0.2) { hopped = true; bot.setControlState('jump', true); await S.wait(250); bot.setControlState('jump', false) } }
      } catch {} finally { bot.setControlState('forward', false) }
      if (!g.ok) g = await S.goto(new goals.GoalBlock(c0.x, c0.y, c0.z), { dig: false, ms: 10000 })
      if (!g.ok) { try { const q = bot.entity.position, nm = (o) => { const b = S.block(o); return b ? b.name : '?' }; api.log('autopilot', `TUNNEL stuck at ${q.x.toFixed(2)},${q.y.toFixed(2)},${q.z.toFixed(2)} onGround ${bot.entity.onGround} -> c0 ${c0} ${nm(c0)}/${nm(c1)} floor ${nm(c0.offset(0, -1, 0))}, here ${nm(S.flo(q))}/${nm(S.flo(q).offset(0, 1, 0))}, goto ${g.err || g.why || ''}`) } catch {} reason = 'stuck'; break }
      done++
      if (i % 3 === 0) await S.pickup(5, 2500)
      // ores in plain view (exposed by our own tunnel or a cave)
      for (let k = 0; k < 8; k++) {
        const o = S.seen(targets, { radius: 7, needSight: true })
        const c = o.find(b => !S.hazardNear(b.position, 1).lava)
        if (!c) break
        // ores that need an iron pickaxe: the only time one is made (Walter 2026-11-06), here and now, from ingots carried; without one
        // the ore stays in the wall (a stone pickaxe would break it for nothing)
        if (IRON_TIER.test(c.name) && S.toolTier('pickaxe') < 3) {
          if (S.count('iron_ingot') >= 3 && S.has('stick')) { const ok = await S.craft('iron_pickaxe', 1).catch(() => false); api.log('autopilot', `GOAL iron pickaxe for ${c.name}: ${ok}`) }
          if (S.toolTier('pickaxe') < 3) break
        }
        const back = S.flo(bot.entity.position)
        if (await S.mine(c, { dig: true })) mined++
        else break
        // return to the tunnel
        const here = S.flo(bot.entity.position)
        if (here.distanceTo(back) > 1.5) await S.goto(new goals.GoalBlock(back.x, back.y, back.z), { dig: false, ms: 10000 })
      }
      // plug cave openings beside, above and below the tunnel, so cave mobs cannot walk or shoot in: every death underground on
      // 2026-11-05 came from a cave the tunnel had broken into (skeletons at y17-18, zombies and creepers at y28-38)
      { const here = S.flo(bot.entity.position), side = [[dz, dx], [-dz, -dx]]
        const cells = [...side.flatMap(([sx, sz]) => [here.offset(sx, 0, sz), here.offset(sx, 1, sz)]), here.offset(0, 2, 0), here.offset(0, -1, 0)]
        for (const c of cells) { const b = S.block(c); if (b && S.passable(b) && !S.isLiquid(b) && !/torch/.test(b.name)) { if (await M.fill(c)) plugged++ } } }
      if (done % torchEvery === 0) await M.torch()
    }
    await S.pickup(6, 3000)
    return { len: done, mined, reason, plugged }
  }

  // Walk back up the way we came (stairs are walkable): pathfind to the surface above/near the start. Returns true when the sky is visible.
  M.surface = async () => {
    for (let i = 0; i < 6; i++) {
      S.check()
      if (S.skyVisible()) return true
      // dig up a staircase in a free direction (reverse of descend)
      const r = await M.ascend(70)
      if (r.ok) return true
    }
    return S.skyVisible()
  }
  M.ascend = async (maxSteps = 80) => {
    let dirIdx = Math.floor(Math.random() * 4), steps = 0
    while (!S.skyVisible() && steps < maxSteps) {
      S.check()
      const p = S.flo(bot.entity.position)
      let moved = false
      for (let t = 0; t < 4 && !moved; t++) {
        const [dx, dz] = DIRS[(dirIdx + t) % 4]
        // step up: clear (dx,+1) and (dx,+2) above forward cell; stand on (dx,+1)
        const a = p.offset(dx, 0, dz), b = p.offset(dx, 1, dz), c = p.offset(dx, 2, dz), top = p.offset(0, 2, 0)
        if (S.hazardNear(b, 1).lava || S.hazardNear(c, 1).lava || S.hazardNear(top, 1).lava) continue
        if (S.hazardNear(b, 1).water || S.hazardNear(c, 1).water) continue
        if (!S.solid(S.block(a))) continue
        let ok = true
        for (const cell of [top, b, c]) { const r = await S.clearCell(cell); if (r !== 'ok') { ok = false; break } }
        if (!ok) continue
        // one stair up, walked directly with a jump (like M.descend: the pathfinder took up to a minute a stair here and the climb out
        // ended in 'no way up' resets, 09:45); the pathfinder without escalation only if the jump does not land
        let g = { ok: false }
        try {
          await bot.lookAt(v(b.x + 0.5, b.y + 1.6, b.z + 0.5), true); bot.setControlState('forward', true); bot.setControlState('jump', true)
          const t0 = Date.now(); while (Date.now() - t0 < 1600) { await S.wait(100); const q = bot.entity.position; if (Math.hypot(q.x - (b.x + 0.5), q.z - (b.z + 0.5)) < 0.45 && Math.floor(q.y) === b.y) { g = { ok: true }; break } }
        } catch {} finally { bot.setControlState('forward', false); bot.setControlState('jump', false) }
        if (!g.ok) g = await S.goto(new goals.GoalBlock(b.x, b.y, b.z), { dig: false, ms: 12000 })
        if (!g.ok) continue
        moved = true; dirIdx = (dirIdx + t) % 4
      }
      if (!moved) return { ok: false }
      steps++
    }
    return { ok: S.skyVisible() }
  }

  return M
}
