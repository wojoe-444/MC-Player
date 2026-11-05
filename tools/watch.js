// Prints the last N planner steps compactly plus the survival summary. usage: node tools/watch.js [N]
const fs = require('fs')
const n = Number(process.argv[2]) || 8
const lines = fs.readFileSync('brain/state/think-log.jsonl', 'utf8').trim().split('\n').slice(-n)
for (const l of lines) {
  try {
    const o = JSON.parse(l)
    if (o.ev !== 'step') { console.log(o.t && o.t.slice(11, 19), o.ev, JSON.stringify(o).slice(0, 160)); continue }
    console.log(o.t.slice(11, 19), o.tick, JSON.stringify(o.pos), 'hp' + o.hp, (o.phase || '').slice(0, 24), '|', o.thought, '|',
      (o.results || []).map(r => `${r.a}:${r.ok ? 'ok' : 'FAIL'}:${String(r.note || '').slice(0, 70)}`).join(' ; '), '| bag', JSON.stringify(o.bag))
  } catch { console.log(l.slice(0, 160)) }
}
try {
  const s = JSON.parse(fs.readFileSync('brain/state/survival-summary.json', 'utf8'))
  for (const l of s.lives) console.log('LIFE', l.n, l.open ? 'OPEN' : 'ended', 'ticks', l.survivedTicks ?? '-', 'nights', l.nights, 'minHp', l.minHp, 'cause', l.cause || '-', 'milestones', JSON.stringify(l.milestones))
} catch {}
