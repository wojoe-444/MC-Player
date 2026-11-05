// Dashboard module: read-only status page on http://127.0.0.1:3010 plus brain/state/dashboard-status.json.
// Reads api.status.all(), the live bot object and a few state files (stations.json, chest-index.json, chat.log, pov/latest.png).
// It never sends chat, never moves the bot and never writes outside api.statePath().
const fs = require('fs')
const path = require('path')
const { build, FileCache } = require('./snapshot')
const { createServer, listen, close } = require('./server')

const DEFAULT_PORT = 3010

function create(api, opts = {}) {
  const dir = opts.dir || api.dir || path.join(__dirname, '..', '..')
  const povPath = opts.povPath || path.join(dir, 'pov', 'latest.png')
  const wantPort = opts.port ?? (process.env.BOT_DASHBOARD_PORT !== undefined ? Number(process.env.BOT_DASHBOARD_PORT) : DEFAULT_PORT)
  const writeMs = opts.writeStatusMs ?? 5000
  const log = (msg) => { try { api.log && api.log('dashboard', msg) } catch {} }
  const cache = new FileCache()
  const ring = []                       // chat lines seen through api.events when status.all() has no chatTail
  const startedAt = api.now ? api.now() : Date.now()
  let server = null, port = null, timer = null, onChat = null, statusFile = null

  const snapshot = () => build({ api, dir, povPath, cache, ring, startedAt, port })

  function writeStatus() {
    if (!statusFile) return
    try {
      const tmp = statusFile + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(snapshot()))
      fs.renameSync(tmp, statusFile)
    } catch (e) { log('status.json write failed: ' + e.message) }
  }

  return {
    name: 'dashboard',
    snapshot,
    async start() {
      if (server || wantPort < 0) return
      try {
        if (api.statePath && opts.writeStatus !== false) {
          statusFile = api.statePath('dashboard-status.json')
          fs.mkdirSync(path.dirname(statusFile), { recursive: true })
        }
        if (api.events && api.events.on) {
          onChat = ({ user, text }) => { ring.push({ t: Date.now(), from: user, text: String(text) }); if (ring.length > 60) ring.shift() }
          api.events.on('chat', onChat)
        }
        server = createServer({ getSnapshot: snapshot, povPath, onLog: log })
        port = await listen(server, wantPort)
        if (port === null) { log(`could not bind 127.0.0.1:${wantPort}; dashboard disabled`); server = null }
        else log(`dashboard on http://127.0.0.1:${port}/`)
        if (writeMs > 0) {
          writeStatus()
          timer = setInterval(writeStatus, writeMs)
          if (timer.unref) timer.unref()
        }
      } catch (e) { log('start failed: ' + e.message) }
    },
    async stop() {
      clearInterval(timer); timer = null
      if (api.events && onChat) api.events.removeListener('chat', onChat)
      onChat = null
      if (server) { const s = server; server = null; await close(s) }
      port = null
    },
    status() { return { url: port ? `http://127.0.0.1:${port}/` : null, port } },
    port: () => port
  }
}

module.exports = function register(api) { return create(api) }
module.exports.create = create
module.exports.meta = { name: 'dashboard', version: 1 }
module.exports.DEFAULT_PORT = DEFAULT_PORT
