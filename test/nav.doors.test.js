// brain/nav: doors, gates, trapdoors (open on the path, close behind) against the real pathfinder + physics.
const test = require('node:test')
const assert = require('node:assert')
const { rig, goals } = require('./nav.helpers')

const G = (x, y, z) => new goals.GoalBlock(x, y, z)
// a wall along x=5 (z -5..20) with a 1x2 gap at z=0
const wall = (s, gapZ = 0) => { s.floor(-5, -5, 30, 20, 63); s.wallX(-5, 20, 5, 64, 66); s.fill(5, 64, gapZ, 5, 66, gapZ, 'air') }
const doorOpen = (r, x = 5, y = 64, z = 0) => r.sim.blockProps(x, y, z).open

test('closed door east->west and west->east: opened on the way, closed behind, bot never has to stop or turn around', async () => {
  for (const [start, goal] of [[[0.5, 64, 0.5], [10, 64, 0]], [[10.5, 64, 0.5], [0, 64, 0]]]) {
    const r = await rig({ pos: start }, s => { wall(s); s.door(5, 64, 0, { facing: 'east' }) })
    const res = await r.go(G(...goal))
    assert.ok(res.ok, JSON.stringify(res))
    assert.strictEqual(doorOpen(r), false, 'door closed again')
    assert.deepStrictEqual(r.sim.interactions.map(i => i.name), ['oak_door', 'oak_door'], 'exactly one open and one close click')
    assert.strictEqual(r.sim.lookCalls, 0, 'the clicks did not turn the bot toward the door (that would fight the pathfinder)')
    assert.ok(res.secs < 3, `took ${res.secs}s`)
    assert.strictEqual(r.nav.status().doors.failed, 0)
    r.close()
  }
})

test('door in a wall along z (other orientation)', async () => {
  const r = await rig({}, s => { s.floor(-5, -5, 30, 20, 63); s.wallZ(-5, 20, 5, 64, 66); s.fill(0, 64, 5, 0, 66, 5, 'air'); s.door(0, 64, 5, { facing: 'south' }) })
  const res = await r.go(G(0, 64, 10))
  assert.ok(res.ok, JSON.stringify(res))
  assert.strictEqual(r.sim.blockProps(0, 64, 5).open, false)
  r.close()
})

test('fence gates, a spruce door and a copper door: all hand-operable', async () => {
  for (const [kind, name] of [['gate', 'oak_fence_gate'], ['gate', 'crimson_fence_gate'], ['door', 'spruce_door'], ['door', 'copper_door']]) {
    const r = await rig({}, s => { wall(s); if (kind === 'gate') s.gate(5, 64, 0, { facing: 'east', name }); else s.door(5, 64, 0, { facing: 'east', name }) })
    const res = await r.go(G(10, 64, 0))
    assert.ok(res.ok, `${name}: ${JSON.stringify(res)}`)
    assert.strictEqual(doorOpen(r), false, `${name} closed behind`)
    r.close()
  }
})

test('a door that was already open is left open', async () => {
  const r = await rig({}, s => { wall(s); s.door(5, 64, 0, { facing: 'east', open: true }) })
  const res = await r.go(G(10, 64, 0))
  assert.ok(res.ok)
  assert.strictEqual(doorOpen(r), true)
  assert.strictEqual(r.sim.interactions.length, 0)
  r.close()
})

test('doors next to the route are not touched', async () => {
  const r = await rig({}, s => { s.floor(-5, -5, 30, 20, 63); s.wallZ(-5, 20, 2, 64, 66); s.fill(8, 64, 2, 8, 66, 2, 'air'); s.door(8, 64, 2, { facing: 'south' }) })
  const res = await r.go(G(15, 64, 0))                         // walks along the wall, 2 blocks from the door
  assert.ok(res.ok)
  assert.strictEqual(r.sim.interactions.length, 0, 'no clicks')
  r.close()
})

test('a door is not closed while the bot stands in the doorway, only after it has moved clear', async () => {
  const r = await rig({}, s => { wall(s); s.door(5, 64, 0, { facing: 'east' }) })
  const closedOnBot = r.track(() => { const p = r.sim.at(); return p.x > 4.75 && p.x < 6.25 && Math.abs(p.z - 0.5) < 0.3 && !r.sim.blockProps(5, 64, 0).open })
  const a = await r.go(G(5, 64, 0), { after: 80 })              // stop IN the doorway
  assert.ok(a.ok, JSON.stringify(a))
  assert.strictEqual(doorOpen(r), true, 'still open while we stand in it')
  const b = await r.go(G(10, 64, 0), { after: 80 })
  assert.ok(b.ok)
  assert.strictEqual(doorOpen(r), false, 'closed once clear of it')
  assert.ok(!closedOnBot.some(Boolean), 'a closed door never appeared on top of the bot')
  r.close()
})

