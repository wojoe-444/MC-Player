// The excavation job: carves the open rectangle at y136-137 up to 6 blocks tall (dig y138-141), one 3x3 section at a time.
//
// Written to run as a scheduler task (brain/scheduler.js): ctx.checkpoint() between every atomic step so it yields to anything
// more important, progress saved after each section so a pause/preempt/restart resumes where it stopped.
//
// Hard rules (see brain/INTERFACE.md and Walter's notes):
//  - only natural filler is dug, only inside the room volume, never at y >= hallMinY (the stone-brick hall starts at y151);
//  - nothing is dug next to water or lava (checked again right before every dig), nothing is ever placed;
//  - items must not pile up: more than maxGroundItems within itemRadius blocks pauses the job and tells Walter;
//  - full inventory: spare cobblestone goes to the station input chests, never onto the ground;
//  - the job never starts or resumes itself without Walter's go (see index.js).
const { Vec3 } = require('vec3')
const util = require('../util')
const plan = require('./plan')
const makeMover = require('./move')
const makeTools = require('./tools')
const makeDumper = require('./dump')
const makeLos = require('./los')
const makePillar = require('./pillar')
const makeWorksite = require('./worksite')
let smelt = null
try { smelt = require('../smeltables') } catch {}

const HOSTILE = /^(zombie|skeleton|creeper|spider|cave_spider|husk|drowned|witch|pillager|vindicator|phantom|slime|silverfish|enderman|zombie_villager|stray|bogged|breeze)$/
const isItem = (e) => !!e && (e.name === 'item' || e.displayName === 'Item')   // not e.objectType: deprecated getter that logs a stack trace on every call
const DEFAULT_LIMITS = { maxGroundItems: 30, itemRadius: 24, reserveCobble: 48, fullSlots: 6, minFreeSlots: 3, minHealth: 8, hostileRadius: 6, minPickaxeUses: 60, dangerRetries: 6, dangerRetryMs: 20000, chestRetryMs: 600000, loadWaitMs: 15000, loadRetries: 3, loadRetryMs: 20000 }

// Thrown inside the job to stop it cleanly: kind 'park' = needs Walter, 'retry' = try again shortly.
class Pause extends Error {
  constructor(kind, reason, afterMs) { super(reason || kind); this.kind = kind; this.reason = reason; this.afterMs = afterMs }
}

