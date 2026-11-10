const $ = (id) => document.getElementById(id)
const when = (iso) => iso ? new Date(iso).toLocaleString() : ''

function render(u) {
  const st = $('status'), check = $('check'), install = $('install'), bar = $('bar'), notes = $('notes')
  const busy = u.status === 'checking' || u.status === 'downloading' || u.status === 'ready'
  check.disabled = busy || u.status === 'unsupported'
  install.hidden = !(u.status === 'available' || (u.status === 'error' && u.latest))
  install.disabled = busy
  bar.hidden = u.status !== 'downloading'; bar.value = u.progress || 0
  notes.hidden = !(u.notes && u.status === 'available'); notes.textContent = u.notes || ''
  st.className = u.status === 'error' ? 'err' : u.status === 'up-to-date' || u.status === 'available' ? 'ok' : 'muted'
  const checked = u.checkedAt ? ` Last checked ${when(u.checkedAt)}.` : ''
  st.textContent = ({
    unsupported: 'Updates only work in the installed app. This copy runs from source: use git pull and npm start.',
    idle: 'Press "Check for updates" to look for a newer version.',
    checking: 'Checking GitHub for a newer version…',
    'up-to-date': `You are up to date.${checked}`,
    available: `Version ${u.latest} is available.${checked}`,
    downloading: `Downloading version ${u.latest}… ${u.progress || 0}%`,
    ready: 'Installing and restarting…',
    error: `Update failed: ${u.error || 'unknown error'}`,
  })[u.status] || u.status
  install.textContent = u.status === 'error' ? 'Retry update and restart' : 'Update and restart'
}

window.botApp.appInfo().then(i => {
  $('version').textContent = `Bot Dashboard ${i.version}`
  $('sub').textContent = `Settings and reviews are stored in ${i.dataDir}. Dashboard: ${i.dashboardUrl}`
})
window.botApp.onUpdate(render)
window.botApp.updateState().then(render)
$('check').onclick = () => window.botApp.updateCheck()
$('install').onclick = () => window.botApp.updateInstall()
