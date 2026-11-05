// Pure decision logic for mob safety: no bot, no timers. Unit-tested offline.
const { P, PROFILES } = require('./profiles')
const { CREEPER_DEFAULTS, planCreeper } = require('./creeper')

const DEFAULTS = {
  ...CREEPER_DEFAULTS,
  engageRange: 5,      // melee mobs: start fighting inside this (never chase beyond it)
  engageApproach: 8,   // ...or inside this when the mob is walking toward us
  warnRange: 16,       // tell Walter about an approaching mob from this far
  alertRange: 10,      // ...or any hostile this close, even standing still
  ownerWarnRange: 14,  // mob near Walter (not the bot)
  fightRange: 9,       // mobs inside this are "close" and get a reaction (ranged mobs: rangedRange)
  rangedRange: 14,
  retreatRange: 7,     // in warn mode, back away when a mob is this close
  minFightHealth: 9.5,   // below this never fight (except desperate self-defence), always retreat
  recoverHealth: 14,   // once low, stay in "recovering" until this
  maxFighters: 3,
  cornerAfterMs: 10000, // fleeing this long while still being hit = cornered
  cornerHits: 3,        // ...or this many hits in the last few seconds with a melee mob adjacent
  rangedFightHealth: 10, // fight archers (strafing in) at this health or better; below it retreat. Walter: deaths mean fight back, do not just run
  nightFightHealth: 14,  // ...and at night in the open only at this health
  maxArchers: 2,         // more archers than this: retreat
  shelterMax: 90,        // retreat to a shelter at most this far away
  maxDy: 8,           // ignore mobs this far above/below (separate floors, cliffs)
  approachSpeed: 0.6   // blocks/second of closing speed that counts as "approaching"
}

function compass(from, to) {
  const dx = to.x - from.x, dz = to.z - from.z
  const a = Math.atan2(dx, -dz) * 180 / Math.PI            // 0 = north (-z), 90 = east (+x)
  const names = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west']
  return names[((Math.round(a / 45) % 8) + 8) % 8]
}
const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

// Remembers recent distances per mob so we can tell "approaching" from "standing there".
class Tracker {
  constructor({ windowMs = 1500, keepMs = 2500 } = {}) { this.windowMs = windowMs; this.keepMs = keepMs; this.h = new Map() }
  // mobs: [{id,pos}], me: Vec3-like. Returns Map id -> { closing (blocks/s, + = nearer), eta (s or Infinity) }
  update(now, me, mobs) {
    const out = new Map(), seen = new Set()
    for (const m of mobs) {
      seen.add(m.id)
      const d = d3(me, m.pos)
      let arr = this.h.get(m.id); if (!arr) this.h.set(m.id, arr = [])
      arr.push({ t: now, d })
      while (arr.length && now - arr[0].t > this.keepMs) arr.shift()
      const ref = arr.find(s => now - s.t <= this.windowMs && now - s.t >= 400)
      const closing = ref ? (ref.d - d) / ((now - ref.t) / 1000) : 0
      out.set(m.id, { closing, eta: closing > 0.05 ? d / closing : Infinity })
    }
    for (const id of [...this.h.keys()]) if (!seen.has(id)) this.h.delete(id)
    return out
  }
}

