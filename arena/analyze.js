// node analyze.js [labelSubstring]   Fight forensics from arena/results/traces/*.json (written for every run since the flight recorder was added).
const fs = require('fs'), path = require('path')
const dir = path.join(__dirname, 'results', 'traces')
const filt = process.argv[2] || ''
const runs = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).filter(r => r.label.includes(filt))
if (!runs.length) { console.log('no traces yet'); process.exit(0) }
const add = (o, k, v) => { o[k] = (o[k] || 0) + v }
const bucket = (n) => n === 0 ? '0' : n === 1 ? '1' : n === 2 ? '2' : n <= 4 ? '3-4' : '5+'
const dSrc = {}, dBeh = {}, dShield = { up: 0, down: 0 }, dCrowd = {}, dSwing = {}, behT = {}, labels = {}
let totalDmg = 0, hits = 0, whiffs = 0, swings = 0, ticks = 0, crowdTicks = {}, n = runs.length
for (const r of runs) {
  labels[r.label] = (labels[r.label] || 0) + 1
  for (const d of r.dmgLog) {
    totalDmg += d.amt; add(dSrc, d.src, d.amt); add(dBeh, d.beh, d.amt); add(dShield, d.shield ? 'up' : 'down', d.amt); add(dCrowd, bucket(d.m3), d.amt)
    add(dSwing, d.sinceSwing < 10 ? 'just swung' : d.sinceSwing < 25 ? 'mid-cooldown' : 'not fighting', d.amt)
  }
  for (const [b, t] of Object.entries(r.behTicks)) { add(behT, b, t); ticks += t }
  hits += r.stats.hits || 0; whiffs += r.stats.whiffs || 0; swings += r.stats.swings || 0
  for (const s of r.trace) add(crowdTicks, bucket(s.n3), 1)
}
const pct = (o, tot) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v / tot * 100).toFixed(0)}%`).join(', ')
const per = (v) => (v / n).toFixed(1)
console.log(`${n} runs (${Object.entries(labels).map(([l, c]) => l + ' x' + c).join(', ')})`)
console.log(`damage taken per run ${per(totalDmg)} HP`)
console.log('by source:     ', pct(dSrc, totalDmg))
console.log('by behaviour:  ', pct(dBeh, totalDmg), ' (what the bot was doing when hit)')
console.log('shield state:  ', `hit while shield down ${(dShield.down / totalDmg * 100).toFixed(0)}%, up ${(dShield.up / totalDmg * 100).toFixed(0)}%`)
console.log('crowd (mobs within 3): ', pct(dCrowd, totalDmg), ' | time spent: ', pct(crowdTicks, Object.values(crowdTicks).reduce((a, b) => a + b, 0)))
console.log('swing timing:  ', pct(dSwing, totalDmg))
console.log('time in behaviour: ', pct(behT, ticks))
console.log(`swings ${per(swings)}/run, landed ${hits}, whiffed ${whiffs} (hit rate ${(hits / Math.max(1, hits + whiffs) * 100).toFixed(0)}%)`)
// death anatomy: last 8 s of every run that died
console.log('\nDeath anatomy (last 8s, one line per 2s: hp, mobs within 3 / 8 / 16, skeletons in sight, behaviour):')
for (const r of runs.slice(-4)) {
  if (!r.died) continue
  const last = r.trace[r.trace.length - 1]; if (!last) continue
  const rows = r.trace.filter(s => s.t > last.t - 160 && (last.t - s.t) % 40 === 0)
  console.log(`  ${r.label}#${r.idx} died at ${r.survivedSec}s (${r.cause}):`, rows.map(s => `hp${s.hp} m${s.n3}/${s.n8}/${s.n16} sk${s.sk} ${s.beh}`).join(' | '))
}
// when does the horde arrive? time of first n8>=6 and hp at that time
const onset = runs.map(r => { const s = r.trace.find(x => x.n8 >= 6); return s ? [s.t / 20, s.hp, r.survivedSec] : null }).filter(Boolean)
if (onset.length) console.log(`\nhorde onset (6+ mobs within 8): at ${(onset.reduce((a, b) => a + b[0], 0) / onset.length).toFixed(0)}s on average, death ${(onset.reduce((a, b) => a + b[2] - b[0], 0) / onset.length).toFixed(0)}s later`)
