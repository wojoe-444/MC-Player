// Server manager for the bench: one vanilla 1.21.6 server in offline mode per run, in its own folder, controlled over RCON.
// Shares the registry file with .claude/skills/trial-server (os.tmpdir()/mc-trial-servers.json) so the one-trial-server-at-a-time rule holds across tools.
// Stops only the PID it started. Never kills other Java processes.
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, execFileSync } = require('child_process')
const rcon = require('./rcon')

const REGISTRY = path.join(os.tmpdir(), 'mc-trial-servers.json')
const readRegistry = () => { try { return JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) } catch { return [] } }
const writeRegistry = (l) => { try { fs.writeFileSync(REGISTRY, JSON.stringify(l)) } catch {} }
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// where the Mojang jar is: BENCH_JAR, the repo's own .trial-server, or a sibling checkout's (the jar is the same file, 50 MB, not committed)
function findJar(repo) {
  const cands = [process.env.BENCH_JAR, path.join(repo, '.trial-server', 'server.jar'), path.join(repo, '.bench', 'server.jar')]
  const parent = path.dirname(repo)
  try { for (const d of fs.readdirSync(parent)) if (/^MC-Player/.test(d)) cands.push(path.join(parent, d, '.trial-server', 'server.jar')) } catch {}
  return cands.filter(Boolean).find(p => fs.existsSync(p)) || null
}

const PROPS = (o) => [
  'online-mode=false', 'server-port=' + o.port, 'level-name=world', 'level-type=' + (o.levelType || 'minecraft\\:normal'), o.seed != null ? 'level-seed=' + o.seed : 'level-seed=',
  'gamemode=survival', 'difficulty=' + (o.difficulty || 'normal'), 'spawn-protection=0', 'max-players=4', 'view-distance=8', 'simulation-distance=6',
  'enable-rcon=true', 'rcon.port=' + o.rconPort, 'rcon.password=' + o.rconPassword, 'broadcast-rcon-to-ops=false',
  'pause-when-empty-seconds=0', 'max-tick-time=-1', 'player-idle-timeout=0', 'spawn-monsters=true', 'spawn-animals=true', 'generate-structures=' + (o.structures === false ? 'false' : 'true'),
  'enforce-secure-profile=false', 'motd=bench', 'op-permission-level=4', 'sync-chunk-writes=false', ''].join('\n')

// dir: the server folder (world/ inside it). Starts, waits for "Done", returns { rcon, stop, log }.
async function start({ jar, dir, port, rconPort, seed, difficulty, structures = true, levelType, ops = [], minutes = 90, force = false }) {
  fs.mkdirSync(dir, { recursive: true })
  const others = readRegistry().filter(e => alive(e.pid) && path.resolve(e.dir) !== path.resolve(dir))
  if (others.length && !force) throw new Error(`another trial server is running (pid ${others[0].pid} in ${others[0].dir}); stop it first`)
  const rconPassword = 'b' + Math.random().toString(36).slice(2, 12)
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n')   // Walter pre-approved the Mojang EULA for the trial server (coordinator note, 2026-11-11)
  fs.writeFileSync(path.join(dir, 'server.properties'), PROPS({ port, rconPort, rconPassword, seed, difficulty, structures, levelType }))
  fs.writeFileSync(path.join(dir, 'ops.json'), JSON.stringify(ops.map(n => ({ uuid: offlineUuid(n), name: n, level: 4, bypassesPlayerLimit: true }))))
  fs.copyFileSync(jar, path.join(dir, 'server.jar'))
  fs.rmSync(path.join(dir, 'logs'), { recursive: true, force: true })
  const out = fs.openSync(path.join(dir, 'server.log'), 'w')
  const child = spawn(process.platform === 'win32' ? 'javaw' : 'java', ['-Xmx1G', '-XX:ActiveProcessorCount=2', '-XX:+UseSerialGC', '-jar', 'server.jar', 'nogui'], { cwd: dir, detached: process.platform !== 'win32', stdio: ['ignore', out, out], windowsHide: true })   // javaw and no 'detached' on Windows: no console window ever opens; the output goes to server.log
  child.unref()
  try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch {}
  fs.writeFileSync(path.join(dir, 'server.pid'), String(child.pid))
  writeRegistry(readRegistry().filter(e => alive(e.pid)).concat([{ dir: path.resolve(dir), pid: child.pid }]))
  const logPath = path.join(dir, 'logs', 'latest.log')
  const log = () => { try { return fs.readFileSync(logPath, 'utf8') } catch { return '' } }
  let watchdog = null
  const stop = async () => {
    clearTimeout(watchdog)
    if (!alive(child.pid)) return
    try { const c = await rcon.connect({ port: rconPort, password: rconPassword, timeoutMs: 4000 }); await c.cmd('save-all flush').catch(() => {}); await c.cmd('stop').catch(() => {}); c.close() } catch {}
    for (let i = 0; i < 40 && alive(child.pid); i++) await sleep(500)      // a clean stop writes the world
    if (alive(child.pid)) { try { if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F']); else process.kill(child.pid, 'SIGTERM') } catch {} }
    writeRegistry(readRegistry().filter(e => e.pid !== child.pid))
  }
  if (minutes > 0) { watchdog = setTimeout(() => { stop() }, minutes * 60000); if (watchdog.unref) watchdog.unref() }
  for (let i = 0; i < 240; i++) {
    await sleep(500)
    if (/Done \(/.test(log())) {
      // "Done" can be logged a moment before the RCON listener is up
      let lastErr = null
      for (let k = 0; k < 40; k++) {
        try { const c = await rcon.connect({ port: rconPort, password: rconPassword, timeoutMs: 180000 }); return { rcon: c, stop, log, pid: child.pid, dir } } catch (e) { lastErr = e; await sleep(500) }
      }
      await stop(); throw new Error('rcon did not come up: ' + (lastErr && lastErr.message))
    }
    if (!alive(child.pid)) throw new Error('server exited, see ' + logPath)
  }
  await stop(); throw new Error('server did not start in 120 s, see ' + logPath)
}

function offlineUuid(name) {
  const h = require('crypto').createHash('md5').update('OfflinePlayer:' + name).digest()
  h[6] = (h[6] & 0x0f) | 0x30; h[8] = (h[8] & 0x3f) | 0x80
  return h.toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
}
module.exports = { start, findJar, offlineUuid, sleep }
