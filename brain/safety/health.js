// Health policy. Pure functions, no bot access.
const { FOOD_NEVER, FOOD_EMERGENCY, FOOD_SPARE } = require('./profiles')

const HEALTH_DEFAULTS = { lowHealth: 9.5, recoverHealth: 14, eatHealth: 16, eatSafeDist: 6, eatCloseDist: 4, idleEatFood: 14, idleEat: false }

// Latch with hysteresis: enters "recovering" below lowHealth, leaves at recoverHealth.
function nextRecovering(prev, health, cfg = {}) {
  const C = { ...HEALTH_DEFAULTS, ...cfg }
  if (health <= C.lowHealth) return true
  if (health >= C.recoverHealth) return false
  return !!prev
}

// Should the bot eat right now? nearestThreat = distance of the closest hostile that matters (Infinity when none).
// Returns { eat:boolean, emergency:boolean, why }.
function shouldEat({ health, food, nearestThreat = Infinity, recovering = false }, cfg = {}) {
  const C = { ...HEALTH_DEFAULTS, ...cfg }
  const no = { eat: false, emergency: false, why: '' }
  if (food === undefined || food >= 20) return no
  const emergency = health <= C.lowHealth
  if (nearestThreat <= C.eatCloseDist) return no                    // never stand and chew next to a mob
  if (emergency) return { eat: true, emergency: true, why: 'low health' }
  if (recovering && food < 18) return { eat: true, emergency: false, why: 'recovering (natural regen needs food >= 18)' }
  if (nearestThreat < Infinity) {
    if (health < C.eatHealth && food <= 17 && nearestThreat >= C.eatSafeDist) return { eat: true, emergency: false, why: 'hurt with mobs about' }
    return no
  }
  if (C.idleEat && (food <= C.idleEatFood)) return { eat: true, emergency: false, why: 'hungry' }
  return no
}

// Pick the food to eat. items = bot.inventory.items(); foods = registry.foodsByName.
function chooseFood(items, foods, { food = 0, emergency = false } = {}) {
  const deficit = 20 - food
  const cands = []
  for (const it of items) {
    const f = foods[it.name]
    if (!f || FOOD_NEVER.has(it.name)) continue
    if (FOOD_EMERGENCY.has(it.name) && !emergency) continue
    cands.push({ it, points: f.foodPoints, sat: f.saturation, spare: FOOD_SPARE.has(it.name) ? 1 : 0, golden: FOOD_EMERGENCY.has(it.name) ? 1 : 0 })
  }
  if (!cands.length) return null
  cands.sort((a, b) => a.golden - b.golden || a.spare - b.spare || b.sat - a.sat || b.points - a.points)
  // avoid wasting a big meal on a small deficit when something smaller still does the job
  const fitting = cands.filter(c => c.points <= deficit + 2 && !c.golden && !c.spare)
  return (fitting.length && !emergency ? fitting[0] : cands[0]).it
}

module.exports = { HEALTH_DEFAULTS, nextRecovering, shouldEat, chooseFood }
