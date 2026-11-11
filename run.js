// Supervisor: keeps join.js running and reconnects with backoff (3s, 6s, ... max 60s) when it exits or the bot is disconnected.
const { spawn } = require('child_process')
const fs = require('fs')
let delay = 3000
let child = null, startedAt = 0
// The deployer (tools/deployer.js) asks for a restart by writing restart-needed.json into this bot's folder when new code needs one. The request is
// kept as restart-done.json, the bot process is stopped, and the exit handler below starts it again on the new code. A bot that has only just started
// is given 20 seconds first, so a request cannot kill it in a loop.
const RESTART_NOTE = 'restart-needed.json'
const POLL_MS = Number(process.env.SUPERVISOR_POLL_MS) || 15000, GRACE_MS = Number(process.env.SUPERVISOR_GRACE_MS) || 20000
setInterval(() => {
  if (!child || Date.now() - startedAt < GRACE_MS || !fs.existsSync(RESTART_NOTE)) return
  let why = ''; try { why = String(JSON.parse(fs.readFileSync(RESTART_NOTE, 'utf8')).why || '').slice(0, 160) } catch { /* an unreadable note is still a request */ }
  try { fs.renameSync(RESTART_NOTE, 'restart-done.json') } catch { try { fs.unlinkSync(RESTART_NOTE) } catch { return } }
  fs.appendFileSync('join.log', `SUPERVISOR restart requested (${why || 'no reason given'}) at ${new Date().toISOString()}; stopping join.js pid ${child.pid}\n`)
  delay = 3000
  try { child.kill() } catch { /* already gone: the exit handler restarts it */ }
}, POLL_MS)
function start() {
  const out = fs.openSync('join.log', 'a')
  const t0 = startedAt = Date.now()
  child = spawn(process.execPath, [require('path').join(__dirname, 'join.js')], { stdio: ['ignore', out, out], env: { ...process.env, SKIP_HELLO: '1' } })
  delete process.env.PENDING_CMD // one-shot startup command only runs on the first start
  fs.appendFileSync('join.log', `SUPERVISOR started join.js pid ${child.pid} at ${new Date().toISOString()}\n`)
  child.on('exit', (code) => {
    const lived = Date.now() - t0
    delay = lived > 60000 ? 3000 : Math.min(delay * 2, 60000)
    fs.appendFileSync('join.log', `SUPERVISOR join.js exited (code ${code}) after ${Math.round(lived / 1000)}s; restarting in ${delay / 1000}s\n`)
    setTimeout(start, delay)
  })
}
start()
