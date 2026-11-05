// Pure geometry of the strip mine and the stairs. No bot, no world: everything is derived from the mine record.
//
//   trunk:   1 wide, 2 high, runs from the origin along `dir` (cells t = 0 .. trunkLen, t = 0 is the origin itself).
//   branch:  at every junction t (t % spacing === 0) a hallway of the same size goes out to the left and to the right.
//   spacing 3 = hallway, 2 solid blocks, hallway: every block between two hallways touches one of them, so everything
//   in the strip is exposed to a player walking the hallways and nothing has to be guessed.
const { Vec3 } = require('vec3')

const CARDINALS = [[1, 0], [0, 1], [-1, 0], [0, -1]]      // east, south, west, north
const leftOf = (d) => [d[1], -d[0]]                        // 90 degrees to the left when looking along d (x east, z south)
const rightOf = (d) => [-d[1], d[0]]
const sideVec = (dir, side) => (side === 'L' ? leftOf(dir) : rightOf(dir))

// feet cell of trunk cell t
const trunkCell = (mine, t) => new Vec3(mine.origin[0] + mine.dir[0] * t, mine.y, mine.origin[2] + mine.dir[1] * t)
// feet cell k (>=1) of the branch at junction t on `side`
function branchCell(mine, t, side, k) {
  const s = sideVec(mine.dir, side), c = trunkCell(mine, t)
  return new Vec3(c.x + s[0] * k, mine.y, c.z + s[1] * k)
}
const keyOf = (t, side) => `${t}:${side}`

function newMine({ origin, dir, y, spacing = 3, trunkLen = 48, branchLen = 16, ore = null, name = null, dim = 'overworld', now = null }) {
  return { origin: [origin[0], y, origin[2]], dir: [dir[0], dir[1]], y, spacing, trunkLen, branchLen, trunk: 0, branches: {}, frontier: [origin[0], y, origin[2]], ore, name, dim, createdAt: now }
}

// The next piece of work, nearest junction first: { type:'branch', t, side, from } | { type:'trunk', from, to } | null (strip finished)
function nextSegment(mine) {
  for (let t = 0; t <= mine.trunk; t += mine.spacing) {
    for (const side of ['L', 'R']) {
      const b = mine.branches[keyOf(t, side)]
      if (!b || !b.done) return { type: 'branch', t, side, from: b ? b.len : 0 }
    }
  }
  if (mine.trunk < mine.trunkLen) return { type: 'trunk', from: mine.trunk, to: Math.min(mine.trunk + mine.spacing, mine.trunkLen) }
  return null
}

// Hallway cells in the planned strip (trunk + branches), for status lines.
function plannedCells(mine) {
  const junctions = Math.floor(mine.trunkLen / mine.spacing) + 1
  return mine.trunkLen + junctions * 2 * mine.branchLen
}
function doneCells(mine) {
  let n = mine.trunk
  for (const b of Object.values(mine.branches)) n += b.len || 0
  return n
}

// Stairs: from feet cell `from` heading `dir`, going down (-1) or up (+1). `dig` lists the cells to clear for the next step in the
// order they must be dug so that each one is in plain view of the bot standing on `from`; `land` is the next feet cell and `floor`
// the block under it (it has to be seen and solid before anyone steps).
function stairStep(from, dir, vdir) {
  const nx = from.x + dir[0], nz = from.z + dir[1]
  if (vdir < 0) {
    const land = new Vec3(nx, from.y - 1, nz)
    return { dig: [new Vec3(nx, from.y, nz), land, new Vec3(nx, from.y + 1, nz)], land, floor: land.offset(0, -1, 0) }
  }
  const land = new Vec3(nx, from.y + 1, nz)           // going up the step block (nx, from.y) stays: it is the floor of the landing
  return { dig: [land, new Vec3(nx, from.y + 2, nz), new Vec3(from.x, from.y + 2, from.z)], land, floor: new Vec3(nx, from.y, nz) }
}

module.exports = { CARDINALS, leftOf, rightOf, sideVec, trunkCell, branchCell, keyOf, newMine, nextSegment, plannedCells, doneCells, stairStep }
