// Herd bookkeeping and the breed/cull/shear policy (pure: entities in, decisions out). Winter food resilience (ROADMAP Phase 2 item 9, Serene Seasons winter):
// keep a breeding pair of every species, grow the herd to a larger winter target while animals still breed, and only cull the surplus, adults only, never a baby.
//
// Entity metadata keys in 1.21.6 (mineflayer: entity.metadata[key]): 16 = AgeableMob "is baby" (boolean), 17 = Sheep wool byte (low nibble colour, 0x10 = sheared).
// NOT YET VERIFIED LIVE: these indexes, and whether Serene Seasons blocks breeding in winter (the policy handles both outcomes: see `breedBlocked`).
const SPECIES = {
  cow:     { foods: ['wheat'], drops: ['beef', 'leather'] },
  sheep:   { foods: ['wheat'], drops: ['mutton', 'white_wool'], shears: true },
  pig:     { foods: ['carrot', 'potato', 'beetroot'], drops: ['porkchop'] },
  chicken: { foods: ['wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds', 'torchflower_seeds', 'pitcher_pod'], drops: ['chicken', 'feather'] }
}
const NAMES = Object.keys(SPECIES)
const BABY_KEY = 16, SHEEP_WOOL_KEY = 17, SHEARED_BIT = 0x10

const isAnimal = (e) => !!e && e.position && !!SPECIES[e.name]
const isBaby = (e) => !!(e && e.metadata && e.metadata[BABY_KEY] === true)
const isSheared = (e) => !!(e && e.name === 'sheep' && e.metadata && typeof e.metadata[SHEEP_WOOL_KEY] === 'number' && (e.metadata[SHEEP_WOOL_KEY] & SHEARED_BIT))

const inBox = (p, b) => p.x >= b.x0 && p.x < b.x1 + 1 && p.z >= b.z0 && p.z < b.z1 + 1 && p.y >= b.y0 - 1.1 && p.y < b.y1 + 2

// animals of each species inside a box, adults and babies apart
function census(entities, box) {
  const out = {}
  for (const n of NAMES) out[n] = { adults: [], babies: [] }
  for (const e of Object.values(entities || {})) {
    if (!isAnimal(e) || !inBox(e.position, box)) continue
    out[e.name][isBaby(e) ? 'babies' : 'adults'].push(e)
  }
  return out
}
const counts = (c) => { const o = {}; for (const n of NAMES) o[n] = { adults: c[n].adults.length, babies: c[n].babies.length }; return o }
const total = (c) => NAMES.reduce((s, n) => s + c[n].adults.length + c[n].babies.length, 0)

// the herd size aimed at for a species (winter: bigger, so the stock outlasts the cold)
const targetFor = (cfg, species, winter) => Math.max(cfg.minStock, Math.round(cfg.targets[species] * (winter ? cfg.winterFactor : 1)))

// What to do with the herd now.
//   census:  the result of census()
//   opts:    { cfg (config.herd), winter, capacity (animals the pen holds), foodLow, breedBlocked: { species: true }, species (only these) }
// Returns { breed: [{species, pairs}], cull: [{species, n}], shear: n, target: {species: n} }
function decide(census, { cfg, winter = false, capacity = 12, foodLow = false, breedBlocked = {}, species = NAMES } = {}) {
  const res = { breed: [], cull: [], shear: 0, target: {} }
  let pop = total(census)
  for (const n of species) {
    const c = census[n]; if (!c) continue
    const target = targetFor(cfg, n, winter)
    res.target[n] = target
    const adults = c.adults.length, young = c.babies.length
    // cull: adults above the target, or above half of it when food is low; never below the breeding pair, never babies
    const keep = Math.max(cfg.minStock, foodLow ? Math.ceil(target / 2) : target)
    const surplus = Math.max(0, adults - keep)
    if (surplus > 0) { res.cull.push({ species: n, n: surplus }); pop -= surplus }
    // breed: a pair, room in the pen, the herd below target
    const room = capacity - pop
    if (adults >= 2 && !breedBlocked[n] && adults + young < target && room > 0) {
      const pairs = Math.min(Math.floor(adults / 2), cfg.maxPairsPerRun, room, target - adults - young)
      if (pairs > 0) { res.breed.push({ species: n, pairs }); pop += pairs }     // one baby per pair
    }
  }
  // overcrowded (more animals than the pen holds, e.g. after a lure): thin the species with the most adults above the breeding pair, one at a time
  while (pop > capacity) {
    let best = null
    for (const n of species) {
      const c = census[n]; if (!c) continue
      const already = (res.cull.find(x => x.species === n) || { n: 0 }).n
      const spare = c.adults.length - already - cfg.minStock
      if (spare > 0 && (!best || spare > best.spare)) best = { n, spare }
    }
    if (!best) break
    const e = res.cull.find(x => x.species === best.n); if (e) e.n++; else res.cull.push({ species: best.n, n: 1 })
    pop--
  }
  if (census.sheep) res.shear = census.sheep.adults.filter(e => !isSheared(e)).length
  return res
}

// food item names a species accepts, best first, from an inventory list [{name,count}]
function foodFor(species, items) {
  const def = SPECIES[species]; if (!def) return null
  for (const f of def.foods) { const it = items.find(i => i.name === f && i.count > 0); if (it) return it }
  return null
}

// Some animals of a species cannot be fed twice in a row: remember when each was fed (entity id -> ms) and skip those within the cooldown.
function breedable(adults, fedAt, nowMs, cooldownMs) {
  return adults.filter(e => !(fedAt[e.id] && nowMs - fedAt[e.id] < cooldownMs))
}

// Pick the animals to cull: the ones that were fed longest ago (they are the least recent parents), sheep sheared first (their wool is already taken), never babies.
function pickVictims(adults, n, fedAt = {}) {
  return [...adults].sort((a, b) => (isSheared(b) ? 1 : 0) - (isSheared(a) ? 1 : 0) || (fedAt[a.id] || 0) - (fedAt[b.id] || 0)).slice(0, Math.max(0, n))
}

module.exports = { SPECIES, NAMES, isAnimal, isBaby, isSheared, inBox, census, counts, total, targetFor, decide, foodFor, breedable, pickVictims, BABY_KEY, SHEEP_WOOL_KEY, SHEARED_BIT }
