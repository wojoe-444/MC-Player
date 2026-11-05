#!/usr/bin/env node
// Throwaway vanilla Minecraft server for trials. No dependencies, Node 18+, Java required.
//   node server.js setup  [--version 1.21.6] [--port 25599] [--dir .trial-server] [--ops TrialA,TrialB] [--mode flat|default]
//   node server.js start | stop | status | log [n]   (same --dir)
// Offline mode, so test bots join with any name and no Microsoft login. Never touches other Java processes:
// start records the server's PID in <dir>/server.pid and stop kills only that PID.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const https = require('https')
const { spawn, execFileSync } = require('child_process')

const args = process.argv.slice(2)
const cmd = args[0]
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d }
const DIR = path.resolve(opt('dir', '.trial-server'))
const PIDFILE = path.join(DIR, 'server.pid')
const P = (f) => path.join(DIR, f)

function get(url) {
  return new Promise((resolve, reject) => https.get(url, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return resolve(get(res.headers.location))
    if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' for ' + url))
    const chunks = []
    res.on('data', c => chunks.push(c))
    res.on('end', () => resolve(Buffer.concat(chunks)))
  }).on('error', reject))
}

// vanilla offline-mode UUID (version 3 of "OfflinePlayer:<name>")
function offlineUuid(name) {
  const h = crypto.createHash('md5').update('OfflinePlayer:' + name).digest()
  h[6] = (h[6] & 0x0f) | 0x30
  h[8] = (h[8] & 0x3f) | 0x80
  return h.toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return false } }
const readLog = () => { try { return fs.readFileSync(P('logs/latest.log'), 'utf8') } catch (e) { return '' } }
const readPid = () => { try { return parseInt(fs.readFileSync(PIDFILE, 'utf8'), 10) } catch (e) { return null } }

async function setup() {
  const version = opt('version', '1.21.6')
  const port = opt('port', '25599')
  const ops = opt('ops', 'TrialA,TrialB').split(',').filter(Boolean)
  fs.mkdirSync(DIR, { recursive: true })
  const jar = P('server.jar')
  if (!fs.existsSync(jar)) {
    const manifest = JSON.parse(await get('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'))
    const v = manifest.versions.find(x => x.id === version)
    if (!v) throw new Error('unknown version ' + version)
    const dl = JSON.parse(await get(v.url)).downloads.server
    console.log('downloading server ' + version + ' (' + (dl.size / 1e6).toFixed(0) + ' MB) from Mojang')
    const buf = await get(dl.url)
    if (crypto.createHash('sha1').update(buf).digest('hex') !== dl.sha1) throw new Error('sha1 mismatch, refusing to use the jar')
    fs.writeFileSync(jar, buf)
  }
  fs.writeFileSync(P('eula.txt'), 'eula=true\n') // running this accepts https://aka.ms/MinecraftEULA
  fs.writeFileSync(P('server.properties'), [
    'online-mode=false',
    'server-port=' + port,
    opt('mode', 'flat') === 'flat' ? 'level-type=minecraft\\:flat' : 'level-type=minecraft\\:normal',
    'gamemode=survival', 'difficulty=normal', 'spawn-protection=0', 'max-players=8', 'view-distance=8', 'motd=trial-server', ''
  ].join('\n'))
  fs.writeFileSync(P('ops.json'), JSON.stringify(ops.map(name => ({ uuid: offlineUuid(name), name, level: 4, bypassesPlayerLimit: true }))))
  console.log('ready in ' + DIR + ': port ' + port + ', ops ' + ops.join(', '))
}

async function start() {
  if (!fs.existsSync(P('server.jar'))) throw new Error('run setup first')
  const old = readPid()
  if (old && alive(old)) { console.log('already running, pid', old); return }
  fs.rmSync(P('logs/latest.log'), { force: true })
  const out = fs.openSync(P('server.log'), 'w')
  const child = spawn('java', ['-Xmx1G', '-jar', 'server.jar', 'nogui'], { cwd: DIR, detached: true, stdio: ['ignore', out, out] })
  child.unref()
  fs.writeFileSync(PIDFILE, String(child.pid))
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 500))
    if (/Done \(/.test(readLog())) { console.log('server up, pid', child.pid); return }
    if (!alive(child.pid)) throw new Error('server exited, see ' + P('logs/latest.log'))
  }
  throw new Error('server did not finish starting in 60s, see ' + P('logs/latest.log'))
}

function stop() {
  const pid = readPid()
  if (!pid || !alive(pid)) { console.log('not running'); return }
  if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'])
  else process.kill(pid, 'SIGTERM')
  fs.rmSync(PIDFILE, { force: true })
  console.log('stopped pid', pid)
}

;(async () => {
  try {
    if (cmd === 'setup') await setup()
    else if (cmd === 'start') await start()
    else if (cmd === 'stop') stop()
    else if (cmd === 'status') { const p = readPid(); console.log(p && alive(p) ? 'running, pid ' + p : 'stopped') }
    else if (cmd === 'log') console.log(readLog().split('\n').slice(-(parseInt(args[1], 10) || 20)).join('\n'))
    else console.log('usage: server.js setup|start|stop|status|log [--dir D] [--version V] [--port N] [--ops A,B] [--mode flat|default]')
  } catch (e) { console.error('error:', e.message); process.exit(1) }
})()
