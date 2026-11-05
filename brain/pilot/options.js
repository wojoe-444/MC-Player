// brain/pilot/options: what the director may do with free time. An option is plain data plus two functions:
//   { id, desc, canonical?, run?(ctx), eligible(ctx) -> true | false | string(reason not),
//     instant?: do it the moment it is eligible (no model needed), auto?: may run in live mode without Walter's go,
//     cooldownMs, weight, announce?: [short lines], risk: 'low'|'high' }
// Eligibility is ALWAYS decided here in code; a model only ever picks among options that are already eligible, and an option
// only runs through a command that Walter's rules already govern (api.commands.dispatch) or a tiny vetted function (wear armor).
// Other modules can add their own with api.pilot.addOption(...).
const gear = (() => { try { return require('../safety/gear') } catch { return null } })()

const SLOTS = { head: 5, torso: 6, legs: 7, feet: 8 }
const wornArmor = (bot) => { const w = {}; try { for (const [k, i] of Object.entries(SLOTS)) w[k] = bot.inventory.slots[i] || null } catch { /* mock bots */ } return w }
const itemsOf = (bot) => { try { return bot.inventory.items() } catch { return [] } }
const has = (bot, re) => itemsOf(bot).some(i => re.test(i.name))
const freeSlots = (bot) => { try { return bot.inventory.emptySlotCount() } catch { return 36 } }
const foodCount = (bot) => itemsOf(bot).filter(i => /^(?:bread|cooked_|baked_potato|apple|golden_carrot|carrot|beetroot|melon_slice|pumpkin_pie|cookie)/.test(i.name)).reduce((a, i) => a + i.count, 0)

function builtin(cfg = {}) {
  const opts = []

  // Walter: "looks like you haven't put on the armor you've made yet". Pure inventory work, no walking, no digging, no placing.
  opts.push({
    id: 'wear-armor', desc: 'put on armor pieces from the bag that are better than what is worn', instant: true, auto: true, risk: 'low', cooldownMs: 120000,
    eligible: (c) => false && !!gear && !c.bot.isSleeping && gear.armorUpgrades(itemsOf(c.bot), wornArmor(c.bot)).length > 0,
    async run(c) {
      const ups = gear.armorUpgrades(itemsOf(c.bot), wornArmor(c.bot))
      let n = 0
      for (const u of ups) { try { await c.bot.equip(u.item, u.slot); n++ } catch { /* try the rest */ } }
      return { ok: n > 0, note: `put on ${n} armor piece(s)` }
    }
  })

  // keep crops from piling up in the bag: the farm routine stores after a harvest; this catches leftovers when the routine is off
  opts.push({
    id: 'store-crops', desc: 'put harvested crops into the house chest', canonical: 'store crops', auto: true, risk: 'low', cooldownMs: 30 * 60000, weight: 1,
    announce: ['Putting the crops away.'],
    eligible: (c) => (freeSlots(c.bot) <= 6 && has(c.bot, /^(?:wheat|carrot|potato|beetroot|melon_slice|pumpkin)$/)) || 'bag is not crowded with crops'
  })

  // Walter: "have you been putting the smeltable items in the auto-furnace when your inventory fills from mining?" / "do all smeltable items the same way as cobblestone".
  // The furnace module already knows what may go (brain/smeltables.js); this only notices the bag filling up while the bot is otherwise idle.
  opts.push({
    id: 'deposit-smeltables', desc: 'put ores, raw metals and other smeltables from the bag into the furnace input chests', canonical: 'furnace deposit', auto: true, risk: 'low', cooldownMs: 15 * 60000, weight: 1.5,
    eligible: (c) => {
      if (typeof c.api.smeltablesPlan !== 'function') return 'furnace module not available'
      let plan; try { plan = c.api.smeltablesPlan() } catch { return 'plan failed' }
      const n = (plan || []).reduce((a, i) => a + i.count, 0)
      if (!n) return 'nothing smeltable to deposit'
      return freeSlots(c.bot) <= 8 || n >= 128 || 'bag is not crowded'
    }
  })

  // The bigger jobs. They dig or cut, so each is `auto` only when its id is listed in config director.autoHigh (Walter's prior go); otherwise the
  // director only PROPOSES it in the feed. The modules still apply their own rules (line of sight, protected ground, tool checks).
  const autoHigh = new Set((cfg && cfg.autoHigh) || [])
  const count = (c, re) => itemsOf(c.bot).filter(i => re.test(i.name)).reduce((a, i) => a + i.count, 0)
  const sturdy = (c) => (c.snap.health == null || c.snap.health >= 16) && c.snap.time !== 'night'
  opts.push({
    id: 'chop-wood', desc: 'chop trees for wood (the bag is low on logs)', canonical: 'chop trees', risk: 'high', auto: autoHigh.has('chop-wood'), cooldownMs: 40 * 60000, weight: 1,
    announce: ['Low on logs, so I am heading out to chop some trees.'],
    eligible: (c) => !has(c.bot, /_axe$/) ? 'no axe' : !sturdy(c) ? 'night or low health' : count(c, /_log$/) >= 16 ? 'plenty of logs' : freeSlots(c.bot) < 6 ? 'bag nearly full' : true
  })
  opts.push({
    id: 'mine-iron', desc: 'strip-mine 16 iron (the bag has little iron)', canonical: 'mine iron 16', risk: 'high', auto: autoHigh.has('mine-iron'), cooldownMs: 60 * 60000, weight: 1.2,
    announce: ['Free time and short on iron, so I am going to strip-mine some.'],
    eligible: (c) => !has(c.bot, /_pickaxe$/) ? 'no pickaxe' : !sturdy(c) ? 'night or low health' : count(c, /^(?:raw_)?iron(?:_ingot)?$/) >= 48 ? 'plenty of iron' : freeSlots(c.bot) < 10 ? 'bag nearly full' : true
  })

  // Not options on purpose: farming, furnace upkeep, sleep and the mining/tree/lighting routines schedule themselves; the bot's whimsy time is its own (CLAUDE.md).
  // Modules and the driver add more through api.pilot.addOption.
  return opts
}

module.exports = { builtin, wornArmor, foodCount, freeSlots }
