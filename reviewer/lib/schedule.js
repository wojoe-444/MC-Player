// Windows Task Scheduler: one task that runs the reviewer every N minutes as the current user, only while that user is logged in
// (no password, no admin prompt), with no console window (a tiny .vbs launcher starts node hidden).
// Pure command building plus thin schtasks wrappers; the Bot Dashboard app and `node run.js --install-task` both use this.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')

const TASK_NAME = 'MC-Player Bot Reviewer'
// Every scheduled job of the memory loop is one entry here: its Task Scheduler name, its launcher file, what it passes to run.js and how often it runs.
// The Bot Dashboard app installs and removes them by id; nothing else on the computer is touched.
const JOBS = {
  review: { id: 'review', name: TASK_NAME, vbs: 'launch-reviewer.vbs', args: ['--once'], minutes: 10, maxMinutes: 120, title: 'Review and dawn briefs', about: 'Watches both bots and answers their dawn briefs.' },
  dream: { id: 'dream', name: 'MC-Player Bot Dream', vbs: 'launch-dream.vbs', args: ['--dream'], minutes: 120, maxMinutes: 720, title: 'Dream: check memory against the journal, open work orders', about: 'Haiku 5.5 at xhigh on your Claude login, a few short calls per bot. It skips a bot whose journal has nothing new. "Run now" takes about five minutes per bot.' },
  deploy: { id: 'deploy', name: 'MC-Player Bot Deployer', vbs: 'launch-deployer.vbs', args: ['--deploy'], minutes: 30, maxMinutes: 720, title: 'Deployer: put main on the live bots, take a deploy back if they get worse', about: 'No model. It runs the tests on new code from main, fast-forwards the code folder below, and hot-reloads or restarts the bots. Forty minutes later it compares each bot with its own hours before, and puts the old code back if the bot got clearly worse. It refuses to touch a code folder that has local changes.' },
  fix: { id: 'fix', name: 'MC-Player Bot Fixer', vbs: 'launch-fixer.vbs', args: ['--fix'], minutes: 180, maxMinutes: 1440, title: 'Fixer: take the most costly work order to a pull request', about: 'Haiku 5.5 at xhigh on your Claude login, one work order per run, up to 40 minutes. It works in its own copy of the code in the loop folder: it writes a test that shows the fault, fixes it, and code checks the result (the test fails on main and passes with the fix, the whole suite passes, only bot code changed). It cannot touch the rules, CLAUDE.md, the bots\' memory or their free time. It needs the GitHub CLI logged in (gh auth login) to open the pull request; without it the checked fix waits on its branch. After two failed attempts an order is parked for a person.' },
  audit: { id: 'audit', name: 'MC-Player Bot Loop Audit', vbs: 'launch-audit.vbs', args: ['--audit'], minutes: 360, maxMinutes: 1440, title: 'Loop audit: is the loop working as intended', about: 'Sonnet 5.5 at high effort on your Claude login, one call every six hours. Reads what every stage did, applies hard rules (job not installed, bots offline, orders nothing acts on, missing modules) and writes a verdict with what only you can unblock. Changes nothing.' },
  digest: { id: 'digest', name: 'MC-Player Bot Digest', vbs: 'launch-digest.vbs', args: ['--digest'], minutes: 60, maxMinutes: 720, title: 'Digest: one page a day', about: 'No model. Checked every hour, written once a day after 07:00: what the bots asked for, deaths and stalls, work orders, deploys, and which jobs failed.' },
}
const jobOf = (job) => (typeof job === 'string' ? JOBS[job] : job) || JOBS.review

