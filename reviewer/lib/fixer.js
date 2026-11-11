// The fixer (docs/MEMORY-LOOP.md, job 5): one work order per run, from the most costly open order to a pull request.
//
//   node run.js --fix               what Task Scheduler runs (its own entry, every 3 h): pick an order, fix it, check the fix, open the PR
//   node run.js --fix --only KEY    that order, even a parked one        --fix-mode merge|pr|local   (default: the app's setting, else merge)
//   node run.js --fix-dry-run       print the order it would take and the prompt; no model call, no change
//
// A run:
//   1. finish what an earlier run left: a checked fix that could not be pushed, a pull request somebody closed
//   2. pick the top open order that is not waiting on a pull request or a deploy verdict and has attempts left
//   3. put the working copy (<loop dir>/fixer/MC-Player, a clone of the public repo) on a new branch from main
//   4. write the evidence beside it (the order, its snapshots, the journal lines about it): on this computer, outside the working copy, never committed
//   5. one agent session (lib/claude.js runAgent): file tools limited to the working copy, plus three tools of ours: run_node, run_tests, git (read only).
//      No shell, no web, no push. It answers fixed, telemetry (could not reproduce: ship what will catch it next time) or gave-up.
//   6. the checks, by code, on whatever the session left (check() below). A session that says "fixed" is not believed: the new test must fail on main
//      and pass with the change, the whole suite must pass, the diff must stay inside the fixer's remit. One more session may repair a failed check.
//   7. commit, push the branch, open the pull request with the GitHub CLI and, in merge mode with nothing held, merge it. The deployer ships it and
//      judges it (lib/deploy.js); its verdict closes the order or leaves it open.
//   8. a failed attempt is written on the order with what was tried; after MAX_ATTEMPTS the order is parked for a person or a thread.
//
// What it may never change (ALLOWED / PROTECTED below): the rules, CLAUDE.md, the bot's memory and its free time, the tests' runner, dependencies,
// the loop's own jobs. The bot is an independent player: the fixer repairs how its code carries out what it decided, not what it wants.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync, spawn } = require('child_process')
const orders = require('./orders')
const runs = require('./runs')

const MAX_ATTEMPTS = 2
const LIMITS = { lines: 400, files: 12, turns: 150, sessionMs: 40 * 60000, testMs: 8 * 60000, suiteMs: 30 * 60000, lockMs: 100 * 60000, keepSessions: 30, journalLines: 300 }
const REPO = 'https://github.com/wojoe-444/MC-Player.git'
const ALLOWED = [/^brain\//, /^test\/[^/]+$/, /^join\.js$/, /^tools\/scenarios\//]
const PROTECTED = [/^brain\/gate\//, /^brain\/memory\//, /^brain\/state\//, /^brain\/autopilot\/whimsy\.js$/]
const FREE_TIME = /whimsy|free[ _-]?time|freetime/i
const SCRATCH = '.fixer-scratch'
const AUTHOR = ['-c', 'user.name=MC-Player fixer', '-c', 'user.email=fixer@mc-player.invalid']

const cut = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const tail = (s, n) => { s = String(s || ''); return s.length > n ? '…' + s.slice(-n) : s }
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')) } catch { return d } }
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(o, null, 1)); fs.renameSync(f + '.tmp', f) }
const posix = (p) => String(p).split(path.sep).join('/')
const fixDir = (cfg) => path.join(cfg.loopDir, 'fixer')
const workDir = (cfg) => path.join(fixDir(cfg), 'MC-Player')
const stateFile = (cfg) => path.join(fixDir(cfg), 'state.json')
const readyBody = (cfg, key) => path.join(fixDir(cfg), `ready-${orders.slug(key)}.md`)          // the pull request text of a checked fix that waits to be pushed
const modeOf = (cfg) => ['merge', 'pr', 'local'].includes(cfg.fixMode) ? cfg.fixMode : 'merge'

// the environment the agent's commands run in: nothing that looks like a credential. (Code it runs is still code on this computer: see the README.)
function cleanEnv(env = process.env) {
  const e = {}
  // (NODE_TEST_CONTEXT too: with it a `node --test` child reports to a parent test runner and exits 0 whatever its tests did)
  for (const [k, v] of Object.entries(env)) if (!/TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|MC_EMAIL|^ANTHROPIC|^CLAUDE|^GH_|^GITHUB_|^OPENROUTER|^AWS_|^AZURE_|^GOOGLE_|^NODE_TEST_CONTEXT$/i.test(k)) e[k] = v
  return e
}
// the node that runs the bot's tests: this process, or (when the job runs inside the app's Electron) the node on PATH that the bots themselves run on
let NODE = null
function nodeExe() {
  if (NODE) return NODE
  if (!process.versions.electron) return (NODE = process.execPath)
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['node'], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
  return (NODE = String(r.stdout || '').split(/\r?\n/).map(x => x.trim()).find(Boolean) || process.execPath)       // Electron itself as node: ELECTRON_RUN_AS_NODE is already set
}
// -> { code, out }: never throws, never a shell
function sh(cmd, args, { cwd, timeout = 120000, env = process.env } = {}) {
  const r = spawnSync(cmd, args, { cwd, timeout, env: { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
  return { code: r.error ? (r.error.code === 'ETIMEDOUT' ? 124 : 127) : r.status, out: `${r.stdout || ''}${r.stderr || ''}${r.error ? `\n${r.error.message}` : ''}` }
}

// the same without blocking: the agent's tools run while the session's own pipe to the SDK has to stay served
function shAsync(cmd, args, { cwd, timeout = 120000, env = process.env } = {}) {
  return new Promise((resolve) => {
    let out = '', done = false
    const fin = (code, extra = '') => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out: out + extra }) }
    let p; try { p = spawn(cmd, args, { cwd, env, windowsHide: true }) } catch (e) { return resolve({ code: 127, out: e.message }) }
    const timer = setTimeout(() => { try { p.kill() } catch { /* gone */ } fin(124, `\ntimed out after ${Math.round(timeout / 1000)} s`) }, timeout)
    const add = (d) => { out += d; if (out.length > 4e6) out = out.slice(-2e6) }
    p.stdout.on('data', add); p.stderr.on('data', add)
    p.on('error', (e) => fin(127, `\n${e.message}`)); p.on('close', (code) => fin(code == null ? 1 : code))
  })
}

// ---------- which order ----------

