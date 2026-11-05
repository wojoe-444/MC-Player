// Walter's never-stop rule (2026-10-26): a task that parks itself is retried with a delay; only his stop parks for good.
const test = require('node:test')
const assert = require('node:assert')
const { Scheduler } = require('../brain/scheduler')

test('a task that returns park is retried by the scheduler on its own', async () => {
  const s = new Scheduler({ idleAfterMs: 0 })
  let runs = 0
  s.submit({ name: 'x', priority: 10, async run() { runs++; if (runs === 1) return { status: 'park', reason: 'blocked' } } })
  await new Promise(r => setTimeout(r, 80))
  assert.strictEqual(runs, 1)
  const t = s.tasks.find(t => t.name === 'x')
  assert.ok(t && t.status === 'paused' && t.notBefore > Date.now())
  s.tasks.find(t => t.name === 'x').notBefore = 0   // skip the 20 s wait
  s.pump()
  await new Promise(r => setTimeout(r, 80))
  assert.strictEqual(runs, 2)
})
