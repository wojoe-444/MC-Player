// Pure crop knowledge for the farm routine (no bot access): what is ripe, what to keep, what to store.
const CROPS = {
  wheat: { maxAge: 7, seed: 'wheat_seeds' },
  carrots: { maxAge: 7, seed: 'carrot' },
  potatoes: { maxAge: 7, seed: 'potato' },
  beetroots: { maxAge: 3, seed: 'beetroot_seeds' }
}
const SEED_TO_CROP = Object.fromEntries(Object.entries(CROPS).map(([crop, c]) => [c.seed, crop]))
const SEED_ITEMS = Object.keys(SEED_TO_CROP)
// what the bot eats, best first (potato is left out on purpose: raw potatoes are poor food and can poison)
const FOOD_ORDER = ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_salmon', 'cooked_cod', 'baked_potato', 'bread', 'golden_carrot', 'carrot', 'apple', 'melon_slice', 'beetroot', 'sweet_berries']
// the only things the farm ever puts in the house chest
const CROP_ITEMS = new Set(['wheat', 'carrot', 'potato', 'beetroot', 'wheat_seeds', 'beetroot_seeds', 'poisonous_potato', 'baked_potato', 'bread', 'sugar_cane', 'bamboo'])

const isCrop = (b) => !!b && !!CROPS[b.name]
function ageOf(b) { try { const p = b.getProperties(); return p && p.age !== undefined ? Number(p.age) : null } catch { return null } }
// ripe = fully grown crop standing on farmland. Anything else is left alone.
function isRipe(block, floor) {
  if (!isCrop(block) || !floor || floor.name !== 'farmland') return false
  const age = ageOf(block)
  return age !== null && age >= CROPS[block.name].maxAge
}

// inv: { itemName: count }. Keeps 16 of every seed item and a stack (64) of food overall; the rest of the crop items go to the chest.
// Food that is not a crop item (cooked meat, apples, ...) is never stored but counts towards the stack.
function planStore(inv, { keepFood = 64, keepSeed = 16, keepBamboo = 4 } = {}) {
  const have = (n) => inv[n] || 0
  const keep = {}
  for (const s of SEED_ITEMS) keep[s] = Math.min(have(s), keepSeed)
  if (have('bamboo') > 0) keep.bamboo = Math.min(have('bamboo'), keepBamboo)          // planting stock for the bamboo patch
  let food = 0
  for (const n of FOOD_ORDER) food += CROP_ITEMS.has(n) ? Math.min(keep[n] || 0, have(n)) : have(n)
  for (const n of FOOD_ORDER) {
    if (!CROP_ITEMS.has(n)) continue
    const extra = have(n) - (keep[n] || 0)
    const take = Math.max(0, Math.min(extra, keepFood - food))
    if (take > 0) { keep[n] = (keep[n] || 0) + take; food += take }
  }
  const deposit = {}
  for (const n of CROP_ITEMS) { const d = have(n) - (keep[n] || 0); if (d > 0) deposit[n] = d }
  return { deposit, keep, food }
}

const foodTotal = (inv) => FOOD_ORDER.reduce((s, n) => s + (inv[n] || 0), 0)

module.exports = { CROPS, SEED_TO_CROP, SEED_ITEMS, FOOD_ORDER, CROP_ITEMS, isCrop, isRipe, planStore, foodTotal }
