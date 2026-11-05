// Probe job: report where the orange/white/red concrete course is (blocks within loaded chunks) and where the players are.
module.exports = async function (bot) {
  const names = ['orange_concrete', 'white_concrete', 'red_concrete', 'lime_concrete', 'black_concrete', 'yellow_concrete', 'blue_concrete']
  const out = { me: bot.entity.position, players: {}, blocks: {} }
  for (const [n, p] of Object.entries(bot.players)) if (p.entity) out.players[n] = p.entity.position
  for (const n of names) {
    const b = bot.registry.blocksByName[n]; if (!b) continue
    const ps = bot.findBlocks({ matching: b.id, maxDistance: 160, count: 20000 })
    if (!ps.length) continue
    const xs = ps.map(p => p.x), ys = ps.map(p => p.y), zs = ps.map(p => p.z)
    out.blocks[n] = { count: ps.length, min: [Math.min(...xs), Math.min(...ys), Math.min(...zs)], max: [Math.max(...xs), Math.max(...ys), Math.max(...zs)], sample: ps.slice(0, 6).map(p => [p.x, p.y, p.z]) }
  }
  return out
}
