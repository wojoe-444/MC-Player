// The one place that decides WHICH TOOL breaks a block (docs/BUG-HUNT-2026-11-10.md finding 8; Walter 2026-11-10: "use the minimum tool tier that gets the job done,
// stone is the default, higher tiers only when a block requires them"). Nine call sites used to pick the fastest tool, which is the highest tier in the bag.
//
//   minimumTool(block, items, { allowSword, durLeft, fallback }) -> the item, or null (no tool helps: use the hand)
//
// Of the tools that can harvest the block and either beat the bare hand or are required to drop it, the lowest tier wins (stone, iron, diamond, netherite; gold and wood
// last, because wood breaks and gold is for nothing but speed), then the faster one. A tool with fewer than 3 uses left is not offered. Swords only when the caller asks
// (bamboo and sugar cane). Pure: no bot, no equip.
'use strict'

const KIND = /_(pickaxe|axe|shovel|hoe)$/
const SWORD = /_sword$/

const rankOf = (name) => /^stone_/.test(name) ? 1 : /^iron_/.test(name) ? 2 : /^diamond_/.test(name) ? 3 : /^netherite_/.test(name) ? 4 : /^golden_/.test(name) ? 5 : /^wooden_/.test(name) ? 6 : 9

function minimumTool(block, items, { allowSword = false, durLeft = () => 999, fallback = false } = {}) {
  if (!block) return null
  let hand = Infinity
  try { hand = block.digTime(null, false, false, false, [], []) } catch { /* unknown */ }
  const cands = []
  for (const it of items || []) {
    if (!(KIND.test(it.name) || (allowSword && SWORD.test(it.name)))) continue
    if (durLeft(it) < 3) continue
    const needed = !!(block.harvestTools && block.harvestTools[it.type])
    if (block.harvestTools && !needed) continue                       // a block with a harvest list drops nothing for a tool that is not on it
    let t = Infinity
    try { t = block.digTime(it.type, false, false, false, [], []) } catch { /* unknown */ }
    if (t < hand || needed) cands.push({ it, t, r: rankOf(it.name) })
  }
  cands.sort((a, b) => a.r - b.r || a.t - b.t)
  if (cands.length) return cands[0].it
  // `fallback`: for callers that need SOME tool in hand ("I have a pickaxe" is their precondition) when the block needs none (dirt with only a pickaxe in the bag): the lowest tier, never the best
  if (fallback && !block.harvestTools) {
    const any = (items || []).filter(it => (KIND.test(it.name) || (allowSword && SWORD.test(it.name))) && durLeft(it) >= 3).sort((a, b) => rankOf(a.name) - rankOf(b.name))
    return any[0] || null
  }
  return null
}

module.exports = { minimumTool, rankOf }
