// Composite score from several per-run metrics. Fixed a priori (unsupervised): log-transform each metric, standardise with the pooled mean/sd of ALL no-armor runs,
// weight by the first principal component (the shared axis of "fighting well"), sign so higher = better. Then t-tests/CIs work on the composite like any other score.
const fs = require('fs')
const rows = fs.readFileSync(__dirname + '/results/trials.jsonl', 'utf8').trim().split('\n').map(JSON.parse).filter(r => r.label !== 'smoke' && r.kit && r.kit.armor === false)
const metric = (r) => [Math.log(r.survivedSec), Math.log(1 + r.kills / r.survivedSec * 60), -Math.log(0.1 + r.damage / r.survivedSec), Math.log(1 + r.kills / Math.max(1, r.damage) * 10)]
const names = ['ln survival', 'ln kills/min', '-ln dmg/s', 'ln kills/damage']
const X = rows.map(metric), k = names.length, n = X.length
const mu = Array.from({ length: k }, (_, j) => X.reduce((s, x) => s + x[j], 0) / n), sd = Array.from({ length: k }, (_, j) => Math.sqrt(X.reduce((s, x) => s + (x[j] - mu[j]) ** 2, 0) / (n - 1)))
const Z = X.map(x => x.map((v, j) => (v - mu[j]) / sd[j]))
// first PC via power iteration on the correlation matrix
const C = Array.from({ length: k }, (_, a) => Array.from({ length: k }, (_, b) => Z.reduce((s, z) => s + z[a] * z[b], 0) / (n - 1)))
let w = Array(k).fill(1); for (let it = 0; it < 200; it++) { const nw = C.map(row => row.reduce((s, c, j) => s + c * w[j], 0)); const nn = Math.hypot(...nw); w = nw.map(x => x / nn) }
if (w.reduce((s, x) => s + x, 0) < 0) w = w.map(x => -x)
const score = (r) => metric(r).reduce((s, v, j) => s + w[j] * (v - mu[j]) / sd[j], 0)
module.exports = { score, w, names }
if (require.main === module) {
  console.log('PC1 weights:', names.map((nm, j) => `${nm} ${w[j].toFixed(2)}`).join(', '))
  const g = {}; for (const r of rows) (g[r.label] = g[r.label] || []).push(r)
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length, vr = a => { const m = mean(a); return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1) }
  const d = (A, B) => (mean(B) - mean(A)) / Math.sqrt((vr(A) + vr(B)) / 2)
  const pairs = [['na-v1', 'na-v3a-shieldskel'], ['na-v3a-shieldskel', 'na-v5a-nocrit'], ['na-v1', 'na-v5a-nocrit'], ['na-v1', 'na-v2']]
  const fns = { 'survival s': r => r.survivedSec, 'ln survival': r => Math.log(r.survivedSec), 'kills/min': r => r.kills / r.survivedSec * 60, '-dmg/s': r => -r.damage / r.survivedSec, 'composite': score }
  console.log('effect size d (higher = the metric separates the variants better; noise-adjusted):')
  for (const [a, b] of pairs) if (g[a] && g[b]) console.log(a.padEnd(20), '->', b.padEnd(20), Object.entries(fns).map(([nm, f]) => `${nm} ${d(g[a].map(f), g[b].map(f)).toFixed(2)}`).join('  |  '))
}
