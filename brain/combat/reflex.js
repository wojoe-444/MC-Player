// Real-time combat reflex layer, ported from the arena benchmark (arena/combat_v3.js). Runs on every physics tick (20/s), pure code, no LLM in the loop.
// create(bot, overrides, hooks) -> { stop, stats, P, events, engaged() }. DEFAULTS = best-on-both brain (swarm-only kite and escape):
//   fastswing + kite from 5 mobs + encirclement escape from 6 mobs + wallAware + glassBlocksLos + organize  (numbers: brain/combat/README.md, arena/RESULTS.md).
// Base-world rules: never digs or places blocks (fireTrap is OFF), never chats, never uses slash commands. Callers must keep the bot from holding a lava bucket.
// Navigation hand-off: pass { yieldIdle: true } so this layer leaves the controls alone when nothing can hurt the bot, and use engaged() to pause the pathfinder.
// Threat assessment is a separate swappable function (threat.js): P.assess.
const bowMath = require('../safety/bow')
const { Vec3 } = require('vec3')
const gear = require('../safety/gear')
const threatMod = require('./threat')

const DEFAULTS = {
  scanRange: 32,
  reach: 3.0,              // max eye-to-hitbox distance for a melee swing
  attackTicks: 10,         // ticks between full-strength swings (iron sword)
  critJump: false,          // jump and hit while falling for a critical
  backAfterHit: 4, hugRange: 0.9 /* practically inside the mob: swing at once (no crit-jump wait) and step out */,         // ticks to back away after a swing (S-tap, avoids return hits)
  strafe: true, strafePeriod: 22,
  approachRange: 14,       // walk toward hostiles inside this range; beyond it, wait
  approachRanged: 24,      // skeletons are approached from further away
  sprintApproach: true,
  // shield
  shieldArrows: true, shieldCreeper: true, shieldMelee: false, shieldMeleeHealth: 10,
  shieldDropTicks: 3, guardMelee: true /* keep the shield up against arrows even while meleeing (drops only to swing) */, shieldSkel: true /* shield up whenever a skeleton has line of sight within shieldSkelRange (drawing flag is not observable) */, shieldSkelRange: 24, skeletonFirst: true, skeletonFirstRange: 22,      // ticks before a swing that the shield comes down
  // bow
  bow: true, bowMin: 9, bowMax: 30, bowDraw: 21, bowNoMeleeRange: 7,
  // creepers
  shieldVerify: false /* re-raise the shield if the server says we are not using it */, crowdEvadeN: 0 /* when this many melee mobs are within 3.2 blocks, break away for retreatTicks (short burst, cooldown crowdGap); 0 = off */, crowdGap: 40, openMin: 0 /* kite and escape only when at least this many of 24 headings are wall-free for 6 blocks (0 = always) */, glassBlocksLos: true /* glass blocks line of sight for threat purposes: mobs behind glass cannot shoot or reach us */, routeWeight: 0 /* course mode: weight of the pull toward the next waypoint when choosing escape / kite headings (needs hooks.routeDir) */, wallAware: true /* avoid running into walls and only jump at one-block steps */, kiteMode: 'repulse' /* 'repulse' | 'gap' (steer through the least-blocked heading) */, encircleEscape: true /* sprint through the open sector when mobs hold encQuads+ of 4 quadrants */, encQuads: 3, encMinMobs: 6, encRange: 10, encTicks: 20, encGap: 50, kiteN: 5 /* steer away from the pack while fighting once this many non-archer mobs are within kiteRange; 0 = off */, kiteRange: 7, evadeRepulse: false, disengageEat: false /* when hurt: a short sprint away to open a gap, eat, then back into the fight (bounded, cooldown) */, deHealth: 10, deGap: 6, deRunTicks: 50, deCooldown: 200, fireTrap: false /* light fires on the ground between us and a crowd (needs flint_and_steel; places blocks, so arena/opt-in only) */, fireMinMobs: 2, fireGap: 24, fireDist: 2.2, fireSelfMin: 1.6, bowAggroOnly: false /* only shoot mobs that already have a target (do not wake calm ones) */, bowNearestFirst: false /* only shoot the nearest threat */, approachAggroOnly: false, creeperShieldKite: false /* while shielding a fusing creeper, still steer away from the pack */, creeperShieldAlone: false /* only freeze behind the shield for a fusing creeper when nothing else is on us */, organize: true /* on start (entering fight mode): wear armor, shield to off-hand, sword in hand, bow and food into the hotbar */, targetMode: 'nearest' /* 'nearest' | 'weakest' | 'rear' (mobs behind us first, then weakest) | 'rearnear' (mobs behind us first, then nearest) */, creeperEngage: 3.0, creeperFuseShield: 5.0, creeperPreShield: true /* legacy: shield whenever a creeper is within 4.2 */, creeperOnFuse: 'shield' /* 'shield' | 'flee' | 'hitflee' */, creeperFuseReact: 6,
  // health
  eatFood: 14, eatHealth: 14, eatSafeDist: 10, eatAbortDist: 4,
  retreatHealth: 6, retreatTicks: 14, retreatCooldown: 100, // short evasions only; endless fleeing is penalised by design (fleeTicks is logged)
  idleSprint: true,
  assess: threatMod.assess,
}

function mulberry(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 } }

