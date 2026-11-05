// Pickaxe handling: which tool may break which block, equipping it, and what to ask the crafting module for when the tools run low.
const { pickTier, craftFor, TIER_NAME, cfg } = require('./ores')

const SHOVEL = /^(dirt|grass_block|coarse_dirt|podzol|rooted_dirt|mud|clay|gravel|sand|red_sand|snow_block)$/

module.exports = function makeTools({ bot, limits, log = () => {} }) {
  const reg = bot.registry
  const durLeft = (it) => { const max = reg.items[it.type] && reg.items[it.type].maxDurability; return max ? max - (it.durabilityUsed || 0) : 999 }
  const pickaxes = () => bot.inventory.items().filter(i => /_pickaxe$/.test(i.name) && durLeft(i) >= 3).map(i => ({ it: i, tier: pickTier(i.name), left: durLeft(i) }))
  const shovels = () => bot.inventory.items().filter(i => /_shovel$/.test(i.name) && durLeft(i) >= 3)
  const totalUses = () => pickaxes().reduce((s, p) => s + p.left, 0)

  // minimum pickaxe tier for a block (ores in config; everything else any pickaxe)
  function needTier(b) {
    for (const o of Object.values(cfg.ores)) if (o.blocks.includes(b.name)) return o.tier
    return 0
  }
  const canHarvest = (b) => pickaxes().some(p => p.tier >= needTier(b))
  const isOre = (b) => /_ore$/.test(b.name)

  // The tool to break `b` with. Ores: the fastest pickaxe that can harvest them. Filler: a shovel for dirt and sand, else the cheapest
  // pickaxe with durability left, so the good one lasts for the ore.
  function choose(b) {
    if (SHOVEL.test(b.name)) { const s = shovels()[0]; if (s) return s }
    const ps = pickaxes()
    if (isOre(b)) {
      const ok = ps.filter(p => p.tier >= needTier(b))
      if (!ok.length) return null
      let best = null, bt = Infinity
      for (const p of ok) { let t = 0; try { t = b.digTime(p.it.type, false, false, false, [], {}) } catch { t = 10 - p.tier } if (t < bt) { bt = t; best = p } }
      return best.it
    }
    if (!ps.length) return null
    const keep = limits.minOreUses || 25
    const cheap = ps.slice().sort((a, c) => a.tier - c.tier || c.left - a.left).find(p => p.left > keep) || ps.slice().sort((a, c) => c.left - a.left)[0]
    return cheap.it
  }

  async function equipFor(b) {
    const it = choose(b)
    if (!it) return false
    if (!bot.heldItem || bot.heldItem.type !== it.type || bot.heldItem.name !== it.name) await bot.equip(it, 'hand')
    return true
  }

  // What is missing for mining `ore`? null = fine, else { item, why }.
  function shortage(oreDef) {
    const ps = pickaxes()
    const capable = ps.filter(p => p.tier >= oreDef.tier && p.left >= (limits.minOreUses || 25))
    if (!capable.length) {
      const item = craftFor(oreDef.tier)
      const have = ps.find(p => p.tier >= oreDef.tier)
      return { item, why: have ? `my ${TIER_NAME[have.tier]} pickaxe is nearly worn out` : `I need a ${TIER_NAME[Math.min(oreDef.tier, 3)]} pickaxe or better` }
    }
    if (totalUses() < (limits.minPickUses || 120)) return { item: 'stone_pickaxe', why: 'my pickaxes are nearly worn out' }
    return null
  }

  return { pickaxes, shovels, totalUses, needTier, canHarvest, choose, equipFor, shortage, durLeft }
}
