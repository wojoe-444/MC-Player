// node brain/pilot/bench-chain.js [N]
// End to end, in process, against the REAL OpenRouter endpoints (Elephant-1 + the quick voice): Walter's line -> router + pilot (fake bot) -> first thing the bot says.
// Prints the time to the first bot line per chat.log line. The key is read from brain/router/openrouter.key or env and never printed. Costs a fraction of a cent.
const fs = require('fs')
const path = require('path')
const ROOT = path.resolve(__dirname, '..', '..')
const { rig } = require(path.join(ROOT, 'test', 'router.helpers'))

const N = Number(process.argv[2] || 10)
let key = process.env.OPENROUTER_API_KEY
if (!key) { try { key = fs.readFileSync(path.join(ROOT, 'brain/router/openrouter.key'), 'utf8').split(/\r?\n/)[0].trim() } catch { /* none */ } }
if (!key) { console.log('no OpenRouter key found'); process.exit(1) }

const lines = fs.readFileSync(path.join(ROOT, 'chat.log'), 'utf8').split(/\r?\n/).filter(l => l.startsWith('OGWO: ')).map(l => l.slice(6)).filter(l => l.length > 12)
const pick = lines.filter((_, i) => i % Math.max(1, Math.floor(lines.length / N)) === 0).slice(0, N)

;(async () => {
  const r = rig({ fetch: undefined, env: { OPENROUTER_API_KEY: key }, config: { ackAfterMs: 3400, timeoutMs: 3000, fastlane: false } })
  r.api.pilotOptions = { env: { OPENROUTER_API_KEY: key }, noWatch: true, config: { feed: { capMs: 2200 } } }
  const pilot = require('./index')(r.api)
  try { fs.copyFileSync(path.join(ROOT, 'brain/state/claude-notes.md'), path.join(r.dir, 'claude-notes.md')) } catch { /* no notes */ }
  pilot.start()
  const times = []
  for (const text of pick) {
    const t0 = Date.now(), before = r.said.length
    r.events.emit('chat', { user: 'OGWO', text })
    pilot.fallback('OGWO', text)
    r.mod.fallback('OGWO', text)
    await r.mod.idle()
    const ms = Date.now() - t0
    const said = r.said.slice(before)
    times.push(ms)
    console.log(`[${String(ms).padStart(4)} ms] ${text.slice(0, 64)}\n          -> ${said.join(' | ') || '(nothing said)'}`)
    await new Promise(res => setTimeout(res, 300))
  }
  times.sort((a, b) => a - b)
  console.log(`\nfirst-reply time: median ${times[Math.floor(times.length / 2)]} ms, max ${times[times.length - 1]} ms over ${times.length} lines`)
  console.log('talker:', JSON.stringify(pilot.status().talker.byReason))
  pilot.stop()
  process.exit(0)
})()
