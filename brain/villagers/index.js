// brain/villagers: find villagers, trade for wishlist items (books, diamond gear, arrows...), sell surplus crops for emeralds, and a
// switched-off-by-default idle "villager upkeep". Phase 0 of DESIGN.md: it only talks to villagers; it never places or breaks blocks.
const path = require('path')
const store = require('./state')
const perceive = require('./perceive')
const trades = require('./trades')
const createTrader = require('./trade')
const baseConfig = require('./config.json')

const P = {
  FIND: /\b(find|look for|locate|search for|spot|where (are|is) (the |any )?)\s*(some |any |the )?villagers?\b|\bvillagers? (nearby|around|near me|near here)\b|\bany villagers?\b/,
  STATUS: /\bvillagers? (status|report|ledger|deals)\b|\bhow (are|is) the villagers?\b|\bvillager economy\b/,
  TRADE: /\btrade (?:for|with villagers? for)\s+(.+)$|\b(?:buy|get) (?:me )?(?:a |an |some )?(.+?) from (?:a |the )?(?:villagers?|librarian|toolsmith|armorer|weaponsmith|fletcher|farmer|cleric)\b/,
  SELL: /\bsell (?:my |the |our |extra |spare |surplus )*(crops?|food|carrots?|potatoes|wheat|beetroots?)(?: to (?:a |the )?(?:farmer|villagers?))?\b/,
  PLAN: /^(?!.*\bapprove\b).*(\bvillager (plan|hall)\b|\bplan (the |a )?(villager|trading) hall\b)/,
  APPROVE: /\bapprove (the )?villager (plan|hall)\b/,
  UPKEEP_ON: /\bvillager upkeep\b.*\b(on|start|enable)\b|\b(start|enable|turn on)\b.*\bvillager upkeep\b/,
  UPKEEP_OFF: /\bvillager upkeep\b.*\b(off|stop|disable)\b|\b(stop|disable|turn off)\b.*\bvillager upkeep\b/
}
const NEG = /^(?:please )?(?:don'?t|do not|never|no need to|no more|stop|cancel|quit)\b/
const FILLER = /\b(hey|yo|claude|bot|ozogo444|please|pls|plz|can you|could you|would you|will you|can u|go ahead and|just|now|for me)\b/g
const norm = (text) => String(text).toLowerCase().replace(/[^\w\s',.-]/g, ' ').replace(FILLER, ' ').replace(/\s+/g, ' ').trim()
const clip = (s, n = 230) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

function register(api) {
  const { scheduler, say, PRIORITY, bot } = api
  const log = (m) => api.log('villagers', m)
  const config = { ...baseConfig, budget: { ...baseConfig.budget }, upkeep: { ...baseConfig.upkeep } }
  const file = api.statePath('villagers-state.json')
  const state = store.load(file, log)
  const save = () => store.save(file, state, api.now, log)

  const trader = createTrader({ bot, say, gotoNear: api.gotoNear, tryGoto: api.tryGoto, goals: api.goals, safehand: api.safehand, stopNav: api.stopNav, canSee: api.canSee, config, state, save, now: api.now, log })
  const emeralds = () => bot.inventory.items().filter((i) => i.name === 'emerald').reduce((s, i) => s + i.count, 0)

  const job = (name, run) => scheduler.submit({ name: `villagers:${name}`, key: 'villagers', priority: PRIORITY.CHAT, onUserStop: 'cancel', abort: () => trader.abort(), run })

  // ---------- commands ----------
  function find() {
    const list = trader.survey()
    const line = perceive.summarize(list)
    say(line ? clip(line) : 'I do not see any villagers within ' + config.scanRadius + ' blocks. I will not guess: tell me where a village is, or I look again when I walk somewhere new.')
  }
  function status() {
    const s = trader.snapshot(), plan = state.plan
    const deals = trader.knownDeals().slice(0, 2).map((d) => `${d.what} for ${d.price}`).join('; ')
    say(clip(`Villagers: ${s.known} known, ${s.jobs} with a job. Emeralds on me: ${emeralds()}, spent ${s.spent}, earned ${s.earned}. ${deals ? 'Good deals I know: ' + deals + '. ' : ''}Hall: ${plan.layoutApproved ? 'plan approved' : plan.designApproved ? 'design approved, layout not drawn yet' : 'new hall planned, waiting for your OK'}.`))
  }
  function tradeFor(user, query) {
    if (!trades.resolveWant(query, config, bot.registry)) { say(clip(`I do not know what "${query.trim()}" is. Try a book like mending, or an item like diamond pickaxe.`)); return }
    job('trade', async (ctx) => {
      const r = await trader.buy(ctx, query)
      if (r.ok) { const v = r.from || {}; say(clip(`Bought ${r.bought.what} for ${r.bought.price}${v.profession ? ' from the ' + v.profession : ''}.`)) }
      else say(clip(r.why || 'I could not buy that.'))
      return { status: 'done' }
    })
  }
  function sell() {
    job('sell', async (ctx) => {
      const r = await trader.sellCrops(ctx)
      if (r.nothing) say(r.why || 'I have no spare crops to sell, or no farmer to sell to yet.')
      else say(clip(`Sold ${Object.entries(r.sold).map(([n, c]) => `${c} ${n}`).join(', ')} for ${r.earned} emeralds.`))
      return { status: 'done' }
    })
  }
  const commands = [
    { name: 'find-villagers', help: 'find villagers', risk: 'low', match: P.FIND, run: find },
    { name: 'villager-status', help: 'villager status', risk: 'low', match: P.STATUS, run: status },
    { name: 'trade-for', help: 'trade for mending', risk: 'high', match: P.TRADE, run(user, text, t) { const m = P.TRADE.exec(t || norm(text)); tradeFor(user, m[1] || m[2]) } },
    { name: 'sell-crops', help: 'sell crops', risk: 'high', match: P.SELL, run: sell },
    { name: 'villager-plan', help: 'villager plan', risk: 'low', match: P.PLAN,
      run() { say(clip(`New villager hall: ${state.plan.layoutApproved ? 'plan approved.' : state.plan.designApproved ? 'design OK\'d, I still need to draw the layout on the ground.' : 'design is written (brain/villagers/DESIGN.md), nothing is built. Say "approve villager plan" to let me draw the layout.'}`)) } },
    { name: 'villager-plan-approve', help: 'approve villager plan', risk: 'high', match: P.APPROVE,
      run(user) {
        if (user && api.ownerName && user !== api.ownerName) { say(`Only ${api.ownerName} can approve the villager plan.`); return }
        state.plan.designApproved = true; state.plan.designApprovedAt = api.now(); save()
        say('Design approved. Next I draw the exact layout on a real spot and show it to you; I place nothing until you OK that too.')
      } },
    { name: 'villager-upkeep-on', help: 'villager upkeep on', risk: 'high', match: P.UPKEEP_ON, run() { state.upkeep.enabled = true; save(); scheduler.setEnabled && scheduler.setEnabled('villager-upkeep', true); say('Villager upkeep on: when I am idle I look at nearby villagers and keep their offers up to date. I buy nothing by myself.') } },
    { name: 'villager-upkeep-off', help: 'villager upkeep off', risk: 'low', match: P.UPKEEP_OFF, run() { state.upkeep.enabled = false; save(); scheduler.setEnabled && scheduler.setEnabled('villager-upkeep', false); scheduler.cancel && scheduler.cancel('villagers'); say('Villager upkeep off.') } }
  ]
  for (const c of commands) { try { api.commands.add(c) } catch (e) { log(`command ${c.name} not added: ${e.message}`) } }

  // Runs before the legacy handler so "find villagers" etc. never fall through to a generic ack.
  function onChat(user, text) {
    const t = norm(text)
    if (NEG.test(t)) return false
    for (const c of commands) {
      let hit = false
      try { hit = c.match.test(t) } catch {}
      if (!hit) continue
      try { c.run(user, text, t) } catch (e) { log(`command ${c.name}: ${e.message}`); say(clip(`That failed: ${e.message}`, 150)) }
      return true
    }
    return false
  }

  // ---------- idle upkeep (off until Walter says "villager upkeep on") ----------
  scheduler.routine({
    name: 'villager-upkeep', priority: 35, idleOnly: true, intervalMs: config.upkeep.intervalMs, defaultEnabled: false, enabledFn: () => !!state.upkeep.enabled,
    due: () => state.upkeep.enabled && api.now() - (state.upkeep.lastRun || 0) > config.upkeep.intervalMs,
    make: () => ({
      name: 'villager-upkeep', key: 'villagers', abort: () => trader.abort(),
      async run(ctx) {
        state.upkeep.lastRun = api.now()
        try {
          const r = await trader.refreshOffers(ctx)
          state.upkeep.lastResult = `refreshed ${r.refreshed}`
          if (config.upkeep.autoBuy) { /* reserved: phase 3, only after Walter allows autonomous spending */ }
        } finally { save() }
        return { status: 'done' }
      }
    })
  })

  return {
    name: 'villagers', provides: ['villagers'],
    stop() { trader.abort() },
    status: () => ({ ...trader.snapshot(), emeralds: emeralds(), plan: state.plan, upkeep: state.upkeep.enabled }),
    onChat, trader, state
  }
}
register.meta = { name: 'villagers', version: 1 }

module.exports = register
module.exports.meta = register.meta
module.exports.phrases = P
