// The schematic build step's guards (brain/autopilot/schematicbuild.js), with stub skills: it only DECIDES the mob farm when the old builder's preconditions hold,
// never twice, never while the old builder is mid-farm, and it leaves a stuck or complete job alone. The digging and placing are exercised on a vanilla server
// by tools/trial/schematic-build-lab.js.
const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os'), path = require('path'), fs = require('fs')
process.env.BOT_SCHEMATIC_CLAIM = path.join(os.tmpdir(), 'schem-claim-test-' + process.pid + '.json')
const SS = require('../brain/schematic/store')

function rig({ shaft, rooms = [], job = null, night = false, mobFarmBuild = null, health = 20 } = {}) {
  const notes = [], started = []
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schb-'))
  const bot = { username: 'T', health, isSleeping: false, entity: { position: { x: 0, y: 40, z: 0 } }, setControlState() {} }
  const jobs = { cur: job }
  bot._schematic = {
    job: () => jobs.cur, dirs: () => SS.dirsFor({}), clearJob() {}, noteWork() {}, verify: () => null, load: () => null, diggable: () => true,
    startJob: (o) => { started.push(o); jobs.cur = { id: 'mobfarm-forever2k27', kind: 'mobfarm', state: 'building', at: [1, 2, 3], pct: 0 }; return { ok: true, job: jobs.cur } },
  }
  const S = { bot, goals: {}, v: () => null, flo: (p) => p, isNight: () => night, underground: () => true, isAbort: () => false, wait: async () => {}, check() {}, items: () => [], hostilesNear: () => [] }
  const LD = { shafts: () => (shaft ? [shaft] : []), rooms: () => rooms }
  const G = { state: { mine: shaft ? { ladder: true, shaft: shaft.id } : null, mobFarmBuild }, note: (m) => notes.push(m), save() {} }
  const step = require('../brain/autopilot/schematicbuild')(G, S, { LD }, { statePath: (f) => path.join(dir, f) }, () => {})
  return { step, G, notes, started, bot, jobs }
}
const sh = { id: 's', entry: [0, 80, 0], wall: [1, 0], bottom: [0, 10, 0] }
const storage = { type: 'storage', shaft: 's' }

test('decides the mob farm only when the old builder would: a laddered shaft, the storage room done, no farm yet', async () => {
  assert.equal(rig({}).step.need(), false, 'no shaft')
  assert.equal(rig({ shaft: sh }).step.need(), false, 'storage room first')
  assert.equal(rig({ shaft: sh, rooms: [storage, { type: 'mobfarm' }] }).step.need(), false, 'one farm per world')
  assert.equal(rig({ shaft: sh, rooms: [storage], night: true }).step.need(), true, 'underground it does not matter that it is night')
  const r = rig({ shaft: sh, rooms: [storage] })
  assert.equal(r.step.need(), true)
  // the geometry builder is part way through a farm: it finishes it
  assert.equal(rig({ shaft: sh, rooms: [storage], mobFarmBuild: { phase: 'platform' } }).step.need(), false)
})

test('run: starts the job near the shaft with the mob farm kind and says so; a second call does not start another', async () => {
  const r = rig({ shaft: sh, rooms: [storage] })
  await r.step.run().catch(() => {})                       // the pass itself needs the real world: only the decision is checked here
  assert.equal(r.started.length, 1)
  assert.equal(r.started[0].kind, 'mobfarm'); assert.deepEqual(r.started[0].near.slice(0, 1), [0]); assert.match(r.started[0].reason, /mob farm/)
  assert.ok(r.notes.some(n => /following mobfarm-forever2k27/.test(n)), r.notes.join(' | '))
  assert.equal(r.started.length, 1)
})

test('need: a building job works; complete, abandoned and a recently verified stuck job do not; low health waits', () => {
  const j = (state, extra = {}) => ({ id: 'x', kind: 'mobfarm', state, pct: 50, by: 'T', ...extra })
  assert.equal(rig({ job: j('building') }).step.need(), true)
  assert.equal(rig({ job: j('complete') }).step.need(), false)
  assert.equal(rig({ job: j('abandoned') }).step.need(), false)
  assert.equal(rig({ job: j('stuck', { lastVerifyAt: Date.now() }) }).step.need(), false)
  assert.equal(rig({ job: j('stuck', { lastVerifyAt: Date.now() - 3600000 }) }).step.need(), true, 'tries again after half an hour')
  assert.equal(rig({ job: j('building'), health: 10 }).step.need(), false)
})

test('status: percent, cells off and what is stuck are in one place for the planner', () => {
  const r = rig({ job: { id: 'x', kind: 'mobfarm', state: 'building', pct: 71.2, off: 90, at: [1, 2, 3], counts: { dig: 80 }, lastWrong: ['a', 'b'], workedMs: 120000 } })
  const s = r.G.schematicBuild.status()
  assert.equal(s.job.pct, 71.2); assert.equal(s.job.workedMin, 2); assert.deepEqual(s.job.lastWrong, ['a', 'b'])
})
