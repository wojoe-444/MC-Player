// Work order step-torches: the torches step idles through 30 autopilot stalls in 9 runs. When the bag has no coal, the step smelts charcoal from
// logs (brain/autopilot/plan.js, the torches step) through S.smelt (brain/autopilot/skills.js): the logs go into a furnace, and the step waits for
// the charcoal, about 10 s an item, while the bag does not change. The watchdog (brain/autopilot/watchdog.js) reads a bag that does not change for
// 45 s as a stall and kicks the step. Its WAIT_STEPS table gives a furnace wait a longer fuse (iron-smelt has one); torches had none, so a
// six-log smelt (60 s) raised a STALL alarm and a kick in the middle of its wait.
// The test runs the real torches step and the real watchdog on a made-up bag. Time is a fake clock: the furnace takes its time by moving the clock
// on, and the watchdog's timers run as it passes.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'), os = require('os'), path = require('path')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const makeGoals = require('../brain/autopilot/goals')
const plan = require('../brain/autopilot/plan')
const watchdog = require('../brain/autopilot/watchdog')

const matches = (re, name) => (typeof re === 'string' ? re === name : re.test(name))

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-torches-'))
  const prevReg = process.env.BOT_REGISTRY
  process.env.BOT_REGISTRY = path.join(dir, 'registry.json')            // no shared registry here
  // the bag: what the watchdog's inventory signature and the step's counts both read. Fourteen oak logs and nothing else.
  const bag = [{ name: 'oak_log', count: 14 }]
  const items = () => bag.filter(i => i.count > 0)
  const count = (re) => items().filter(i => matches(re, i.name)).reduce((n, i) => n + i.count, 0)
  const take = (name, n) => { bag.find(i => i.name === name).count -= n }
  const give = (name, n) => { const e = bag.find(i => i.name === name); if (e) e.count += n; else bag.push({ name, count: n }) }

  // fake clock: time moves only when the furnace (or a test) advances it; the timers the watchdog starts run as it passes
  const clock = { now: 1794000000000 }
  const timers = []
  const advance = (ms) => {
    const end = clock.now + ms
    for (;;) {
      let due = null
      for (const t of timers) if (!t.dead && t.next <= end && (!due || t.next < due.next)) due = t
      if (!due) break
      clock.now = due.next
      if (due.repeat) due.next += due.ms; else due.dead = true
      try { due.fn() } catch { /* a timer that throws must not stop the clock */ }
    }
    clock.now = end
  }
  const later = (fn, ms, repeat) => { const t = { fn, ms, repeat, next: clock.now + ms, dead: false, unref() { return this }, ref() { return this } }; timers.push(t); return t }

  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(0.5, 64, 0.5) }
  bot.time = { day: 3, timeOfDay: 2000 }
  bot.health = 20; bot.food = 20; bot.isSleeping = false; bot.username = 'fixer-test'
  bot.inventory = { items, emptySlotCount: () => 20, slots: [] }
  bot.registry = { blocksArray: [], blocksByName: {}, blocksByStateId: {}, itemsByName: {} }
  bot.world = {}; bot.blockAt = () => null; bot.findBlock = () => null; bot.findBlocks = () => []

  const base = {
    bot, goals: { GoalNear: class {}, GoalXZ: class {}, GoalBlock: class {}, GoalLookAtBlock: class {} },
    v: (x, y, z) => new Vec3(x, y, z),
    items, count, logs: () => count(/_log$/), has: (re) => count(re) > 0,
    furnaceNear: () => ({}), isNight: () => false, skyVisible: () => true, dist: () => 0, toolTier: () => 3,
    check() {}, progress() {}, say() {}, isAbort: () => false, stepDeadline: 0,
    wait: async (ms) => advance(ms),
    // the furnace, as S.smelt waits for it: the logs go in (the bag changes then), one charcoal comes out every 10 s, and the bag stands
    // still until the output is taken out
    smelt: async (input, n) => {
      n = Math.min(n, count(input)); if (n <= 0) return 0
      take(input, n)
      advance(10000 * n)
      give('charcoal', n)
      return n
    },
    // one torch batch: a charcoal and a stick make four torches (the stick is not modelled; the step only counts torches)
    craft: async (name, n) => { take('charcoal', 1); give(name, 4); advance(500); return count(name) >= n },
  }
  const S = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => 0) })
  const scheduler = { status: () => ({ running: { name: 'autopilot' }, queue: [], parked: [] }), cancel() {}, submit() {}, resumeParked() {} }
  const api = { bot, scheduler, reflexes: null, statePath: (f) => path.join(dir, f), profile: { get: () => ({ role: 'hillclimber', steps: null }) } }
  // goals and the plan are built with the real timers (the plan starts a 15 s timer that writes a shared file: not run here)
  const G = makeGoals(S, {}, api, () => {})
  G.state.home = [0, 64, 0]
  plan(G, S, {}, api, () => {})
  const step = G.steps.find(s => s.id === 'torches')

  // the fake timers from here on: the watchdog's own samples and alarm checks
  const real = { now: Date.now, si: global.setInterval, st: global.setTimeout, ci: global.clearInterval, ct: global.clearTimeout }
  const alarms = []
  const log = (tag, msg) => { if (tag === 'ALARM') alarms.push(String(msg)) }
  Date.now = () => clock.now
  global.setInterval = (fn, ms) => later(fn, ms, true)
  global.setTimeout = (fn, ms) => later(fn, ms, false)
  global.clearInterval = global.clearTimeout = (t) => { if (t) t.dead = true }
  const W = watchdog({ G, S, enabled: true, ensureTask() {} }, api, log)

  return {
    G, step, alarms, count, advance,
    dispose: () => {
      try { W.dispose() } catch {}
      Date.now = real.now; global.setInterval = real.si; global.setTimeout = real.st; global.clearInterval = real.ci; global.clearTimeout = real.ct
      try { G.dispose && G.dispose() } catch {}
      if (prevReg === undefined) delete process.env.BOT_REGISTRY; else process.env.BOT_REGISTRY = prevReg
    },
  }
}

test('a six-log charcoal smelt at the torches step is a furnace wait: no stall is raised while the bag waits on the furnace', async () => {
  const r = rig()
  try {
    assert.ok(r.step, 'the torches step exists')
    r.G.lastStep = 'torches'                                 // what goals.js sets before it runs a step
    const ok = await r.step.run()
    assert.equal(ok, true, 'the torches step should make torches')
    assert.ok(r.count('torch') >= 16, `the step made ${r.count('torch')} torches`)
    assert.deepEqual(r.alarms, [], `the furnace wait raised: ${r.alarms.join(' | ')}`)
  } finally { r.dispose() }
})

test('torches standing still with nothing to wait for is still raised as a stall, after the longer fuse', () => {
  const r = rig()
  try {
    r.G.lastStep = 'torches'
    r.advance(170000)                                        // nothing in the bag changes for almost three minutes
    assert.ok(r.alarms.some(a => /STALL/.test(a) && /autopilot-stalled:torches/.test(a)), `no stall after 170 s: ${r.alarms.join(' | ') || 'no alarm'}`)
  } finally { r.dispose() }
})