test('stops short of a door and idles: it is shut again (we did not go through)', async () => {
  const r = await rig({}, s => { wall(s); s.door(5, 64, 0, { facing: 'east' }) })
  const a = await r.go(G(3, 64, 0), { after: 0 })
  assert.ok(a.ok)
  await r.sim.run(null, 120)
  assert.strictEqual(doorOpen(r), false)
  r.close()
})

test('a door the server will not toggle: tried 3 times, then planned around via the other door', async () => {
  const r = await rig({}, s => { wall(s); s.fill(5, 64, 8, 5, 66, 8, 'air'); s.door(5, 64, 0, { facing: 'east' }); s.door(5, 64, 8, { facing: 'east' }); s.locked.add('5,64,0') })
  const res = await r.go(G(10, 64, 0), { maxTicks: 900 })
  assert.ok(res.ok, JSON.stringify(res) + '\n' + r.logs.join('\n'))
  assert.ok(r.logs.some(l => /will not open/.test(l)))
  assert.strictEqual(r.nav.status().doors.failed, 1)
  assert.strictEqual(r.sim.blockProps(5, 64, 0).open, false)
  r.close()
})

test('the only door is locked: "no path", not an endless loop of clicking', async () => {
  const r = await rig({}, s => { wall(s); s.door(5, 64, 0, { facing: 'east' }); s.locked.add('5,64,0') })
  const res = await r.go(G(10, 64, 0), { maxTicks: 600 })
  assert.strictEqual(res.ok, false)
  assert.match(res.err, /no path/)
  assert.ok(r.sim.interactions.length <= 4, `${r.sim.interactions.length} clicks`)
  r.close()
})

test('iron doors need redstone: they are walls, not doors', async () => {
  const r = await rig({}, s => { wall(s); s.door(5, 64, 0, { facing: 'east', name: 'iron_door' }) })
  const res = await r.go(G(10, 64, 0), { maxTicks: 300 })
  assert.strictEqual(res.ok, false)
  assert.strictEqual(r.sim.interactions.length, 0)
  r.close()
})

test('double door (two doors side by side) followed by a gate', async () => {
  const r = await rig({}, s => {
    s.floor(-5, -5, 30, 20, 63); s.wallX(-5, 20, 5, 64, 66); s.fill(5, 64, 0, 5, 66, 1, 'air')
    s.door(5, 64, 0, { facing: 'east', hinge: 'left' }); s.door(5, 64, 1, { facing: 'east', hinge: 'right' })
    s.wallX(-5, 20, 8, 64, 66); s.fill(8, 64, 0, 8, 66, 0, 'air'); s.gate(8, 64, 0, { facing: 'east' })
  })
  const res = await r.go(G(12, 64, 0), { maxTicks: 600 })
  assert.ok(res.ok, JSON.stringify(res))
  assert.strictEqual(r.sim.blockProps(5, 64, 0).open, false)
  assert.strictEqual(r.sim.blockProps(8, 64, 0).open, false)
  r.close()
})

test('door moves stay on the door axis: the route crosses the wall straight through the doorway, never diagonally', async () => {
  const r = await rig({ pos: [2.5, 64, 6.5] }, s => { wall(s); s.door(5, 64, 0, { facing: 'east' }) })
  const crossing = r.track(() => { const p = r.sim.at(); return p.x > 4.9 && p.x < 5.1 ? p.z : null })
  const res = await r.go(G(9, 64, -5))
  assert.ok(res.ok, JSON.stringify(res))
  const zs = crossing.filter(z => z !== null)
  assert.ok(zs.length && zs.every(z => z > 0.0 && z < 1.0), `crossed the wall plane at z=${zs}`)
  r.close()
})

test('bump fallback: a door shut after the route was planned is opened when the bot walks into it', async () => {
  const r = await rig({}, s => { wall(s); s.door(5, 64, 0, { facing: 'east', open: true }) })
  let res = null
  r.nav.goto(G(10, 64, 0), { ms: 30000 }).then(x => { res = x })
  await r.sim.run(null, 12)
  // somebody closes it and the bot is not told (no blockUpdate): the planned route still goes through it
  r.sim.set(5, 64, 0, 'oak_door', { facing: 'east', half: 'lower', hinge: 'left', open: false, powered: false })
  r.sim.set(5, 65, 0, 'oak_door', { facing: 'east', half: 'upper', hinge: 'left', open: false, powered: false })
  await r.sim.run(() => res, 400)
  assert.ok(res && res.ok, JSON.stringify(res) + r.logs.join('\n'))
  r.close()
})

