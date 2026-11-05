// brain/autopilot/mining.js: staircase descents and strip-mining tunnels. Survival-legit: only ores in plain view are mined, lava/water are never opened.
const { Vec3 } = require('vec3')
const { SIX, HORIZ, ORE_RE } = require('./skills').consts

const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]]

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
      let moved = false
      for (let t = 0; t < 4 && !moved; t++) {
        const [dx, dz] = DIRS[(dirIdx + t) % 4]
        const c1 = p.offset(dx, 1, dz), c0 = p.offset(dx, 0, dz), n = p.offset(dx, -1, dz), under = n.offset(0, -1, 0)
        const bu = S.block(under)
        if (!bu || !S.solid(bu) || bu.name === 'magma_block') continue          // would drop into a cave/lava: try another way
        const nb = S.block(n), c0b = S.block(c0), c1b = S.block(c1)
        if (!nb || !c0b || !c1b) continue
        if (S.hazardNear(n, 1).lava || S.hazardNear(c0, 1).lava || S.isLiquid(nb) || S.isLiquid(c0b) || S.isLiquid(c1b)) continue
        if (S.hazardNear(n, 1).water || S.hazardNear(c0, 1).water) continue
        let ok = true
        for (const c of [c1, c0, n]) { const r = await S.clearCell(c); if (r !== 'ok') { ok = false; break } }
        if (!ok) continue
        const r = await S.goto(new goals.GoalBlock(n.x, n.y, n.z), { dig: false, ms: 12000 })
        if (!r.ok) { await S.wait(200); continue }
        moved = true; dirIdx = (dirIdx + t) % 4
        if (t) turns++
      }
      if (!moved) return { ok: false, y: Math.floor(bot.entity.position.y), reason: 'blocked' }
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
    let done = 0, mined = 0, reason = 'length'
    for (let i = 0; i < len; i++) {
      S.check()
      if (stop && stop()) { reason = 'stop'; break }
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
      if (h0.water || h1.water) { reason = 'water'; break }
      let r = await S.clearCell(c1); if (r !== 'ok') { reason = 'clear-' + r; break }
      r = await S.clearCell(c0); if (r !== 'ok') { reason = 'clear-' + r; break }
      if (!floorOk(c0)) { const f = await M.fill(c0.offset(0, -1, 0)); if (!f) { reason = 'nofloor'; break } }
      const g = await S.goto(new goals.GoalBlock(c0.x, c0.y, c0.z), { dig: false, ms: 10000 })
      if (!g.ok) { reason = 'stuck'; break }
      done++
      if (i % 3 === 0) await S.pickup(5, 2500)
      // ores in plain view (exposed by our own tunnel or a cave)
      for (let k = 0; k < 8; k++) {
        const o = S.seen(targets, { radius: 7, needSight: true })
        const c = o.find(b => !S.hazardNear(b.position, 1).lava)
        if (!c) break
        const back = S.flo(bot.entity.position)
        if (await S.mine(c, { dig: true })) mined++
        else break
        // return to the tunnel
        const here = S.flo(bot.entity.position)
        if (here.distanceTo(back) > 1.5) await S.goto(new goals.GoalBlock(back.x, back.y, back.z), { dig: false, ms: 10000 })
      }
      if (done % torchEvery === 0) await M.torch()
    }
    await S.pickup(6, 3000)
    return { len: done, mined, reason }
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
        const g = await S.goto(new goals.GoalBlock(b.x, b.y, b.z), { dig: false, ms: 12000 })
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
