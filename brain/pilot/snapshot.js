// brain/pilot/snapshot: a small, factual JSON picture of the bot for the fast models (no coordinates, nothing secret).
// Every field is optional and read defensively: a missing piece just drops out of the prompt.
const ARMOR_SLOTS = [5, 6, 7, 8]
const FOOD = /^(?:bread|cooked_[a-z_]+|apple|golden_apple|baked_potato|carrot|golden_carrot|beetroot|melon_slice|sweet_berries|pumpkin_pie|cookie|mushroom_stew|rabbit_stew|beetroot_soup|dried_kelp|potato)$/

function itemsOf(bot) { try { return bot.inventory.items() || [] } catch { return [] } }

function carrying(bot) {
  const items = itemsOf(bot)
  const count = (re) => items.filter(i => re.test(i.name)).reduce((a, i) => a + i.count, 0)
  const best = (kind) => {
    for (const t of ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']) if (items.some(i => i.name === `${t}_${kind}`)) return t.replace('wooden', 'wood').replace('golden', 'gold')
    return null
  }
  let worn = 0
  try { worn = ARMOR_SLOTS.filter(s => bot.inventory.slots[s]).length } catch { /* mock bots have no slots */ }
  const bag = items.filter(i => /_(helmet|chestplate|leggings|boots)$/.test(i.name)).length
  const out = { food: count(FOOD), pickaxe: best('pickaxe'), sword: best('sword'), armor_worn: worn, armor_in_bag: bag, free_slots: (() => { try { return bot.inventory.emptySlotCount() } catch { return null } })() }
  if (items.some(i => i.name === 'bow')) out.bow = true
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k]
  return out
}

function timeWord(bot) {
  const t = bot.time && bot.time.timeOfDay
  if (t == null) return undefined
  return t >= 12542 && t < 23460 ? 'night' : t < 12000 ? 'day' : 'dusk'
}

// api: the brain api (bot, scheduler, ownerName, now). extra: { recentEvents, lastBotLines }
function snapshot(api, extra = {}) {
  const bot = api.bot
  const s = {}
  try {
    const st = api.scheduler && api.scheduler.status && api.scheduler.status()
    if (st) {
      if (st.running) s.doing = `${st.running.name}${st.running.progress ? ' (' + st.running.progress + ')' : ''}`          // absent = nothing running
      if (st.queue && st.queue.length) s.queue = st.queue.slice(0, 4).map(t => t.name)
      if (st.parked && st.parked.length) s.paused_until_walter_says_go = st.parked.slice(0, 4).map(t => t.name)
      if (st.routines) s.routines = Object.fromEntries(st.routines.map(r => [r.name, r.enabled ? 'on' : 'off']))
      s.walter_quiet_s = st.quietForS
    }
  } catch { /* scheduler absent */ }
  try {
    if (bot.health != null) s.health = Math.round(bot.health)
    if (bot.food != null) s.food = Math.round(bot.food)
    if (bot.isSleeping) s.in_bed = true
    s.time = timeWord(bot)
    if (bot.game && bot.game.dimension) s.dimension = String(bot.game.dimension).replace('minecraft:', '')
    if (bot.heldItem) s.holding = bot.heldItem.name
    const w = bot.players && bot.players[api.ownerName || 'OGWO']
    const me = bot.entity && bot.entity.position
    if (w && w.entity && me) s.walter_distance = Math.round(w.entity.position.distanceTo(me))
    else s.walter_distance = 'not in range'
  } catch { /* partial state is fine */ }
  try { s.carrying = carrying(bot) } catch { /* no inventory */ }
  if (extra.recentEvents && extra.recentEvents.length) s.recent_events = extra.recentEvents.slice(-4)
  if (extra.lastDeath) s.last_death = extra.lastDeath
  if (extra.directives && extra.directives.length) s.directives = extra.directives
  if (extra.recentRouter && extra.recentRouter.length) s.recent_router_decisions = extra.recentRouter.slice(-5)
  for (const k of Object.keys(s)) if (s[k] === undefined) delete s[k]
  return s
}

module.exports = { snapshot, carrying, timeWord, FOOD }