// what the order's history says since it was last opened: failed attempts (with what was tried), and whether it waits on a pull request or a deploy
function progress(o) {
  let attempts = [], waiting = null, ready = null
  for (const h of (o && o.history) || []) {
    if (h.ev === 'opened' || h.ev === 'reopened') { attempts = []; waiting = null; ready = null }
    else if (h.ev === 'attempt') { attempts.push(h); waiting = null; ready = null }
    else if (h.ev === 'ready') { ready = h; waiting = null }
    else if (h.ev === 'pr') { waiting = { on: h.merged ? 'deploy' : 'merge', pr: h.pr, at: h.at }; ready = null }
    else if (h.ev === 'deploy') waiting = { on: 'verdict', pr: o.pr, at: h.at }
    else if (h.ev === 'verdict') { waiting = null; if (h.verdict && h.verdict !== 'ok') attempts.push({ at: h.at, ev: 'attempt', outcome: 'reverted', why: `PR #${o.pr} was deployed and judged ${h.verdict}: ${cut(h.why || h.note || '', 200)}`, pr: o.pr }) }
  }
  return { attempts, waiting, ready }
}
// the order this run takes: open, not waiting, attempts left; most costly first (orders.list is already in that order)
function pick(list, { only = null } = {}) {
  if (only) return list.find(o => o.key === only) || null
  // (an outcome order is a build that makes nothing or a setting a person has to change: the world's problem, not a fault in the code)
  return list.find(o => { if (o.status !== 'open' || o.type === 'outcome' || o.kind === 'human') return false; const p = progress(o); return !p.waiting && !p.ready && p.attempts.length < MAX_ATTEMPTS }) || null
}

// ---------- the working copy ----------

function prepare(cfg, branch, run = sh, keep = []) {
  const dir = workDir(cfg), repo = cfg.fixRepo || REPO
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true })
    const r = run('git', ['clone', '--quiet', repo, dir], { timeout: 10 * 60000 })
    if (r.code !== 0) return { ok: false, error: `could not clone ${repo}: ${cut(r.out, 200)}` }
  }
  let r = run('git', ['fetch', '--quiet', 'origin', 'main'], { cwd: dir, timeout: 5 * 60000 })
  if (r.code !== 0) return { ok: false, error: `could not fetch main: ${cut(r.out, 200)}` }
  r = run('git', ['checkout', '--quiet', '--force', '-B', branch, 'origin/main'], { cwd: dir })
  if (r.code !== 0) return { ok: false, error: `could not start ${branch}: ${cut(r.out, 200)}` }
  run('git', ['clean', '-fdq'], { cwd: dir })
  // branches of earlier attempts go, except a checked fix that still waits to be pushed
  for (const b of run('git', ['branch', '--format=%(refname:short)'], { cwd: dir }).out.split('\n').map(x => x.trim())) if (/^fix\//.test(b) && b !== branch && !keep.includes(b)) run('git', ['branch', '-D', b], { cwd: dir })
  // the borrowed node_modules is a link, which the repository's "node_modules/" ignore rule (folders only) does not cover
  try { const ex = path.join(dir, '.git', 'info', 'exclude'), cur = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : ''; if (!/^node_modules$/m.test(cur)) { fs.mkdirSync(path.dirname(ex), { recursive: true }); fs.appendFileSync(ex, `\nnode_modules\n${SCRATCH}/\n`) } } catch { /* check() would refuse the change */ }
  const deps = linkModules(cfg, dir, run)
  if (!deps.ok) return deps
  return { ok: true, dir, branch, base: run('git', ['rev-parse', 'origin/main'], { cwd: dir }).out.trim(), deps: deps.how }
}
// the tests need the bot's dependencies: borrow the live clone's node_modules (a junction on Windows: a plain directory link needs admin rights), else install
function linkModules(cfg, dir, run = sh) {
  const mine = path.join(dir, 'node_modules')
  if (fs.existsSync(mine)) return { ok: true, how: 'present' }
  const theirs = cfg.codeDir && path.join(cfg.codeDir, 'node_modules')
  if (theirs && fs.existsSync(theirs)) { try { fs.symlinkSync(theirs, mine, process.platform === 'win32' ? 'junction' : 'dir'); return { ok: true, how: 'linked' } } catch { /* install instead */ } }
  const r = spawnSync('npm ci --no-audit --no-fund', { shell: true, cwd: dir, timeout: 20 * 60000, encoding: 'utf8', windowsHide: true })
  return r.status === 0 ? { ok: true, how: 'installed' } : { ok: false, error: `npm ci failed in the working copy: ${cut(`${r.stdout || ''}${r.stderr || ''}`.slice(-400), 300)}` }
}

// ---------- the evidence ----------

// the journal lines about this order from the last two days of one bot: its step, or alarms, deaths and flags that name it
function journalFor(bot, o, now) {
  const dir = path.join(bot.dir, 'brain', 'state', 'journal'), out = []
  for (let d = 1; d >= 0; d--) {
    let text = ''; try { text = fs.readFileSync(path.join(dir, `${new Date(now - d * 86400000).toISOString().slice(0, 10)}.jsonl`), 'utf8') } catch { continue }
    for (const l of text.split('\n')) {
      if (!l) continue
      let e; try { e = JSON.parse(l) } catch { continue }
      const mine = o.type === 'step' ? (e.step === o.step || (e.k === 'step' && e.prev === o.step)) : o.type === 'death' ? e.k === 'death' : o.type === 'flag' ? (e.k === 'flag' && `flag-${orders.slug(e.kind)}` === o.key) : o.type === 'trample' ? (e.k === 'trample' || (e.k === 'flag' && e.kind === 'farmland_trampled')) : o.type === 'leftover' ? (e.k === 'leftover' || (e.k === 'flag' && /^leftover_/.test(e.kind || ''))) : false
      if (mine || e.k === 'commit') out.push(l)
    }
  }
  return out.slice(-LIMITS.journalLines)
}
function writeEvidence(cfg, o, now) {
  const dir = path.join(fixDir(cfg), 'evidence', orders.slug(o.key))
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true })
  const files = ['ORDER.md']
  fs.writeFileSync(path.join(dir, 'ORDER.md'), orders.toMarkdown([{ ...o, status: 'open' }], new Date(now).toISOString()))
  for (const b of cfg.bots || []) {
    const lines = o.bots && o.bots[b.id] ? journalFor(b, o, now) : []
    if (lines.length) { fs.writeFileSync(path.join(dir, `journal-${b.id}.jsonl`), lines.join('\n') + '\n'); files.push(`journal-${b.id}.jsonl`) }
  }
  for (const s of o.snapshots || []) {
    const [botId, id] = String(s).split('/'), bot = (cfg.bots || []).find(b => b.id === botId)
    if (!bot || !/^[\w.-]+$/.test(id || '')) continue
    try { fs.copyFileSync(path.join(bot.dir, 'brain', 'state', 'snapshots', `${id}.json`), path.join(dir, `snapshot-${botId}-${id}.json`)); files.push(`snapshot-${botId}-${id}.json`) } catch { /* rotated away */ }
  }
  return { dir, files }
}

