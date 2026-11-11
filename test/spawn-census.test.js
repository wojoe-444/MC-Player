// tools/spawn-census.js: the share of spawn chances a mob farm gets, from chunk data (saved block light, floors, free cells).
const test = require('node:test')
const assert = require('node:assert')
const C = require('../tools/spawn-census')

// one chunk, section y 0..15: stone floor at y 0, air above, a torch's light on a 4x4 corner, no heightmap (surface assumed 64)
function chunk(cx, cz) {
  const ids = new BigInt64Array(Math.ceil(4096 / 16))              // 4 bits per entry, 16 per long: all zero = palette 0 ...
  // palette: 0 air, 1 stone; layer y=0 is stone (index 1): entries 0..255
  for (let i = 0; i < 256; i++) { const w = Math.floor(i / 16), sh = BigInt((i % 16) * 4); ids[w] |= 1n << sh }
  const bl = new Int8Array(2048)
  for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) { const i = x + 16 * z + 256 * 1; bl[i >> 1] |= (8 << ((i & 1) * 4)) }      // light 8 at y 1
  return { xPos: cx, zPos: cz, sections: [{ Y: 0, block_states: { palette: [{ Name: 'minecraft:air' }, { Name: 'minecraft:stone' }], data: ids }, BlockLight: bl }] }
}
test('a free cell on a solid floor with no light is a spawn cell; a lit one is not; weight is 1 / (256 * y range)', () => {
  const cells = C.spawnCells(chunk(0, 0))
  const at = (x, y, z) => cells.find(c => c.x === x && c.y === y && c.z === z)
  assert.ok(at(10, 1, 10)); assert.strictEqual(at(1, 1, 1), undefined, 'block light 8 at the cell')
  assert.ok(!at(10, 2, 10), 'no floor under it'); assert.strictEqual(cells.filter(c => c.y === 1).length, 256 - 16)
  assert.ok(Math.abs(at(10, 1, 10).w - 1 / (256 * (65 + 64 + 1))) < 1e-12)       // surface 64: y from -64 to 65
})
test('share: the farm cells against everything else, minus cells within 24 blocks of a player', () => {
  const cells = [{ x: 0, y: 1, z: 0, w: 0.001, pad: true }, { x: 100, y: 1, z: 0, w: 0.099, pad: false }, { x: 5, y: 1, z: 5, w: 0.1, pad: false }]
  const cs = { cells }
  assert.ok(Math.abs(C.share(cs, []).farmShare - 0.001 / 0.2) < 1e-9)
  const s = C.share(cs, [[2, 1, 2]])                          // a player beside the farm: the farm and the cell at 5,5 are inside 24 blocks
  assert.strictEqual(s.farm, 0); assert.strictEqual(s.farmShare, 0)
  assert.strictEqual(C.share(cs, [[2, 1, 2]]).rest, 0.099, 'only the far cell is left, if its chunk is within 128 of the player')
})
