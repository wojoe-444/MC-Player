// The deployer and the digest as scheduled jobs (docs/MEMORY-LOOP.md, jobs 6 and 7), and the bot supervisor acting on a restart request.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { runDeploy } = require('../lib/deploy')
const { buildDigest, runDigest, latest } = require('../lib/digest')
const orders = require('../lib/orders')
const runs = require('../lib/runs')
const schedule = require('../lib/schedule')
const { resolveConfig } = require('../lib/config')

const NOW = Date.parse('2026-11-11T09:00:00Z')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'loopjobs-'))
function cfgFor(root) {
  const ozo = path.join(root, 'ozo'); fs.mkdirSync(ozo, { recursive: true })
  return { bots: [{ id: 'ozo', name: 'OzoGo444', dir: ozo }, { id: 'smeo', name: 'Smeo444', dir: path.join(root, 'missing') }], loopDir: path.join(root, 'loop'), codeDir: path.join(root, 'code') }
}
const cand = (key, costMin) => ({ key, type: 'step', step: key.slice(5), costMin, counts: { alarms: 9 }, line: key, evidence: [] })

test('runDeploy: judge first, no new deploy while the last one waits for its verdict, and work orders follow their PR through deploy and verdict', async () => {
  const root = tmp(), cfg = cfgFor(root)
  orders.sync(cfg.loopDir, { bot: 'ozo', cands: [cand('step-iron', 18), cand('step-stash', 6)], decided: { 'step-iron': { isBug: true, title: 'iron idles', problem: 'p' }, 'step-stash': { isBug: true, title: 'stash idles', problem: 'p' } }, now: NOW - 3600000 })
  orders.record(cfg.loopDir, 'step-iron', 'pr', { pr: 290 }, NOW - 1800000)
  const calls = []
  const script = []                                    // what the deployer tool answers, in order
  const tool = { judge: (o) => { calls.push('judge'); assert.deepStrictEqual(o.runtimes, [cfg.bots[0].dir], 'only bot folders that exist'); return script.shift() }, deploy: () => { calls.push('deploy'); return script.shift() } }
  fs.mkdirSync(cfg.codeDir, { recursive: true })
  const dep = { t: NOW, event: 'deploy', from: 'aaaaaaaaa', to: 'bbbbbbbbb' }
  fs.writeFileSync(path.join(cfg.codeDir, 'deploys.jsonl'), JSON.stringify(dep) + '\n')

  // 1: nothing to judge, main moved: deployed, and the order whose PR is in it gets the event
  script.push({ result: 'no deploy yet' }, { result: 'deployed', from: 'aaaaaaaaa1', to: 'bbbbbbbbb2', action: 'restart', steps: [] })
  let r = await runDeploy(cfg, { tool, now: NOW, prs: () => [290, 291] })
  assert.strictEqual(r.ok, true); assert.match(r.summary, /deployed aaaaaaaaa to bbbbbbbbb \(restart; PRs #290, #291\)/)
  assert.deepStrictEqual(orders.load(cfg.loopDir, 'step-iron').history.map(h => h.ev), ['opened', 'pr', 'deploy'])
  assert.ok(!orders.load(cfg.loopDir, 'step-stash').history.some(h => h.ev === 'deploy'), 'an order without that PR is untouched')
  // 2: still inside the waiting time: judge only, no deploy call
  calls.length = 0; script.push({ result: 'wait', per: [{ verdict: 'wait', waitedMin: 10, needMin: 40 }] })
  r = await runDeploy(cfg, { tool, now: NOW + 600000 })
  assert.deepStrictEqual(calls, ['judge']); assert.match(r.summary, /waiting to judge the last deploy \(10 of 40 min\)/)
  // 3: judged ok: the order is fixed by its PR, then the next deploy is looked at
  calls.length = 0; script.push({ result: 'ok', per: [{ runtime: cfg.bots[0].dir, before: 12, after: 4 }] }, { result: 'current', steps: [] })
  r = await runDeploy(cfg, { tool, now: NOW + 2400000 })
  assert.deepStrictEqual(calls, ['judge', 'deploy']); assert.match(r.summary, /the last deploy \(bbbbbbbbb\) was judged ok; the bots are on main/)
  const o = orders.load(cfg.loopDir, 'step-iron')
  assert.strictEqual(o.status, 'fixed'); assert.match(o.closed.reason, /fixed by PR #290: deployed as bbbbbbbbb and judged ok/)
  assert.deepStrictEqual(orders.readLedger(cfg.loopDir).map(l => l.ev).slice(-4), ['deploy', 'verdict', 'verdict', 'fixed'])
  // the journal shows the problem again: reopened, and counted
  const back = orders.sync(cfg.loopDir, { bot: 'ozo', cands: [cand('step-iron', 12)], decided: { 'step-iron': { isBug: true, title: 'iron idles', problem: 'p' } }, now: NOW + 9000000 })
  assert.deepStrictEqual(back.reopened, ['step-iron']); assert.strictEqual(orders.load(cfg.loopDir, 'step-iron').reopens, 1)
  // 4: red tests are a failed run with the reason; a revert says what was taken back
  script.push({ result: 'already judged' }, { result: 'red', steps: ['candidate ccc', 'tests FAILED, not deploying:\n1 failed'] })
  r = await runDeploy(cfg, { tool, now: NOW + 9100000 })
  assert.strictEqual(r.ok, false); assert.match(r.summary, /the tests failed on main, nothing deployed; tests FAILED/)
  script.push({ result: 'reverted', per: [] }, { result: 'bad', steps: [] })
  r = await runDeploy(cfg, { tool, now: NOW + 9200000 })
  assert.match(r.summary, /made the bots worse and was taken back to aaaaaaaaa; main is still the commit that was taken back/)
  assert.deepStrictEqual(runs.read(cfg, { jobs: ['deploy'] }).map(x => x.ok), [true, false, true, true, true])
  // no clone: a failed run that says what to do, and no crash
  const none = await runDeploy({ ...cfg, codeDir: path.join(root, 'nope') }, { now: NOW })
  assert.strictEqual(none.ok, false); assert.match(none.error, /not a git clone/)
})

test('digest: the bots\' own asks first, then deaths and stalls, work orders, deploys, failed jobs and at most one question', () => {
  const rollup = { events: 40, deaths: [{ cause: 'tried to swim in lava' }], alarms: { raised: 12, stalledMin: 18 }, flagsHigh: 3, steps: { iron: { stalledMin: 14 }, stash: { stalledMin: 4 }, unknown: { stalledMin: 9 } }, items: { cobblestone: 90, raw_iron: 4 } }
  const at = new Date(NOW - 3600000).toISOString()
  const text = buildDigest({
    now: NOW,
    bots: [{ name: 'OzoGo444', rollup, asks: [{ at, text: 'Could I have a chest of my own by the shaft?' }], brief: { at, intent: 'Iron today.', freeTime: { choice: 'vantage' } }, memoryLines: 22, memoryChanges: 3, roadmap: 'phase 1: 2 of 2 measured items done' }, { name: 'Smeo444', rollup: null, asks: [] }],
    orders: [{ key: 'step-iron', title: 'iron idles', status: 'open', costMin: 18, pr: 290, reopens: 1 }, { key: 'step-old', title: 'old', status: 'closed', costMin: 0 }],
    ledger: [{ at, order: 'step-iron', ev: 'opened' }, { at, order: 'step-iron', ev: 'reopened' }, { at: new Date(NOW - 3 * 86400000).toISOString(), order: 'step-older', ev: 'opened' }, { at, ev: 'deploy' }],
    deploys: [{ t: NOW - 7200000, event: 'deploy', to: 'bbbbbbbbb' }, { t: NOW - 3600000, event: 'revert', from: 'bbbbbbbbb' }, { t: NOW - 1800000, event: 'refused', why: 'tests' }],
    runs: [{ at, job: 'dream', ok: true, costUsd: 0.04 }, { at, job: 'dream', ok: false, summary: 'OzoGo444: failed: timed out' }, { at, job: 'review', ok: true, costUsd: 0.02 }],
    question: 'Should the storage room have a door?',
  })
  assert.match(text, /## The bots ask\n\n- \*\*OzoGo444\*\* \(\d\d:\d\dZ\): Could I have a chest of my own by the shaft\?/)
  assert.match(text, /\*\*OzoGo444\*\*: 1 death \(tried to swim in lava\), 18 min stalled over 12 alarms \(most: iron 14 min, stash 4 min\), 3 high flags\. Gained cobblestone x90, raw_iron x4\./)
  assert.match(text, /Memory: 22 of 60 lines, 3 lines changed by the memory check\./); assert.match(text, /\*\*Smeo444\*\*: nothing in its journal/)
  assert.match(text, /- 18 min lost: iron idles \(`step-iron`, PR #290, reopened 1x\)/); assert.doesNotMatch(text, /step-old\b/)
  assert.match(text, /- Opened: step-iron\n- Came back after a fix: step-iron/); assert.doesNotMatch(text, /step-older/)
  assert.match(text, /1 deploy \(now at bbbbbbbbb\), 1 taken back \(bbbbbbbbb\), 1 held back \(tests\)/)
  assert.match(text, /- dream: 2 runs, 1 failed \(OzoGo444: failed: timed out\), about \$0\.04/); assert.match(text, /## One question\n\nShould the storage room have a door\?/)
  const quiet = buildDigest({ now: NOW, bots: [], orders: [], ledger: [], deploys: [], runs: [] })
  assert.match(quiet, /None open\./); assert.match(quiet, /No job ran in the last 24 hours/); assert.doesNotMatch(quiet, /One question|The bots ask/)
})

test('runDigest: one a day after 07:00 local, the question is asked once, and the app reads the newest', () => {
  const root = tmp(), cfg = cfgFor(root)
  const at = (h) => { const d = new Date(2026, 10, 11, h, 30); return d.getTime() }
  fs.mkdirSync(cfg.loopDir, { recursive: true }); fs.writeFileSync(path.join(cfg.loopDir, 'digest-question.txt'), '\nA door on the storage room?\n')
  assert.match(runDigest(cfg, { now: at(5) }).skipped, /before 7:00/)
  const r = runDigest(cfg, { now: at(8) })
  assert.strictEqual(r.ok, true); assert.strictEqual(path.basename(r.file), '2026-11-11.md'); assert.match(r.text, /A door on the storage room\?/)
  assert.ok(!fs.existsSync(path.join(cfg.loopDir, 'digest-question.txt')))
  assert.match(runDigest(cfg, { now: at(9) }).skipped, /already written/)
  assert.doesNotMatch(runDigest(cfg, { now: at(10), force: true }).text, /One question/)
  assert.strictEqual(latest(cfg.loopDir).date, '2026-11-11'); assert.strictEqual(latest(path.join(root, 'nope')), null)
  assert.strictEqual(runs.read(cfg, { jobs: ['digest'] }).length, 2)
})

test('jobs and settings: each loop job is its own Task Scheduler entry; the code folder comes from the flag, the app setting, then Downloads', () => {
  assert.deepStrictEqual(Object.values(schedule.JOBS).map(j => [j.id, j.name, j.args[0], j.minutes]), [['review', 'MC-Player Bot Reviewer', '--once', 10], ['dream', 'MC-Player Bot Dream', '--dream', 120], ['deploy', 'MC-Player Bot Deployer', '--deploy', 30], ['digest', 'MC-Player Bot Digest', '--digest', 60]])
  assert.strictEqual(new Set(Object.values(schedule.JOBS).map(j => j.vbs)).size, 4)
  const home = path.join(tmp(), 'h')
  assert.strictEqual(resolveConfig({ argv: [], env: {}, home, exists: () => false }).codeDir, path.join(home, 'Downloads', 'MC-Player-live'))
  assert.strictEqual(resolveConfig({ argv: ['--code', '/c'], env: { BOT_CODE_DIR: '/e' }, home, exists: () => false }).codeDir, '/c')
  const appCfg = path.join(home, '.config', 'Bot Dashboard', 'config.json'); fs.mkdirSync(path.dirname(appCfg), { recursive: true }); fs.writeFileSync(appCfg, JSON.stringify({ loop: { codeDir: '/from-app' } }))
  assert.strictEqual(resolveConfig({ argv: [], env: {}, home }).codeDir, '/from-app')
})

test('the bot supervisor restarts the bot when the deployer leaves restart-needed.json, and keeps the request as restart-done.json', async () => {
  const dir = tmp()
  fs.copyFileSync(path.join(__dirname, '..', '..', 'run.js'), path.join(dir, 'run.js'))
  fs.writeFileSync(path.join(dir, 'join.js'), "require('fs').appendFileSync('starts.txt', process.pid + '\\n'); setInterval(() => {}, 1000)\n")
  const sup = spawn(process.execPath, [path.join(dir, 'run.js')], { cwd: dir, env: { ...process.env, SUPERVISOR_POLL_MS: '100', SUPERVISOR_GRACE_MS: '300' }, stdio: 'ignore' })
  const starts = () => { try { return fs.readFileSync(path.join(dir, 'starts.txt'), 'utf8').trim().split('\n').filter(Boolean) } catch { return [] } }
  const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 50)) } return false }
  try {
    assert.ok(await until(() => starts().length === 1, 5000), 'the bot starts')
    fs.writeFileSync(path.join(dir, 'restart-needed.json'), JSON.stringify({ why: '2 files changed: join.js' }))
    assert.ok(await until(() => starts().length === 2, 15000), 'a second process after the request')
    assert.ok(fs.existsSync(path.join(dir, 'restart-done.json')) && !fs.existsSync(path.join(dir, 'restart-needed.json')))
    assert.match(fs.readFileSync(path.join(dir, 'join.log'), 'utf8'), /SUPERVISOR restart requested \(2 files changed: join\.js\)/)
    assert.notStrictEqual(starts()[0], starts()[1])
  } finally {
    for (const pid of starts()) { try { process.kill(Number(pid)) } catch { /* gone */ } }
    sup.kill()
  }
})