test('doors opened by us survive a restart: the list is persisted and the door is closed when the bot is next to it', async () => {
  const saved = []
  const r = await rig({}, s => { wall(s); s.door(5, 64, 0, { facing: 'east' }) }, { persist: (p) => saved.push(p) })
  const a = await r.go(G(5, 64, 0), { after: 0 })
  assert.ok(a.ok)
  assert.strictEqual(saved.at(-1).doors.length, 1, 'open door recorded')
  const snapshot = JSON.parse(JSON.stringify(saved.at(-1).doors))
  r.close()
  const r2 = await rig({ pos: [3.5, 64, 0.5] }, s => { wall(s); s.door(5, 64, 0, { facing: 'east', open: true }) }, { saved: { doors: snapshot } })
  assert.strictEqual(doorOpen(r2), true)
  await r2.sim.run(null, 60)
  assert.strictEqual(doorOpen(r2), false, 'the orphan was closed')
  r2.close()
})

test('bot.lookAt is restored after a click and the bot keeps its heading', async () => {
  const r = await rig({}, s => { wall(s); s.door(5, 64, 0, { facing: 'east' }) })
  const orig = r.bot.lookAt
  const res = await r.go(G(10, 64, 0))
  assert.ok(res.ok)
  assert.strictEqual(r.bot.lookAt, orig)
  r.close()
})

test('tidy(): a door left open (bot was out of reach when it should have closed) is walked back to and closed', async () => {
  const r = await rig({}, s => { wall(s); s.door(5, 64, 0, { facing: 'east' }) })
  const a = await r.go(G(5, 64, 0), { after: 0 })
  assert.ok(a.ok)
  r.nav.doors.cfg.closeMax = 0.1                                // pretend the closing window was missed
  const b = await r.go(G(14, 64, 0), { after: 30 })
  assert.ok(b.ok)
  assert.strictEqual(doorOpen(r), true, 'left open')
  r.nav.doors.cfg.closeMax = 4.0
  const left = await (async () => { let out; const p = r.nav.tidy().then(x => { out = x }); await r.sim.run(() => out !== undefined, 600); return out })()
  assert.strictEqual(left, 0)
  assert.strictEqual(doorOpen(r), false)
  r.close()
})

// ---------------------------------------------------------------- line of sight (INTERFACE.md section 10)
test('LOS rule: a door is only clicked while canSee(door) is true; no view, no click', async () => {
  let seeing = false
  const clicksWhileBlind = []
  const r = await rig({}, s => { wall(s); s.door(5, 64, 0, { facing: 'east' }) }, { los: { canSee: () => seeing, ensure: async () => seeing } })
  r.bot.on('physicsTick', () => { if (!seeing && r.sim.interactions.length) clicksWhileBlind.push(r.sim.ticks) })
  let res = null
  r.nav.goto(G(10, 64, 0), { ms: 20000 }).then(x => { res = x })
  await r.sim.run(() => res, 400)
  assert.strictEqual(r.sim.interactions.length, 0, 'no click without a clear view')
  assert.ok(r.nav.status().doors.losSkips > 0)
  assert.ok(!res || !res.ok, 'bot cannot get through a door it may not click')
  seeing = true                                                   // the view opens up
  r.nav.stop('retry')
  const again = await r.go(G(10, 64, 0), { maxTicks: 600 })
  assert.ok(again.ok, JSON.stringify(again))
  assert.deepStrictEqual(r.sim.interactions.map(i => i.name), ['oak_door', 'oak_door'])
  r.close()
})

test('LOS rule with the real brain/los.js: a clear doorway is visible, a pillar in front of the door is not', async () => {
  const { Vec3 } = require('vec3')
  const losLib = require('../brain/los')
  const r = await rig({ pos: [2.5, 64, 0.5] }, s => { wall(s); s.door(5, 64, 0, { facing: 'east' }) })
  const door = r.bot.blockAt(new Vec3(5, 64, 0))
  assert.strictEqual(losLib.canSee(r.bot, door), true)
  r.sim.fill(4, 64, 0, 4, 67, 0, 'stone')                                  // someone built a pillar right in front of it
  assert.strictEqual(losLib.canSee(r.bot, r.bot.blockAt(new Vec3(5, 64, 0))), false)
  r.close()
})
