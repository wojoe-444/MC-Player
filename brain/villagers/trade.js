// Trader: walks to a villager, makes sure it can be seen (Walter's line-of-sight rule), opens its trade window like a right click,
// records the offers, and buys wishlist items / sells surplus crops under the price caps and the emerald budget. Never hits a villager,
// never places or breaks anything.
const { Vec3 } = require('vec3')
const perceive = require('./perceive')
const trades = require('./trades')
const store = require('./state')
const common = require('../routines/common')

const STOP_NONE = /^(none|nitwit)$/
const REACH = 3.0            // interacting with an entity works up to ~3 blocks from the eye
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))])

module.exports = function createTrader({ bot, say, gotoNear, tryGoto, goals, safehand, stopNav = () => {}, canSee, config, state, save, now = Date.now, log = () => {} }) {
  let stopFlag = false, openWin = null
  const eye = () => bot.entity.position.offset(0, 1.62, 0)
  const invCounts = () => common.counts(bot)
  const days = (ms) => ms / 86400000
  const isTrader = (v) => v.kind === 'villager' && !STOP_NONE.test(v.profession || '') && !(v.baby)
  const fresh = (v) => v.lastSeen && days(now() - v.lastSeen) <= config.rememberDays

  // ---------- perception ----------
  function survey() {
    const list = perceive.scan(bot, { radius: config.scanRadius, canSee })
    store.remember(state, list, { now: now(), maxKnown: config.maxKnown })
    save()
    return list
  }

  // ---------- getting next to a villager and opening it ----------
  const entityOf = (id) => bot.entities && bot.entities[id]
  const distToEye = (e) => eye().distanceTo(e.position.offset(0, (e.height || 1.8) * 0.5, 0))

  async function approach(ctx, e) {
    for (let attempt = 0; attempt < 3; attempt++) {
      ctx.checkpoint()
      if (!entityOf(e.id)) return { ok: false, why: 'it moved out of reach' }
      if (distToEye(e) > REACH) {
        await safehand.ensureSafeForMove()
        const p = e.position.floored()
        await gotoNear({ pos: p, radius: 2, reach: 2.6, label: 'a villager', ctx, ms: config.approachMs })
      }
      ctx.checkpoint()
      if (distToEye(e) <= REACH + 0.4 && canSee(e)) return { ok: true }
      if (distToEye(e) <= REACH + 0.4) {          // close but something is in the way: try a few other spots around it
        for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
          ctx.checkpoint()
          await safehand.ensureSafeForMove()
          await tryGoto(new goals.GoalNear(Math.floor(e.position.x) + dx, Math.floor(e.position.y), Math.floor(e.position.z) + dz, 1), 'a spot with a clear view of a villager', 15000)
          if (distToEye(e) <= REACH + 0.4 && canSee(e)) return { ok: true }
        }
        return { ok: false, why: 'no clear line of sight to it' }
      }
    }
    return { ok: false, why: 'I could not get next to it' }
  }

  async function closeWin() { const w = openWin; openWin = null; if (!w) return; try { typeof w.close === 'function' ? w.close() : bot.closeWindow(w) } catch (e) { log(`close window: ${e.message}`) } }

  // Walk to `rec`, open its trade window, record the offers, run act(win, descs) and close. Returns { ok, why, ...act result }.
  async function visit(ctx, rec, act) {
    let e = entityOf(rec.id)
    if (!e && rec.pos) {                           // remembered but not loaded: walk to where it was and look again
      await safehand.ensureSafeForMove()
      await gotoNear({ pos: rec.pos, radius: 6, reach: 8, label: 'where I saw a villager', ctx, ms: config.approachMs })
      survey()
      e = entityOf(rec.id) || perceive.scan(bot, { radius: 10, canSee }).filter((x) => x.kind === 'villager' && x.entity.position.distanceTo(new Vec3(rec.pos.x, rec.pos.y, rec.pos.z)) < 6)[0]?.entity
    }
    if (!e) return { ok: false, why: 'I could not find it again' }
    const near = await approach(ctx, e)
    if (!near.ok) return near
    let win
    try { win = await withTimeout(bot.openVillager(e), 8000, 'opening the trade window'); openWin = win }
    catch (err) { return { ok: false, why: `could not open its trades (${err.message})` } }
    try {
      const descs = (win.trades || []).map((t, i) => trades.describeTrade(t, i))
      store.recordOffers(state, rec.id, descs, now())
      const rec2 = state.villagers[rec.id]; if (rec2 && !rec2.profession) { const p = perceive.professionOf(e); if (p) rec2.profession = p }
      save()
      return { ok: true, ...(await act(win, descs, e)) }
    } finally { await closeWin() }
  }

  const danger = () => common.danger(bot, { minHealth: config.minHealth, radius: config.dangerRadius })

  // ---------- candidates ----------
  function candidates({ matcher = null, onlyJobs = true } = {}) {
    const me = bot.entity.position
    const all = Object.values(state.villagers).filter((v) => v.kind === 'villager' && v.pos && fresh(v) && (!onlyJobs || isTrader(v)))
    const dist = (v) => me.distanceTo(new Vec3(v.pos.x, v.pos.y, v.pos.z))
    const rank = (v) => (matcher && v.offers && v.offers.length && v.offers.some(matcher) ? 0 : !v.offers || !v.offers.length ? 1 : 2)
    return all.sort((a, b) => rank(a) - rank(b) || dist(a) - dist(b))
  }

  // ---------- buying ----------
  async function buy(ctx, query, { maxVisits = 6 } = {}) {
    stopFlag = false
    const want = trades.resolveWant(query, config, bot.registry)
    if (!want) return { ok: false, why: `I do not know what "${String(query).trim()}" is. Try a book like mending, or an item like diamond pickaxe.` }
    survey()
    let budgetLeft = config.budget.emeraldsPerRun
    const matcher = (o) => !!o.out && want.match({ out: o.out })
    const cands = candidates({ matcher })
    if (!cands.length) return { ok: false, why: 'I do not know any villager with a job yet. Say "find villagers" when some are in view.' }
    const notes = []
    let visited = 0
    for (const v of cands) {
      if (stopFlag || visited >= maxVisits) break
      const d = danger(); if (d) return { ok: false, why: `I stopped because ${d}.`, notes }
      visited++
      const res = await visit(ctx, v, async (win, descs) => {
        const inv = invCounts(); inv.emerald = Math.max(0, (inv.emerald || 0) - config.budget.keepEmeralds)
        const picks = descs.map((dsc) => ({ dsc, ev: trades.evaluateBuy(dsc, want, inv, budgetLeft) })).filter((x) => x.ev.ok)
          .sort((a, b) => trades.emeraldCost(a.dsc) - trades.emeraldCost(b.dsc))
        if (!picks.length) {
          const seen = descs.filter((dsc) => want.match(dsc))
          if (seen.length) { const w = trades.evaluateBuy(seen[0], want, inv, budgetLeft); return { bought: null, why: `${trades.label(seen[0])} for ${trades.price(seen[0])}: ${w.why}` } }
          return { bought: null, why: null }
        }
        const { dsc, ev } = picks[0]
        const before = invCounts()[dsc.out.name] || 0
        await win.trade(dsc.index, ev.times)
        const got = (invCounts()[dsc.out.name] || 0) - before
        if (got <= 0) return { bought: null, why: 'the trade did not go through' }
        budgetLeft -= ev.emeralds
        store.recordDeal(state, { villager: v.id, kind: 'buy', what: trades.label(dsc), times: ev.times, emeralds: ev.emeralds }, { now: now(), ledgerMax: config.ledgerMax })
        save()
        return { bought: { what: trades.label(dsc), times: ev.times, emeralds: ev.emeralds, price: trades.price(dsc) } }
      })
      if (res.ok && res.bought) return { ok: true, bought: res.bought, from: state.villagers[v.id], notes }
      if (res.why) notes.push(res.why)
    }
    return { ok: false, why: notes.length ? notes[0] : `No villager I have visited offers ${want.label}.`, notes, visited }
  }

  // ---------- selling surplus crops ----------
  async function sellCrops(ctx) {
    stopFlag = false
    survey()
    const inv0 = invCounts()
    const sellable = config.sell.items.filter((n) => (inv0[n] || 0) > (config.sell.keep[n] || 0))
    if (!sellable.length) return { ok: true, earned: 0, sold: {}, nothing: true }
    const wantProf = new Set(sellable.map((n) => config.sell.professions[n]).filter(Boolean))
    const matcher = (o) => !!o.out && o.out.name === 'emerald' && o.in1 && sellable.includes(o.in1.name)
    const cands = candidates({ matcher }).filter((v) => !v.profession || wantProf.has(v.profession) || (v.offers || []).some(matcher))
    const sold = {}; let earned = 0
    for (const v of cands) {
      if (stopFlag) break
      const d = danger(); if (d) return { ok: false, why: `I stopped because ${d}.`, sold, earned }
      await visit(ctx, v, async (win, descs) => {
        for (const dsc of descs) {
          ctx.checkpoint()
          const ev = trades.evaluateSell(dsc, invCounts(), config.sell)
          if (!ev.ok) continue
          const before = invCounts().emerald || 0
          await win.trade(dsc.index, ev.times)
          const gained = (invCounts().emerald || 0) - before
          if (gained <= 0) continue
          sold[dsc.in1.name] = (sold[dsc.in1.name] || 0) + ev.times * dsc.in1.count; earned += gained
          store.recordDeal(state, { villager: v.id, kind: 'sell', what: dsc.in1.name, times: ev.times, emeralds: gained }, { now: now(), ledgerMax: config.ledgerMax })
        }
        save()
        return {}
      }).catch((e) => { if (e && e.name === 'AbortError') throw e; log(`sell visit ${v.id}: ${e.message}`) })
    }
    return { ok: true, sold, earned, nothing: !earned }
  }

  // ---------- refreshing what the nearby villagers offer (upkeep) ----------
  async function refreshOffers(ctx, { max = 3, maxAgeMs = 6 * 3600 * 1000 } = {}) {
    stopFlag = false
    survey()
    const stale = candidates().filter((v) => !v.offersAt || now() - v.offersAt > maxAgeMs).slice(0, max)
    let n = 0
    for (const v of stale) {
      if (stopFlag || danger()) break
      const r = await visit(ctx, v, async () => ({})).catch((e) => { if (e && e.name === 'AbortError') throw e; return { ok: false } })
      if (r.ok) n++
    }
    return { refreshed: n }
  }

  // best known deal on the wishlist from the remembered offers (no walking): [{villager, what, price, emeralds}]
  function knownDeals() {
    const wants = trades.wishWant(config, bot.registry), out = []
    for (const v of Object.values(state.villagers)) for (const o of v.offers || []) {
      const d = { index: o.index, in1: o.in1, in2: o.in2, out: o.out, left: o.left, disabled: !o.left }
      for (const w of wants) if (w.match(d) && trades.emeraldCost(d) <= w.maxEmeralds) { out.push({ villager: v, what: trades.label(d), price: trades.price(d), emeralds: trades.emeraldCost(d) }); break }
    }
    return out.sort((a, b) => a.emeralds - b.emeralds)
  }

  function abort() { stopFlag = true; closeWin(); try { stopNav() } catch {} }
  const snapshot = () => ({
    known: Object.keys(state.villagers).length,
    jobs: Object.values(state.villagers).filter((v) => v.kind === 'villager' && v.profession && !STOP_NONE.test(v.profession)).length,
    spent: state.totals.spent, earned: state.totals.earned, deals: state.ledger.length
  })

  return { survey, visit, buy, sellCrops, refreshOffers, knownDeals, abort, snapshot, candidates }
}
