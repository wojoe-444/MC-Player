// LadderWork: climbing a ladder column by hand and finishing an incomplete one with the fewest blocks.
//
// Why it exists: the pathfinder plans over the ladders that are there. When a ladder stops short of where the goal is it still plans the climb (or
// loops on it): the bot rides up to the last rung, falls off, slides back down and starts again ("bobbing"; the live bot did it 13 blocks up and
// down in a shaft). StuckMonitor now recognises that cycle (err 'ladder-loop') and the navigator hands the goal to this module, which
//   1. reads the column cell by cell,
//   2. works out what is missing: ladders, and a backing block where the wall behind a cell is open,
//   3. places exactly that, from the rung below, bottom to top, and climbs as it goes (the same cells it needs are the minimum: see plan()),
//   4. steps off at the top onto the goal.
//
// Physics it relies on (prismarine-physics, same as vanilla 1.21):
//   - on a ladder the climb is 0.2 blocks/tick while jump is held or the bot is pressed into the wall; with nothing pressed it slides at 0.15;
//     SNEAK holds it still (that is how it waits on a rung while it places the next ladder)
//   - feet leaving the top of the highest rung gain about 0.4 more: not enough for a ledge, so the rung must reach the cell BELOW the exit level
//   - from the ground one cell of ladder can be skipped at the bottom (a jump takes the feet 1.25 up, into the next cell, and the bot grabs the rung)
// Placement follows Walter's rules: reach 4.5 and a clear line to the face, one block per placement, nothing dug, nothing placed that is not needed.
const { Vec3 } = require('vec3')

const DIRS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }
const FACING_OF = (dx, dz) => Object.keys(DIRS).find(k => DIRS[k][0] === dx && DIRS[k][1] === dz)
const BACKING = ['cobblestone', 'cobbled_deepslate', 'stone', 'dirt', 'netherrack', 'andesite', 'diorite', 'granite', 'deepslate', 'tuff', 'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks']

const isAir = (b) => !b || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air'
const fullSolid = (b) => !!b && b.boundingBox === 'block' && Array.isArray(b.shapes) && b.shapes.length === 1 && b.shapes[0].join(',') === '0,0,0,1,1,1' && !/(^|_)(ladder|scaffolding|chest|bed|door|trapdoor|slab|stairs|torch|sign|fence|wall|glass_pane|leaves|ice)$|^(gravel|sand|red_sand)$/.test(b.name)
const tick = (bot) => new Promise(r => bot.once('physicsTick', r))
const waitTicks = async (bot, n) => { for (let i = 0; i < n; i++) await tick(bot) }

// ---------------------------------------------------------------------------------------------- planning (pure)
// cells: [{ y, kind }] for the column cells from baseY up to exitY - 1, kind = 'ladder' | 'free' (air, wall behind is solid) | 'nowall' (air, wall behind is open)
//        | 'blocked' (something solid in the column)
// Returns { ok, missing: [y], ladders, backing, why }. Cell baseY itself needs nothing: the bot is in it, on the ground (and the next cell is a jump away) or on a rung.
function plan({ cells, baseY, have = {} }) {
  const from = baseY + 1                    // the bot stands (or hangs) in cell baseY; from the ground the next cell is a jump away
  const missing = [], backing = []
  for (const c of cells) {
    if (c.y < from) continue
    if (c.kind === 'blocked') return { ok: false, why: `something solid is in the column at y${c.y}`, missing, ladders: missing.length, backing: backing.length }
    if (c.kind === 'free') missing.push(c.y)
    else if (c.kind === 'nowall') { missing.push(c.y); backing.push(c.y) }
  }
  const out = { ok: true, missing, backing, ladders: missing.length, blocks: backing.length, total: missing.length + backing.length }
  const haveLadders = have.ladder || 0, haveBlocks = have.blocks || 0
  if (haveLadders < out.ladders) { out.ok = false; out.why = `needs ${out.ladders} ladders, has ${haveLadders}` }
  else if (haveBlocks < out.blocks) { out.ok = false; out.why = `needs ${out.blocks} backing blocks, has ${haveBlocks}` }
  return out
}

