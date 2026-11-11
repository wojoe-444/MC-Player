// tools/deployer.js: merge on green, hot-reload or restart note, take a bad deploy back. Real git in temp folders (an origin and a live clone), fake tests.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'), os = require('os'), path = require('path')
const { execFileSync } = require('child_process')
const D = require('../tools/deployer')

const sh = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
function rig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-'))
  const origin = path.join(root, 'origin'), live = path.join(root, 'live'), rt = path.join(root, 'rt')
  fs.mkdirSync(origin); sh(origin, 'init', '-q', '-b', 'main')
  const put = (f, c) => { fs.mkdirSync(path.dirname(path.join(origin, f)), { recursive: true }); fs.writeFileSync(path.join(origin, f), c); sh(origin, 'add', '-A'); sh(origin, 'commit', '-qm', 'c ' + f) }
  put('brain/autopilot/skills.js', '1'); put('join.js', '1')
  execFileSync('git', ['clone', '-q', origin, live]); fs.mkdirSync(rt)
  return { root, origin, live, rt, put, head: (d) => sh(d, 'rev-parse', 'HEAD') }
}
const base = (r, extra = {}) => ({ code: r.live, runtimes: [r.rt], testCmd: 'node -e "process.exit(0)"', ...extra })

test('classify: autopilot files hot-reload, anything else restarts, docs and tests need nothing', () => {
  assert.strictEqual(D.classify(['brain/autopilot/skills.js', 'docs/x.md']).action, 'reload')
  assert.strictEqual(D.classify(['brain/autopilot/skills.js', 'brain/gate/rules.json']).action, 'restart')
  assert.strictEqual(D.classify(['join.js']).action, 'restart')
  assert.strictEqual(D.classify(['docs/a.md', 'test/x.test.js']).action, 'none')
  assert.strictEqual(D.classify(['brain/autopilot/index.js']).action, 'restart')          // the loader itself is not re-read by ap.reload()
  assert.strictEqual(D.classify(['package.json', 'join.js']).installNeeded, true)
})

