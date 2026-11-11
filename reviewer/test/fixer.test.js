// The fixer (lib/fixer.js) with a fake agent: a real git repository stands in for GitHub, the "session" is a function that edits the working copy.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const fixer = require('../lib/fixer')
const orders = require('../lib/orders')
const runs = require('../lib/runs')

const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...a], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
const write = (root, rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
const NOW = Date.parse('2026-11-11T03:00:00Z')

// a tiny "MC-Player": one module with a fault (half() rounds the wrong way), one test that passes, a test runner, and files the fixer may not touch
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-test-'))
  const origin = path.join(root, 'origin'), code = path.join(root, 'live'), loopDir = path.join(root, 'loop')
  fs.mkdirSync(path.join(code, 'node_modules'), { recursive: true })
  write(origin, 'brain/iron/half.js', `module.exports = { half: (n) => Math.ceil(n / 2), whimsy: () => 'free time' }\n`)
  write(origin, 'brain/autopilot/whimsy.js', `module.exports = { freeTime: true }\n`)
  write(origin, 'brain/gate/rules.json', '{}\n')
  write(origin, 'test/half.test.js', `const test = require('node:test'), assert = require('node:assert')\nconst { half } = require('../brain/iron/half')\ntest('half of 4', () => assert.equal(half(4), 2))\n`)
  write(origin, 'scripts/run-tests.js', `const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process')\nconst dir = path.join(__dirname, '..', 'test'); let bad = 0\nfor (const f of fs.readdirSync(dir).filter(f => f.endsWith('.test.js'))) { const r = spawnSync(process.execPath, ['--test', path.join(dir, f)], { encoding: 'utf8' }); if (r.status !== 0) { bad++; console.log('FAIL ' + f) } }\nprocess.exit(bad ? 1 : 0)\n`)
  write(origin, 'CLAUDE.md', '# the bot is an independent player\n')
  write(origin, '.gitignore', 'node_modules/\n')
  git(origin, 'init', '-q'); git(origin, 'add', '-A'); git(origin, 'commit', '-q', '-m', 'start')
  const cfg = { loopDir, codeDir: code, fixRepo: origin, fixSlug: 'wojoe-444/MC-Player', fixMode: 'local', bots: [], model: 'm', effort: 'e' }
  const order = (key, extra = {}) => {
    const o = { v: 1, key, type: 'step', step: 'iron', status: 'open', title: 'half() rounds up', kind: 'bug', problem: 'The iron step asks for half of 5 and gets 3.', suggestion: 'brain/iron/half.js', findings: [], snapshots: [],
      bots: { ozo: { costMin: 30, counts: {}, line: 'step iron: 9 runs, 5 fail', evidence: ['5x STALL: no progress'], at: '2026-11-11T02:00:00.000Z', quiet: 0 } }, costMin: 30, cost: [], openedAt: '2026-11-11T02:00:00.000Z', updatedAt: '2026-11-11T02:00:00.000Z', seenDreams: 1, reopens: 0, pr: null,
      history: [{ at: '2026-11-11T02:00:00.000Z', ev: 'opened' }], ...extra }
    write(loopDir, `work-orders/${key}.json`, JSON.stringify(o)); return o
  }
  return { root, origin, cfg, order, wc: fixer.workDir(cfg) }
}
const GOOD_TEST = `const test = require('node:test'), assert = require('node:assert')\nconst { half } = require('../brain/iron/half')\ntest('half of 5 rounds down', () => assert.equal(half(5), 2))\n`
const answer = (over = {}) => ({ ok: true, costUsd: 0.01, turns: 5, calls: [], data: { outcome: 'fixed', title: 'Round half() down so the iron step asks for what fits', rootCause: 'brain/iron/half.js used Math.ceil', summary: 'Use Math.floor.', tests: ['test/fix-step-iron.test.js'], tried: '', question: '', ...over } })
// the session a careful model would run
const goodAgent = async (o) => { write(o.cwd, 'brain/iron/half.js', `module.exports = { half: (n) => Math.floor(n / 2), whimsy: () => 'free time' }\n`); write(o.cwd, 'test/fix-step-iron.test.js', GOOD_TEST); write(o.cwd, '.fixer-scratch/notes.js', '1'); return answer() }
// GitHub, faked: gh answers, pushes are swallowed, everything else is real git and node
const fakeGitHub = (seen, { merge = 0 } = {}) => (cmd, args, opts) => {
  if (cmd === 'gh') { seen.push(args.slice(0, 2).join(' ')); return args[0] === 'pr' && args[1] === 'create' ? { code: 0, out: 'https://github.com/wojoe-444/MC-Player/pull/301\n' } : args[1] === 'merge' ? { code: merge, out: merge ? 'not mergeable' : '' } : args[1] === 'view' ? { code: 0, out: '{"state":"CLOSED"}' } : { code: 0, out: 'ok' } }
  if (cmd === 'git' && args[0] === 'push') { seen.push('git push'); return { code: 0, out: '' } }
  return fixer.sh(cmd, args, opts)
}