class LadderWork {
  // goto(goal) -> Promise<{ok}> walks (the navigator's plain attempt); goals: the pathfinder goals module
  constructor({ bot, goals, goto = null, log = () => {}, isAborted = () => false }) {
    Object.assign(this, { bot, goals, goto, log, isAborted })
    this.stats = { runs: 0, ladders: 0, backing: 0, failures: 0 }
  }

  at(x, y, z) { return this.bot.blockAt(new Vec3(x, y, z)) }
  count(name) { return this.bot.inventory.items().filter(i => i.name === name).reduce((s, i) => s + i.count, 0) }
  backingItem() { return this.bot.inventory.items().find(i => BACKING.includes(i.name) && i.count > 0) || null }
  backingCount() { return this.bot.inventory.items().filter(i => BACKING.includes(i.name)).reduce((s, i) => s + i.count, 0) }

  // ---- reading the column ----
  // The ladder column nearest to `goal` (a standing cell): { x, z, facing, lowest, highest } | null. Only columns within `radius` blocks sideways, with their
  // lowest rung below the goal.
  findColumn(goal, radius = 3.2) {
    const bot = this.bot
    const ids = bot.registry.blocksByName.ladder.id
    const found = bot.findBlocks({ matching: ids, maxDistance: 64, count: 400 }) || []
    const cols = new Map()
    for (const p of found) {
      const k = p.x + ',' + p.z
      const c = cols.get(k) || { x: p.x, z: p.z, lowest: Infinity, highest: -Infinity, facing: null }
      c.lowest = Math.min(c.lowest, p.y); c.highest = Math.max(c.highest, p.y)
      if (p.y === c.lowest) { const b = this.at(p.x, p.y, p.z); c.facing = b && b.getProperties().facing }
      cols.set(k, c)
    }
    let best = null
    for (const c of cols.values()) {
      const d = Math.hypot(c.x + 0.5 - (goal.x + 0.5), c.z + 0.5 - (goal.z + 0.5))
      if (d > radius || c.lowest >= goal.y) continue
      if (!best || d < best.d) best = { ...c, d }
    }
    return best
  }

  // y of the first standing level at or below `fromY` in the column (the block under the column cell is solid)
  footY(x, z, fromY) {
    for (let y = fromY; y > fromY - 40; y--) { const under = this.at(x, y - 1, z); if (!under) return null; if (fullSolid(under) || under.boundingBox === 'block') return y }
    return null
  }

  readColumn(col, baseY, exitY) {
    const [wx, wz] = this.wallOf(col)
    const cells = []
    for (let y = baseY; y < exitY; y++) {
      const b = this.at(col.x, y, col.z)
      if (!b) return { ok: false, why: `y${y} of the column is not loaded` }
      let kind
      if (b.name === 'ladder') kind = 'ladder'
      else if (!isAir(b)) kind = 'blocked'
      else kind = fullSolid(this.at(col.x + wx, y, col.z + wz)) ? 'free' : 'nowall'
      cells.push({ y, kind })
    }
    return { ok: true, cells }
  }
  // direction from the column cell to the wall its ladders hang on (the ladder faces away from it)
  wallOf(col) { const f = DIRS[col.facing]; return f ? [-f[0], -f[1]] : [0, -1] }

