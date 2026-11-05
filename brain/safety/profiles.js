// Static knowledge about mobs and food. Pure data, no bot access.
//  kind: melee    walks up and hits       -> fightable
//        ranged   shoots from a distance  -> fightable, but noticed from further away
//        explosive                        -> never meleed unless cornered
//        flee     too strong / unreachable -> always walk away
//        neutral  ignored until it hurts us
const P = (kind, danger = 2, extra = {}) => ({ kind, danger, ...extra })
const PROFILES = {
  zombie: P('melee', 2), husk: P('melee', 2), drowned: P('melee', 2), zombie_villager: P('melee', 2),
  spider: P('melee', 2), cave_spider: P('melee', 2), silverfish: P('melee', 1), slime: P('melee', 1), magma_cube: P('melee', 2),
  vindicator: P('melee', 3), piglin_brute: P('melee', 3), phantom: P('melee', 2), spider_jockey: P('melee', 2),
  skeleton: P('ranged', 2), stray: P('ranged', 2), bogged: P('ranged', 2), pillager: P('ranged', 3), witch: P('ranged', 2),
  creeper: P('explosive', 4),
  warden: P('flee', 9, { range: 20 }), ravager: P('flee', 5), evoker: P('flee', 4), vex: P('flee', 3), ghast: P('flee', 5, { range: 24 }),
  blaze: P('flee', 4), wither_skeleton: P('flee', 4), guardian: P('flee', 3), elder_guardian: P('flee', 5), breeze: P('flee', 3), wither: P('flee', 9, { range: 24 }),
  enderman: P('neutral', 3), zombified_piglin: P('neutral', 2), piglin: P('neutral', 1), wolf: P('neutral', 1), bee: P('neutral', 1),
  iron_golem: P('neutral', 1), polar_bear: P('neutral', 2), llama: P('neutral', 0)
}
const SWORDS = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword']

// Never eaten by the safety module (bad effects, or too precious to burn in an emergency).
const FOOD_NEVER = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken', 'suspicious_stew', 'enchanted_golden_apple', 'chorus_fruit', 'honey_bottle', 'ominous_bottle'])
// Only in an emergency (health very low).
const FOOD_EMERGENCY = new Set(['golden_apple', 'golden_carrot'])
// Farm stock / replanting material: eaten last.
const FOOD_SPARE = new Set(['carrot', 'potato', 'beetroot', 'sweet_berries', 'glow_berries', 'wheat', 'melon_slice'])

module.exports = { P, PROFILES, SWORDS, FOOD_NEVER, FOOD_EMERGENCY, FOOD_SPARE }

// Mobs that fly or hover: a walking path says nothing about whether they can reach us.
const FLYING = new Set(['phantom', 'vex', 'ghast', 'blaze', 'bee', 'allay'])
// Climbs walls: path distance under-estimates how close it can get.
const CLIMBERS = new Set(['spider', 'cave_spider'])
module.exports.FLYING = FLYING
module.exports.CLIMBERS = CLIMBERS
