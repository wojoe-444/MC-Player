// Local control endpoint so a Claude session on the same laptop can check for, download and install app updates
// (the same actions as Settings > "Check for updates" / "Update and restart") without anyone pressing buttons.
//
// Security model (simplest thing that is safe on a single-user laptop):
//   - listens on 127.0.0.1 only, never on a network interface
//   - every request needs `Authorization: Bearer <token>`; the token is random, created on first start and kept in
//     control.json in the app's data folder (plus a pointer copy in ~/.mc-player/app-control.json so tools can find it)
//   - requests carrying an Origin header (any web page) or an unexpected Host header (DNS rebinding) are refused
//   - it only exposes update status / check / apply; it can't read files, run commands or change settings
// Pure Node (no electron import) so it can be unit tested.
const http = require('http')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const DEFAULT_PORT = 8766

function loadOrCreateToken(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (j && typeof j.token === 'string' && j.token.length >= 32) return j.token
  } catch {}
  return crypto.randomBytes(32).toString('hex')
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 })
}

function tokenOk(header, token) {
  const m = /^Bearer (.+)$/.exec(String(header || ''))
  if (!m) return false
  const a = crypto.createHash('sha256').update(m[1]).digest()
  const b = crypto.createHash('sha256').update(token).digest()
  return crypto.timingSafeEqual(a, b)
}

// updates: an UpdateManager. info(): { version, packaged }. Resolves to { port, token, close() }.
function startControlServer({ updates, info, dataDir, port = DEFAULT_PORT, pointerFile = path.join(os.homedir(), '.mc-player', 'app-control.json'), log = () => {} }) {
  const file = path.join(dataDir, 'control.json')
  const token = loadOrCreateToken(file)
  let actualPort = port

  const send = (res, code, body) => {
    const s = JSON.stringify(body)
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s), 'Cache-Control': 'no-store' })
    res.end(s)
  }
  const status = () => ({ app: info(), update: updates.state() })

  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.origin) return send(res, 403, { error: 'browser requests are refused' })
      const host = String(req.headers.host || '')
      if (host !== `127.0.0.1:${actualPort}` && host !== `localhost:${actualPort}`) return send(res, 403, { error: 'bad host' })
      if (!tokenOk(req.headers.authorization, token)) return send(res, 401, { error: 'missing or wrong token' })
      const route = `${req.method} ${req.url.split('?')[0]}`
      if (route === 'GET /v1/status') return send(res, 200, status())
      if (route === 'POST /v1/update/check') { await updates.check(); return send(res, 200, status()) }
      if (route === 'POST /v1/update/apply') {
        // Check, and if a newer release exists download it and restart into it (what the "Update and restart" button does).
        // The app quits during the install, so this answers as soon as the download has started; poll /v1/status afterwards.
        const s = await updates.apply()
        return send(res, 200, { app: info(), update: s })
      }
      return send(res, 404, { error: 'unknown route', routes: ['GET /v1/status', 'POST /v1/update/check', 'POST /v1/update/apply'] })
    } catch (e) {
      send(res, 500, { error: String(e && e.message || e).slice(0, 300) })
    }
  })

  return new Promise((resolve) => {
    server.once('error', (e) => { log('control endpoint not started:', e.message); resolve(null) })
    server.listen(port, '127.0.0.1', () => {
      actualPort = server.address().port
      const entry = { port: actualPort, token, pid: process.pid, startedAt: new Date().toISOString() }
      try { writeJson(file, entry); writeJson(pointerFile, entry) } catch (e) { log('control: could not write token file:', e.message) }
      log(`control endpoint on 127.0.0.1:${actualPort}`)
      resolve({ port: actualPort, token, close: () => new Promise(r => server.close(() => r())) })
    })
  })
}

module.exports = { startControlServer, DEFAULT_PORT }
