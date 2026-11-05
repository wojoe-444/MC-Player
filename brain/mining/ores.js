// Ore tables and the "mine <ore> <amount>" parser. Pure: no bot, no world.
const cfg = require('./config.json')

const TIER_OF = { wooden: 0, golden: 0, stone: 1, copper: 1, iron: 2, diamond: 3, netherite: 3 }
const pickTier = (name) => { const m = /^(\w+?)_pickaxe$/.exec(name || ''); return m ? (TIER_OF[m[1]] ?? 0) : -1 }
const TIER_NAME = ['wooden', 'stone', 'iron', 'diamond']
const craftFor = (tier) => (tier <= 1 ? 'stone_pickaxe' : 'iron_pickaxe')    // cheapest pickaxe that can harvest that tier

const blockToOre = new Map()
for (const [ore, o] of Object.entries(cfg.ores)) for (const b of o.blocks) blockToOre.set(b, ore)
const ORE_BLOCKS = new Set(blockToOre.keys())
const oreOfBlock = (name) => blockToOre.get(name) || null
const isOreBlock = (name) => /_ore$/.test(name || '')

// "iron" -> key in config.ores, or null
function resolveOre(word) {
  const w = String(word || '').toLowerCase().trim().replace(/\s+/g, ' ')
  if (cfg.ores[w]) return w
  if (cfg.aliases[w]) return cfg.aliases[w]
  const s = w.replace(/s$/, '').replace(/ ore$/, '')
  if (cfg.ores[s]) return s
  if (cfg.aliases[s]) return cfg.aliases[s]
  return null
}
function unsupportedOre(word) {
  const w = String(word || '').toLowerCase().trim()
  for (const [k, msg] of Object.entries(cfg.unsupported)) if (w.includes(k)) return msg
  return null
}

const NUMWORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, stack: 64, 'a stack': 64, 'a stack of': 64, 'two stacks': 128, 'two stacks of': 128 }
const LEAD = /^(?:(?:go|head|get started|get|start|begin)\s+)?(?:and\s+)?(?:mine|mining|strip ?mine|strip mining|dig for)\b\s*/
const FILLER = /^(?:(?:me|us|some|for|the|up|out|more|a few|a couple of|several|lots of|a bunch of|a lot of|loads of)\s+)+/

// -> null (not a mining line) | { error } | { ore, amount, explicit }
function parseMine(t) {
  const text = String(t || '').trim().replace(/[.!?]+$/, '')
  const lead = LEAD.exec(text)
  if (!lead) return null
  if (/\b(status|progress|how (far|is|many)|waypoints?)\b/.test(text)) return null
  let rest = text.slice(lead[0].length).trim()
  const stripped = rest.replace(FILLER, '')
  if (!stripped && !/^(go|head|get|start|begin|strip)/.test(lead[0])) return null     // a bare "mine" is not a command
  if (!stripped) return { error: 'Mine what? Try "mine diamonds 5", "mine iron 32" or "mine coal 64".' }
  rest = stripped
  let amount = null, what = rest
  let mm = /^(\d{1,4})\s*x?\s+(?:of\s+)?(.+)$/.exec(rest)
  if (mm) { amount = +mm[1]; what = mm[2] }
  else if ((mm = /^(.+?)\s+(?:x\s*)?(\d{1,4})$/.exec(rest))) { amount = +mm[2]; what = mm[1] }
  else if ((mm = /^(a stack of|two stacks of|a stack|two stacks|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|a|an)\s+(?:of\s+)?(.+)$/.exec(rest)) && NUMWORDS[mm[1]]) { amount = NUMWORDS[mm[1]]; what = mm[2] }
  what = what.replace(/^(?:of|some|more)\s+/, '').replace(/\s+(?:for me|please|now|today)$/, '').trim()
  const bad = unsupportedOre(what)
  if (bad) return { error: bad }
  const ore = resolveOre(what)
  if (!ore) return null              // "mine craft", "mine is bigger": not ours
  const def = cfg.ores[ore]
  return { ore, amount: amount ? Math.min(amount, 2304) : def.default, explicit: !!amount }
}

module.exports = { cfg, oreOfBlock, isOreBlock, ORE_BLOCKS, resolveOre, parseMine, pickTier, TIER_NAME, craftFor, TIER_OF }
