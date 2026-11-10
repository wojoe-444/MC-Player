// Electron entry: starts (or attaches to) the dashboard server, shows it in a window, and runs background triggers.
const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const { Config } = require('./lib/config')
const { startDashboard } = require('./lib/dashboard-process')
const { TriggerManager } = require('./lib/triggers')
const { createReviewTrigger, listReviews } = require('./lib/review')

// Packaged: electron-builder copies dashboard/ into resources/. From source: the repo root is one level up.
const REPO_ROOT = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..')
// The spectator reviewer (../reviewer) runs outside the app too, from Windows Task Scheduler; the app installs that task, runs it on demand and shows its findings.
const REVIEWER_DIR = app.isPackaged ? path.join(process.resourcesPath, 'reviewer') : path.join(__dirname, '..', 'reviewer')
let schedule = null
try { schedule = require(path.join(REVIEWER_DIR, 'lib', 'schedule')) } catch (e) { console.log('reviewer not available:', e.message) }
const ICON = path.join(__dirname, 'build', 'icon.ico')
let config, dash, triggers, reviewsDir
let mainWin = null, reviewsWin = null

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

function openMain() {
  if (mainWin) return mainWin.focus()
  mainWin = new BrowserWindow({
    width: 1400, height: 900, title: 'Bot Dashboard', icon: ICON, backgroundColor: '#0b0d10',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  lockDown(mainWin, dash.url)
  mainWin.loadURL(dash.url)
  mainWin.on('closed', () => { mainWin = null })
}

function openReviews() {
  if (reviewsWin) return reviewsWin.focus()
  reviewsWin = new BrowserWindow({
    width: 760, height: 820, title: 'Claude reviews', icon: ICON, backgroundColor: '#0b0d10',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, 'preload.js') },
  })
  lockDown(reviewsWin, 'file://')
  reviewsWin.loadFile(path.join(__dirname, 'renderer', 'reviews.html'))
  reviewsWin.on('closed', () => { reviewsWin = null })
}

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
  const done = () => { reviewerRunning = false; if (reviewsWin) reviewerState().then(r => reviewsWin && reviewsWin.webContents.send('reviewer', r)) }
  child.once('exit', done); child.once('error', done)
  return true
}

function snapshot() {
  return { triggers: triggers.list(), reviews: listReviews(reviewsDir), dashboard: { url: dash.url, attached: dash.attached }, claude: config.data.claude }
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'App', submenu: [
      { label: 'Dashboard', accelerator: 'CmdOrCtrl+1', click: openMain },
      { label: 'Claude reviews', accelerator: 'CmdOrCtrl+2', click: openReviews },
      { label: 'Open dashboard in browser', click: () => shell.openExternal(dash.url) },
      { type: 'separator' }, { role: 'quit' },
    ] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'togglefullscreen' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
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
  triggers.on('update', () => { if (reviewsWin) reviewsWin.webContents.send('state', snapshot()) })

  ipcMain.handle('state', () => snapshot())
  ipcMain.handle('trigger:run', (_e, id) => { triggers.runNow(String(id)).catch(() => {}); return true })
  ipcMain.handle('trigger:set', (_e, id, patch) => {
    const clean = {}
    if (typeof patch.enabled === 'boolean') clean.enabled = patch.enabled
    if (Number.isFinite(patch.intervalMin)) clean.intervalMin = Math.min(1440, Math.max(1, Math.round(patch.intervalMin)))
    triggers.setSettings(String(id), clean)
    return snapshot()
  })

  ipcMain.handle('reviewer:state', () => reviewerState())
  ipcMain.handle('reviewer:run', () => runReviewerNow())
  ipcMain.handle('reviewer:install', async (_e, minutes) => {
    if (!schedule) return { ok: false, error: 'reviewer folder not found' }
    const r = await schedule.install({ scriptPath: path.join(REVIEWER_DIR, 'run.js'), minutes: Math.min(120, Math.max(1, Math.round(Number(minutes) || 10))) })
    return { ...r, state: await reviewerState() }
  })
  ipcMain.handle('reviewer:uninstall', async () => (schedule ? { ...(await schedule.uninstall()), state: await reviewerState() } : { ok: false }))

  buildMenu()
  openMain()
  triggers.start()
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => { if (triggers) triggers.stop(); if (dash) dash.stop() })
