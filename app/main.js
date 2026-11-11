// Electron entry: starts (or attaches to) the dashboard server, shows it in a window, and runs background triggers.
const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const { Config } = require('./lib/config')
const { startDashboard } = require('./lib/dashboard-process')
const { TriggerManager } = require('./lib/triggers')
const { createReviewTrigger, listReviews } = require('./lib/review')
const { UpdateManager } = require('./lib/updater')
const { startControlServer } = require('./lib/control')
const { loopState, loadLib, JOB_IDS } = require('./lib/loop')

// Packaged: electron-builder copies dashboard/ into resources/. From source: the repo root is one level up.
const REPO_ROOT = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..')
// The spectator reviewer (../reviewer) runs outside the app too, from Windows Task Scheduler; the app installs that task, runs it on demand and shows its findings.
const REVIEWER_DIR = app.isPackaged ? path.join(process.resourcesPath, 'reviewer') : path.join(__dirname, '..', 'reviewer')
let schedule = null
try { schedule = require(path.join(REVIEWER_DIR, 'lib', 'schedule')) } catch (e) { console.log('reviewer not available:', e.message) }
// The memory loop (docs/MEMORY-LOOP.md): its jobs are other entry points of the same reviewer package, each with its own Task Scheduler entry.
const loopLib = loadLib(REVIEWER_DIR)
const ICON = path.join(__dirname, 'build', 'icon.ico')
let config, dash, triggers, reviewsDir
let mainWin = null
let updates, control

const log = (...a) => console.log(new Date().toISOString(), ...a)

if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => { if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus() } })

function lockDown(win, allowOrigin) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(allowOrigin)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url) }
  })
}

// One window showing the dashboard web app (dashboard/web). Its pages for Claude reviews, Memory loop and Settings talk to this process
// through window.botApp (preload.js), so there are no separate tab views any more. The menu shortcuts ask the page to switch (the 'navigate' message).
const PAGES = { dashboard: '/', reviews: '/reviews', loop: '/loop', settings: '/settings' }
const sendUI = (channel, payload) => { if (mainWin && !mainWin.isDestroyed() && !mainWin.webContents.isDestroyed()) mainWin.webContents.send(channel, payload) }

// Only the dashboard page itself may use window.botApp: it can install scheduled tasks and updates, so ignore any other frame or origin.
function fromDashboard(e) {
  try { return new URL(e.senderFrame.url).origin === new URL(dash.url).origin } catch { return false }
}
function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!fromDashboard(e)) throw new Error('not allowed')
    return fn(...args)
  })
}

function openMain(tab) {
  const page = PAGES[tab] || null
  if (mainWin) {
    if (mainWin.isMinimized()) mainWin.restore()
    mainWin.focus()
    if (page) sendUI('navigate', page)
    return
  }
  mainWin = new BrowserWindow({
    width: 1400, height: 900, title: 'Bot Dashboard', icon: ICON, backgroundColor: '#f5f1e8',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, 'preload.js') },
  })
  lockDown(mainWin, dash.url)
  mainWin.webContents.loadURL(dash.url + (page && page !== '/' ? '#' + page : ''))
  mainWin.on('closed', () => { mainWin = null })
}
const openReviews = () => openMain('reviews')
const openSettings = () => openMain('settings')

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
async function reviewerState() {
  const d = config.data.dashboard
  const bots = [['ozo', 'OzoGo444', d.ozoDir], ['smeo', 'Smeo444', d.smeoDir]].map(([id, name, dir]) => ({
    id, name, findings: readJson(path.join(dir, 'brain', 'state', 'review', 'findings.json')), telemetry: readJson(path.join(dir, 'brain', 'state', 'telemetry', 'summary.json')),
  }))
  return { available: !!schedule, bots, task: schedule ? await schedule.status() : null, taskName: schedule && schedule.TASK_NAME }
}
let reviewerRunning = false
function runReviewerNow() {
  if (reviewerRunning || !schedule) return false
  reviewerRunning = true
  const d = config.data.dashboard
  const child = spawn(process.execPath, [path.join(REVIEWER_DIR, 'run.js'), '--once', '--force'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', BOT_OZO_DIR: d.ozoDir, BOT_SMEO_DIR: d.smeoDir }, windowsHide: true, stdio: 'ignore',
  })
  const done = () => { reviewerRunning = false; reviewerState().then(r => sendUI('reviewer', r)) }
  child.once('exit', done); child.once('error', done)
  return true
}

