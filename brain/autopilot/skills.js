// brain/autopilot/skills.js: the body skills of the self-playing bot (walk, dig, craft, smelt, hunt, tunnel).
// Survival-legit: blocks are only chosen when a player standing here could see them (clear ray from the eye); nothing is found "through" stone.
// Digging/placing is allowed here (Walter started a fresh world and asked the bot to play on its own).
const { Vec3 } = require('vec3')
const { Movements, goals } = require('mineflayer-pathfinder')
const los = require('../los')
const { holderOf, markPlacing } = require('../reflexes')

const AIR = /^(air|cave_air|void_air)$/
const LOG_RE = /_(log|stem|hyphae|wood)$/
const PLANK_RE = /_planks$/
const ORE_RE = /_ore$/
const CANT_BREAK = /planks|brick|glass|_door|fence|slab|stairs|chest|barrel|furnace|_bed$|crafting_table|_wall$|lantern|banner|sign|bookshelf|rail|obsidian|bedrock|spawner|torch|ladder|scaffolding|sea_lantern|beacon|shulker|anvil|enchanting|brewing|cauldron|campfire|hopper|piston|lever|button|pressure_plate|trapdoor|concrete|terracotta|carpet|wool/
const SIX = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
const HORIZ = [[1, 0], [0, 1], [-1, 0], [0, -1]]
const FOOD_VALUE = { dried_kelp: 1, cooked_beef: 8, cooked_porkchop: 8, cooked_mutton: 6, cooked_chicken: 6, cooked_rabbit: 5, cooked_cod: 5, cooked_salmon: 6, bread: 5, baked_potato: 5, apple: 4, carrot: 3, golden_carrot: 6, melon_slice: 2, sweet_berries: 2, beetroot: 1, cookie: 2, pumpkin_pie: 8, mushroom_stew: 6, rabbit_stew: 10, beef: 3, porkchop: 3, mutton: 2, chicken: 2, rabbit: 3, cod: 2, salmon: 2, potato: 1 }
const RAW_MEAT = ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon', 'potato']
const SMELT_OF = { beef: 'cooked_beef', porkchop: 'cooked_porkchop', mutton: 'cooked_mutton', chicken: 'cooked_chicken', rabbit: 'cooked_rabbit', cod: 'cooked_cod', salmon: 'cooked_salmon', potato: 'baked_potato', raw_iron: 'iron_ingot', raw_gold: 'gold_ingot', raw_copper: 'copper_ingot', cobblestone: 'stone', sand: 'glass', oak_log: 'charcoal', spruce_log: 'charcoal', birch_log: 'charcoal', jungle_log: 'charcoal', acacia_log: 'charcoal', dark_oak_log: 'charcoal', mangrove_log: 'charcoal', cherry_log: 'charcoal' }
const FUEL = ['coal', 'charcoal', 'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'bamboo_planks', 'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'stick']
const FUEL_ITEMS = { coal: 8, charcoal: 8, stick: 0.5 }  // items smelted per fuel item (planks/logs 1.5/1.5)
const HOSTILE = /^(zombie|zombie_villager|husk|drowned|skeleton|stray|creeper|spider|cave_spider|enderman|witch|pillager|vindicator|slime|phantom|silverfish|blaze|ghast|piglin_brute|hoglin|zoglin|wither_skeleton|magma_cube|evoker|ravager|vex|warden|bogged|breeze)$/
const PASSIVE_FOOD = { cow: 'beef', pig: 'porkchop', sheep: 'mutton', chicken: 'chicken', rabbit: 'rabbit' }

