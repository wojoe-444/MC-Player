// brain/inspect/light.js: block light over a grid, the way the game spreads it (a source gives its level, every step through a transparent cell costs 1,
// an opaque block stops it). Pure. Monsters spawn in the Overworld only at block light 0 (1.21 monster_spawn_block_light_limit), so for a spawning room
// this is the number that decides everything: ONE torch inside a 17-wide room lights most of it.
'use strict'
const { EMIT, LIGHT_SOURCE } = require('./grid')

const SIX = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]

function sources(grid) {
  const out = []
  for (const [k, c] of grid.cells) if (LIGHT_SOURCE.test(c.n) && (EMIT[c.n] || 0) > 0) { const [x, y, z] = k.split(',').map(Number); out.push({ at: [x, y, z], name: c.n, level: EMIT[c.n] }) }
  return out
}

// light from the given sources only (a Map "x,y,z" -> level)
function spread(grid, srcs) {
  const light = new Map(), q = []
  for (const s of srcs) { const k = s.at.join(','); if ((light.get(k) || 0) < s.level) { light.set(k, s.level); q.push(s.at) } }
  for (let i = 0; i < q.length; i++) {
    const c = q[i], l = light.get(c.join(','))
    if (l <= 1) continue
    for (const [dx, dy, dz] of SIX) {
      const x = c[0] + dx, y = c[1] + dy, z = c[2] + dz
      if (!grid.isTransparent(x, y, z)) continue
      const k = x + ',' + y + ',' + z
      if ((light.get(k) || 0) < l - 1) { light.set(k, l - 1); q.push([x, y, z]) }
    }
  }
  return light
}
const blockLight = (grid) => spread(grid, sources(grid))

module.exports = { sources, spread, blockLight }
