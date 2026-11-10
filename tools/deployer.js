#!/usr/bin/env node
// The deployer (docs/HILLCLIMB-INSIGHTS.md item 9): get `main` onto the live bots without Walter copying files, and take a deploy back when the bots get worse.
// It touches only the code folder it is given (a git clone that exists to be deployed to) and writes records next to the bots; it never edits the world,
// never installs the app, and never runs two bots differently (no A/B between bots: each bot is compared with ITS OWN previous hours).
//
//   node tools/deployer.js deploy --code <clone> [--runtime <dir>]... [--test-cmd "npm test"] [--no-tests] [--restart-cmd "<cmd>"] [--dry-run]
//   node tools/deployer.js judge  --code <clone> [--runtime <dir>]... [--min-minutes 40]
//   node tools/deployer.js status --code <clone>
//
// deploy: fetch origin/main; stop if the clone has local changes (drift is reported, never overwritten); run the tests on the candidate commit in a scratch
//         worktree (merge on green); fast-forward the clone; then tell the bots: only brain/autopilot/*.js (the files ap.reload() re-reads) hot-reloads through
//         brain/state/ap-cmd.js in every --runtime folder, anything else asks for a restart (--restart-cmd, else a restart-needed.json for whoever supervises).
// judge:  for the latest deploy, once --min-minutes (default 40, about two in-game days) have passed, compare the weighted flags per hour since the deploy with the
//         same-length window before it, per runtime folder. Clearly worse (at least 1.5x and 6 more weighted flags; high = 3, med = 1) puts the clone back on the
//         previous commit, marks the commit bad (it is not redeployed until main moves on) and reloads or restarts the same way.
// Records: <code>/deploys.jsonl (one line per deploy / revert / judge verdict), <code>/deploy-bad.json.  All plain git and files; no network except `git fetch`.
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync, spawnSync } = require('child_process')

const RELOADABLE = new Set(['hallway.js', 'skills.js', 'mining.js', 'goals.js', 'plan.js', 'memory.js', 'think.js', 'watchdog.js', 'commit.js'].map(f => 'brain/autopilot/' + f))
const WEIGHT = { high: 3, med: 1, low: 0 }

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }).toString().trim()

// Pure: what a set of changed files needs from a running bot.
function classify(files) {
  const f = files.filter(Boolean)
  const reloadOnly = f.length > 0 && f.every(x => RELOADABLE.has(x) || /\.(md|txt)$/.test(x) || x.startsWith('docs/') || x.startsWith('test/') || x.startsWith('tools/') || x.startsWith('.claude/'))
  const touchesBot = f.some(x => RELOADABLE.has(x))
  const installNeeded = f.includes('package.json') || f.includes('package-lock.json')
  const inert = f.length > 0 && f.every(x => /\.(md|txt)$/.test(x) || x.startsWith('docs/') || x.startsWith('test/') || x.startsWith('tools/') || x.startsWith('.claude/'))
  return { action: f.length === 0 || inert ? 'none' : reloadOnly && touchesBot ? 'reload' : 'restart', installNeeded }
}

// Pure: weighted flags in [from, to) from flags.jsonl lines ({ at: ISO, sev })
function weigh(lines, from, to) {
  let w = 0, n = 0
  for (const l of lines) { const t = Date.parse(l.at); if (t >= from && t < to) { w += WEIGHT[l.sev] ?? 1; n++ } }
  return { weight: w, count: n }
}

// Pure: is the window after a deploy clearly worse than the same-length window before it?
function verdict({ deployedAt, now, before, after, minMs = 40 * 60000 }) {
  const waited = now - deployedAt
  if (waited < minMs) return { verdict: 'wait', waitedMin: Math.round(waited / 60000), needMin: Math.round(minMs / 60000) }
  const worse = after.weight >= 1.5 * before.weight && after.weight - before.weight >= 6
  return { verdict: worse ? 'worse' : 'ok', before: before.weight, after: after.weight, windowMin: Math.round(waited / 60000) }
}

function readJsonl(file) { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch { return [] } }
function readJson(file, d) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return d } }
const record = (code, rec) => fs.appendFileSync(path.join(code, 'deploys.jsonl'), JSON.stringify({ t: Date.now(), ...rec }) + '\n')
const flagsOf = (runtime) => readJsonl(path.join(runtime, 'brain', 'state', 'telemetry', 'flags.jsonl'))

