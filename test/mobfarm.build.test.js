// The mob farm build routine's guards (brain/autopilot/mobfarmbuild.js), with stub skills: it does nothing without a deep enough shaft, says why,
// waits for the storage room, and reports what it is missing. The digging itself is exercised against a vanilla server by tools/trial/mobfarm-build-lab.js.
const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os'), path = require('path'), fs = require('fs')
const { Vec3 } = require('vec3')
process.env.BOT_MOBFARM_CLAIM = path.join(os.tmpdir(), 'mobfarm-claim-test-' + process.pid + '.json')   // never the real bot-shared claim

function rig({ shaft, rooms = [], items = {} } = {}) {
  const notes = []
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfb-'))
  const bot = { username: 'T', entity: { position: new Vec3(0.5, 80, 0.5) }, inventory: { items: () => Object.entries(items).map(([name, count]) => ({ name, count, type: 1 })) }, setControlState() {} }
  const S = {
    bot, goals: {}, v: (x, y, z) => new Vec3(x, y, z), flo: (p) => new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    count: (w) => { let n = 0; for (const [k, c] of Object.entries(items)) if (w instanceof RegExp ? w.test(k) : k === w) n += c; return n },
    has: (n, c = 1) => S.count(n) >= c, planks: () => 0, logs: () => 0, freeSlots: () => 20, isNight: () => false, underground: () => true,
    noDigAt: () => false, isAbort: () => false, wait: async () => {}, check() {}, block: () => null, items: () => bot.inventory.items(),
  }
  const LD = { shafts: () => (shaft ? [shaft] : []), rooms: () => rooms, worldKey: () => 'spawn 0,0', putRoom() {}, up: async () => true }
  const M = { LD }
  const G = { state: { mine: shaft ? { ladder: true, shaft: shaft.id } : null }, note: (m) => notes.push(m), save() {} }
  const api = { statePath: (f) => path.join(dir, f) }
  const step = require('../brain/autopilot/mobfarmbuild')(G, S, M, api, () => {})
  return { step, G, notes, dir, bot }
}

test('a shaft that is too shallow: no work, the reason is said, the depth it needs is in the status', async () => {
  const sh = { id: 's', entry: [0, 80, 0], wall: [1, 0], bottom: [0, 60, 0] }
  const { step, G, notes } = rig({ shaft: sh, items: { iron_pickaxe: 1 } })
  const r = await step.run()
  assert.equal(r, false)
  assert.ok(notes.some(n => /too shallow/.test(n)), notes.join(' | '))
  assert.equal(G.mobFarmBuild.status().needBottom, 80 - 6 - 22 - 2)
  assert.equal(G.mobFarmBuild.status().done, false)
})

test('no shaft: nothing to hang the farm on; the routine step stays off', async () => {
  const { step, G } = rig({})
  assert.equal(step.need(), false)
  assert.equal(await step.run(), false)
  assert.equal(G.mobFarmBuild.status().phase, 'not started')
})

test('the routine waits for the storage room, then for the kit; status lists what is missing', () => {
  const sh = { id: 's', entry: [0, 80, 0], wall: [1, 0], bottom: [0, 10, 0] }
  const bare = rig({ shaft: sh, items: {} })
  assert.equal(bare.step.need(), false, 'no storage room yet')
  const withRoom = rig({ shaft: sh, rooms: [{ type: 'storage', shaft: 's' }], items: {} })
  assert.equal(withRoom.step.need(), false, 'kit missing')
  const needs = withRoom.G.mobFarmBuild.needs()
  assert.deepEqual(Object.keys(needs).sort(), ['chest', 'filler', 'hopper', 'pickaxe', 'torch', 'water_bucket'])
  const ready = rig({ shaft: sh, rooms: [{ type: 'storage', shaft: 's' }], items: { stone_pickaxe: 2, hopper: 1, water_bucket: 2, torch: 8, cobblestone: 64 } })
  assert.deepEqual(ready.G.mobFarmBuild.needs(), {})
  assert.equal(ready.step.need(), true)
  assert.equal(ready.step.id, 'mob-farm-build')
})

test('a finished farm is not started again', () => {
  const sh = { id: 's', entry: [0, 80, 0], wall: [1, 0], bottom: [0, 10, 0] }
  const { step, G } = rig({ shaft: sh, rooms: [{ type: 'storage', shaft: 's' }], items: { stone_pickaxe: 2, hopper: 1, water_bucket: 2, torch: 8, cobblestone: 64 } })
  G.state.mobFarmBuild = { phase: 'done', shaft: 's' }
  assert.equal(step.need(), false)
})

test('repair: no inspection yet says so; the fallback step runs only for a fault it can take out, one bot at a time, and rests', async () => {
  process.env.BOT_MOBFARM_REPAIR_CLAIM = path.join(os.tmpdir(), 'mobfarm-repair-claim-test-' + process.pid + '.json')
  const sh = { id: 's', entry: [0, 80, 0], wall: [1, 0], bottom: [0, 10, 0] }
  const rg = rig({ shaft: sh, items: { stone_pickaxe: 1 } })
  const step = rg.step.repairStep; assert.equal(step.id, 'mob-farm-repair')
  assert.equal(step.need(), false, 'no inspector, no repair')
  const r0 = await rg.G.mobFarmBuild.repair(); assert.equal(r0.ok, false); assert.match(r0.note, /no inspection/)
  const res = (over) => ({ id: 'mobfarm-s', ok: false, faults: 1, warns: 0, headline: ['x'], findings: [{ id: 'stray-light', sev: 'fault', fix: { kind: 'break', cells: [[1, 2, 3]] } }], ...over })
  const put = (r) => { rg.bot._inspect = { run: async () => [r], last: () => [r] } }
  put(res({})); assert.equal(step.need(), true, 'a fixable fault turns the step on')
  put(res({ ok: true, faults: 0, findings: [] })); assert.equal(step.need(), false, 'a passing farm needs nothing')
  put(res({ findings: [{ id: 'slit-wide', sev: 'fault' }] })); assert.equal(step.need(), false, 'a fault the repair cannot take out is reported, not attempted')
  const r1 = await rg.G.mobFarmBuild.repair(); assert.equal(r1.ok, false); assert.match(r1.note, /nothing here that a repair takes out/)
  put(res({})); rg.G.state.mobFarmBuild = { repairRestUntil: Date.now() + 60000 }; assert.equal(step.need(), false, 'resting after a try')
  rg.G.state.mobFarmBuild = {}; fs.writeFileSync(process.env.BOT_MOBFARM_REPAIR_CLAIM, JSON.stringify({ by: 'Other', at: Date.now() })); assert.equal(step.need(), false, 'the other bot is on it')
  fs.writeFileSync(process.env.BOT_MOBFARM_REPAIR_CLAIM, JSON.stringify({ by: 'Other', at: Date.now() - 3600000 })); assert.equal(step.need(), true, 'a stale claim lapses')
  rg.bot.health = 8; assert.equal(step.need(), false, 'hurt: not now'); rg.bot.health = 20
  rg.bot.isSleeping = true; assert.equal(step.need(), false); rg.bot.isSleeping = false
  put(res({ ok: true, faults: 0, findings: [] })); assert.equal((await rg.G.mobFarmBuild.repair()).ok, true)
  assert.equal(rg.G.mobFarmBuild.status().inspection.ok, true)
})
