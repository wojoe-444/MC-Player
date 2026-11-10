#!/usr/bin/env node
// `npm test`: runs every test file (one `node --test` process per file, 4 at a time) and prints a summary. Exit code 1 if any file fails.
// Usage: node scripts/run-tests.js [substring ...]      (only files whose path contains one of the substrings)
//
// No CI runs this (Walter 2026-11-10: nothing runs in the repo itself); it is for people, agents and a scheduled agent in the app.
// KNOWN_FLAKY files drive a mock world with 10 ms timers and lose a race now and then (treefarm pillar drops). They get up to two more tries,
// and the summary says so loudly ("passed on retry") so the flakiness is never hidden; every other file must pass first time.
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const KNOWN_FLAKY = new Set(['test/treefarm.test.js', 'test/treefarm.canopy.test.js', 'test/treefarm.clear.test.js'])
// Tests that fail on main for a reason not yet fixed. They are listed here by exact name, printed in every run as KNOWN FAILING, and do not fail the run;
// any other failure does. When one starts passing the runner says so, so the entry gets deleted. Keep this list short and give each a reason.
const KNOWN_FAILING = {
  // The mock world's 10 ms item-fall timer leaves one pillar-block drop hanging at its old height when this test runs after other tests in the same process
  // (alone it passes); the drop is then never collected. The treefarm pillar goes away with the motor layer (docs/HILLCLIMB-INSIGHTS.md item 7), and this test with it.
  'test/treefarm.test.js': ['a pillar left in the state by a crash is taken down at the start of the next run']
}
const DIRS = ['test', 'app/test', 'reviewer/test']
const CONCURRENCY = Number(process.env.TEST_CONCURRENCY) || 4

function listFiles(filters) {
  const out = []
  for (const d of DIRS) {
    const full = path.join(ROOT, d)
    if (!fs.existsSync(full)) continue
    for (const f of fs.readdirSync(full).sort()) if (f.endsWith('.test.js')) out.push(`${d}/${f}`)
  }
  return filters.length ? out.filter(f => filters.some(s => f.includes(s))) : out
}

function runOne(file) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const p = spawn(process.execPath, ['--test', path.join(ROOT, file)], { cwd: ROOT, env: process.env })
    let out = ''
    p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { out += d })
    p.on('close', code => resolve({ file, ok: code === 0, out, ms: Date.now() - t0 }))
  })
}

async function runWithRetry(file) {
  const tries = KNOWN_FLAKY.has(file) ? 3 : 1
  let r
  for (let i = 1; i <= tries; i++) {
    r = await runOne(file)
    r.tries = i
    if (r.ok) break
  }
  return r
}

function failedNames(out) {
  return out.split('\n').filter(l => /^\s*not ok \d+ - /.test(l)).map(l => l.replace(/^\s*not ok \d+ - /, '').trim())
}

async function main() {
  const files = listFiles(process.argv.slice(2))
  if (!files.length) { console.error('no test files match'); process.exit(2) }
  const results = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, async () => {
    while (next < files.length) {
      const f = files[next++]
      const r = await runWithRetry(f)
      results.push(r)
      console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${f} (${(r.ms / 1000).toFixed(1)}s${r.tries > 1 ? `, ${r.ok ? 'PASSED ON RETRY' : 'failed'} after ${r.tries} tries` : ''})`)
    }
  }))
  // a failed file counts as "known" only when every failing test in it is listed in KNOWN_FAILING
  const known = []
  for (const r of results) {
    if (r.ok && KNOWN_FAILING[r.file]) console.log(`NOTE ${r.file}: known-failing test now passes, delete its KNOWN_FAILING entry`)
    if (r.ok) continue
    const names = failedNames(r.out), allowed = KNOWN_FAILING[r.file] || []
    if (names.length && names.every(n => allowed.includes(n))) { r.known = true; known.push(r) }
  }
  const bad = results.filter(r => !r.ok && !r.known).sort((a, b) => a.file.localeCompare(b.file))
  for (const r of known) for (const n of failedNames(r.out)) console.log(`KNOWN FAILING ${r.file}: ${n}`)
  const flaky = results.filter(r => r.ok && r.tries > 1)
  for (const r of bad) { console.log(`\n--- ${r.file}`); for (const n of failedNames(r.out)) console.log('  not ok - ' + n); if (!failedNames(r.out).length) console.log(r.out.split('\n').slice(-30).join('\n')) }
  console.log(`\n${results.length} files, ${results.length - bad.length - known.length} passed, ${known.length} with known failures, ${bad.length} failed${flaky.length ? `, ${flaky.length} only on retry (${flaky.map(r => r.file).join(', ')})` : ''}`)
  process.exit(bad.length ? 1 : 0)
}
main()
