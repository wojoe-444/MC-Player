// Furnace upkeep (Walter's default routine for undirected time).
//   empty buckets leave the output chests -> fill at a lava depot (lava_cauldron) -> lava buckets go into the fuel chests;
//   spare cobblestone goes into the input chests. Reads chests, never takes anything except empty buckets (and the
//   lava buckets it made itself). Never digs or places. Lava is only ever held inside safehand.lavaMoment().
// Needs Walter's go before it runs on its own (scheduler routine 'furnace' is disabled by default).
const fs = require('fs')
const { Vec3 } = require('vec3')
const { gotoNear, sleep, fmt, dimOf } = require('./util')
const smeltables = require('./smeltables')

const CHEST_NAMES = new Set(['chest', 'trapped_chest', 'barrel'])
const V = (a) => new Vec3(a[0], a[1], a[2])
const key = (p) => `${p.x},${p.y},${p.z}`

module.exports = function install({ bot, say, goals, tryGoto, safehand, stopNav = () => {}, gotoNear: gotoNearDep = null, ensureLos = null, config, stateFile = null, now = Date.now, log = () => {} }) {
  const T = { fuelMin: 4, fuelTop: 6, maxCarryLava: 12, reserveCobble: 48, minCobbleToDeposit: 32, smeltableTriggerFree: 6, noopBackoffMinutes: 15, overdueMinutes: 90, minAttemptGapMinutes: 3, keepFood: 64, keepLogs: 32, outputWarnFraction: 0.8, checkIntervalMinutes: 10, minHealth: 12, ...(config.targets || {}) }
  const itemId = (n) => bot.registry.itemsByName[n].id
  const have = (n) => bot.inventory.items().filter(i => i.name === n).reduce((s, i) => s + i.count, 0)
  const units = []
  for (const st of config.stations) for (const [i, u] of st.units.entries()) units.push({ station: st, idx: i, name: `${st.id}${st.units.length > 1 ? '.' + (i + 1) : ''}`, furnace: V(u.furnace), fuel: V(u.fuel), input: V(u.input), output: V(u.output), hopper: u.hopper ? V(u.hopper) : V(u.fuel).offset(0, -1, 0) })

  let state = { lastRunAt: 0, lastSurveyAt: 0, lastResult: null, chests: {}, depots: {}, warned: {}, lastError: null }
  try { if (stateFile) state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, 'utf8').replace(/^﻿/, '')) } } catch {}
  const save = () => { if (!stateFile) return; try { const tmp = stateFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state, null, 1)); fs.renameSync(tmp, stateFile) } catch (e) { log('furnace state save failed: ' + e.message) } }
  state.hoppers = state.hoppers || {}
  let running = false

  // Warn about the same problem at most every 30 minutes.
  // A shortage is announced once and stays quiet until it has cleared (clearShortage), whatever the number of later passes.
  function announceOnce(cond, text) { if (state.warned['flag:' + cond]) return; state.warned['flag:' + cond] = true; say(text) }
  function clearShortage(cond) { if (state.warned['flag:' + cond]) { delete state.warned['flag:' + cond]; save() } }
  function warnOnce(cond, text) {
    if (now() - (state.warned[cond] || 0) < 30 * 60000) return
    state.warned[cond] = now(); say(text)
  }

  const move = async (ctx, pos, label, radius = 3) => {
    await safehand.ensureSafeForMove()
    return (gotoNearDep || gotoNear)({ bot, goals, tryGoto, ctx, pos, radius, label, ms: 60000, stop: stopNav })
  }

  // Walter's rule: only touch what a crosshair could point at. Walks to a spot with a clear view when needed.
  const seen = async (ctx, pos, label) => {
    if (!ensureLos) return true
    const blk = bot.blockAt(pos)
    return blk ? ensureLos({ ctx, target: blk, label: label + ' (clear view)' }) : false
  }

  // ---------- reading chests ----------
  async function readChest(ctx, pos, role, unit, { takeBuckets = false } = {}) {
    const k = key(pos)
    const rec = { role, unit: unit.name, at: now() }
    const reach = await move(ctx, pos, `${role} chest`)
    if (!reach) { rec.error = `unreachable${bot._lastGotoErr ? ' (' + bot._lastGotoErr + ')' : ''}`; state.chests[k] = { ...state.chests[k], ...rec }; return null }
    if (!(await seen(ctx, pos, `${role} chest`))) { rec.error = 'no clear line of sight to the chest'; state.chests[k] = rec; return null }
    const blk = bot.blockAt(pos)
    if (!blk || !CHEST_NAMES.has(blk.name)) { rec.error = `expected a chest, found ${blk ? blk.name : 'unloaded block'}`; state.chests[k] = rec; return null }
    let win
    try {
      win = await bot.openContainer(blk)
      const items = win.containerItems(), tally = {}
      for (const it of items) tally[it.name] = (tally[it.name] || 0) + it.count
      rec.items = tally; rec.slots = win.inventoryStart; rec.used = items.length
      if (role === 'input') {
        // the hopper under an input chest pushes ANY item into the furnace's input slot; one it cannot smelt (a sapling) blocks that slot for good
        rec.junk = Object.keys(tally).filter(n => !smeltables.isSmeltable(n))
        if (rec.junk.length) warnOnce(`junk:${k}`, `The ${unit.name} input chest holds ${rec.junk.slice(0, 3).map(n => `${tally[n]} ${n}`).join(', ')}: the hopper will push it into the furnace and jam it. Please take it out (I leave other people's items alone).`.slice(0, 230))
      }
      if (takeBuckets && tally.bucket && bot.inventory.emptySlotCount() >= 2) {
        const n = tally.bucket
        await win.withdraw(itemId('bucket'), null, n)
        rec.items = { ...tally }; delete rec.items.bucket
        rec.used = items.filter(i => i.name !== 'bucket').length
        rec.tookBuckets = n
      }
    } catch (e) { rec.error = e.message }
    finally { try { win && win.close() } catch {} }
    state.chests[k] = rec
    return rec
  }

  // Walter's rule: the fuel is only "low" when the feeder hopper (under the fuel chest, pushing into the furnace) holds 0 or 1 lava buckets; chest counts alone
  // do not trigger refill trips or "low" reports (the hopper keeps up to 5 buckets for itself, so a chest with 2 is not a problem).
  async function readHopper(ctx, u) {
    const k = key(u.hopper), rec = { unit: u.name, at: now() }
    const blk = bot.blockAt(u.hopper)
    if (!blk || blk.name !== 'hopper') { rec.error = `expected a hopper, found ${blk ? blk.name : 'unloaded block'}`; state.hoppers[k] = rec; return null }
    if (!(await move(ctx, u.hopper, `${u.name} feeder hopper`)) || !(await seen(ctx, u.hopper, `${u.name} feeder hopper`))) { rec.error = 'unreachable or not in view'; state.hoppers[k] = rec; return null }
    let win
    try { win = await bot.openContainer(blk); rec.lava = win.containerItems().filter(i => i.name === 'lava_bucket').reduce((a, i) => a + i.count, 0) }
    catch (e) { rec.error = e.message } finally { try { win && win.close() } catch {} }
    state.hoppers[k] = rec
    return rec.lava ?? null
  }
  const hopperLava = (u) => { const r = state.hoppers[key(u.hopper)]; return r && r.lava !== undefined && !r.error ? r.lava : null }
  // low = feeder hopper holds 0 or 1 (falls back to the old chest rule only when the hopper cannot be read)
  const isLow = (u) => { const h = hopperLava(u); if (h !== null) return h <= 1; const f = fuelOf(u); return f !== null && f < T.fuelMin }

  // Visits every chest of every unit (nearest station first). collect=true also takes the empty buckets out of the outputs.
  async function survey(ctx, { collect }) {
    const order = [...new Set(units.map(u => u.station))].sort((a, b) => dist(a.units[0].fuel) - dist(b.units[0].fuel))
    let buckets = 0
    for (const st of order) {
      for (const u of units.filter(x => x.station === st)) {
        // output first: it is the chest the bot can walk up to; the fuel/input chests above it are then within arm's reach
        // (a path search straight to the elevated chests times out on the real build)
        const order = [['output', u.output], ['fuel', u.fuel], ['input', u.input]]
        for (const [role, pos] of order) {
          const prev = state.chests[key(pos)]
          if (ctx && ctx.resumed && prev && !prev.error && now() - prev.at < 180000) continue   // resumed after a pause: keep what was already read
          await readChest(ctx, pos, role, u)
        }
        { const prevH = state.hoppers[key(u.hopper)]; if (!(ctx && ctx.resumed && prevH && !prevH.error && now() - prevH.at < 180000)) await readHopper(ctx, u) }
        // only take empty buckets from a unit whose fuel chest is low (known now); shortfalls are topped up by collectExtra()
        const f = fuelOf(u), out = state.chests[key(u.output)]
        if (collect && isLow(u) && out && out.items && out.items.bucket) {
          const r = await readChest(ctx, u.output, 'output', u, { takeBuckets: true })
          if (r && r.tookBuckets) buckets += r.tookBuckets
        }
      }
    }
    state.lastSurveyAt = now(); save()
    return { buckets }
  }
  const dist = (p) => bot.entity.position.distanceTo(p)

  // Not enough empty buckets for the deficits? Fetch more from other output chests that are known to hold some.
  async function collectExtra(ctx, shortfall) {
    let got = 0
    for (const u of units.slice().sort((a, b) => dist(a.output) - dist(b.output))) {
      if (got >= shortfall) break
      const c = state.chests[key(u.output)]
      if (!c || !c.items || !c.items.bucket) continue
      const r = await readChest(ctx, u.output, 'output', u, { takeBuckets: true })
      if (r && r.tookBuckets) got += r.tookBuckets
    }
    return got
  }

  // ---------- lava depots ----------
  function cauldrons(depot) {
    const { min, max } = depot.box, out = []
    for (let x = min[0]; x <= max[0]; x++) for (let y = min[1]; y <= max[1]; y++) for (let z = min[2]; z <= max[2]; z++) out.push(new Vec3(x, y, z))
    return out
  }
  function depotStatus(depot) {
    const all = cauldrons(depot); let lava = 0, loaded = 0
    for (const p of all) { const b = bot.blockAt(p); if (!b) continue; loaded++; if (b.name === 'lava_cauldron') lava++ }
    if (loaded) state.depots[depot.id] = { lava, total: all.length, at: now() }
    return { depot, lava, total: all.length, loaded }
  }

  async function fillAt(ctx, depot, want) {
    let made = 0, misses = 0
    const bucketsLeft = () => have('bucket')
    const lavaNow = () => have('lava_bucket')
    const pending = cauldrons(depot).filter(p => { const b = bot.blockAt(p); return b && b.name === 'lava_cauldron' })
    while (made < want && bucketsLeft() > 0 && pending.length && misses < 3) {
      ctx && ctx.checkpoint()
      pending.sort((a, b) => dist(a) - dist(b))
      const p = pending.shift()
      if (!(await move(ctx, p, depot.label, 2))) continue
      if (!(await seen(ctx, p, depot.label))) { misses++; log(`no clear view of cauldron ${fmt(p)}`); continue }
      const before = lavaNow()
      await safehand.lavaMoment(async () => {
        const bucket = bot.inventory.items().find(i => i.name === 'bucket')
        await bot.equip(bucket, 'hand')
        await bot.activateBlock(bot.blockAt(p))
        for (let i = 0; i < 25 && lavaNow() === before; i++) await sleep(100)
      })
      if (lavaNow() > before) { made++; misses = 0 } else { misses++; log(`no lava from cauldron ${fmt(p)}`) }
    }
    return made
  }

  // ---------- planning ----------
  function fuelOf(u) { const c = state.chests[key(u.fuel)]; return c && c.items ? (c.items.lava_bucket || 0) : null }
  function deficits() {
    return units.map(u => { const f = fuelOf(u); return { u, have: f, need: f === null || !isLow(u) ? 0 : Math.max(0, T.fuelTop - f) } })
      .filter(d => d.need > 0).sort((a, b) => b.need - a.need)
  }

  async function deliver(ctx, ds) {
    let delivered = 0
    // Fair split: first bring every low chest up to the minimum (lowest first), only then top up towards fuelTop.
    let pool = have('lava_bucket')
    const alloc = new Map(ds.map(d => [d, 0]))
    for (const d of ds.slice().sort((a, b) => a.have - b.have)) { const g = Math.min(Math.max(0, T.fuelMin - d.have), pool); alloc.set(d, g); pool -= g }
    for (const d of ds.slice().sort((a, b) => a.have - b.have)) { const g = Math.min(d.need - alloc.get(d), pool); if (g > 0) { alloc.set(d, alloc.get(d) + g); pool -= g } }
    for (const d of ds) {
      let lava = have('lava_bucket'); if (!lava) break
      const give = Math.min(alloc.get(d), lava)
      if (!give) continue
      if (!(await move(ctx, d.u.fuel, 'fuel chest'))) { state.lastError = `cannot reach fuel chest ${fmt(d.u.fuel)}`; continue }
      if (!(await seen(ctx, d.u.fuel, 'fuel chest'))) { state.lastError = `no clear view of fuel chest ${fmt(d.u.fuel)}`; continue }
      const blk = bot.blockAt(d.u.fuel); let win
      try {
        win = await bot.openContainer(blk)
        await win.deposit(itemId('lava_bucket'), null, give)
        const c = state.chests[key(d.u.fuel)] || (state.chests[key(d.u.fuel)] = { role: 'fuel', unit: d.u.name, items: {} })
        c.items = { ...(c.items || {}), lava_bucket: (c.items?.lava_bucket || 0) + give }; c.at = now()
        delivered += give; d.delivered = give
      } catch (e) { state.lastError = `fuel deposit ${d.u.name}: ${e.message}`; log(state.lastError) }
      finally { try { win && win.close() } catch {} }
    }
    return delivered
  }

  // Smeltables into the auto-furnace input chests (rules in smeltables.js). Triggered by the periodic pass or by any module whose inventory
  // is filling up (api.depositSmeltables): only when <= T.smeltableTriggerFree slots are free unless force. Never throws items away:
  // when every input chest is full it stops and reports { full: true, left: [...] } so the caller can pause.
  let lastFullWarn = 0
  async function depositSmeltables(ctx, opts = {}) {
    const force = !!opts.force
    if (!force && bot.inventory.emptySlotCount() > T.smeltableTriggerFree) return { skipped: true, moved: {}, left: [], full: false }
    let todo = smeltables.plan(bot.inventory.items(), { reserveCobble: T.reserveCobble, keepFood: T.keepFood, keepLogs: T.keepLogs })
    if (!todo.length) return { moved: {}, left: [], full: false }
    // small cobblestone amounts are not worth a trip unless the inventory is nearly full
    if (!force && bot.inventory.emptySlotCount() > T.smeltableTriggerFree) todo = todo.filter(t => t.name !== 'cobblestone' || t.count >= T.minCobbleToDeposit)
    const moved = {}
    const cands = units.map(u => ({ u, rec: state.chests[key(u.input)] }))
      .filter(c => !c.rec || !c.rec.error || now() - c.rec.at > 30 * 60000)          // an unreachable chest is retried every half hour
    const remaining = () => smeltables.plan(bot.inventory.items(), { reserveCobble: T.reserveCobble, keepFood: T.keepFood, keepLogs: T.keepLogs })
    // Balance the load: chests holding the least go first, and each item type is split between the reachable chests instead of piling
    // everything into the nearest one (one chest had 1262 cobblestone while the others starved).
    const load = (u) => { const c = state.chests[key(u.input)]; return c && c.items ? Object.values(c.items).reduce((a, b) => a + b, 0) : 0 }
    cands.sort((a, b) => load(a.u) - load(b.u) || dist(a.u.input) - dist(b.u.input))
    const nCands = cands.length
    let visited = 0
    for (const { u } of cands) {
      if (!remaining().length) break
      ctx && ctx.checkpoint()
      if (!(await move(ctx, u.input, 'input chest'))) continue
      if (!(await seen(ctx, u.input, 'input chest'))) continue
      const blk = bot.blockAt(u.input); let win
      try {
        win = await bot.openContainer(blk)
        let misses = 0
        for (const t of remaining()) {
          if (misses >= 2) break                       // two item types in a row would not go in: this chest is full, do not wait for every other type
          const before = have(t.name)
          const share = visited < nCands - 1 ? Math.max(1, Math.ceil(t.count / (nCands - visited))) : t.count
          try { await win.deposit(itemId(t.name), null, share) } catch (e) { log(`deposit ${t.name}: ${e.message}`) }
          const got = before - (await settle(t.name, before))   // the server's inventory update arrives after the click
          if (got > 0) { moved[t.name] = (moved[t.name] || 0) + got; misses = 0 } else misses++
        }
        const c = state.chests[key(u.input)] || (state.chests[key(u.input)] = { role: 'input', unit: u.name, items: {} })
        delete c.error; c.at = now()
        const tally = {}; for (const it of win.containerItems()) tally[it.name] = (tally[it.name] || 0) + it.count
        c.items = tally; c.slots = win.inventoryStart; c.used = win.containerItems().length
      } catch (e) { log('input chest: ' + e.message) }
      finally { try { win && win.close() } catch {} }
      visited++
    }
    const left = remaining()
    const total = Object.values(moved).reduce((a, b) => a + b, 0)
    if (total) { state.lastSmelt = { at: now(), moved }; save(); if (!opts.quiet) say(`Put into the furnace input chests: ${Object.entries(moved).map(([n, c]) => `${c} ${n}`).join(', ')}.`.slice(0, 230)) }
    const full = left.length > 0 && cands.length > 0
    if (full && now() - lastFullWarn > 10 * 60000) {
      lastFullWarn = now()
      say(`The furnace input chests are full or out of reach (${left.slice(0, 3).map(t => `${t.count} ${t.name}`).join(', ')} left). I won't throw anything away; tell me where to put it.`.slice(0, 230))
    }
    return { moved, left, full, cantReach: cands.length === 0 }
  }
  const depositCobble = async (ctx) => { const r = await depositSmeltables(ctx, { force: true, quiet: true }); return r.moved.cobblestone || 0 }

  function checkOutputs() {
    for (const u of units) {
      const c = state.chests[key(u.output)]
      if (c && c.slots && c.used / c.slots >= T.outputWarnFraction) warnOnce(`full:${u.name}`, `Heads up: the ${u.name} output chest is ${Math.round(100 * c.used / c.slots)}% full. Tell me where the stone should go and I'll move it.`)
    }
  }

  // ---------- the routine ----------
  async function run(ctx) {
    if (running) return { status: 'done' }
    running = true
    state.lastAttemptAt = now()
    const summary = { filled: 0, delivered: 0, buckets: 0, cobble: 0, notes: [] }
    try {
      if (dimOf(bot) !== 'overworld') return { status: 'retry', afterMs: 120000 }
      await safehand.stow()
      if (ctx && ctx.resumed && now() - state.lastSurveyAt < 5 * 60000) { /* reuse the survey from before the interruption */ }
      else { const r = await survey(ctx, { collect: true }); summary.buckets = r.buckets }
      for (let trip = 0; trip < 3; trip++) {
        ctx && ctx.checkpoint()
        const ds = deficits()
        const needLava = ds.reduce((s, d) => s + d.need, 0)
        const carrying = have('lava_bucket')
        const short = Math.min(needLava, T.maxCarryLava) - carrying - have('bucket')
        if (short > 0) summary.buckets += await collectExtra(ctx, short)
        let toMake = Math.min(needLava - carrying, have('bucket'), T.maxCarryLava - carrying)
        if (toMake > 0) {
          const depots = config.depots.map(depotStatus).filter(s => s.lava > 0).sort((a, b) => dist(V(a.depot.box.min)) - dist(V(b.depot.box.min)))
          if (!depots.length) { announceOnce('depots-dry', 'Both lava depots look dry (no full lava cauldrons). They refill slowly from the dripstone; I will try again later.'); summary.notes.push('depots dry') }
          for (const s of depots) {
            if (toMake <= 0) break
            const n = await fillAt(ctx, s.depot, toMake)
            summary.filled += n; toMake -= n
          }
        } else if (needLava > 0 && have('bucket') === 0 && carrying === 0) {
          announceOnce('no-buckets', 'A fuel feeder is low but I have no empty buckets. None in the output chests either; give me a few buckets or tell me where they are.')
          summary.notes.push('no empty buckets')
        }
        if (have('lava_bucket') > 0 && ds.length) summary.delivered += await deliver(ctx, ds)
        else break
        if (!deficits().length) break
      }
      summary.smelt = await depositSmeltables(ctx, { force: true, quiet: true })
      summary.cobble = summary.smelt.moved.cobblestone || 0
      checkOutputs()
      if (have('bucket') > 0 || summary.buckets > 0) clearShortage('no-buckets')
      if (summary.filled > 0) clearShortage('depots-dry')
      const moved = Object.keys(summary.smelt.moved).length > 0
      summary.noop = !summary.filled && !summary.delivered && !summary.buckets && !moved
      state.lastRunAt = now()
      state.lastResult = { at: now(), ...summary }
      save()
      const bits = []
      if (summary.delivered) bits.push(`${summary.delivered} lava bucket(s) into the fuel chests`)
      if (summary.buckets) bits.push(`took ${summary.buckets} empty bucket(s)`)
      const sm = Object.entries(summary.smelt.moved); if (sm.length) bits.push(`${sm.map(([n, c]) => `${c} ${n}`).join(', ')} into input chests`)
      if (bits.length) say(`Furnace upkeep: ${bits.join(', ')}.`.slice(0, 230))
      return { status: 'done' }
    } catch (e) {
      if (e.name !== 'AbortError') { state.lastError = e.message; save(); say(`Furnace upkeep stopped: ${e.message}`.slice(0, 200)) }
      throw e
    } finally {
      running = false
      try { await safehand.stow() } catch {}
    }
  }

  // Read-only dry run: walks to the chests, reads them, reports what a real run would do. Takes nothing.
  async function plan(ctx) {
    const lines = []
    await safehand.stow()
    await survey(ctx, { collect: false })
    const ds = deficits()
    const needLava = ds.reduce((s, d) => s + d.need, 0)
    const bucketsInOutputs = units.reduce((s, u) => s + (state.chests[key(u.output)]?.items?.bucket || 0), 0)
    const depots = config.depots.map(depotStatus)
    const fuel = units.map(u => `${u.name}: ${fuelOf(u) ?? '?'} in the chest, ${hopperLava(u) ?? '?'} in the feeder${isLow(u) ? ' (LOW)' : ''}`).join('; ')
    lines.push(`Fuel chests: ${fuel}.`)
    lines.push(needLava ? `Would add ${needLava} lava bucket(s) (target ${T.fuelMin}+ each); empty buckets available: ${have('bucket') + bucketsInOutputs}.` : `All fuel chests have at least ${T.fuelMin}; nothing to refill.`)
    lines.push('Depots: ' + depots.map(s => `${s.depot.id} ${s.loaded ? s.lava + '/' + s.total + ' full' : 'not loaded from here'}`).join(', ') + '.')
    const probs = verify().filter(p => !p.startsWith('unloaded'))
    if (probs.length) lines.push('Config problems: ' + probs.slice(0, 3).join('; '))
    return lines
  }

  // Read-only diagnosis of why a station is not smelting: furnace slots and lit state, the hoppers around each furnace (contents, facing,
  // enabled = false means a redstone lock), and fresh chest contents. Opens things only to read; takes nothing. Full detail goes to furnace-inspect.txt.
  async function inspect(ctx) {
    const lines = [], detail = []
    const itemStr = (it) => (it ? `${it.name}x${it.count}` : 'empty')
    for (const u of units) {
      ctx && ctx.checkpoint()
      const parts = []
      const fb = bot.blockAt(u.furnace)
      const pr = fb && fb.getProperties ? fb.getProperties() : {}
      parts.push(`${fb ? fb.name : 'unloaded'} lit=${pr.lit}`)
      if (fb && typeof bot.openFurnace === 'function' && (await move(ctx, u.furnace, `${u.name} furnace`)) && (await seen(ctx, u.furnace, `${u.name} furnace`))) {
        let f
        try {
          f = await bot.openFurnace(fb)
          parts.push(`fuel=${itemStr(f.fuelItem())} input=${itemStr(f.inputItem())} output=${itemStr(f.outputItem())} burn=${f.fuel ?? '?'} progress=${f.progress ?? '?'}`)
        } catch (e) { parts.push(`furnace window: ${e.message}`) } finally { try { f && f.close() } catch {} }
      }
      for (const [lab, d] of [['above', [0, 1, 0]], ['below', [0, -1, 0]], ['north', [0, 0, -1]], ['south', [0, 0, 1]], ['east', [1, 0, 0]], ['west', [-1, 0, 0]]]) {
        const p = new Vec3(u.furnace.x + d[0], u.furnace.y + d[1], u.furnace.z + d[2])
        const b = bot.blockAt(p)
        if (!b || b.name === 'air') continue
        if (b.name !== 'hopper') { detail.push(`${u.name} ${lab} of furnace: ${b.name}`); continue }
        const hp = b.getProperties ? b.getProperties() : {}
        let held = '?'
        if (await seen(ctx, p, `${u.name} hopper`)) {
          let w
          try { w = await bot.openContainer(b); held = w.containerItems().map(i => `${i.name}x${i.count}`).join(',') || 'empty' } catch (e) { held = `window: ${e.message}` } finally { try { w && w.close() } catch {} }
        } else held = 'no clear view'
        parts.push(`hopper ${lab}: facing ${hp.facing} enabled=${hp.enabled} holds ${held}`)
      }
      lines.push(`${u.name}: ${parts.join(' | ')}`)
    }
    await survey(ctx, { collect: false })
    for (const u of units) { const c = state.chests[key(u.input)], fch = state.chests[key(u.fuel)]; lines.push(`${u.name} chests: fuel ${fch && fch.items ? JSON.stringify(fch.items) : fch && fch.error}, input ${c && c.items ? JSON.stringify(c.items) : c && c.error}`) }
    try { fs.writeFileSync('furnace-inspect.txt', [new Date(now()).toISOString(), ...lines, ...detail].join('\n')) } catch {}
    return lines
  }

  // A furnace whose INPUT slot holds something it cannot smelt (a sapling, a flower, ...) blocks the hopper above it forever: nothing else
  // can enter that slot. This takes such an item out (only items matching JUNK, never smeltables) and keeps it in the bag. Run on request
  // ("furnace unjam"); it takes nothing else.
  const JUNK = /sapling|leaves|flower|seeds|^stick$|dirt|gravel|^bone$|string|feather|wool|tulip|dandelion|poppy|^fern|vine|torch|^grass$|spore_blossom|azalea|bamboo/
  async function unjam(ctx) {
    const report = []
    for (const u of units) {
      ctx && ctx.checkpoint()
      const fb = bot.blockAt(u.furnace)
      if (!fb || typeof bot.openFurnace !== 'function') continue
      if (!(await move(ctx, u.furnace, `${u.name} furnace`)) || !(await seen(ctx, u.furnace, `${u.name} furnace`))) { report.push(`${u.name}: could not get to the furnace`); continue }
      let f
      try {
        f = await bot.openFurnace(fb)
        const it = f.inputItem()
        if (!it) continue
        if (JUNK.test(it.name)) { await f.takeInput(); report.push(`${u.name}: took ${it.count} ${it.name} out of the input slot (it blocked the hopper)`) }
        else if (!smeltables.isSmeltable(it.name)) report.push(`${u.name}: the input slot holds ${it.count} ${it.name}, which I do not recognise as smeltable; left alone`)
      } catch (e) { report.push(`${u.name}: ${e.message}`) } finally { try { f && f.close() } catch {} }
    }
    return report
  }

  // Wait for the server's inventory update after a chest click: poll until the count of `name` changes (or give up after ~2.5 s), then let
  // it settle. A fixed short sleep was not enough on the real server (the first balance run reported "moved 0" while 186 cobblestone had moved).
  async function settle(name, before) {
    for (let i = 0; i < 12 && have(name) === before; i++) await sleep(100)
    let last = have(name)
    for (let i = 0; i < 5; i++) { await sleep(120); const now_ = have(name); if (now_ === last) break; last = now_ }
    return last
  }
  // Even out the input chests: when one holds far more cobblestone than another, move half of the difference over (cobblestone only; it is
  // what the bot itself deposited). Everything used to pile into the nearest chest. Repeats in bag-sized rounds until balanced.
  async function balanceInputs(ctx) {
    const dep = await depositSmeltables(ctx, { force: true, quiet: true })   // unload the bag first (spread, emptiest chest first)
    let totalMoved = 0, last = ''
    for (let round = 0; round < 8; round++) {
      ctx && ctx.checkpoint()
      await survey(ctx, { collect: false })
      const rows = units.map(u => ({ u, rec: state.chests[key(u.input)] })).filter(r => r.rec && r.rec.items && !r.rec.error)
      if (rows.length < 2) return 'Fewer than two input chests are reachable, nothing to balance.'
      const cob = (r) => r.rec.items.cobblestone || 0
      rows.sort((a, b) => cob(b) - cob(a))
      const from = rows[0], to = rows[rows.length - 1]
      const want = Math.floor((cob(from) - cob(to)) / 2)
      if (want < 64) break
      const room = 64 * Math.max(0, bot.inventory.emptySlotCount() - 3)
      if (room <= 0) { last = 'My bag is too full to move cobblestone between chests; unload it first.'; break }
      const cobId = itemId('cobblestone')
      const start = have('cobblestone')
      if (!(await move(ctx, from.u.input, 'input chest')) || !(await seen(ctx, from.u.input, 'input chest'))) { last = `Could not reach the ${from.u.name} input chest.`; break }
      let win
      try {
        win = await bot.openContainer(bot.blockAt(from.u.input))
        await win.withdraw(cobId, null, Math.min(want, room))
      } catch (e) { last = `Balancing stopped: ${e.message}`; break } finally { try { win && win.close() } catch {} }
      const after = await settle('cobblestone', start)
      const taken = after - start
      if (taken <= 0) { last = 'Could not take cobblestone out of the fullest input chest.'; break }
      if (!(await move(ctx, to.u.input, 'input chest')) || !(await seen(ctx, to.u.input, 'input chest'))) { last = `Could not reach the ${to.u.name} input chest; I am carrying ${taken} cobblestone.`; break }
      try {
        win = await bot.openContainer(bot.blockAt(to.u.input))
        await win.deposit(cobId, null, taken)
      } catch (e) { last = `Balancing stopped while putting it back: ${e.message}`; break } finally { try { win && win.close() } catch {} }
      await settle('cobblestone', after)
      totalMoved += taken
    }
    const m = Object.entries(dep.moved).map(([n, c]) => `${c} ${n}`).join(', ')
    const parts = []
    if (m) parts.push(`unloaded my bag into the input chests (${m})`)
    if (totalMoved) parts.push(`moved ${totalMoved} cobblestone from the fullest input chest to the emptiest`)
    if (!parts.length && !last) return 'The input chests are already balanced.'
    return `${parts.length ? parts.join(', ') + '.' : ''} ${last}`.trim()
  }

  // Compare config coordinates with the blocks the bot can currently see.
  function verify() {
    const problems = []
    const expect = (pos, names, what) => {
      const b = bot.blockAt(pos)
      if (!b) { problems.push(`unloaded ${what} ${fmt(pos)}`); return }
      if (!names.includes(b.name)) problems.push(`${what} ${fmt(pos)} is ${b.name}`)
    }
    for (const u of units) {
      expect(u.furnace, ['furnace', 'blast_furnace', 'smoker'], `${u.name} furnace`)
      expect(u.fuel, [...CHEST_NAMES], `${u.name} fuel chest`)
      expect(u.input, [...CHEST_NAMES], `${u.name} input chest`)
      expect(u.output, [...CHEST_NAMES], `${u.name} output chest`)
    }
    for (const d of config.depots) {
      const all = cauldrons(d); const kinds = all.map(p => bot.blockAt(p)).filter(Boolean)
      if (!kinds.length) { problems.push(`unloaded depot ${d.id}`); continue }
      const bad = kinds.filter(b => !/cauldron/.test(b.name))
      if (bad.length) problems.push(`depot ${d.id}: ${bad.length} position(s) are not cauldrons (e.g. ${bad[0].name} at ${fmt(bad[0].position)})`)
    }
    return problems
  }

  function snapshot() {
    const ageS = (t) => t ? Math.round((now() - t) / 1000) : null
    return {
      running, lastRunAgoS: ageS(state.lastRunAt), lastSurveyAgoS: ageS(state.lastSurveyAt), lastResult: state.lastResult, lastError: state.lastError,
      units: units.map(u => {
        const f = state.chests[key(u.fuel)], i = state.chests[key(u.input)], o = state.chests[key(u.output)]
        return {
          name: u.name, furnace: fmt(u.furnace),
          fuelLava: f && f.items ? (f.items.lava_bucket || 0) : null, feederLava: hopperLava(u), low: isLow(u), fuelAgeS: f ? ageS(f.at) : null,
          inputItems: i && i.items ? Object.values(i.items).reduce((a, b) => a + b, 0) : null,
          outputPct: o && o.slots ? Math.round(100 * o.used / o.slots) : null, outputBuckets: o && o.items ? (o.items.bucket || 0) : null,
          errors: [f, i, o].filter(c => c && c.error).map(c => `${c.role}: ${c.error}`),
          junkInInput: i && i.junk ? i.junk : []
        }
      }),
      depots: config.depots.map(d => ({ id: d.id, lava: state.depots[d.id]?.lava ?? null, total: state.depots[d.id]?.total ?? cauldrons(d).length, ageS: ageS(state.depots[d.id]?.at) })),
      carrying: { lava: have('lava_bucket'), buckets: have('bucket'), cobble: have('cobblestone') }
    }
  }

  // Scheduler routine definition (disabled until Walter says go).
  // The idle check runs BELOW Walter's mining/excavation jobs (priority EXCAVATE-1) so a queued job is never delayed by a look at the chests; if no pass has
  // finished for overdueMinutes it is boosted to FURNACE priority so the fuel cannot run out. After a pass that changed nothing it waits noopBackoffMinutes.
  function routine(PRIORITY) {
    const interval = () => (state.lastResult && state.lastResult.noop ? Math.max(T.noopBackoffMinutes, T.checkIntervalMinutes) : T.checkIntervalMinutes) * 60000
    const overdue = () => now() - (state.lastRunAt || 0) > T.overdueMinutes * 60000
    return {
      name: 'furnace', priority: PRIORITY.EXCAVATE - 1, idleOnly: true, intervalMs: 30000, defaultEnabled: false,
      due: () => dimOf(bot) === 'overworld' && bot.health >= T.minHealth && now() - (state.lastRunAt || 0) >= interval() && now() - (state.lastAttemptAt || 0) >= T.minAttemptGapMinutes * 60000,
      make: () => ({ name: 'furnace', priority: overdue() ? PRIORITY.FURNACE : PRIORITY.EXCAVATE - 1, run })
    }
  }

  return { run, plan, inspect, unjam, balanceInputs, verify, snapshot, routine, depositSmeltables, smeltablesPlan: () => smeltables.plan(bot.inventory.items(), { reserveCobble: T.reserveCobble, keepFood: T.keepFood, keepLogs: T.keepLogs }), depotStatus, units, state: () => state, isRunning: () => running }
}
