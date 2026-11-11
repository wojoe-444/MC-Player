// Arena preview for the dashboard: a top-down colour grid of the arena window (surface block per column, shaded by height), as JSON the page draws on a canvas.
// { size, x0, z0, palette: [[name, '#rrggbb']], grid: [paletteIndex...] (row-major, z then x), height: [y...], spawn, center }
'use strict'
const fs = require('fs')
const T = require('./terrain')
const W = require('../../../brain/schematic/world')

const COLORS = [
  [/grass_block|^minecraft:fern|tall_grass/, '#5d9b3a'], [/podzol/, '#6b4a2a'], [/snow/, '#f1f5f8'], [/powder_snow/, '#f1f5f8'], [/red_sand/, '#bf6a2f'], [/sand$|sandstone/, '#dccf8f'],
  [/gravel/, '#867f7c'], [/coarse_dirt|rooted_dirt|dirt/, '#7a5636'], [/mud/, '#4a3a33'], [/clay/, '#9aa3b3'], [/stone|andesite|diorite|granite|tuff|deepslate|calcite|cobble/, '#7d7d7d'],
  [/water/, '#3b6fd0'], [/ice/, '#a3c6f5'], [/lava/, '#e0661a'], [/_leaves/, '#2f6a28'], [/_log|_wood/, '#5a432b'], [/cactus/, '#2f7d3a'], [/terracotta/, '#a1583a'], [/mycelium/, '#6c5b6b']
]
const colorOf = (n) => { for (const [re, c] of COLORS) if (re.test(n)) return c; return '#909090' }

function write(worldDir, meta, outFile) {
  const size = meta.size, x0 = meta.center[0] - size / 2, z0 = meta.center[1] - size / 2
  const g = T.columns(worldDir, x0, z0, x0 + size - 1, z0 + size - 1)
  const w = W.openSave(worldDir)
  const pal = [], idx = new Map(), grid = new Array(size * size), height = new Array(size * size)
  for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) {
    const o = z * size + x
    // the surface including trees and water: look one block above the ground heightmap for leaves, else the ground block; water shows as water
    let y = g.ground[o], b = w.get(x0 + x, y, z0 + z)
    if (g.water[o] > 0) b = { name: 'minecraft:water' }
    else if (g.tree[o]) b = { name: 'minecraft:oak_leaves' }
    else if (b && /^minecraft:(snow)$/.test(b.name)) b = { name: 'minecraft:snow' }
    const n = b ? b.name : 'minecraft:air'
    if (!idx.has(n)) { idx.set(n, pal.length); pal.push([n.replace('minecraft:', ''), colorOf(n)]) }
    grid[o] = idx.get(n); height[o] = y
  }
  w.close()
  fs.writeFileSync(outFile, JSON.stringify({ size, x0, z0, palette: pal, grid, height, spawn: meta.spawn, center: meta.center, biome: meta.biome, window: meta.window }))
}
module.exports = { write }
