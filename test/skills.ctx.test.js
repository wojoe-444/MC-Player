// S.withCtx: a skill called from another scheduler task runs under THAT task's context, not the (preempted) autopilot's.
const test = require('node:test')
const assert = require('node:assert')
const EE = require('events')
const makeSkills = require('../brain/autopilot/skills')

function skills() {
  const bot = new EE(); bot.version = '1.21.6'; bot.entity = { position: { x: 0, y: 64, z: 0 } }; bot.inventory = { items: () => [], slots: [] }
  bot.pathfinder = { setMovements() {}, setGoal() {} }; bot.clickWindow = async () => {}; bot.equip = async () => {}; bot.unequip = async () => {}; bot.registry = require('minecraft-data')('1.21.6')
  const S = makeSkills({ bot, api: { statePath: (f) => '/tmp/' + f, log() {}, say() {} }, log() {} })
  clearInterval(bot._resyncTimer); clearInterval(bot._hotbarTimer)          // makeSkills starts two timers that would keep the test process alive
  return S
}
const ctx = (aborted) => ({ aborted, checkpoint() { if (this.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e } }, sleep: () => Promise.resolve(), progress() {} })

test('S.check on an aborted autopilot context throws; under withCtx(ownContext) it does not, and the previous context comes back', async () => {
  const S = skills()
  S.ctx = ctx(true)                                              // the autopilot task, preempted by the husbandry task
  assert.throws(() => S.check(), /aborted/)
  const own = ctx(false)
  const seen = await S.withCtx(own, async () => { S.check(); return S.ctx })
  assert.strictEqual(seen, own)
  assert.strictEqual(S.ctx.aborted, true)                         // restored
  await S.withCtx(null, async () => { S.check(); assert.strictEqual(S.ctx, null) })   // no task context at all: no checkpoints
  await assert.rejects(S.withCtx(own, async () => { throw new Error('inner') }), /inner/)
  assert.strictEqual(S.ctx.aborted, true)                         // restored after a throw too
})

test('husbandry crafts under its own task context (source check)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'brain', 'husbandry', 'index.js'), 'utf8')
  assert.match(src, /taskCtx && S\.withCtx \? S\.withCtx\(taskCtx, \(\) => S\.craft\(item, n\)\)/)
  assert.match(src, /taskCtx = ctx; try/)
})
