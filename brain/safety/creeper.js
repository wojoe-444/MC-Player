// Creeper handling. Pure logic (no bot): fuse tracking and the plan for one creeper. Unit-tested, including a small
// physics simulation in test/safety.creeper.test.js.
//
// Facts used (vanilla Java): a creeper starts to swell when a target is within ~3 blocks (and in sight), explodes after 30 ticks
// (1.5 s) of swelling, and the fuse winds back down when the target is > 7 blocks away or out of sight. Explosion power 3: damage
// falls off to zero at 6 blocks. So: never be within 6 blocks of a creeper that is swelling, and never let swelling accumulate.
//
// Plans (planCreeper returns { type, reason, urgent? }):
//   flee      creeper is close or fusing: run (urgent = fuse already started)
//   withdraw  just landed a hit: back off 5.5+ blocks before anything else
//   shoot     bow + arrows + line of sight, creeper outside the flee range: shoot from range
//   strike    sword hit-and-retreat (only in fight mode, healthy, creeper alone): close in, one hit, then withdraw
//   none      keep an eye on it
const CREEPER_DEFAULTS = {
  creeperRange: 7,         // flee when a (non-striking) creeper is inside this
  creeperWatch: 14,        // plan creeper behaviour inside this
  creeperStrike: true,     // allow sword hit-and-retreat (still needs fight mode)
  strikeStart: 10,         // start a strike run when the creeper is within this but outside creeperRange
  strikeHealth: 14,
  withdrawDist: 5.5,
  withdrawMinMs: 900,
  maxStrikeCycles: 8,
  strikeCommitMs: 600,     // a fuse this young does not cancel a strike we are already committed to
  commitEst: 10,
  maxFuseTicks: 14,        // estimated swelling ticks that abort a strike (30 = boom)
  bowMin: 8,               // never shoot inside this: kite first
  bowMax: 24
}

class FuseTracker {
  // Per creeper: ticks of swelling we estimate (0..30) from proximity, plus whether the game says it is fusing (metadata or hiss).
  constructor() { this.h = new Map() }
  // creepers: [{id, dist, fusing}]
  update(nowMs, creepers) {
    const seen = new Set()
    for (const c of creepers) {
      seen.add(c.id)
      let s = this.h.get(c.id)
      if (!s) this.h.set(c.id, s = { t: nowMs, est: 0, fusingSince: null })
      const dtTicks = Math.max(0, Math.min(2000, nowMs - s.t)) / 50
      s.t = nowMs
      s.est = c.dist <= 3.2 ? Math.min(30, s.est + dtTicks) : Math.max(0, s.est - dtTicks)
      if (c.fusing) { if (s.fusingSince == null) s.fusingSince = nowMs } else s.fusingSince = null
    }
    for (const id of [...this.h.keys()]) if (!seen.has(id)) this.h.delete(id)
  }
  get(id, nowMs) {
    const s = this.h.get(id)
    return s ? { est: s.est, fusing: s.fusingSince != null, fusingMs: s.fusingSince != null ? nowMs - s.fusingSince : 0 } : { est: 0, fusing: false, fusingMs: 0 }
  }
}

// input: { creeper:{dist, approaching}, fuse:{est, fusing}, others:int (other hostiles within 8), mode, health, hasSword, hasBow, hasArrows,
//          los:bool, phase:'idle'|'approach'|'withdraw', sinceHitMs, cycles, cornered }
function planCreeper(i, cfg = {}) {
  const C = { ...CREEPER_DEFAULTS, ...cfg }
  const d = i.creeper.dist
  const canStrike = C.creeperStrike && i.mode === 'fight' && i.hasSword && i.health >= C.strikeHealth && i.others === 0 && i.cycles < C.maxStrikeCycles
  // committed to a strike and in reach: land the hit even though it just started to swell (the hit is followed by a full retreat)
  if (canStrike && i.phase === 'approach' && d <= 3.4 && i.fuse.est < C.commitEst && (!i.fuse.fusing || i.fuse.fusingMs < C.strikeCommitMs)) return { type: 'strike', reason: 'creeper, hit and retreat' }
  if (i.fuse.fusing || i.fuse.est >= C.maxFuseTicks) return { type: 'flee', reason: 'creeper fuse', urgent: true }
  if (i.cornered && i.hasSword && d <= 3.2) return { type: 'strike', reason: 'creeper, cornered' }
  if (i.phase === 'withdraw' && !(d >= C.withdrawDist && i.sinceHitMs >= C.withdrawMinMs)) return { type: 'withdraw', reason: 'creeper hit-and-retreat' }
  if (i.hasBow && i.hasArrows && i.los && d >= C.bowMin && d <= C.bowMax) return { type: 'shoot', reason: 'creeper, from range' }
  if (canStrike && i.phase === 'approach' && d <= C.strikeStart) return { type: 'strike', reason: 'creeper, hit and retreat' }
  // already mid-fight with this creeper (landed at least one hit): go back in as soon as the withdraw is complete and it is calm
  if (canStrike && i.cycles > 0 && i.phase !== 'withdraw' && !i.fuse.fusing && i.fuse.est < 4 && d <= C.strikeStart) return { type: 'strike', reason: 'creeper, hit and retreat' }
  if (d <= C.creeperRange) return { type: 'flee', reason: 'creeper' }
  if (canStrike && d <= C.strikeStart && i.creeper.approaching) return { type: 'strike', reason: 'creeper, hit and retreat' }
  return { type: 'none', reason: 'creeper in view' }
}

module.exports = { CREEPER_DEFAULTS, FuseTracker, planCreeper }
