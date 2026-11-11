#!/usr/bin/env node
// Follow the LAN port so nobody has to chase it by hand. When Walter opens a world to LAN, Minecraft announces it on the local network
// (UDP multicast 224.0.2.60:4445, text "[MOTD]name[/MOTD][AD]port[/AD]", every ~1.5 s). This listens for that announcement and writes the port into
// lan-port.txt of each bot runtime folder. join.js reads that file each time the supervisor (run.js) starts it, and the supervisor restarts it every few seconds
// while the server refuses connections, so the bots rejoin by themselves: no restart, no chat, no commands in game. It only reads announcements that
// come from this machine (a stranger's LAN world on the same network never moves the bots).
//
//   node scripts/lan-watch.js [runtimeDir ...]       (default: ../Minecraft-Survival and ../Minecraft-Smeo, next to this repo)
//   powershell -NoProfile -File scripts/start-lan-watch.ps1        detached
// Log: <repo>/../bot-shared/lan-watch.log (one line per port change).
const dgram = require('dgram')
const os = require('os')
const fs = require('fs')
const path = require('path')

const GROUP = '224.0.2.60', PORT = 4445

function parseAnnouncement(text) {
  const m = /\[MOTD\]([\s\S]*?)\[\/MOTD\]\s*\[AD\](\d{1,5})\[\/AD\]/.exec(String(text))
  if (!m) return null
  const port = Number(m[2])
  return port >= 1024 && port <= 65535 ? { motd: m[1], port } : null
}
function localAddresses() {
  const out = new Set(['127.0.0.1'])
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' || i.family === 4) out.add(i.address)
  return out
}
function currentPort(dir) { try { return parseInt(fs.readFileSync(path.join(dir, 'lan-port.txt'), 'utf8'), 10) || 0 } catch { return 0 } }
// the port a runtime folder should hold after an accepted announcement (null: it already holds it)
function writePort(dirs, port) {
  const changed = []
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue
    if (currentPort(d) === port) continue
    fs.writeFileSync(path.join(d, 'lan-port.txt'), String(port) + '\n'); changed.push(d)
  }
  return changed
}

function start(dirs, log = () => {}) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  let pending = null, seen = 0
  sock.on('error', (e) => log('socket error: ' + e.message))
  sock.on('message', (buf, rinfo) => {
    const a = parseAnnouncement(buf.toString('utf8')); if (!a) return
    if (!localAddresses().has(rinfo.address)) return                       // only this machine's own worlds
    if (pending === a.port) seen++; else { pending = a.port; seen = 1 }
    if (seen < 2) return                                                   // two announcements in a row, not a stray packet
    const changed = writePort(dirs, a.port)
    if (changed.length) log(`LAN world "${a.motd}" on ${a.port}: wrote lan-port.txt in ${changed.map(c => path.basename(c)).join(', ')}`)
  })
  sock.bind(PORT, () => {
    let joined = 0
    for (const addr of localAddresses()) { try { sock.addMembership(GROUP, addr); joined++ } catch { /* that adapter has no multicast */ } }
    if (!joined) { try { sock.addMembership(GROUP); joined++ } catch { /* nothing to listen on */ } }
    log(`listening for LAN announcements on ${GROUP}:${PORT} (${joined} interface${joined === 1 ? '' : 's'}); runtimes: ${dirs.map(d => path.basename(d)).join(', ')}`)
  })
  return sock
}

module.exports = { parseAnnouncement, writePort, start }

if (require.main === module) {
  const repo = path.join(__dirname, '..')
  const args = process.argv.slice(2).map(d => path.resolve(d))
  const dirs = args.length ? args : [path.join(repo, '..', 'Minecraft-Survival'), path.join(repo, '..', 'Minecraft-Smeo')]
  const logFile = path.join(repo, '..', 'bot-shared', 'lan-watch.log')
  const log = (m) => { const line = new Date().toISOString() + ' ' + m; console.log(line); try { fs.appendFileSync(logFile, line + '\n') } catch { /* no shared folder */ } }
  start(dirs, log)
}
