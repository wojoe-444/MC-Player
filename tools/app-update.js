#!/usr/bin/env node
// Update the installed Bot Dashboard app from a terminal (what Claude uses on the laptop).
//   node tools/app-update.js status          app version + update state
//   node tools/app-update.js check           ask GitHub whether a newer release exists
//   node tools/app-update.js apply [--wait]  check; if newer, download, install and restart the app (--wait polls until the new version is up)
// Finds the app through ~/.mc-player/app-control.json (written by the app; contains a local-only port + token).
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const file = process.env.MC_APP_CONTROL || path.join(os.homedir(), '.mc-player', 'app-control.json')
const cmd = process.argv[2] || 'status'
const wait = process.argv.includes('--wait')

function call(method, route) {
  return new Promise((resolve, reject) => {
    let c
    try { c = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return reject(new Error(`app control file not found (${file}). Is the Bot Dashboard app (a version with the control endpoint) installed and running?`)) }
    const req = http.request({ host: '127.0.0.1', port: c.port, path: route, method, headers: { Authorization: `Bearer ${c.token}` }, timeout: 120000 }, (res) => {
      let b = ''; res.on('data', d => b += d)
      res.on('end', () => { try { resolve({ code: res.statusCode, body: JSON.parse(b) }) } catch { resolve({ code: res.statusCode, body: b }) } })
    })
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')))
    req.end()
  })
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const show = (r) => console.log(JSON.stringify(r.body, null, 2))

async function main() {
  if (cmd === 'status') return show(await call('GET', '/v1/status'))
  if (cmd === 'check') return show(await call('POST', '/v1/update/check'))
  if (cmd === 'apply') {
    const before = (await call('GET', '/v1/status')).body
    const r = await call('POST', '/v1/update/apply')
    show(r)
    const u = r.body && r.body.update
    if (!wait || !u || u.status === 'up-to-date' || u.status === 'error' || u.status === 'unsupported') return
    // The app quits into the installer and relaunches; poll until it answers again with a different version.
    const t0 = Date.now()
    while (Date.now() - t0 < 10 * 60 * 1000) {
      await sleep(5000)
      try {
        const s = (await call('GET', '/v1/status')).body
        if (s && s.app && s.app.version !== before.app.version) { console.log(`updated: ${before.app.version} -> ${s.app.version}`); return }
      } catch {} // app is restarting
    }
    console.error('timed out waiting for the app to come back on a new version'); process.exitCode = 1
    return
  }
  console.error('usage: app-update.js status | check | apply [--wait]'); process.exitCode = 2
}
main().catch(e => { console.error(e.message); process.exitCode = 1 })
