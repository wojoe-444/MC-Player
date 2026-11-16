// Work order finding-ozo-mobfarm-overdue: a mob farm is judged "overdue" for making no kills, and the verdict cannot say whether any mob ever reached
// its kill pocket. "None fell in" and "they fell in and were not killed" read the same, so the next work order cannot tell which one it is.
// Expected: the kill routine records that mobs were seen in the pocket (how many at once, when), and the outcome verdict says so.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'), os = require('os'), path = require('path')
const { Vec3 } = require('vec3')
const E = require('../brain/outcome/expect')
const H = 3600000

test('an overdue farm says whether any mob was recorded in its kill pocket', () => {
  const none = E.evaluate({ id: 'mobfarm-1', kind: 'mobfarm', liveMs: 8 * H, got: 0, seen: null }, { difficulty: 'easy' })
  assert.equal(none.state, 'overdue')
  assert.match(none.why.join(' '), /no mob recorded in its kill pocket/, 'the verdict does not say that no mob was recorded: ' + none.why.join(' | '))
  const t = Date.parse('2026-11-16T01:02:00Z')
  const some = E.evaluate({ id: 'mobfarm-1', kind: 'mobfarm', liveMs: 8 * H, got: 0, seen: { first: t - H, last: t, max: 3 } }, { difficulty: 'easy' })
  assert.equal(some.state, 'overdue')
  assert.match(some.why.join(' '), /mobs were in its kill pocket \(up to 3 at once, last 2026-11-16 01:02\), so they reached it and none was killed/, 'the verdict does not say mobs reached the pocket: ' + some.why.join(' | '))
  assert.match(some.why[0], /no kills/, 'the first reason must still say there were no kills')
})

test('the kill routine records the mobs it sees in the kill pocket, when, and how many at once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ozo-mobfarm-'))
  fs.writeFileSync(path.join(dir, 'mobfarm.json'), JSON.stringify({ builder: 'mobfarmbuild', killSpot: [5, 9, 9], killBox: { x0: 5, x1: 5, y0: 10, y1: 11, z0: 5, z1: 5 }, chests: [[5, 9, 8]] }))
  const bot = { username: 'T', health: 20, isSleeping: false, entity: { position: new Vec3(5.5, 9, 9.5) }, entities: {} }
  const S = { bot, goals: {}, v: (x, y, z) => new Vec3(x, y, z), items: () => [], count: () => 0, check() {} }
  const G = { state: {}, note() {}, save() {} }
  const step = require('../brain/autopilot/mobfarm')(G, S, {}, { statePath: (f) => path.join(dir, f) }, () => {})
  assert.equal(step.need(), false, 'an empty pocket: nothing to do')
  assert.equal(G.state.mobSeen, undefined, 'an empty pocket records nothing')
  bot.entities = { 7: { id: 7, name: 'zombie', position: new Vec3(5.5, 10, 5.5), height: 1.95 }, 8: { id: 8, name: 'skeleton', position: new Vec3(5.5, 10, 5.5), height: 1.99 } }
  assert.equal(step.need(), true, 'two mobs in the pocket: the kill pass should run')
  assert.ok(G.state.mobSeen, 'the kill routine did not record that mobs were in the pocket')
  assert.equal(G.state.mobSeen.max, 2, 'the most mobs seen at once')
  assert.ok(G.state.mobSeen.first > 0 && G.state.mobSeen.last >= G.state.mobSeen.first, 'the first and last sightings are not recorded')
})

test('the outcome check carries the pocket record into its verdict and the state file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ozo-outcome-'))
  const registry = path.join(dir, 'registry.json')
  fs.writeFileSync(registry, JSON.stringify({ worlds: { w: { rooms: [{ id: 'mobfarm-1', type: 'mobfarm', box: { x0: 0, x1: 20, y0: 60, y1: 80, z0: 0, z1: 20 } }] } } }))
  let t = Date.parse('2026-11-16T00:00:00Z')
  const seenAt = t + 60000
  const state = { mobFarm: { kills: 0 }, mobSeen: { first: seenAt, last: seenAt, max: 2 } }
  const bot = { entity: { position: { x: 10, y: 70, z: 10 } }, _ap: { G: { state } } }
  const register = require('../brain/outcome')
  const o = register({ bot, now: () => t, statePath: (f) => path.join(dir, f), registryFile: registry, log() {} })
  o._tick()
  for (let i = 0; i < 20; i++) { t += 10 * 60000; o._tick() }        // 3 h 20 min in range, past the 3 h grace, no kills
  const v = JSON.parse(fs.readFileSync(path.join(dir, 'outcome.json'), 'utf8')).builds['mobfarm-1']
  assert.equal(v.state, 'overdue')
  assert.match(v.why.join(' '), /mobs were in its kill pocket \(up to 2 at once/, 'the outcome state does not carry the pocket record: ' + v.why.join(' | '))
})
