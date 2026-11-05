// brain/lighting: keeps the places the bot actually walks lit (torches only, line of sight, logged). See README.md and brain/INTERFACE.md.
//   - samples the cells the bot stands on (a 'move' listener, throttled, removed in stop()) into a persisted route map;
//   - an idle routine ('lighting', on by default) finds route cells inside the configured areas (Walter's base) whose block light is
//     below config.placeBelow, walks next to a plain floor there, checks it can see it and puts a torch on it;
//   - "light up" does the same on request. Mining uses the same placer (torches.js) inside its hallways.
const fs = require('fs')
const { Vec3 } = require('vec3')
const createTorches = require('./torches')
const baseConfig = require('./config.json')

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) } catch { return fallback } }
const key = (p) => `${p.x},${p.y},${p.z}`
const AIR = /^(air|cave_air|void_air)$/
const LIGHT_UP = /\b(light(ing)? up|lighten up|fix (the )?light(ing)?|(place|put|set)( up| down| out)? (some |a few )?torch(es)?|torch (the )?(base|dark|rooms?)|(too )?dark (spots?|rooms?|places?))\b/
const STATUS = /\b(lighting|torch(es)?|dark spots?)\b.*\b(status|placed|how many|report)\b|\bhow many torch(es)?\b/
const ROUTINE = /\blighting routine\b.*\b(on|off|enable|disable|stop|start)\b|\b(stop|start|enable|disable|turn (on|off))\b.*\blighting routine\b/

