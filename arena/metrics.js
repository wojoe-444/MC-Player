// Per-run scores. kind 'survival' (seconds) or 'composite' (z-units from the frozen PC1 weights in composite.json; 0 = pooled average run, +1 = one pooled SD better).
const fs = require('fs'), path = require('path')
const F = {}
const tierOf = (r) => r.waveCfg && r.waveCfg.firstCount === 14 ? 'h7' : 'orig'   // eval H has its own frozen scale
function frozen(r) { const t = tierOf(r); if (!F[t]) F[t] = JSON.parse(fs.readFileSync(path.join(__dirname, t === 'h7' ? 'composite-h7.json' : 'composite.json'), 'utf8')); return F[t] }
function composite(r) {
  const f = frozen(r)
  const x = [Math.log(r.survivedSec), Math.log(1 + r.kills / r.survivedSec * 60), -Math.log(0.1 + r.damage / r.survivedSec), Math.log(1 + r.kills / Math.max(1, r.damage) * 10)]
  return x.reduce((s, v, j) => s + f.w[j] * (v - f.mu[j]) / f.sd[j], 0)
}
// composite2 = composite minus a minor penalty on the damage the bot took from creeper blasts (0.05 per HP, capped at 20 HP = 1.0). Explosions that hurt only mobs, or that the shield absorbed, cost nothing.
const PENALTY_PER_HP = 0.05
function composite2(r) { if (r.course) return r.course.score
   return composite(r) - PENALTY_PER_HP * Math.min(20, (r.dmgBy && r.dmgBy.creeper) || 0) }
const score = (r, kind) => r.course ? r.course.score : kind === 'composite2' ? composite2(r) : kind === 'composite' ? composite(r) : r.survivedSec
module.exports = { score, composite, composite2 }
