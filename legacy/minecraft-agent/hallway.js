// brain/autopilot/hallway.js: Walter's hallway (2026-10-27): west from (-1072,136,2299), 3 wide, 10 tall.
// Method (his): the top 6 layers first, standing on the untouched bottom 4 (reached by a small ramp), then the bottom 4 from the floor. No scaffolding columns.
// Loaded by plan.js: gives M.hallway() and G.hallway = { active(), run() }. Progress persists in brain/state/hallway.json.
const fs = require('fs')

module.exports = function hallway(G, S, M, api, log) {
  const bot = S.bot, { goals } = S, v = S.v
  const H = { x0: -1075, zc: 2299, y0: 136, height: 10, top: 6, xMin: -1230, file: api.statePath('hallway.json') }
  const load = () => { try { return JSON.parse(fs.readFileSync(H.file, 'utf8')) } catch { return { phase: 'ramp', x: H.x0, topEnd: null, done: false, active: true } } }
  const save = (s) => { try { fs.writeFileSync(H.file, JSON.stringify(s)) } catch {} }
  const note = (m) => G.note('hallway: ' + m)

  // stone/cobble/dirt/gravel pile up: put the surplus in the tunnel chest, never on the floor
  M.depositExcess = async () => {
    const keep = { cobblestone: 64, stone: 0, dirt: 16, gravel: 0, andesite: 0, diorite: 0, granite: 0, tuff: 0, deepslate: 0, cobbled_deepslate: 0, calcite: 0 }
    const surplus = bot.inventory.items().filter(i => i.name in keep && i.count > keep[i.name])
    if (!surplus.length) return 0
    const pos = v(-1069, 136, 2323)
    const g = await S.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3), { dig: false, ms: 90000 })
    let moved = 0
    if (g.ok) {
      let ch = null
      try { ch = await bot.openContainer(bot.blockAt(pos)) } catch { ch = null }
      if (ch) {
        for (const it of surplus) { const n = it.count - keep[it.name]; try { await ch.deposit(it.type, null, n); moved += n } catch { break } }
        try { ch.close() } catch {}
      }
    }
    return moved
  }

  // Falling gravel/sand (Walter: the 18:28 death was suffocation under gravel): a guard digs out any solid block that lands in the head or feet cell,
  // and loose blocks above a cell we open are given time to fall (while we stand next to the column, not in it) and are cleared again.
  const LOOSE = /^(gravel|sand|red_sand|suspicious_gravel|suspicious_sand|(\w+_)?concrete_powder|anvil)$/
  const SUFFOCATE = /^(gravel|sand|red_sand|suspicious_gravel|suspicious_sand|(\w+_)?concrete_powder|stone|cobblestone|dirt|andesite|diorite|granite|deepslate|cobbled_deepslate|tuff|netherrack)$/
  let freeing = false
  const guard = setInterval(async () => {
    if (freeing || !bot.entity || bot.isSleeping) return
    const p = S.flo(bot.entity.position)
    for (const dy of [1, 0]) {
      const b = S.block(p.offset(0, dy, 0))
      // ONLY loose blocks and plain natural rock may be dug out of the head/feet cell. (The first version dug every 'block' bounding box and removed
      // Walter's beds, stairs, doors, ladders and dirt-path floor wherever the bot stood: 2026-10-27, fixed.)
      if (b && SUFFOCATE.test(b.name) && !S.isLiquid(b) && b.diggable !== false) {
        freeing = true
        try { try { bot.pathfinder.setGoal(null) } catch {} await bot.dig(b, true); note('dug myself out of ' + b.name) } catch {} finally { freeing = false }
        return
      }
    }
  }, 250)
  const prevDispose = G.dispose
  G.dispose = () => { clearInterval(guard); if (prevDispose) prevDispose() }

  async function clearIfNeeded(c) {
    const b = S.block(c)
    if (!b) return false
    if (S.passable(b)) return true
    let ok = (await S.clearCell(c)) === 'ok'
    // loose blocks above fall into the hole: wait for them and clear again (we stand beside the column, not under it)
    for (let i = 0; ok && i < 10; i++) {
      let loose = false
      for (let dy = 1; dy <= 4; dy++) { const a = S.block(c.offset(0, dy, 0)); if (a && LOOSE.test(a.name)) { loose = true; break } }
      const here = S.block(c)
      if (!loose && (!here || S.passable(here))) break
      await S.wait(600)
      const now = S.block(c)
      if (now && !S.passable(now)) ok = (await S.clearCell(c)) === 'ok'
    }
    return ok
  }
  function hazard(c) { const hz = S.hazardNear(c, 1); return hz.lava ? 'lava' : hz.water ? 'water' : hz.sculk ? 'sculk' : null }

  M.hallway = async ({ maxMs = 180000 } = {}) => {
    const t0 = Date.now()
    let st = load()
    let slices = 0
    const stand = (x, y) => S.goto(new goals.GoalBlock(x, y, H.zc), { dig: false, ms: 20000 })
    while (!st.done && Date.now() - t0 < maxMs) {
      S.check()
      if (S.freeSlots() <= 3) { const n = await M.depositExcess(); if (!n && S.freeSlots() <= 1) return { ok: false, why: 'bag full and chest full', state: st } }
      if (st.phase === 'ramp') {
        // 4 steps up inside the wall (centre line only; the top phase widens it)
        for (let i = 1; i <= 4; i++) {
          const x = H.x0 - i, y = H.y0 + i
          for (const dy of [0, 1, 2]) if (!(await clearIfNeeded(v(x, y + dy, H.zc)))) return { ok: false, why: `ramp blocked at ${x},${y + dy}`, state: st }
          const g = await stand(x, y)
          if (!g.ok) return { ok: false, why: `ramp walk failed at ${x},${y}: ${g.err}`, state: st }
        }
        st.phase = 'top'; st.x = H.x0 - 4; save(st); note('ramp done'); continue
      }
      if (st.phase === 'top') {
        const yS = H.y0 + (H.height - H.top)                       // 140: stand here, layer 139 below is still solid
        const x = st.x - 1
        if (x < H.xMin) { st.phase = 'bottom'; st.x = H.x0; save(st); continue }
        let open = 0
        for (const dz of [0, -1, 1]) for (let y = yS; y < yS + H.top; y++) {
          const c = v(x, y, H.zc + dz), b = S.block(c)
          if (!b) return { ok: false, why: 'unloaded chunk at ' + x, state: st }
          if (S.passable(b)) { open++; continue }
          const hz = hazard(c); if (hz) return { ok: false, why: `${hz} at ${x},${y},${H.zc + dz}`, state: st }
          if (!(await clearIfNeeded(c))) return { ok: false, why: `could not clear ${x},${y},${H.zc + dz}`, state: st }
        }
        const g = await stand(x, yS)
        if (!g.ok) return { ok: false, why: `could not step to ${x},${yS}: ${g.err}`, state: st }
        st.x = x
        st.openRun = open >= H.top * 3 ? (st.openRun || 0) + 1 : 0
        if (st.openRun >= 3) { st.topEnd = x; st.phase = 'bottom'; st.x = H.x0; note(`top layers reached open air at x=${x}`) }
        save(st); slices++
        if (slices % 6 === 0) await S.pickup(6, 3000)
        continue
      }
      if (st.phase === 'bottom') {
        const end = st.topEnd != null ? st.topEnd : H.xMin
        const x = st.x - 1
        if (x < end) { st.done = true; save(st); note('finished'); break }
        if (st.x === H.x0) { const g0 = await stand(H.x0 + 1, H.y0); if (!g0.ok) return { ok: false, why: 'cannot reach the hallway floor start', state: st } }
        for (const dz of [0, -1, 1]) for (let y = H.y0; y < H.y0 + 4; y++) {
          const c = v(x, y, H.zc + dz), b = S.block(c)
          if (!b) return { ok: false, why: 'unloaded chunk at ' + x, state: st }
          if (S.passable(b)) continue
          const hz = hazard(c); if (hz) return { ok: false, why: `${hz} at ${x},${y},${H.zc + dz}`, state: st }
          if (!(await clearIfNeeded(c))) return { ok: false, why: `could not clear ${x},${y},${H.zc + dz}`, state: st }
        }
        const g = await stand(x, H.y0)
        if (!g.ok) return { ok: false, why: `could not step to ${x},${H.y0}: ${g.err}`, state: st }
        st.x = x; save(st); slices++
        if (slices % 6 === 0) await S.pickup(6, 3000)
        continue
      }
      break
    }
    return { ok: true, done: !!st.done, state: st, slices }
  }

  G.hallway = {
    status: () => load(),
    active: () => { const s = load(); return !s.done && s.active !== false },
    async run() {
      const r = await M.hallway({ maxMs: 150000 })
      note(`${r.ok ? 'dug ' + r.slices + ' slices, phase ' + r.state.phase + ' x ' + r.state.x : 'stopped: ' + r.why}`)
      return r
    },
  }
}
