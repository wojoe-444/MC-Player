// Freeze Score weights for eval H (the h7 steady-pressure schedule) from the baseline runs only, so candidates never influence the scale.
const fs = require('fs')
const rows = fs.readFileSync(__dirname + '/results/trials.jsonl', 'utf8').trim().split('\n').map(JSON.parse).filter(r => r.label === 'h7-v5b')
const metric = (r) => [Math.log(r.survivedSec), Math.log(1 + r.kills / r.survivedSec * 60), -Math.log(0.1 + r.damage / r.survivedSec), Math.log(1 + r.kills / Math.max(1, r.damage) * 10)]
const names = ['ln survival', 'ln kills/min', '-ln dmg/s', 'ln kills/damage']
const X = rows.map(metric), k = 4, n = X.length
const mu = Array.from({ length: k }, (_, j) => X.reduce((s, x) => s + x[j], 0) / n), sd = Array.from({ length: k }, (_, j) => Math.max(1e-6, Math.sqrt(X.reduce((s, x) => s + (x[j] - mu[j]) ** 2, 0) / (n - 1))))
const Z = X.map(x => x.map((v, j) => (v - mu[j]) / sd[j]))
const C = Array.from({ length: k }, (_, a) => Array.from({ length: k }, (_, b) => Z.reduce((s, z) => s + z[a] * z[b], 0) / (n - 1)))
let w = Array(k).fill(1); for (let it = 0; it < 300; it++) { const nw = C.map(row => row.reduce((s, c, j) => s + c * w[j], 0)); const nn = Math.hypot(...nw); w = nw.map(x => x / nn) }
if (w.reduce((s, x) => s + x, 0) < 0) w = w.map(x => -x)
fs.writeFileSync(__dirname + '/composite-h7.json', JSON.stringify({ names, mu, sd, w, n, frozenAt: new Date().toISOString(), note: 'eval H baseline' }, null, 1))
console.log('froze from', n, 'baseline runs; weights', w.map(x => x.toFixed(2)).join(', '))
