// Runs dashboard/server.js (the existing read-only live viewer) as a child process, or attaches to one that is
// already listening on the port (e.g. started with dashboard/start.bat).
const net = require('net')
const path = require('path')
const { spawn } = require('child_process')

function portInUse(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect({ port, host })
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => resolve(false))
  })
}

async function waitForPort(port, tries = 50, delay = 200) {
  for (let i = 0; i < tries; i++) {
    if (await portInUse(port)) return true
    await new Promise(r => setTimeout(r, delay))
  }
  return false
}

// The redesigned dashboard page carries <meta name="bot-dashboard-ui">. A dashboard that was started earlier from an older checkout
// (dashboard/start.bat) serves the previous UI, which has no pages for Claude reviews, Memory loop or updates inside the app, so do not attach to it.
const UI_MARKER = 'name="bot-dashboard-ui"'
async function servesCurrentUi(url, fetchFn = globalThis.fetch) {
  try {
    const res = await fetchFn(url + '/', { signal: AbortSignal.timeout(3000) })
    return (await res.text()).includes(UI_MARKER)
  } catch { return false }
}

// Returns { url, attached, stop() }. Throws if the server never comes up.
async function startDashboard(cfg, { repoRoot, log = console.log, fetchFn } = {}) {
  let port = cfg.port
  let url = `http://127.0.0.1:${port}`
  if (await portInUse(port)) {
    if (await servesCurrentUi(url, fetchFn)) {
      log(`dashboard: attaching to the server already on port ${port}`)
      return { url, attached: true, stop() {} }
    }
    // an older dashboard holds the port: run our own copy on the next free port well away from the app's control port
    for (let p = cfg.port + 100; p < cfg.port + 120; p++) if (!(await portInUse(p))) { port = p; break }
    if (port === cfg.port) throw new Error(`port ${cfg.port} serves an older dashboard and no spare port was found`)
    url = `http://127.0.0.1:${port}`
    log(`dashboard: the server on port ${cfg.port} is an older version; starting this app's own on port ${port}`)
  }
  const script = path.join(repoRoot, 'dashboard', 'server.js')
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',     // run Electron's bundled Node as plain node
      PORT: String(port),
      BOT_OZO_DIR: cfg.ozoDir,
      BOT_SMEO_DIR: cfg.smeoDir,
      BOT_CODE_DIR: cfg.codeDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.on('data', d => log('dashboard: ' + String(d).trimEnd()))
  child.stderr.on('data', d => log('dashboard ERR: ' + String(d).trimEnd()))
  let exited = false
  child.once('exit', (code) => { exited = true; log(`dashboard: exited (${code})`) })
  if (!(await waitForPort(port)) || exited) {
    try { child.kill() } catch {}
    throw new Error(`dashboard server did not start on port ${port}`)
  }
  return { url, attached: false, stop() { try { child.kill() } catch {} } }
}

module.exports = { startDashboard, portInUse, servesCurrentUi, UI_MARKER }
