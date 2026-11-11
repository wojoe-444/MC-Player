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
let updates

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

// One window with a tab bar (Dashboard | Claude reviews | Memory loop | Settings). Each tab is its own web view, so the dashboard keeps its state while you look at another tab.
const TAB_H = 42
const TABS = [['dashboard', 'Dashboard'], ['reviews', 'Claude reviews'], ['loop', 'Memory loop'], ['settings', 'Settings']]
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
  views.loop = mk({ preload })
  views.settings = mk({ preload })
  tabsView = mk({ preload })
  lockDown(views.dashboard, dash.url)
  views.dashboard.webContents.loadURL(dash.url)
  for (const id of ['reviews', 'loop', 'settings']) { lockDown(views[id], 'file://'); views[id].webContents.loadFile(path.join(__dirname, 'renderer', id + '.html')) }
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

// ---- memory loop tab: Task Scheduler jobs (install, remove, run now), work orders, each bot's memory, the run log ----
const loopBots = () => { const d = config.data.dashboard; return [{ id: 'ozo', name: 'OzoGo444', dir: d.ozoDir }, { id: 'smeo', name: 'Smeo444', dir: d.smeoDir }] }
const loopDir = () => loopLib.config.loopDirOf()                      // the same folder the scheduled job resolves: beside this app's settings
const loopRunning = {}
const codeDir = () => (config.data.loop && config.data.loop.codeDir) || loopLib.config.resolveConfig({}).codeDir
const getLoopState = () => loopState({ lib: loopLib, loopDir: loopLib ? loopDir() : null, codeDir: loopLib ? codeDir() : null, bots: loopBots(), status: (job) => loopLib.schedule.status(undefined, job), running: loopRunning })
function runLoopJob(id) {
  if (!loopLib || !JOB_IDS.includes(id) || loopRunning[id]) return false
  loopRunning[id] = true
  const d = config.data.dashboard
  const child = spawn(process.execPath, [path.join(REVIEWER_DIR, 'run.js'), ...loopLib.schedule.JOBS[id].args, '--force'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', BOT_OZO_DIR: d.ozoDir, BOT_SMEO_DIR: d.smeoDir, LOOP_DIR: loopDir(), BOT_CODE_DIR: codeDir() }, windowsHide: true, stdio: 'ignore',
  })
  const done = () => { loopRunning[id] = false; getLoopState().then(s => sendTo('loop', 'loop', s)) }
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

  ipcMain.handle('loop:state', () => getLoopState())
  ipcMain.handle('loop:run', (_e, id) => runLoopJob(String(id)))
  ipcMain.handle('loop:install', async (_e, id, minutes) => {
    if (!loopLib || !JOB_IDS.includes(String(id))) return { ok: false, error: 'the reviewer folder was not found next to the app' }
    const job = loopLib.schedule.JOBS[String(id)]
    fs.mkdirSync(loopDir(), { recursive: true })
    const r = await loopLib.schedule.install({ scriptPath: path.join(REVIEWER_DIR, 'run.js'), minutes: Number(minutes) || job.minutes, job })
    return { ...r, state: await getLoopState() }
  })
  ipcMain.handle('loop:codeDir', async (_e, dir) => {
    const v = String(dir || '').trim()
    if (v && !fs.existsSync(v)) return { ok: false, error: 'that folder does not exist', state: await getLoopState() }
    config.set('loop.codeDir', v || undefined)
    return { ok: true, state: await getLoopState() }
  })
  ipcMain.handle('loop:uninstall', async (_e, id) => {
    if (!loopLib || !JOB_IDS.includes(String(id))) return { ok: false }
    return { ...(await loopLib.schedule.uninstall(undefined, loopLib.schedule.JOBS[String(id)])), state: await getLoopState() }
  })

  // Updates: only the installed (packaged) app can update itself; from source the page says to use git pull.
  let autoUpdater = null
  if (app.isPackaged) { try { ({ autoUpdater } = require('electron-updater')) } catch (e) { log('electron-updater not available:', e.message) } }
  updates = new UpdateManager({ autoUpdater, currentVersion: app.getVersion(), isPackaged: app.isPackaged, log, beforeInstall: () => { if (dash) dash.stop(); if (triggers) triggers.stop() } })
  updates.on('update', (s) => { sendTo('settings', 'update', s); sendTabs() })
  ipcMain.handle('update:state', () => updates.state())
  ipcMain.handle('update:check', () => updates.check())
  ipcMain.handle('update:install', () => { updates.install().catch(() => {}); return updates.state() })
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
app.on('before-quit', () => { if (triggers) triggers.stop(); if (dash) dash.stop() })