module.exports = function createEngine({ bot, say, goals, tryGoto, safehand, stopNav = () => {}, config, state, save, inputs = [], canSee = null, depositSmeltables = null, craft = null, getCrafting = null, now = Date.now, log = () => {} }) {
  const L = { ...DEFAULT_LIMITS, ...(config.limits || {}) }
  const geo = plan.makeGeometry(config)
  const mover = makeMover({ bot, goals, tryGoto, safehand, stopNav })
  const tools = makeTools({ bot, goals, mover, limits: L, craft, getCrafting, say, log })
  const los = makeLos({ bot, goals, mover, canSee, log })     // Walter's survival-legit rule: a clear line to every block we break or chest we open
  const bands = geo.bands
  const pillar = makePillar({ bot, goals, mover, los, state, save, equipBest: tools.equipBest, dig: tools.dig, aim: (config.pillar && config.pillar.aimOffset) || 0, floorY: geo.floorY, maxBlocks: Math.min((config.pillar && config.pillar.blocks) || 4, 4), danger: () => danger(), stepMs: (config.pillar && config.pillar.stepMs) || 30, landMs: (config.pillar && config.pillar.landMs) || 120, log })
  const dumper = makeDumper({ bot, mover, say, limits: L, inputs, now, log, los, depositSmeltables })

  // ---------- work-site chest (Walter's time-economy rule): stash next to the work, haul once at the end ----------
  const WS = config.worksite || {}
  const STASH = /^(cobblestone|cobbled_deepslate|stone|dirt|coarse_dirt|grass_block|rooted_dirt|podzol|mud|clay|clay_ball|gravel|sand|red_sand|flint|andesite|diorite|granite|deepslate|tuff|calcite|dripstone_block|moss_block|smooth_basalt|basalt|amethyst_block|coal|raw_iron|raw_copper|raw_gold|redstone|lapis_lazuli|diamond|emerald|quartz|amethyst_shard)$|_ore$/
  const KEEP_CAP = { cobblestone: L.reserveCobble, coal: 16 }                 // the pillar and pickaxes need cobblestone, torches need coal
  const stashList = () => {
    const tot = {}
    for (const i of bot.inventory.items()) tot[i.name] = (tot[i.name] || 0) + i.count
    return Object.entries(tot).filter(([n]) => STASH.test(n)).map(([name, count]) => ({ name, count: count - (KEEP_CAP[name] || 0) })).filter(t => t.count > 0)
  }
  const forwardable = (items) => smelt ? smelt.plan(items, { reserveCobble: 0, keepFood: 0, keepLogs: 0, keepSeeds: 0 }) : items.filter(i => i.name === 'cobblestone')
  const workCols = () => { const w = state.worksite; return w ? new Set([`${w.pos[0]},${w.pos[2]}`]) : new Set() }
  // an edge column of the room next to the entry, against the wall, with a free cell beside it to stand in
  function worksiteSpot() {
    if (WS.enabled === false) return null
    const W = WS.cell || [geo.box.x1, geo.floorY, config.entry[2]]
    const free = (x, y, z) => { const a = bot.blockAt(new Vec3(x, y, z)), b = bot.blockAt(new Vec3(x, y + 1, z)), f = bot.blockAt(new Vec3(x, y - 1, z)); return !!(a && b && f && a.boundingBox === 'empty' && b.boundingBox === 'empty' && !plan.isLiquid(a) && f.boundingBox !== 'empty' && !plan.isLiquid(f)) }
    const wall = (x, y, z) => { const w = bot.blockAt(new Vec3(x, y, z)); return !!(w && w.boundingBox !== 'empty' && !plan.isLiquid(w)) }
    const dx = W[0] === geo.box.x2 ? -1 : 1                                   // the room lies on this side of the chosen edge
    for (let d = 0; d <= (WS.search || 25); d++) for (const dz of d ? [d, -d] : [0]) {
      const z = W[2] + dz
      if (z < geo.box.z1 || z > geo.box.z2) continue
      if (free(W[0], geo.floorY, z) && free(W[0] + dx, geo.floorY, z) && wall(W[0] - dx, geo.floorY, z) && wall(W[0] - dx, geo.floorY + 1, z)) return { cell: new Vec3(W[0], geo.floorY, z), stand: new Vec3(W[0] + dx, geo.floorY, z) }
    }
    return null
  }
  const ws = makeWorksite({
    bot, goals, mover, los, say, state, save, now, log, equipBest: tools.equipBest, label: 'the work-site chest',
    chooseSpot: worksiteSpot, stashList, forwardable,
    forward: (ctx) => dumper.dump(ctx, { force: true }),
    craftChest: (ctx) => tools.craftVia(ctx, 'craft chest', () => bot.inventory.items().some(i => i.name === 'chest'), 'a work-site chest')
  })
  const FURNACES_FULL = 'The furnace input chests are full or out of reach, so I cannot empty my inventory. I will not leave items on the ground; tell me where to put things.'
  // Empties the bag: into the work-site chest when there is (or can be) one, otherwise the old way (straight to the furnace chests).
  async function unload(ctx) {
    if (WS.enabled !== false) {
      let r = await ws.stash(ctx)
      if (r.ok && r.full) { const h = await ws.haul(ctx, { quiet: true }); if (h.full) throw new Pause('park', FURNACES_FULL); r = await ws.stash(ctx) }
      if (r.ok && !r.full) {
        if (ws.nearlyFull()) { const h = await ws.haul(ctx, { quiet: true }); if (h.full) throw new Pause('park', FURNACES_FULL) }
        return { full: false, viaWorksite: true }
      }
    }
    return dumper.dump(ctx)
  }
  let running = false
  let last = null
  const note = (msg) => { last = { at: now(), msg }; log(msg) }
  // counts skipped blocks per reason, each block once per job (sweeps and resumed sections look at the same blocks again)
  let skipSeen = new Set()
  const skip = (why, key) => {
    if (key !== undefined) { const k = `${why}|${key}`; if (skipSeen.has(k)) return; skipSeen.add(k) }
    state.skipped[why] = (state.skipped[why] || 0) + 1
  }
  const doneSet = () => new Set(state.done)

  // ---------- world questions ----------
  const groundItems = () => {
    const me = bot.entity.position
    return Object.values(bot.entities || {}).filter(e => isItem(e) && e.position.distanceTo(me) < L.itemRadius).length
  }
  function danger() {
    if (bot.health < L.minHealth) return `my health is ${Math.round(bot.health)}/20`
    const m = bot.nearestEntity && bot.nearestEntity(e => HOSTILE.test(e.name || '') && e.position.distanceTo(bot.entity.position) < L.hostileRadius)
    return m ? `a ${m.name} is near` : null
  }
  function dangerCheck(ctx) {
    const d = danger()
    if (!d) { ctx.state.dangerRetries = 0; return }
    ctx.state.dangerRetries = (ctx.state.dangerRetries || 0) + 1
    if (ctx.state.dangerRetries === 1) say(`Pausing the dig: ${d}. I will carry on when it is clear.`)
    if (ctx.state.dangerRetries > L.dangerRetries) throw new Pause('park', `Pausing the excavation: ${d}.`)
    throw new Pause('retry', null, L.dangerRetryMs)
  }

  // ---------- inventory ----------
  // Enough free slots to keep digging? Dumps spare cobblestone into the input chests when the inventory gets full.
  async function makeRoom(ctx) {
    if (bot.inventory.emptySlotCount() > L.fullSlots) return
    const r = await unload(ctx)
    if (r.full) throw new Pause('park', FURNACES_FULL)
    if (bot.inventory.emptySlotCount() > L.minFreeSlots) return
    throw new Pause('park', 'My inventory is nearly full and I could not empty it (the input chests are full or out of reach, or it is full of things other than cobblestone). I will not leave items on the ground; tell me where to put things.')
  }

  async function collectDrops(ctx) {
    for (let i = 0; i < 8; i++) {
      ctx.checkpoint()
      if (bot.inventory.emptySlotCount() < 2) return
      const item = bot.nearestEntity(e => isItem(e) && e.position.distanceTo(bot.entity.position) < 10 && e.position.y > geo.floorY - 2)
      if (!item) return
      await mover.goto(ctx, new goals.GoalNear(item.position.x, item.position.y, item.position.z, 0.8), 'a drop', 4000)
    }
  }

  // Walter: do not let items pile up on the ground. Try to pick them up; if the pile stays, stop and tell him.
  async function ensurePileOk(ctx) {
    let n = groundItems()
    if (n <= L.maxGroundItems) return
    if (bot.inventory.emptySlotCount() <= L.fullSlots) { const u = await unload(ctx); if (u.full) throw new Pause('park', FURNACES_FULL) }
    for (let pass = 0; pass < 3 && n > L.maxGroundItems; pass++) { await collectDrops(ctx); n = groundItems() }
    if (n > L.maxGroundItems) throw new Pause('park', `Pausing: ${n} items are lying on the ground near me and I can't pick them up (inventory nearly full?). I'd rather not leave a pile. Tell me where to put things.`)
  }

  // ---------- digging ----------
  async function digCell(ctx, x, y, z, { noMove = false } = {}) {
    const key = `${x},${y},${z}`
    const at = new Vec3(x, y, z)   // real mineflayer blockAt/dig need a Vec3 (pos.floored)
    let chk = plan.checkCell(bot, x, y, z, geo)
    if (!chk.ok) { if (!chk.quiet) skip(chk.why, key); return false }
    let b = bot.blockAt(at)
    if (noMove && (!bot.canDigBlock(b) || !los.canSee(b))) { skip(!bot.canDigBlock(b) ? 'out-of-reach' : 'no-line-of-sight', key); return false }     // up on the pillar: never walk off it
    if (!bot.canDigBlock(b) || !los.canSee(b)) {
      // too far, or something solid in the way (we only dig what we can see): step into this column, under the block, and look again
      if (!workCols().has(`${x},${z}`)) await mover.goto(ctx, new goals.GoalBlock(x, geo.floorY, z), `column ${x},${z}`, 15000)
      chk = plan.checkCell(bot, x, y, z, geo)
      if (!chk.ok) { if (!chk.quiet) skip(chk.why, key); return false }
      b = bot.blockAt(at)
      if (!bot.canDigBlock(b)) { skip('out-of-reach', key); return false }
      if (!los.canSee(b)) { skip('no-line-of-sight', key); return false }
    }
    if (!(await tools.equipBest(b))) {
      const r = await tools.restock(ctx)
      if (!r.ok) throw new Pause('park', `${r.reason} Pausing the excavation.`)
      if (!(await tools.equipBest(b))) throw new Pause('park', 'I have no usable pickaxe. Pausing the excavation.')
    }
    ctx.checkpoint()
    chk = plan.checkCell(bot, x, y, z, geo)       // the world may have changed while walking / crafting
    if (!chk.ok) { if (!chk.quiet) skip(chk.why, key); return false }
    b = bot.blockAt(at)
    if (!los.canSee(b)) { skip('no-line-of-sight', key); return false }
    try { await tools.dig(b, { why: noMove ? 'from the pillar' : '' }) }
    catch (e) { ctx.checkpoint(); skip('dig-error', key); log(`dig error ${x},${y},${z}: ${e.message}`); return false }
    state.dug++
    return true
  }

  const membersOf = (g) => g.members.filter(c => { if (plan.columnHasGravity(bot, c.x, c.z, geo)) { skip('gravity-column', `${c.x},${c.z}`); return false } return true })
  const cellsLeft = (g, band) => {
    const out = []
    for (const c of g.members) {
      if (plan.columnHasGravity(bot, c.x, c.z, geo)) continue
      for (let y = band.from; y <= band.to; y++) if (plan.checkCell(bot, c.x, y, c.z, geo).ok) out.push(`${c.x},${y},${c.z}`)
    }
    return out
  }

  // Floor access: one 3x3 section from its standing spot. false = could not reach it.
  async function doFloor(ctx, g, band) {
    const r = await mover.goto(ctx, new goals.GoalBlock(g.stand.x, geo.floorY, g.stand.z), `section ${g.id}`, 30000)
    if (!r.ok) { log(`unreachable ${g.id}: ${r.err}`); return false }
    // Layer by layer, bottom up: every block is exposed from below once the layer under it is gone, so each one is in plain view
    // from the standing spot (anything that is not is reached by stepping into its column, see digCell).
    const members = membersOf(g)
    for (let y = band.from; y <= band.to; y++) {
      for (const c of members) {
        ctx.checkpoint()
        dangerCheck(ctx)
        await digCell(ctx, c.x, y, c.z)
        if (groundItems() > L.maxGroundItems) await ensurePileOk(ctx)
      }
    }
    await collectDrops(ctx)
    return true
  }

  // A column of the section that is open from the floor to the pillar top plus head room (so the bot can stand and jump in it), nearest the middle first.
  function pillarColumn(g, feetY) {
    const cx = g.stand.x, cz = g.stand.z
    const ok = (c) => { for (let y = geo.floorY; y <= feetY + 2; y++) { const b = bot.blockAt(new Vec3(c.x, y, c.z)); if (!b || b.boundingBox !== 'empty' || plan.isLiquid(b)) return false } return true }
    const avoid = workCols()
    return g.members.filter(c => !avoid.has(`${c.x},${c.z}`)).sort((a, b) => Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz)).find(ok) || null
  }

  // Pillar access (y143 and up are out of reach from the floor): build a temporary cobblestone pillar in an already dug column, dig the layers from its
  // top, take it down again (always, also when stopped or in danger). false = could not reach the section.
  async function doPillar(ctx, g, band) {
    const blocks = Math.min(((config.pillar && config.pillar.blocks) || 4), 4)
    const feetY = geo.floorY + blocks
    const col = pillarColumn(g, feetY)
    if (!col) { skip('pillar-blocked', g.id); return true }
    if (cobbleCount() < ((config.pillar && config.pillar.minCobble) || blocks + 2)) { skip('no-cobble-for-pillar', g.id); return true }
    const r = await mover.goto(ctx, new goals.GoalBlock(col.x, geo.floorY, col.z), `pillar ${g.id}`, 30000)
    if (!r.ok) { log(`unreachable ${g.id}: ${r.err}`); return false }
    const members = membersOf(g)
    let built
    try {
      built = await pillar.build(ctx, col, blocks)
      if (!built.ok) { skip('pillar-failed', g.id); note(`pillar ${g.id}: ${built.why}`) }
      else {
        for (let y = band.from; y <= band.to; y++) {
          for (const c of members) {
            ctx.checkpoint()
            dangerCheck(ctx)
            await digCell(ctx, c.x, y, c.z, { noMove: true })
          }
        }
      }
    } finally {
      await pillar.dismantle(ctx)               // down again: also after an abort or when a hostile showed up
    }
    await collectDrops(ctx)
    return true
  }
  const cobbleCount = () => bot.inventory.items().filter(i => i.name === 'cobblestone').reduce((n, i) => n + i.count, 0)

  const bandDone = (band, id) => state[band.key].includes(id)
  const markBand = (band, id) => { if (!bandDone(band, id)) state[band.key].push(id) }
  const sectionComplete = (g) => bands.every(b => bandDone(b, g.id))

  // All layer bands of one section, bottom up. A band with nothing left to dig is simply done (no walking, no pillar).
  // sweep = ignore the done sets and look at what is really left. false = could not reach the section.
  async function runBands(ctx, g, sweep = false) {
    for (const band of bands) {
      if (!sweep && bandDone(band, g.id)) continue
      if (!cellsLeft(g, band).length) { markBand(band, g.id); continue }
      const ok = band.access === 'pillar' ? await doPillar(ctx, g, band) : await doFloor(ctx, g, band)
      if (ok === false) return false
      markBand(band, g.id); save()
    }
    return true
  }

  // ---------- planning ----------
  const skippedText = () => Object.entries(state.skipped).map(([k, v]) => `${v} ${k}`).join(', ')
  // What the world looks like right now. `complete` = every column of the room box could be looked at (no unloaded chunk) and the room is there.
  function scan() {
    const chestCols = workCols()
    const { cols, unloaded } = plan.scanColumns(bot, geo, { chestCols })
    const groups = plan.groupsOf(cols, geo, { avoid: chestCols })
    return { cols, groups, unloaded, complete: unloaded === 0 && cols.length > 0, left: groups.filter(g => !sectionComplete(g)), doneCount: groups.filter(sectionComplete).length }
  }
  // Blocks that could still be dug right now (natural, in the volume, not next to liquid, not in a sand/gravel column). The only honest test for "finished".
  function remainingCells(groups) {
    const out = []
    for (const g of groups) for (const c of g.members) {
      if (plan.columnHasGravity(bot, c.x, c.z, geo)) continue
      for (let y = geo.digFrom; y <= geo.digTo; y++) if (plan.checkCell(bot, c.x, y, c.z, geo).ok) out.push(`${c.x},${y},${c.z}`)
    }
    return out
  }
  let verifyCache = null
  function verify(fresh = false) {
    if (!fresh && verifyCache && now() - verifyCache.at < 60000) return verifyCache
    const s = scan()
    if (!s.complete) verifyCache = { at: now(), visible: false, unloaded: s.unloaded }
    else { const cells = remainingCells(s.groups); verifyCache = { at: now(), visible: true, total: s.groups.length, doneCount: s.doneCount, leftSections: s.left.length, leftCells: cells.length, sample: cells.slice(0, 3) } }
    return verifyCache
  }
  function describePlan() {
    const s = scan()
    if (!s.complete) return `I can only see part of the room from here (${s.unloaded} columns not loaded). Say "excavate" and I will walk there first.`
    const { tally, hazards } = plan.prescan(bot, s.cols, geo)
    const top = Object.entries(tally).filter(([n]) => n !== 'air').sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, c]) => `${c} ${n}`).join(', ')
    const blocks = Object.entries(tally).filter(([n]) => n !== 'air' && n !== 'cave_air').reduce((a, [, c]) => a + c, 0)
    return `Excavation plan: ${s.left.length} of ${s.groups.length} sections left (${s.doneCount} done), dig y${geo.digFrom}-${geo.digTo} (about ${blocks} blocks: ${top}). Will skip ${hazards.liquidAdjacent} next to liquid, ${hazards.gravityColumns} sand/gravel columns, ${hazards.unknownBlocks} non-natural blocks.`
  }
  // Status looks at the world, not at the saved flag: the flag has been wrong before (a partial view of the room right after a restart).
  function statusLine() {
    if (running) {
      const s = scan(); const total = s.complete ? s.groups.length : state.total
      return `Excavating: ${state.done.length}/${total || '?'} sections done, ${state.dug} blocks dug.`
    }
    const v = verify(true)
    if (v.visible) {
      if (v.leftCells === 0) {
        if (!state.finished) { state.finished = true; state.finishedAt = new Date(now()).toISOString(); save() }
        return `The room is carved: ${state.dug} blocks dug${skippedText() ? '. Skipped: ' + skippedText() : ''}.`
      }
      if (state.finished) { state.finished = false; save() }
      const base = `Not running. ${v.doneCount}/${v.total} sections done, ${state.dug} blocks dug, ${v.leftCells} block(s) still uncut.`
      if (state.pauseReason) return `${base} Paused: ${state.pauseReason} Say "resume excavation" to continue.`
      return `${base} ${state.active ? 'Say "resume excavation" to continue.' : 'Waiting for your go (say "excavate").'}`
    }
    const base = `Not running. ${state.done.length}/${state.total || '?'} sections done, ${state.dug} blocks dug (I cannot see the whole room from here, so this is from my notes).`
    if (state.pauseReason) return `${base} Paused: ${state.pauseReason} Say "resume excavation" to continue.`
    return `${base} ${state.finished ? 'My notes say it is finished.' : 'Waiting for your go (say "excavate").'}`
  }
  function snapshot() {
    const v = running ? null : verify(false)
    const stale = !!(v && v.visible && v.leftCells > 0)
    return {
      running, active: !!state.active, finished: !!state.finished && !stale, sectionsDone: state.done.length, bandsDone: Object.fromEntries(bands.map(b => [b.id, state[b.key].length])), height: geo.digTo - geo.floorY + 1, sectionsTotal: state.total, dug: state.dug,
      uncutBlocks: v && v.visible ? v.leftCells : null, skipped: { ...state.skipped }, unreachable: [...(state.unreachable || [])], pauseReason: state.pauseReason, startedAt: state.startedAt,
      updatedAt: state.updatedAt, importedFrom: state.importedFrom, last: last && { agoS: Math.round((now() - last.at) / 1000), msg: last.msg },
      worksite: ws.snapshot(), digStats: { ...tools.stats }, limits: { maxGroundItems: L.maxGroundItems, itemRadius: L.itemRadius, digFrom: geo.digFrom, digTo: geo.digTo, hallMinY: geo.hallMinY }
    }
  }

  // A scan of the whole room. Right after a restart only the chunks around the bot are loaded, so a partial scan is waited out (chunks stream in),
  // then we walk into the room; if part of it still cannot be seen we retry later and finally pause: never carry on with half a room.
  async function loadedScan(ctx) {
    let s = scan()
    const t0 = now()
    while (!s.complete && now() - t0 < L.loadWaitMs) { await ctx.sleep(1000); s = scan() }
    if (!s.complete) {
      const e = config.entry
      await mover.goto(ctx, new goals.GoalBlock(e[0], e[1], e[2]), 'the room', 90000)
      await ctx.sleep(1500)
      s = scan()
    }
    if (!s.complete) {
      ctx.state.loadRetries = (ctx.state.loadRetries || 0) + 1
      if (ctx.state.loadRetries > L.loadRetries) throw new Pause('park', s.cols.length ? `Only part of the room is loaded (${s.unloaded} columns I cannot see), so I will not guess what is left.` : 'I cannot find the room footprint from here. Make sure the room is loaded (floor y136).')
      throw new Pause('retry', null, L.loadRetryMs)
    }
    ctx.state.loadRetries = 0
    return s
  }

  // ---------- the job ----------
  async function job(ctx) {
    skipSeen = new Set()
    if (util.dimOf(bot) !== 'overworld') return { status: 'retry', afterMs: 120000 }
    await safehand.stow()
    const first0 = await loadedScan(ctx)
    const all = first0.groups
    state.total = all.length
    const first = !ctx.resumed
    if (first) {
      if (!state.startedAt) {
        state.startedAt = new Date(now()).toISOString()
        say(describePlan().slice(0, 230))
        note(`START ${describePlan()}`)
      } else say(`Resuming the excavation (${geo.digTo - geo.floorY + 1} blocks tall): ${all.filter(sectionComplete).length}/${all.length} sections done.`)
    }
    state.active = true; state.pauseReason = null; state.finished = false; save()
    if (state.pillar) { note('removing a pillar left from an earlier run'); await pillar.dismantle(ctx) }
    const total = all.length
    let queue = all.filter(g => !sectionComplete(g)), pass = 0, sinceReport = 0
    let doneCount = all.length - queue.length
    ctx.progress(`${doneCount}/${total} sections`)
    await ensurePileOk(ctx)
    while (queue.length) {
      const retry = []
      for (const g of queue) {
        ctx.checkpoint()
        dangerCheck(ctx)
        const t = await tools.restock(ctx)
        if (!t.ok) throw new Pause('park', `${t.reason} Pausing the excavation.`)
        await makeRoom(ctx)
        if (!(await runBands(ctx, g))) { retry.push(g); continue }
        doneCount++
        save()
        ctx.progress(`${doneCount}/${total} sections`)
        if (++sinceReport % 10 === 0) say(`Progress: ${doneCount}/${total} sections, ${state.dug} blocks dug.`)
        await ensurePileOk(ctx)
      }
      if (!retry.length || pass >= 1) { state.unreachable = retry.map(g => g.id); break }
      queue = retry; pass++
    }
    if (!queue.length) state.unreachable = []
    // Verification sweeps: "the queue is empty" is not "the room is done". Look at the world again (whole room, all chunks) and dig whatever
    // can still be dug (a block skipped earlier, one that only became visible later, one the section missed after a pause).
    for (let sweep = 0; sweep < 2; sweep++) {
      const s = await loadedScan(ctx)
      const need = s.groups.filter(g => remainingCells([g]).length)
      if (!need.length) break
      note(`SWEEP ${sweep + 1}: ${need.length} section(s) still have diggable blocks`)
      for (const g of need) {
        ctx.checkpoint(); dangerCheck(ctx)
        await makeRoom(ctx)
        await runBands(ctx, g, true)
        await ensurePileOk(ctx)
      }
    }
    // the job's work is over: one haul of the work-site chest to the furnaces (the ledger survives a restart, so an interrupted haul is finished later)
    if (state.worksite) {
      const h = await ws.haul(ctx)
      if (h.full) throw new Pause('park', FURNACES_FULL)
      if (h.done && h.left && Object.keys(h.left).length) say(`The work-site chest at ${state.worksite.pos.join(', ')} still holds things the furnaces cannot take (${Object.entries(h.left).slice(0, 3).map(([n, c]) => `${c} ${n}`).join(', ')}). Tell me where to put them, or say keep.`.slice(0, 230))
      else if (!h.done) say(`I could not get back to the work-site chest at ${state.worksite.pos.join(', ')} (${h.why}); it still holds my stash.`.slice(0, 230))
    }
    const fin = await loadedScan(ctx)
    const leftCells = remainingCells(fin.groups)
    state.total = fin.groups.length
    verifyCache = null
    state.active = false; state.pauseReason = null
    if (leftCells.length) {
      state.finished = false; state.leftCells = leftCells.length
      const sec = state.unreachable.length ? ` (${state.unreachable.length} section(s) I could not walk to)` : ''
      say(`Excavation not finished: ${leftCells.length} block(s) are still uncut${sec}, e.g. ${leftCells.slice(0, 2).join(' | ')}. Say "resume excavation" to try again.`.slice(0, 230))
    } else {
      state.unreachable = []; state.leftCells = 0
      state.finished = true; state.finishedAt = new Date(now()).toISOString()
      say(`Excavation finished: ${state.dug} blocks dug. ${skippedText() ? 'Skipped: ' + skippedText() + '.' : 'Nothing skipped.'}`.slice(0, 230))
    }
    note(`DONE dug=${state.dug} skipped=${JSON.stringify(state.skipped)} unreachable=${state.unreachable.length} left=${leftCells.length}`)
    save()
    return { status: 'done' }
  }

  async function run(ctx) {
    if (running) return { status: 'done' }
    running = true
    try { return await job(ctx) }
    catch (e) {
      if (e && e.name === 'AbortError') throw e
      if (e instanceof Pause) {
        if (e.kind === 'retry') return { status: 'retry', afterMs: e.afterMs || L.dangerRetryMs }
        return park(e.reason)
      }
      log(`ERROR ${e && e.stack || e}`)
      say(`Excavation stopped by an error: ${e && e.message}`.slice(0, 200))
      return park(`error: ${e && e.message}`, true)
    } finally {
      running = false
      verifyCache = null
      save()
      try { await safehand.stow() } catch {}
    }
  }

  function park(reason, quiet = false) {
    state.active = false; state.pauseReason = reason; save()
    note(`PAUSED ${reason}`)
    if (!quiet) say(`${reason} Say "resume excavation" when ready.`.slice(0, 235))
    return { status: 'park', reason }
  }

  // Scheduler abort hook (preempt / Walter's stop). The running dig is interrupted; progress is already on disk.
  function abort(reason) {
    try { stopNav() } catch {}
    try { bot.stopDigging && bot.stopDigging() } catch {}
    if (reason !== 'preempted') { state.active = false; state.pauseReason = reason === 'user-stop' ? 'stopped by Walter.' : `stopped (${reason}).`; save() }
  }

  return { run, abort, describePlan, statusLine, snapshot, scan, isRunning: () => running, dumper, tools, geo, Pause }
}
module.exports.Pause = Pause
