// brain/autopilot/lightup.js: the light-up task (Walter 2026-11-10, thread "Light up spawns competing with mob farm").
//
// The mob farm (mobfarmbuild.js) only fills its chest when its dark platform wins the mob cap, and every dark cave within spawn range takes mobs that would
// otherwise have spawned there. So part of running a mob farm is finding where hostile mobs can spawn around it and lighting those spots.
//
// Walter allows ONE scan through blocks for this (an exception to the no-x-ray rule, 2026-11-10): the list of dark spawnable spots in the loaded chunks
// around the farm (brain/lightup/plan.js scan). It is used only to choose where to walk. Placing still needs a view of the floor, the way there is walked
// like any player would, nothing is dug, and the farm's own platform and kill chamber are never lit (they must stay dark).
//
// How a run goes (the "dance"): scan, drop sealed pockets the bot cannot reach, choose the fewest torch cells that light everything (torch spacing at least
// two air blocks apart, never a torch whose light would reach the platform), order them into one route, then for each: rush to the spot, put the torch down
// in view of its floor, and fall back to the safe spot (the farm's rest corridor, or where the run began) when mobs gather or health drops. The bot does not go
// looking for fights: the combat reflex (brain/combat) handles what reaches it; a lit spot stops producing mobs and the ones already there despawn once the
// bot is far away. Spots with a creeper or a crowd of mobs close by are postponed to a later pass.
//
// Think-brain: the skill `light_up` (action scan|run|status) in think.js; fallback routine step `mob-farm-light` (below).
const fs = require('fs')
const P = require('../lightup/plan')
const makeWorld = require('../lightup/world')

const DEFAULTS = { r: 48, dy: 40, maxTorches: 20, ms: 8 * 60000, minHealth: 14, abortHealth: 9, spotMs: 30000, passes: 3, minTorches: 3 }