// Tell the running bots: reload through the eval channel, or restart (command, else a note for the supervisor)
function notify(code, runtimes, action, why, { restartCmd, dryRun } = {}) {
  const done = []
  if (action === 'none' || dryRun) return done
  if (action === 'reload') {
    for (const rt of runtimes) {
      try { const f = path.join(rt, 'brain', 'state', 'ap-cmd.js'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "return bot._ap && bot._ap.reload ? bot._ap.reload() : 'no autopilot'\n"); done.push('reload ' + rt) } catch (e) { done.push('reload failed ' + rt + ': ' + e.message) }
    }
    return done
  }
  if (restartCmd) { const r = spawnSync(restartCmd, { shell: true, cwd: code, timeout: 120000 }); done.push(`restart-cmd exit ${r.status}`) }
  else for (const rt of runtimes.length ? runtimes : [code]) {
    try { fs.mkdirSync(rt, { recursive: true }); fs.writeFileSync(path.join(rt, 'restart-needed.json'), JSON.stringify({ at: new Date().toISOString(), why, commit: git(code, 'rev-parse', '--short=9', 'HEAD') }, null, 1)); done.push('restart-needed.json in ' + rt) } catch (e) { done.push('could not write restart note: ' + e.message) }
  }
  return done
}

function runTests(code, commit, testCmd) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-'))
  try {
    git(code, 'worktree', 'add', '--detach', dir + '/wt', commit)
    try { if (fs.existsSync(path.join(code, 'node_modules'))) fs.symlinkSync(path.join(code, 'node_modules'), path.join(dir, 'wt', 'node_modules'), 'dir') } catch { /* tests will say */ }
    const r = spawnSync(testCmd, { shell: true, cwd: path.join(dir, 'wt'), timeout: 30 * 60000, encoding: 'utf8' })
    return { ok: r.status === 0, status: r.status, tail: String(r.stdout || '').split('\n').filter(Boolean).slice(-6).join('\n') + String(r.stderr || '').slice(-300) }
  } finally { try { git(code, 'worktree', 'remove', '--force', dir + '/wt') } catch { /* leave it */ } try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } }
}

function deploy(o) {
  const code = o.code, remote = o.remote || 'origin', branch = o.branch || 'main', runtimes = o.runtimes || []
  const out = { steps: [] }
  const step = (s) => { out.steps.push(s); if (o.log) o.log(s) }
  const dirty = git(code, 'status', '--porcelain', '--untracked-files=no')
  if (dirty) { step('drift: the clone has local changes, nothing deployed:\n' + dirty); out.result = 'drift'; record(code, { event: 'refused', why: 'drift', files: dirty.split('\n').length }); return out }
  git(code, 'fetch', '-q', remote, branch)
  const from = git(code, 'rev-parse', 'HEAD'), to = git(code, 'rev-parse', `${remote}/${branch}`)
  if (from === to) { step('already at ' + to.slice(0, 9)); out.result = 'current'; return out }
  try { git(code, 'merge-base', '--is-ancestor', from, to) } catch { step('the clone is not an ancestor of ' + remote + '/' + branch + ' (local commits?): nothing deployed'); out.result = 'diverged'; record(code, { event: 'refused', why: 'diverged' }); return out }
  const bad = readJson(path.join(code, 'deploy-bad.json'), { commits: [] })
  if (bad.commits.includes(to)) { step(to.slice(0, 9) + ' was taken back earlier; waiting for main to move on'); out.result = 'bad'; return out }
  const files = git(code, 'diff', '--name-only', from, to).split('\n').filter(Boolean)
  const kind = classify(files)
  step(`candidate ${to.slice(0, 9)}: ${files.length} file(s) changed, needs: ${kind.action}${kind.installNeeded ? ' + npm install' : ''}`)
  if (o.tests !== false) {
    const t = runTests(code, to, o.testCmd || 'npm test')
    step(t.ok ? 'tests green' : 'tests FAILED, not deploying:\n' + t.tail)
    if (!t.ok) { out.result = 'red'; record(code, { event: 'refused', why: 'tests', to: to.slice(0, 9), tail: t.tail.slice(-300) }); return out }
  }
  if (o.dryRun) { step('dry run: would fast-forward and ' + kind.action); out.result = 'dry-run'; return out }
  git(code, 'merge', '--ff-only', `${remote}/${branch}`)
  const actions = notify(code, runtimes, kind.action, `${files.length} files changed: ${files.slice(0, 5).join(', ')}`, o)
  record(code, { event: 'deploy', from: from.slice(0, 9), to: to.slice(0, 9), files: files.length, action: kind.action, installNeeded: kind.installNeeded, runtimes, actions })
  step(`deployed ${from.slice(0, 9)} -> ${to.slice(0, 9)}${kind.installNeeded ? ' (package files changed: run npm install, then restart)' : ''}; ${actions.join('; ') || 'no bot action needed'}`)
  if (kind.installNeeded) notify(code, runtimes, 'restart', 'package files changed: npm install first', { ...o, restartCmd: null })
  out.result = 'deployed'
  return out
}