  // ---- doing it ----
  // Climb and complete the column to `exitY` (the standing level of the top; feet end up in the column cell exitY - 1, then step to `goal`).
  async completeUp(col, exitY, goal, { baseY = null } = {}) {
    this.stats.runs++
    const bot = this.bot
    const fail = (why, extra = {}) => { this.stats.failures++; this.log(`ladders: ${why}`); this.release(); return { ok: false, why, ...extra } }
    const p = bot.entity.position
    const inColumn = Math.floor(p.x) === col.x && Math.floor(p.z) === col.z
    if (baseY === null) baseY = inColumn ? Math.floor(p.y + 1e-3) : (this.footY(col.x, col.z, col.lowest) ?? col.lowest)
    const rc = this.readColumn(col, baseY, exitY)
    if (!rc.ok) return fail(rc.why)
    const pl = plan({ cells: rc.cells, baseY, have: { ladder: this.count('ladder'), blocks: this.backingCount() } })
    this.log(`ladders: column ${col.x},${col.z} base y${baseY} exit y${exitY}: ${pl.ladders} ladders + ${pl.blocks} backing blocks needed`)
    if (!pl.ok) return fail(pl.why, { plan: pl })
    // get into the column foot cell facing the wall
    if (!inColumn) {
      if (!this.goto) return fail('not in the column and no way to walk there')
      const r = await this.goto(new this.goals.GoalBlock(col.x, baseY, col.z))
      if (!r.ok) return fail('could not get to the foot of the ladder: ' + r.err)
    }
    try {
      for (const y of pl.missing) {
        if (this.isAborted()) return fail('aborted')
        // stand in the cell below (on the rung, sneaking) or on the ground in the foot cell
        if (!(await this.riseTo(col, y - 1, baseY))) return fail(`could not climb to y${y - 1}`)
        if (pl.backing.includes(y)) { const r = await this.placeBacking(col, y); if (!r.ok) return fail(`backing at y${y}: ${r.why}`) }
        const r = await this.placeLadder(col, y)
        if (!r.ok) return fail(`ladder at y${y}: ${r.why}`)
      }
      if (!(await this.riseTo(col, exitY - 1, baseY))) return fail(`could not climb to y${exitY - 1}`)
    } catch (e) { return fail('error: ' + (e && e.message || e)) }
    // step off
    this.release()
    if (goal) {
      const r = this.goto ? await this.goto(new this.goals.GoalBlock(goal.x, goal.y, goal.z)) : await this.stepOff(goal)
      if (!r.ok) return fail('stepping off at the top failed: ' + r.err)
    }
    return { ok: true, plan: pl }
  }

  // Climb an existing (complete) column by hand: for a start the pathfinder will not plan (the first rung one block above the floor).
  async climb(col, toY) {
    const bot = this.bot
    const ok = await this.riseTo(col, toY, null)
    this.release()
    return { ok }
  }

  release() { try { this.bot.clearControlStates() } catch { /* ignore */ } }

  // Get the feet into column cell `cellY` and hold still there. From the ground: jump + forward into the wall until the rung is grabbed.
  async riseTo(col, cellY, baseY) {
    const bot = this.bot
    const [wx, wz] = this.wallOf(col)
    const cx = col.x + 0.5, cz = col.z + 0.5
    await this.faceWall(col, cellY)
    let stalled = 0, lastY = bot.entity.position.y
    for (let i = 0; i < 700; i++) {
      const p = bot.entity.position
      if (Math.floor(p.x) !== col.x || Math.floor(p.z) !== col.z) {
        // drifted out of the column sideways (a jump from the ground, a bump): press back to the middle of the cell, towards the wall
        bot.clearControlStates()
        await this.steerTo(cx + wx * 0.2, cz + wz * 0.2, 12)
        if (Math.floor(bot.entity.position.x) !== col.x || Math.floor(bot.entity.position.z) !== col.z) return false
        continue
      }
      if (p.y >= cellY - 1e-6 && Math.floor(p.y + 1e-3) >= cellY) {
        // in the cell: hold still on the rung (sneak), no other key
        bot.clearControlStates(); bot.setControlState('sneak', true)
        await waitTicks(bot, 2)
        return Math.floor(bot.entity.position.y + 1e-3) >= cellY
      }
      const here = this.at(col.x, Math.floor(p.y + 1e-3), col.z)
      const onRung = here && here.name === 'ladder'
      bot.setControlState('sneak', false)
      bot.setControlState('forward', true)              // into the plate: that alone climbs; pressing against the wall keeps the bot in the column
      bot.setControlState('sprint', false)
      bot.setControlState('jump', true)                 // from the ground this is the jump onto the first rung; on a rung it is the climb key
      await tick(bot)
      const y = bot.entity.position.y
      if (y > lastY + 0.02 || onRung) { stalled = 0; lastY = Math.max(lastY, y) } else if (++stalled > 40) { bot.clearControlStates(); return false }
    }
    bot.clearControlStates()
    return false
  }