// ---------- the agent's limits ----------

const inside = (root, p) => { const r = path.resolve(root, String(p || '')); return r === root || r.startsWith(root + path.sep) }
// through links too: the nearest existing folder of the target must really be inside the root
function reallyInside(root, p) {
  if (!inside(root, p)) return false
  let cur = path.resolve(root, String(p || ''))
  while (!fs.existsSync(cur)) { const up = path.dirname(cur); if (up === cur) return false; cur = up }
  try { const real = fs.realpathSync(cur), rr = fs.realpathSync(root); return real === rr || real.startsWith(rr + path.sep) } catch { return false }
}
const mayChange = (rel) => rel.startsWith(SCRATCH + '/') || (ALLOWED.some(r => r.test(rel)) && !PROTECTED.some(r => r.test(rel)))
// every tool call of the session passes here first -> { allow, why }
function gateFor({ dir, evidence, run = sh }) {
  // tests that are on main: read only. (Read from main itself, not the index: the checks stage the session's new test, and a repair session must be able to edit it.)
  const existing = new Set(run('git', ['ls-tree', '-r', '--name-only', 'origin/main', 'test'], { cwd: dir }).out.split('\n').filter(Boolean))
  return (name, input) => {
    if (/^mcp__fixer__(run_node|run_tests|git)$/.test(name)) return { allow: true }                 // our own tools check their own arguments
    if (name === 'Read' || name === 'Glob' || name === 'Grep') {
      const p = input.file_path || input.path || dir
      return inside(dir, p) || inside(evidence, p) ? { allow: true } : { allow: false, why: 'you can read the working copy and the evidence folder, nothing else on this computer' }
    }
    if (name === 'Edit' || name === 'Write') {
      const p = input.file_path
      if (!p || !reallyInside(dir, p)) return { allow: false, why: 'you can only change files inside the working copy' }
      const rel = posix(path.relative(dir, path.resolve(dir, p)))
      if (/^(\.git|node_modules)(\/|$)/.test(rel)) return { allow: false, why: 'not a file of the repository' }
      if (existing.has(rel)) return { allow: false, why: `${rel} is an existing test: add a new test file instead. If it asserts the faulty behaviour, say so and answer "gave-up".` }
      return mayChange(rel) ? { allow: true } : { allow: false, why: `${rel} is outside what the fixer may change (brain/ except the rules, the memory and the free time; new files in test/; join.js; tools/scenarios/; scratch files in ${SCRATCH}/)` }
    }
    return { allow: false, why: `${name} is not available in this session` }
  }
}
const GIT_READ = new Set(['log', 'show', 'diff', 'status', 'blame', 'grep', 'ls-files'])
function toolsFor({ dir, run = shAsync }) {
  const env = cleanEnv()
  const report = (r) => `exit code ${r.code}\n${tail(r.out, 12000)}`
  return [
    { name: 'run_node', description: 'Run one JavaScript file of the working copy with node and get its exit code and output. Set test to true for a test file (runs `node --test <file>`). Times out after 8 minutes.',
      shape: (z) => ({ file: z.string().describe('path inside the working copy, for example test/fix-step-iron.test.js'), test: z.boolean().optional(), args: z.array(z.string()).optional() }),
      handler: async (a) => {
        if (!reallyInside(dir, a.file) || /(^|[\\/])node_modules([\\/]|$)/.test(a.file) || !/\.(c|m)?js$/.test(a.file)) return 'refused: a .js file inside the working copy, please'
        if (!fs.existsSync(path.resolve(dir, a.file))) return `no such file: ${a.file}`
        return report(await run(nodeExe(), [...(a.test ? ['--test'] : []), path.resolve(dir, a.file), ...((a.args || []).slice(0, 12).map(String))], { cwd: dir, timeout: LIMITS.testMs, env }))
      } },
    { name: 'run_tests', description: 'Run the repository\'s test suite (`node scripts/run-tests.js`) and get the summary. With filters, only test files whose path contains one of them. The whole suite takes about five minutes, so run your own test with run_node while you work and the whole suite once at the end.',
      shape: (z) => ({ filters: z.array(z.string()).optional() }),
      handler: async (a) => report(await run(nodeExe(), [path.join(dir, 'scripts', 'run-tests.js'), ...((a.filters || []).slice(0, 12).map(String).filter(s => !s.startsWith('-')))], { cwd: dir, timeout: LIMITS.suiteMs, env })) },
    { name: 'git', description: 'Read the repository\'s history: log, show, diff, status, blame, grep or ls-files with the usual arguments. Read only: you never commit or push, the job does that after its checks.',
      shape: (z) => ({ args: z.array(z.string()).describe('for example ["log", "--oneline", "-8", "--", "brain/mining"]') }),
      handler: async (a) => {
        const args = (a.args || []).map(String)
        if (!GIT_READ.has(args[0]) || args.some(x => /^(-c|-C|--output|--ext-diff|--textconv|--exec|--upload-pack|--receive-pack|--git-dir|--work-tree|--no-index)\b/.test(x))) return `refused: only ${[...GIT_READ].join(', ')}, without options that write or run things`
        return report(await run('git', ['--no-pager', ...args], { cwd: dir, timeout: 60000, env }))
      } },
  ]
}

