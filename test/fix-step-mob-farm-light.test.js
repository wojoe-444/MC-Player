// Work order step-mob-farm-light: a light-up run that the scheduler ends halfway (a preemption, a watchdog kick) wrote no line to the journal.
// The step then gives way with nothing said about how long it ran, what it had placed, or why it stopped.
const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os'), fs = require('fs'), path = require('path')
const { Vec3 } = require('vec3')
process.env.LIGHTUP_XRAY_OK = '1'   // the step is gated on the approval; these tests exercise it as approved

const FARM = { builder: 'mobfarmbuild', platform: { y: 30, centre: [230, 29, 0], radius: 9 }, rest: [207, 30, 0], killSpot: [227, 8, 0], killBox: { x0: 230, x1: 230, y0: 8, y1: 9, z0: 0, z1: 0 } }

// a bot with 20 torches, standing 230 blocks from the farm, so the run first walks to the farm's rest spot; that walk is cut short by the scheduler
function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lu-fix-'))
  fs.writeFileSync(path.join(dir, 'mobfarm.json'), JSON.stringify(FARM))
  const bot = { username: 'T', health: 20, isSleeping: false, entity: { position: new Vec3(0.5, 30, 0.5) }, entities: {}, inventory: { items: () => [{ name: 'torch', count: 20 }] } }
  const S = {
    bot, goals: { GoalNear: function GoalNear() {} }, v: (x, y, z) => new Vec3(x, y, z), flo: (p) => new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    count: (w) => (w === 'torch' ? 20 : 0), planks: () => 0, logs: () => 0,
    isNight: () => false, underground: () => false, check() {}, wait: async () => {}, craft: async () => false,
    hostilesNear: () => [], dist: () => 0,
    isAbort: (e) => !!e && e.name === 'AbortError',
    goto: async () => { const e = new Error('aborted: preempted'); e.name = 'AbortError'; e.reason = 'preempted'; throw e },
  }
  const notes = []
  const G = { state: {}, note: (m) => notes.push(m), save() {} }
  require('../brain/autopilot/lightup')(G, S, {}, { statePath: (f) => path.join(dir, f) }, () => {})
  return { G, notes }
}

test('a light-up run the scheduler ends halfway writes a journal line: why it stopped, how long it ran, what it placed', async () => {
  const r = rig()
  await assert.rejects(r.G.lightUp.run(), { name: 'AbortError' })
  assert.match(r.notes.join('\n'), /light-up: aborted \(preempted\) after \d+ s, 0 torches placed/, 'the aborted run wrote no line: ' + JSON.stringify(r.notes))
})
