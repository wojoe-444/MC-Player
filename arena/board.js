// prints a markdown scoreboard from results/trials.jsonl (per label: n, median, mean, kills, damage, per-trial list)
const fs = require('fs')
const rows = fs.readFileSync(__dirname + '/results/trials.jsonl', 'utf8').trim().split('\n').map(JSON.parse).filter(r => r.label !== 'smoke')
const by = {}; for (const r of rows) (by[r.label + (r.kit && r.kit.armor === false ? ' (no armor)' : ' (armor)')] ||= []).push(r)
const med = a => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
let out = '**Live combat scoreboard** (median survival is the score; higher is better)\n\n'
for (const [k, v] of Object.entries(by)) {
  const t = v.map(r => r.survivedSec)
  out += `- **${k}**: n=${v.length}, median **${med(t).toFixed(1)}s**, mean ${(t.reduce((a, b) => a + b, 0) / t.length).toFixed(1)}s, kills/run ${(v.reduce((a, r) => a + r.kills, 0) / v.length).toFixed(1)} — runs: ${t.map(x => x.toFixed(0) + 's').join(', ')}\n`
}
console.log(out)
