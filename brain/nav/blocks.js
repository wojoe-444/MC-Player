// Block classification shared by the nav pieces (names only, so it works for any registry version).

// Things that open by hand. Iron doors/trapdoors need redstone, so they are walls for us.
const isHandOpenable = (name) => /_(door|trapdoor|fence_gate)$/.test(name) && !name.startsWith('iron_')
const isDoor = (name) => /_door$/.test(name) && !name.startsWith('iron_')
const isGate = (name) => /_fence_gate$/.test(name)
const isTrapdoor = (name) => /_trapdoor$/.test(name) && !name.startsWith('iron_')

// Never walked through or stood on (fire, lava, contact damage, teleports, wardens, trampling, tilting leaves).
const HARD_AVOID = [
  'lava', 'fire', 'soul_fire', 'cactus', 'sweet_berry_bush', 'magma_block', 'campfire', 'soul_campfire', 'powder_snow',
  'wither_rose', 'pointed_dripstone', 'cobweb', 'nether_portal', 'end_portal', 'end_gateway', 'sculk_sensor',
  'calibrated_sculk_sensor', 'sculk_shrieker', 'turtle_egg', 'bamboo_sapling', 'big_dripleaf', 'tripwire'
]

// What the physics engine really climbs (prismarine-physics isOnLadder): other vines would plan fine and then fail to climb.
const CLIMBABLE = ['ladder', 'vine', 'scaffolding']

// Extra path cost for being next to these (bumped by a mob or a bad jump). orth = 4 neighbours, diag = the 4 corners.
const NEAR_COST = {
  lava: { orth: 7, diag: 3 }, flowing_lava: { orth: 7, diag: 3 },
  cactus: { orth: 10, diag: 4 },
  fire: { orth: 3, diag: 1 }, soul_fire: { orth: 3, diag: 1 },
  magma_block: { orth: 0, diag: 0, above: 1 }
}
// Walking on/over these is allowed but avoided when there is another way (redstone triggers, crops).
const STEP_COST = {
  oak_pressure_plate: 15, stone_pressure_plate: 15, light_weighted_pressure_plate: 15, heavy_weighted_pressure_plate: 15,
  spruce_pressure_plate: 15, birch_pressure_plate: 15, jungle_pressure_plate: 15, acacia_pressure_plate: 15, dark_oak_pressure_plate: 15,
  mangrove_pressure_plate: 15, cherry_pressure_plate: 15, bamboo_pressure_plate: 15, crimson_pressure_plate: 15, warped_pressure_plate: 15,
  pale_oak_pressure_plate: 15, polished_blackstone_pressure_plate: 15, tripwire_hook: 10,
  soul_sand: 3, honey_block: 6, slime_block: 4
}
const FLOOR_COST = { farmland: 2 }
// Extra cost of a move that ends on farmland after a drop or a parkour jump (more than half a block of fall can turn it to dirt). Walking or stepping up onto it is free of this.
const FARMLAND_LANDING_COST = 100

const dirName = { 0: 'south', 1: 'west', 2: 'north', 3: 'east' }
// Compass word for a vector from the bot to something (z+ is south).
function compass(dx, dz) {
  if (!dx && !dz) return 'here'
  const a = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360       // 0 = north, 90 = east
  return ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'][Math.round(a / 45) % 8]
}

// Axis ('x' or 'z') you walk along to pass through a door/gate block, from its facing.
function passAxis(props) {
  const f = props && props.facing
  return (f === 'east' || f === 'west') ? 'x' : 'z'
}

module.exports = { isHandOpenable, isDoor, isGate, isTrapdoor, HARD_AVOID, CLIMBABLE, NEAR_COST, STEP_COST, FLOOR_COST, FARMLAND_LANDING_COST, compass, passAxis, dirName }
