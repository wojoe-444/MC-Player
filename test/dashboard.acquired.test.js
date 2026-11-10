// dashboard/server.js: /api/acquired sums brain/state/acquired.jsonl per bot for a window.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const net = require('net')
const { spawn } = require('child_process')

const HOUR = 3600e3
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })

test('/api/acquired: windows, per-bot sums, tracking start, a bot with no log', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acq-dash-'))
  const ozo = path.join(root, 'ozo'), smeo = path.join(root, 'smeo')
  fs.mkdirSync(path.join(ozo, 'brain', 'state'), { recursive: true }); fs.mkdirSync(path.join(smeo, 'brain', 'state'), { recursive: true })
  const now = Date.now()
  const L = (t, item, n) => JSON.stringify({ t, item, n })
  fs.writeFileSync(path.join(ozo, 'brain', 'state', 'acquired.jsonl'), [
    L(now - 10 * HOUR, 'oak_log', 40), L(now - 3 * HOUR, 'oak_log', 5), L(now - 2 * HOUR, 'cobblestone', 64), L(now - 30 * 60e3, 'oak_log', 2), '{"torn',
  ].join('\n') + '\n')
  const port = await freePort()
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'dashboard', 'server.js')], { env: { ...process.env, PORT: String(port), BOT_OZO_DIR: ozo, BOT_SMEO_DIR: smeo, BOT_CODE_DIR: root }, stdio: 'ignore' })
  try {
    let r
    for (let i = 0; i < 50 && !r; i++) { try { r = await fetch(`http://127.0.0.1:${port}/api/acquired`) } catch { await new Promise(x => setTimeout(x, 100)) } }
    assert.ok(r, 'server did not start')
    const d = await r.json()
    assert.strictEqual(d.window, '8h')                                          // default window is the last 8 hours: the 40 logs from 10 h ago are out
    assert.deepStrictEqual(d.bots, { ozo: { oak_log: 7, cobblestone: 64 }, smeo: {} })
    assert.ok(Math.abs(d.trackingSince - (now - 10 * HOUR)) < 1000)
    const get = async (w) => (await (await fetch(`http://127.0.0.1:${port}/api/acquired?window=${w}`)).json())
    assert.deepStrictEqual((await get('1h')).bots.ozo, { oak_log: 2 })
    assert.deepStrictEqual((await get('24h')).bots.ozo, { oak_log: 47, cobblestone: 64 })
    assert.deepStrictEqual((await get('all')).bots.ozo, { oak_log: 47, cobblestone: 64 })
    assert.strictEqual((await get('bogus')).window, '8h')                       // unknown window falls back to the default
  } finally { child.kill() }
})
