const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')
const h = require('./build.helpers')
const { rig, waitFor, wait, PRIORITY, Scheduler, nameAt, assertClean } = h
const register = require('../brain/build')

// the world of the real site: flat grass at y70 around the configured centre, bot a few blocks away
const CX = -984, CZ = 2292
function fakeApi(over = {}, rigOpts = {}) {
  const r = rig({ ox: CX, oy: 71, oz: CZ, site: false, ...rigOpts })
  const commands = [], logs = []
  const scheduler = over.scheduler || new Scheduler({ graceMs: 10000, idleAfterMs: 0 })
  const api = {
    bot: r.bot, PRIORITY, scheduler, say: (t) => r.said.push(t), goals: r.bot.goals, tryGoto: r.bot.tryGoto, stopNav: () => {}, safehand: r.sh,
    canSee: r.canSee, ensureLineOfSight: r.ensureLineOfSight, ownerName: 'OGWO', dir: r.dir, statePath: (f) => path.join(r.dir, f), log: (tag, m) => logs.push(`${tag} ${m}`), now: Date.now,
    commands: { add: (c) => { commands.push(c); return true }, list: () => commands },
    ...over
  }
  return { api, r, commands, logs, scheduler }
}
const route = (commands, text) => { for (const c of commands) { const hit = typeof c.match === 'function' ? c.match('OGWO', text) : c.match.test(text); if (hit) { c.run('OGWO', text, text); return c.name } } return null }

test('module: registers without any state file, adds its commands, and never starts building by itself', async () => {
  const { api, r, commands, scheduler } = fakeApi()
  const mod = register(api)
  assert.strictEqual(mod.name, 'build'); assert.strictEqual(register.meta.name, 'build')
  assert.deepStrictEqual(commands.map(c => c.name).sort(), ['build-pause', 'build-resume', 'build-site', 'build-status', 'build-survey', 'build-tower'])
  assert.deepStrictEqual(commands.filter(c => c.risk === 'high').map(c => c.name).sort(), ['build-resume', 'build-site', 'build-tower'])
  mod.start(); await wait(60)
  assert.strictEqual(r.bot.placements.length, 0); assert.strictEqual(scheduler.status().running, null); assert.deepStrictEqual(scheduler.status().queue, [])
  assert.strictEqual(mod.status().running, false); assert.doesNotThrow(() => JSON.stringify(mod.status()))
  mod.stop()
})

test('module: needs() lists what the driver has to fetch or craft', () => {
  const { api } = fakeApi({}, { materials: {}, furnishing: false })
  const mod = register(api)
  assert.deepStrictEqual(mod.needs().map(m => `${m.count} x ${m.name}`), ['118 x stone_bricks', '36 x spruce_log', '52 x spruce_planks', '1 x spruce_door', '10 x ladder', '4 x torch', '18 x cobblestone', '1 x pickaxe'])
  const full = fakeApi()
  assert.deepStrictEqual(register(full.api).needs(), [])
})