test('deploy: green tests, fast-forward, hot reload command written to the runtime folder, recorded', () => {
  const r = rig(); r.put('brain/autopilot/skills.js', '2')
  const out = D.deploy(base(r))
  assert.strictEqual(out.result, 'deployed'); assert.strictEqual(r.head(r.live), r.head(r.origin))
  assert.match(fs.readFileSync(path.join(r.rt, 'brain', 'state', 'ap-cmd.js'), 'utf8'), /_ap\.reload/)
  const rec = fs.readFileSync(path.join(r.live, 'deploys.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.strictEqual(rec[0].event, 'deploy'); assert.strictEqual(rec[0].action, 'reload')
  assert.strictEqual(D.deploy(base(r)).result, 'current')
})

test('deploy: red tests leave the clone where it was; a restart-needing change leaves a note', () => {
  const r = rig(); const before = r.head(r.live); r.put('join.js', '2')
  const red = D.deploy(base(r, { testCmd: 'node -e "process.exit(3)"' }))
  assert.strictEqual(red.result, 'red'); assert.strictEqual(r.head(r.live), before)
  const ok = D.deploy(base(r)); assert.strictEqual(ok.result, 'deployed')
  assert.ok(JSON.parse(fs.readFileSync(path.join(r.rt, 'restart-needed.json'), 'utf8')).why.includes('join.js'))
})

test('deploy: local changes in the clone (drift) are reported and never overwritten; dry run changes nothing', () => {
  const r = rig(); r.put('join.js', '2')
  fs.writeFileSync(path.join(r.live, 'join.js'), 'hand edited')
  const d = D.deploy(base(r)); assert.strictEqual(d.result, 'drift'); assert.strictEqual(fs.readFileSync(path.join(r.live, 'join.js'), 'utf8'), 'hand edited')
  sh(r.live, 'checkout', '--', 'join.js')
  const before = r.head(r.live); assert.strictEqual(D.deploy(base(r, { dryRun: true })).result, 'dry-run'); assert.strictEqual(r.head(r.live), before)
})

test('verdict and weigh: waits for the window, then compares with the same-length window before', () => {
  const lines = [{ at: new Date(1000).toISOString(), sev: 'high' }, { at: new Date(5000).toISOString(), sev: 'med' }]
  assert.deepStrictEqual(D.weigh(lines, 0, 2000), { weight: 3, count: 1 }); assert.deepStrictEqual(D.weigh(lines, 2000, 9000), { weight: 1, count: 1 })
  const min = 60000
  assert.strictEqual(D.verdict({ deployedAt: 0, now: 10 * min, before: { weight: 0 }, after: { weight: 50 }, minMs: 40 * min }).verdict, 'wait')
  assert.strictEqual(D.verdict({ deployedAt: 0, now: 50 * min, before: { weight: 4 }, after: { weight: 9 }, minMs: 40 * min }).verdict, 'ok')          // 2.2x but only 5 more
  assert.strictEqual(D.verdict({ deployedAt: 0, now: 50 * min, before: { weight: 10 }, after: { weight: 14 }, minMs: 40 * min }).verdict, 'ok')        // 1.4x
  assert.strictEqual(D.verdict({ deployedAt: 0, now: 50 * min, before: { weight: 4 }, after: { weight: 11 }, minMs: 40 * min }).verdict, 'worse')
})

test('judge: flags that jump after a deploy put the clone back, mark the commit bad and ask for a reload; a calm window passes', () => {
  const r = rig(); r.put('brain/autopilot/skills.js', '2')
  D.deploy(base(r))
  const dep = JSON.parse(fs.readFileSync(path.join(r.live, 'deploys.jsonl'), 'utf8').trim().split('\n')[0])
  const now = dep.t + 60 * 60000
  const flagsFile = path.join(r.rt, 'brain', 'state', 'telemetry', 'flags.jsonl'); fs.mkdirSync(path.dirname(flagsFile), { recursive: true })
  const line = (t) => JSON.stringify({ at: new Date(t).toISOString(), sev: 'high', kind: 'x' })
  assert.strictEqual(D.judge({ ...base(r), now: dep.t + 5 * 60000 }).result, 'wait')
  fs.writeFileSync(flagsFile, [1, 2, 3].map(i => line(dep.t - i * 60000)).join('\n') + '\n' + [1, 2, 3, 4].map(i => line(dep.t + i * 60000)).join('\n'))   // before: 9, after: 12
  assert.strictEqual(D.judge({ ...base(r), now }).result, 'ok')
  const r2 = rig(); r2.put('brain/autopilot/skills.js', '2'); D.deploy(base(r2))
  const dep2 = JSON.parse(fs.readFileSync(path.join(r2.live, 'deploys.jsonl'), 'utf8').trim().split('\n')[0])
  const f2 = path.join(r2.rt, 'brain', 'state', 'telemetry', 'flags.jsonl'); fs.mkdirSync(path.dirname(f2), { recursive: true })
  fs.writeFileSync(f2, [1, 2, 3, 4, 5, 6, 7, 8].map(i => line(dep2.t + i * 60000)).join('\n'))                                                       // before: 0, after: 24
  const res = D.judge({ ...base(r2), now: dep2.t + 60 * 60000 })
  assert.strictEqual(res.result, 'reverted'); assert.notStrictEqual(r2.head(r2.live), r2.head(r2.origin))
  assert.strictEqual(D.deploy(base(r2)).result, 'bad')                                              // not redeployed until main moves on
  r2.put('brain/autopilot/skills.js', '3'); assert.strictEqual(D.deploy(base(r2)).result, 'deployed')
})

test('deploy: when package.json changed, the install runs before the bots are told to restart; --no-install leaves a note instead', () => {
  const r = rig(); r.put('package.json', '{"name":"x"}')
  const out = D.deploy(base(r, { installCmd: 'node -e "require(\'fs\').writeFileSync(\'installed.txt\', String(require(\'fs\').existsSync(\'../rt/restart-needed.json\')))"' }))
  assert.strictEqual(out.result, 'deployed'); assert.strictEqual(out.install, true); assert.strictEqual(out.action, 'restart'); assert.ok(out.from && out.to && out.from !== out.to)
  assert.strictEqual(fs.readFileSync(path.join(r.live, 'installed.txt'), 'utf8'), 'false', 'no restart request existed yet when the install ran')
  assert.ok(fs.existsSync(path.join(r.rt, 'restart-needed.json')))
  const r2 = rig(); r2.put('package.json', '{"name":"y"}')
  const out2 = D.deploy(base(r2, { install: false, installCmd: 'node -e "process.exit(9)"' }))
  assert.strictEqual(out2.result, 'deployed'); assert.strictEqual(out2.install, undefined)
  assert.match(JSON.parse(fs.readFileSync(path.join(r2.rt, 'restart-needed.json'), 'utf8')).why, /npm install first/)
})
