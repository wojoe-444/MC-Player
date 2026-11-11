// brain/schematic/blocks.js: what a block IS, in the terms a build cares about. Pure.
//
// Walter 2026-11-11: "most of the mob farm is cobble, but all that matters is that it's a solid light-blocking block and not flammable." A schematic therefore
// stores ROLES, not block names, wherever the name does not matter, and keeps the exact block (with the properties that matter) only where it does
// (water levels, hoppers and which way they face, slabs, trapdoors, ladders, torches, chests ...).
//
//   any      anything at all (natural rock that touches nothing the build uses, or a cell nobody could read)
//   air      open: a mob or the player can stand or walk through (air, cave air)
//   solid    a full, opaque (light-blocking), non-flammable, non-falling cube that emits no light: cobblestone, stone, deepslate, bricks, concrete, ores, dirt ...
//            `block` is the one drawn (cobblestone); any other solid block passes the check
//   water    a water cell, with its level when the level matters (a source is 0, flowing 1..7)
//   lava     a lava cell
//   block    this exact block, with the listed properties (everything else); `alt: [names]` lists other blocks that are accepted in its place (an aesthetic build
//            that allows spruce planks where it drew oak)
// Any entry may carry `scenery: true`: part of the surroundings (terrain, trees next to the build). Drawn when the viewer shows the surroundings, never checked.
'use strict'

const strip = (n) => String(n || '').replace(/^minecraft:/, '')

const AIR = /^(air|cave_air|void_air)$/
// full cubes a build can use as a wall. Whitelist on purpose: a block that is not here is "block" (exact), never silently "solid".
const SOLID = /^(stone|cobblestone|mossy_cobblestone|deepslate|cobbled_deepslate|tuff|granite|diorite|andesite|dirt|coarse_dirt|rooted_dirt|podzol|mycelium|grass_block|clay|terracotta|netherrack|blackstone|basalt|smooth_basalt|calcite|dripstone_block|obsidian|crying_obsidian|bedrock|mud|packed_mud|end_stone|smooth_stone|sandstone|smooth_sandstone|cut_sandstone|chiseled_sandstone|red_sandstone|smooth_red_sandstone|cut_red_sandstone|chiseled_red_sandstone|iron_block|gold_block|diamond_block|emerald_block|lapis_block|redstone_block|copper_block|raw_iron_block|raw_gold_block|raw_copper_block|quartz_block|smooth_quartz|purpur_block|prismarine|dark_prismarine|stone_bricks|mossy_stone_bricks|cracked_stone_bricks|chiseled_stone_bricks|deepslate_bricks|deepslate_tiles|nether_bricks|bricks|mud_bricks|polished_[a-z_]+|[a-z_]+_ore|[a-z_]+_terracotta|[a-z_]+_concrete|[a-z_]*_bricks|[a-z_]*tiles|chiseled_[a-z_]+|cracked_[a-z_]+)$/
const NOT_SOLID_EVEN_IF_MATCHED = /(_slab|_stairs|_wall|_pane|_door|_trapdoor|_fence|_button|_pressure_plate|_sign)$|^(spawner|trial_spawner|vault|infested_[a-z_]+|sculk[a-z_]*|budding_amethyst)$/

const isAir = (name) => AIR.test(strip(name))
const isSolid = (name) => { const n = strip(name); return SOLID.test(n) && !NOT_SOLID_EVEN_IF_MATCHED.test(n) }
const isWater = (name) => strip(name) === 'water'
const isLava = (name) => strip(name) === 'lava'
// cells that are open for a mob to stand in or fall through (air, plants, torches, ladders ...): used to decide which solid cells form a shell
const OPENISH = /^(air|cave_air|void_air|water|lava|torch|wall_torch|soul_torch|soul_wall_torch|ladder|vine|glow_lichen|short_grass|tall_grass|fern|large_fern|[a-z_]*_button|redstone_wire|tripwire|string|lever|rail|powered_rail|detector_rail|activator_rail|snow|sign|[a-z_]*_sign|[a-z_]*_wall_sign|[a-z_]*_carpet|moss_carpet|[a-z_]*_sapling|dead_bush|leaf_litter|[a-z_]*_trapdoor|[a-z_]*_door|[a-z_]*_fence_gate|[a-z_]*_pressure_plate|[a-z_]*_slab|[a-z_]*_stairs|hopper|chest|trapped_chest|barrel|[a-z_]*_pane|[a-z_]*_fence|[a-z_]*_wall|scaffolding|cobweb|[a-z_]*_bed|conduit|bubble_column)$/
const isOpenish = (name) => OPENISH.test(strip(name))

// the properties that decide what a block does here; the rest (powered, waterlogged, distance ...) are noise for a build
const KEEP = ['facing', 'half', 'type', 'open', 'level', 'hinge', 'axis', 'face', 'attached', 'shape']
const keepProps = (props) => { const o = {}; for (const k of KEEP) if (props && props[k] != null) o[k] = String(props[k]); return o }

// { role, block?, props? } for one block state. `props` as the world gives them (strings).
function describe(name, props) {
  const n = strip(name)
  if (isAir(n)) return { role: 'air' }
  if (isSolid(n)) return { role: 'solid', block: n }
  if (isWater(n)) return { role: 'water', block: 'water', level: String((props && props.level) != null ? props.level : 0) }
  if (isLava(n)) return { role: 'lava', block: 'lava', level: String((props && props.level) != null ? props.level : 0) }
  const p = keepProps(props)
  return { role: 'block', block: n, ...(Object.keys(p).length ? { props: p } : {}) }
}
// the same cell for an aesthetic build: every block is wanted as itself (no "any solid block"), air stays air
function describeExact(name, props) {
  const n = strip(name)
  if (isAir(n)) return { role: 'air' }
  if (isWater(n) || isLava(n)) return describe(name, props)
  const p = keepProps(props)
  return { role: 'block', block: n, ...(Object.keys(p).length ? { props: p } : {}) }
}

// does a world block satisfy a palette entry?
function matches(entry, name, props) {
  if (!entry || entry.role === 'any') return true
  const n = strip(name)
  switch (entry.role) {
    case 'air': return isAir(n)
    case 'solid': return isSolid(n)
    case 'water': return isWater(n) && (entry.level == null || String((props && props.level) != null ? props.level : 0) === String(entry.level))
    case 'lava': return isLava(n)
    case 'block': if (entry.alt && entry.alt.map(strip).includes(n)) return true; return n === entry.block && Object.entries(entry.props || {}).every(([k, v]) => props && String(props[k]) === String(v))
    default: return false
  }
}
const label = (e) => !e ? '?' : e.role === 'block' ? e.block + (e.props ? ' ' + Object.entries(e.props).map(([k, v]) => `${k}=${v}`).join(' ') : '') : e.role === 'water' || e.role === 'lava' ? `${e.role}${e.level != null ? ' level ' + e.level : ''}` : e.role
// 'oak_stairs' -> 'Oak Stairs'
const displayName = (n) => strip(n).split('_').map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ')
const requirementText = (e) => ({ any: 'anything', air: 'open air', solid: 'a solid, light-blocking, non-flammable block (cobblestone, stone, deepslate ...)', water: 'water' + (e.level != null ? (String(e.level) === '0' ? ' (a source)' : ` (flowing, level ${e.level})`) : ''), lava: 'lava' }[e && e.role] || `exactly ${label(e)}`)

module.exports = { strip, isAir, isSolid, isWater, isLava, isOpenish, describe, describeExact, displayName, matches, label, requirementText, keepProps, SOLID }
