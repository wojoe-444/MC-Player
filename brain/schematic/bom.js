// brain/schematic/bom.js: the bill of materials of a schematic, and the raw materials it comes down to. Pure.
//   bom(s)        -> [{ key, block, name, cells, indices, role, subs, fluid }]  one row per block (all its facings, levels and variants together), most first.
//                    `indices` are the palette entries (for the viewer to isolate), `subs` says what else may stand there when the role allows a substitute.
//   rawMaterials(rows) -> { lines: [{ id, label, verb, amount, stacks }], other: [{ name, amount }], note }
//                    what to mine, chop and smelt for it (rounded up; fuel is not counted). Crafting ratios are the game's: 3 planks make 6 slabs, 6 make 4 stairs ...
// Scenery (the natural world kept around a build for the picture) is not part of the build and is not counted.
'use strict'
const B = require('./blocks')

function bom(s) {
  const rows = new Map()
  s.palette.forEach((e, i) => {
    const n = (s.counts && s.counts[i]) || 0
    if (!n || e.role === 'any' || e.role === 'air' || e.scenery) return
    const block = e.role === 'water' || e.role === 'lava' ? e.role : B.strip(e.block || '?').replace(/^(soul_)?wall_torch$/, '$1torch')
    const r = rows.get(block) || { key: block, block, name: B.displayName(block), cells: 0, indices: [], role: e.role, subs: null, fluid: e.role === 'water' || e.role === 'lava' }
    r.cells += n; r.indices.push(i)
    if (e.role === 'solid') r.subs = 'Any solid, light-blocking, non-flammable block works here'
    else if (e.alt && e.alt.length) r.subs = 'Also accepted: ' + e.alt.map(B.displayName).join(', ')
    rows.set(block, r)
  })
  return [...rows.values()].sort((a, b) => b.cells - a.cells || a.name.localeCompare(b.name))
}

// ---- raw materials
const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak']
const STEMS = ['crimson', 'warped']
const woodRe = new RegExp('^(' + [...WOODS, ...STEMS, 'bamboo'].join('|') + ')_(planks|slab|stairs|fence|fence_gate|trapdoor|door|button|pressure_plate|sign|wall_sign|log|wood|stem|hyphae|block|mosaic|mosaic_slab|mosaic_stairs)$')
const stripped = (n) => n.replace(/^stripped_/, '')
// planks per block (a log makes 4 planks; sticks are half a plank each pair)
const PLANKS = { planks: 1, slab: 0.5, stairs: 1.5, fence: 1.5, fence_gate: 3, trapdoor: 3, door: 1, button: 1, pressure_plate: 2, sign: 1.75, wall_sign: 1.75, mosaic: 1, mosaic_slab: 0.5, mosaic_stairs: 1.5, block: 4 }
const LOGS = new Set(['log', 'wood', 'stem', 'hyphae'])

// stone family: [cobblestone to mine per block, smelting operations per block]
const STONE = {
  cobblestone: [1, 0], mossy_cobblestone: [1, 0], stone: [1, 1], smooth_stone: [1, 2], stone_bricks: [1, 1], mossy_stone_bricks: [1, 1], cracked_stone_bricks: [1, 2], chiseled_stone_bricks: [1, 1],
  cobbled_deepslate: [1, 0], andesite: [1, 0], granite: [1, 0], diorite: [1, 0],
}
const SHAPE = { slab: 0.5, stairs: 1.5, wall: 1 }
const BASE = { stone_brick: 'stone_bricks', mossy_stone_brick: 'mossy_stone_bricks', brick: 'bricks' }

const add = (m, k, v) => { m[k] = (m[k] || 0) + v }
function rawMaterials(rows) {
  const logs = {}, cobble = { a: 0 }, other = {}, st = { smelt: 0, charcoal: 0 }, extraLogs = { n: 0 }
  let torches = false
  for (const r of rows) {
    if (r.fluid) continue
    const n = B.strip(r.block), c = r.cells
    const w = n.match(woodRe)
    if (w) {
      const wood = w[1], kind = w[2]
      if (LOGS.has(kind)) add(logs, wood, c)
      else add(logs, wood, (PLANKS[kind] || 1) * c / 4)
      continue
    }
    const sn = stripped(n)
    const lw = sn.match(woodRe)
    if (lw && n !== sn) { add(logs, lw[1], c); continue }
    // stone family with a shape suffix
    const sh = n.match(/^(.*)_(slab|stairs|wall)$/)
    const base = sh ? (BASE[sh[1]] || sh[1]) : n
    if (STONE[base]) {
      const k = sh ? SHAPE[sh[2]] : 1
      cobble.a += STONE[base][0] * k * c; st.smelt += STONE[base][1] * k * c
      continue
    }
    if (n === 'torch' || n === 'wall_torch') { torches = true; st.charcoal += c / 4; extraLogs.n += c / 4 + c / 32; continue }
    if (n === 'soul_torch' || n === 'soul_wall_torch') { torches = true; add(other, n, c); continue }
    if (n === 'ladder') { extraLogs.n += c * 7 / 3 / 8; continue }                 // 7 sticks = 3.5 planks for 3 ladders
    if (n === 'chest' || n === 'trapped_chest') { extraLogs.n += c * 2; continue }   // 8 planks
    if (n === 'barrel') { extraLogs.n += c * 7 / 4; continue }
    if (n === 'crafting_table') { extraLogs.n += c; continue }
    if (n === 'hopper') { add(other, 'iron_ingot', 5 * c); extraLogs.n += c * 2; continue }
    if (n === 'dirt' || n === 'grass_block') { add(other, 'dirt', c); continue }
    add(other, n, c)
  }
  const top = Object.entries(logs).sort((a, b) => b[1] - a[1])[0]
  const spill = top ? top[0] : 'oak'
  add(logs, spill, extraLogs.n)
  st.smelt += st.charcoal
  const up = (v) => Math.ceil(v - 1e-9)
  const lines = []
  const line = (id, label, verb, amount) => { const a = up(amount); if (a > 0) lines.push({ id, label, verb, amount: a, stacks: Math.round(a / 64 * 10) / 10 }) }
  line('cobblestone', 'Cobblestone', 'to mine', cobble.a)
  for (const [wood, v] of Object.entries(logs).sort((a, b) => b[1] - a[1])) line(wood + '_log', B.displayName(wood) + (STEMS.includes(wood) ? ' stems' : ' logs'), 'to chop', v)
  line('smelting', 'Smelting operations', '', st.smelt)
  const rest = Object.entries(other).sort((a, b) => b[1] - a[1]).map(([name, amount]) => ({ name: B.displayName(name), amount: up(amount) }))
  const notes = []
  if (cobble.a || Object.keys(logs).length) notes.push('Everything that can be made from cobblestone and logs is counted that way (stone is smelted cobblestone, planks are logs).')
  if (torches) notes.push('Torches use charcoal (smelted logs); fuel for the furnace is not counted.')
  if (rest.length) notes.push('Blocks listed under "Other" are counted as they stand: gather or craft them.')
  return { lines, other: rest, note: notes.join(' ') }
}

module.exports = { bom, rawMaterials }