  // look at the middle of the wall block behind the column cell at `cellY`
  async faceWall(col, cellY) {
    const [wx, wz] = this.wallOf(col)
    try { await this.bot.lookAt(new Vec3(col.x + 0.5 + wx * 0.5, cellY + 0.5, col.z + 0.5 + wz * 0.5), true) } catch { /* ignore */ }
  }

  async steerTo(x, z, ticks) {
    const bot = this.bot
    for (let i = 0; i < ticks; i++) {
      const p = bot.entity.position
      const dx = x - p.x, dz = z - p.z
      if (Math.hypot(dx, dz) < 0.12) break
      bot.entity.yaw = Math.atan2(-dx, -dz)
      bot.setControlState('forward', true)
      await tick(bot)
    }
    bot.clearControlStates()
  }

  async equipItem(name) {
    const bot = this.bot
    const it = bot.inventory.items().find(i => i.name === name && i.count > 0)
    if (!it) return false
    if (!bot.heldItem || bot.heldItem.name !== name) await bot.equip(it, 'hand')
    return true
  }

  // a ladder into column cell y, against the wall block behind it (the bot stands in the cell below, sneaking on its rung)
  async placeLadder(col, y) {
    const [wx, wz] = this.wallOf(col)
    const wall = this.at(col.x + wx, y, col.z + wz)
    if (!wall) return { ok: false, why: 'wall not loaded' }
    if (!(await this.equipItem('ladder'))) return { ok: false, why: 'no ladders' }
    await this.faceWallAt(wall, new Vec3(-wx, 0, -wz))
    try { await this.bot.placeBlock(wall, new Vec3(-wx, 0, -wz)) } catch (e) { return { ok: false, why: e.message } }
    await waitTicks(this.bot, 2)
    const b = this.at(col.x, y, col.z)
    if (!b || b.name !== 'ladder') return { ok: false, why: 'the server did not keep the ladder' }
    this.stats.ladders++
    return { ok: true }
  }

  // the wall cell behind column cell y is open: put a block there, on top of the wall block below it (or against the block behind it)
  async placeBacking(col, y) {
    const [wx, wz] = this.wallOf(col)
    const W = new Vec3(col.x + wx, y, col.z + wz)
    const refs = [[this.at(W.x, y - 1, W.z), new Vec3(0, 1, 0)], [this.at(W.x + wx, y, W.z + wz), new Vec3(-wx, 0, -wz)], [this.at(W.x - wz, y, W.z + wx), new Vec3(wz, 0, -wx)], [this.at(W.x + wz, y, W.z - wx), new Vec3(-wz, 0, wx)]]
    const item = this.backingItem()
    if (!item) return { ok: false, why: 'no backing block' }
    for (const [ref, face] of refs) {
      if (!ref || !fullSolid(ref)) continue
      await this.bot.equip(item, 'hand')
      await this.faceWallAt(ref, face)
      try { await this.bot.placeBlock(ref, face) } catch (e) { this.log(`ladders: backing refused (${e.message})`); continue }
      await waitTicks(this.bot, 2)
      this.stats.backing++
      return { ok: true }
    }
    return { ok: false, why: 'nothing to put the backing block against' }
  }

  async faceWallAt(ref, face) {
    try { await this.bot.lookAt(ref.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5), true) } catch { /* ignore */ }
    await waitTicks(this.bot, 1)
  }

  // no navigator: face the goal and walk/jump onto it
  async stepOff(goal) {
    const bot = this.bot
    bot.clearControlStates()
    for (let i = 0; i < 80; i++) {
      const p = bot.entity.position
      const dx = goal.x + 0.5 - p.x, dz = goal.z + 0.5 - p.z
      if (Math.hypot(dx, dz) < 0.35 && Math.abs(p.y - goal.y) < 0.6) { bot.clearControlStates(); return { ok: true } }
      bot.entity.yaw = Math.atan2(-dx, -dz)
      bot.setControlState('forward', true); bot.setControlState('jump', p.y < goal.y + 0.1)
      await tick(bot)
    }
    bot.clearControlStates()
    return { ok: false, err: 'could not step off' }
  }
}

module.exports = { LadderWork, plan, BACKING, fullSolid, isAir }