module.exports = function makeSkills({ bot, api, log }) {
  const mcData = require('minecraft-data')(bot.version)
  const S = { bot, ctx: null, mcData, consts: { LOG_RE, PLANK_RE, ORE_RE, FOOD_VALUE, HOSTILE, PASSIVE_FOOD, RAW_MEAT, SMELT_OF }, blacklist: new Map(), stats: { dug: 0, crafted: 0, killed: 0, goto: 0, gotoFail: 0 } }
  const sleepRaw = (ms) => new Promise(r => setTimeout(r, ms))
  const now = () => Date.now()
  const v = (x, y, z) => new Vec3(x, y, z)
  const flo = (p) => v(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
  const key = (p) => `${p.x},${p.y},${p.z}`
  S.v = v; S.flo = flo; S.key = key; S.goals = goals; S.sleepRaw = sleepRaw

  // ---------- abort plumbing ----------
  // time box: G.step sets S.stepDeadline; any skill that calls S.check() past it throws StepTimeout, so no single step can hold the bot for long
  S.check = () => { if (S.ctx) S.ctx.checkpoint(); if (S.stepDeadline && Date.now() > S.stepDeadline) { S.stepDeadline = 0; try { S.stopMoving() } catch {} const e = new Error('step time budget used up'); e.name = 'StepTimeout'; throw e } }
  S.aborted = () => !!(S.ctx && S.ctx.aborted)
  S.wait = async (ms) => { if (S.ctx) await S.ctx.sleep(ms); else await sleepRaw(ms) }
  S.isAbort = (e) => !!e && (e.name === 'AbortError' || (S.ctx && S.ctx.aborted))
  S.progress = (t) => { try { S.ctx && S.ctx.progress && S.ctx.progress(t) } catch {} }
  S.say = (t) => { try { api.say(t) } catch {} }

  // ---------- blacklist (positions or ids that failed recently) ----------
  S.ban = (k, ms = 5 * 60000) => S.blacklist.set(String(k), now() + ms)
  S.banned = (k) => { const t = S.blacklist.get(String(k)); if (!t) return false; if (t < now()) { S.blacklist.delete(String(k)); return false } return true }

  // ---------- inventory ----------
  S.items = () => bot.inventory.items()
  S.count = (what) => {
    let n = 0
    for (const it of bot.inventory.items()) {
      if (what instanceof RegExp ? what.test(it.name) : it.name === what) n += it.count
    }
    return n
  }
  S.has = (name, n = 1) => S.count(name) >= n
  S.logs = () => S.count(LOG_RE)
  S.planks = () => S.count(PLANK_RE)
  S.freeSlots = () => bot.inventory.emptySlotCount()
  S.foodPoints = () => { let n = 0; for (const it of bot.inventory.items()) { const f = FOOD_VALUE[it.name]; if (f && !RAW_MEAT.includes(it.name)) n += f * it.count } return n }
  S.rawFood = () => { let n = 0; for (const it of bot.inventory.items()) if (RAW_MEAT.includes(it.name)) n += it.count; return n }
  S.toolTier = (kind) => { // best tier of a tool kind: 0 none, 1 wooden/golden, 2 stone, 3 iron, 4 diamond, 5 netherite
    const order = { wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 }
    let best = 0
    for (const it of bot.inventory.items()) { const m = new RegExp(`^(\\w+)_${kind}$`).exec(it.name); if (m && order[m[1]] > best) best = order[m[1]] }
    return best
  }

  // ---------- world queries ----------
  S.block = (p) => { try { return bot.blockAt(p instanceof Vec3 ? p : v(p.x, p.y, p.z)) } catch { return null } }
  S.name = (p) => { const b = S.block(p); return b ? b.name : null }
  S.isAir = (b) => !b || AIR.test(b.name)
  S.isLiquid = (b) => !!b && (b.name === 'water' || b.name === 'lava' || b.name === 'bubble_column')
  S.passable = (b) => !!b && b.boundingBox === 'empty' && !S.isLiquid(b)
  S.solid = (b) => !!b && b.boundingBox === 'block' && !S.isLiquid(b)
  S.eye = () => los.eyeOf(bot)
  S.canSee = (target) => { try { return los.canSee(bot, target) } catch { return false } }
  S.exposed = (p) => { // a face of this block touches open space (air-like, not liquid)
    for (const [dx, dy, dz] of SIX) { const b = S.block(v(p.x + dx, p.y + dy, p.z + dz)); if (b && b.boundingBox === 'empty' && !S.isLiquid(b)) return true }
    return false
  }
  S.hazardNear = (p, r = 1) => { // lava (or water for tunnels) next to a cell
    let lava = false, water = false, sculk = false
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
      const b = S.block(v(p.x + dx, p.y + dy, p.z + dz)); if (!b) continue
      if (b.name === 'lava') lava = true
      else if (b.name === 'water') water = true
      else if (/^sculk|^reinforced_deepslate/.test(b.name)) sculk = true
    }
    return { lava, water, sculk }
  }
  S.blockIds = (re) => mcData.blocksArray.filter(b => (re instanceof RegExp ? re.test(b.name) : re.includes(b.name))).map(b => b.id)

  // Blocks of a kind that the bot can actually SEE from where it stands (exposed face + clear ray). Never an x-ray list.
  S.seen = (what, { radius = 40, max = 60, needSight = true } = {}) => {
    const ids = S.blockIds(what)
    if (!ids.length) return []
    let ps = []
    // bounded work: big radii and 200 line-of-sight raycasts stalled the event loop for 2-3 s (lag module, wood-stock)
    try { ps = bot.findBlocks({ matching: ids, maxDistance: Math.min(radius, 40), count: Math.min(120, max * 4) }) } catch { return [] }
    const me = bot.entity.position
    const out = []; let losChecks = 0
    ps.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
    for (const p of ps) {
      if (out.length >= max) break
      if (S.banned('b' + key(p))) continue
      if (!S.exposed(p)) continue
      const b = S.block(p); if (!b) continue
      if (needSight && ++losChecks > 40) break
      if (needSight && !S.canSee(b)) continue
      out.push(b)
    }
    return out
  }

  // ---------- movement ----------
  function makeMoves(dig) {
    const mv = new Movements(bot)
    mv.canDig = !!dig
    mv.allow1by1towers = !!dig
    mv.allowParkour = true
    mv.allowSprinting = true
    mv.canOpenDoors = true
    mv.maxDropDown = 4
    mv.infiniteLiquidDropdownDistance = false
    mv.liquidCost = 25                      // drowning is the top killer in this world: wade only when there is no other way
    for (const b of mcData.blocksArray) if (CANT_BREAK.test(b.name)) mv.blocksCantBreak.add(b.id)
    for (const n of ['cactus', 'sweet_berry_bush', 'magma_block', 'campfire', 'soul_campfire', 'soul_fire', 'powder_snow', 'wither_rose', 'pointed_dripstone', 'fire', 'lava']) {
      const b = mcData.blocksByName[n]; if (b) mv.blocksToAvoid.add(b.id)
    }
    return mv
  }
  const moveCache = {}
  S.setMoves = (dig) => { const k = dig ? 'dig' : 'walk'; if (!moveCache[k]) moveCache[k] = makeMoves(dig); bot.pathfinder.setMovements(moveCache[k]) }
  S.dropMoveCache = () => { for (const k of Object.keys(moveCache)) delete moveCache[k] }

  S.stopMoving = () => { try { bot.pathfinder.setGoal(null) } catch {} try { bot.clearControlStates() } catch {} }

  // goto: resolves {ok, err}. Never throws except on task abort.
  // With the nav module loaded this is nav's escalating go-to (brain/nav/reach.js): when the plain path fails it digs, bridges, pillars and
  // tears walls down (and rebuilds base walls behind it) until it arrives. `ms` is the plain attempt; `maxMs` caps the whole thing;
  // `escalate: false` keeps it to one plain attempt (item pickup, chasing); `dig: true` skips the plain attempt.
  S.goto = async (goal, { dig = false, ms = 45000, escalate = true, maxMs = null } = {}) => {
    S.check()
    // always give timers a turn: a caller looping on goals that are already satisfied (nav returns without awaiting a tick) starved the
    // event loop for two minutes at 14:23 and again at 14:51 (no evals, no reflex timers)
    await new Promise(r => setImmediate(r))
    // the breath reflex owns the movement keys while the bot is out of air (a dig under water drowned it at 14:50): wait for it
    for (let i = 0; i < 40 && (bot._reflexes ? holderOf(bot, 'body') === 'breath' : (bot._breathBusyUntil || 0) > Date.now()); i++) await new Promise(r => setTimeout(r, 500))
    try { await api.safehand.ensureSafeForMove() } catch {}
    S.stats.goto++
    const nav = api.nav && api.nav.goto && api.nav.reach ? api.nav : null        // old nav (no reach.js loaded yet): the legacy path below
    let r
    if (nav) {
      let offAbort = null
      if (S.ctx && S.ctx.onAbort) offAbort = S.ctx.onAbort(() => { try { nav.nav.stop('aborted') } catch {} })
      try {
        const res = await nav.goto(goal, { label: 'autopilot', ms, escalate, startAtDig: !!dig && escalate, maxMs: maxMs || Math.min(8 * 60000, Math.max(120000, ms * 4)), isAborted: () => S.aborted() })
        r = res.ok ? { ok: true } : { ok: false, err: res.err || 'nopath' }
      } finally { if (offAbort) try { offAbort() } catch {} }
    } else {
      S.setMoves(dig)
      let timer, offAbort = null
      const guard = new Promise((res) => {
        timer = setTimeout(() => { S.stopMoving(); res({ ok: false, err: 'timeout' }) }, ms)
        if (S.ctx && S.ctx.onAbort) offAbort = S.ctx.onAbort(() => { S.stopMoving(); res({ ok: false, err: 'aborted' }) })
      })
      const run = bot.pathfinder.goto(goal).then(() => ({ ok: true }), (e) => ({ ok: false, err: e && e.name || String(e) }))
      r = await Promise.race([run, guard])
      clearTimeout(timer); if (offAbort) try { offAbort() } catch {}
    }
    if (r.ok) { // the library resolves on an empty path (noPath/timeout) too: check that we really arrived
      let end = true
      try { end = goal.isEnd ? !!goal.isEnd(S.flo(bot.entity.position)) : true } catch {}
      if (!end) { r.ok = false; r.err = 'nopath' }
    }
    if (!r.ok) { S.stats.gotoFail++; S.stopMoving() }
    S.check()
    return r
  }
  // The combat reflex (brain/combat) takes the controls when something can hurt us: a walk it interrupted is retried once the fight is over.
  // Work zone (Walter 2026-11-02, brain/state/zone.json): goals outside the zone are refused unless they bring us closer to it; no digging inside noDig circles.
  let zoneCache = null, zoneAt = 0
  S.zone = () => { if (Date.now() - zoneAt > 10000) { zoneAt = Date.now(); try { zoneCache = JSON.parse(require('fs').readFileSync(api.statePath('zone.json'), 'utf8')) } catch { zoneCache = null } } return zoneCache }
  const goalXZ = (g) => { if (!g) return null; if (g.pos && g.pos.x != null) return { x: g.pos.x, z: g.pos.z }; if (g.x != null && g.z != null) return { x: g.x, z: g.z }; return null }
  S.inZone = (p) => { const z = S.zone(); if (!z || !z.workZone) return true; const w = z.workZone; return Math.hypot(p.x - w.x, p.z - w.z) <= w.r }
  // zone.json allow: [{ x0, x1, y0, y1, z0, z1, blocks: 'regex' }]: a job site inside a no-dig area where only those blocks may be broken
  // (Walter 2026-11-04: Smeo444 harvests his birch farm, logs and leaves only)
  S.noDigAt = (p, name) => { const z = S.zone(); if (!z || !z.noDig) return false
    if (name && (z.allow || []).some(a => p.x >= a.x0 && p.x <= a.x1 && p.y >= a.y0 && p.y <= a.y1 && p.z >= a.z0 && p.z <= a.z1 && new RegExp(a.blocks).test(name))) return false
    return z.noDig.some(c => Math.hypot(p.x - c.x, p.z - c.z) <= c.r) }
  const gotoBase = S.goto
  S.goto = async (goal, o = {}) => {
    const tg = goalXZ(goal), z = S.zone()
    if (tg && z && z.workZone && !S.inZone(tg)) {
      const w = z.workZone, me = bot.entity.position
      if (Math.hypot(tg.x - w.x, tg.z - w.z) >= Math.hypot(me.x - w.x, me.z - w.z)) { log('ZONE', 'refused goto outside the work zone ' + Math.round(tg.x) + ',' + Math.round(tg.z)); return { ok: false, why: 'outside work zone' } }
    }
    if (o.dig && S.noDigAt(bot.entity.position)) o = { ...o, dig: false }
    // the navigator's escalation digs, pillars and towers whatever dig says: never inside a no-dig area (Walter's bases)
    if (S.noDigAt(bot.entity.position) || (tg && S.noDigAt({ x: tg.x, y: 64, z: tg.z }))) o = { ...o, escalate: false }
    let r = await gotoBase(goal, o)
    // like a player: when the exact path fails, get roughly close first (the new view often shows the way: a door, a gap), then try the exact goal once more
    if (!r.ok && tg && !o._closer) {
      const d = Math.hypot(tg.x - bot.entity.position.x, tg.z - bot.entity.position.z)
      if (d > 5 && d < 200) {
        const me = bot.entity.position, f = Math.max(0, (d - 4) / d)
        const mid = { x: Math.round(me.x + (tg.x - me.x) * f), z: Math.round(me.z + (tg.z - me.z) * f) }
        const r1 = await gotoBase(new goals.GoalNearXZ ? new goals.GoalNearXZ(mid.x, mid.z, 3) : new goals.GoalXZ(mid.x, mid.z), { ...o, ms: Math.min(o.ms || 45000, 45000) })
        if (r1.ok || Math.hypot(tg.x - bot.entity.position.x, tg.z - bot.entity.position.z) < d - 2) r = await gotoBase(goal, { ...o, _closer: true })
      }
    }
    // a look-at goal raycasts every candidate cell and timed out among bushes and clutter (the berries starved the bot): standing within
    // 2 blocks is within reach, so fall back to that
    if (!r.ok && goal && goal.constructor && goal.constructor.name === 'GoalLookAtBlock' && goal.pos && !o._near) {
      const gp = goal.pos
      if (bot.entity.position.distanceTo(gp.offset(0.5, 0.5, 0.5)) > 4.2) { const r2 = await gotoBase(new goals.GoalNear(gp.x, gp.y, gp.z, 2), { ...o, _near: true }); if (r2.ok) r = r2 }
      else r = { ok: true }
    }
    for (let i = 0; i < 3 && !r.ok; i++) {
      const c = bot._combat
      if (!(c && c.engaged())) break
      const t0 = Date.now()
      while (c.engaged() && Date.now() - t0 < 20000) { S.check(); await sleepRaw(300) }
      r = await gotoBase(goal, o)
    }
    return r
  }
  S.gotoNear = (p, r = 2, o = {}) => S.goto(new goals.GoalNear(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), r), o)

  // ---------- tools & digging ----------
  S.canHarvest = (block) => {
    if (!block.harvestTools) return true
    for (const it of bot.inventory.items()) if (block.harvestTools[it.type]) return true
    return false
  }
  S.equipFor = async (block) => {
    let best = null, bt = Infinity
    for (const it of bot.inventory.items()) {
      if (!/_(pickaxe|axe|shovel|hoe|sword)$/.test(it.name)) continue
      if (block.harvestTools && !block.harvestTools[it.type]) continue
      let t = Infinity
      try { t = block.digTime(it.type, false, false, false, [], []) } catch {}
      if (t < bt) { bt = t; best = it }
    }
    if (block.harvestTools && !best) return false
    let hand = Infinity
    try { hand = block.digTime(null, false, false, false, [], []) } catch {}
    if (best && bt < hand) { if (!bot.heldItem || bot.heldItem.type !== best.type) await bot.equip(best, 'hand').catch(() => {}) }
    else if (bot.heldItem && /_(pickaxe|axe|shovel|hoe|sword)$/.test(bot.heldItem.name)) await bot.unequip('hand').catch(() => {})
    return true
  }
  const reachOk = (b) => S.eye().distanceTo(v(b.position.x + 0.5, b.position.y + 0.5, b.position.z + 0.5)) <= 4.6

  // First solid block on the ray from the eye to the centre of target (what the crosshair would hit).
  S.firstHit = (target) => {
    const eye = S.eye(), c = v(target.x + 0.5, target.y + 0.5, target.z + 0.5)
    const d = c.minus(eye), dist = d.norm()
    if (dist < 1e-6) return null
    try { return bot.world.raycast(eye, d.scaled(1 / dist), dist + 0.5) || null } catch { return null }
  }

  // Dig a block that is in reach and in view. Returns true when it is gone.
  S.digBlock = async (b, { force = false } = {}) => {
    S.check()
    if (!b || S.isAir(b)) return true
    if (S.noDigAt && S.noDigAt(b.position, b.name)) { log('ZONE', 'refused dig in a no-dig area at ' + b.position); return false }
    // established things (the house, chests, beds, farmland, torches...) are not mined in passing; ripe wheat is harvest, not damage
    if (!force && b.name !== 'wheat' && S.isEstablished && S.isEstablished(b)) { log('KNOWN', `refused to dig established ${b.name} at ${b.position}`); return false }
    if (!force && CANT_BREAK.test(b.name) && !/^(crafting_table)$/.test(b.name)) return false
    if (!(await S.equipFor(b))) return false
    try { await bot.lookAt(v(b.position.x + 0.5, b.position.y + 0.5, b.position.z + 0.5), true) } catch {}
    if (!S.canSee(b)) return false
    let timer = setTimeout(() => { try { bot.stopDigging() } catch {} }, 25000)
    try { await bot.dig(b, true); S.stats.dug++ } catch (e) { return false } finally { clearTimeout(timer) }
    S.check()
    const after = S.block(b.position)
    return S.isAir(after) || (after && after.type !== b.type)
  }

  // Get within reach with a clear view of a block. If leaves/dirt are in the way, dig the thing the crosshair hits (a player would).
  S.approach = async (b, { dig = true, tries = 3 } = {}) => {
    for (let i = 0; i < tries; i++) {
      S.check()
      if (reachOk(b) && S.canSee(b)) return true
      if (reachOk(b)) { // close but blocked: clear what is in the way if it is natural/soft
        const hit = S.firstHit(b.position)
        if (hit && hit.position && !hit.position.equals(b.position) && /leaves|dirt|grass|stone|sand|gravel|snow|vine|bush|fern|flower|tuff|andesite|diorite|granite|deepslate/.test(hit.name) && !S.hazardNear(hit.position).lava) {
          await S.digBlock(hit)
          continue
        }
      }
      const r = await S.goto(new goals.GoalLookAtBlock(b.position, bot.world, { reach: 4.2 }), { dig, ms: 30000 })
      if (!r.ok && !reachOk(b)) {
        const r2 = await S.goto(new goals.GoalNear(b.position.x, b.position.y, b.position.z, 3), { dig, ms: 25000 })
        if (!r2.ok) { S.ban('b' + key(b.position), 3 * 60000); return false }
      }
    }
    return reachOk(b) && S.canSee(b)
  }

  // Pick up item drops nearby.
  S.itemEntities = (radius = 12) => {
    const me = bot.entity.position, out = []
    for (const e of Object.values(bot.entities)) {
      if (!e || e === bot.entity || !e.position) continue
      if (e.name !== 'item' && e.displayName !== 'Item') continue
      const d = e.position.distanceTo(me); if (d <= radius) out.push({ e, d })
    }
    return out.sort((a, b) => a.d - b.d).map(o => o.e)
  }
  S.pickup = async (radius = 10, ms = 9000) => {
    const t0 = now()
    let n = 0
    while (now() - t0 < ms) {
      S.check()
      // drops lying inside a berry bush stay there (Walter: losing some berries beats walking into the thorns)
      const its = S.itemEntities(radius).filter(e => !S.banned('i' + e.id) && !/sweet_berry_bush|cactus/.test((S.block(e.position.floored()) || {}).name || ''))
      if (!its.length) break
      if (S.freeSlots() === 0) break
      const e = its[0]
      const r = await S.goto(new goals.GoalNear(e.position.x, e.position.y, e.position.z, 0.6), { dig: false, ms: 6000, escalate: false })
      n++
      if (!r.ok) S.ban('i' + e.id, 60000)
      await S.wait(120)
    }
    return n
  }

  // Dig a block as a player would: get a view, dig, collect the drop.
  S.mine = async (b, { dig = true, pick = true } = {}) => {
    if (!(await S.approach(b, { dig }))) return false
    const h = S.hazardNear(b.position, 1)
    if (h.lava) { S.ban('b' + key(b.position), 30 * 60000); return false }
    const ok = await S.digBlock(b)
    if (!ok) { S.ban('b' + key(b.position), 2 * 60000); return false }
    if (pick) await S.pickup(6, 4000)
    return true
  }

  // Mine up to `count` of the visible blocks matching `what` (regex or name list). Returns how many were mined.
  S.gather = async (what, count, { radius = 40, dig = true, filter = null, needSight = true, ms = 240000, stopWhen = null } = {}) => {
    let got = 0, fails = 0
    const t0 = now(), re = what, skip = new Set()
    while (got < count && now() - t0 < ms) {
      S.check()
      if (stopWhen && stopWhen()) break
      if (S.freeSlots() <= 1) { S.progress('inventory full'); break }
      // established blocks (home, paths) and blocks that already failed are not candidates: picking the same refused stone again and again
      // was a tight loop that starved the event loop for two minutes
      let cands = S.seen(re, { radius, needSight }).filter(b => !skip.has(key(b.position)) && !(S.isEstablished && S.isEstablished(b)))
      if (filter) cands = cands.filter(filter)
      if (!cands.length) break
      const ok = await S.mine(cands[0], { dig })
      if (ok) { got++; fails = 0 } else { skip.add(key(cands[0].position)); if (++fails >= 8) break }
      await new Promise(r => setImmediate(r))
    }
    return got
  }

  // Chop whole trees: nearest visible log, then every log connected to it (bottom first).
  S.chopTree = async (want = 6, { ms = 180000 } = {}) => {
    const t0 = now(); let got = 0
    while (got < want && now() - t0 < ms) {
      S.check()
      if (S.freeSlots() <= 1) break
      const logs = S.seen(LOG_RE, { radius: 48, needSight: true })
      if (!logs.length) break
      // pick the log closest to the ground within the nearest few
      const start = logs[0]
      const tree = []
      const seen = new Set([key(start.position)]), q = [start.position]
      while (q.length && tree.length < 40) {
        const p = q.shift(); const b = S.block(p)
        if (b && LOG_RE.test(b.name)) tree.push(b)
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
          const np = v(p.x + dx, p.y + dy, p.z + dz), k = key(np)
          if (seen.has(k)) continue
          seen.add(k)
          const nb = S.block(np); if (nb && LOG_RE.test(nb.name)) q.push(np)
        }
      }
      tree.sort((a, b) => a.position.y - b.position.y)
      let cut = 0
      for (const lg of tree) {
        if (got >= want + 2) break
        const cur = S.block(lg.position); if (!cur || !LOG_RE.test(cur.name)) continue
        if (lg.position.y - Math.floor(bot.entity.position.y) > 6) continue   // too high without a tower
        // walk to it, do not dig through the hillside to reach a trunk (Walter: the bot tears up terrain)
        if (await S.mine(cur, { dig: false })) { got++; cut++ }
      }
      if (!cut) S.ban('b' + key(start.position), 5 * 60000)
      // a felled tree is replanted where it stood (with a sapling of the same wood if we carry one)
      if (cut && tree.length) {
        const base = tree[0].position, g = S.block(base.offset(0, -1, 0)), c = S.block(base)
        const kind = tree[0].name.replace(/_log$/, '')
        const sap = S.items().find(i => i.name === kind + '_sapling') || S.items().find(i => /_sapling$/.test(i.name))
        if (sap && g && /^(grass_block|dirt|podzol|coarse_dirt)$/.test(g.name) && c && S.isAir(c)) { try { await S.placeAgainst(g, v(0, 1, 0), sap.name) } catch {} }
      }
    }
    await S.pickup(10, 5000)
    return got
  }

  // ---------- placing ----------
  S.placeAgainst = async (ref, face, itemName) => {
    const it = bot.inventory.items().find(i => i.name === itemName)
    if (!it) return false
    if (bot._meleeClose && Date.now() - (bot._meleeCloseAt || 0) < 500) return false   // a mob in reach: no placing while combat holds the sword
    markPlacing(bot, 2500)
    await bot.equip(it, 'hand').catch(() => {})
    try { await bot.lookAt(v(ref.position.x + 0.5 + face.x * 0.5, ref.position.y + 0.5 + face.y * 0.5, ref.position.z + 0.5 + face.z * 0.5), true) } catch {}
    try { await bot.placeBlock(ref, face); return true } catch (e) { log('PLACE_FAIL', `${itemName}: ${e.message}`); return false }
  }
  // Find an open floor cell next to the bot and place `itemName` there. Returns the placed block or null.
  S.placeNear = async (itemName) => {
    const me = flo(bot.entity.position)
    const spots = []
    for (let dy = 0; dy >= -1; dy--) for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      if (!dx && !dz) continue
      const cell = v(me.x + dx, me.y + dy, me.z + dz), floor = S.block(cell.offset(0, -1, 0)), here = S.block(cell), above = S.block(cell.offset(0, 1, 0))
      if (!floor || !here || !above) continue
      if (!S.solid(floor) || !S.isAir(here) || !S.passable(above)) continue
      spots.push({ cell, floor, d: Math.abs(dx) + Math.abs(dz) + Math.abs(dy) })
    }
    spots.sort((a, b) => a.d - b.d)
    for (const s of spots.slice(0, 6)) {
      if (!(await S.placeAgainst(s.floor, v(0, 1, 0), itemName))) continue
      await S.wait(250)
      const placed = S.block(s.cell)
      if (placed && placed.name === itemName) return placed
    }
    return null
  }

  // Underground (tunnels): never plug the corridor. Dig a niche into a side wall and put the block in there.
  S.placeInNiche = async (itemName) => {
    const me = flo(bot.entity.position)
    for (const [dx, dz] of HORIZ) {
      const cell = v(me.x + dx, me.y, me.z + dz), b = S.block(cell)
      if (!b || !S.solid(b) || CANT_BREAK.test(b.name)) continue
      if (S.hazardNear(cell, 1).lava || S.hazardNear(cell, 1).water) continue
      const head = S.block(cell.offset(0, 1, 0)); if (!head || !S.solid(head)) continue
      const floor = S.block(cell.offset(0, -1, 0)); if (!floor || !S.solid(floor)) continue
      if (!(await S.digBlock(b))) continue
      await S.pickup(3, 1500)
      if (await S.placeAgainst(floor, v(0, 1, 0), itemName)) { await S.wait(250); const pl = S.block(cell); if (pl && pl.name === itemName) return pl }
    }
    return null
  }
  S.placed = []
  S.placeWork = async (itemName) => {
    const b = (S.skyVisible() ? await S.placeNear(itemName) : await S.placeInNiche(itemName)) || (await S.placeNear(itemName))
    if (b) S.placed.push({ name: itemName, pos: b.position.clone() })
    return b
  }
  // Pick our portable table/furnace up again (they are reusable and must not wall in a corridor).
  S.reclaim = async () => {
    const keep = []
    for (const pl of S.placed) {
      const b = S.block(pl.pos)
      if (!b || b.name !== pl.name) continue
      if (S.dist(pl.pos) > 6) { keep.push(pl); continue }
      if (await S.approach(b, { dig: false, tries: 2 })) { await S.digBlock(b, { force: true }); await S.pickup(4, 2500) } else keep.push(pl)
    }
    S.placed = keep
  }

  // ---------- crafting ----------
  S.tableNear = (r = 4.5) => { const ids = S.blockIds(['crafting_table']); const b = bot.findBlock({ matching: ids, maxDistance: r }); return b || null }
  S.knownTable = (r = 40) => { const ids = S.blockIds(['crafting_table']); return bot.findBlock({ matching: ids, maxDistance: r }) || null }
  S.ensureTable = async () => {
    let t = S.tableNear(4)
    if (t && (S.canSee(t) || S.eye().distanceTo(t.position.offset(.5,.5,.5)) < 3)) return t
    t = S.knownTable(48)
    if (t) { const r = await S.goto(new goals.GoalLookAtBlock(t.position, bot.world, { reach: 3.5 }), { dig: false, ms: 30000 }); if (r.ok || S.tableNear(4.4)) { const tt = S.tableNear(4.5); if (tt) return tt } }
    if (!S.has('crafting_table')) { if (!(await S.craft('crafting_table', 1, { noTable: true }))) return null }
    const placed = await S.placeWork('crafting_table')
    return placed
  }

  // craft(name, count): make sure the bag has at least `count` of the item, crafting intermediates (planks, sticks, ...) as needed.
  S.craft = async (name, count = 1, { noTable = false, depth = 0 } = {}) => {
    const item = mcData.itemsByName[name]
    if (!item) return false
    if (S.count(name) >= count) return true
    if (depth > 4) return false
    const need = count - S.count(name)
    const recipes = bot.recipesAll(item.id, null, !noTable)
    if (!recipes.length) return false
    const have = (id) => bot.inventory.count(id, null)
    const scored = recipes.map(r => {
      const times = Math.ceil(need / r.result.count)
      let missing = 0
      for (const d of r.delta) if (d.count < 0) missing += Math.max(0, -d.count * times - have(d.id))
      return { r, times, missing }
    }).sort((a, b) => a.missing - b.missing)
    for (let { r, times } of scored.slice(0, 24)) {
      // satisfy ingredients
      let okAll = true
      for (const d of r.delta) {
        if (d.count >= 0) continue
        const want = -d.count * times
        const ing = mcData.items[d.id]
        if (have(d.id) >= want) continue
        if (!(await S.craft(ing.name, want, { noTable, depth: depth + 1 }))) { okAll = false; break }
      }
      if (!okAll) continue
      let table = null
      if (r.requiresTable) {
        if (noTable) continue
        table = await S.ensureTable()
        if (!table) continue
        if (!reachOk(table)) { await S.goto(new goals.GoalLookAtBlock(table.position, bot.world, { reach: 3.5 }), { ms: 20000 }) }
      }
      try {
        const useTable = table || S.tableNear(4.5) || undefined
        // the planned recipe may name a different plank/log variant than the bag now holds ("missing ingredient"): re-resolve against the real inventory
        const live = bot.recipesFor(item.id, null, 1, useTable || null)
        if (live.length) { const lr = live[0]; const per = lr.result.count || 1; r = lr; times = Math.ceil((count - S.count(name)) / per) }
        try { await bot.craft(r, times, useTable) } catch (e0) {
          // the inventory view lags a moment after the previous craft ("missing ingredient" with the items in the bag): wait, re-resolve, craft one batch at a time
          let e = e0
          if (/missing ingredient/i.test(String(e0.message))) {
            let made = 0
            for (let k = 0; k < times; k++) {
              await S.wait(600)
              const lv = bot.recipesFor(item.id, null, 1, useTable || null)
              if (!lv.length) break
              try { await bot.craft(lv[0], 1, useTable); made++ } catch (e2) { e = e2; break }
            }
            if (made) e = null
          }
          if (e) {
          // inventory (2x2) crafts can time out on this server: retry at a crafting table
          if (!useTable && /updateSlot/.test(String(e.message)) && !noTable) {
            const tb = await S.ensureTable()
            if (!tb) throw e
            if (!reachOk(tb)) await S.goto(new goals.GoalLookAtBlock(tb.position, bot.world, { reach: 3.5 }), { ms: 20000 })
            await bot.craft(r, times, tb)
          } else throw e
          }
        }
        S.stats.crafted++
        S.check()
        if (S.count(name) >= count) return true
      } catch (e) { log('CRAFT_FAIL', `${name}: ${e.message}`) }
    }
    return S.count(name) >= count
  }
  // Inventory (2x2) crafting is unreliable on this server (updateSlot:0 timeouts, then "missing ingredient"), crafting at a table is not.
  // So with a table in the bag every craft happens at a table: put it down, craft, pick it back up.
  // An interrupted craft can leave the crafting-table window open; every later craft or chest then fails ("Non-container window used as a container").
  S.closeWindows = () => { try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch {} }
  const craftInner = S.craft
  S.craft = async (name, count = 1, o = {}) => {
    if (!(o.depth > 0)) S.closeWindows()
    if (S.count(name) >= count) return true
    let placed = null
    if (!o.noTable && !(o.depth > 0) && name !== 'crafting_table' && !S.tableNear(4.5) && S.has('crafting_table')) { try { placed = await S.placeWork('crafting_table') } catch {} }
    try { return await craftInner(name, count, o) } finally { if (placed) { try { await S.reclaim() } catch {} } }
  }

  // ---------- furnace ----------
  S.furnaceNear = (r = 4.5) => bot.findBlock({ matching: S.blockIds(['furnace']), maxDistance: r }) || null
  S.ensureFurnace = async () => {
    let f = S.furnaceNear(4)
    if (f && S.canSee(f)) return f
    f = bot.findBlock({ matching: S.blockIds(['furnace']), maxDistance: 40 })
    if (f) { const r = await S.goto(new goals.GoalLookAtBlock(f.position, bot.world, { reach: 3.5 }), { ms: 30000 }); const ff = S.furnaceNear(4.5); if (ff) return ff }
    if (!S.has('furnace')) { if (!(await S.craft('furnace', 1))) return null }
    return await S.placeWork('furnace')
  }
  S.fuelPlan = () => { // what to burn: coal/charcoal first, then planks, then logs
    const inv = {}; for (const it of bot.inventory.items()) inv[it.name] = (inv[it.name] || 0) + it.count
    for (const n of ['coal', 'charcoal']) if (inv[n]) return { name: n, per: 8, have: inv[n] }
    for (const n of Object.keys(inv)) if (PLANK_RE.test(n)) return { name: n, per: 1.5, have: inv[n] }
    for (const n of Object.keys(inv)) if (LOG_RE.test(n) && !/stripped/.test(n)) return { name: n, per: 1.5, have: inv[n] }
    return null
  }
  // Smelt `n` of `input` (item name). Blocks until done (abortable). Returns number produced.
  S.smelt = async (input, n, { keepFuelLogs = 0 } = {}) => {
    const have = S.count(input); n = Math.min(n, have)
    if (n <= 0) return 0
    const fuel = S.fuelPlan(); if (!fuel) return 0
    const furnaceBlock = await S.ensureFurnace(); if (!furnaceBlock) return 0
    S.closeWindows()
    let f
    try { f = await bot.openFurnace(furnaceBlock) } catch (e) { log('FURNACE_OPEN_FAIL', e.message); return 0 }
    const inItem = mcData.itemsByName[input]
    let produced = 0
    try {
      // a furnace left with output or another input in it refused the new load ('destination full', torches failed x5): empty it first
      try { if (f.outputItem()) await f.takeOutput() } catch {}
      try { const li = f.inputItem(); if (li && li.name !== input) await f.takeInput() } catch {}
      try { const fi = f.fuelItem(); if (fi && fi.name !== fuel.name) await f.takeFuel() } catch {}
      const need = Math.ceil(n / fuel.per)
      const fuelItem = mcData.itemsByName[fuel.name]
      await f.putFuel(fuelItem.id, null, Math.min(need + (fuel.per < 2 ? 1 : 0), fuel.have))
      await f.putInput(inItem.id, null, n)
      const t0 = now(), limit = n * 10500 + 15000
      while (now() - t0 < limit) {
        await S.wait(1000)
        const out = f.outputItem()
        if (out && out.count >= n) break
        S.progress(`smelting ${input} ${out ? out.count : 0}/${n}`)
      }
      const out = f.outputItem()
      if (out) { produced = out.count; await f.takeOutput() }
      try { const left = f.inputItem(); if (left) await f.takeInput() } catch {}
      try { const fl = f.fuelItem(); if (fl) await f.takeFuel() } catch {}
    } catch (e) { if (S.isAbort(e)) { try { f.close() } catch {} ; throw e } log('SMELT_ERR', e.message) }
    try { f.close() } catch {}
    return produced
  }

  // ---------- eating ----------
  S.eat = async () => {
    if (bot.food >= 18) return false
    let best = null
    for (const it of bot.inventory.items()) {
      const f = FOOD_VALUE[it.name]; if (!f || RAW_MEAT.includes(it.name)) continue
      if (['golden_carrot'].includes(it.name)) continue
      if (!best || f > FOOD_VALUE[best.name]) best = it
    }
    if (!best) return false
    try { await bot.equip(best, 'hand'); await bot.consume(); return true } catch (e) { return false }
  }

  // ---------- hunting ----------
  S.animals = (kinds = Object.keys(PASSIVE_FOOD), radius = 40) => {
    const me = bot.entity.position, out = []
    for (const e of Object.values(bot.entities)) {
      if (!e || !e.position || e === bot.entity) continue
      if (!kinds.includes(e.name)) continue
      const d = e.position.distanceTo(me); if (d > radius) continue
      if (e.metadata && e.metadata.some && false) continue
      if (!S.canSee(e)) continue
      out.push({ e, d })
    }
    return out.sort((a, b) => a.d - b.d).map(o => o.e)
  }
  S.bestWeapon = async () => {
    const order = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword', 'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe']
    for (const n of order) { const it = bot.inventory.items().find(i => i.name === n); if (it) { await bot.equip(it, 'hand').catch(() => {}); return it } }
    return null
  }
  S.kill = async (e, { ms = 25000 } = {}) => {
    const t0 = now()
    await S.bestWeapon()
    try { await api.safehand.ensureSafeForMove() } catch {}
    S.setMoves(false)
    while (now() - t0 < ms) {
      S.check()
      if (!bot.entities[e.id] || e.isValid === false) { S.stats.killed++; break }
      const d = e.position.distanceTo(bot.entity.position)
      if (d > 3.2) {
        bot.pathfinder.setGoal(new goals.GoalFollow(e, 2), true)
        await S.wait(300)
      } else {
        bot.pathfinder.setGoal(null)
        if (S.canSee(e)) { try { await bot.lookAt(e.position.offset(0, e.height * 0.6, 0), true); bot.attack(e) } catch {} }
        await S.wait(550)
      }
    }
    S.stopMoving()
    await S.wait(400)
    await S.pickup(10, 6000)
  }

  // ---------- safe tunnelling ----------
  // Clear one cell of a tunnel safely. Returns 'ok' | 'lava' | 'water' | 'fail'.
  S.clearCell = async (p) => {
    const b = S.block(p)
    if (!b) return 'fail'
    if (S.passable(b)) return 'ok'
    if (b.name === 'lava') return 'lava'
    if (b.name === 'water') return 'water'
    const h = S.hazardNear(p, 1)
    if (h.lava) return 'lava'
    if (h.water) return 'water'
    if (!(await S.approach(b, { dig: false, tries: 2 }))) return 'fail'
    if (!(await S.digBlock(b, { force: !CANT_BREAK.test(b.name) }))) return 'fail'
    // a gravel/sand column above refills the cell as it falls: keep digging until the cell stays open (walking into falling gravel suffocated the bot 4 times)
    for (let i = 0; i < 12; i++) {
      await S.wait(350)
      const nb = S.block(p)
      if (!nb || S.passable(nb)) return 'ok'
      if (!/gravel|sand|concrete_powder|suspicious/.test(nb.name)) return 'ok'
      if (!(await S.digBlock(nb, { force: true }))) return 'fail'
    }
    return S.passable(S.block(p)) ? 'ok' : 'fail'
  }

  // Nearby dangerous things
  S.hostilesNear = (r = 16) => {
    const me = bot.entity.position, out = []
    for (const e of Object.values(bot.entities)) {
      if (!e || !e.position || e === bot.entity) continue
      if (!HOSTILE.test(e.name || '')) continue
      // a calm enderman is no threat (metadata 17/18: angry/staring); counting it held the cave reflex on for 14 minutes (03:49)
      if (e.name === 'enderman') { const md = e.metadata || []; if (md[17] !== true && md[18] !== true) continue }
      if (e.position.distanceTo(me) <= r) out.push(e)
    }
    return out
  }
  S.isNight = () => { const t = bot.time && bot.time.timeOfDay; return t != null && t >= 12700 && t <= 23300 }
  S.underground = () => { const p = bot.entity.position; const top = bot.world.getColumn ? null : null; return p.y < 55 || !S.skyVisible() }
  S.skyVisible = () => {
    const p = flo(bot.entity.position)
    for (let y = p.y + 2; y < Math.min(p.y + 40, 320); y++) { const b = S.block(v(p.x, y, p.z)); if (b && b.boundingBox === 'block') return false }
    return true
  }
  S.dist = (p) => bot.entity.position.distanceTo(p)

  return S
}

module.exports.consts = { AIR, LOG_RE, PLANK_RE, ORE_RE, CANT_BREAK, SIX, HORIZ, FOOD_VALUE, RAW_MEAT, HOSTILE, PASSIVE_FOOD, SMELT_OF }
