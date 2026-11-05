// Probe job: find the purple terracotta barrier around the old arena and save its footprint to walls.json.
const fs = require('fs'), path = require('path')
module.exports = async function (bot, cmd, sleep) {
  cmd('/gamemode creative'); cmd('/tp @s 2.5 -60 -8.5 0 0'); await sleep(3500)
  const b = bot.registry.blocksByName['purple_terracotta']
  const ps = b ? bot.findBlocks({ matching: b.id, maxDistance: 120, count: 50000 }) : []
  if (!ps.length) return { found: 0 }
  const xs = ps.map(p => p.x), ys = ps.map(p => p.y), zs = ps.map(p => p.z)
  const bbox = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), z0: Math.min(...zs), z1: Math.max(...zs) }
  const cells = new Set(ps.map(p => p.x + ',' + p.z))
  fs.writeFileSync(path.join(__dirname, 'walls.json'), JSON.stringify({ bbox, count: ps.length, cells: [...cells] }))
  return { found: ps.length, bbox, home: [2.5, -8.5] }
}