test('phrases: the plain requests start/resume/ask, chatter about towers does not', () => {
  const P = register.phrases
  const go = (t) => P.isGo('OGWO', t)
  for (const t of ['build tower', 'build my tower', 'start the tower', 'build the tower', 'build a tower', 'lets build the tower', "let's build my tower", 'start building the tower', 'ok build my tower.', 'build me a lookout tower', 'begin the tower', 'build my own tower']) assert.ok(go(t), t)
  for (const t of ['what a nice tower', 'how do i build a tower?', 'should we build a tower', 'walter will build a tower', 'i built a tower yesterday', 'build a house', 'tower', 'the tower looks good', 'is the tower finished?', 'build a bridge', 'dont build the tower', 'build status', 'build survey', 'build site 10 20', 'when will you build the tower', 'someone should build a tower', 'build tower status']) assert.ok(!go(t), t)
  for (const t of ['resume building', 'continue the tower', 'continue building the tower', 'resume the tower', 'keep building', 'resume building the tower', 'carry on with the tower']) assert.ok(P.isResume('OGWO', t), t)
  for (const t of ['resume', 'continue', 'resume excavation', 'continue digging', 'keep digging', 'resume the furnace', 'how is the tower going']) assert.ok(!P.isResume('OGWO', t), t)
  for (const t of ['build status', 'how is the tower going', 'tower status', 'how is the building going', 'build progress', "how's the tower"]) assert.ok(P.isStatus('OGWO', t), t)
  for (const t of ['build survey', 'tower survey', 'survey the tower site', 'build site survey']) assert.ok(P.SURVEY.test(t), t)
  for (const t of ['build site -984 2292', 'build site 10, 20', 'build the tower site 5 6']) assert.ok(P.isSite('OGWO', t), t)
  for (const t of ['pause building', 'stop building the tower', 'stop building', "don't build the tower"]) assert.ok(P.isPause('OGWO', t), t)
  for (const t of ['stop', 'stop digging', 'pause excavation', 'build the tower']) assert.ok(!P.isPause('OGWO', t), t)
  // the phrases of other modules are not ours
  for (const t of ['excavate', 'resume excavation', 'harvest', 'sleep', 'craft stone pickaxe 4', 'build', 'come here', 'go to bed']) for (const f of [P.isGo, P.isResume, P.isStatus, P.isSite, P.isPause]) assert.ok(!f('OGWO', t), `${t}`)
})

test('routing: each phrase reaches exactly the right command', () => {
  const { api, commands } = fakeApi()
  register(api)
  const names = (t) => commands.filter(c => (typeof c.match === 'function' ? c.match('OGWO', t) : c.match.test(t))).map(c => c.name)
  assert.deepStrictEqual(names('build tower'), ['build-tower'])
  assert.deepStrictEqual(names('build site -984 2292'), ['build-site'])
  assert.deepStrictEqual(names('build survey'), ['build-survey'])
  assert.deepStrictEqual(names('how is the tower going'), ['build-status'])
  assert.deepStrictEqual(names('resume building'), ['build-resume'])
  assert.deepStrictEqual(names('pause building'), ['build-pause'])
  assert.deepStrictEqual(names('good morning'), [])
})

test('module: "build survey" only looks (no task, no blocks); "build status" before and after', () => {
  const { api, r, commands, scheduler } = fakeApi()
  const mod = register(api)
  assert.strictEqual(route(commands, 'build status'), 'build-status'); assert.match(r.said.pop(), /No tower yet/)
  assert.strictEqual(route(commands, 'build survey'), 'build-survey')
  assert.match(r.said.pop(), /^Best tower site: -984, 71, 2292 \(flat, 0 blocks from the centre\)\.$/)
  assert.strictEqual(mod.state.site, null); assert.strictEqual(scheduler.status().running, null); assert.strictEqual(r.bot.placements.length, 0)
  const empty = fakeApi({}, { materials: {} })
  const m2 = register(empty.api)
  // the real site is nowhere near this world: say why
  m2.state.centre = { x: 3000, z: 3000 }
  route(empty.commands, 'build survey'); assert.match(empty.r.said.pop(), /^Tower: no flat, dry, tree-free 7x7 patch within 14 blocks of 3000, 3000/)
})

test('module: "build tower" surveys, starts the task at OUTING priority, builds the whole thing; "build status" says finished; asking again does nothing', async () => {
  const { api, r, commands, scheduler } = fakeApi()
  const mod = register(api)
  assert.strictEqual(route(commands, 'build tower'), 'build-tower')
  assert.deepStrictEqual([mod.state.site.ox, mod.state.site.oy, mod.state.site.oz], [CX, 71, CZ])
  assert.strictEqual(scheduler.status().running.name, 'build'); assert.strictEqual(scheduler.status().running.priority, 45)
  await waitFor(() => mod.state.finished, 20000)
  const o = { ox: CX, oy: 71, oz: CZ }
  r.origin = o; Object.assign(r, { cx: CX + 2, cz: CZ + 2 }); r.state = mod.state; r.steps = () => mod.engine.steps()
  assertClean(r)
  assert.strictEqual(nameAt(r, CX + 2, 71, CZ + 4), 'spruce_door'); assert.strictEqual(mod.state.pillar, null)
  assert.strictEqual(route(commands, 'how is the tower going'), 'build-status'); assert.match(r.said.pop(), /^My tower is finished at -984, 71, 2292\.$/)
  const n = r.bot.placements.length
  route(commands, 'build the tower'); assert.match(r.said.pop(), /already built/)
  route(commands, 'build site 10 10'); assert.match(r.said.pop(), /already built|already started/)
  await wait(50); assert.strictEqual(r.bot.placements.length, n)
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(r.dir, 'build-state.json'), 'utf8')).finished, true)
  mod.stop()
})

