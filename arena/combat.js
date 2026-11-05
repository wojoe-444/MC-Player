// Real-time combat reflex layer. Runs on every physics tick (20/s), pure code, no LLM in the loop.
// create(bot, overrides) -> { stop, stats, P, events }. Tunables live in DEFAULTS (arena/params.json overrides them).
// Threat assessment is a separate swappable function (threat.js): P.assess.
const bowMath = require('../brain/safety/bow')
const threatMod = require('./threat')

const DEFAULTS = {
  scanRange: 32,
  reach: 3.0,              // max eye-to-hitbox distance for a melee swing
  attackTicks: 13,         // ticks between full-strength swings (iron sword)
  critJump: true,          // jump and hit while falling for a critical
  backAfterHit: 4, hugRange: 0.9 /* practically inside the mob: swing at once (no crit-jump wait) and step out */,         // ticks to back away after a swing (S-tap, avoids return hits)
  strafe: true, strafePeriod: 22,
  approachRange: 14,       // walk toward hostiles inside this range; beyond it, wait
  approachRanged: 24,      // skeletons are approached from further away
  sprintApproach: true,
  // shield
  shieldArrows: true, shieldCreeper: true, shieldMelee: false, shieldMeleeHealth: 10,
  shieldDropTicks: 3, guardMelee: true /* keep the shield up against arrows even while meleeing (drops only to swing) */, skeletonFirst: true, skeletonFirstRange: 22,      // ticks before a swing that the shield comes down
  // bow
  bow: true, bowMin: 9, bowMax: 30, bowDraw: 21, bowNoMeleeRange: 7,
  // creepers
  creeperEngage: 3.0, creeperFuseShield: 5.0,
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
  const stats = { firstContactTick: null, hugTicks: 0, hugSwings: 0, dmgShielded: 0, dmgOpen: 0, shieldUps: 0, fleeTicks: 0, ticks: 0, dbg: [], arrowsSeen: 0, drawnSeen: 0, kills: 0, swings: 0, shots: 0, shieldBlocks: 0, eats: 0, retreats: 0, crits: 0 }
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
  const holdSlot = (it) => { if (!it) return false; const s = it.slot - 36; if (s >= 0 && s < 9) { if (bot.quickBarSlot !== s) bot.setQuickBarSlot(s); return true } return false }
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
    if (at !== undefined && tickN - at < 80 && !counted.has(e.id)) { counted.add(e.id); stats.kills++; ev('kill', { mob: e.name }) }
  }
  function onDead(e) { onEntityGone(e) }
  bot.on('entityDead', onDead)
  const onGone = (e) => { if (e && e.name !== 'creeper') onEntityGone(e) }
  bot.on('entityGone', onGone)

  // ---- one tick ----
  function step() {
    const me = bot.entity
    if (!me || bot.health <= 0 || !bot.entity.position) return
    tickN++; stats.ticks++
    refreshTracks()
    const pos = me.position
    const { threats, arrows: inbound } = P.assess(bot, tracks, P)
    const live = threats.filter(t => t.canHurt)
    const c = { forward: false, back: false, left: false, right: false, sprint: false, jump: false }
    const hp = bot.health, food_ = bot.food
    if (tickN >= strafeAt) { strafeDir = rng() < 0.5 ? -1 : 1; strafeAt = tickN + P.strafePeriod * (0.7 + rng() * 0.6) }

    if (hp < lastHealth - 0.01) { if (shielding) stats.dmgShielded += lastHealth - hp; else stats.dmgOpen += lastHealth - hp }
    lastHealth = hp
    if (tickN % 60 === 0 && stats.dbg.length < 8) { const sk = threats.find(t => t.kind === 'ranged' && t.d < 20); if (sk) stats.dbg.push('skel md=' + JSON.stringify(sk.e.metadata).slice(0, 160) + ' d=' + sk.d.toFixed(1) + ' los=' + sk.los + ' arrows=' + inbound.length) }
    // mid-bow-draw: finish or abort
    if (bowState) { if (!stepBow(live)) { control(c); return } }

    if (stats.firstContactTick === null && (live.some(t => t.reach < 9) || hp < 19.9)) stats.firstContactTick = tickN
    const near = live.slice().sort((a, b) => a.reach - b.reach)
    const nearest = near[0]
    const nearMelee = near.filter(t => t.kind === 'melee' || (t.kind === 'creeper' && !t.fusing))
    const fusing = near.find(t => t.kind === 'creeper' && t.fusing && t.d < P.creeperFuseShield)
    const incoming = P.shieldArrows ? inbound.find(a => a.eta < 14) : null
    const drawnAt = P.shieldArrows ? near.find(t => t.kind === 'ranged' && t.drawing && t.d > 3.5 && t.d < 26) : null
    if (incoming) stats.arrowsSeen++
    if (drawnAt) stats.drawnSeen++

    // ---- eating ----
    if (eatingUntil > tickN) {
      if (nearest && nearest.reach < P.eatAbortDist) { bot.deactivateItem(); eatingUntil = 0; ev('eat-abort', {}) }
      else { control({ ...c }); return }
    }
    const wantEat = (food_ <= P.eatFood || (hp <= P.eatHealth && food_ < 20)) && !!food()
    if (wantEat && !fusing && !incoming && (!nearest || nearest.reach > P.eatSafeDist)) {
      shield(false)
      const f = food(); if (holdSlot(f)) { bot.activateItem(); eatingUntil = tickN + 36; stats.eats++; ev('eat', { hp, food: food_ }); control(c); return }
    }

    // ---- no live threat: sprint on, shield down ----
    if (!nearest) {
      shield(false)
      if (sword()) holdSlot(sword())
      if (P.idleSprint) {
        // go for hostiles that are visible but not yet hurting us (approach), else keep heading
        const seen = threats.filter(t => t.los).sort((a, b) => a.d - b.d)[0]
        if (seen && seen.d < P.approachRanged) face(aimPoint(seen.e)); else if (idleYaw !== null) bot.look(idleYaw, 0, true)
        c.forward = true; c.sprint = true
      }
      control(c); return
    }

    // ---- retreat when low ----
    if (hp <= P.retreatHealth && nearMelee.length && retreatUntil + P.retreatCooldown < tickN && !fusing) { retreatUntil = tickN + P.retreatTicks; stats.retreats++; ev('retreat', { hp }) }
    if (retreatUntil > tickN && nearMelee.length) {
      let cx = 0, cz = 0; for (const t of nearMelee) { cx += t.e.position.x; cz += t.e.position.z }
      cx /= nearMelee.length; cz /= nearMelee.length
      const dx = pos.x - cx, dz = pos.z - cz, n = Math.hypot(dx, dz) || 1
      stats.fleeTicks++
      shield(false); bot.look(Math.atan2(-(dx / n), -(dz / n)), 0, true)
      c.forward = true; c.sprint = true
      // fight back only if cornered
      const adj = nearest && nearest.reach < 1.6 && nearest.kind === 'melee'
      if (!adj) { control(c); return }
    }

    // ---- creeper fusing: shield and hold (or hit it if it is in reach and we are not raising) ----
    if (fusing && P.shieldCreeper) {
      face(aimPoint(fusing.e)); shield(true)
      if (fusing.d > 2.2) c.back = false
      control(c); return
    }

    // ---- target choice ----
    let target = null
    const closeMelee = nearMelee.filter(t => t.reach < P.reach + 2.5).sort((a, b) => a.reach - b.reach)
    const skel = P.skeletonFirst ? near.filter(t => t.kind === 'ranged' && t.reach < P.skeletonFirstRange).sort((a, b) => a.reach - b.reach)[0] : null
    if (skel && !closeMelee.some(t => t.reach < 2.6)) target = skel
    else if (closeMelee.length) target = closeMelee[0]
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
    if (P.bow && bowItem() && arrows() > 0 && !closeMelee.length && target.reach >= P.bowMin && target.reach <= P.bowMax &&
        (target.kind === 'ranged' || target.kind === 'creeper' || target.kind === 'melee') && target.los && !near.some(t => t.kind !== 'ranged' && t.reach < P.bowNoMeleeRange && t !== target)) {
      shield(false)
      if (holdSlot(bowItem())) { bowState = { t0: tickN, id: e.id }; bot.activateItem(); ev('bow-draw', { mob: e.name, d: +target.reach.toFixed(1) }); control(c); return }
    }

    // ---- melee ----
    if (target.reach <= P.reach + 0.6) {
      if (sword()) holdSlot(sword())
      const inReach = target.reach <= P.reach
      const wantShieldUp = (P.guardMelee && !!(incoming || drawnAt) && !ready) || (P.shieldMelee && hp <= P.shieldMeleeHealth && sinceSwing < P.attackTicks - P.shieldDropTicks && !ready) || (target.kind === 'creeper' && P.shieldCreeper && target.d < 4.2 && !ready)
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
      control(c); return
    }

    // ---- approach / hold ----
    const lim = target.kind === 'ranged' ? P.approachRanged : P.approachRange
    if (incoming || drawnAt) { shield(true) } else if (shielding && !fusing) shield(false)
    if (target.reach < lim) {
      if (!shielding) { c.forward = true; c.sprint = P.sprintApproach }
      else c.forward = true
      if (P.strafe && target.reach > 4) { if (strafeDir > 0) c.right = true; else c.left = true }
    }
    control(c)
  }

  function doAttack(e, crit) {
    try { bot.attack(e); stats.swings++; if (crit) stats.crits++; recentHit.set(e.id, tickN) } catch (err) { ev('attack-error', { m: String(err.message).slice(0, 80) }) }
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
  const onStatus = (p) => { if (p.entityId === bot.entity.id && p.entityStatus === 29) { stats.shieldBlocks++ } }
  bot._client.on('entity_status', onStatus)
  bot.on('physicsTick', onTick)
  idleYaw = rng() * Math.PI * 2

  return {
    P, stats, events,
    setIdleYaw(y) { idleYaw = y },
    stop() {
      bot.removeListener('physicsTick', onTick); bot.removeListener('entityDead', onDead); bot.removeListener('entityGone', onGone)
      bot._client.removeListener('entity_status', onStatus)
      control({}); try { if (shielding) bot.deactivateItem() } catch {}
    },
  }
}

module.exports = { create, DEFAULTS }