// snapshot: { now, me:{pos}, health, mode:'warn'|'fight', hasWeapon, owner:{pos}|null,
//             mobs:[{id,name,pos,closing?,hostile?}], hurtBy:id|null, hurtRecently:bool, recentHits?:number,
//             recovering?:bool, giveUp:Set, fleeingSinceMs:number|null }
// returns { action:'none'|'warn'|'flee'|'fight'|'recover', target, reason, retreat:'away'|'owner', warnings:[{key,text}], threats }
function assess(s, cfg = {}) {
  const C = { ...DEFAULTS, ...cfg }
  const out = { action: 'none', target: null, reason: '', retreat: 'away', warnings: [], threats: [] }
  const list = []
  for (const m of s.mobs) {
    if (s.giveUp && s.giveUp.has(m.id)) continue
    if (m.hostile === false) continue
    const prof = PROFILES[m.name] || P('melee', 2, { unknown: true })
    if (prof.kind === 'neutral' && m.id !== s.hurtBy) continue
    if (Math.abs(m.pos.y - s.me.pos.y) > C.maxDy) continue
    const closing = m.closing || 0
    list.push({ ...m, prof, dist: d3(s.me.pos, m.pos), closing, approaching: closing >= C.approachSpeed,
      ownerDist: s.owner ? d3(s.owner.pos, m.pos) : Infinity })
  }
  list.sort((a, b) => b.prof.danger - a.prof.danger || a.dist - b.dist)
  const rangeOf = (m) => m.prof.range || (m.prof.kind === 'ranged' ? C.rangedRange : m.prof.kind === 'explosive' ? C.creeperWatch : C.fightRange)
  const near = list.filter(m => m.dist <= rangeOf(m))
  out.threats = near

  // 8 health or less: disengage. Hide in the nearest known shelter when there is one (post-mortem: the bot used to stand and hold in the open).
  const lowHealth = s.health <= C.minFightHealth || (!!s.recovering && s.health < C.recoverHealth)
  const shelterOk = !!s.shelter && s.shelter.dist <= C.shelterMax
  const nightOpen = !!s.night && !!s.outdoors
  const lowHealthRetreat = (lowHealth || nightOpen) && shelterOk ? 'shelter' : lowHealth ? 'owner' : 'away'

  // ---- chat warnings: what is coming, where from ----
  const warned = new Set()
  for (const m of near) {
    warned.add(m.id)
    out.warnings.push({ key: `bot:${m.name}`, text: `${m.name} ${m.approaching ? 'approaching, ' : ''}${Math.round(m.dist)} blocks ${compass(s.me.pos, m.pos)} of me.` })
  }
  for (const m of list) {
    if (warned.has(m.id)) continue
    if (m.dist <= C.warnRange && (m.approaching || m.dist <= C.alertRange)) {
      warned.add(m.id)
      out.warnings.push({ key: `far:${m.name}`, text: `${m.name} ${m.approaching ? 'approaching from' : 'to the'} ${compass(s.me.pos, m.pos)}, ${Math.round(m.dist)} blocks.` })
    }
  }
  if (s.owner) for (const m of list) {
    if (!warned.has(m.id) && m.ownerDist <= C.ownerWarnRange && m.dist > 4) out.warnings.push({ key: `owner:${m.name}`, text: `Heads up: ${m.name} ${Math.round(m.ownerDist)} blocks ${compass(s.owner.pos, m.pos)} of you.` })
  }

  if (!near.length) {
    if (lowHealth) return { ...out, action: 'recover', reason: `health ${Math.round(s.health)}/20`, retreat: shelterOk && s.shelter.dist > 5 ? 'shelter' : 'owner' }
    return out
  }

  const nearest = near.slice().sort((a, b) => a.dist - b.dist)[0]
  const hits = s.recentHits || 0
  const adjacentMelee = near.filter(m => m.prof.kind === 'melee' && m.dist <= 3)
  const cornered = (s.fleeingSinceMs != null && s.fleeingSinceMs >= C.cornerAfterMs && !!s.hurtRecently) ||
    (hits >= C.cornerHits && adjacentMelee.length > 0)
  const dangerous = near.find(m => m.prof.kind === 'flee')
  const cmob = near.filter(m => m.prof.kind === 'explosive').sort((a, b) => a.dist - b.dist)[0]
  const creeper = cmob && cmob.dist <= C.creeperRange ? cmob : undefined
  let cplan = null
  if (cmob) {
    const st = s.creeper || {}, fuse = (st.fuse && st.fuse[cmob.id]) || { est: 0, fusing: false }
    cplan = planCreeper({
      creeper: { dist: cmob.dist, approaching: cmob.approaching }, fuse, others: near.filter(m => m !== cmob && m.prof.kind !== 'explosive' && m.dist <= 8).length,
      mode: s.mode, health: s.health, hasSword: !!s.hasWeapon, hasBow: !!s.hasBow, hasArrows: !!s.hasArrows, los: !!(s.los && s.los[cmob.id]),
      phase: st.phase || 'idle', sinceHitMs: st.sinceHitMs ?? Infinity, cycles: st.cycles || 0, cornered
    }, C)
  }
  const fighters = near.filter(m => m.prof.kind !== 'explosive' && m.prof.kind !== 'flee')
  const pickTarget = () => (fighters.find(m => m.id === s.hurtBy) || fighters.slice().sort((a, b) => a.dist - b.dist)[0])

  // Cornered at low health by a single melee mob: running only gives it free hits.
  if (lowHealth && cornered && s.hasWeapon && !dangerous && !creeper && fighters.length === 1 && fighters[0].dist <= 3)
    return { ...out, action: 'fight', target: fighters[0], reason: 'cornered, last stand', retreat: lowHealthRetreat }
  if (lowHealth) return { ...out, action: 'flee', target: nearest, reason: `health ${Math.round(s.health)}/20`, retreat: lowHealthRetreat }
  if (dangerous) return { ...out, action: 'flee', target: dangerous, reason: `${dangerous.name} is too dangerous to fight` }
  if (cplan) {
    if (cplan.type === 'flee' || cplan.type === 'withdraw') return { ...out, action: 'flee', target: cmob, reason: cplan.reason, urgent: !!cplan.urgent, creeper: cplan.type }
    if (cplan.type === 'shoot') return { ...out, action: 'shoot', target: cmob, reason: cplan.reason }
    if (cplan.type === 'strike') return { ...out, action: 'fight', style: 'strike', target: cmob, reason: cplan.reason }
  }
  // Archers (skeleton, stray, pillager, witch): fight up to maxArchers of them while healthy (the runtime closes in zig-zagging so half the arrows miss);
  // hurt, or at night in the open below nightFightHealth, or too many: break away (to shelter if known).
  const archers = fighters.filter(m => m.prof.kind === 'ranged').sort((a, b) => a.dist - b.dist)
  if (archers.length && !cornered) {
    const okHere = archers.length <= C.maxArchers && s.health >= C.rangedFightHealth && (!nightOpen || s.health >= C.nightFightHealth)
    if (!okHere) return { ...out, action: 'flee', target: archers[0], reason: nightOpen && s.health < C.nightFightHealth ? `${archers[0].name} in the open at night` : archers.length > C.maxArchers ? 'several archers' : `${archers[0].name}, health ${Math.round(s.health)}/20`, retreat: nightOpen && shelterOk ? 'shelter' : lowHealthRetreat }
  }
  const canFight = (s.mode === 'fight' || cornered) && s.hasWeapon && fighters.length <= C.maxFighters
  const engaged = (m) => cornered || m.id === s.hurtBy || m.dist <= C.engageRange || (m.approaching && m.dist <= C.engageApproach) || m.prof.kind === 'ranged'
  if (canFight) {
    const eng = fighters.filter(engaged)
    const target = eng.find(m => m.id === s.hurtBy) || eng.slice().sort((a, b) => a.dist - b.dist)[0]
    if (target) return { ...out, action: 'fight', target, reason: cornered && s.mode !== 'fight' ? 'self-defence, cornered' : 'fighting back' }
  }
  const retreatAt = (m) => m.prof.kind === 'ranged' ? C.rangedRange : C.retreatRange
  const close = near.filter(m => m.dist <= retreatAt(m)).sort((a, b) => a.dist - b.dist)[0]
  const holdGround = s.mode === 'fight' && s.hasWeapon && fighters.length <= C.maxFighters
  if (close && !holdGround) return { ...out, action: 'flee', target: close, reason: s.mode === 'fight' ? (!s.hasWeapon ? 'no sword' : 'too many mobs') : 'fighting not allowed' }
  return { ...out, action: 'warn', target: nearest, reason: 'mob in range' }
}

module.exports = { assess, compass, Tracker, DEFAULTS, d3 }
