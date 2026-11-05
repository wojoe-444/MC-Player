// Probe job: map the obstacle course (x -108..-59, z 1..50) into a top-down ASCII map + per-column profile.
const fs = require('fs'), path = require('path')
const { Vec3 } = require('vec3')
module.exports = async function (bot, cmd, sleep) {
  cmd('/gamemode creative'); cmd('/tp @s -65 -60 8 0 0'); await sleep(4000)
  const X0 = -110, X1 = -58, Z0 = 0, Z1 = 52, YMIN = -63, YMAX = -40
  const ch = (n) => ({ air: '.', grass_block: '.', dirt: '.', bedrock: '.', orange_concrete: 'O', white_concrete: 'W', red_concrete: 'R', blue_concrete: 'B', light_blue_concrete: 'b', cyan_concrete: 'c', water: '~', lava: 'L', netherrack: 'n', soul_sand: 's', glass: 'G', glass_pane: 'g', stained_glass: 'G', iron_bars: '#', barrier: '!', cobweb: 'w', ladder: 'H', oak_door: 'D', iron_door: 'D', oak_fence: 'F', slime_block: 'S', honey_block: 'h', ice: 'i', packed_ice: 'i', magma_block: 'M', cactus: 'C', obsidian: 'X', stone: '#' }[n] || (n.endsWith('_concrete') ? 'k' : n.endsWith('_stained_glass') ? 'G' : n.endsWith('_glass') ? 'G' : n.endsWith('_stairs') ? '/' : n.endsWith('_slab') ? '_' : '?'))
  const lines = [], legendUnknown = new Set(), cols = {}
  for (let z = Z0; z <= Z1; z++) {
    let row = ''
    for (let x = X0; x <= X1; x++) {
      let top = null, topY = null, nonAirCount = 0, waterAt = false
      for (let y = YMAX; y >= YMIN; y--) {
        const b = bot.blockAt(new Vec3(x, y, z)); if (!b) continue
        if (b.name === 'air') continue
        if (b.name === 'water') waterAt = true
        if (top === null && b.name !== 'grass_block' && b.name !== 'dirt' && b.name !== 'bedrock') { top = b.name; topY = y }
        nonAirCount++
      }
      const c = top === null ? '.' : ch(top)
      if (c === '?') legendUnknown.add(top)
      row += c
      if (top !== null) cols[x + ',' + z] = [top, topY]
    }
    lines.push(String(z).padStart(3) + ' ' + row)
  }
  const header = '    ' + Array.from({ length: X1 - X0 + 1 }, (_, i) => (i % 10 === 0 ? String(Math.abs(X0 + i) % 100).padStart(2, '0')[0] : ' ')).join('')
  const txt = `x from ${X0} (left) to ${X1} (right), z from ${Z0} (top) to ${Z1} (bottom). O orange wall, B/b blue, G glass, ~ water, W white start, R red finish, n netherrack, . open\n` + lines.join('\n') + '\nunknown: ' + [...legendUnknown].join(',')
  fs.writeFileSync(path.join(__dirname, 'results', 'course-map.txt'), txt)
  // wall heights: report max y of orange per column quickly
  let maxWall = -99; for (const [k, [n, y]] of Object.entries(cols)) if (n === 'orange_concrete') maxWall = Math.max(maxWall, y)
  return { unknown: [...legendUnknown], maxWallY: maxWall, columns: Object.keys(cols).length }
}
