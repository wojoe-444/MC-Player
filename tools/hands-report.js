#!/usr/bin/env node
// Prints brain/state/hands-log.json (brain/motor/hands.js): pairs of call sites that change the held item against each other within 2 s, and the busiest callers.
const fs = require('fs'), path = require('path')
const file = process.argv[2] || path.join(process.cwd(), 'brain', 'state', 'hands-log.json')
if (!fs.existsSync(file)) { console.error('no hands log at ' + file + ' (written when the first swap is seen; none yet is good news)'); process.exit(0) }
const g = JSON.parse(fs.readFileSync(file, 'utf8'))
console.log(`hands log since ${new Date(g.since).toISOString()}: ${g.calls} equip/unequip/slot calls`)
for (const s of Object.values(g.swaps).sort((x, y) => y.count - x.count)) console.log(`  ${String(s.count).padStart(5)}x  ${s.a}  <->  ${s.b}   ${Object.entries(s.items).sort((p, q) => q[1] - p[1]).slice(0, 3).map(([k, n]) => `${k} (${n})`).join(', ')}`)
if (!Object.keys(g.swaps).length) console.log('  no swaps')
console.log('\nbusiest callers:'); for (const [site, n] of Object.entries(g.byCaller).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${String(n).padStart(6)}  ${site}`)