function create(bot, overrides = {}, hooks = {}) {
  const P = { ...DEFAULTS, ...overrides }
  const rng = P.rngSeed != null ? mulberry(P.rngSeed ^ 0x9e3779b9) : Math.random   // benchmark runs are seeded; production is not
  const stats = { encEscapes: 0, kiteTicks: 0, organizeMoves: 0, organizeMs: 0, crowdEvades: 0, hits: 0, whiffs: 0, disengages: 0, deEats: 0, fires: 0, fireFails: 0, bowAtCalm: 0, shieldNoMeta: 0, shieldChecks: 0, shieldDrops: 0, rearPicks: 0, dbgS: [], fuseFlees: 0, primedSounds: 0, blasts: 0, blastsNear: 0, creeperKills: 0, dbgC: [], firstContactTick: null, hugTicks: 0, hugSwings: 0, dmgShielded: 0, dmgOpen: 0, shieldUps: 0, fleeTicks: 0, ticks: 0, dbg: [], arrowsSeen: 0, drawnSeen: 0, kills: 0, swings: 0, shots: 0, shieldBlocks: 0, eats: 0, retreats: 0, crits: 0 }
  const events = []
  const ev = (type, o) => { if (events.length < 600) events.push({ t: tickN, type, ...o }); hooks.event && hooks.event(type, o) }
  const tracks = new Map()                      // entity id -> { pos, tick, vel (blocks/tick) }
  let tickN = 0, lastSwing = -99, shielding = false, bowState = null, eatingUntil = 0, retreatUntil = 0, strafeDir = 1, strafeAt = 0
  let lastHealth = bot.health, lastTarget = null, lastTargetTick = 0, jumpedAt = -99, idleYaw = null
  const counted = new Set()
  const recentHit = new Map()                   // entity id -> tick we last attacked or shot at it

  // ---- inventory helpers ----
  const items = () => bot.inventory.items()
  const find = (re) => items().find(i => re.test(i.name))
  // another layer is placing a block right now (nav pillar): switching to the sword made it try to place the sword (20:25)
  // a mob in melee range beats a placing job: safety walling itself in held the cobblestone while a zombie killed OzoGo444 in four hits (08:26)
  let meleeClose = false
  const holdSlot = (it) => { if (!it) return false; { const h = bot._reflexes && bot._reflexes.heldByOther('hands', 'combat'); if (h && (h !== 'placer' || (/_sword$|_axe$/.test(it.name) && !meleeClose))) return false }   /* safehand holds the slot: nothing; a placing job: no weapon swap */ if (!bot._reflexes && (bot._placingUntil || 0) > Date.now() && /_sword$|_axe$/.test(it.name)) return false; const s = it.slot - 36; if (s >= 0 && s < 9) { if (bot.quickBarSlot !== s) bot.setQuickBarSlot(s); return true } return false }
  const sword = () => find(/_sword$/)
  const bowItem = () => find(/^bow$/)
  const arrows = () => items().filter(i => /arrow$/.test(i.name)).reduce((s, i) => s + i.count, 0)
  const food = () => items().find(i => /^(cooked_beef|cooked_porkchop|cooked_mutton|cooked_chicken|bread|golden_carrot|apple|baked_potato|cooked_salmon|cooked_cod)$/.test(i.name))
  const hasShield = () => { const o = bot.inventory.slots[45]; return !!o && o.name === 'shield' }

  function shield(on) {
    if (on === shielding) return
    if (on && !hasShield()) return
    shielding = on; if (on) stats.shieldUps++
    if (on) { bot.activateItem(true) } else { bot.deactivateItem() }
  }
  function control(c) {
    for (const k of ['forward', 'back', 'left', 'right', 'sprint', 'jump']) bot.setControlState(k, !!c[k])
  }
  function face(pos) { bot.lookAt(pos, true) }
  const aimPoint = (e) => e.position.offset(0, (e.height || 1.8) * 0.7, 0)

  function refreshTracks() {
    for (const e of Object.values(bot.entities)) {
      if (!e.position) continue
      const t = tracks.get(e.id)
      if (!t) { tracks.set(e.id, { pos: e.position.clone(), tick: tickN, vel: { x: 0, y: 0, z: 0 }, seen: tickN }); continue }
      const dt = tickN - t.tick
      if (e.position.x !== t.pos.x || e.position.y !== t.pos.y || e.position.z !== t.pos.z) {
        if (dt > 0) t.vel = { x: (e.position.x - t.pos.x) / dt, y: (e.position.y - t.pos.y) / dt, z: (e.position.z - t.pos.z) / dt }
        t.pos = e.position.clone(); t.tick = tickN
      } else if (dt > 4) t.vel = { x: 0, y: 0, z: 0 }
      t.seen = tickN
    }
    if (tickN % 200 === 0) for (const [id, t] of tracks) if (tickN - t.seen > 100) tracks.delete(id)
  }

  function onEntityGone(e) {
    if (!e) return
    const at = recentHit.get(e.id)
    if (at !== undefined && tickN - at < 80 && !counted.has(e.id)) { counted.add(e.id); stats.kills++; if (e.name === 'creeper') stats.creeperKills++; ev('kill', { mob: e.name }) }
  }
  function onDead(e) { onEntityGone(e) }
  bot.on('entityDead', onDead)
  const onGone = (e) => { if (e && e.name !== 'creeper') onEntityGone(e) }
  bot.on('entityGone', onGone)

  // ---- terrain awareness (walls): do not run into, or hop at, something that cannot be crossed ----
  const solidBody = (x, y, z) => { const b = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))); return !!b && b.boundingBox === 'block' }
  function wallDist(dx, dz, maxD) {   // distance along (dx,dz) to a block that is solid at BOTH body heights (a wall); a single block is a step, not a wall
    const p = bot.entity.position
    for (let d = 0.7; d <= maxD; d += 0.5) { const x = p.x + dx * d, z = p.z + dz * d; if (solidBody(x, p.y + 0.5, z) && solidBody(x, p.y + 1.5, z)) return d }
    return Infinity
  }
  function stepAhead(dx, dz) { const p = bot.entity.position, x = p.x + dx * 0.9, z = p.z + dz * 0.9; return solidBody(x, p.y + 0.5, z) && !solidBody(x, p.y + 1.5, z) && !solidBody(x, p.y + 2.5, z) }
  function freeDir(rx, rz) {   // nearest heading to (rx,rz) with no wall within 3 blocks
    const base = Math.atan2(rz, rx)
    for (const off of [0, 0.52, -0.52, 1.05, -1.05, 1.57, -1.57, 2.1, -2.1, 2.6, -2.6]) { const a = base + off, dx = Math.cos(a), dz = Math.sin(a); if (wallDist(dx, dz, 3) === Infinity) return { x: dx, z: dz } }
    return { x: rx, z: rz }
  }
  // How much room is there? Count of the 24 headings with no wall within 6 blocks (cached 4 ticks). Corridors and small rooms score low: running around in them only drags the pack along.
  let opCache = { t: -99, v: 24 }
  function openness() {
    if (tickN - opCache.t < 4) return opCache.v
    let n = 0; for (let k = 0; k < 24; k++) { const th = k * Math.PI / 12; if (wallDist(Math.cos(th), Math.sin(th), 6) === Infinity) n++ }
    opCache = { t: tickN, v: n }; return n
  }
  // Pattern-aware escape direction: find the least-blocked heading by looking at where ALL mobs are (not just the adjacent ones).
  // Returns { x, z (unit heading), quads (how many of the 4 quadrants hold a mob within range), cost }.
  function openHeading(threats, range) {
    const pos = bot.entity.position, mobs = []
    for (const t of threats) { if (t.kind === 'ranged' || t.d > range) continue; const dx = t.e.position.x - pos.x, dz = t.e.position.z - pos.z; mobs.push({ a: Math.atan2(dz, dx), d: Math.hypot(dx, dz) || 0.5 }) }
    const q = new Set(mobs.map(m => Math.floor(((m.a + Math.PI) / (Math.PI / 2))) % 4))
    let best = null
    for (let k = 0; k < 24; k++) {
      const th = k * Math.PI / 12; let cost = 0
      for (const m of mobs) { const cs = Math.cos(th - m.a); if (cs > 0) cost += Math.exp(-m.d / 5) * cs * cs }   // a mob ahead of this heading blocks it, nearer ones more
      if (P.wallAware) { const wd = wallDist(Math.cos(th), Math.sin(th), 7); if (wd < 7) cost += 3 * (1 - wd / 7) + (wd < 2 ? 4 : 0) }
      if (P.routeWeight && hooks.routeDir) { const rd = hooks.routeDir(); if (rd) cost -= P.routeWeight * Math.max(0, Math.cos(th - Math.atan2(rd.z, rd.x))) }   // prefer escaping toward the goal
      if (!best || cost < best.cost) best = { x: Math.cos(th), z: Math.sin(th), cost }
    }
    return { x: best ? best.x : 0, z: best ? best.z : 0, quads: q.size, cost: best ? best.cost : 0, n: mobs.length }
  }

  // ---- fight mode entry: put the loadout in order whatever the inventory looks like ----
  let organizing = false
  async function organize() {
    organizing = true; const t0 = Date.now()
    try {
      const worn = { head: bot.inventory.slots[5], torso: bot.inventory.slots[6], legs: bot.inventory.slots[7], feet: bot.inventory.slots[8] }
      for (const up of gear.armorUpgrades(items(), worn)) { await bot.equip(up.item, up.slot); stats.organizeMoves++ }
      const sh = bot.inventory.slots[45]
      if (!sh || sh.name !== 'shield') { const it = find(/^shield$/); if (it) { await bot.equip(it, 'off-hand'); stats.organizeMoves++ } }
      const sw = sword(); if (sw) { await bot.equip(sw, 'hand'); stats.organizeMoves++ }
      for (const it of [bowItem(), food()]) {
        if (it && !(it.slot >= 36 && it.slot <= 44)) {
          const used = new Set(items().filter(i => i.slot >= 36 && i.slot <= 44).map(i => i.slot))
          let dest = -1; for (let s = 44; s >= 36; s--) if (!used.has(s) && s - 36 !== bot.quickBarSlot) { dest = s; break }
          if (dest < 0) dest = 44
          await bot.moveSlotItem(it.slot, dest); stats.organizeMoves++
        }
      }
    } catch (err) { ev('organize-error', { m: String(err.message).slice(0, 80) }) }
    stats.organizeMs = Date.now() - t0; organizing = false
  }
  if (P.organize) organize()

  // ---- one tick ----
  function step() {
    const me = bot.entity
    if (!me || bot.health <= 0 || !bot.entity.position) return
    if (organizing) { control({}); return }
    // brain/breath owns the movement controls while it gets the bot out of the water or air: fighting drowned while swimming killed it (18:37).
    // With the reflex registry that is the `body` lease; without one (arena harness) the old flag.
    { const bodyBy = bot._reflexes ? bot._reflexes.heldByOther('body', 'combat') : ((bot._ashoreUntil || 0) > Date.now() ? 'ashore' : null)
      if (bodyBy) {
        // a record when this costs a fight: who held the body while a hostile was in reach (two cave deaths 2026-11-05 without a swing)
        try { const me2 = bot.entity.position; const m = Object.values(bot.entities).find(x => x !== bot.entity && x.position && /zombie|skeleton|spider|husk|drowned|stray|creeper|witch|pillager|vindicator|slime|silverfish|cave_spider/.test(x.name || '') && x.position.distanceTo(me2) < 3.5)
          if (m && Date.now() - (bot._combatYieldLogAt || 0) > 10000) { bot._combatYieldLogAt = Date.now(); ev('yield', { body: bodyBy, mob: m.name, d: +m.position.distanceTo(me2).toFixed(1) }) } } catch {}
        return } }
    if (hp0 === null) hp0 = bot.health
    tickN++; stats.ticks++
    refreshTracks()
    const pos = me.position
    // verify the server really has us blocking (the self metadata flag 'using item'); if we think the shield is up but it is not, raise it again
    if (shielding && tickN % 3 === 0) { const f = bot.entity.metadata && bot.entity.metadata[8]; stats.shieldChecks++; if (typeof f === 'number' && !(f & 1)) { stats.shieldDrops++; if (P.shieldVerify) bot.activateItem(true) } else if (typeof f !== 'number') stats.shieldNoMeta++ }
    const { threats, arrows: inbound } = P.assess(bot, tracks, P)
    const live = threats.filter(t => t.canHurt)
    // melee only: a creeper close by is a reason to wall in or back off, not to hold the sword over the placer
    meleeClose = live.some(t => t.kind === 'melee' && t.d < 3.5); bot._meleeClose = meleeClose; bot._meleeCloseAt = Date.now()
    behTicks[beh] = (behTicks[beh] || 0) + 1
    // ---- flight recorder ----
    const ar = inbound.length
    if (hp0 > bot.health + 0.01) {
      const amt = hp0 - bot.health
      const m3 = threats.filter(t => t.reach < 3.2).length, m8 = threats.filter(t => t.d < 8).length
      const cand = threats.slice().sort((a, b) => a.reach - b.reach).slice(0, 3).map(t => [t.name, +t.reach.toFixed(1), t.los ? 1 : 0, ((t.e.metadata && (t.e.metadata[15] | 0) & 4) ? 1 : 0)])
      const src = tickN - lastBlastTick <= 6 ? 'blast' : (ar || threats.some(t => t.kind === 'ranged' && t.los && t.d > 4 && t.d < 26)) && !threats.some(t => t.kind === 'melee' && t.reach < 2.6) ? 'arrow' : threats.some(t => t.reach < 3.2) ? 'melee' : 'unknown'
      if (dmgLog.length < 300) dmgLog.push({ t: tickN, amt: +amt.toFixed(1), hp: +bot.health.toFixed(1), src, shield: shielding, beh, m3, m8, ar, sinceSwing: tickN - lastSwing, cand })
    }
    hp0 = bot.health
    if (tickN % 4 === 0 && trace.length < 1500) {
      const p = bot.entity.position, near3 = threats.slice().sort((a, b) => a.reach - b.reach).slice(0, 3).map(t => [t.name, +t.reach.toFixed(1), t.los ? 1 : 0])
      trace.push({ t: tickN, x: startPos ? +(p.x - startPos.x).toFixed(1) : 0, z: startPos ? +(p.z - startPos.z).toFixed(1) : 0, hp: +bot.health.toFixed(1), f: bot.food, sh: shielding ? 1 : 0, beh, held: bot.heldItem ? bot.heldItem.name : null, n3: threats.filter(t => t.reach < 3.2).length, n8: threats.filter(t => t.d < 8).length, n16: threats.filter(t => t.d < 16).length, sk: threats.filter(t => t.kind === 'ranged' && t.los).length, ar, near: near3 })
    }
    for (let i = pendingSwings.length - 1; i >= 0; i--) {
      const s = pendingSwings[i]; if (tickN - s.tick < 4) continue
      pendingSwings.splice(i, 1)
      const e2 = bot.entities[s.id]; const h2 = e2 && e2.metadata && typeof e2.metadata[9] === 'number' ? e2.metadata[9] : null
      const base = s.hp === null ? 20 : s.hp
      if (!e2 || (h2 !== null && h2 < base - 0.05)) stats.hits++; else stats.whiffs++
    }
    const c = { forward: false, back: false, left: false, right: false, sprint: false, jump: false }
    const hp = bot.health, food_ = bot.food
    if (tickN >= strafeAt) { strafeDir = rng() < 0.5 ? -1 : 1; strafeAt = tickN + P.strafePeriod * (0.7 + rng() * 0.6) }

    if (hp < lastHealth - 0.01) { if (shielding) stats.dmgShielded += lastHealth - hp; else stats.dmgOpen += lastHealth - hp }
    lastHealth = hp
    if (tickN % 60 === 0 && stats.dbg.length < 8) { const sk = threats.find(t => t.kind === 'ranged' && t.d < 20); if (sk) stats.dbg.push('skel md=' + JSON.stringify(sk.e.metadata).slice(0, 160) + ' d=' + sk.d.toFixed(1) + ' los=' + sk.los + ' arrows=' + inbound.length) }
    { const cr = threats.find(t => t.kind === 'creeper' && t.d < 8); if (cr && tickN % 4 === 0 && stats.dbgC.length < 40) stats.dbgC.push(tickN + ' d=' + cr.d.toFixed(1) + ' md16=' + JSON.stringify(cr.e.metadata && cr.e.metadata[16]) + ' md17=' + JSON.stringify(cr.e.metadata && cr.e.metadata[17]) + ' md18=' + JSON.stringify(cr.e.metadata && cr.e.metadata[18]) + ' fusing=' + cr.fusing + ' hp=' + bot.health.toFixed(1)) }
    for (const t of threats) if (t.kind === 'ranged' && t.d < 26 && stats.dbgS.length < 40) { const md = t.e.metadata || []; const sig = JSON.stringify([md[8], md[15], md[16], md[17], md[18]]); const prev = skelSig.get(t.e.id); if (prev !== sig) { skelSig.set(t.e.id, sig); stats.dbgS.push(tickN + ' id' + t.e.id + ' d=' + t.d.toFixed(0) + ' md8,15-18=' + sig + (t.drawing ? ' DRAWING' : '')) } }
    const isAggro = (t) => !!(t.e.metadata && ((t.e.metadata[15] | 0) & 4))   // Mob flag 'aggressive' = it has a target (observed on skeletons that were shooting)
    // mid-bow-draw: finish or abort
    if (bowState) { beh = 'bow-draw'; if (!stepBow(live)) { control(c); return } }

    if (stats.firstContactTick === null && (live.some(t => t.reach < 9) || hp < 19.9)) stats.firstContactTick = tickN
    if (primed && tickN - primed.tick < 34) for (const t of threats) if (t.kind === 'creeper' && Math.hypot(t.e.position.x - primed.x, t.e.position.z - primed.z) < 3.5) t.fusing = true
    const near = live.slice().sort((a, b) => a.reach - b.reach)
    const nearest = near[0]
    const nearMelee = near.filter(t => t.kind === 'melee' || (t.kind === 'creeper' && !t.fusing))
    const fusing = near.find(t => t.kind === 'creeper' && t.fusing && t.d < P.creeperFuseShield)
    const incoming = P.shieldArrows ? inbound.find(a => a.eta < 14) : null
    const drawnAt = P.shieldArrows ? near.find(t => t.kind === 'ranged' && t.drawing && t.d > 3.5 && t.d < 26) : null
    const skelGuard = P.shieldSkel && P.shieldArrows ? near.find(t => t.kind === 'ranged' && t.los && t.d < P.shieldSkelRange && t.d > 2.5) : null
    if (incoming) stats.arrowsSeen++
    if (drawnAt) stats.drawnSeen++

    // ---- disengage, eat, re-engage ----
    if (deRunUntil && eatingUntil <= tickN) {
      if (tickN >= deRunUntil || (nearest && nearest.reach >= P.deGap) || !nearest || !food()) {
        deRunUntil = 0
        const f = food()
        if (f && bot.food < 20 && !fusing && holdSlot(f)) { shield(false); bot.activateItem(); eatingUntil = tickN + 36; stats.eats++; stats.deEats++; ev('disengage-eat', { hp, gap: nearest ? +nearest.reach.toFixed(1) : null }); control(c); return }
      } else {
        let cx = 0, cz = 0; for (const t of nearMelee) { cx += t.e.position.x; cz += t.e.position.z }
        if (nearMelee.length) {
          cx /= nearMelee.length; cz /= nearMelee.length
          const dx = pos.x - cx, dz = pos.z - cz, n = Math.hypot(dx, dz) || 1
          beh = 'disengage'; shield(false); bot.look(Math.atan2(-(dx / n), -(dz / n)), 0, true)
          c.forward = true; c.sprint = true; stats.fleeTicks++
          if (P.wallAware ? (me.onGround && stepAhead(-(dx / n), -(dz / n)) === false && false) : (me.onGround && tickN % 12 === 0)) c.jump = true
          control(c); return
        }
      }
    } else if (P.disengageEat && !deRunUntil && eatingUntil <= tickN && hp <= P.deHealth && bot.food < 20 && !!food() && tickN >= deCoolUntil && nearMelee.length && !fusing) {
      deRunUntil = tickN + P.deRunTicks; deCoolUntil = tickN + P.deCooldown; stats.disengages++; ev('disengage', { hp: +hp.toFixed(1) })
    }
    // ---- fire trap: set fires between us and the crowd, never next to ourselves ----
    if (fireBusyUntil > tickN) { control(c); return }
    if (fireBusyUntil && fireBusyUntil <= tickN) { fireBusyUntil = 0; if (sword()) holdSlot(sword()) }
    if (P.fireTrap && !fusing && tickN - lastFire >= P.fireGap && nearMelee.length >= P.fireMinMobs && !(nearest && nearest.reach < 1.3)) {
      const flint = find(/^flint_and_steel$/)
      if (flint) {
        const mobs = nearMelee.filter(t => t.d < 6.5)
        if (mobs.length >= P.fireMinMobs) {
          let cx = 0, cz = 0; for (const t of mobs) { cx += t.e.position.x; cz += t.e.position.z }
          cx /= mobs.length; cz /= mobs.length
          const dx = cx - pos.x, dz = cz - pos.z, n = Math.hypot(dx, dz) || 1
          const tx = pos.x + dx / n * P.fireDist, tz = pos.z + dz / n * P.fireDist
          const ref = bot.blockAt(new Vec3(Math.floor(tx), Math.floor(pos.y) - 1, Math.floor(tz)))
          const above = ref && bot.blockAt(ref.position.offset(0, 1, 0))
          if (ref && ref.boundingBox === 'block' && above && above.name === 'air' && Math.hypot(above.position.x + 0.5 - pos.x, above.position.z + 0.5 - pos.z) >= P.fireSelfMin) {
            lastFire = tickN; fireBusyUntil = tickN + 5; stats.fires++; beh = 'fire'
            if (holdSlot(flint)) { bot.lookAt(ref.position.offset(0.5, 1, 0.5), true); bot.placeBlock(ref, new Vec3(0, 1, 0)).catch(() => { stats.fireFails++ }); ev('fire', { mobs: mobs.length }); control(c); return }
          }
        }
      }
    }
    // ---- eating ----
    if (eatingUntil > tickN) {
      if (nearest && nearest.reach < P.eatAbortDist) { bot.deactivateItem(); eatingUntil = 0; ev('eat-abort', {}) }
      else { beh = 'eat'; control({ ...c }); return }
    }
    const wantEat = (food_ <= P.eatFood || (hp <= P.eatHealth && food_ < 20)) && !!food()
    if (wantEat && !fusing && !incoming && (!nearest || nearest.reach > P.eatSafeDist)) {
      shield(false)
      const f = food(); if (holdSlot(f)) { bot.activateItem(); eatingUntil = tickN + 36; stats.eats++; ev('eat', { hp, food: food_ }); control(c); return }
    }

    // ---- no live threat: sprint on, shield down ----
    if (nearest) lastEngagedTick = tickN
    if (!nearest) {
      beh = 'idle'
      if (P.yieldIdle) { shield(false); if (sword()) holdSlot(sword()); return }   // course mode: hand the controls back to navigation
      shield(false)
      // only right after a fight: forcing the sword into the hand on every quiet tick broke pickaxe use, torches and scaffold placement
      if (sword() && tickN - lastEngagedTick < 40) holdSlot(sword())
      if (P.idleSprint) {
        // go for hostiles that are visible but not yet hurting us (approach), else keep heading
        const seen = threats.filter(t => t.los && (!P.approachAggroOnly || isAggro(t))).sort((a, b) => a.d - b.d)[0]
        if (seen && seen.d < P.approachRanged) face(aimPoint(seen.e)); else if (idleYaw !== null) bot.look(idleYaw, 0, true)
        c.forward = true; c.sprint = true
      }
      control(c); return
    }

    // ---- encirclement escape: when mobs hold most of the compass, run through the open sector before the ring closes ----
    if (P.encircleEscape && encUntil < tickN && encCool < tickN && !fusing && (!P.openMin || openness() >= P.openMin)) { const oh = openHeading(threats, P.encRange); if (oh.quads >= P.encQuads && oh.n >= P.encMinMobs) { encUntil = tickN + P.encTicks; encCool = tickN + P.encTicks + P.encGap; stats.encEscapes++; ev('encircle-escape', { n: oh.n, quads: oh.quads, hp: +hp.toFixed(1) }) } }
    if (encUntil > tickN && !fusing) {
      const oh = openHeading(threats, P.encRange + 4)
      beh = 'encircle-escape'; shield(false); bot.look(Math.atan2(-oh.x, -oh.z), 0, true)
      c.forward = true; c.sprint = true; if (P.wallAware ? (me.onGround && stepAhead(oh.x, oh.z)) : (me.onGround && tickN % 14 === 0)) c.jump = true
      stats.fleeTicks++
      const adj = nearest && nearest.reach < 1.4 && nearest.kind === 'melee' && oh.cost > 1.5
      if (!adj) { control(c); return }
    }
    // ---- retreat when low ----
    if (hp <= P.retreatHealth && nearMelee.length && retreatUntil + P.retreatCooldown < tickN && !fusing) { retreatUntil = tickN + P.retreatTicks; stats.retreats++; ev('retreat', { hp }) }
    if (P.crowdEvadeN && retreatUntil + P.crowdGap < tickN && !fusing && nearMelee.filter(t => t.reach < 3.2).length >= P.crowdEvadeN) { retreatUntil = tickN + P.retreatTicks; stats.crowdEvades++; ev('crowd-evade', { n: nearMelee.filter(t => t.reach < 3.2).length, hp: +hp.toFixed(1) }) }
    if (retreatUntil > tickN && nearMelee.length) {
      beh = 'retreat'
      let cx = 0, cz = 0; for (const t of nearMelee) { cx += t.e.position.x; cz += t.e.position.z }
      cx /= nearMelee.length; cz /= nearMelee.length
      let dx = pos.x - cx, dz = pos.z - cz, n = Math.hypot(dx, dz) || 1
      if (P.evadeRepulse) {   // push away from EVERY nearby threat (1/d^2 weighted), not just the adjacent crowd's centroid
        let rx = 0, rz = 0
        for (const t of threats) { if (t.d > 12 || t.kind === 'creeper' && !t.fusing && t.d > 6) continue; const ex = pos.x - t.e.position.x, ez = pos.z - t.e.position.z, ed = Math.hypot(ex, ez) || 0.5; const w = 1 / (ed * ed); rx += ex / ed * w; rz += ez / ed * w }
        const rn = Math.hypot(rx, rz); if (rn > 1e-6) { dx = rx; dz = rz; n = rn }
      }
      stats.fleeTicks++
      shield(false); bot.look(Math.atan2(-(dx / n), -(dz / n)), 0, true)
      c.forward = true; c.sprint = true
      // fight back only if cornered
      const adj = nearest && nearest.reach < 1.6 && nearest.kind === 'melee'
      if (!adj) { control(c); return }
    }

    // ---- creeper fusing: shield and hold (or hit it if it is in reach and we are not raising) ----
    if (fusing && P.creeperOnFuse !== 'shield' && fusing.d < P.creeperFuseReact) {
      beh = 'creeper-flee'
      // get out of the blast: damage falls off to nothing by ~6 blocks, and the fuse is only 1.5 s
      if (P.creeperOnFuse === 'hitflee' && fusing.reach <= P.reach && ready && !shielding) { doAttack(fusing.e, false); lastSwing = tickN }
      shield(false); stats.fuseFlees++
      const dx = pos.x - fusing.e.position.x, dz = pos.z - fusing.e.position.z, n = Math.hypot(dx, dz) || 1
      bot.look(Math.atan2(-(dx / n), -(dz / n)), 0, true); c.forward = true; c.sprint = true
      control(c); return
    }
    if (fusing && P.shieldCreeper && !(P.creeperShieldAlone && nearMelee.some(t => t.reach < 3.2))) {
      beh = 'creeper-shield'
      face(aimPoint(fusing.e)); shield(true)
      if (fusing.d > 2.2) c.back = false
      if (P.creeperShieldKite) {   // keep the shield up (walking is not slowed) but slip away from the pack instead of freezing
        let rx = 0, rz = 0
        for (const t of threats) { if (t.d > 12) continue; const ex = pos.x - t.e.position.x, ez = pos.z - t.e.position.z, ed = Math.hypot(ex, ez) || 0.5; const w = 1 / (ed * ed); rx += ex / ed * w; rz += ez / ed * w }
        const rn = Math.hypot(rx, rz)
        if (rn > 1e-6) { rx /= rn; rz /= rn; if (P.wallAware) { const fd = freeDir(rx, rz); rx = fd.x; rz = fd.z } const fx = -Math.sin(me.yaw), fz = -Math.cos(me.yaw), f = rx * fx + rz * fz, r = rx * -fz + rz * fx; c.forward = f > 0.35; c.back = f < -0.35; c.right = r > 0.35; c.left = r < -0.35; c.sprint = false; stats.kiteTicks++ }
      }
      control(c); return
    }

    // ---- target choice ----
    let target = null
    const closeMelee = nearMelee.filter(t => t.reach < P.reach + 2.5).sort((a, b) => a.reach - b.reach)
    const skel = P.skeletonFirst ? near.filter(t => t.kind === 'ranged' && t.reach < P.skeletonFirstRange).sort((a, b) => a.reach - b.reach)[0] : null
    const hpOf = (t) => (t.e.metadata && typeof t.e.metadata[9] === 'number') ? t.e.metadata[9] : 20
    const pickClose = (list) => {
      const mode = P.targetMode
      if (mode === 'nearest') return list[0]
      const fx = -Math.sin(me.yaw), fz = -Math.cos(me.yaw)
      const inReach = list.filter(t => t.reach <= P.reach + 0.8)
      if (mode === 'rear' || mode === 'rearnear') {
        const behind = inReach.filter(t => { const dx = t.e.position.x - pos.x, dz = t.e.position.z - pos.z, n = Math.hypot(dx, dz) || 1; return (dx * fx + dz * fz) / n < -0.2 })
        if (behind.length) { stats.rearPicks++; return behind.sort((a, b) => mode === 'rear' ? hpOf(a) - hpOf(b) || a.reach - b.reach : a.reach - b.reach)[0] }
      }
      if (inReach.length > 1 && mode !== 'rearnear') return inReach.sort((a, b) => hpOf(a) - hpOf(b) || a.reach - b.reach)[0]
      return list[0]
    }
    if (skel && !closeMelee.some(t => t.reach < 2.6)) target = skel
    else if (closeMelee.length) target = pickClose(closeMelee)
    else {
      const ranged = near.filter(t => t.kind === 'ranged')
      const rangedT = ranged.sort((a, b) => a.reach - b.reach)[0]
      const meleeT = nearMelee.sort((a, b) => a.reach - b.reach)[0]
      target = meleeT && (!rangedT || meleeT.reach < 12) ? meleeT : (rangedT || meleeT)
    }
    if (!target) { control(c); return }
    const e = target.e
    face(aimPoint(e))
    lastTarget = e.id; lastTargetTick = tickN
    const sinceSwing = tickN - lastSwing
    const ready = sinceSwing >= P.attackTicks

    // ---- bow at range ----
    if (P.bow && (!P.bowAggroOnly || isAggro(target)) && (!P.bowNearestFirst || !near.some(t => t !== target && t.reach < target.reach - 2)) && bowItem() && arrows() > 0 && !closeMelee.length && target.reach >= P.bowMin && target.reach <= P.bowMax &&
        (target.kind === 'ranged' || target.kind === 'creeper' || target.kind === 'melee') && target.los && !near.some(t => t.kind !== 'ranged' && t.reach < P.bowNoMeleeRange && t !== target)) {
      shield(false); beh = 'bow'
      if (holdSlot(bowItem())) { bowState = { t0: tickN, id: e.id }; if (!isAggro(target)) stats.bowAtCalm++; bot.activateItem(); ev('bow-draw', { mob: e.name, d: +target.reach.toFixed(1) }); control(c); return }
    }

    // ---- melee ----
    if (target.reach <= P.reach + 0.6) {
      beh = 'melee'
      if (sword()) holdSlot(sword())
      const inReach = target.reach <= P.reach
      const wantShieldUp = (P.guardMelee && !!(incoming || drawnAt || skelGuard) && !ready) || (P.shieldMelee && hp <= P.shieldMeleeHealth && sinceSwing < P.attackTicks - P.shieldDropTicks && !ready) || (P.creeperPreShield && target.kind === 'creeper' && P.shieldCreeper && target.d < 4.2 && !ready)
      if (shielding && (ready || !wantShieldUp)) shield(false)
      else if (!shielding && wantShieldUp && !ready) shield(true)
      if (inReach && ready && !shielding) {
        const falling = !me.onGround && me.velocity.y < -0.05
        if (target.reach < P.hugRange) { doAttack(e, false); lastSwing = tickN; stats.hugSwings++ }
        else if (P.critJump && target.kind !== 'creeper') {
          if (falling) { doAttack(e, true); lastSwing = tickN }
          else if (me.onGround && tickN - jumpedAt > 8 && sinceSwing >= P.attackTicks - 1) { c.jump = true; jumpedAt = tickN }
          else if (me.onGround && sinceSwing >= P.attackTicks + 7) { doAttack(e, false); lastSwing = tickN }
        } else { doAttack(e, false); lastSwing = tickN }
      }
      if (target.reach < P.hugRange) { stats.hugTicks++; c.back = true; c.forward = false; c.sprint = false }
      // spacing: back off briefly after a swing, strafe otherwise
      if (tickN - lastSwing < P.backAfterHit && target.reach < 2.2) c.back = true
      else if (target.reach > P.reach - 0.3 && !shielding) { c.forward = true; c.sprint = !shielding }
      if (P.strafe) { if (strafeDir > 0) c.right = true; else c.left = true }
      // kite: keep facing and hitting the target, but steer (back / strafe keys) away from the whole pack so mobs trail in a line instead of surrounding us
      if (P.kiteN && threats.filter(t => t.d < P.kiteRange && t.kind !== 'ranged').length >= P.kiteN && !shielding && (!P.openMin || openness() >= P.openMin)) {
        let rx = 0, rz = 0
        if (P.kiteMode === 'gap') { const oh = openHeading(threats, 16); rx = oh.x; rz = oh.z } else for (const t of threats) { if (t.d > 12) continue; const ex = pos.x - t.e.position.x, ez = pos.z - t.e.position.z, ed = Math.hypot(ex, ez) || 0.5; const w = 1 / (ed * ed); rx += ex / ed * w; rz += ez / ed * w }
        const rn = Math.hypot(rx, rz)
        if (rn > 1e-6) {
          rx /= rn; rz /= rn
          if (P.routeWeight && hooks.routeDir) { const rd = hooks.routeDir(); if (rd) { rx += P.routeWeight * rd.x; rz += P.routeWeight * rd.z; const nn = Math.hypot(rx, rz) || 1; rx /= nn; rz /= nn } }   // keep kiting toward the goal
          if (P.wallAware) { const fd = freeDir(rx, rz); rx = fd.x; rz = fd.z }
          const fx = -Math.sin(me.yaw), fz = -Math.cos(me.yaw), f = rx * fx + rz * fz, r = rx * -fz + rz * fx
          c.forward = f > 0.35 && target.reach > 1.2; c.back = f < -0.35; c.right = r > 0.35; c.left = r < -0.35; c.sprint = false
          if (!c.forward && !c.back && !c.right && !c.left) c.back = target.reach < 2.4
          stats.kiteTicks++
        }
      }
      control(c); return
    }

    // ---- approach / hold ----
    const lim = target.kind === 'ranged' ? P.approachRanged : P.approachRange
    beh = 'approach'
    if (incoming || drawnAt || skelGuard) { shield(true) } else if (shielding && !fusing) shield(false)
    if (target.reach < lim && (!P.approachAggroOnly || isAggro(target))) {
      if (!shielding) { c.forward = true; c.sprint = P.sprintApproach }
      else c.forward = true
      if (P.strafe && target.reach > 4) { if (strafeDir > 0) c.right = true; else c.left = true }
    }
    control(c)
  }

  function doAttack(e, crit) {
    if (bot._thornsMobs && bot._thornsMobs.has(e.id)) { stats.thornsSkips = (stats.thornsSkips || 0) + 1; return }   // Thorns armor (threat.js already drops it as a target; belt and braces)
    try { pendingSwings.push({ tick: tickN, id: e.id, hp: e.metadata && typeof e.metadata[9] === 'number' ? e.metadata[9] : null, reach: 0 }); bot.attack(e); stats.swings++; if (crit) stats.crits++; recentHit.set(e.id, tickN) } catch (err) { ev('attack-error', { m: String(err.message).slice(0, 80) }) }
  }

  // Returns true when the bow sequence is over and the normal logic should run this tick.
  function stepBow(live) {
    const e = bot.entities[bowState.id]
    const age = tickN - bowState.t0
    const closeThreat = live.find(t => t.reach < 5 && t.kind !== 'ranged')
    if (!e || !e.position || closeThreat) { bot.deactivateItem(); bowState = null; return true }
    const eye = bot.entity.position.offset(0, 1.62, 0)
    const tr = tracks.get(e.id); const vel = tr ? { x: tr.vel.x * 20, y: 0, z: tr.vel.z * 20 } : undefined
    const aim = bowMath.solveAim(eye, aimPointRaw(e), vel)
    if (aim) bot.look(aim.yaw, aim.pitch, true); else face(aimPoint(e))
    if (age >= P.bowDraw) { bot.deactivateItem(); stats.shots++; recentHit.set(e.id, tickN); ev('bow-shot', { mob: e.name }); bowState = null; if (sword()) holdSlot(sword()); return false }
    return false
  }
  const aimPointRaw = (e) => ({ x: e.position.x, y: e.position.y + (e.height || 1.8) * 0.6, z: e.position.z })

  const onTick = () => { try { step() } catch (err) { ev('error', { m: String(err.stack || err).split('\n').slice(0, 2).join(' | ').slice(0, 200) }) } }
  let lastEngagedTick = -99
  let deRunUntil = 0, deCoolUntil = 0, encUntil = 0, encCool = 0
  let beh = 'start', hp0 = null
  const trace = [], dmgLog = [], behTicks = {}, pendingSwings = [], startPos = bot.entity ? bot.entity.position.clone() : null
  let lastBlastTick = -99
  let lastFire = -999, fireBusyUntil = 0
  const skelSig = new Map()
  const onSkelSound = (name, pt) => { if (/skeleton.(shoot|ambient|step)/.test(String(name)) && /shoot/.test(String(name)) && stats.dbgS.length < 40) stats.dbgS.push(tickN + ' SOUND ' + name + ' at d=' + Math.hypot(pt.x - bot.entity.position.x, pt.z - bot.entity.position.z).toFixed(0)) }
  bot.on('soundEffectHeard', onSkelSound)
  let primed = null
  const onSound = (name, pt) => { if (/creeper.primed/.test(String(name))) { primed = { tick: tickN, x: pt.x, y: pt.y, z: pt.z }; stats.primedSounds++ } }
  bot.on('soundEffectHeard', onSound)
  const onExplosion = (p) => { const me = bot.entity && bot.entity.position; if (!me) return; const d = Math.hypot((p.x ?? p.center?.x) - me.x, (p.y ?? p.center?.y) - me.y, (p.z ?? p.center?.z) - me.z); stats.blasts++; lastBlastTick = tickN; if (d < 7) { stats.blastsNear++; ev('blast', { d: +d.toFixed(1), hp: +bot.health.toFixed(1), shield: shielding }) } }
  bot._client.on('explosion', onExplosion)
  const onStatus = (p) => { if (p.entityId === bot.entity.id && p.entityStatus === 29) { stats.shieldBlocks++ } }
  bot._client.on('entity_status', onStatus)
  bot.on('physicsTick', onTick)
  idleYaw = rng() * Math.PI * 2

  return {
    P, stats, events, trace, dmgLog, behTicks, engaged: () => tickN - lastEngagedTick <= 8,
    setIdleYaw(y) { idleYaw = y },
    stop() {
      bot.removeListener('physicsTick', onTick); bot._meleeClose = false; bot.removeListener('entityDead', onDead); bot.removeListener('entityGone', onGone)
      bot._client.removeListener('entity_status', onStatus); bot.removeListener('soundEffectHeard', onSound); bot.removeListener('soundEffectHeard', onSkelSound); bot._client.removeListener('explosion', onExplosion)
      control({}); try { if (shielding) bot.deactivateItem() } catch {}
    },
  }
}

module.exports = { create, DEFAULTS }
