// P3: the bot profile, its fallbacks to the old state files, the planner persona and the stance gate that replaced the ap.enabled pin.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createProfile, persona } = require('../brain/profile')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'profile-'))
const write = (dir, f, v) => fs.writeFileSync(path.join(dir, f), typeof v === 'string' ? v : JSON.stringify(v))

test('no files at all: the defaults the bot always had (hillclimber, task stance, planner on, nothing disabled)', () => {
  const p = createProfile({ stateDir: tmp(), botName: 'OzoGo444' }).get()
  assert.strictEqual(p.name, 'OzoGo444'); assert.strictEqual(p.role, 'hillclimber'); assert.strictEqual(p.stance, 'task')
  assert.strictEqual(p.planner.enabled, true); assert.deepStrictEqual(p.disabledModules, []); assert.strictEqual(p.steps, null); assert.strictEqual(p.hasFile, false)
})

test('old files are the fallback: role.json, mode.json, think-off, disabled-modules.json', () => {
  const d = tmp()
  write(d, 'role.json', { role: 'assistant', steps: ['eat', 'cook'] }); write(d, 'mode.json', { mode: 'autonomous', since: 5 })
  write(d, 'think-off', ''); write(d, 'disabled-modules.json', ['mining'])
  const p = createProfile({ stateDir: d, botName: 'Smeo444' }).get()
  assert.strictEqual(p.role, 'assistant'); assert.deepStrictEqual(p.steps, ['eat', 'cook']); assert.strictEqual(p.stance, 'autonomous'); assert.strictEqual(p.stanceSince, 5)
  assert.strictEqual(p.planner.enabled, false); assert.deepStrictEqual(p.disabledModules, ['mining'])
  assert.strictEqual(p.source.role, 'role.json'); assert.strictEqual(p.source.stance, 'mode.json'); assert.strictEqual(p.source.planner, 'think-off')
})

test('profile.json wins over the old files, per field; BRAIN_DISABLE adds modules', () => {
  const d = tmp()
  write(d, 'role.json', { role: 'assistant' }); write(d, 'mode.json', { mode: 'task' }); write(d, 'disabled-modules.json', ['mining'])
  write(d, 'profile.json', { name: 'Ozo', role: 'hillclimber', stance: 'autonomous', planner: { enabled: false }, disabledModules: ['build'], router: { mode: 'live' } })
  const p = createProfile({ stateDir: d, botName: 'x', env: { BRAIN_DISABLE: 'chat' } }).get()
  assert.strictEqual(p.name, 'Ozo'); assert.strictEqual(p.role, 'hillclimber'); assert.strictEqual(p.stance, 'autonomous'); assert.strictEqual(p.planner.enabled, false)
  assert.deepStrictEqual(p.disabledModules, ['build', 'chat']); assert.strictEqual(p.router.mode, 'live'); assert.strictEqual(p.source.stance, 'profile.json')
  assert.strictEqual(p.hasFile, true)
})

test('setStance writes profile.json when there is one, otherwise the old mode.json', () => {
  const a = tmp(); write(a, 'profile.json', { name: 'A', role: 'hillclimber', stance: 'task' })
  const pa = createProfile({ stateDir: a }); assert.strictEqual(pa.get().stance, 'task')
  assert.ok(pa.setStance('autonomous', 'chat')); assert.strictEqual(pa.get().stance, 'autonomous')
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(a, 'profile.json'), 'utf8')).name, 'A')       // other fields survive
  assert.ok(!fs.existsSync(path.join(a, 'mode.json')))
  const b = tmp(); const pb = createProfile({ stateDir: b }); assert.ok(pb.setStance('autonomous'))
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(b, 'mode.json'), 'utf8')).mode, 'autonomous'); assert.strictEqual(pb.get().stance, 'autonomous')
  assert.strictEqual(pb.setStance('flying'), false)
})

test('persona: the hillclimber line is the text think.js always used (with the name in it); the assistant is briefed differently', () => {
  const old = 'You are the mind of OzoGo444, a Minecraft survival player who just spawned in a brand-new world (LAN, Java 1.21.6, Hard) with an empty bag and no base. Goal: survive as long as possible and progress.'
  assert.strictEqual(persona({ name: 'OzoGo444', role: 'hillclimber' }), old)
  const a = persona({ name: 'Smeo444', role: 'assistant' })
  assert.match(a, /^You are the mind of Smeo444/); assert.ok(!/OzoGo444/.test(a)); assert.match(a, /keep the base running/)
  assert.strictEqual(persona({ name: 'x', override: 'custom' }), 'custom')
  const d = tmp(); write(d, 'role.json', { role: 'assistant' })
  assert.match(createProfile({ stateDir: d, botName: 'Smeo444' }).persona(), /^You are the mind of Smeo444.*keep the base running/)
})

