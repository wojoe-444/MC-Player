// Tiny read-only HTTP server for the dashboard: GET/HEAD only, bound to 127.0.0.1, no dependencies.
//   /                 the page
//   /api/status       live JSON snapshot (also /status.json)
//   /pov/latest.png   last POV image (never cached)
//   /healthz          "ok"
const http = require('http')
const fs = require('fs')
const path = require('path')

const PAGE = path.join(__dirname, 'page.html')
const HOST_OK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i

function createServer({ getSnapshot, povPath, onLog = () => {} }) {
  const server = http.createServer((req, res) => {
    const send = (code, type, body, extra = {}) => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra })
      res.end(req.method === 'HEAD' ? undefined : body)
    }
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain', 'read-only', { Allow: 'GET, HEAD' })
      // DNS-rebinding guard: only answer requests addressed to a loopback name.
      if (!HOST_OK.test(req.headers.host || '')) return send(403, 'text/plain', 'forbidden host')
      const url = new URL(req.url, 'http://localhost')
      switch (url.pathname) {
        case '/':
        case '/index.html':
          return send(200, 'text/html; charset=utf-8', fs.readFileSync(PAGE), { 'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:" })
        case '/api/status':
        case '/status.json':
          return send(200, 'application/json; charset=utf-8', JSON.stringify(getSnapshot()))
        case '/pov/latest.png': {
          let buf
          try { buf = fs.readFileSync(povPath) } catch { return send(404, 'text/plain', 'no POV image yet') }
          return send(200, 'image/png', buf)
        }
        case '/healthz':
          return send(200, 'text/plain', 'ok')
        default:
          return send(404, 'text/plain', 'not found')
      }
    } catch (e) {
      onLog('request failed: ' + e.message)
      if (!res.headersSent) send(500, 'text/plain', 'error')
      else res.end()
    }
  })
  return server
}

// Listens on 127.0.0.1:port, trying port+1.. when it is taken (up to `tries`). Resolves with the bound port, or null when
// nothing could be bound (the caller logs it; the dashboard must never take the bot down).
function listen(server, port, tries = 5) {
  return new Promise((resolve) => {
    let p = port
    const attempt = () => {
      const onError = (e) => {
        if (e.code === 'EADDRINUSE' && port !== 0 && --tries > 0) { p++; attempt() } else resolve(null)
      }
      server.once('error', onError)
      server.listen(p, '127.0.0.1', () => { server.removeListener('error', onError); resolve(server.address().port) })
    }
    attempt()
  })
}

function close(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve()
    server.close(() => resolve())
    if (server.closeAllConnections) server.closeAllConnections()
  })
}

module.exports = { createServer, listen, close }
