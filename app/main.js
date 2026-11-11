// Electron entry: starts (or attaches to) the dashboard server, shows it in a window, and runs background triggers.
const { app, BrowserWindow, WebContentsView, Menu, ipcMain, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const { Config } = require('./lib/config')
const { startDashboard } = require('./lib/dashboard-process')
const { TriggerManager } = require('./lib/triggers')
const { createReviewTrigger, listReviews } = require('./lib/review')
const { UpdateManager } = require('./lib/updater')
const { startControlServer } = require('./lib/control')

// Packaged: electron-builder copies dashboard/ into resources/. From source: the repo root is one level up.
const REPO_ROOT = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..')
// The spectator reviewer (../reviewer) runs outside the app too, from Windows Task Scheduler; the app installs that task, runs it on demand and shows its findings.
const REVIEWER_DIR = app.isPackaged ? path.join(process.resourcesPath, 'reviewer') : path.join(__dirname, '..', 'reviewer')
let schedule = null
try { schedule = require(path.join(REVIEWER_DIR, 'lib', 'schedule')) } catch (e) { console.log('reviewer not available:', e.message) }
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

// One window with a tab bar (Dashboard | Claude reviews | Settings). Each tab is its own web view, so the dashboard keeps its state while you look at another tab.
const TAB_H = 42
const TABS = [['dashboard', 'Dashboard'], ['reviews', 'Claude reviews'], ['settings', 'Settings']]
let tabsView = null, views = {}, activeTab = 'dashboard'

function tabsState() {
  const u = updates ? updates.state() : null
  return { active: activeTab, tabs: TABS.map(([id, label]) => ({ id, label })), badges: { settings: !!u && (u.status === 'available' || u.status === 'downloading' || u.status === 'ready') } }
}
const sendTabs = () => { if (tabsView) tabsView.webContents.send('tabs', tabsState()) }
const sendTo = (id, channel, payload) => { const v = views[id]; if (v && !v.webContents.isDestroyed()) v.webContents.send(channel, payload) }

function layoutTabs() {
  if (!mainWin) return
  const [w, h] = mainWin.getContentSize()
  tabsView.setBounds({ x: 0, y: 0, width: w, height: TAB_H })
  for (const v of Object.values(views)) v.setBounds({ x: 0, y: TAB_H, width: w, height: Math.max(0, h - TAB_H) })
}

function selectTab(id) {
  if (!views[id]) return
  activeTab = id
  for (const [k, v] of Object.entries(views)) v.setVisible(k === id)
  if (mainWin && !mainWin.isDestroyed()) mainWin.setTitle(id === 'dashboard' ? 'Bot Dashboard' : 'Bot Dashboard: ' + TABS.find(t => t[0] === id)[1])
  sendTabs()
}

function openMain(tab) {
  if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); if (tab) selectTab(tab); return }
  mainWin = new BrowserWindow({
    width: 1400, height: 900, title: 'Bot Dashboard', icon: ICON, backgroundColor: '#0b0d10',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  const preload = path.join(__dirname, 'preload.js')
  const mk = (webPreferences) => { const v = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, ...webPreferences } }); v.setBackgroundColor('#0b0d10'); mainWin.contentView.addChildView(v); return v }
  views.dashboard = mk({})
  views.reviews = mk({ preload })
  views.settings = mk({ preload })
  tabsView = mk({ preload })
  lockDown(views.dashboard, dash.url)
  views.dashboard.webContents.loadURL(dash.url)
  for (const id of ['reviews', 'settings']) { lockDown(views[id], 'file://'); views[id].webContents.loadFile(path.join(__dirname, 'renderer', id + '.html')) }
  lockDown(tabsView, 'file://')
  tabsView.webContents.loadFile(path.join(__dirname, 'renderer', 'tabs.html'))
  mainWin.on('resize', layoutTabs)
  mainWin.on('closed', () => {
    for (const v of [...Object.values(views), tabsView]) { try { v.webContents.close() } catch {} }
    mainWin = null; tabsView = null; views = {}
  })
  layoutTabs()
  selectTab(tab || 'dashboard')
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
  const done = () => { reviewerRunning = false; reviewerState().then(r => sendTo('reviews', 'reviewer', r)) }
  child.once('exit', done); child.once('error', done)
  return true
}

function snapshot() {
  return { triggers: triggers.list(), reviews: listReviews(reviewsDir), dashboard: { url: dash.url, attached: dash.attached }, claude: config.data.claude }
}

const activeWc = () => (views[activeTab] && !views[activeTab].webContents.isDestroyed() ? views[activeTab].webContents : null)

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'App', submenu: [
      { label: 'Dashboard', accelerator: 'CmdOrCtrl+1', click: () => openMain('dashboard') },
      { label: 'Claude reviews', accelerator: 'CmdOrCtrl+2', click: openReviews },
      { label: 'Settings', accelerator: 'CmdOrCtrl+3', click: openSettings },
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
  triggers.on('update', () => sendTo('reviews', 'state', snapshot()))

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

  // Updates: only the installed (packaged) app can update itself; from source the page says to use git pull.
  let autoUpdater = null
  if (app.isPackaged) { try { ({ autoUpdater } = require('electron-updater')) } catch (e) { log('electron-updater not available:', e.message) } }
  updates = new UpdateManager({ autoUpdater, currentVersion: app.getVersion(), isPackaged: app.isPackaged, log, beforeInstall: () => { if (dash) dash.stop(); if (triggers) triggers.stop() } })
  updates.on('update', (s) => { sendTo('settings', 'update', s); sendTabs() })
  ipcMain.handle('update:state', () => updates.state())
  ipcMain.handle('update:check', () => updates.check())
  ipcMain.handle('update:install', () => { updates.install().catch(() => {}); return updates.state() })
  // Local control endpoint (127.0.0.1 + token file): lets a Claude session on this laptop check/download/install updates. See lib/control.js.
  if (config.data.control.enabled) control = await startControlServer({ updates, info: () => ({ version: app.getVersion(), packaged: app.isPackaged }), dataDir: userData, port: config.data.control.port, log })
  ipcMain.handle('tabs:state', () => tabsState())
  ipcMain.handle('tabs:select', (_e, id) => { selectTab(String(id)); return tabsState() })
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), packaged: app.isPackaged, dataDir: userData, dashboardUrl: dash.url }))

  buildMenu()
  openMain()
  triggers.start()
  // Quiet background check (nothing is downloaded): puts a dot on the Settings tab when a newer version exists.
  setTimeout(() => updates.check().catch(() => {}), 20 * 1000)
  setInterval(() => updates.check().catch(() => {}), 6 * 3600 * 1000)
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => { if (triggers) triggers.stop(); if (dash) dash.stop(); if (control) control.close() })