module.exports = function lightup(G, S, M, api, log) {
  const bot = S.bot, { goals } = S, v = S.v, st = G.state
  const Vec3 = v(0, 0, 0).constructor
  const note = (m) => { try { G.note(m) } catch { log('LIGHTUP', m) } }
  const flo = (p) => S.flo(p)
  const tick = () => new Promise(r => setImmediate(r))
  const farm = () => { try { const c = JSON.parse(fs.readFileSync(api.statePath('mobfarm.json'), 'utf8')); return c && c.platform && c.platform.centre ? c : null } catch { return null } }
  const U = () => (st.lightUp = st.lightUp || {})
  const torchCount = () => S.count('torch')

  // ------------------------------------------------------------------ what must stay dark
  // The farm's own cells: the diamond room (pads and air, a margin of 2 around it, 4 levels), the drop column and the kill chamber with its corridor.
  function farmZones(cfg) {
    if (!cfg) return { exclude: () => false, keepDark: null }
    const [hx, hy, hz] = cfg.platform.centre, R = (cfg.platform.radius || 9), Yp = cfg.platform.y != null ? cfg.platform.y : hy + 1
    const kb = cfg.killBox, Y0 = cfg.killSpot ? cfg.killSpot[1] : Yp - 22
    const room = (x, y, z, pad, dlo, dhi) => Math.abs(x - hx) + Math.abs(z - hz) <= R + pad && y >= Yp - dlo && y <= Yp + dhi
    const column = (x, y, z) => Math.abs(x - hx) <= 1 && Math.abs(z - hz) <= 1 && y >= Y0 - 3 && y <= Yp + 3
    const chamber = (x, y, z) => !!kb && x >= kb.x0 - 4 && x <= kb.x1 + 5 && z >= kb.z0 - 4 && z <= kb.z1 + 5 && y >= Y0 - 3 && y <= Y0 + 3
    return {
      exclude: (x, y, z) => room(x, y, z, 2, 3, 4) || column(x, y, z) || chamber(x, y, z),
      keepDark: (x, y, z) => room(x, y, z, 0, 1, 2),                  // light reaching the pads or the air over them would let torch light in
    }
  }

  // ------------------------------------------------------------------ scan + plan (no walking)
  async function scanPlan(o) {
    const cfg = farm()
    const centre = o.center || (cfg ? cfg.platform.centre : [bot.entity.position.x, bot.entity.position.y, bot.entity.position.z]).map(Math.floor)
    const Cv = v(centre[0], centre[1], centre[2])
    const L = require('./light')(bot, Vec3)
    const lv = await L.compute(Cv, o.r, o.dy)
    const w = makeWorld(bot, Vec3, L, lv)
    const zones = farmZones(cfg)
    const sc = await P.scan(w, centre, { r: o.r, dy: o.dy, exclude: zones.exclude, sky: !!o.surface, tick })
    const here = flo(bot.entity.position), start = [here.x, here.y, here.z]
    const reach = await P.connected(w, start, centre, { r: o.r, dy: o.dy, tick })
    const key = P.keyer(centre)
    const dark = sc.cells.filter(c => reach.has(key(c[0], c[1], c[2])))
    const sealed = sc.cells.length - dark.length
    let torches = []
    try { torches = bot.findBlocks({ matching: (b) => b && /^(torch|wall_torch)$/.test(b.name), point: Cv, maxDistance: o.r + 15, count: 4000 }).map(t => [t.x, t.y, t.z]) } catch { /* none */ }
    const prefer = (c) => Math.hypot(c[0] - start[0], c[1] - start[1], c[2] - start[2]) / 500
    const pl = await P.plan(w, dark, { torches, max: o.maxTorches, keepDark: zones.keepDark, prefer, tick })
    return { centre, cfg, w, dark, sealed, sky: sc.sky, excluded: sc.excluded, plan: pl, torches: torches.length, start, route: P.route(pl.torches, start), reach }
  }
  const summary = (r) => ({ dark: r.dark.length, sealed: r.sealed, skyOnly: r.sky, planned: r.plan.torches.length, covers: r.plan.covered, leftover: r.plan.leftover.length, rejected: r.plan.rejected, torchesNearby: r.torches })

  // ------------------------------------------------------------------ one torch: rush in, place it in view, out again
  const hostile = (r) => S.hostilesNear(r)
  const creepers = (r) => hostile(r).filter(e => e.name === 'creeper')
  async function waitOutCombat(ms = 20000) {
    const c = bot._combat, t0 = Date.now()
    while (c && c.engaged && c.engaged() && Date.now() - t0 < ms) { S.check(); await S.wait(300) }
  }
  async function retreat(safe, why) {
    if (!safe) return false
    const d = S.dist(v(safe[0] + 0.5, safe[1], safe[2] + 0.5))
    if (d < 2) return true
    log('LIGHTUP', 'falling back to the safe spot (' + why + ')')
    try { await api.safehand.ensureSafeForMove() } catch { /* no safehand: the test rigs */ }
    const r = await S.goto(new goals.GoalNear(safe[0], safe[1], safe[2], 2), { dig: false, ms: 30000, escalate: false })
    return !!r.ok
  }

  async function lightSpot(at, o) {
    const T = v(at[0], at[1], at[2]), F = T.offset(0, -1, 0)
    const cell = S.block(T), floor = S.block(F)
    if (!cell || !S.isAir(cell) || !floor || floor.boundingBox !== 'block') return { ok: false, why: 'cell-changed' }
    if (S.torchCrowded(T)) return { ok: true, why: 'crowded', skipped: true }           // someone lit it meanwhile
    const hz = S.hazardNear(T, 1); if (hz.lava) return { ok: false, why: 'lava-beside' }
    try { await api.safehand.ensureSafeForMove() } catch { /* no safehand: the test rigs */ }
    const eyeOk = () => S.eye().distanceTo(v(F.x + 0.5, F.y + 1, F.z + 0.5)) <= 4.3 && S.canSee(S.block(F))
    if (!eyeOk()) {
      let r = await S.goto(new goals.GoalNear(T.x, T.y, T.z, 3), { dig: false, ms: o.spotMs, escalate: false })
      if (!r.ok && S.dist(T.offset(0.5, 0, 0.5)) > 4) return { ok: false, why: 'no-path' }
      if (!eyeOk()) { r = await S.goto(new goals.GoalNear(T.x, T.y, T.z, 1), { dig: false, ms: 15000, escalate: false }); if (!r.ok && !eyeOk()) return { ok: false, why: 'no-view' } }
      if (!eyeOk()) return { ok: false, why: 'no-view' }
    }
    for (let i = 0; i < 3; i++) {
      S.check()
      if (await S.placeAgainst(S.block(F), v(0, 1, 0), 'torch')) {
        for (let k = 0; k < 6; k++) { const b = S.block(T); if (b && /torch/.test(b.name)) return { ok: true, at: [T.x, T.y, T.z] }; await S.wait(100) }
      }
      if (S.torchCrowded(T)) return { ok: true, why: 'crowded', skipped: true }
      await waitOutCombat(6000)           // a mob in reach holds the hand: let combat finish, then try again
      await S.wait(250)
    }
    return { ok: false, why: 'not-placed' }
  }

  // ------------------------------------------------------------------ the torches in the bag
  async function ensureTorches(want) {
    if (torchCount() >= want) return true
    if (S.count(/^(coal|charcoal)$/) >= 1 && (S.count('stick') >= 1 || S.planks() >= 2 || S.logs() >= 1)) await S.craft('torch', torchCount() + Math.max(8, want)).catch(() => false)
    return torchCount() >= Math.min(want, DEFAULTS.minTorches)
  }

  // ------------------------------------------------------------------ the run
  async function run(opts = {}) {
    const o = { ...DEFAULTS, ...opts }, t0 = Date.now()
    const res = { ok: false, placed: 0, failed: 0, postponed: 0, retreats: 0, passes: 0, why: '' }
    if (bot.isSleeping) { res.why = 'asleep'; return res }
    if (bot.health < o.minHealth) { res.why = 'health ' + Math.round(bot.health) + ' is under ' + o.minHealth; return res }
    if (S.isNight() && !S.underground()) { res.why = 'night on the surface'; return res }
    const cfg = farm()
    if (cfg) {                                      // be near the farm: the scan box is centred on its platform
      const c = cfg.platform.centre, d = Math.hypot(bot.entity.position.x - c[0], bot.entity.position.z - c[2])
      if (d > o.r * 0.7 && cfg.rest) { await S.goto(new goals.GoalNear(cfg.rest[0], cfg.rest[1], cfg.rest[2], 2), { dig: false, ms: 90000, escalate: false }) }
    }
    const runStart = flo(bot.entity.position)
    let safe = cfg && cfg.rest ? cfg.rest : [runStart.x, runStart.y, runStart.z]
    const bad = new Set()                           // spots that failed this run (key)
    let lastDark = null
    for (let pass = 1; pass <= o.passes && Date.now() - t0 < o.ms; pass++) {
      S.check()
      const r = await scanPlan(o)
      res.passes = pass
      if (!r.cfg) r.safeNote = 'no farm config: centred on the bot'
      if (lastDark == null) res.dark0 = r.dark.length
      lastDark = r.dark.length
      log('LIGHTUP', `pass ${pass}: ${JSON.stringify(summary(r))}`)
      if (cfg && r.cfg && !r.reach.has(P.keyer(r.centre)(safe[0], safe[1], safe[2]))) safe = [runStart.x, runStart.y, runStart.z]   // the rest spot is not connected to here
      const route = r.route.filter(t => !bad.has(t.at.join(',')))
      if (!route.length) break
      if (!(await ensureTorches(Math.min(route.length, o.maxTorches)))) { res.why = 'no torches (coal and sticks needed)'; res.needs = { torch: route.length }; break }
      let progress = false
      const queue = route.slice()
      let postponedOnce = new Set()
      while (queue.length && Date.now() - t0 < o.ms) {
        S.check()
        const t = queue.shift(), key = t.at.join(',')
        if (torchCount() < 1) { res.why = 'out of torches'; break }
        if (bot.health < o.abortHealth) { await retreat(safe, 'health ' + Math.round(bot.health)); res.why = 'hurt (health ' + Math.round(bot.health) + ')'; res.retreats++; break }
        await waitOutCombat()
        // a creeper by the spot, a crowd around it, or a mob standing on it: this spot waits (once) and the next one goes first; when only
        // such spots are left the bot falls back, gives the mobs a moment to wander off, and then goes in anyway (the combat reflex takes what reaches it)
        const tv = v(t.at[0] + 0.5, t.at[1], t.at[2] + 0.5), near = (r) => hostile(40).filter(e => e.position.distanceTo(tv) < r)
        const threatened = near(9).some(e => e.name === 'creeper') || near(10).length >= 3 || near(4).length > 0
        if (threatened && !postponedOnce.has(key)) {
          postponedOnce.add(key); queue.push(t); res.postponed++
          if (queue.some(q => !postponedOnce.has(q.at.join(',')))) continue
          await retreat(safe, near(9).some(e => e.name === 'creeper') ? 'creeper at the spot' : 'mobs at the spot'); res.retreats++
          await S.wait(8000)
          continue
        }
        const r1 = await lightSpot(t.at, o)
        if (r1.ok && !r1.skipped) {
          res.placed++; progress = true
          const arr = (U().torches = U().torches || []); arr.push({ at: t.at, t: Date.now() }); if (arr.length > 120) arr.shift()
          log('LIGHTUP', `TORCH at ${key} (${res.placed} this run, gain ${t.gain})`)
        } else if (!r1.ok) { res.failed++; bad.add(key); log('LIGHTUP', `no torch at ${key}: ${r1.why}`) }
        // mobs gathering behind us: out to the safe spot and let them lose us (they despawn when the bot is far away)
        const after = hostile(10)
        if (after.length >= 2 || creepers(8).length || (after.length && bot.health < o.minHealth)) {
          await waitOutCombat(8000)
          if (hostile(10).length >= 2 || creepers(8).length) { await retreat(safe, 'mobs gathered'); res.retreats++; await S.wait(5000) }
        }
      }
      if (!progress) break
    }
    // done: leave the dark caves behind, then take stock
    if (hostile(12).length || creepers(14).length) { await retreat(safe, 'run over'); res.retreats++ }
    let left = null
    try { const r = await scanPlan({ ...o, maxTorches: 1 }); left = { dark: r.dark.length, sealed: r.sealed, leftover: r.plan.leftover.length, skyOnly: r.sky } } catch (e) { log('LIGHTUP', 'final scan failed: ' + e.message) }
    res.left = left; res.ok = res.placed > 0 || (left && left.dark === 0)
    if (!res.why && left && left.dark > 0 && !res.placed) res.why = left.dark + ' dark spots left (spacing rule, no path or no view)'
    const u = U(); u.at = Date.now(); u.last = { placed: res.placed, failed: res.failed, retreats: res.retreats, postponed: res.postponed, dark0: res.dark0, left, why: res.why }
    u.total = (u.total || 0) + res.placed
    u.nextAt = Date.now() + ((left && left.dark === 0) ? 90 : res.placed ? 20 : 45) * 60000
    G.save()
    note(`light-up: ${res.placed} torches placed, ${res.failed} failed, ${res.retreats} retreats; dark spots ${res.dark0 != null ? res.dark0 : '?'} -> ${left ? left.dark : '?'} (${left ? left.sealed : '?'} sealed)${res.why ? '; ' + res.why : ''}`)
    return res
  }

  async function scan(opts = {}) { const r = await scanPlan({ ...DEFAULTS, ...opts }); return { ...summary(r), sample: r.plan.torches.slice(0, 6).map(t => t.at) } }
  const status = () => { const u = U(); return { last: u.last || null, at: u.at || 0, nextAt: u.nextAt || 0, total: u.total || 0, farm: !!farm() } }
  // The scan lists dark spawn cells in loaded chunks through rock: the one place a bot decision would use block data it cannot see. The project rule
  // is survival-legit with no x-ray, so the exception sits behind an approval that has to come from Walter himself (the README quotes him, but a
  // quote in a file is not his go-ahead in this thread). Off until LIGHTUP_XRAY_OK=1 in the bot's environment or a brain/state/lightup-approved.json
  // file exists; neither the step nor the skill does anything without it.
  const approved = () => process.env.LIGHTUP_XRAY_OK === '1' || require('fs').existsSync(require('path').join(process.env.BOT_RUNTIME_DIR || process.cwd(), 'brain', 'state', 'lightup-approved.json'))
  const NEEDS_OK = { ok: false, why: 'the light-up scan reads dark cells through rock; it stays off until Walter approves that exception (lightup-approved.json)' }
  const guarded = (fn) => async (...a) => approved() ? fn(...a) : NEEDS_OK
  G.lightUp = { run: guarded(run), scan: guarded(scan), status, DEFAULTS, approved }

  return {
    id: 'mob-farm-light', budget: DEFAULTS.ms + 120000, cool: 300000,
    need: () => {
      if (!approved()) return false
      if (!farm() || bot.isSleeping || bot.health < DEFAULTS.minHealth) return false
      if (S.isNight() && !S.underground()) return false
      if (Date.now() < (U().nextAt || 0)) return false
      return torchCount() >= DEFAULTS.minTorches || S.count(/^(coal|charcoal)$/) >= 1
    },
    run: async () => { const r = await G.lightUp.run(); return !!r.ok },
  }
}
module.exports.DEFAULTS = DEFAULTS
