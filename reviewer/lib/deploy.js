// The deployer on a schedule (docs/MEMORY-LOOP.md, job 6). `node run.js --deploy`, from its own Task Scheduler entry every 30 minutes.
//
// The work is done by tools/deployer.js of the clone the live bots run from (cfg.codeDir, by default ~/Downloads/MC-Player-live): this file only
// calls it in the right order and writes what happened where the rest of the loop reads it. No model is called.
//   1. judge the last deploy. While it is still inside its waiting time (40 minutes) nothing new is deployed, so a verdict is about one change.
//   2. deploy: fetch main, run the tests on the candidate, fast-forward the clone, hot-reload or ask the bots' supervisor (run.js) for a restart.
//   3. write the outcome to the run log and the ledger. A work order whose PR is in a deploy gets a "deploy" event, and when that deploy is
//      judged it gets the verdict: "ok" marks the order fixed (it is reopened, and counted, if the journal shows the problem again), "worse"
//      leaves it open after the deployer has put the previous commit back.
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const orders = require('./orders')
const runs = require('./runs')

const cut = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const short = (c) => String(c || '').slice(0, 9)
const LOCK_MS = 45 * 60000

// PR numbers named in the subjects of the commits a deploy brought in ("... (#286)")
function prsBetween(code, from, to, run = execFileSync) {
  try { return [...new Set(run('git', ['log', '--format=%s', `${from}..${to}`], { cwd: code, timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n').flatMap(s => [...s.matchAll(/\(#(\d+)\)/g)].map(m => Number(m[1]))))] } catch { return [] }
}

// A lock whose process is gone is stale at once: on 2026-11-11 an app update killed a deploy in the middle of its tests and its lock then held every deploy back for 45 minutes.
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true                 // an old-format lock: trust the clock
  try { process.kill(pid, 0); return true } catch (e) { return !!(e && e.code === 'EPERM') }
}

// A red test suite on main stops every deploy, and until now nothing owned it: the refusal was a line in the run log. It is an order like any other, the most costly
// one (nothing ships while it stands), written by code from the deployer's own words, and closed by the next deploy that gets through.
const RED = 'main-tests-red'
function openRedOrder(cfg, d, now) {
  const tail = cut((d.steps || []).filter(s => /FAILED/.test(s)).pop() || 'the test suite failed', 500)
  const files = [...new Set(tail.match(/test[\\/][\w.-]+\.test\.js/g) || [])].map(f => f.split('\\').join('/'))
  const line = `the test suite is red on main${files.length ? `: ${files.join(', ')}` : ''}`
  orders.sync(cfg.loopDir, { bot: 'main', now, cands: [{ key: RED, type: 'ci', step: null, costMin: 3000, counts: { tests: files.length || 1 }, line, evidence: [tail] }], decided: { [RED]: {
    isBug: true, kind: 'bug', title: 'The test suite is red on main, so nothing can be deployed', why: 'measured by the deployer, not judged',
    problem: cut(`The deployer ran the full test suite on main before putting it on the live bots and it failed (${files.join(', ') || 'see the output below'}). While it fails nothing ships, including every other fix. Output: ${tail}`, 600),
    suggestion: 'Run the named test file on main. Either the code it tests is broken (fix the code), or the test depends on something that is not in the repository or on this computer (make the test not depend on it, as a new test or a fix to what it calls). Do not weaken a test to make it pass.' } } })
}
function closeRedOrder(cfg, now) {
  const o = orders.load(cfg.loopDir, RED)
  if (o && (o.status === 'open' || o.status === 'parked')) orders.record(cfg.loopDir, RED, 'closed', { reason: 'the test suite is green on main again' }, now)
}

// deps: { tool: the deployer module (injected in tests), now, log, prs(code, from, to) }
async function runDeploy(cfg, { tool = null, now = Date.now(), log = () => {}, prs = prsBetween, tests = true } = {}) {
  const code = cfg.codeDir, toolFile = path.join(code || '', 'tools', 'deployer.js')
  const fail = (summary) => { runs.append(cfg, 'deploy', { ok: false, summary }, now); log('deploy ' + summary); return { ok: false, error: summary } }
  if (!tool) {
    if (!code || !fs.existsSync(path.join(code, '.git'))) return fail(`the code folder is not a git clone: ${code}. Set it on the Memory loop tab.`)
    if (!fs.existsSync(toolFile)) return fail(`no tools/deployer.js in ${code}: the clone is older than the deployer`)
    try { tool = require(toolFile) } catch (e) { return fail(`could not load ${toolFile}: ${cut(e.message, 160)}`) }
  }
  const lock = path.join(cfg.loopDir, 'deploy.lock')
  try { fs.mkdirSync(cfg.loopDir, { recursive: true }); const j = JSON.parse(fs.readFileSync(lock, 'utf8')); if (now - j.at < LOCK_MS && alive(j.pid)) return { ok: true, skipped: 'another deploy is running' } } catch { /* no lock */ }
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: now }))
  try {
    const runtimes = cfg.bots.map(b => b.dir).filter(d => fs.existsSync(d))
    const o = { code, runtimes, now, tests, log: (s) => log('deploy ' + cut(s, 300)) }
    const parts = []
    let ok = true

    let j; try { j = tool.judge(o) } catch (e) { return fail(`judge failed: ${cut(e.message, 200)}`) }
    if (j.result === 'ok' || j.result === 'reverted') {
      const dep = lastDeploy(code)
      const verdict = j.result === 'ok' ? 'ok' : 'worse'
      const judged = dep ? dep.to : null                                       // the commit the verdict is about (after a revert the clone is back on dep.from)
      parts.push(j.result === 'ok' ? `the last deploy (${short(judged)}) was judged ok` : `the last deploy (${short(judged)}) made the bots worse and was taken back to ${short(dep && dep.from)}`)
      orders.ledger(cfg.loopDir, { ev: 'verdict', verdict, commit: judged, per: (j.per || []).map(p => ({ runtime: path.basename(p.runtime), before: p.before, after: p.after })) }, now)
      for (const ord of orders.list(cfg.loopDir)) {
        const d = (ord.history || []).filter(h => h.ev === 'deploy').pop()
        if (!d || !judged || short(d.commit) !== short(judged) || (ord.history || []).some(h => h.ev === 'verdict' && short(h.commit) === short(judged))) continue
        orders.record(cfg.loopDir, ord.key, 'verdict', { verdict, commit: short(judged) }, now)
        if (verdict === 'ok' && ord.status === 'open') orders.record(cfg.loopDir, ord.key, 'fixed', { reason: `fixed by PR #${ord.pr}: deployed as ${short(judged)} and judged ok` }, now + 1)
      }
    }
    if (j.result === 'wait') {
      const w = (j.per || []).find(p => p.verdict === 'wait') || {}
      parts.push(`waiting to judge the last deploy (${w.waitedMin ?? '?'} of ${w.needMin ?? '?'} min), so nothing new is deployed yet`)
    } else {
      let d; try { d = tool.deploy(o) } catch (e) { return fail(`deploy failed: ${cut(e.message, 200)}`) }
      if (d.result === 'deployed') {
        closeRedOrder(cfg, now)
        const numbers = prs(code, d.from, d.to)
        parts.push(`deployed ${short(d.from)} to ${short(d.to)} (${d.action}${numbers.length ? `; PRs ${numbers.map(n => '#' + n).join(', ')}` : ''})`)
        orders.ledger(cfg.loopDir, { ev: 'deploy', from: short(d.from), to: short(d.to), action: d.action, prs: numbers }, now)
        for (const ord of orders.list(cfg.loopDir)) if (ord.pr && numbers.includes(Number(ord.pr)) && ord.status === 'open') orders.record(cfg.loopDir, ord.key, 'deploy', { commit: short(d.to), pr: ord.pr }, now)
      } else if (d.result === 'current') { closeRedOrder(cfg, now); parts.push('the bots are on main')
      } else if (d.result === 'bad') parts.push('main is still the commit that was taken back; waiting for it to move on')
      else { ok = false; if (d.result === 'red') { try { openRedOrder(cfg, d, now) } catch { /* the run log still says it */ } } parts.push({ red: 'the tests failed on main, nothing deployed', drift: 'the code folder has local changes, nothing deployed', diverged: 'the code folder has commits main does not, nothing deployed' }[d.result] || `deploy: ${d.result}`); const last = (d.steps || []).slice(-1)[0]; if (last) parts.push(cut(last, 240)) }
    }
    const summary = parts.join('; ')
    runs.append(cfg, 'deploy', { ok, summary }, now)
    log('deploy ' + summary)
    return { ok, summary }
  } finally { try { fs.unlinkSync(lock) } catch { /* gone */ } }
}

function lastDeploy(code) {
  try { return fs.readFileSync(path.join(code, 'deploys.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(r => r && r.event === 'deploy').pop() || null } catch { return null }
}
// for the app and the digest: the last few lines of the clone's own record
function deployLog(code, limit = 20) {
  try { return fs.readFileSync(path.join(code, 'deploys.jsonl'), 'utf8').split('\n').filter(Boolean).slice(-limit).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch { return [] }
}

module.exports = { alive, runDeploy, prsBetween, deployLog, lastDeploy }