// ---------- the prompts ----------

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['outcome', 'title', 'rootCause', 'summary', 'tests', 'tried', 'question'],
  properties: {
    outcome: { type: 'string', enum: ['fixed', 'telemetry', 'gave-up'] },
    title: { type: 'string', description: 'the pull request title: what the change does, under 70 characters' },
    rootCause: { type: 'string', description: 'the cause in the code, with file and function. Empty when you did not find it.' },
    summary: { type: 'string', description: 'what you changed and why it fixes the cause, in a few sentences' },
    tests: { type: 'array', items: { type: 'string' }, description: 'the test files you added' },
    tried: { type: 'string', description: 'what you tried that did not work or did not reproduce: the next attempt reads this' },
    question: { type: 'string', description: 'only when the right fix depends on a preference of the person who runs the bots: the one question to ask. Otherwise empty.' },
  },
}
const SYSTEM = `You repair one fault in the code of a Minecraft bot. The bot is a Node.js program (mineflayer) that plays in a survival world day and night. A journal of what it did was read by another job, which found a problem that only a code change can fix and wrote it up as a work order. Nobody is watching this session: you work alone, and code checks your result afterwards.

The bot is an independent player with its own goals, its own memory and free time it spends as it chooses. You repair how its code carries out what it decided. You never change what it wants, the rules of the world, its memory or its free time.

## Where you are
- Your working directory is a clean copy of the repository on a new branch. Bot code is in brain/ (one folder per module) and join.js. Tests are test/*.test.js, run with node's built-in test runner. BRAIN.md and brain/INTERFACE.md describe the scheduler and the modules.
- The evidence folder (path in the task) holds the work order, journal lines about it and sometimes snapshots: the blocks around the bot when a detector fired. The evidence is a digest. A fact that is missing from it was not measured; it is not proof of anything.
- Tools: Read, Glob, Grep, Edit, Write for files; run_node to run one file (test: true for a test file); run_tests for the suite; git to read history. There is no shell and no network.

## How to work
1. Find the code. Search for the step or flag named in the order and read it with what calls it. Read one or two neighbouring tests to see how they build a fake bot and world.
2. Name the cause. Say which line does the wrong thing in which situation, and check that the evidence fits. If two causes fit, find what tells them apart.
3. Show it failing. Write a new test file test/fix-<order key>.test.js that sets up that situation with a small made-up world and fails on the current code because of the fault. It has to call code that already exists (the step's own entry point), so that it fails by an assertion and not by a missing file. Run it and read the failure: it has to fail for the reason you named, not because the test is wrong.
4. Fix the cause with the smallest change that does it. Do not tidy, rename or improve anything else.
5. Run your test again, then run_tests with no filters. A test that passed before and fails now means your change broke something: fix the change, not that test. A test that fails without your change too is not yours: name it in your summary, leave it alone, and carry on (the checks compare with main).
6. If you cannot make it fail, do not guess a fix. Add what would catch it next time instead: a journal event or a telemetry flag that records the missing fact, with a test that it is recorded. Answer "telemetry".
7. If neither is possible, change nothing and answer "gave-up". Say exactly what you tried; the next attempt starts from your notes.

## Limits. Code checks every one after you finish, and a result that breaks one is thrown away.
- You may change files in brain/ (never brain/gate, brain/memory, brain/state or brain/autopilot/whimsy.js), join.js and tools/scenarios/, and add new files in test/. Nothing else: not CLAUDE.md, not package.json, not the test runner.
- Do not edit or delete lines of tests that exist. If an existing test asserts the faulty behaviour, say so in "tried" and answer "gave-up": a person decides that.
- Do not remove or weaken anything about the bot's free time (whimsy).
- With outcome "fixed", your new test must fail without your change and pass with it.
- Keep it under ${LIMITS.lines} changed lines and ${LIMITS.files} files.
- Build test worlds by hand. Do not copy files from the evidence folder into the repository, and write no names or paths from this computer.
- Scratch files go in ${SCRATCH}/ (deleted afterwards). Do not commit or push.

## The answer
Plain sentences a maintainer can check. The title says what the change does. If the right fix depends on a preference of the person who runs the bots (how the bot should behave, not how the code works), do not decide it: put the one question in "question" and take the outcome that fits what you could do without the answer.`

const FORM = `Below is the closing report of a repair session on a Minecraft bot's code. Fill in the answer form from it. Use only what the report says: do not add causes, changes or tests it does not mention. outcome is "fixed" when it says it fixed the fault and its new test and the test suite pass, "telemetry" when it says it could not reproduce the fault and added recording instead, and "gave-up" in every other case, including a report that is unclear or cut off. Fields the report says nothing about are empty.`

