// brain/pilot/collect: deterministic "collect drops" sweep and "recover your gear" run (no model involved).
//   sweep():    every dropped-item entity within a radius (default 48), nearest first, walk onto it with nav (walking onto an item picks it up)
//               until none are left, the time limit hits, the bag is full, or Walter says stop.
//   recover():  go to the recorded death spot, then sweep. Runs by itself after a respawn when it is daytime and no hostile is near
//               (otherwise the bot says where it died and waits for "recover your gear").
// Fair play: only nav is used (no digging, no placing); lava is never held while walking (safehand); items lying in or next to lava/fire are skipped;
// hostiles near abort the sweep so the safety module has the body. Both are scheduler tasks (chat priority, cancelled by "stop", pre-empted by safety).
const { Vec3 } = require('vec3')

const HOSTILE = new Set(['zombie', 'husk', 'drowned', 'skeleton', 'stray', 'creeper', 'spider', 'cave_spider', 'witch', 'pillager', 'vindicator', 'evoker', 'ravager', 'phantom', 'blaze', 'ghast', 'piglin_brute', 'wither_skeleton', 'slime', 'magma_cube', 'hoglin', 'zoglin', 'vex', 'warden'])
const DANGER_BLOCK = /^(lava|fire|soul_fire|magma_block|cactus|sweet_berry_bush|wither_rose|campfire|soul_campfire)$/

