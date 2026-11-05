// What may go into the auto-furnace input chests (Walter: all smeltable mining output when the inventory fills).
// Pure rules, shared by furnace.js (api.depositSmeltables) and anything that wants to know what would be deposited.
//   deposit: raw metals, ancient debris, ores, sand, clay, netherrack, stone types, kelp, cactus, wet sponge, raw food above the food the bot
//            keeps, logs above what tools need.  Keep: coal/charcoal (fuel, torches), cooked food up to the stack, tools, buckets.
const DEFAULTS = { reserveCobble: 48, keepFood: 64, keepLogs: 32, keepSeeds: 16 }

const ALWAYS = new Set(['raw_iron', 'raw_gold', 'raw_copper', 'ancient_debris', 'sand', 'red_sand', 'clay_ball', 'clay', 'cobbled_deepslate', 'netherrack',
  'quartz_ore', 'nether_quartz_ore', 'kelp', 'cactus', 'wet_sponge', 'stone'])
const ORE = /(^|_)ore$/                                  // iron_ore, deepslate_gold_ore, nether_gold_ore ...
const RAW_FOOD = new Set(['porkchop', 'beef', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon', 'potato'])
const COOKED_FOOD = ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_salmon', 'cooked_cod', 'cooked_rabbit', 'baked_potato', 'bread', 'golden_carrot', 'carrot', 'apple', 'melon_slice', 'beetroot', 'sweet_berries']
const NEVER = new Set(['coal', 'charcoal', 'lava_bucket', 'bucket', 'water_bucket'])

// inventory: [{name,count}] -> [{name, count}] to deposit (counts already net of the reserves).
function plan(inventory, opts = {}) {
  const K = { ...DEFAULTS, ...opts }
  const total = {}
  for (const it of inventory) total[it.name] = (total[it.name] || 0) + it.count
  // Reserved items (the driver's builds): amounts listed in brain/state/reserved.json (or opts.reserved, used by tests) are never treated as spare,
  // e.g. { "stone": 150, "spruce_log": 40 } while the tower is being built.
  let reserved = opts.reserved
  if (!reserved) { try { reserved = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'state', 'reserved.json'), 'utf8').replace(/^﻿/, '')) } catch { reserved = {} } }
  for (const [n, k] of Object.entries(reserved)) if (typeof k === 'number' && total[n]) total[n] = Math.max(0, total[n] - k)
  const cookedFood = COOKED_FOOD.reduce((s, n) => s + (total[n] || 0), 0)
  let foodRoom = Math.max(0, K.keepFood - cookedFood)      // raw food may fill whatever is left of the food stack we keep
  let logsKept = 0
  const out = []
  for (const [name, count] of Object.entries(total)) {
    if (NEVER.has(name)) continue
    let n = 0
    if (name === 'cobblestone') n = Math.max(0, count - K.reserveCobble)
    else if (ALWAYS.has(name) || ORE.test(name)) n = count
    else if (RAW_FOOD.has(name)) {
      // potatoes double as seed for replanting (routines keeps 16), so those stay even when the food stack is full
      const keep = Math.min(count, Math.max(foodRoom, name === 'potato' ? K.keepSeeds : 0)); foodRoom -= Math.min(foodRoom, keep); n = count - keep
    }
    else if (/_log$/.test(name)) { const keep = Math.min(count, Math.max(0, K.keepLogs - logsKept)); logsKept += keep; n = count - keep }
    if (n > 0) out.push({ name, count: n })
  }
  return out
}

// Does a furnace smelt/cook/burn this into something? (used to leave unknown items in a furnace slot alone)
const isSmeltable = (name) => ALWAYS.has(name) || ORE.test(name) || RAW_FOOD.has(name) || name === 'cobblestone' || /_log$|^raw_|_terracotta$|^sandstone|^red_sandstone|^stone_bricks|chorus_fruit|sea_pickle|^glass/.test(name)

module.exports = { plan, isSmeltable, DEFAULTS, ALWAYS, RAW_FOOD, COOKED_FOOD }