test.skip('module: missing materials -> the task parks with one line; the driver supplies them; "resume building" carries on', async () => {
  const { api, r, commands, scheduler } = fakeApi({}, { materials: { ...h.MATERIALS, ladder: 0, spruce_planks: 0 } })
  const mod = register(api)
  route(commands, 'build tower')
  await waitFor(() => scheduler.status().parked.length === 1)
  assert.strictEqual(scheduler.status().parked[0].name, 'build')
  const need = mod.needs().map(m => `${m.count} x ${m.name}`)
  assert.strictEqual(r.said[r.said.length - 1], `Tower: need ${need.join(', ')}.`)
  assert.deepStrictEqual(need.map(n => n.split(' x ')[1]), ['spruce_planks', 'ladder'])
  assert.strictEqual(r.bot.placements.length, 0); assert.strictEqual(mod.state.active, false)
  r.bot.give('spruce_planks', 60); r.bot.give('ladder', 12)
  route(commands, 'resume building')
  await waitFor(() => mod.state.finished, 20000)
  assertClean(Object.assign(r, { origin: { ox: CX, oy: 71, oz: CZ } }))
})

test('module: "pause building" up on the pillar comes down and parks; "resume building" finishes', async () => {
  const { api, r, commands, scheduler } = fakeApi()
  const mod = register(api)
  let paused = false
  r.bot.onPlace = (n, rec) => { if (!paused && rec.name === 'stone_bricks' && rec.y === 71 + 6) { paused = true; route(commands, 'pause building') } }
  route(commands, 'build tower')
  await waitFor(() => scheduler.status().parked.length === 1)
  assert.strictEqual(r.bot.entity.position.y, 71); assert.strictEqual(mod.state.pillar, null); assert.strictEqual(mod.state.active, false)
  assert.ok(r.said.some(t => /pausing the tower/i.test(t)))
  route(commands, 'build status'); assert.match(r.said.pop(), /^Tower \(not running\): phase walls, course \d\/9, \d+\/\d+ blocks placed, site -984, 71, 2292\. Paused: stopped by Walter\. Say "resume building" to continue\.$/)
  route(commands, 'resume building')
  await waitFor(() => mod.state.finished, 20000)
  assertClean(Object.assign(r, { origin: { ox: CX, oy: 71, oz: CZ } }))
})

test('module: "build site <x> <z>" uses that centre; a started tower is never abandoned for another site', async () => {
  const { api, r, commands, scheduler } = fakeApi()
  const mod = register(api)
  // the site far away is not loaded here: the job walks there and looks again; here it just starts the task with that centre
  for (let x = 2950; x <= 3050; x++) for (let z = 2950; z <= 3050; z++) for (let y = 20; y <= 120; y += 1) r.bot.unloaded.add(`${x},${y},${z}`)
  route(commands, 'build site 3000 3000')
  assert.deepStrictEqual(mod.state.centre, { x: 3000, z: 3000 }); assert.strictEqual(mod.state.site, null)
  await waitFor(() => scheduler.status().queue.length + (scheduler.status().running ? 1 : 0) + scheduler.status().parked.length >= 1)
  scheduler.cancel('build'); await wait(30)
  // a tower already under way
  const second = fakeApi()
  const m2 = register(second.api)
  m2.state.site = { ox: CX, oy: 71, oz: CZ, low: [] }; m2.state.blocks = 5; m2.state.centre = { x: CX + 2, z: CZ + 2 }
  route(second.commands, 'build site 3000 3000'); assert.match(second.r.said.pop(), /already started a tower at -984, 71, 2292; I finish that one first/)
  assert.strictEqual(m2.state.site.ox, CX)
})

