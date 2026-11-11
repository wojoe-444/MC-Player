// In-app updates for the installed Bot Dashboard, via electron-updater and the GitHub releases of this repo
// (published by .github/workflows/release-app.yml). Pure Node apart from the injected autoUpdater, so it can be unit tested.
//
// Flow: check() asks GitHub for latest.yml and compares versions; install() (the "Update and restart" button)
// downloads the new installer, stops the dashboard child process, then quits, runs the installer silently and relaunches.
const { EventEmitter } = require('events')

const firstLine = (s) => String(s || '').split('\n').map(x => x.trim()).find(Boolean) || ''

// electron-updater errors can be long (a whole HTTP response); keep the part a person can act on.
function friendlyError(err) {
  const msg = firstLine(err && (err.message || err))
  if (/404|Cannot find latest|No published versions|latest\.yml/i.test(msg)) return 'No published update found on GitHub yet (the release build may still be running).'
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|net::ERR|getaddrinfo/i.test(msg)) return 'Could not reach GitHub. Check the internet connection and try again.'
  return msg.slice(0, 300) || 'Update failed.'
}

function notesText(info) {
  const n = info && info.releaseNotes
  if (!n) return ''
  const raw = Array.isArray(n) ? n.map(x => (x && x.note) || '').join('\n') : String(n)
  return raw.replace(/<[^>]+>/g, '').trim().slice(0, 1200)
}

class UpdateManager extends EventEmitter {
  // autoUpdater: electron-updater's autoUpdater (or a fake). beforeInstall: called right before quitAndInstall (stop child processes).
  constructor({ autoUpdater, currentVersion, isPackaged, beforeInstall = () => {}, log = () => {} }) {
    super()
    this.au = autoUpdater
    this.beforeInstall = beforeInstall
    this.log = log
    this.s = { status: isPackaged ? 'idle' : 'unsupported', current: currentVersion, latest: null, notes: '', progress: 0, checkedAt: null, error: null }
    if (!isPackaged || !autoUpdater) { this.s.status = 'unsupported'; return }
    autoUpdater.autoDownload = false          // only ever download on the explicit button
    autoUpdater.autoInstallOnAppQuit = false  // never install behind the user's back
    autoUpdater.allowPrerelease = false
    autoUpdater.on('update-available', (info) => this.set({ status: 'available', latest: info.version, notes: notesText(info), error: null }))
    autoUpdater.on('update-not-available', (info) => this.set({ status: 'up-to-date', latest: (info && info.version) || this.s.current, notes: '', error: null }))
    autoUpdater.on('download-progress', (p) => this.set({ status: 'downloading', progress: Math.round((p && p.percent) || 0) }))
    autoUpdater.on('update-downloaded', () => this.set({ status: 'ready', progress: 100 }))
    autoUpdater.on('error', (e) => { this.log('updater error:', e && e.message); this.set({ status: 'error', error: friendlyError(e) }) })
  }

  state() { return { ...this.s } }
  set(patch) { this.s = { ...this.s, ...patch }; this.emit('update', this.state()) }
  busy() { return this.s.status === 'checking' || this.s.status === 'downloading' || this.s.status === 'ready' }

  async check() {
    if (this.s.status === 'unsupported' || this.busy()) return this.state()
    this.set({ status: 'checking', error: null, progress: 0 })
    try { await this.au.checkForUpdates() } catch (e) { this.set({ status: 'error', error: friendlyError(e) }) }
    this.set({ checkedAt: new Date().toISOString() })
    return this.state()
  }

  // "Update and restart": download, then quit into the installer and relaunch.
  async install() {
    if (this.s.status !== 'available' && this.s.status !== 'error') return this.state()
    if (this.s.status === 'error' && !this.s.latest) return this.state() // nothing known to install; check first
    this.set({ status: 'downloading', progress: 0, error: null })
    try {
      await this.au.downloadUpdate()
    } catch (e) {
      this.set({ status: 'error', error: friendlyError(e) })
      return this.state()
    }
    this.set({ status: 'ready', progress: 100 })
    try { this.beforeInstall() } catch (e) { this.log('beforeInstall failed:', e.message) }
    this.au.quitAndInstall(true, true) // isSilent, isForceRunAfter
    return this.state()
  }

  // Check, then (if a newer release exists) start the same flow as the "Update and restart" button without waiting for it:
  // the app quits into the installer, so callers get the state as soon as the download has begun. Used by the local control endpoint.
  async apply() {
    if (this.s.status === 'unsupported' || this.busy()) return this.state()
    const s = await this.check()
    if (s.status === 'available') this.install().catch(() => {})
    return this.state()
  }
}

module.exports = { UpdateManager, friendlyError, notesText }
