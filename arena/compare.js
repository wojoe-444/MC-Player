// node compare.js <labelA> <labelB>   Welch t-test + Mann-Whitney U on survival seconds (one-sided: is B better than A?)
const fs = require('fs')
const rows = fs.readFileSync(__dirname + '/results/trials.jsonl', 'utf8').trim().split('\n').map(JSON.parse)
const val = (r) => process.env.ENGAGED && r.stats && r.stats.firstContactTick != null ? r.survivedSec - r.stats.firstContactTick / 20 : r.survivedSec   // ENGAGED=1: time since first mob contact
const get = (l) => rows.filter(r => r.label === l).map(val)
function lgamma(x) { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]; let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let s = 1.000000000190015; for (const k of c) s += k / ++y; return -t + Math.log(2.5066282746310005 * s / x) }
function betacf(a, b, x) { let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap; if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d; let h = d; for (let m = 1; m <= 200; m++) { const m2 = 2 * m; let aa = m * (b - m) * x / ((qam + m2) * (a + m2)); d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30; c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30; d = 1 / d; h *= d * c; aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2)); d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30; c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30; d = 1 / d; const del = d * c; h *= del; if (Math.abs(del - 1) < 3e-7) break } return h }
function ibeta(x, a, b) { if (x <= 0) return 0; if (x >= 1) return 1; const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x)); return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b }
const tCdf = (t, v) => { const x = v / (v + t * t), p = 0.5 * ibeta(x, v / 2, 0.5); return t > 0 ? 1 - p : p }
const mean = a => a.reduce((s, x) => s + x, 0) / a.length
const vr = a => { const m = mean(a); return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1) }
const [A, B] = [get(process.argv[2]), get(process.argv[3])]
if (A.length < 2 || B.length < 2) { console.log('need n>=2 each', A.length, B.length); process.exit(0) }
const se = Math.sqrt(vr(A) / A.length + vr(B) / B.length), t = (mean(B) - mean(A)) / se
const df = (vr(A) / A.length + vr(B) / B.length) ** 2 / ((vr(A) / A.length) ** 2 / (A.length - 1) + (vr(B) / B.length) ** 2 / (B.length - 1))
const pT = 1 - tCdf(t, df)
// Mann-Whitney U (normal approx with tie-less correction)
let U = 0; for (const b of B) for (const a of A) U += b > a ? 1 : b === a ? 0.5 : 0
const mu = A.length * B.length / 2, sd = Math.sqrt(A.length * B.length * (A.length + B.length + 1) / 12), z = (U - mu) / sd
const nCdf = z => 0.5 * (1 + Math.sign(z) * (1 - Math.exp(-0.717 * Math.abs(z) - 0.416 * z * z)))
console.log(`${process.argv[2]} n=${A.length} mean=${mean(A).toFixed(1)}  vs  ${process.argv[3]} n=${B.length} mean=${mean(B).toFixed(1)}`)
console.log(`Welch t=${t.toFixed(2)} df=${df.toFixed(1)} one-sided p(B>A)=${pT.toFixed(3)} | Mann-Whitney U=${U} z=${z.toFixed(2)} one-sided p=${(1 - nCdf(z)).toFixed(3)}`)

// Paired view: trial idx k of both labels used the same seed, i.e. the same wave composition and timing, so the per-seed difference removes mob-draw noise.
const byIdx = (l) => { const m = {}; for (const r of rows.filter(r => r.label === l)) m[r.idx] = val(r); return m }
const [a, b] = [byIdx(process.argv[2]), byIdx(process.argv[3])]
const d = Object.keys(a).filter(k => k in b).map(k => b[k] - a[k])
if (d.length >= 3) {
  const md = mean(d), sdd = Math.sqrt(vr(d)), tp = md / (sdd / Math.sqrt(d.length)), pp = 1 - tCdf(tp, d.length - 1)
  console.log(`PAIRED by seed: n=${d.length} mean diff=${md.toFixed(1)}s (${d.map(x => x.toFixed(0)).join(', ')}) t=${tp.toFixed(2)} one-sided p=${pp.toFixed(3)}  (wins ${d.filter(x => x > 0).length}/${d.length})`)
}
