// Loadout before a trip (Walter: "packing torches before you go somewhere ... these are things you should be getting better at"). Pure checks plus a fixer that
// uses the crafting module for what can be crafted. Never takes anything from chests itself: crafting does that for recipe ingredients only.
//
//   const lo = makeLoadout({ bot, commands, canCraft, log, tuning: () => ({ req }) })
//   lo.summary()                     { sword, pickaxe, torches, filler, food, armor, bow, arrows }
//   lo.check('cave')                 { ok, kind, missing:[{what, need, have, fix?}], have }
//   await lo.ensure('cave', {})      equips armor, asks crafting for torches / a sword / a pickaxe, waits, returns { ok, missing, fixed }
const gear = require('./gear')
const bowMod = require('./bow')
const { FOOD_NEVER, FOOD_SPARE } = require('./profiles')
const { FILLER } = require('./entomb')

// what each kind of trip needs (counts): armor = pieces worn or ready to wear
const KINDS = {
  trip: { sword: 1, food: 8, torches: 8, armor: 0 },
  cave: { sword: 1, pickaxe: 1, food: 12, torches: 16, filler: 64, armor: 0 },   // armor not required (Walter 17:50: not wanted for now)
  explore: { sword: 1, food: 12, torches: 16, filler: 64, armor: 0 }
}
const FIX_CMD = { torches: (n) => `craft ${n} torch`, sword: () => 'craft stone_sword', pickaxe: () => 'craft stone_pickaxe' }

function summarize(items, worn, foods = {}) {
  const count = (re) => items.filter(i => re.test(i.name)).reduce((s, i) => s + i.count, 0)
  const food = items.filter(i => foods[i.name] && !FOOD_NEVER.has(i.name) && !FOOD_SPARE.has(i.name) || (foods[i.name] && FOOD_SPARE.has(i.name))).reduce((s, i) => s + i.count, 0)
  const ups = gear.armorUpgrades(items, worn || {})
  const wornCount = Object.values(worn || {}).filter(Boolean).length
  const slots = new Set(Object.entries(worn || {}).filter(([, v]) => v).map(([k]) => k)); for (const u of ups) slots.add(u.slot)
  return {
    sword: items.some(i => /_sword$/.test(i.name)) ? 1 : 0, pickaxe: items.some(i => /_pickaxe$/.test(i.name)) ? 1 : 0,
    torches: count(/^torch$/), filler: items.filter(i => FILLER.includes(i.name)).reduce((s, i) => s + i.count, 0), food,
    armor: Math.max(wornCount, slots.size), armorWorn: wornCount, bow: items.some(i => i.name === 'bow') ? 1 : 0, arrows: bowMod.arrowCount(items)
  }
}

// need = KINDS[kind] raised by what past deaths taught (req from the tuning file)
function check(have, kind = 'cave', req = {}) {
  const base = KINDS[kind] || KINDS.cave
  const need = { ...base }
  if (kind !== 'trip') for (const [k, v] of Object.entries(req || {})) if (typeof v === 'number') need[k] = Math.max(need[k] || 0, v)
  const missing = []
  for (const [what, n] of Object.entries(need)) {
    if (!n) continue
    if ((have[what] || 0) < n) missing.push({ what, need: n, have: have[what] || 0, fix: FIX_CMD[what] ? FIX_CMD[what](Math.max(1, n - (have[what] || 0))) : null })
  }
  return { ok: missing.length === 0, kind, missing, have, need }
}

const phrase = (m) => `${m.what} ${m.have}/${m.need}`

function makeLoadout({ bot, commands = null, owner = 'OGWO', log = () => {}, tuning = () => ({ req: {} }), sleep = (ms) => new Promise(r => setTimeout(r, ms)), waitMs = 60000 }) {
  const worn = () => {
    const w = {}
    if (typeof bot.getEquipmentDestSlot === 'function' && bot.inventory && bot.inventory.slots) for (const s of ['head', 'torso', 'legs', 'feet']) w[s] = bot.inventory.slots[bot.getEquipmentDestSlot(s)] || null
    return w
  }
  const summary = () => summarize(bot.inventory.items(), worn(), (bot.registry && bot.registry.foodsByName) || {})
  const checkNow = (kind) => check(summary(), kind, (tuning() || {}).req)

  async function equipArmor() {
    try {
      for (const { item, slot } of gear.armorUpgrades(bot.inventory.items(), worn())) await bot.equip(item, slot)
    } catch (e) { log('loadout armor: ' + e.message) }
  }

  // Equip armor, then try the crafting module for torches / sword / pickaxe. Returns what is still missing (cobblestone, food and armor have to be mined,
  // farmed or found: this never raids chests on its own).
  async function ensure(kind = 'cave', { ctx = null } = {}) {
    await equipArmor()
    let c = checkNow(kind)
    const fixed = []
    if (!c.ok && commands && typeof commands.dispatch === 'function') {
      for (const m of c.missing) {
        if (!m.fix) continue
        const before = summary()[m.what] || 0
        let handled = false
        try { handled = !!commands.dispatch(owner, m.fix) } catch (e) { log(`loadout fix '${m.fix}': ${e.message}`) }
        if (!handled) continue
        const t0 = Date.now()
        while (Date.now() - t0 < waitMs) {                         // crafting runs as a scheduler task: wait for the bag to change
          if (ctx) ctx.checkpoint()
          await sleep(1000)
          if ((summary()[m.what] || 0) > before) { fixed.push(m.what); break }
          if (Date.now() - t0 > 4000 && !(commands.busy && commands.busy())) { /* nothing running any more */ }
        }
      }
      await equipArmor()
      c = checkNow(kind)
    }
    return { ok: c.ok, kind, missing: c.missing, fixed, have: c.have }
  }

  const describe = (c) => c.ok ? `Loadout for ${c.kind} is complete.` : `For ${c.kind} I still need: ${c.missing.map(phrase).join(', ')}.`
  return { summary, check: checkNow, ensure, describe, equipArmor, KINDS }
}

module.exports = { makeLoadout, summarize, check, KINDS }
