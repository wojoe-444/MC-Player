// Offline analysis: how much of the survival noise is explained by (a) the wave composition of that seed, (b) other per-run metrics.
const fs = require('fs')
const rows = fs.readFileSync(__dirname + '/results/trials.jsonl', 'utf8').trim().split('\n').map(JSON.parse).filter(r => r.label !== 'smoke' && r.kit && r.kit.armor === false)
function mulberry(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 } }
const MOBS = [['zombie', 0.45], ['skeleton', 0.25], ['creeper', 0.15], ['spider', 0.15]]
const pick = (rnd) => { let r = rnd(), s = 0; for (const [m, w] of MOBS) { s += w; if (r < s) return m } return 'zombie' }
function comp(idx, waves) { const rnd = mulberry(1000 + idx), c = { zombie: 0, skeleton: 0, creeper: 0, spider: 0, total: 0 }; rnd() /* heading draw happens first */; for (let w = 0; w < waves; w++) { const n = Math.min(30, Math.round(2 + w * 0.7)); for (let i = 0; i < n; i++) { c[pick(rnd)]++; c.total++; rnd(); rnd() } } return c }
const mean = a => a.reduce((s, x) => s + x, 0) / a.length
const groups = {}; for (const r of rows) (groups[r.label] = groups[r.label] || []).push(r)
const corr = (x, y) => { const mx = mean(x), my = mean(y); let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2 } return sxy / Math.sqrt(sxx * syy) }
for (const W of [3, 5, 7]) {
  // within-variant demeaned survival vs composition of the first W waves
  const dev = [], X = { skeleton: [], zombie: [], creeper: [], spider: [], total: [] }
  for (const rs of Object.values(groups)) { if (rs.length < 4) continue; const m = mean(rs.map(r => r.survivedSec)); for (const r of rs) { dev.push(r.survivedSec - m); const c = comp(r.idx, W); for (const k in X) X[k].push(c[k]) } }
  console.log(`first ${W} waves, n=${dev.length} runs:`, Object.keys(X).map(k => `${k} r=${corr(X[k], dev).toFixed(2)}`).join('  '))
}
// metric correlations across all runs
const M = rows.map(r => ({ surv: r.survivedSec, kpm: r.kills / r.survivedSec * 60, dps: r.damage / r.survivedSec, kpd: r.kills / Math.max(1, r.damage) }))
const keys = ['surv', 'kpm', 'dps', 'kpd']
console.log('metric correlations (n=' + M.length + '):'); for (const a of keys) console.log(a.padEnd(5), keys.map(b => corr(M.map(m => m[a]), M.map(m => m[b])).toFixed(2)).join('  '))