function judge(o) {
  const code = o.code, runtimes = o.runtimes || [], now = o.now || Date.now()
  const recs = readJsonl(path.join(code, 'deploys.jsonl'))
  const dep = [...recs].reverse().find(r => r.event === 'deploy')
  if (!dep) return { result: 'no deploy yet' }
  if (recs.some(r => (r.event === 'verdict' || r.event === 'revert') && r.deployT === dep.t)) return { result: 'already judged' }
  const deployedAt = dep.t, win = now - deployedAt
  const per = runtimes.map(rt => { const fl = flagsOf(rt); const after = weigh(fl, deployedAt, now), before = weigh(fl, deployedAt - win, deployedAt); return { runtime: rt, ...verdict({ deployedAt, now, before, after, minMs: (o.minMinutes ?? 40) * 60000 }) } })
  if (!per.length) return { result: 'no runtime folders given', deploy: dep }
  if (per.some(p => p.verdict === 'wait')) return { result: 'wait', per }
  const worse = per.filter(p => p.verdict === 'worse')
  if (!worse.length) { record(code, { event: 'verdict', deployT: dep.t, to: dep.to, verdict: 'ok', per }); return { result: 'ok', per } }
  // the same bot, clearly worse than its own previous hours: put the clone back (no local work lives in it: deploy refuses a dirty clone)
  const bad = readJson(path.join(code, 'deploy-bad.json'), { commits: [] })
  const full = git(code, 'rev-parse', dep.to), prev = git(code, 'rev-parse', dep.from)
  if (!bad.commits.includes(full)) bad.commits.push(full)
  fs.writeFileSync(path.join(code, 'deploy-bad.json'), JSON.stringify(bad, null, 1))
  if (!o.dryRun) git(code, 'reset', '--hard', prev)
  const files = git(code, 'diff', '--name-only', prev, full).split('\n').filter(Boolean)
  const actions = notify(code, runtimes, classify(files).action === 'none' ? 'none' : classify(files).action, 'reverted ' + dep.to, o)
  record(code, { event: 'revert', deployT: dep.t, from: dep.to, to: dep.from, per, actions })
  return { result: 'reverted', per, actions }
}

function status(o) {
  const recs = readJsonl(path.join(o.code, 'deploys.jsonl'))
  let head = null; try { head = git(o.code, 'rev-parse', '--short=9', 'HEAD') } catch { /* not a clone */ }
  return { head, bad: readJson(path.join(o.code, 'deploy-bad.json'), { commits: [] }).commits.map(c => c.slice(0, 9)), last: recs.slice(-5) }
}

function parseArgs(argv) {
  const o = { runtimes: [], cmd: argv[0] }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i]
    if (a === '--code') o.code = path.resolve(v()); else if (a === '--runtime') o.runtimes.push(path.resolve(v()))
    else if (a === '--test-cmd') o.testCmd = v(); else if (a === '--no-tests') o.tests = false
    else if (a === '--restart-cmd') o.restartCmd = v(); else if (a === '--dry-run') o.dryRun = true
    else if (a === '--min-minutes') o.minMinutes = +v(); else if (a === '--branch') o.branch = v(); else if (a === '--remote') o.remote = v()
  }
  return o
}

if (require.main === module) {
  const o = parseArgs(process.argv.slice(2)); o.log = (s) => console.log(s)
  if (!o.code || !['deploy', 'judge', 'status'].includes(o.cmd)) { console.error('usage: node tools/deployer.js deploy|judge|status --code <clone> [--runtime <dir>]... (see the header of this file)'); process.exit(2) }
  try { const r = o.cmd === 'deploy' ? deploy(o) : o.cmd === 'judge' ? judge(o) : status(o); if (o.cmd !== 'deploy') console.log(JSON.stringify(r, null, 1)); process.exit(o.cmd === 'deploy' && ['red', 'drift', 'diverged'].includes(r.result) ? 1 : 0) } catch (e) { console.error('deployer: ' + e.message); process.exit(1) }
}

module.exports = { classify, weigh, verdict, deploy, judge, status, RELOADABLE }
