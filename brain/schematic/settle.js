// brain/schematic/settle.js: the block states a schematic file does not keep, worked out from the neighbours, for placing a schematic into a world save.
// A schematic stores only the properties that decide what a block does (facing, half, type ...). A running game would recompute fence / wall / pane connections, hanging
// lanterns and decaying leaves on its first block update, but a save written straight to disk gets no update, so a build pasted as it is would show unconnected fences
// and its leaves would rot. `settle` adds those properties: fence / wall / pane / bars connections, wall posts, lanterns hanging from a block, leaves persistent.
// Pure: works on a { W, H, D, cells: Uint16Array (x fastest, then z, then y), states: [{ name, props }] } grid; `intern(name, props)` returns the state index.
'use strict'
const B = require('./blocks')

const DIRS = [['north', 0, -1], ['south', 0, 1], ['east', 1, 0], ['west', -1, 0]]
const isFence = (n) => /_fence$/.test(n)
const isWall = (n) => /_wall$/.test(n)
const isPane = (n) => /_pane$/.test(n) || n === 'iron_bars'
const isGate = (n) => /_fence_gate$/.test(n)
// full cubes a fence, wall or pane attaches to (sturdy side). Whitelist plus what blocks.js knows is solid.
const FULL = /(_planks|_log|_wood|_wool|_stem|_hyphae|_concrete|_concrete_powder|_terracotta|glass|_ore|_block|_bricks|_tiles)$|^(barrel|furnace|blast_furnace|smoker|crafting_table|bookshelf|stone|cobblestone|smooth_stone|sandstone|dirt|grass_block|sand|gravel|tuff|andesite|diorite|granite|deepslate|bedrock|obsidian|crying_obsidian|netherrack|clay|packed_ice|ice|glowstone|sea_lantern|cartography_table|fletching_table|smithing_table|loom|lectern_nope|jukebox|note_block|dispenser|dropper|observer|piston_nope)$|^stripped_/
const NOT_ATTACHED = /(_leaves|barrier|pumpkin|melon|shulker_box|_slab|_stairs|_wall|_fence|_pane|_door|_trapdoor|_gate|_button|_plate|_sign|_banner|_bed|_carpet)$|^(iron_bars|lantern|soul_lantern|chain|torch|wall_torch|ladder|chest|trapped_chest|composter|campfire|grindstone|hopper|cauldron|anvil|flower_pot|candle|bell|scaffolding)$/
const fullCube = (n) => B.isSolid(n) || (FULL.test(n) && !NOT_ATTACHED.test(n))

function settle(grid, intern) {
  const { W, H, D, cells, states } = grid
  const at = (x, y, z) => (x < 0 || y < 0 || z < 0 || x >= W || y >= H || z >= D) ? null : states[cells[x + W * (z + D * y)]]
  const nm = (s) => s ? B.strip(s.name) : ''
  const out = new Map()   // cell index -> new state index
  for (let y = 0; y < H; y++) for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
    const k = x + W * (z + D * y), s = states[cells[k]], n = nm(s)
    if (!n || n === 'air') continue
    const props = { ...(s.props || {}) }
    let changed = false
    if (isFence(n) && props.north == null) {
      const wood = !/nether_brick/.test(n)
      for (const [d, dx, dz] of DIRS) {
        const m = nm(at(x + dx, y, z + dz)), gate = isGate(m) && gateAlong(at(x + dx, y, z + dz), d)
        props[d] = String(gate || (isFence(m) && wood === !/nether_brick/.test(m)) || fullCube(m)); changed = true
      }
    } else if (isPane(n) && props.north == null) {
      for (const [d, dx, dz] of DIRS) { const m = nm(at(x + dx, y, z + dz)); props[d] = String(isPane(m) || isWall(m) || fullCube(m)); changed = true }
    } else if (isWall(n) && props.up == null) {
      const side = {}, above = at(x, y + 1, z), a = nm(above)
      let count = 0
      for (const [d, dx, dz] of DIRS) {
        const nb = at(x + dx, y, z + dz), m = nm(nb)
        const conn = isWall(m) || fullCube(m) || isPane(m) || (isGate(m) && gateAlong(nb, d))
        side[d] = conn; if (conn) count++
      }
      const aboveFull = fullCube(a) || (/_slab$/.test(a) && above.props && above.props.type !== 'bottom')
      const tallOf = (d, dx, dz) => aboveFull || (isWall(a) && wallSide(above, d)) || (isWall(a) && wallConn(at(x + dx, y + 1, z + dz)))
      for (const [d, dx, dz] of DIRS) props[d] = side[d] ? (tallOf(d, dx, dz) ? 'tall' : 'low') : 'none'
      const straight = count === 2 && ((side.north && side.south) || (side.east && side.west))
      props.up = String(!straight || aboveFull || isWall(a) || /torch|lantern|chain|banner|sign|skull|head/.test(a))
      changed = true
    } else if (/_leaves$/.test(n) && props.persistent == null) { props.persistent = 'true'; changed = true }
    else if ((n === 'lantern' || n === 'soul_lantern') && props.hanging == null) {
      const up = nm(at(x, y + 1, z)), down = nm(at(x, y - 1, z))
      const holdsUp = (m) => fullCube(m) || /_slab$|_stairs$|_fence$|_wall$/.test(m)
      props.hanging = String(/chain$/.test(up) || (holdsUp(up) && !holdsUp(down)))
      changed = true
    }
    if (changed) out.set(k, intern(s.name, props))
  }
  for (const [k, v] of out) cells[k] = v
  return out.size
}

// does a fence gate at `nb` stand along the direction d (a gate facing north or south connects along east-west, so it joins a neighbour to its east or west)
function gateAlong(nb, d) { const f = nb && nb.props && nb.props.facing; if (!f) return true; return (f === 'north' || f === 'south') ? (d === 'east' || d === 'west') : (d === 'north' || d === 'south') }
const wallConn = (s) => !!s && isWall(B.strip(s.name))
const wallSide = (s, d) => !!s && s.props && s.props[d] && s.props[d] !== 'none'

module.exports = { settle, fullCube }
