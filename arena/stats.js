// Small stats helpers shared by the harness (sequential tests against the incumbent). One-sided Welch t-test: p(B better than A).
function lgamma(x) { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]; let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let s = 1.000000000190015; for (const k of c) s += k / ++y; return -t + Math.log(2.5066282746310005 * s / x) }
function betacf(a, b, x) { const qab = a + b, qap = a + 1, qam = a - 1; let c = 1, d = 1 - qab * x / qap; if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d; let h = d; for (let m = 1; m <= 200; m++) { const m2 = 2 * m; let aa = m * (b - m) * x / ((qam + m2) * (a + m2)); d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30; c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30; d = 1 / d; h *= d * c; aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2)); d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30; c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30; d = 1 / d; const del = d * c; h *= del; if (Math.abs(del - 1) < 3e-7) break } return h }
function ibeta(x, a, b) { if (x <= 0) return 0; if (x >= 1) return 1; const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x)); return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b }
const tCdf = (t, v) => { const x = v / (v + t * t), p = 0.5 * ibeta(x, v / 2, 0.5); return t > 0 ? 1 - p : p }
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length
const vari = (a) => { const m = mean(a); return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1) }
// p-value that B's true mean is greater than A's (one-sided Welch)
function welchP(A, B) {
  if (A.length < 2 || B.length < 2) return 1
  const se = Math.sqrt(vari(A) / A.length + vari(B) / B.length); if (!se) return mean(B) > mean(A) ? 0 : 1
  const t = (mean(B) - mean(A)) / se
  const df = (vari(A) / A.length + vari(B) / B.length) ** 2 / ((vari(A) / A.length) ** 2 / (A.length - 1) + (vari(B) / B.length) ** 2 / (B.length - 1))
  return 1 - tCdf(t, df)
}
// 80% CI half-width of the mean
function halfWidth80(a) { if (a.length < 2) return Infinity; let lo = 0, hi = 50; for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (tCdf(m, a.length - 1) < 0.9) lo = m; else hi = m } return (lo + hi) / 2 * Math.sqrt(vari(a) / a.length) }
module.exports = { welchP, halfWidth80, mean, vari }
