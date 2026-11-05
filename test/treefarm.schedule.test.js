// brain/treefarm: the idle routine runs about every 45 minutes (Walter); follow-up visits never chop and never restart that clock; manual commands never wait.
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { rig, growTree, fakeCtx } = require('./treefarm.helpers')
const base = require('../brain/treefarm/config.json')

const SITE = { name: 'tree farm', x: 0, y: 64, z: 20, radius: 30 }
const logsLeft = (r, logs) => logs.filter(p => /_log$/.test(r.bot.blockAt(p).name)).length

test('the configured interval is 45 minutes', () => { assert.strictEqual(base.intervalMinutes, 45) })

test('idle regular runs: one now, the next only after 45 minutes; decay visits in between are follow-ups that chop nothing and do not restart the clock', async () => {
  let t = 1e12
  const r = rig({ sites: [SITE], now: () => t, inv: { iron_axe: 1, dirt: 20, oak_sapling: 4 }, config: { clearLeaves: false } }); const { bot } = r
  const a = growTree(bot, { x: 2, z: 20, h: 5 }), b = growTree(bot, { x: -6, z: 24, h: 5 })
  assert.strictEqual(r.engine.dueKind(), 'trees', 'never ran: due')
  await r.engine.run(fakeCtx(), { manual: false, count: 1 })
  assert.strictEqual(logsLeft(r, a) + logsLeft(r, b), 5, 'one tree cut in the regular run')
  const clock = r.state.lastRun
  assert.strictEqual(r.engine.dueKind(), null, 'nothing due right after')
  t += 3 * 60000
  assert.strictEqual(r.engine.dueKind(), 'followup', 'the decay drops are worth a visit after 2 minutes')
  r.said.length = 0
  await r.engine.run(fakeCtx(), { manual: false, followUp: true })
  assert.strictEqual(logsLeft(r, a) + logsLeft(r, b), 5, 'the follow-up did not chop the second tree')
  assert.strictEqual(r.state.lastRun, clock, 'and did not restart the 45-minute clock')
  t = clock + 44 * 60000
  assert.notStrictEqual(r.engine.dueKind(), 'trees', 'not at 44 minutes')
  t = clock + 46 * 60000
  assert.strictEqual(r.engine.dueKind(), 'trees', 'at 46 minutes')
  await r.engine.run(fakeCtx(), { manual: false })
  assert.strictEqual(logsLeft(r, a) + logsLeft(r, b), 0, 'the next regular run took the other tree')
  r.stop()
})

test('manual commands do not wait for the interval, and a manual run restarts the clock', async () => {
  let t = 1e12
  const r = rig({ sites: [SITE], now: () => t, inv: { iron_axe: 1, oak_sapling: 4 }, config: { clearLeaves: false } }); const { bot } = r
  const a = growTree(bot, { x: 2, z: 20, h: 5 })
  r.state.lastRun = t - 60000                                           // an idle run a minute ago
  assert.strictEqual(r.engine.dueKind(), null)
  await r.engine.run(fakeCtx(), { manual: true })
  assert.strictEqual(logsLeft(r, a), 0, 'chopped at once')
  assert.strictEqual(r.state.lastRun, t)
  r.stop()
})

test('a leftover pillar or work-site chest is a follow-up, and the routine task passes that on', async () => {
  const r = rig({ sites: [SITE] }); const { bot } = r
  r.state.lastRun = Date.now()
  r.state.worksite = { x: 6, y: 64, z: 6, ledger: {}, at: 1 }
  assert.strictEqual(r.engine.dueKind(), 'followup')
  r.state.worksite = null; r.state.pillar = { x: 0, y: 64, z: 0, placed: [] }
  assert.strictEqual(r.engine.dueKind(), 'followup')
  r.stop()
})