function createCollector({ api, now = Date.now, cfg = {}, getDeath, markDeath }) {
  const c = { radius: 48, maxMs: 4 * 60000, perItemMs: 20000, pickupWaitMs: 450, autoRecover: true, maxRecoverDistance: 300, hostileRadius: 20, ...cfg }
  const bot = api.bot
  let run = null
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const bagTotal = () => { try { return bot.inventory.items().reduce((a, i) => a + i.count, 0) } catch { return 0 } }
  const freeSlots = () => { try { return bot.inventory.emptySlotCount() } catch { return 36 } }
  const dropsNear = (radius, skip) => {
    const me = bot.entity.position, out = []
    for (const e of Object.values(bot.entities || {})) {
      if (!e || !e.position || e.name !== 'item' || skip.has(e.id)) continue
      const d = e.position.distanceTo(me)
      if (d <= radius) out.push({ e, d })
    }
    return out.sort((a, b) => a.d - b.d)
  }
  const hostilesNear = (radius = c.hostileRadius) => {
    const me = bot.entity.position
    return Object.values(bot.entities || {}).some(e => e && e !== bot.entity && e.position && HOSTILE.has(e.name) && e.position.distanceTo(me) <= radius)
  }
  const unsafeSpot = (p) => {
    for (const [dx, dy, dz] of [[0, 0, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
      let b = null; try { b = bot.blockAt(new Vec3(Math.floor(p.x) + dx, Math.floor(p.y) + dy, Math.floor(p.z) + dz)) } catch { b = null }
      if (b && DANGER_BLOCK.test(b.name)) return true
    }
    return false
  }

  // st: { aborted }. ctx: scheduler ctx or null. -> { collected, seen, skipped, why }
  async function sweep({ radius = c.radius, maxMs = c.maxMs, ctx = null, st = { aborted: false } } = {}) {
    const t0 = now(), before = bagTotal(), skip = new Set(), tries = new Map()
    let seen = 0, why = 'done'
    for (;;) {
      if (st.aborted) { why = 'aborted'; break }
      if (ctx && ctx.checkpoint) ctx.checkpoint()
      if (now() - t0 > maxMs) { why = 'time-limit'; break }
      if (freeSlots() === 0) { why = 'bag-full'; break }
      if (hostilesNear()) { why = 'hostile-near'; break }
      const list = dropsNear(radius, skip)
      if (!list.length) break
      const { e } = list[0]
      seen++
      if (unsafeSpot(e.position)) { skip.add(e.id); continue }
      const n = (tries.get(e.id) || 0) + 1; tries.set(e.id, n)
      if (n > 2) { skip.add(e.id); continue }
      if (api.safehand) await api.safehand.ensureSafeForMove()
      const p = e.position
      const r = await api.tryGoto(new api.goals.GoalNear(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), 1), 'drops', c.perItemMs)
      if (st.aborted) { why = 'aborted'; break }
      if (!(r && r.ok)) { skip.add(e.id); continue }
      await (ctx && ctx.sleep ? ctx.sleep(c.pickupWaitMs) : sleep(c.pickupWaitMs))
    }
    const left = dropsNear(radius, new Set()).length
    return { collected: Math.max(0, bagTotal() - before), seen, skipped: skip.size, left, why }
  }

  const sayResult = (r) => {
    if (r.why === 'aborted') return
    const parts = []
    if (r.collected > 0) parts.push(`Picked up ${r.collected} item${r.collected === 1 ? '' : 's'}.`)
    else if (!r.seen) parts.push('No dropped items nearby.')
    else parts.push('Could not pick anything up.')
    if (r.why === 'bag-full') parts.push('My bag is full.')
    else if (r.why === 'hostile-near') parts.push('A hostile is close, so I stopped.')
    else if (r.why === 'time-limit') parts.push('Out of time.')
    if (r.skipped) parts.push(`${r.skipped} item${r.skipped === 1 ? '' : 's'} unreachable or in danger.`)
    api.say(parts.join(' ').slice(0, 220))
  }

  async function gotoSpot(pos, st, ctx) {
    const p = new Vec3(pos[0], pos[1], pos[2])
    if (api.safehand) await api.safehand.ensureSafeForMove()
    for (let leg = 0; leg < 6; leg++) {                            // far spots: several legs of at most 100 blocks
      if (st.aborted) return { ok: false, why: 'aborted' }
      if (ctx && ctx.checkpoint) ctx.checkpoint()
      const me = bot.entity.position
      if (me.distanceTo(p) <= 5) return { ok: true }
      const d = p.minus(me), len = d.norm()
      const step = len > 100 ? me.plus(d.scaled(100 / len)) : p
      const r = await api.tryGoto(new api.goals.GoalNear(Math.floor(step.x), Math.floor(step.y), Math.floor(step.z), 3), 'death spot', 45000)
      if (!(r && r.ok) && bot.entity.position.distanceTo(step) > 8) return { ok: false, why: 'no-path' }
    }
    return { ok: bot.entity.position.distanceTo(p) <= 8, why: 'far' }
  }

  // ---- scheduler tasks ----
  function abort() { if (run) run.aborted = true; try { api.stopNav && api.stopNav() } catch {} }
  function submit(name, fn) {
    return api.scheduler.submit({
      name, key: name, priority: api.PRIORITY.CHAT, onUserStop: 'cancel', replace: true, abort,
      async run(ctx) { const st = run = { aborted: false }; try { await fn(st, ctx) } finally { run = null } return { status: 'done' } }
    })
  }
  const startSweep = (opts = {}) => submit('collect-drops', async (st, ctx) => { sayResult(await sweep({ ...opts, ctx, st })) })
  const startRecover = (why = 'chat') => {
    const d = getDeath && getDeath()
    if (!d) { api.say('I have no record of where I died.'); return null }
    return submit('recover-gear', async (st, ctx) => {
      const dim = bot.game && bot.game.dimension ? String(bot.game.dimension).replace('minecraft:', '') : null
      if (d.dim && dim && d.dim !== dim) return api.say(`I died in the ${d.dim} and I am in the ${dim} now, so I cannot walk there.`)
      const g = await gotoSpot(d.pos, st, ctx)
      if (st.aborted) return
      if (!g.ok) return api.say(`I could not find a way to my death spot at ${d.pos.join(' ')}.`)
      sayResult(await sweep({ ctx, st }))
    })
  }

  // after a respawn: daytime and calm = go; otherwise say where it happened and wait for "recover your gear"
  function afterRespawn() {
    const d = getDeath && getDeath()
    if (!d || d.handled || now() - d.at > 4 * 60000) return 'none'
    markDeath && markDeath()
    const dim = bot.game && bot.game.dimension ? String(bot.game.dimension).replace('minecraft:', '') : null
    const dist = bot.entity && bot.entity.position ? bot.entity.position.distanceTo(new Vec3(d.pos[0], d.pos[1], d.pos[2])) : Infinity
    const day = bot.time && bot.time.timeOfDay != null && bot.time.timeOfDay < 12000
    if (d.dim && dim && d.dim !== dim) { api.say(`I died at ${d.pos.join(' ')} in the ${d.dim}.`); return 'other-dimension' }
    if (c.autoRecover && day && !hostilesNear(24) && dist <= c.maxRecoverDistance) {
      api.say(`I died at ${d.pos.join(' ')}. Going back for my things.`)
      startRecover('auto'); return 'auto'
    }
    api.say(`I died at ${d.pos.join(' ')}. Say "recover your gear" when it is safe and I will go get my things.`)
    return 'asked'
  }

  return { sweep, startSweep, startRecover, afterRespawn, abort, hostilesNear, dropsNear, active: () => !!run }
}

module.exports = { createCollector, HOSTILE }