test('the shipped bot profiles are valid and match the seeds they replaced', () => {
  for (const [bot, role] of [['ozo', 'hillclimber'], ['smeo', 'assistant']]) {
    const d = tmp(); fs.copyFileSync(path.join(__dirname, '..', 'bots', bot, 'profile.json'), path.join(d, 'profile.json'))
    const p = createProfile({ stateDir: d }).get()
    assert.strictEqual(p.role, role); assert.strictEqual(p.stance, 'autonomous'); assert.deepStrictEqual(p.disabledModules, ['treefarm', 'excavation', 'build', 'villagers', 'mining', 'routines', 'dashboard']); assert.strictEqual(p.planner.enabled, false)
    assert.strictEqual(p.name, bot === 'ozo' ? 'OzoGo444' : 'Smeo444')
  }
  assert.ok(createProfile({ stateDir: (() => { const d = tmp(); fs.copyFileSync(path.join(__dirname, '..', 'bots', 'smeo', 'profile.json'), path.join(d, 'profile.json')); return d })() }).get().steps.includes('berries'))
})

// ---- the stance gate (brain/mode) replaces the defineProperty pin on ap.enabled
function modeFixture(stateDir, env = {}) {
  const profile = createProfile({ stateDir })
  const ap = { enabled: true, gate: null, keepTaskOff: false, ensured: 0, ensureTask() { this.ensured++ }, S: { stopMoving() {} } }
  ap.allowed = () => !ap.gate || !!ap.gate(); ap.active = () => !!ap.enabled && ap.allowed()
  const cancelled = [], cmds = []
  const api = { bot: { _ap: ap }, scheduler: { cancel: (k, why) => cancelled.push([k, why]) }, profile, log() {}, say() {}, commands: { add: (c) => cmds.push(c) } }
  const old = process.env.BOT_MODE
  if (env.BOT_MODE) process.env.BOT_MODE = env.BOT_MODE; else delete process.env.BOT_MODE
  const h = require('../brain/mode')(api)
  if (old === undefined) delete process.env.BOT_MODE; else process.env.BOT_MODE = old
  return { h, ap, profile, cancelled, cmds }
}

test('task stance gates the autopilot even when something sets ap.enabled = true (no property pin)', () => {
  const d = tmp(); write(d, 'profile.json', { name: 'A', stance: 'task' })
  const { h, ap, cancelled } = modeFixture(d)
  h.start(); h.stop()
  assert.strictEqual(typeof ap.gate, 'function')
  ap.enabled = true                                                    // the watchdog kick does this
  assert.strictEqual(ap.enabled, true); assert.strictEqual(ap.active(), false)
  assert.ok(cancelled.some(c => c[0] === 'autopilot'))
  assert.strictEqual(Object.getOwnPropertyDescriptor(ap, 'enabled').get, undefined, 'enabled must be a plain property again')
})

test('switching to autonomous opens the gate, turns the autopilot on and saves the stance in the profile', () => {
  const d = tmp(); write(d, 'profile.json', { name: 'A', stance: 'task' })
  const { h, ap, profile } = modeFixture(d)
  h.start()
  assert.strictEqual(h.set('autonomous', 'test'), true)
  assert.strictEqual(ap.active(), true); assert.ok(ap.ensured >= 1); assert.strictEqual(profile.get().stance, 'autonomous')
  assert.strictEqual(h.set('autonomous', 'test'), false)
  h.set('task', 'test'); assert.strictEqual(ap.active(), false); assert.strictEqual(profile.get().stance, 'task')
  h.stop()
})

test('BOT_MODE sets the start stance only; a bot with the old mode.json and no profile still works', () => {
  const d = tmp(); write(d, 'mode.json', { mode: 'task' })
  const r = modeFixture(d, { BOT_MODE: 'autonomous' }); r.h.start()
  assert.strictEqual(r.h.get(), 'autonomous'); assert.strictEqual(r.ap.active(), true)
  r.h.set('task', 'chat'); assert.strictEqual(JSON.parse(fs.readFileSync(path.join(d, 'mode.json'), 'utf8')).mode, 'task'); r.h.stop()
})

test('the stance command matches through the integrator signature match(user, text) (it used to take only text and never matched)', () => {
  const d = tmp(); write(d, 'profile.json', { name: 'A', stance: 'task' })
  const { cmds, h } = modeFixture(d); h.stop()
  const c = cmds.find(x => x.name === 'mode')
  for (const t of ['autonomous mode', 'task mode', 'mode', 'switch to autonomous', 'back to task mode']) assert.ok(c.match('OGWO', t), t)
  for (const t of ['hello there', 'what mode is the farm in today']) assert.ok(!c.match('OGWO', t), t)
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'brain', 'clearbox', 'index.js'), 'utf8'), /match: \(u, t\) => STARTRE\.test\(t\)/)
})

test('the seed profiles ship with the planner off and the digging/building modules disabled', () => {
  for (const b of ['ozo', 'smeo']) {
    const pf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bots', b, 'profile.json'), 'utf8'))
    assert.strictEqual(pf.planner.enabled, false, b)
    for (const m of ['treefarm', 'excavation', 'build', 'villagers', 'mining', 'routines']) assert.ok(pf.disabledModules.includes(m), b + ' ' + m)
  }
})