// ---- memory loop tab: Task Scheduler jobs (install, remove, run now), work orders, each bot's memory, the run log ----
const loopBots = () => { const d = config.data.dashboard; return [{ id: 'ozo', name: 'OzoGo444', dir: d.ozoDir }, { id: 'smeo', name: 'Smeo444', dir: d.smeoDir }] }
const loopDir = () => loopLib.config.loopDirOf()                      // the same folder the scheduled job resolves: beside this app's settings
const loopRunning = {}
const codeDir = () => (config.data.loop && config.data.loop.codeDir) || loopLib.config.resolveConfig({}).codeDir
const fixMode = () => (config.data.loop && config.data.loop.fixMode) || 'merge'
const getLoopState = () => loopState({ lib: loopLib, loopDir: loopLib ? loopDir() : null, codeDir: loopLib ? codeDir() : null, fixMode: fixMode(), bots: loopBots(), status: (job) => loopLib.schedule.status(undefined, job), running: loopRunning })
function runLoopJob(id) {
  if (!loopLib || !JOB_IDS.includes(id) || loopRunning[id]) return false
  loopRunning[id] = true
  const d = config.data.dashboard
  const child = spawn(process.execPath, [path.join(REVIEWER_DIR, 'run.js'), ...loopLib.schedule.JOBS[id].args, '--force'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', BOT_OZO_DIR: d.ozoDir, BOT_SMEO_DIR: d.smeoDir, LOOP_DIR: loopDir(), BOT_CODE_DIR: codeDir(), FIXER_MODE: fixMode() }, windowsHide: true, stdio: 'ignore',
  })
  const done = () => { loopRunning[id] = false; getLoopState().then(s => sendUI('loop', s)) }
  child.once('exit', done); child.once('error', done)
  return true
}

function snapshot() {
  return { triggers: triggers.list(), reviews: listReviews(reviewsDir), dashboard: { url: dash.url, attached: dash.attached }, claude: config.data.claude }
}

const activeWc = () => (mainWin && !mainWin.isDestroyed() ? mainWin.webContents : null)

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'App', submenu: [
      { label: 'Dashboard', accelerator: 'CmdOrCtrl+1', click: () => openMain('dashboard') },
      { label: 'Claude reviews', accelerator: 'CmdOrCtrl+2', click: openReviews },
      { label: 'Memory loop', accelerator: 'CmdOrCtrl+3', click: () => openMain('loop') },
      { label: 'Settings', accelerator: 'CmdOrCtrl+4', click: openSettings },
      { label: 'Open dashboard in browser', click: () => shell.openExternal(dash.url) },
      { type: 'separator' }, { role: 'quit' },
    ] },
    { label: 'View', submenu: [
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => activeWc() && activeWc().reload() },
      { label: 'Developer tools', accelerator: 'CmdOrCtrl+Shift+I', click: () => activeWc() && activeWc().toggleDevTools() },
      { role: 'togglefullscreen' },
      { label: 'Reset zoom', accelerator: 'CmdOrCtrl+0', click: () => activeWc() && activeWc().setZoomLevel(0) },
      { label: 'Zoom in', accelerator: 'CmdOrCtrl+=', click: () => activeWc() && activeWc().setZoomLevel(activeWc().getZoomLevel() + 0.5) },
      { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: () => activeWc() && activeWc().setZoomLevel(activeWc().getZoomLevel() - 0.5) },
    ] },
  ]))
}

app.setAppUserModelId('com.walter.botdashboard') // keeps the taskbar pin and the window grouped