const vbsQuote = (s) => '"' + String(s).replace(/"/g, '""') + '"'

// nodeExe: path to node.exe, or Electron's exe with electronAsNode = true (the packaged app has no separate node)
function launcherVbs({ nodeExe, scriptPath, workDir, electronAsNode = false, args = ['--once'] }) {
  const lines = ['Set sh = CreateObject("WScript.Shell")', `sh.CurrentDirectory = ${vbsQuote(workDir)}`]
  if (electronAsNode) lines.push('sh.Environment("Process")("ELECTRON_RUN_AS_NODE") = "1"')
  lines.push(`sh.Run ${vbsQuote([vbsQuote(nodeExe), vbsQuote(scriptPath), ...args.map(a => String(a).replace(/[^A-Za-z0-9_=.-]/g, ''))].join(' '))}, 0, False`)
  return lines.join('\r\n') + '\r\n'
}

function createArgs({ vbsPath, minutes = 10, name = TASK_NAME }) {
  return ['/Create', '/F', '/TN', name, '/SC', 'MINUTE', '/MO', String(Math.max(1, Math.round(minutes))), '/RL', 'LIMITED',
    '/TR', `wscript.exe //B //Nologo "${vbsPath}"`]
}
const deleteArgs = (name = TASK_NAME) => ['/Delete', '/F', '/TN', name]
const queryArgs = (name = TASK_NAME) => ['/Query', '/TN', name, '/FO', 'LIST', '/V']
const runArgs = (name = TASK_NAME) => ['/Run', '/TN', name]

// schtasks /Query /FO LIST /V -> { installed, status, nextRun, lastRun, lastResult, schedule }  (English and most localized outputs use "Key: value" lines)
function parseQuery(text) {
  const kv = {}
  for (const line of String(text).split(/\r?\n/)) { const m = /^([^:]+):\s*(.*)$/.exec(line); if (m && !(m[1].trim() in kv)) kv[m[1].trim()] = m[2].trim() }
  return {
    installed: true, status: kv['Status'] || null, nextRun: kv['Next Run Time'] || null, lastRun: kv['Last Run Time'] || null,
    lastResult: kv['Last Result'] || null, schedule: kv['Repeat: Every'] || kv['Schedule Type'] || null,
  }
}

const sh = (args, run = execFile) => new Promise((resolve) => {
  run('schtasks', args, { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '').trim() }))
})

async function status(run, job) {
  if (process.platform !== 'win32') return { installed: false, unsupported: true }
  const r = await sh(queryArgs(jobOf(job).name), run)
  return r.ok ? parseQuery(r.out) : { installed: false }
}

// where to find node: the running node, or (inside Electron) `where node`, or the Electron exe itself as node
function findNode(run = execFile) {
  return new Promise((resolve) => {
    if (!process.versions.electron) return resolve({ nodeExe: process.execPath, electronAsNode: false })
    run('where', ['node'], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      const first = String(stdout || '').split(/\r?\n/).map(s => s.trim()).find(Boolean)
      resolve(!err && first ? { nodeExe: first, electronAsNode: false } : { nodeExe: process.execPath, electronAsNode: true })
    })
  })
}

async function install({ scriptPath, outDir = path.join(os.homedir(), '.mc-player', 'reviewer'), minutes, run, node, job } = {}) {
  const j = jobOf(job)
  minutes = Math.min(j.maxMinutes, Math.max(1, Math.round(Number(minutes) || j.minutes)))
  if (process.platform !== 'win32') return { ok: false, error: 'Task Scheduler is Windows-only. On other systems run `node reviewer/run.js` from cron or launchd.' }
  const n = node || await findNode(run)
  fs.mkdirSync(outDir, { recursive: true })
  const vbsPath = path.join(outDir, j.vbs)
  fs.writeFileSync(vbsPath, launcherVbs({ nodeExe: n.nodeExe, scriptPath, workDir: path.dirname(scriptPath), electronAsNode: n.electronAsNode, args: j.args }))
  const r = await sh(createArgs({ vbsPath, minutes, name: j.name }), run)
  return r.ok ? { ok: true, vbsPath, nodeExe: n.nodeExe, minutes, name: j.name, status: await status(run, j) } : { ok: false, error: r.err || r.out }
}
async function uninstall(run, job) {
  if (process.platform !== 'win32') return { ok: false, error: 'Windows-only' }
  const r = await sh(deleteArgs(jobOf(job).name), run)
  return { ok: r.ok || /cannot find|does not exist/i.test(r.err), error: r.ok ? undefined : r.err }
}
async function runNow(run, job) { const r = await sh(runArgs(jobOf(job).name), run); return { ok: r.ok, error: r.ok ? undefined : r.err } }

module.exports = { TASK_NAME, JOBS, launcherVbs, createArgs, deleteArgs, queryArgs, runArgs, parseQuery, status, install, uninstall, runNow, findNode }
