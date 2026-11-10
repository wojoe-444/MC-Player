#!/usr/bin/env node
// Prints brain/state/lease-log.json (brain/motor/lease.js): pairs of call sites that keep flipping the same movement key back and forth, most frequent first.
const fs = require('fs'), path = require('path')
const file = process.argv[2] || path.join(process.cwd(), 'brain', 'state', 'lease-log.json')
if (!fs.existsSync(file)) { console.error('no lease log at ' + file + ' (written when the first fight is seen; none yet is good news)'); process.exit(0) }
const g = JSON.parse(fs.readFileSync(file, 'utf8'))
console.log(`lease log since ${new Date(g.since).toISOString()}: ${g.changes} key changes`)
for (const f of Object.values(g.fights).sort((x, y) => y.count - x.count)) console.log(`  ${String(f.count).padStart(5)}x  ${f.control}: ${f.a}  <->  ${f.b}   (last ${new Date(f.last).toISOString()})`)
if (!Object.keys(g.fights).length) console.log('  no fights')
