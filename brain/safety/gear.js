// Weapon and armor choice from what is already in the inventory. Pure functions. The bot never takes gear from chests on its own
// (Walter decides that); this only uses what it carries.
const SWORDS = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword']
const AXES = ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe']

// Best melee weapon: any sword beats any axe at the same tier ordering (axes only when there is no sword).
function bestWeapon(items) {
  for (const n of SWORDS) { const it = items.find(i => i.name === n); if (it) return it }
  for (const n of AXES) { const it = items.find(i => i.name === n); if (it) return it }
  return null
}
// Time between full-strength hits (1.9+ attack cooldown). Swords: 1.6/s. Axes: 0.8-1.0/s.
function cooldownMs(item) {
  if (!item) return 500
  if (/_sword$/.test(item.name)) return 650
  if (/^(wooden|stone|iron)_axe$/.test(item.name)) return 1300
  if (/_axe$/.test(item.name)) return 1050
  return 500
}

const TIER = { netherite: 6, diamond: 5, iron: 4, chainmail: 3, golden: 2, leather: 1 }
const SLOT_OF = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' }
function armorInfo(name) {
  const m = /^(netherite|diamond|iron|chainmail|golden|leather)_(helmet|chestplate|leggings|boots)$/.exec(name)
  return m ? { tier: TIER[m[1]], slot: SLOT_OF[m[2]] } : null
}
// worn: { head, torso, legs, feet } -> item|null. Returns [{ item, slot }] upgrades to put on.
function armorUpgrades(items, worn = {}) {
  const best = {}
  for (const it of items) {
    const a = armorInfo(it.name); if (!a) continue
    if (!best[a.slot] || a.tier > best[a.slot].tier) best[a.slot] = { tier: a.tier, item: it }
  }
  const out = []
  for (const [slot, b] of Object.entries(best)) {
    const cur = worn[slot] ? armorInfo(worn[slot].name) : null
    if (!cur || b.tier > cur.tier) { if (!worn[slot] || worn[slot] !== b.item) out.push({ item: b.item, slot }) }
  }
  return out
}

module.exports = { SWORDS, AXES, bestWeapon, cooldownMs, armorInfo, armorUpgrades }
