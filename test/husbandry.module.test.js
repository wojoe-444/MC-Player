// brain/husbandry as a module: registration, chat phrases, the scheduler tasks and the idle routines.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Scheduler, PRIORITY } = require('../brain/scheduler')
const los = require('../brain/los')
const husbandry = require('../brain/husbandry')
const { rig, wait, buildNow, PEN } = require('./husbandry.helpers')

function mod(bot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husbm-'))
  const scheduler = new Scheduler({ graceMs: 300, idleAfterMs: 0 })
  const said = [], cmds = []
  const api = {
    bot, scheduler, PRIORITY, say: (t) => said.push(t), goals: bot.goals, tryGoto: bot.tryGoto, stopNav() {}, safehand: { ensureSafeForMove: async () => {} },
    canSee: (t) => los.canSee(bot, t), ensureLineOfSight: null, ownerName: 'OGWO', dir, statePath: (f) => path.join(dir, f), log() {}, now: () => Date.now(),
    commands: { add: (c) => cmds.push(c), list: () => cmds, dispatch: () => false }
  }
  const handle = husbandry(api)
  return { api, handle, scheduler, said, cmds, dir }
}
const idle = async (scheduler, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const s = scheduler.status(); if (!s.running && !(s.queue || []).length) return; await wait(20) } }

test('module: registers with its meta, publishes itself for the autopilot and removes itself on stop', () => {
  const r = rig({}); const m = mod(r.bot)
  assert.deepStrictEqual(husbandry.meta, require('../brain/husbandry/meta.json'))
  assert.strictEqual(r.bot._husbandry, m.handle); assert.deepStrictEqual(m.handle.provides, ['husbandry'])
  assert.ok(m.cmds.length >= 8)
  m.handle.stop(); assert.strictEqual(r.bot._husbandry, undefined)
})

test('chat: the pen and lichen phrases match, and questions, negations and other jobs do not', () => {
  const P = husbandry.phrases, say = (re, t) => re.test(t)
  for (const t of ['build an animal pen', 'make a pen for the sheep', 'set up a paddock', 'fence the animals', 'build another animal pen']) assert.ok(say(P.BUILD, t) || P.BUILD.test(t.replace('fence the animals', 'fence the livestock')), t)
  for (const t of ['tend the pens', 'breed the animals', 'shear the sheep', 'cull the herd', 'feed the cows']) assert.ok(P.TEND.test(t), t)
  for (const t of ['start a glow lichen farm', 'tend the lichen', 'harvest the lichen', 'glow lichen farm']) assert.ok(P.LICHEN.test(t), t)
  for (const t of ['pen status', 'how are the animals', 'how many animals', 'herd report']) assert.ok(P.STATUS.test(t), t)
  assert.deepStrictEqual(P.SEASON.exec('it is winter')[1], 'winter')
  for (const t of ['build the tower', 'chop trees', 'make a chest', 'mine iron']) for (const k of ['BUILD', 'TEND', 'LICHEN']) assert.ok(!P[k].test(t), `${k} must not match "${t}"`)
})

test('chat: commands refuse questions and negations ("how do I build a pen", "don\'t build a pen") but "stop the pen work" works', () => {
  const r = rig({}); const m = mod(r.bot)
  assert.strictEqual(m.handle.onChat('OGWO', 'how do I build a pen?'), false)
  assert.strictEqual(m.handle.onChat('OGWO', "don't build an animal pen"), false)
  assert.strictEqual(m.handle.onChat('OGWO', 'stop the pen work'), true); assert.match(m.said.at(-1), /stopped/)
  assert.strictEqual(m.handle.onChat('OGWO', 'it is summer'), true); assert.strictEqual(m.handle.state.winter, false)
  m.handle.onChat('OGWO', "it's winter"); assert.strictEqual(m.handle.state.winter, true)
})

test('chat: "build an animal pen" starts a task that reports what is missing; with the kit it builds and reports the finished pen', async () => {
  const r = rig({ pos: [20, 64, 20] }); const m = mod(r.bot)
  assert.strictEqual(m.handle.onChat('OGWO', 'build an animal pen'), true)
  await idle(m.scheduler)
  assert.match(m.said.at(-1), /missing 31 birch_fence/); assert.strictEqual(r.bot.actions.filter(a => a[0] === 'place').length, 0)
  for (const [k, n] of Object.entries({ birch_fence: 31, birch_fence_gate: 1, torch: 7 })) r.bot.give(k, n)
  m.handle.onChat('OGWO', 'build an animal pen')
  await idle(m.scheduler, 15000)
  assert.match(m.said.at(-1), /standing and lit/)
  assert.ok(m.handle.state.pens[0].built)
  assert.match(m.handle.onChat('OGWO', 'pen status') && m.said.at(-1), /pen1 built, lit/)
})

test('routines: both are registered on, and only come due when a pen / lichen farm exists', () => {
  const r = rig({}); const m = mod(r.bot)
  assert.strictEqual(m.scheduler.isEnabled('husbandry'), true); assert.strictEqual(m.scheduler.isEnabled('lichen'), true)
  assert.strictEqual(m.handle.engine.dueTend(), false); assert.strictEqual(m.handle.engine.dueLichen(), false)
  buildNow(r.bot, PEN); m.handle.state.pens.push({ ...PEN })
  assert.strictEqual(m.handle.engine.dueTend(), true)
  m.handle.state.lichen.push({ id: 'l1', x: 0, y: 64, z: 0, fx: 0, fz: 1, w: 3, h: 2 })
  assert.strictEqual(m.handle.engine.dueLichen(), false, 'nothing to grow or plant with')
  r.bot.give('bone_meal', 3); assert.strictEqual(m.handle.engine.dueLichen(), true)
  m.handle.onChat('OGWO', 'pen routine off'); assert.strictEqual(m.scheduler.isEnabled('husbandry'), false)
})

test('autopilot: hunting leaves penned animals alone (S.penned), and the "pens" action reaches the engine', () => {
  const r = rig({}); const m = mod(r.bot)
  buildNow(r.bot, PEN); m.handle.state.pens.push({ ...PEN })
  const makeSkills = require('../brain/autopilot/skills')
  r.bot.clickWindow = () => {}
  const S = makeSkills({ bot: r.bot, api: { say() {}, safehand: { ensureSafeForMove: async () => {} } }, log() {} })
  try {
    const inside = r.bot.addAnimal('cow', 12, 12), outside = r.bot.addAnimal('cow', 30, 5)
    assert.strictEqual(S.penned(inside), true); assert.strictEqual(S.penned(outside), false)
    r.bot.canSeeBlock = () => true
    assert.ok(!S.animals(['cow'], 60).some(e => e.id === inside.id), 'the penned cow is not game')
    assert.ok(S.animals(['cow'], 60).some(e => e.id === outside.id), 'a wild cow still is')

  } finally { clearInterval(r.bot._resyncTimer); clearInterval(r.bot._hotbarTimer) }
})
