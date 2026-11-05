const fs = require('fs')
const idle = fs.readFileSync('idle.log', 'utf8').split('\n').filter(l => /dug myself out of/.test(l))
const L = fs.readFileSync('brain/state/think-log.jsonl', 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean).filter(d => d.pos && d.t)
const sc = fs.readFileSync('brain/state/scoreboard.log', 'utf8').split('\n')
for (const l of idle) {
  const t = l.slice(0, 24)
  // nearest think-log position before this time
  let best = null
  for (const d of L) { if (d.t <= t) best = d; else break }
  console.log(t.slice(11, 19), l.replace(/^\S+ autopilot GOAL hallway: /, ''), best ? JSON.stringify(best.pos) + ' @' + best.t.slice(11, 19) : '')
}
