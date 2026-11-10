// Configures a mineflayer-pathfinder `Movements` instance for Walter's rules and for the things the stock planner gets wrong:
//   - never digs/places (canDig/placeholders off, re-asserted here in case someone replaces the Movements later)
//   - hazards: lava, fire, cactus, magma, campfires, ... are never walked through or stood on; being NEXT to them costs extra
//   - falls: at most `maxFall` blocks (3 = no fall damage), also into water; long ladder descents are fine (grabbing a ladder resets the fall)
//   - closed hand-operable doors/gates are planned as passable (the DoorTender opens them) but only along their axis
//   - a closed trapdoor right above the top of a ladder climb is planned as a hatch (descending through one is NOT planned:
//     in the physics engine a bot dropping into a hatch shaft bobs against the trapdoor panel instead of sliding down)
// configure() patches the instance in place and returns { restore(), index, ... } so tests (and stop()) can undo it.
const { Vec3 } = require('vec3')
const B = require('./blocks')

const KEY = (x, y, z) => `${x},${y},${z}`

function configure(bot, mv, opts = {}) {
  const reg = bot.registry
  const maxFall = opts.maxFall ?? 3
  const idsOf = (names) => names.map(n => reg.blocksByName[n] && reg.blocksByName[n].id).filter(id => id !== undefined)
  const restore = []
  // patch(obj, 'name', (orig) => replacement): `orig` is whatever the instance had (the stock method, or an earlier override such as join.js's)
  const patch = (obj, name, make) => { const orig = obj[name]; obj[name] = make(orig); restore.push(() => { obj[name] = orig }) }
  const setProp = (obj, name, val) => { const orig = obj[name]; obj[name] = val; restore.push(() => { obj[name] = orig }) }

  // ---- rules that must hold whatever join.js did ----
  setProp(mv, 'canDig', false)
  setProp(mv, 'allow1by1towers', false)
  setProp(mv, 'allowParkour', opts.allowParkour ?? false)
  setProp(mv, 'scafoldingBlocks', [])
  setProp(mv, 'canOpenDoors', false)                 // doors are opened by the DoorTender, not by the library
  setProp(mv, 'maxDropDown', maxFall + 1)            // library counts floor-to-floor: 4 means a 3 block fall
  setProp(mv, 'infiniteLiquidDropdownDistance', false)
  setProp(mv, 'liquidCost', 25)                    // survival world: drowning is the top killer, wade only when there is no other way
  setProp(mv, 'blocksToAvoid', new Set([...mv.blocksToAvoid, ...idsOf(B.HARD_AVOID)]))
  for (const id of idsOf(B.CLIMBABLE)) if (!mv.climbables.has(id)) { mv.climbables.add(id); restore.push(() => mv.climbables.delete(id)) }

  const hardAvoid = new Set(idsOf(B.HARD_AVOID))
  const climbableIds = new Set(idsOf(B.CLIMBABLE))
  const ladderId = reg.blocksByName.ladder.id
  const doorLike = new Set(reg.blocksArray.filter(b => B.isHandOpenable(b.name)).map(b => b.id))
  const trapdoorIds = new Set(reg.blocksArray.filter(b => B.isTrapdoor(b.name)).map(b => b.id))
  const idName = (id) => reg.blocks[id] && reg.blocks[id].name

  // ---- doors index: where doors/gates are (refreshed by the nav core), used to keep door moves on the door's axis ----
  const doorCells = new Map()        // "x,y,z" -> axis ('x'|'z') for every hand-openable door/gate cell (both halves of doors)
  const index = {
    cells: doorCells,
    add(block) {
      if (!block || !B.isHandOpenable(block.name) || B.isTrapdoor(block.name)) return
      const axis = B.passAxis(block.getProperties ? block.getProperties() : {})
      const p = block.position
      doorCells.set(KEY(p.x, p.y, p.z), axis)
    },
    remove(pos) { doorCells.delete(KEY(pos.x, pos.y, pos.z)) },
    rescan(radius = 32) {   // was 96: a 96-block findBlocks on every goal change froze the event loop ~1.2 s (lag module)
      doorCells.clear()
      const ids = [...doorLike].filter(id => !trapdoorIds.has(id))
      let found = []
      try { found = bot.findBlocks({ matching: ids, maxDistance: radius, count: 600 }) } catch { /* not ready */ }
      for (const p of found) index.add(bot.blockAt(p))
      return doorCells.size
    }
  }

  // ---- hazard proximity costs (cached; cleared whenever the world changes) ----
  let costCache = new Map()
  const nameAt = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); return b ? b.name : null }
  function nearCost(x, y, z) {
    const k = KEY(x, y, z)
    let c = costCache.get(k)
    if (c !== undefined) return c
    c = 0
    for (const dy of [0, 1]) {
      for (const [dx, dz, kind] of [[1, 0, 'orth'], [-1, 0, 'orth'], [0, 1, 'orth'], [0, -1, 'orth'], [1, 1, 'diag'], [1, -1, 'diag'], [-1, 1, 'diag'], [-1, -1, 'diag']]) {
        const n = nameAt(x + dx, y + dy, z + dz)
        const w = n && B.NEAR_COST[n]
        if (w) c += w[kind]
      }
    }
    const here = nameAt(x, y - 1, z)                // what we would stand on
    if (here && B.FLOOR_COST[here]) c += B.FLOOR_COST[here]
    const feet = nameAt(x, y, z)
    if (feet && B.STEP_COST[feet]) c += B.STEP_COST[feet]
    if (here && B.STEP_COST[here]) c += Math.min(B.STEP_COST[here], 6)
    c = Math.min(c, 40)
    if (costCache.size > 60000) costCache = new Map()
    costCache.set(k, c)
    return c
  }
  const onBlockUpdate = (oldB, newB) => {
    costCache.clear()
    try {
      if (oldB && B.isHandOpenable(oldB.name)) index.remove(oldB.position)
      if (newB && B.isHandOpenable(newB.name)) index.add(newB)
    } catch { /* ignore */ }
  }
  bot.on('blockUpdate', onBlockUpdate)
  restore.push(() => bot.removeListener('blockUpdate', onBlockUpdate))
  const weight = (block) => (block && block.position ? nearCost(block.position.x, block.position.y, block.position.z) : 0)
  mv.exclusionAreasStep.push(weight)
  restore.push(() => { const i = mv.exclusionAreasStep.indexOf(weight); if (i >= 0) mv.exclusionAreasStep.splice(i, 1) })

  // ---- block classification ----
  let hatchUp = false
  patch(mv, 'getBlock', (orig) => function (pos, dx, dy, dz) {
    const b = orig.call(mv, pos, dx, dy, dz)
    if (!b || b.type === undefined) return b
    if (hardAvoid.has(b.type)) { b.physical = false; b.safe = false; return b }
    if (doorLike.has(b.type)) {
      if (trapdoorIds.has(b.type)) {
        const pr = b.getProperties ? b.getProperties() : {}
        const open = pr.open === true
        const below = hatchUp && dx === 0 && dz === 0 && dy === 2      // closed hatch right above a ladder climb
        if (open) {
          // an open trapdoor is a hole (or a ladder extension), never a floor; ladder-aligned ones are climbable like the physics says
          b.physical = false; b.safe = true
          const under = bot.blockAt(new Vec3(b.position.x, b.position.y - 1, b.position.z))
          if (under && under.type === ladderId && under.getProperties().facing === pr.facing) b.climbable = true
        } else if (below) { b.physical = false; b.safe = true }
      } else { b.physical = false; b.safe = true }                       // door or gate: opened on arrival, closed behind
      return b
    }
    return b
  })

  // Moves through a door/gate cell only along the door's axis (a leaf swings across the other one); never diagonally past one.
  function doorOk(node, n) {
    const dx = n.x - node.x, dz = n.z - node.z
    const diag = dx !== 0 && dz !== 0
    const cells = [[node.x, node.y, node.z], [n.x, n.y, n.z]]
    if (diag) cells.push([n.x, node.y, node.z], [node.x, node.y, n.z])
    for (const [x, y, z] of cells) {
      for (const yy of [y, y + 1]) {
        const axis = doorCells.get(KEY(x, yy, z))
        if (!axis) continue
        if (diag || (dx === 0 && dz === 0)) return false
        if ((axis === 'x' && dz !== 0) || (axis === 'z' && dx !== 0)) return false
      }
    }
    return true
  }
  // No climbing out of the top of a ladder into thin air: the library lets a path rise from a climbable cell into the empty cell above it and carry on from
  // there, but in the physics nothing holds the bot in that cell (the rung ends below it, and the 0.4 block of momentum does not reach a ledge). That
  // phantom move is what sent the bot up a ladder that stopped one short of the ledge, off its end, down, and up again ("ladder bobbing").
  const climbAt = (x, y, z) => { const b = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))); return !!b && (climbableIds.has(b.type) || !!b.climbable) }
  const noAirRise = (node, n) => {
    if (n.x !== node.x || n.z !== node.z || n.y !== node.y + 1) return true
    if (!climbAt(node.x, node.y, node.z) || climbAt(n.x, n.y, n.z)) return true
    const b = bot.blockAt(new Vec3(Math.floor(n.x), Math.floor(n.y), Math.floor(n.z)))
    return !b || b.liquid || (b.name || '').includes('water') || trapdoorIds.has(b.type)   // swimming up out of water, or up through a hatch above the ladder, is not this
  }
  patch(mv, 'getNeighbors', (orig) => function (node) {
    const all = orig.call(mv, node)
    return all.filter(n => noAirRise(node, n) && (!doorCells.size || doorOk(node, n)))
  })

  // Hatch contexts for the two vertical moves.
  patch(mv, 'getMoveUp', (orig) => function (node, neighbors) { hatchUp = true; try { return orig.call(mv, node, neighbors) } finally { hatchUp = false } })

  // Falls: count only the free-fall part, a ladder/vine you pass through resets it; the limit also applies to water.
  patch(mv, 'getLandingBlock', () => function (node, dir) {
    let startY = node.y
    let blockLand = mv.getBlock(node, dir.x, -2, dir.z)
    while (blockLand.position && blockLand.position.y > bot.game.minY) {
      if (blockLand.climbable) startY = blockLand.position.y
      if (blockLand.liquid && blockLand.safe) return (startY - blockLand.position.y - 1 <= maxFall) ? blockLand : null
      if (blockLand.physical) return (startY - blockLand.position.y - 1 <= maxFall) ? mv.getBlock(blockLand.position, 0, 1, 0) : null
      if (!blockLand.safe) return null
      blockLand = mv.getBlock(blockLand.position, 0, -1, 0)
    }
    return null
  })

  return {
    index, nearCost, doorCells,
    clearCaches() { costCache.clear() },
    restore() { while (restore.length) { try { restore.pop()() } catch { /* ignore */ } } }
  }
}

module.exports = { configure }