app.whenReady().then(async () => {
  const userData = app.getPath('userData')
  config = new Config(path.join(userData, 'config.json'))
  reviewsDir = path.join(userData, 'reviews')
  try { dash = await startDashboard(config.data.dashboard, { repoRoot: REPO_ROOT, log }) }
  catch (e) { log('FATAL', e.message); app.exit(1); return }

  triggers = new TriggerManager(config, {})
  triggers.register(createReviewTrigger({ reviewsDir, getConfig: () => config.data }))
  triggers.on('update', () => sendUI('state', snapshot()))

  handle('state', () => snapshot())
  handle('trigger:run', (id) => { triggers.runNow(String(id)).catch(() => {}); return true })
  handle('trigger:set', (id, patch) => {
    const clean = {}
    if (typeof patch.enabled === 'boolean') clean.enabled = patch.enabled
    if (Number.isFinite(patch.intervalMin)) clean.intervalMin = Math.min(1440, Math.max(1, Math.round(patch.intervalMin)))
    triggers.setSettings(String(id), clean)
    return snapshot()
  })

  handle('reviewer:state', () => reviewerState())
  handle('reviewer:run', () => runReviewerNow())
  handle('reviewer:install', async (minutes) => {
    if (!schedule) return { ok: false, error: 'reviewer folder not found' }
    const r = await schedule.install({ scriptPath: path.join(REVIEWER_DIR, 'run.js'), minutes: Math.min(120, Math.max(1, Math.round(Number(minutes) || 10))) })
    return { ...r, state: await reviewerState() }
  })
  handle('reviewer:uninstall', async () => (schedule ? { ...(await schedule.uninstall()), state: await reviewerState() } : { ok: false }))

  handle('loop:state', () => getLoopState())
  handle('loop:run', (id) => runLoopJob(String(id)))
  handle('loop:install', async (id, minutes) => {
    if (!loopLib || !JOB_IDS.includes(String(id))) return { ok: false, error: 'the reviewer folder was not found next to the app' }
    const job = loopLib.schedule.JOBS[String(id)]
    fs.mkdirSync(loopDir(), { recursive: true })
    const r = await loopLib.schedule.install({ scriptPath: path.join(REVIEWER_DIR, 'run.js'), minutes: Number(minutes) || job.minutes, job })
    return { ...r, state: await getLoopState() }
  })
  handle('loop:codeDir', async (dir) => {
    const v = String(dir || '').trim()
    if (v && !fs.existsSync(v)) return { ok: false, error: 'that folder does not exist', state: await getLoopState() }
    config.set('loop.codeDir', v || undefined)
    return { ok: true, state: await getLoopState() }
  })
  handle('loop:fixMode', async (mode) => {
    if (!['merge', 'pr', 'local'].includes(String(mode))) return { ok: false, error: 'unknown mode', state: await getLoopState() }
    config.set('loop.fixMode', String(mode))
    return { ok: true, state: await getLoopState() }
  })
  handle('loop:uninstall', async (id) => {
    if (!loopLib || !JOB_IDS.includes(String(id))) return { ok: false }
    return { ...(await loopLib.schedule.uninstall(undefined, loopLib.schedule.JOBS[String(id)])), state: await getLoopState() }
  })

  // Updates: only the installed (packaged) app can update itself; from source the page says to use git pull.
  let autoUpdater = null
  if (app.isPackaged) { try { ({ autoUpdater } = require('electron-updater')) } catch (e) { log('electron-updater not available:', e.message) } }
  updates = new UpdateManager({ autoUpdater, currentVersion: app.getVersion(), isPackaged: app.isPackaged, log, beforeInstall: () => { if (dash) dash.stop(); if (triggers) triggers.stop() } })
  updates.on('update', (s) => sendUI('update', s))
  handle('update:state', () => updates.state())
  handle('update:check', () => updates.check())
  handle('update:install', () => { updates.install().catch(() => {}); return updates.state() })
  // Local control endpoint (127.0.0.1 + token file): lets a Claude session on this laptop check/download/install updates. See lib/control.js.
  if (config.data.control.enabled) control = await startControlServer({ updates, info: () => ({ version: app.getVersion(), packaged: app.isPackaged }), dataDir: userData, port: config.data.control.port, log })
  handle('app:info', () => ({ version: app.getVersion(), packaged: app.isPackaged, dataDir: userData, dashboardUrl: dash.url }))

  buildMenu()
  openMain()
  triggers.start()
  // Quiet background check (nothing is downloaded): puts a dot on the Settings tab when a newer version exists.
  setTimeout(() => updates.check().catch(() => {}), 20 * 1000)
  setInterval(() => updates.check().catch(() => {}), 6 * 3600 * 1000)
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => { if (triggers) triggers.stop(); if (dash) dash.stop(); if (control) control.close() })
