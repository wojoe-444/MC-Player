// node tools/relay-report.js [N]
// What the pilot has recorded (brain/state): latency.jsonl (time to quick reply / ack / first bot line / Claude's outbox write per Walter line),
// talker-log.jsonl (what the quick voice said or why it did not) and pilot-log.jsonl (free-time decisions).
const fs = require('fs')
const path = require('path')
const { summarize } = require('../brain/pilot/latency')
const S = path.join(__dirname, '..', 'brain', 'state')
const rows = (f) => { try { return fs.readFileSync(path.join(S, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse) } catch { return [] } }
const N = Number(process.argv[2] || 200)

const lat = rows('latency.jsonl').slice(-N)
const s = summarize(lat)
const fmt = (x) => x && x.n ? `n=${x.n} median ${x.p50} ms, p90 ${x.p90} ms` : 'no data'
console.log(`Chat lines recorded: ${s.n}`)
console.log(`  first reply of any kind: ${fmt(s.firstReply)}`)
console.log(`  quick voice reply:       ${fmt(s.quick)}`)
console.log(`  generic ack:             ${fmt(s.ack)}`)
console.log(`  first bot line (any):    ${fmt(s.bot)}`)
console.log(`  Claude outbox write:     ${fmt(s.outbox)}`)
const lanes = {}; for (const r of lat) lanes[r.lane] = (lanes[r.lane] || 0) + 1
console.log('  lanes:', JSON.stringify(lanes))

const tk = rows('talker-log.jsonl').slice(-N)
const by = {}; for (const r of tk) { const k = r.action === 'say' ? 'said' : r.reason; by[k] = (by[k] || 0) + 1 }
const ms = tk.filter(r => r.action === 'say').map(r => r.ms).sort((a, b) => a - b)
console.log(`\nQuick voice: ${tk.length} lines, ${JSON.stringify(by)}${ms.length ? `, reply median ${ms[Math.floor(ms.length / 2)]} ms` : ''}`)

const pl = rows('pilot-log.jsonl').slice(-N)
const dby = {}; for (const r of pl) if (r.kind === 'decision') { const k = `${r.id}:${r.action}`; dby[k] = (dby[k] || 0) + 1 }
console.log(`Free-time decisions: ${JSON.stringify(dby)}`)
