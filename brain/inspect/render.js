// brain/inspect/render.js: the picture a human takes in at a glance, as text a model can read too: a light map of the spawning room (digits = block light,
// '.' = dark enough to spawn on) and two cutaways through the farm (along its axis through the drop column, and across the trench), with the cells the
// inspection flagged marked '!'. Pure. A model sees "a column of digits in a room that should be all dots" without any rule telling it what a torch is.
'use strict'
const MF = require('../mobfarm/geometry')

const SYM = { air: ' ', cave_air: ' ', void_air: ' ', stone: '#', cobblestone: 'c', water: '~', lava: 'L', torch: 'T', wall_torch: 'T', hopper: 'H', chest: 'C', ladder: 'l', sandstone: 's', dirt: 'd', grass_block: 'G', granite: 'g', andesite: 'a', diorite: 'i', gravel: 'v', deepslate: 'D', tuff: 'u', cobbled_deepslate: 'b', mud: 'm', coal_ore: 'o', iron_ore: 'I', copper_ore: 'p', oak_planks: 'P', oak_log: 'O', oak_leaves: '&', short_grass: ',', tall_grass: ',', stone_bricks: 'B' }
const sym = (n) => (n == null ? '?' : SYM[n] !== undefined ? SYM[n] : /_ore$/.test(n) ? 'o' : /_slab$|_stairs$/.test(n) ? '_' : /_door$|_trapdoor$|_fence/.test(n) ? '|' : /sapling|flower|fern|bush/.test(n) ? ',' : '*')
const LV = '0123456789abcdef'

// block-light map of one level over a rectangle: '#' solid, '.' dark (light 0) open, digit/letter = light level, '~' water
function lightPlan(grid, light, rect, y, mark) {
  const rows = []
  for (let z = rect.z0; z <= rect.z1; z++) {
    let s = ''
    for (let x = rect.x0; x <= rect.x1; x++) {
      const m = mark && mark.get(x + ',' + y + ',' + z)
      if (m) { s += m; continue }
      if (!grid.has(x, y, z)) { s += '?'; continue }
      if (grid.isSolid(x, y, z)) { s += '#'; continue }
      const n = grid.name(x, y, z)
      if (n === 'water') { s += '~'; continue }
      const l = light.get(x + ',' + y + ',' + z) || 0
      s += l === 0 ? '.' : LV[Math.min(15, l)]
    }
    rows.push(s)
  }
  return `light at y=${y} (x ${rect.x0}..${rect.x1} left to right, z ${rect.z0}..${rect.z1} top to bottom; '.' = dark, digit = light level, # rock, ~ water)\n` + rows.join('\n')
}

// a vertical cutaway: horizontal axis 'x' (fixed z) or 'z' (fixed x)
function section(grid, axis, fixed, a0, a1, y0, y1, mark) {
  const rows = []
  for (let y = y1; y >= y0; y--) {
    let s = ''
    for (let a = a0; a <= a1; a++) {
      const x = axis === 'x' ? a : fixed, z = axis === 'x' ? fixed : a
      const m = mark && mark.get(x + ',' + y + ',' + z)
      s += m || (grid.has(x, y, z) ? sym(grid.name(x, y, z)) : '?')
    }
    rows.push(String(y).padStart(4) + ' ' + s)
  }
  return `cutaway through ${axis === 'x' ? 'z' : 'x'}=${fixed} (${axis} ${a0}..${a1} left to right, y ${y1} at the top; '#' rock, ' ' open, ~ water, T torch, H hopper, C chest, l ladder, ! flagged)\n` + rows.join('\n')
}

function renderMobFarm(L, grid, light, result) {
  const mark = new Map()
  for (const f of result.findings) if (f.sev !== 'note') for (const s of f.cells) mark.set(s.replace(/,/g, ',').split(',').map(Number).join(','), '!')
  const P = L.platform, b = L.platformBox, h = P.hole
  const alongX = Math.abs(L.d[0]) === 1
  const plan = lightPlan(grid, light, { x0: b.x0 - 1, x1: b.x1 + 1, z0: b.z0 - 1, z1: b.z1 + 1 }, L.Yp, mark)
  const y0 = L.Y0 - 3, y1 = L.Yp + 3
  const fb = L.box
  const along = alongX ? section(grid, 'x', h[2], fb.x0 - 2, fb.x1 + 2, y0, y1, mark) : section(grid, 'z', h[0], fb.z0 - 2, fb.z1 + 2, y0, y1, mark)
  const across = alongX ? section(grid, 'z', h[0], fb.z0 - 2, fb.z1 + 2, y0, y1, mark) : section(grid, 'x', h[2], fb.x0 - 2, fb.x1 + 2, y0, y1, mark)
  return { lightPlan: plan, along, across }
}

module.exports = { lightPlan, section, renderMobFarm, sym }
