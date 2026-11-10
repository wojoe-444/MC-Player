#!/usr/bin/env node
// node tools/scenarios/run.js [filter] [--runs 30] [--port 25599] [--bots TrialA,TrialB,TrialC,TrialD] [--out dir]
const fs = require('fs')
const path = require('path')
const { runAll, summarize, table } = require('./harness')
const scenarios = require('./scenarios')

const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d }
const filter = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--'))) || ''
const runs = +opt('runs', 30), port = +opt('port', 25599), bots = opt('bots', 'TrialA,TrialB,TrialC,TrialD').split(','), out = opt('out', path.join(__dirname, 'results'))

;(async () => {
  const list = scenarios.filter(s => s.name.includes(filter))
  if (!list.length) { console.error('no scenario matches ' + filter); process.exit(2) }
  fs.mkdirSync(out, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const jsonl = path.join(out, `runs-${stamp}.jsonl`)
  const results = await runAll({ port, bots, scenarios: list, runs, onResult: (r) => fs.appendFileSync(jsonl, JSON.stringify(r) + '\n') })
  const rows = summarize(results), md = table(rows)
  fs.writeFileSync(path.join(out, `summary-${stamp}.md`), `# Scenario rates ${stamp}\n\n${runs} runs per scenario, bots ${bots.join(', ')}, commit ${require('child_process').execSync('git rev-parse --short HEAD').toString().trim()}\n\n${md}\n`)
  fs.writeFileSync(path.join(out, `baseline-latest.json`), JSON.stringify({ stamp, runs, rows }, null, 1))
  console.log('\n' + md)
  process.exit(rows.some(r => r.rate < 1) ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(2) })