test('pick takes the most costly open order that is not waiting and has attempts left', () => {
  const o = (key, history, status = 'open') => ({ key, status, pr: 7, history: [{ ev: 'opened' }, ...history] })
  const list = [o('a', [{ ev: 'pr', pr: 7, merged: true }]), o('b', [{ ev: 'pr', pr: 7, merged: true }, { ev: 'deploy' }]), o('c', [{ ev: 'attempt' }, { ev: 'attempt' }]), o('d', [], 'parked'), o('e', [{ ev: 'ready', branch: 'x' }]),
    o('f', [{ ev: 'pr', pr: 7, merged: true }, { ev: 'deploy' }, { ev: 'verdict', verdict: 'reverted', why: 'more stalls' }]), o('g', [])]
  assert.equal(fixer.pick(list).key, 'f')
  const p = fixer.progress(list[5])
  assert.equal(p.waiting, null); assert.equal(p.attempts.length, 1); assert.match(p.attempts[0].why, /PR #7 was deployed and judged reverted/)
  assert.deepEqual(fixer.progress(list[0]).waiting.on, 'deploy'); assert.equal(fixer.progress(list[1]).waiting.on, 'verdict')
  assert.equal(fixer.progress(o('h', [{ ev: 'attempt' }, { ev: 'attempt' }, { ev: 'reopened' }])).attempts.length, 0, 'a reopened order starts over')
  assert.equal(fixer.pick(list, { only: 'd' }).key, 'd')
})

test('the gate keeps the session inside the working copy and away from the rules, memory, free time and existing tests', () => {
  const w = world(); w.order('step-iron')
  const wc = fixer.prepare(w.cfg, 'fix/t'); assert.ok(wc.ok, wc.error)
  const ev = path.join(w.root, 'loop', 'fixer', 'evidence', 'x'); fs.mkdirSync(ev, { recursive: true })
  const gate = fixer.gateFor({ dir: wc.dir, evidence: ev })
  const W = (p) => gate('Write', { file_path: path.join(wc.dir, p) }).allow
  assert.equal(W('brain/iron/half.js'), true); assert.equal(W('test/fix-new.test.js'), true); assert.equal(W('.fixer-scratch/a.js'), true); assert.equal(W('join.js'), true)
  for (const p of ['CLAUDE.md', 'brain/gate/rules.json', 'brain/memory/store.js', 'brain/autopilot/whimsy.js', 'package.json', 'scripts/run-tests.js', 'test/half.test.js', '.git/config', 'node_modules/x/index.js', 'reviewer/lib/fixer.js']) assert.equal(W(p), false, p)
  assert.equal(gate('Write', { file_path: path.join(w.root, 'elsewhere.js') }).allow, false)
  assert.equal(gate('Edit', { file_path: path.join(wc.dir, '..', 'MC-Player-x', 'brain', 'a.js') }).allow, false)
  assert.equal(gate('Read', { file_path: path.join(ev, 'ORDER.md') }).allow, true); assert.equal(gate('Read', { file_path: path.join(w.root, 'live', 'bot.local.env') }).allow, false)
  assert.equal(gate('Grep', { pattern: 'x' }).allow, true)
  for (const t of ['Bash', 'WebFetch', 'Agent', 'mcp__other__x']) assert.equal(gate(t, {}).allow, false, t)
  assert.equal(gate('mcp__fixer__run_tests', {}).allow, true)
})

test('the fixer\'s own tools: read-only git, node on files of the working copy only, no credentials in their environment', async () => {
  const w = world(); const wc = fixer.prepare(w.cfg, 'fix/t')
  const tools = Object.fromEntries(fixer.toolsFor({ dir: wc.dir }).map(t => [t.name, t.handler]))
  assert.match(await tools.git({ args: ['log', '--oneline'] }), /exit code 0\n\w+ start/)
  for (const args of [['push', 'origin', 'x'], ['commit', '-m', 'x'], ['log', '--output=/tmp/x'], ['-c', 'core.pager=x', 'log'], ['config', 'user.name']]) assert.match(await tools.git({ args }), /^refused/, args.join(' '))
  assert.match(await tools.run_node({ file: 'test/half.test.js', test: true }), /exit code 0/)
  assert.match(await tools.run_node({ file: '../../../etc/x.js' }), /^refused/); assert.match(await tools.run_node({ file: 'node_modules/x/a.js' }), /^refused/)
  assert.match(await tools.run_tests({}), /exit code 0/)
  const env = fixer.cleanEnv({ PATH: '/bin', GH_TOKEN: 'x', ANTHROPIC_API_KEY: 'x', MC_EMAIL: 'x', MY_SECRET: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'x', HOME: '/h' })
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH'])
})

test('a checked fix in local mode: test fails on main, passes with the change, the suite passes; it waits on its branch and is published later without a new session', async () => {
  const w = world(); w.order('step-iron')
  const prompts = []
  const r = await fixer.runFix(w.cfg, { agent: async (o) => { prompts.push(o); return goodAgent(o) }, now: NOW, words: [] })
  assert.equal(r.outcome, 'ready', r.summary); assert.match(r.branch, /^fix\/step-iron-1111-0300$/)
  assert.match(prompts[0].prompt, /Work order step-iron[\s\S]*half\(\) rounds up[\s\S]*Evidence folder: /); assert.deepEqual(prompts[0].builtins, ['Read', 'Glob', 'Grep', 'Edit', 'Write'])
  assert.equal(git(w.wc, 'log', '-1', '--format=%an|%s', r.branch), 'MC-Player fixer|Round half() down so the iron step asks for what fits')
  assert.deepEqual(git(w.wc, 'show', '--name-only', '--format=', r.branch).split('\n').sort(), ['brain/iron/half.js', 'test/fix-step-iron.test.js'], 'scratch files and the node_modules link are not committed')
  let o = orders.load(w.cfg.loopDir, 'step-iron')
  assert.equal(o.status, 'open'); assert.equal(fixer.progress(o).ready.branch, r.branch); assert.equal(fixer.pick([o]), null, 'not taken again while the fix waits')
  assert.ok(fs.existsSync(path.join(w.cfg.loopDir, 'fixer', 'evidence', 'step-iron', 'ORDER.md')))
  assert.equal(fs.readdirSync(path.join(w.cfg.loopDir, 'fixer', 'sessions')).length, 1)
  assert.equal(fixer.fixState(w.cfg).orders['step-iron'].ready.branch, r.branch)
  // later, with GitHub reachable and merge mode on: no agent call, the same branch goes out
  const seen = []
  const r2 = await fixer.runFix({ ...w.cfg, fixMode: 'merge' }, { agent: async () => { throw new Error('no session expected') }, run: fakeGitHub(seen), now: NOW + 3 * 3600000, words: [] })
  assert.equal(r2.pr, 301); assert.equal(r2.merged, true); assert.deepEqual(seen, ['--version', 'auth status', 'git push', 'pr create', 'pr merge'])
  o = orders.load(w.cfg.loopDir, 'step-iron')
  assert.equal(o.pr, 301); assert.equal(fixer.progress(o).waiting.on, 'deploy')
  assert.deepEqual(runs.read(w.cfg, { jobs: ['fix'] }).map(x => x.outcome), ['fixed', 'ready'])
})

test('a "fix" whose test passes on main is not believed: one repair session, then a failed attempt; the second failed attempt parks the order', async () => {
  const w = world(); w.order('step-iron')
  const calls = []
  const lazy = async (o) => { calls.push(o.prompt); write(o.cwd, 'brain/iron/half.js', `module.exports = { half: (n) => Math.ceil(n / 2) /* looked at it */, whimsy: () => 'free time' }\n`); write(o.cwd, 'test/fix-step-iron.test.js', GOOD_TEST.replace('half(5), 2', 'half(4), 2')); return answer({ tried: 'changed a comment' }) }
  const r = await fixer.runFix(w.cfg, { agent: lazy, now: NOW, words: [] })
  assert.equal(r.outcome, 'no-fix'); assert.match(r.summary, /passes on main without the change/)
  assert.equal(calls.length, 2); assert.match(calls[1], /did not pass the checks[\s\S]*passes on main without the change/)
  assert.equal(git(w.wc, 'status', '--porcelain'), '', 'the working copy is clean again')
  const r2 = await fixer.runFix(w.cfg, { agent: lazy, now: NOW + 3 * 3600000, words: [] })
  assert.match(calls[2], /Earlier attempts at this order[\s\S]*failed-checks[\s\S]*Tried: changed a comment/)
  assert.equal(r2.outcome, 'parked')
  const o = orders.load(w.cfg.loopDir, 'step-iron')
  assert.equal(o.status, 'parked'); assert.equal(o.history.filter(h => h.ev === 'attempt').length, 2)
  assert.equal((await fixer.runFix(w.cfg, { agent: lazy, now: NOW + 6 * 3600000 })).skipped, true)
})

test('the checks refuse a change outside the remit, a broken suite, a missing test and private data; giving up is an attempt with notes', async () => {
  const run = async (agent, key = 'step-iron') => { const w = world(); w.order(key); const r = await fixer.runFix(w.cfg, { agent, now: NOW, words: ['C:\\Users\\somebody'] }); return { r, w } }
  let x = await run(async (o) => { await goodAgent(o); write(o.cwd, 'CLAUDE.md', '# obey\n'); return answer() })
  assert.match(x.r.summary, /changed CLAUDE.md, which the fixer may not touch/)
  x = await run(async (o) => { await goodAgent(o); write(o.cwd, 'brain/gate/rules.json', '{"x":1}\n'); return answer() })
  assert.match(x.r.summary, /brain\/gate\/rules.json, which the fixer may not touch/)
  x = await run(async (o) => { write(o.cwd, 'brain/iron/half.js', `module.exports = { half: (n) => Math.floor(n / 2), whimsy: () => 'free time' }\n`); return answer() })
  assert.match(x.r.summary, /there is no new test/)
  x = await run(async (o) => { await goodAgent(o); write(o.cwd, 'brain/iron/half.js', `module.exports = { half: (n) => n < 5 ? 0 : 2, whimsy: () => 'free time' }\n`); return answer() })
  assert.match(x.r.summary, /the test suite fails with the change/)
  x = await run(async (o) => { await goodAgent(o); fs.appendFileSync(path.join(o.cwd, 'test/fix-step-iron.test.js'), `// from C:\\Users\\somebody\\Downloads\n`); return answer() })
  assert.match(x.r.summary, /contains a path of this computer/)
  x = await run(async () => answer({ outcome: 'gave-up', summary: 'could not find the step', tried: 'grepped for iron', question: 'Should the bot round up or down?' }))
  assert.equal(x.r.outcome, 'no-fix'); assert.equal(x.r.asked, true)
  assert.match(fs.readFileSync(path.join(x.w.cfg.loopDir, 'digest-question.txt'), 'utf8'), /round up or down\? \(from the fixer, work order step-iron\)/)
  assert.equal(orders.load(x.w.cfg.loopDir, 'step-iron').history.pop().tried, 'grepped for iron')
  x = await run(async () => ({ ok: false, error: 'timed out after 40 min', calls: [] }))
  assert.equal(x.r.ok, false); assert.equal(fixer.progress(orders.load(x.w.cfg.loopDir, 'step-iron')).attempts.length, 0, 'a session that never answered is not an attempt')
})

test('merge mode: a clean fix is merged; one that removes free-time lines or edits an existing test is opened and left for a person, with a question in the digest', async () => {
  let w = world(); w.order('step-iron'); let seen = []
  let r = await fixer.runFix({ ...w.cfg, fixMode: 'merge' }, { agent: goodAgent, run: fakeGitHub(seen), now: NOW, words: [] })
  assert.equal(r.merged, true, r.summary); assert.equal(orders.load(w.cfg.loopDir, 'step-iron').pr, 301)
  const body = fs.readFileSync(path.join(w.cfg.loopDir, 'fixer', 'pr-body.md'), 'utf8')
  assert.match(body, /test\/fix-step-iron.test.js fails on main and passes with this change/); assert.match(body, /Opened by the fixer job/)

  w = world(); w.order('step-iron'); seen = []
  r = await fixer.runFix({ ...w.cfg, fixMode: 'merge' }, { run: fakeGitHub(seen), now: NOW, words: [], agent: async (o) => { await goodAgent(o); write(o.cwd, 'brain/iron/half.js', `module.exports = { half: (n) => Math.floor(n / 2) }\n`); fs.appendFileSync(path.join(o.cwd, 'test/half.test.js'), '// edited\n'); fs.writeFileSync(path.join(o.cwd, 'test/half.test.js'), fs.readFileSync(path.join(o.cwd, 'test/half.test.js'), 'utf8').replace('half of 4', 'half of four')); return answer() } })
  assert.equal(r.pr, 301); assert.equal(r.merged, false); assert.ok(!seen.includes('pr merge'))
  assert.match(r.summary, /left it for a person: .*existing test test\/half.test.js.*free time/)
  assert.match(fs.readFileSync(path.join(w.cfg.loopDir, 'digest-question.txt'), 'utf8'), /pull request #301 .* needs a look/)
  assert.equal(fixer.progress(orders.load(w.cfg.loopDir, 'step-iron')).waiting.on, 'merge')
  // somebody closes that pull request: the next run counts it as a failed attempt and takes the order again
  const calls = []
  await fixer.runFix({ ...w.cfg, fixMode: 'pr' }, { run: fakeGitHub(seen), now: NOW + 3 * 3600000, words: [], agent: async (o) => { calls.push(o.prompt); return goodAgent(o) } })
  assert.match(calls[0], /pull request #301 was closed without merging/)

  w = world(); w.order('step-iron')
  r = await fixer.runFix({ ...w.cfg, fixMode: 'pr' }, { agent: goodAgent, run: (c, a, o) => c === 'gh' ? { code: 127, out: 'not found' } : fixer.sh(c, a, o), now: NOW, words: [] })
  assert.equal(r.outcome, 'ready'); assert.match(r.summary, /GitHub CLI \(gh\) is not installed/); assert.equal(fixer.fixState(w.cfg).gh.ok, false)
})

test('a lock held by a live run skips this one; a lock left by a run that died does not', async () => {
  const w = world(); w.order('step-iron'); fs.mkdirSync(w.cfg.loopDir, { recursive: true })
  const lock = path.join(w.cfg.loopDir, 'fix.lock')
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }))
  assert.equal((await fixer.runFix(w.cfg, { agent: goodAgent, now: NOW, words: [] })).skipped, 'another fixer run is going')
  fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345 }))                // no such process
  assert.equal((await fixer.runFix(w.cfg, { agent: goodAgent, now: NOW, words: [] })).outcome, 'ready'); assert.ok(!fs.existsSync(lock))
})

test('a dry run names the order and prints the prompt without touching anything', async () => {
  const w = world(); w.order('step-iron'); w.order('step-wood', { costMin: 90, title: 'wood' })
  const r = await fixer.runFix(w.cfg, { dryRun: true, now: NOW })
  assert.equal(r.order, 'step-wood'); assert.match(r.system, /independent player/); assert.ok(!fs.existsSync(w.wc)); assert.equal(runs.read(w.cfg, {}).length, 0)
})
