// Supervisor: keeps join.js running and reconnects with backoff (3s, 6s, ... max 60s) when it exits or the bot is disconnected.
const { spawn } = require('child_process')
const fs = require('fs')
let delay = 3000
function start() {
  const out = fs.openSync('join.log', 'a')
  const t0 = Date.now()
  const child = spawn(process.execPath, [require('path').join(__dirname, 'join.js')], { stdio: ['ignore', out, out], env: { ...process.env, SKIP_HELLO: '1' } })
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
