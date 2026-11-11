// The deployer's lock (lib/deploy.js): held by a live process it blocks a second deploy; left behind by a process that is gone it does not.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'), os = require('os'), path = require('path')
const { runDeploy, alive } = require('../lib/deploy')

const cfgOf = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dlock-')); return { loopDir: path.join(root, 'loop'), codeDir: root, bots: [], outDir: root } }
const tool = { judge: () => ({ result: 'none' }), deploy: () => ({ result: 'current' }) }

test('alive: this process is, a pid that cannot exist is not, an old lock without a pid is trusted', () => {
  assert.strictEqual(alive(process.pid), true)
  assert.strictEqual(alive(2 ** 22 + 12345), false)
  assert.strictEqual(alive(undefined), true)
})

test('a fresh lock held by a live process blocks the deploy; the same lock from a dead process does not', async () => {
  const cfg = cfgOf(); fs.mkdirSync(cfg.loopDir, { recursive: true })
  const lock = path.join(cfg.loopDir, 'deploy.lock'), now = Date.now()
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: now - 60000 }))
  assert.deepStrictEqual(await runDeploy(cfg, { tool, now }), { ok: true, skipped: 'another deploy is running' })
  fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, at: now - 60000 }))
  const r = await runDeploy(cfg, { tool, now })
  assert.strictEqual(r.skipped, undefined); assert.strictEqual(r.ok, true)
  assert.ok(!fs.existsSync(lock), 'the lock is released after the run')
})