function register(api) {
  const { bot, scheduler, say, PRIORITY } = api
  const config = { ...baseConfig }
  const log = (m) => api.log('lighting', m)
  const file = api.statePath('lighting-state.json')
  const saved = readJson(file, {})
  const state = { routes: Array.isArray(saved.routes) ? saved.routes : [], placed: Array.isArray(saved.placed) ? saved.placed : [], lastRunAt: saved.lastRunAt || 0, lastCraftAskAt: saved.lastCraftAskAt || 0, lastNoTorchSayAt: saved.lastNoTorchSayAt || 0 }
  const routes = new Map(state.routes.map(r => [`${r[0]},${r[1]},${r[2]}`, { n: r[3], last: r[4] }]))
  const bad = new Map()                       // cell key -> retry time
  let dirty = false, lastSample = 0, lastSave = 0, running = false, nextAt = 0, last = null
  const torches = createTorches({ bot, canSee: (b) => api.canSee(b), log, now: api.now })

  const pad = config.areaPad || 0
  const areas = (config.areas || []).map(a => ({ min: a.min.map(v => v - pad), max: a.max.map(v => v + pad), label: a.label }))
  const inArea = (p) => areas.some(a => p.x >= a.min[0] && p.x <= a.max[0] && p.y >= a.min[1] && p.y <= a.max[1] && p.z >= a.min[2] && p.z <= a.max[2])
  const overworld = () => String((bot.game && bot.game.dimension) || 'overworld').replace('minecraft:', '') === 'overworld'
  const blockAt = (p) => { try { return bot.blockAt(p) || null } catch { return null } }

  function save() {
    state.routes = [...routes.entries()].map(([k, v]) => { const [x, y, z] = k.split(',').map(Number); return [x, y, z, v.n, v.last] })
    try { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, file) } catch (e) { log('state save failed: ' + e.message) }
    dirty = false; lastSave = api.now()
  }

  // ---------- routes the bot really uses ----------
  function onMove() {
    const t = api.now()
    if (t - lastSample < config.sampleMs || !bot.entity || !bot.entity.onGround || !overworld()) return
    lastSample = t
    const p = bot.entity.position, k = `${Math.floor(p.x)},${Math.floor(p.y + 0.01)},${Math.floor(p.z)}`
    const r = routes.get(k)
    if (r) { r.n++; r.last = t } else {
      if (routes.size >= config.routeCap) {                         // forget the least used, oldest cell
        let worst = null
        for (const [kk, v] of routes) if (!worst || v.n < worst.v.n || (v.n === worst.v.n && v.last < worst.v.last)) worst = { k: kk, v }
        if (worst) routes.delete(worst.k)
      }
      routes.set(k, { n: 1, last: t })
    }
    dirty = true
    if (t - lastSave > config.saveMs) save()
  }
  bot.on('move', onMove)

  // ---------- dark spots ----------
  // Route cells in the configured areas whose block light is too low, with a plain floor to put a torch on. Only cells that are loaded.
  function darkSpots() {
    const out = [], t = api.now()
    for (const [k, v] of routes) {
      const [x, y, z] = k.split(',').map(Number)
      const cell = new Vec3(x, y, z)
      if (!inArea(cell) || (bad.get(k) || 0) > t) continue
      const feet = blockAt(cell), head = blockAt(cell.offset(0, 1, 0)), floor = blockAt(cell.offset(0, -1, 0))
      if (!feet || !head || !floor || typeof feet.light !== 'number') continue
      if (!AIR.test(feet.name) || !AIR.test(head.name) || feet.light >= config.placeBelow) continue
      out.push({ cell, floor, n: v.n, light: feet.light, k })
    }
    return out.sort((a, b) => b.n - a.n)
  }
  // A floor block for a torch at or beside `spot`: its own floor, else a plain neighbour within 2.
  function floorFor(spot) {
    const order = [[0, 0]]
    for (let r = 1; r <= 2; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (Math.max(Math.abs(dx), Math.abs(dz)) === r) order.push([dx, dz])
    for (const [dx, dz] of order) {
      const c = spot.cell.offset(dx, 0, dz)
      const floor = blockAt(c.offset(0, -1, 0)), above = blockAt(c), head = blockAt(c.offset(0, 1, 0))
      if (floor && above && head && AIR.test(head.name) && torches.floorOk(floor, above) && !torches.torchNear(c, config.skipNear)) return { floor, cell: c }
    }
    return null
  }

  async function ensureTorches(ctx) {
    if (torches.count() > 0) return true
    const t = api.now()
    if (t - state.lastCraftAskAt < config.craftRetryMs || !api.commands || !api.commands.dispatch) return false
    state.lastCraftAskAt = t; save()
    api.commands.dispatch(api.ownerName, `craft ${config.craftCount} torch`)
    const craftOn = () => { try { const s = scheduler.status(); return (s.running && s.running.name === 'craft') || s.queue.some(x => x.name === 'craft') } catch { return false } }
    if (craftOn()) await ctx.sleep(10 * 60000)        // the craft task preempts this one; the routine comes back later
    return torches.count() > 0
  }

  async function run(ctx, { manual = false } = {}) {
    if (running) return { status: 'done' }
    running = true
    let placed = 0, failed = 0
    try {
      if (!overworld()) return { status: 'done' }
      await api.safehand.stow()
      let spots = darkSpots()
      if (!spots.length) { if (manual) say('I know of no dark spots on my routes right now.'); return { status: 'done' } }
      if (!(await ensureTorches(ctx))) {
        if (api.now() - state.lastNoTorchSayAt > 6 * 3600000) { state.lastNoTorchSayAt = api.now(); save(); say(`There are ${spots.length} dark spots on my routes but I have no torches and could not make any (coal and sticks needed).`) }
        return { status: 'done' }
      }
      while (spots.length && placed < config.maxPerRun) {
        ctx.checkpoint()
        const spot = spots[0]
        const f = floorFor(spot)
        if (!f) { bad.set(spot.k, api.now() + config.retryBadMs); spots.shift(); failed++; continue }
        await api.safehand.ensureSafeForMove()
        await api.gotoNear({ pos: f.floor.position, radius: 3, ctx, label: 'a dark spot', ms: 45000 })
        const fresh = blockAt(f.floor.position)
        const seen = fresh && (await api.ensureLineOfSight({ ctx, target: fresh, label: 'a view of the floor' }))
        const r = seen ? await torches.place(ctx, fresh) : { ok: false, why: 'no-line-of-sight' }
        if (r.ok) {
          placed++
          state.placed.push({ x: r.at.x, y: r.at.y, z: r.at.z, at: new Date(api.now()).toISOString(), light: spot.light }); if (state.placed.length > 300) state.placed.shift()
          log(`TORCH at ${key(r.at)} (light was ${spot.light}, ${spot.n} visits)`)
        } else { failed++; bad.set(spot.k, api.now() + config.retryBadMs); log(`no torch at ${key(spot.cell)}: ${r.why}`) }
        // forget the route cells this torch now covers, and re-evaluate (real light data arrives from the server a moment later)
        for (const [k] of routes) { const [x, y, z] = k.split(',').map(Number); if (Math.abs(x - spot.cell.x) <= config.cover && Math.abs(z - spot.cell.z) <= config.cover && Math.abs(y - spot.cell.y) <= 3 && r.ok) bad.set(k, api.now() + config.retryBadMs) }
        spots = darkSpots()
        if (torches.count() === 0) break
      }
      return { status: 'done' }
    } finally {
      running = false
      state.lastRunAt = api.now(); nextAt = api.now() + config.cooldownMs; save()
      if (placed) { last = { at: api.now(), msg: `placed ${placed}` }; say(`Put up ${placed} torch${placed === 1 ? '' : 'es'} in dark spots on my routes (logged).`) }
    }
  }

  const submit = (manual) => scheduler.submit({ name: 'lighting', key: 'lighting', priority: PRIORITY.EXCAVATE, onUserStop: 'cancel', idleOnly: !manual, run: (ctx) => run(ctx, { manual }) })
  scheduler.routine({
    name: 'lighting', priority: PRIORITY.EXCAVATE, idleOnly: true, defaultEnabled: true, intervalMs: config.intervalMs,
    due: () => !running && overworld() && api.now() >= nextAt && bot.health >= 10 && darkSpots().length > 0,
    make: () => ({ name: 'lighting', key: 'lighting', onUserStop: 'cancel', run: (ctx) => run(ctx, { manual: false }) })
  })

  const commands = [
    { name: 'lighting-status', help: 'lighting status | how many torches have you placed', risk: 'low', match: STATUS,
      run() { say(`I have placed ${state.placed.length} torches so far, know ${routes.size} cells on my routes, ${darkSpots().length} of them dark; carrying ${torches.count()} torches.`.slice(0, 230)) } },
    { name: 'lighting-routine', help: 'lighting routine on | lighting routine off', risk: 'low', match: ROUTINE,
      run(user, text, t) { const off = /\b(off|disable|stop)\b/.test(t); scheduler.setEnabled('lighting', !off); say(off ? 'Lighting routine off.' : 'Lighting routine on: when I am idle I put torches in dark spots on my routes.') } },
    { name: 'light-up', help: 'light up | place torches | fix the lighting', risk: 'high', match: LIGHT_UP,
      run() { nextAt = 0; say('OK, looking for dark spots on my routes.'); submit(true) } }
  ]
  for (const c of commands) { try { api.commands.add(c) } catch (e) { log(`command ${c.name} not added: ${e.message}`) } }

  return {
    name: 'lighting',
    stop() { bot.removeListener('move', onMove); if (dirty) save() },
    status: () => ({ running, routeCells: routes.size, placed: state.placed.length, torches: torches.count(), enabled: scheduler.isEnabled('lighting'), last }),
    torches, darkSpots, run, state, routes
  }
}
register.meta = require('./meta.json')

module.exports = register
module.exports.meta = register.meta
module.exports.phrases = { LIGHT_UP, STATUS, ROUTINE }
