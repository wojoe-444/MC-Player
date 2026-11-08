// Electron entry: starts (or attaches to) the dashboard server, shows it in a window, and runs background triggers.
const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron')
const path = require('path')
const { Config } = require('./lib/config')
const { startDashboard } = require('./lib/dashboard-process')
const { TriggerManager } = require('./lib/triggers')
const { createReviewTrigger, listReviews } = require('./lib/review')

// Packaged: electron-builder copies dashboard/ into resources/. From source: the repo root is one level up.
const REPO_ROOT = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..')
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

  buildMenu()
  openMain()
  triggers.start()
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => { if (triggers) triggers.stop(); if (dash) dash.stop() })