test('module: a restart in the middle: the new process takes the pillar down and, with Walter\'s go still in effect, finishes; without it, only comes down', async () => {
  for (const active of [true, false]) {
    const first = fakeApi()
    const m1 = register(first.api)
    let crashed = false
    first.r.bot.onPlaceAsync = async (n, rec) => { if (!crashed && rec.name === 'stone_bricks' && rec.y >= 71 + 6) { crashed = true; await new Promise(() => {}) } }
    route(first.commands, 'build tower')
    await waitFor(() => crashed)
    assert.ok(first.r.bot.entity.position.y >= 77)
    // the new process: same bot position, same world, same state directory, a fresh scheduler
    first.r.bot.onPlaceAsync = null
    const saved = JSON.parse(fs.readFileSync(path.join(first.r.dir, 'build-state.json'), 'utf8'))
    assert.ok(saved.pillar && saved.pillar.cells.length >= 6); assert.strictEqual(saved.active, true)
    if (!active) { saved.active = false; fs.writeFileSync(path.join(first.r.dir, 'build-state.json'), JSON.stringify(saved)) }
    const placedAtCrash = first.r.bot.placements.length
    const second = fakeApi({ bot: first.r.bot, safehand: first.r.sh, tryGoto: first.r.bot.tryGoto, goals: first.r.bot.goals, canSee: first.r.canSee, ensureLineOfSight: first.r.ensureLineOfSight, dir: first.r.dir, statePath: (f) => path.join(first.r.dir, f), say: (t) => first.r.said.push(t) })
    second.api.buildConfig = { autoResumeOnStart: true }   // the shipped default is off (a restart must never start the tower by itself); this test checks the opt-in path
    const m2 = register(second.api)
    m2.start()
    if (active) {
      await waitFor(() => m2.state.finished, 20000)
      assertClean(Object.assign(first.r, { origin: { ox: CX, oy: 71, oz: CZ } }))
      assert.strictEqual(first.r.bot.digLog[0].placedSoFar, placedAtCrash, 'the pillar came down first')
    } else {
      await waitFor(() => second.scheduler.status().running === null && second.scheduler.status().queue.length === 0 && first.r.bot.entity.position.y === 71 && !m2.state.pillar)
      await wait(100)
      assert.strictEqual(first.r.bot.placements.length, placedAtCrash, 'no go from Walter: nothing new is built'); assert.strictEqual(m2.state.finished, false)
    }
    m2.stop(); m1.stop()
  }
})

test('module: with the scheduler outdoor gate closed the tower is queued and held (not dropped, not started); it runs once the gate opens', async () => {
  const { api, r, commands, scheduler } = fakeApi()
  let open = false
  scheduler.setGate({ names: new Set(['build']), check: () => (open ? true : { ok: false, reason: 'daylight' }) })
  const mod = register(api)
  mod.start()
  route(commands, 'build tower'); await wait(150)
  const s = scheduler.status()
  assert.ok(s.queue.some(t => t.name === 'build') || s.parked.some(t => t.name === 'build'), 'the go is kept in the queue while the gate is closed')
  assert.strictEqual(s.running, null, 'not running at night')
  assert.strictEqual(r.bot.placements.length, 0, 'nothing placed while held')
  assert.strictEqual(mod.state.active, true, 'Walter\'s go stays in effect so a restart re-queues it')
  open = true; scheduler.gateRecheck()
  await waitFor(() => r.bot.placements.length > 5, 15000)
  assert.ok(r.bot.placements.length > 5, 'runs when the gate opens')
  scheduler.cancel('build', 'user-stop'); await wait(300)
})
