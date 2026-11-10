#!/usr/bin/env node
// The daily digest (docs/HILLCLIMB-INSIGHTS.md item 11): ONE message for Walter, by exception. Everything else goes to the fixing loop, not to him.
//   node tools/digest.js [--state <brain/state>] [--code <deploy clone, for deploys.jsonl>] [--hours 24] [--out <dir>]
// Reads (all optional, a missing file is just a missing section): roadmap.json, telemetry/flags.jsonl, gate-log.json, lease-log.json, runlog/step-loops.json,
// <code>/deploys.jsonl, and digest-question.txt (a question the fixing loop wants Walter's taste on; at most one, the first line). Writes <out>/<date>.md and prints it.
'use strict'
const fs = require('fs')
const path = require('path')

const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }
const readJsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch { return [] } }
const pct = (a, b) => (b ? Math.round(100 * a / b) + '%' : '-')

// Pure: inputs -> markdown
function buildDigest({ roadmap, flags = [], gate, lease, loops, deploys = [], question = null, now = Date.now(), hours = 24 }) {
  const since = now - hours * 3600000
  const L = [`# Bot digest, ${new Date(now).toISOString().slice(0, 10)}`, '']
  // 1. phase progress: done of measured, and how much is measured at all
  if (roadmap && roadmap.phases) {
    L.push('## Roadmap')
    for (const [ph, p] of Object.entries(roadmap.phases)) L.push(`- Phase ${ph}: ${p.done} done of ${p.measured} measured (${p.total - p.measured} of ${p.total} items have no record to measure yet)`)
    const open = (roadmap.items || []).filter(i => i.status === 'open').slice(0, 3).map(i => i.title)
    if (open.length) L.push(`- Next open: ${open.join('; ')}`)
  } else L.push('## Roadmap', '- no roadmap.json yet (the roadmap module writes it every 10 minutes)')
  // 2. weakest ratios: flags in the window, by kind
  const recent = flags.filter(f => Date.parse(f.at) >= since)
  const byKind = {}; for (const f of recent) byKind[f.kind] = (byKind[f.kind] || 0) + 1
  L.push('', '## Flags', recent.length ? `- ${recent.length} in the last ${hours} h: ` + Object.entries(byKind).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k} ${n}`).join(', ') : `- none in the last ${hours} h`)
  // 3. rules: violations and fights, by exception
  const gv = gate ? Object.entries(gate.rules || {}).filter(([, r]) => r.violations > 0) : []
  if (gv.length) { L.push('', '## Rule violations (packet gate)'); for (const [k, r] of gv) { const top = Object.entries(r.sites || {}).sort((a, b) => b[1] - a[1])[0]; L.push(`- ${k} [${r.mode}]: ${r.violations}${r.blocked ? ` (${r.blocked} blocked)` : ''}${top ? `, mostly ${top[0]}` : ''}`) } }
  const fights = lease ? Object.values(lease.fights || {}) : []
  if (fights.length) { L.push('', '## Loops fighting over a movement key'); for (const f of fights.sort((a, b) => b.count - a.count).slice(0, 3)) L.push(`- ${f.control}: ${f.a} vs ${f.b} (${f.count}x)`) }
  const lp = loops ? Object.entries(loops.pairs || {}).filter(([, v]) => v.count >= 3) : []
  if (lp.length) { L.push('', '## Step ping-pong'); for (const [k, v] of lp.sort((a, b) => b[1].count - a[1].count).slice(0, 3)) L.push(`- ${k.replace('|', ' <-> ')}: ${v.count}x`) }
  // 4. what was promoted / reverted itself
  const dd = deploys.filter(d => d.t >= since)
  const promoted = dd.filter(d => d.event === 'deploy'), reverted = dd.filter(d => d.event === 'revert'), refused = dd.filter(d => d.event === 'refused')
  L.push('', '## Deploys', `- promoted ${promoted.length}${promoted.length ? ` (now at ${promoted[promoted.length - 1].to})` : ''}, reverted itself ${reverted.length}${reverted.length ? ` (${reverted.map(r => r.from).join(', ')})` : ''}, held back ${refused.length}${refused.length ? ` (${[...new Set(refused.map(r => r.why))].join(', ')})` : ''}`)
  // 5. at most one question
  if (question) L.push('', '## One question', `- ${String(question).split('\n')[0].slice(0, 300)}`)
  return L.join('\n') + '\n'
}

function main(argv) {
  const a = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
  const state = path.resolve(a('--state', path.join(process.cwd(), 'brain', 'state'))), code = a('--code', null), hours = +a('--hours', 24)
  const md = buildDigest({
    roadmap: readJson(path.join(state, 'roadmap.json')), flags: readJsonl(path.join(state, 'telemetry', 'flags.jsonl')), gate: readJson(path.join(state, 'gate-log.json')),
    lease: readJson(path.join(state, 'lease-log.json')), loops: readJson(path.join(state, 'runlog', 'step-loops.json')),
    deploys: code ? readJsonl(path.join(code, 'deploys.jsonl')) : [], hours,
    question: (() => { try { return fs.readFileSync(path.join(state, 'digest-question.txt'), 'utf8').trim() || null } catch { return null } })()
  })
  const out = path.resolve(a('--out', path.join(state, 'digest')))
  try { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, new Date().toISOString().slice(0, 10) + '.md'), md) } catch (e) { console.error('could not save: ' + e.message) }
  process.stdout.write(md)
}
if (require.main === module) main(process.argv.slice(2))
module.exports = { buildDigest }