function taskPrompt({ o, evidence, attempts, repair }) {
  const L = [`# Work order ${o.key}`, '', `**${o.title}**`, '', o.problem || '', '']
  for (const [b, n] of Object.entries(o.bots || {})) { L.push(`- ${b}: ${n.line} (${n.costMin} min lost in a day)`); for (const e of n.evidence || []) L.push(`  - ${e}`) }
  if (o.suggestion) L.push('', `Where the job that opened it would look first (a guess, check it): ${o.suggestion}`)
  L.push('', `Evidence folder: ${evidence.dir}`, `Files in it: ${evidence.files.join(', ')}`)
  if (o.reopens) L.push('', `This order was closed as fixed ${o.reopens} time(s) and came back${o.pr ? ` (last pull request: #${o.pr})` : ''}. Read that change with the git tool before you start: it did not fix the cause.`)
  if (attempts.length) {
    L.push('', '## Earlier attempts at this order (do not repeat them)')
    for (const a of attempts) L.push(`- ${String(a.at).slice(0, 16)}Z, ${a.outcome}: ${cut(a.why, 300)}${a.tried ? ` Tried: ${cut(a.tried, 500)}` : ''}`)
  }
  if (repair) L.push('', '## Your change is still in the working copy, and it did not pass the checks', '', repair, '', 'Repair it so the checks pass, or take it out and answer "gave-up". Do not start over.')
  L.push('', 'Work through it, then give your answer.')
  return L.join('\n')
}

// ---------- the checks ----------

// names and paths of this computer that must not reach a public repository
function privateWords(home = os.homedir(), user = (() => { try { return os.userInfo().username } catch { return '' } })()) {
  const w = [home, posix(home)]
  if (user && user.length >= 4 && !['root', 'user', 'admin', 'runner', 'claude'].includes(user.toLowerCase())) w.push(`Users\\${user}`, `Users/${user}`, `home/${user}`)
  return [...new Set(w.filter(s => s && s.length >= 6))]
}
function leaks(text, words = privateWords()) {
  const t = String(text || '')
  for (const w of words) if (t.toLowerCase().includes(w.toLowerCase())) return 'a path of this computer'
  if (/[A-Za-z0-9._%+-]+@(?!example\.|mc-player\.invalid|users\.noreply)[A-Za-z0-9-]+\.(com|net|org|io|de|uk)\b/.test(t)) return 'an email address'
  if (/\b(ghp|gho|github_pat|sk-ant|sk-or)[-_][A-Za-z0-9_-]{16,}/.test(t)) return 'something that looks like a key'
  return null
}
// the staged change against main -> { files: [{ status, path }], added, removed, lines }
function diffOf(dir, run = sh) {
  const names = run('git', ['diff', '--cached', '--name-status', '--no-renames', 'origin/main'], { cwd: dir }).out.split('\n').filter(Boolean).map(l => { const [status, ...p] = l.split('\t'); return { status: status[0], path: p.join('\t') } })
  const text = run('git', ['diff', '--cached', '--no-renames', '-U0', 'origin/main'], { cwd: dir }).out
  const added = [], removed = []; let file = null, head = false
  for (const l of text.split('\n')) {
    if (l.startsWith('diff --git ')) { head = true; continue }
    if (l.startsWith('@@')) { head = false; continue }
    if (head) { if (l.startsWith('+++ b/')) file = l.slice(6); else if (l.startsWith('--- a/')) file = l.slice(6); continue }
    if (l.startsWith('+')) added.push({ file, text: l.slice(1) })
    else if (l.startsWith('-')) removed.push({ file, text: l.slice(1) })
  }
  return { files: names, added, removed, lines: added.length + removed.length }
}
const isTest = (p) => /^test\/[^/]+\.test\.js$/.test(p)
// run the changed tests on main's code: a worktree of origin/main with only those test files copied over it -> the files that fail there
function failingOnMain(dir, tests, run = sh) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-base-')), wt = path.join(tmp, 'wt'), failed = [], missing = []
  try {
    const r = run('git', ['worktree', 'add', '--detach', wt, 'origin/main'], { cwd: dir })
    if (r.code !== 0) return { error: `could not check out main beside the working copy: ${cut(r.out, 160)}` }
    try { fs.symlinkSync(fs.realpathSync(path.join(dir, 'node_modules')), path.join(wt, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir') } catch { /* the tests will say */ }
    for (const t of tests) {
      fs.mkdirSync(path.dirname(path.join(wt, t)), { recursive: true }); fs.copyFileSync(path.join(dir, t), path.join(wt, t))
      const r2 = run(nodeExe(), ['--test', path.join(wt, t)], { cwd: wt, timeout: LIMITS.testMs, env: cleanEnv() })
      if (r2.code !== 0) { failed.push(t); if (/Cannot find module|MODULE_NOT_FOUND/.test(r2.out)) missing.push(t) }
    }
    return { failed, missing }
  } finally { run('git', ['worktree', 'remove', '--force', wt], { cwd: dir }); try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* next run's problem */ } run('git', ['worktree', 'prune'], { cwd: dir }) }
}
// -> { ok, fail?, detail?, hold: [reasons the pull request must wait for a person], files, lines, tests, failedOnMain }
function check({ dir, outcome, run = sh, words }) {
  try { fs.rmSync(path.join(dir, SCRATCH), { recursive: true, force: true }) } catch { /* not there */ }
  run('git', ['add', '-A'], { cwd: dir })
  const d = diffOf(dir, run), hold = []
  const res = { ok: false, hold, files: d.files.map(f => f.path), lines: d.lines, tests: [], failedOnMain: [] }
  const fail = (why, detail) => ({ ...res, fail: why, detail: detail ? tail(detail, 3000) : undefined })
  if (!d.files.length) return fail('the session left no change in the working copy')
  for (const f of d.files) {
    if (!mayChange(f.path)) return fail(`it changed ${f.path}, which the fixer may not touch`)
    if (isTest(f.path) && f.status === 'D') return fail(`it deleted the test ${f.path}`)
    if (/^test\//.test(f.path) && f.status === 'M' && d.removed.some(l => l.file === f.path)) hold.push(`it changed lines of the existing test ${f.path}`)
  }
  // free time: more lines about it taken out of a file than put back (an edited line counts on both sides)
  const ft = (rows, f) => rows.filter(l => l.file === f && FREE_TIME.test(l.text)).length
  if (d.files.some(f => ft(d.removed, f.path) > ft(d.added, f.path))) hold.push('it removed lines about the bot\'s free time')
  if (d.lines > LIMITS.lines || d.files.length > LIMITS.files) hold.push(`the change is large (${d.lines} lines in ${d.files.length} files)`)
  const leak = leaks(d.added.map(l => l.text).join('\n'), words)
  if (leak) return fail(`the change contains ${leak}`)
  res.tests = d.files.filter(f => isTest(f.path) && f.status !== 'D').map(f => f.path)
  if (!res.tests.length) return fail('there is no new test: a fix needs a test that shows the fault, telemetry needs a test that it is recorded')
  if (outcome === 'fixed') {
    const b = failingOnMain(dir, res.tests, run)
    if (b.error) return fail(b.error)
    res.failedOnMain = b.failed
    if (!b.failed.length) return fail(`the new test (${res.tests.join(', ')}) passes on main without the change, so it does not show the fault`)
    if (b.missing.length === b.failed.length) hold.push(`the new test fails on main only because a file it needs does not exist there (${b.missing.join(', ')}), which does not show the fault`)
  }
  for (const t of res.tests) {
    const r = run(nodeExe(), ['--test', path.join(dir, t)], { cwd: dir, timeout: LIMITS.testMs, env: cleanEnv() })
    if (r.code !== 0) return fail(`${t} fails with the change`, r.out)
  }
  const all = run(nodeExe(), [path.join(dir, 'scripts', 'run-tests.js')], { cwd: dir, timeout: LIMITS.suiteMs, env: cleanEnv() })
  if (all.code !== 0) {
    // a test that fails on main too is not this change's doing (a real trial, 2026-11-11: another merge had left one red, and a sound fix was refused for it)
    const lines = all.out.split('\n').filter(l => /^(FAIL|fail|not ok)\b|failed/.test(l.trim())).slice(0, 30).join('\n') || all.out
    const red = [...new Set(all.out.split('\n').map(l => /^FAIL\s+(\S+\.test\.js)/.exec(l.trim())).filter(Boolean).map(m => m[1]))].filter(f => fs.existsSync(path.join(dir, f)))
    if (!red.length || red.length > 8) return fail('the test suite fails with the change', lines)
    const b = failingOnMain(dir, red.filter(f => !res.tests.includes(f)), run)
    const mine = red.filter(f => res.tests.includes(f) || !(b.failed || []).includes(f))
    if (b.error || mine.length) return fail(`the test suite fails with the change${mine.length ? ` (${mine.join(', ')} passes on main)` : ''}`, lines)
    res.redOnMain = red
  }
  return { ...res, ok: true }
}

// ---------- publishing ----------

function ghReady(run = sh) {
  const v = run('gh', ['--version'], { timeout: 20000 })
  if (v.code !== 0) return { ok: false, note: 'the GitHub CLI (gh) is not installed: the fixer can check a fix but not open its pull request. Install it from https://cli.github.com and run `gh auth login` once.' }
  const a = run('gh', ['auth', 'status'], { timeout: 30000 })
  return a.code === 0 ? { ok: true, note: 'GitHub CLI is logged in' } : { ok: false, note: 'the GitHub CLI is installed but not logged in: run `gh auth login` once in a terminal.' }
}
const slugOf = (cfg) => cfg.fixSlug || repoSlug(cfg.fixRepo || REPO)                    // owner/name on GitHub, for the GitHub CLI
const repoSlug = (url) => { const m = /github\.com[:/]+([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(String(url || '')); return m ? m[1] : null }
function prBody({ o, answer, checked, hold }) {
  const L = [`Work order \`${o.key}\`: ${o.title}`, '', '## Cause', answer.rootCause || '(not found: this change adds what will catch it next time)', '', '## Change', answer.summary || '', '', '## Checks the fixer job ran before opening this',
    checked.failedOnMain.length ? `- ${checked.failedOnMain.join(', ')} fails on main and passes with this change` : `- new tests pass: ${checked.tests.join(', ')}`,
    (checked.redOnMain || []).length ? `- the test suite passes except ${checked.redOnMain.join(', ')}, which fails on main without this change too` : '- the whole test suite passes', `- ${checked.lines} changed lines in ${checked.files.length} files, all inside what the fixer may change`]
  if (hold.length) L.push('', '## Left open for a person', ...hold.map(h => `- ${h}`))
  L.push('', '---', '_Opened by the fixer job of the Bot Dashboard app: an unattended Claude session on the laptop that takes the most costly work order (docs/MEMORY-LOOP.md). The deployer puts it on the bots and reverts it if the journal says it made things worse._')
  return L.join('\n')
}
// push the checked branch and open (and maybe merge) its pull request -> { pushed, pr, merged, note }
function publish(cfg, { dir, branch, title, body, hold, run = sh }) {
  const mode = modeOf(cfg), slug = slugOf(cfg)
  if (mode === 'local') return { pushed: false, note: 'local mode: the fix stays on its branch in the working copy' }
  const gh = ghReady(run)
  if (!gh.ok) return { pushed: false, note: gh.note, gh }
  if (!slug) return { pushed: false, note: `the fixer's repository is not on GitHub: ${cfg.fixRepo}`, gh }
  const p = run('git', ['push', '--quiet', '-u', 'origin', branch], { cwd: dir, timeout: 5 * 60000 })
  if (p.code !== 0) return { pushed: false, note: `git push was refused (${cut(p.out, 160)}). Run \`gh auth setup-git\` once so git can use the GitHub CLI's login.`, gh }
  const bodyFile = path.join(fixDir(cfg), 'pr-body.md'); fs.writeFileSync(bodyFile, body)
  const c = run('gh', ['pr', 'create', '--repo', slug, '--base', 'main', '--head', branch, '--title', title, '--body-file', bodyFile], { cwd: dir, timeout: 120000 })
  const m = /\/pull\/(\d+)/.exec(c.out)
  if (c.code !== 0 || !m) return { pushed: true, note: `the branch ${branch} is pushed, but the pull request could not be opened: ${cut(c.out, 200)}`, gh }
  const pr = Number(m[1])
  if (mode !== 'merge' || hold.length) return { pushed: true, pr, merged: false, note: hold.length ? `opened #${pr} and left it for a person: ${hold.join('; ')}` : `opened #${pr} (pull request mode: a person merges)`, gh }
  const g = run('gh', ['pr', 'merge', String(pr), '--repo', slug, '--squash', '--delete-branch'], { cwd: dir, timeout: 120000 })
  return g.code === 0 ? { pushed: true, pr, merged: true, note: `opened and merged #${pr}`, gh } : { pushed: true, pr, merged: false, note: `opened #${pr}, but the merge was refused: ${cut(g.out, 200)}`, gh }
}
function prState(cfg, pr, run = sh) {
  const slug = slugOf(cfg); if (!slug) return null
  const r = run('gh', ['pr', 'view', String(pr), '--repo', slug, '--json', 'state'], { timeout: 60000 })
  try { return r.code === 0 ? JSON.parse(r.out.slice(r.out.indexOf('{'))).state : null } catch { return null }
}

// ---------- one run ----------

function note(cfg, key, ev, fields, now) { return orders.record(cfg.loopDir, key, ev, fields, now) }
function failAttempt(cfg, o, { outcome, why, tried, costUsd }, now) {
  const before = progress(orders.load(cfg.loopDir, o.key) || o).attempts.length
  note(cfg, o.key, 'attempt', { n: before + 1, outcome, why: cut(why, 400), tried: cut(tried, 800), costUsd }, now)
  if (before + 1 >= MAX_ATTEMPTS) { note(cfg, o.key, 'parked', { reason: `${before + 1} attempts by the fixer did not produce a checked fix; the last one: ${cut(why, 240)}` }, now); return true }
  return false
}
function saveSession(cfg, key, now, data) {
  const dir = path.join(fixDir(cfg), 'sessions')
  try {
    writeJson(path.join(dir, `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${orders.slug(key)}.json`), data)
    for (const f of fs.readdirSync(dir).sort().slice(0, -LIMITS.keepSessions)) fs.unlinkSync(path.join(dir, f))
  } catch { /* the run row still says what happened */ }
}
function askOnce(cfg, question, key) {
  const f = path.join(cfg.loopDir, 'digest-question.txt'), q = cut(question, 300)
  if (!q) return false
  try { if (fs.readFileSync(f, 'utf8').trim()) return false } catch { /* none waiting */ }
  try { fs.mkdirSync(cfg.loopDir, { recursive: true }); fs.writeFileSync(f, `${q} (from the fixer, work order ${key})\n`); return true } catch { return false }
}
// a fix an earlier run checked and committed but could not push: try again now, without a new session
function finishReady(cfg, o, p, { run, now, log }) {
  const dir = workDir(cfg), r = p.ready
  if (run('git', ['rev-parse', '--verify', '--quiet', r.branch], { cwd: dir }).code !== 0) { failAttempt(cfg, o, { outcome: 'lost', why: `the checked fix on ${r.branch} is no longer in the working copy` }, now); return null }
  let body = `Work order \`${o.key}\`: ${o.title}`; try { body = fs.readFileSync(readyBody(cfg, o.key), 'utf8') } catch { /* the short one */ }
  const pub = publish(cfg, { dir, branch: r.branch, title: r.title, body, hold: r.hold || [], run })
  if (!pub.pr) { log(`fix ${o.key}: still not published: ${pub.note}`); return { order: o.key, outcome: 'ready', note: pub.note, gh: pub.gh } }
  note(cfg, o.key, 'pr', { pr: pub.pr, merged: !!pub.merged, branch: r.branch, hold: r.hold || [] }, now)
  return { order: o.key, outcome: r.outcome, pr: pub.pr, merged: !!pub.merged, note: pub.note, gh: pub.gh }
}

// deps: { agent: async (opts) -> runAgent's result, run: sh, now, log, force, only, dryRun }
async function runFix(cfg, { agent = null, ask = null, run = sh, now = Date.now(), log = () => {}, only = null, dryRun = false, words } = {}) {
  const row = (r) => { runs.append(cfg, 'fix', r, now); return r }
  const state = readJson(stateFile(cfg), {})
  const lock = path.join(cfg.loopDir, 'fix.lock')
  if (!dryRun) {
    // a lock younger than a run can be, held by a process that is still alive: a run cut off by a restart or a logoff must not block the next one for hours
    try {
      const held = readJson(lock, {})
      let alive = true; try { process.kill(held.pid, 0) } catch (e) { alive = !!(e && e.code === 'EPERM') }
      if (alive && Date.now() - fs.statSync(lock).mtimeMs < LIMITS.lockMs) return { ok: true, skipped: 'another fixer run is going' }
    } catch { /* no lock */ }
    fs.mkdirSync(cfg.loopDir, { recursive: true }); fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() }))
  }
  try {
    const all = orders.list(cfg.loopDir)
    // 1. what earlier runs left
    if (!dryRun) for (const o of all) {
      if (o.status !== 'open') continue
      const p = progress(o)
      if (p.ready && modeOf(cfg) !== 'local') {
        const r = finishReady(cfg, o, p, { run, now, log })
        if (r && r.pr) { writeJson(stateFile(cfg), { ...state, at: new Date(now).toISOString(), gh: r.gh, last: r }); return row({ ok: true, ...r, summary: `${o.key}: ${r.note}` }) }
      } else if (p.waiting && p.waiting.on === 'merge' && prState(cfg, p.waiting.pr, run) === 'CLOSED') {
        failAttempt(cfg, o, { outcome: 'closed', why: `pull request #${p.waiting.pr} was closed without merging` }, now)
      }
    }
    // 2. the order
    const o = pick(orders.list(cfg.loopDir), { only })
    if (!o) return dryRun ? { ok: true, dryRun: true, order: null } : row({ ok: true, skipped: true, summary: only ? `no work order ${only}` : 'no open work order to take (none open, or all wait on a pull request, a deploy or a person)' })
    const p = progress(o)
    const branch = `fix/${orders.slug(o.key)}-${new Date(now).toISOString().slice(5, 16).replace(/[-:]/g, '').replace('T', '-')}`
    if (dryRun) { const ev = { dir: path.join(fixDir(cfg), 'evidence', orders.slug(o.key)), files: ['ORDER.md'] }; return { ok: true, dryRun: true, order: o.key, branch, mode: modeOf(cfg), system: SYSTEM, prompt: taskPrompt({ o, evidence: ev, attempts: p.attempts }) } }
    if (!agent) return row({ ok: false, order: o.key, summary: 'no agent to run the session with' })
    // 3, 4. working copy and evidence
    const wc = prepare(cfg, branch, run, orders.list(cfg.loopDir).map(x => progress(x).ready).filter(Boolean).map(r => r.branch))
    if (!wc.ok) return row({ ok: false, order: o.key, summary: wc.error })
    const evidence = writeEvidence(cfg, o, now)
    log(`fix ${o.key}: attempt ${p.attempts.length + 1} on ${branch} (${wc.deps} dependencies)`)
    // 5, 6. the session, the checks, one repair
    const session = { order: o.key, branch, base: wc.base, at: new Date(now).toISOString(), rounds: [] }
    let answer = null, checked = null, cost = 0, error = null, repair = null
    for (let round = 0; round < 2; round++) {
      const a = await agent({ systemPrompt: SYSTEM, prompt: taskPrompt({ o, evidence, attempts: p.attempts, repair }), schema: SCHEMA, model: cfg.model, effort: cfg.effort, cwd: wc.dir, claudePath: cfg.claudePath,
        builtins: ['Read', 'Glob', 'Grep', 'Edit', 'Write'], tools: toolsFor({ dir: wc.dir }), gate: gateFor({ dir: wc.dir, evidence: evidence.dir, run }), maxTurns: LIMITS.turns, timeoutMs: LIMITS.sessionMs })
      cost += a.costUsd || 0
      session.rounds.push({ ok: a.ok, error: a.error, answer: a.data, text: a.text, turns: a.turns, costUsd: a.costUsd, durationMs: a.durationMs, calls: (a.calls || []).slice(-400) })
      // the session ended in prose instead of the answer form (seen in a real trial after 55 tool calls): one short call with no tools reads the form off
      // its report. Nothing is taken on trust by this: the checks below still decide.
      if (!a.ok && a.text && ask) {
        const f = await ask({ systemPrompt: FORM, prompt: a.text, schema: SCHEMA, model: cfg.model, effort: cfg.effort, cwd: wc.dir, claudePath: cfg.claudePath, timeoutMs: 5 * 60000 })
        cost += f.costUsd || 0
        if (f.ok && f.data && SCHEMA.properties.outcome.enum.includes(f.data.outcome)) { a.ok = true; a.data = f.data; session.rounds[round].answer = f.data; session.rounds[round].formFromText = true }
      }
      if (!a.ok) { error = a.error; break }
      answer = a.data
      if (answer.outcome === 'gave-up') break
      checked = check({ dir: wc.dir, outcome: answer.outcome, run, words })
      session.rounds[round].check = checked
      log(`fix ${o.key}: session said ${answer.outcome}; checks ${checked.ok ? 'passed' : `failed: ${checked.fail}`}`)
      if (checked.ok) break
      repair = `${checked.fail}.${checked.detail ? `\n\n${checked.detail}` : ''}`
    }
    session.diff = tail(run('git', ['diff', 'origin/main'], { cwd: wc.dir }).out, 20000) || undefined           // what the session left, kept for whoever reads a failed attempt
    saveSession(cfg, o.key, now, session)
    const asked = answer && answer.question ? askOnce(cfg, answer.question, o.key) : false
    const done = (r) => { writeJson(stateFile(cfg), { ...state, at: new Date(now).toISOString(), gh: r.gh || state.gh, last: { order: o.key, outcome: r.outcome, pr: r.pr || null, note: r.summary } }); return row({ costUsd: cost || undefined, asked: asked || undefined, ...r, gh: undefined }) }
    const discard = () => { run('git', ['reset', '--quiet', '--hard', 'origin/main'], { cwd: wc.dir }); run('git', ['clean', '-fdq'], { cwd: wc.dir }) }
    if (!answer) { discard(); return done({ ok: false, order: o.key, outcome: 'error', summary: `${o.key}: the session failed: ${cut(error, 240)}` }) }      // not an attempt: the model was never heard
    if (answer.outcome === 'gave-up' || !checked || !checked.ok) {
      const why = answer.outcome === 'gave-up' ? `gave up: ${cut(answer.summary || answer.tried, 300)}` : `said ${answer.outcome}, but ${checked ? checked.fail : `the repair session failed: ${error}`}`
      discard()
      const parked = failAttempt(cfg, o, { outcome: answer.outcome === 'gave-up' ? 'gave-up' : 'failed-checks', why, tried: answer.tried || answer.summary, costUsd: cost || undefined }, now)
      return done({ ok: true, order: o.key, outcome: parked ? 'parked' : 'no-fix', summary: `${o.key}: ${why}${parked ? '. Parked for a person.' : ''}` })
    }
    // 7. commit and publish
    const title = cut(String(answer.title || o.title).replace(/[\r\n`]/g, ' '), 72)
    const privacy = leaks(`${title}\n${answer.rootCause}\n${answer.summary}`, words)
    const text = privacy ? { rootCause: '(left out: it named something from this computer)', summary: `See the diff. Tests: ${checked.tests.join(', ')}.` } : answer
    const body = prBody({ o, answer: text, checked, hold: checked.hold })
    const c = run('git', [...AUTHOR, 'commit', '--quiet', '-m', `${privacy ? `Fix for work order ${o.key}` : title}\n\nWork order ${o.key}. ${answer.outcome === 'telemetry' ? 'Could not reproduce: this records what will catch it next time.' : `Test that failed before: ${checked.failedOnMain.join(', ')}.`}\nWritten and checked by the fixer job (docs/MEMORY-LOOP.md).`], { cwd: wc.dir })
    if (c.code !== 0) { discard(); return done({ ok: false, order: o.key, outcome: 'error', summary: `${o.key}: could not commit: ${cut(c.out, 200)}` }) }
    const pub = publish(cfg, { dir: wc.dir, branch, title: privacy ? `Fix for work order ${o.key}` : title, body, hold: checked.hold, run })
    if (!pub.pr) {
      try { fs.writeFileSync(readyBody(cfg, o.key), body) } catch { /* a short body is written at publish time */ }
      note(cfg, o.key, 'ready', { branch, outcome: answer.outcome, title, hold: checked.hold, why: cut(pub.note, 300), costUsd: cost || undefined }, now)
      return done({ ok: true, order: o.key, outcome: 'ready', branch, gh: pub.gh, summary: `${o.key}: a checked ${answer.outcome === 'telemetry' ? 'telemetry change' : 'fix'} is on ${branch} in the working copy. ${pub.note}` })
    }
    note(cfg, o.key, 'pr', { pr: pub.pr, merged: !!pub.merged, branch, outcome: answer.outcome, hold: checked.hold, title, costUsd: cost || undefined }, now)
    if ((checked.redOnMain || []).length) askOnce(cfg, `The test suite on main is failing (${checked.redOnMain.join(', ')}), so the deployer will not put anything on the bots until that is fixed.`, o.key)
    if (checked.hold.length) askOnce(cfg, `The fixer's pull request #${pub.pr} for "${cut(o.title, 80)}" needs a look before it is merged: ${checked.hold.join('; ')}.`, o.key)
    return done({ ok: true, order: o.key, outcome: answer.outcome, pr: pub.pr, merged: !!pub.merged, gh: pub.gh, summary: `${o.key}: ${pub.note}` })
  } finally { if (!dryRun) { try { fs.unlinkSync(lock) } catch { /* gone */ } } }
}

// what the app's tab shows about the fixer, read from files only
function fixState(cfg) {
  const s = readJson(stateFile(cfg), {}), dir = workDir(cfg)
  const list = orders.list(cfg.loopDir).filter(o => o.status === 'open' || o.status === 'parked')
  return { mode: modeOf(cfg), repo: cfg.fixRepo || REPO, workDir: dir, hasClone: fs.existsSync(path.join(dir, '.git')), gh: s.gh || null, last: s.last || null, at: s.at || null,
    orders: Object.fromEntries(list.map(o => { const p = progress(o); return [o.key, { attempts: p.attempts.length, waiting: p.waiting, ready: p.ready ? { branch: p.ready.branch, why: p.ready.why } : null }] })) }
}

module.exports = { runFix, sh, shAsync, pick, progress, prepare, writeEvidence, gateFor, toolsFor, check, diffOf, leaks, privateWords, publish, prBody, taskPrompt, fixState, cleanEnv, mayChange, repoSlug, ghReady, workDir, fixDir, SYSTEM, SCHEMA, LIMITS, MAX_ATTEMPTS, ALLOWED, PROTECTED, REPO }
