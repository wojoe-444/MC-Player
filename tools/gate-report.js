#!/usr/bin/env node
// Prints brain/state/gate-log.json (written by brain/gate): per rule, how many violations and from which call sites, most frequent first.
// Usage: node tools/gate-report.js [path/to/gate-log.json]     The stray-path list after a day of log-only mode is the input to flipping a rule to "enforce".
const fs = require('fs')
const path = require('path')
const file = process.argv[2] || path.join(process.cwd(), 'brain', 'state', 'gate-log.json')
if (!fs.existsSync(file)) { console.error('no gate log at ' + file + ' (the bot writes it when the first violation is recorded; none yet is good news)'); process.exit(0) }
const g = JSON.parse(fs.readFileSync(file, 'utf8'))
const hours = ((g.savedAt || Date.now()) - g.since) / 3600000
console.log(`gate log since ${new Date(g.since).toISOString()} (${hours.toFixed(1)} h)`)
for (const [rule, r] of Object.entries(g.rules)) {
  console.log(`\n${rule} [${r.mode}]: ${r.violations} violation(s)${r.blocked ? `, ${r.blocked} blocked` : ''}`)
  for (const [site, n] of Object.entries(r.sites).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${site}${n / Math.max(hours, 0.01) > 60 ? '   <- more than a minute: this call site is itself a loop' : ''}`)
}
const last = (g.recent || []).slice(-5)
if (last.length) { console.log('\nlast violations:'); for (const e of last) console.log(`  ${new Date(e.t).toISOString()} ${e.rule}: ${e.why} <- ${e.sites.join(' < ')}`) }
