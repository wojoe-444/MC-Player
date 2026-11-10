// Windows Task Scheduler: one task that runs the reviewer every N minutes as the current user, only while that user is logged in
// (no password, no admin prompt), with no console window (a tiny .vbs launcher starts node hidden).
// Pure command building plus thin schtasks wrappers; the Bot Dashboard app and `node run.js --install-task` both use this.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')

const TASK_NAME = 'MC-Player Bot Reviewer'

const vbsQuote = (s) => '"' + String(s).replace(/"/g, '""') + '"'

// nodeExe: path to node.exe, or Electron's exe with electronAsNode = true (the packaged app has no separate node)
function launcherVbs({ nodeExe, scriptPath, workDir, electronAsNode = false }) {
  const lines = ['Set sh = CreateObject("WScript.Shell")', `sh.CurrentDirectory = ${vbsQuote(workDir)}`]
  if (electronAsNode) lines.push('sh.Environment("Process")("ELECTRON_RUN_AS_NODE") = "1"')
  lines.push(`sh.Run ${vbsQuote(vbsQuote(nodeExe) + ' ' + vbsQuote(scriptPath) + ' --once')}, 0, False`)
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

async function status(run) {
  if (process.platform !== 'win32') return { installed: false, unsupported: true }
  const r = await sh(queryArgs(), run)
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

async function install({ scriptPath, outDir = path.join(os.homedir(), '.mc-player', 'reviewer'), minutes = 10, run, node } = {}) {
  if (process.platform !== 'win32') return { ok: false, error: 'Task Scheduler is Windows-only. On other systems run `node reviewer/run.js` from cron or launchd.' }
  const n = node || await findNode(run)
  fs.mkdirSync(outDir, { recursive: true })
  const vbsPath = path.join(outDir, 'launch-reviewer.vbs')
  fs.writeFileSync(vbsPath, launcherVbs({ nodeExe: n.nodeExe, scriptPath, workDir: path.dirname(scriptPath), electronAsNode: n.electronAsNode }))
  const r = await sh(createArgs({ vbsPath, minutes }), run)
  return r.ok ? { ok: true, vbsPath, nodeExe: n.nodeExe, minutes, status: await status(run) } : { ok: false, error: r.err || r.out }
}
async function uninstall(run) {
  if (process.platform !== 'win32') return { ok: false, error: 'Windows-only' }
  const r = await sh(deleteArgs(), run)
  return { ok: r.ok || /cannot find|does not exist/i.test(r.err), error: r.ok ? undefined : r.err }
}
async function runNow(run) { const r = await sh(runArgs(), run); return { ok: r.ok, error: r.ok ? undefined : r.err } }

module.exports = { TASK_NAME, launcherVbs, createArgs, deleteArgs, queryArgs, runArgs, parseQuery, status, install, uninstall, runNow, findNode }
