const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { planEntomb, referenceFor, exitCells, makeEntomb, countFiller } = require('../brain/safety/entomb')
const { rig, addMob, until, wait } = require('./safety.combat.helpers')

// a 41-block-deep cave: stone floor at y=63, everything else air unless set
function cave(bot) { for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) bot.setBlock(x, 63, z, 'stone') }
// world-aware placeBlock/dig for the mock: placing puts a block into the world and takes one from the inventory
function blockOps(bot) {
  bot.placed = []; bot.dug = []
  bot.placeBlock = async (ref, face) => {
    const t = ref.position.plus(face)
    const held = bot.heldItem
    if (!held || !/cobblestone|stone|deepslate|dirt/.test(held.name)) throw new Error('not holding a block')
    if (bot.blockAt(t).name !== 'air') throw new Error('target not empty')
    bot.setBlock(t.x, t.y, t.z, held.name); bot.take(held.name, 1)
    bot.placed.push(t); bot.actions.push(['place', t.x, t.y, t.z])
  }
  bot.dig = async (block) => { bot.setBlock(block.position.x, block.position.y, block.position.z, 'air'); bot.dug.push(block.position); bot.actions.push(['dig', block.position.x, block.position.y, block.position.z]) }
}
const kindFor = (bot) => (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); return b.name === 'lava' ? 'lava' : b.name === 'water' ? 'water' : b.name === 'air' ? 'air' : 'solid' }

test('planEntomb: open cave = roof, 4 head-level sides, 4 foot-level sides (floor is solid); lava next to us is reported, never filled', () => {
  const { bot } = rig({ pos: [0.5, 64, 0.5] }); cave(bot)
  const p = planEntomb(bot.entity.position, kindFor(bot))
  assert.strictEqual(p.fill.length, 9)
  bot.setBlock(1, 64, 0, 'lava')
  const q = planEntomb(bot.entity.position, kindFor(bot))
  assert.strictEqual(q.fill.length, 8); assert.strictEqual(q.blocked.length, 1); assert.strictEqual(q.blocked[0].kind, 'lava')
})
test('referenceFor: needs a solid neighbour to click on', () => {
  const { bot } = rig({ pos: [0.5, 64, 0.5] }); cave(bot)
  const k = kindFor(bot)
  assert.strictEqual(referenceFor(new Vec3(5, 70, 5), k), null)
  const r = referenceFor(new Vec3(1, 64, 0), k)
  assert.deepStrictEqual([r.ref.x, r.ref.y, r.ref.z], [1, 63, 0]); assert.deepStrictEqual([r.face.x, r.face.y, r.face.z], [0, 1, 0])
})

test('seal(): walls itself in on the spot (feet level first, then head level), places only filler, never lava; the roof stays open without a jump', async () => {
  const { bot } = rig({ pos: [0.5, 64, 0.5], items: ['stone_pickaxe', 'cobblestone'] }); cave(bot); blockOps(bot); bot.give('cobblestone', 20)
  const e = makeEntomb({ bot, sleep: () => Promise.resolve() })
  const r = await e.seal()
  assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(r.open, 0)
  for (const [x, y, z] of [[1, 64, 0], [-1, 64, 0], [0, 64, 1], [0, 64, -1], [1, 65, 0], [-1, 65, 0], [0, 65, 1], [0, 65, -1]]) assert.strictEqual(bot.blockAt(new Vec3(x, y, z)).name, 'cobblestone', `${x},${y},${z}`)
  assert.strictEqual(r.roof, false, 'no clickable face above the head and no jump here')
  assert.ok(bot.placed.every(p => Math.abs(p.x) <= 1 && Math.abs(p.z) <= 1))
  assert.deepStrictEqual(bot.placed.slice(0, 4).map(p => p.y), [64, 64, 64, 64], 'feet level (with a floor to click) goes first')
  assert.strictEqual(bot.position, undefined)
})
test('seal(): no filler blocks -> says why and places nothing', async () => {
  const { bot } = rig({ pos: [0.5, 64, 0.5], items: ['stone_sword'] }); cave(bot); blockOps(bot)
  const r = await makeEntomb({ bot }).seal()
  assert.strictEqual(r.ok, false); assert.match(r.why, /no cobblestone/); assert.strictEqual(bot.placed.length, 0)
})
test('digOut(): only blocks it placed itself, one pair on the chosen side, then the rest stays', async () => {
  const { bot } = rig({ pos: [0.5, 64, 0.5], items: ['stone_pickaxe', 'cobblestone'] }); cave(bot); blockOps(bot); bot.give('cobblestone', 20)
  bot.setBlock(3, 64, 0, 'stone')                              // natural block: must never be dug
  const e = makeEntomb({ bot, sleep: () => Promise.resolve() })
  await e.seal()
  assert.ok(await e.digOut(new Vec3(10, 64, 0)))
  assert.deepStrictEqual(bot.dug.map(p => [p.x, p.y, p.z]).sort(), [[1, 64, 0], [1, 65, 0]])
  assert.strictEqual(bot.blockAt(new Vec3(3, 64, 0)).name, 'stone')
  assert.strictEqual(bot.blockAt(new Vec3(-1, 64, 0)).name, 'cobblestone')
})
test('exitCells: prefers the side facing the target', () => {
  const placed = [[1, 64, 0], [1, 65, 0], [-1, 64, 0], [-1, 65, 0], [0, 66, 0]].map(a => new Vec3(...a))
  const c = exitCells(placed, new Vec3(0, 64, 0), new Vec3(-9, 64, 0))
  assert.strictEqual(c[0].x, -1); assert.strictEqual(c[0].y, 65)
})

// ---- runtime: only with Walter's OK, only when hurt + hostile + no way to shelter ----
function hurtRig(opts = {}) {
  const r = rig({ pos: [0.5, 64, 0.5], health: 6, food: 10, items: ['stone_sword', 'bread'], ...opts })
  cave(r.bot); blockOps(r.bot); r.bot.give('cobblestone', 24)
  r.bot.consume = async () => { r.bot.food = 20; r.bot.health = Math.min(20, r.bot.health + 4); r.bot.take('bread', 1); r.bot.actions.push(['eat', 'bread']) }
  addMob(r.bot, 7, 'zombie', 5.5, 0.5)
  return r
}

test('runtime: wall-in is ON by default (Walter approved it) and "do not wall yourself in" turns it off: then no block is ever placed', async () => {
  const { bot, sched, rt } = hurtRig()
  assert.strictEqual(rt.getEmergencyEntomb(), true, 'default on')
  rt.setEmergencyEntomb(false)
  for (let i = 0; i < 10; i++) { rt.scan(); await wait(60) }
  assert.strictEqual(bot.placed.length, 0)
  delete bot.entities[7]; await until(() => { rt.scan(); return !sched.running }, 3000)
})

test('runtime: with Walter\'s OK it walls in, eats inside (mob outside does not matter), then digs out through its own blocks once healed and calm', async () => {
  const { bot, sched, said, rt, slog } = hurtRig()
  rt.setEmergencyEntomb(true)
  // the zombie stays put outside the walls, 5 blocks away
  for (let i = 0; i < 12; i++) { rt.scan(); await wait(80) }
  assert.ok(bot.placed.length >= 8, `placed ${bot.placed.length}`)
  assert.ok(said.some(t => /sealing myself in/.test(t)) && said.some(t => /Sealed in/.test(t)))
  await until(() => bot.actions.some(a => a[0] === 'eat'), 2000)
  assert.ok(bot.actions.some(a => a[0] === 'eat'), 'eats while walled in')
  assert.strictEqual(bot.dug.length, 0, 'no digging while hurt')
  delete bot.entities[7]                                              // danger gone
  bot.health = 20
  const out = await until(() => { rt.scan(); return bot.dug.length === 2 }, 9000)
  assert.ok(out, `dug ${bot.dug.length}; ${slog.join(' | ')}`)
  assert.ok(bot.dug.every(p => bot.placed.some(q => q.x === p.x && q.y === p.y && q.z === p.z)), 'only its own blocks')
  assert.ok(said.some(t => /Digging out/.test(t)))
  await until(() => { rt.scan(); return !sched.running }, 4000)
})

test('runtime: a reachable shelter close by means no wall-in (it walks there instead)', async () => {
  const fs = require('fs'), os = require('os'), path = require('path')
  const f = path.join(os.tmpdir(), `wp-ent-${process.pid}.json`); fs.writeFileSync(f, JSON.stringify({ house: { x: 0, y: 64, z: 20 } }))
  const { bot, sched, rt } = hurtRig({ waypointsFile: f })
  rt.setEmergencyEntomb(true)
  for (let i = 0; i < 8; i++) { rt.scan(); await wait(60) }
  assert.strictEqual(bot.placed.length, 0)
  assert.ok(bot.goalLog.some(g => g.g.constructor.name === 'GoalNear' && g.g.z === 20))
  delete bot.entities[7]; await until(() => { rt.scan(); return !sched.running }, 3000); fs.unlinkSync(f)
})

test('runtime: far shelter (89 blocks) does not count while hurt with a mob close; unreachable shelter does not count at all', async () => {
  const fs = require('fs'), os = require('os'), path = require('path')
  const f = path.join(os.tmpdir(), `wp-far-${process.pid}.json`); fs.writeFileSync(f, JSON.stringify({ 'mine storage': { x: 0, y: 64, z: 89 } }))
  const { bot, sched, rt } = hurtRig({ waypointsFile: f })
  rt.setEmergencyEntomb(true)
  for (let i = 0; i < 10; i++) { rt.scan(); await wait(60) }
  assert.ok(bot.placed.length >= 8, 'walled in instead of a long walk')
  assert.ok(!bot.goalLog.some(g => g.g.constructor.name === 'GoalNear' && g.g.z === 89), 'never set off on the 89 block walk')
  delete bot.entities[7]; bot.health = 20; await until(() => { rt.scan(); return !sched.running }, 9000); fs.unlinkSync(f)
})

test('runtime: after a 41 block fall into a cave, hurt, hostile close, no shelter -> walls in first', async () => {
  const { bot, sched, said, rt } = hurtRig({ health: 12 })
  rt.setEmergencyEntomb(true)
  bot.entity.position = new Vec3(0.5, 105, 0.5)                    // top of the fall
  rt.scan(); bot.entity.position = new Vec3(0.5, 64, 0.5)           // 41 blocks down
  rt.scan()
  delete bot.entities[7]; addMob(bot, 8, 'creeper', 7.5, 0.5); addMob(bot, 9, 'skeleton', -8, 0.5)
  for (let i = 0; i < 12; i++) { rt.scan(); await wait(80) }
  assert.ok(bot.placed.length >= 8, `placed ${bot.placed.length}`)
  assert.ok(!bot.actions.some(a => a[0] === 'attack'))
  delete bot.entities[8]; delete bot.entities[9]; bot.health = 20
  await until(() => { rt.scan(); return !sched.running }, 9000)
})

test('runtime: a failed seal (lava next to us) is reported and not retried for a minute', async () => {
  const { bot, sched, said, rt } = hurtRig()
  bot.setBlock(1, 64, 0, 'lava'); bot.setBlock(1, 65, 0, 'lava')
  rt.setEmergencyEntomb(true)
  for (let i = 0; i < 10; i++) { rt.scan(); await wait(60) }
  assert.ok(said.some(t => /Could not seal myself in/.test(t)))
  assert.ok(!bot.placed.some(p => p.x === 1 && p.z === 0 && p.y <= 65), 'never places into lava cells')
  delete bot.entities[7]; bot.health = 20; await until(() => { rt.scan(); return !sched.running }, 4000)
})

test('flag is saved and chat toggles it', () => {
  const fs = require('fs'), os = require('os'), path = require('path')
  const f = path.join(os.tmpdir(), `ent-state-${process.pid}.json`)
  const install = require('../brain/safety/runtime'), { Scheduler, PRIORITY } = require('../brain/scheduler'), { mockBot } = require('./mock-bot')
  const mk = () => install({ bot: mockBot(), say() {}, goals: {}, scheduler: new Scheduler(), PRIORITY, stateFile: f })
  try {
    assert.strictEqual(mk().getEmergencyEntomb(), true)
    mk().setMode('warn'); assert.strictEqual(mk().getEmergencyEntomb(), true, 'saving the mode does not freeze the default')
    mk().setEmergencyEntomb(false); assert.strictEqual(mk().getEmergencyEntomb(), false, 'Walter\'s explicit choice is remembered')
    mk().setEmergencyEntomb(true); assert.strictEqual(mk().getEmergencyEntomb(), true)
  } finally { try { fs.unlinkSync(f) } catch { /* none */ } }
  const register = require('../brain/safety'), cmds = []
  const bot = mockBot()
  const m = register({ bot, PRIORITY, scheduler: new Scheduler(), say() {}, goals: bot.goals, stopNav() {}, safehand: require('../brain/safehand')({ bot }), ownerName: 'OGWO', statePath: (x) => path.join(os.tmpdir(), `ent-reg-${process.pid}-${x}`), log() {}, now: Date.now, commands: { add: (c) => cmds.push(c) } })
  const hit = (t) => cmds.filter(c => (typeof c.match === 'function' ? c.match('OGWO', t) : c.match.test(t))).map(c => c.name)
  for (const t of ['you can wall yourself in', 'seal yourself in when hurt', 'emergency shelter on']) assert.deepStrictEqual(hit(t), ['entomb-on'], t)
  for (const t of ['do not wall yourself in', "don't seal yourself in", 'emergency shelter off']) assert.deepStrictEqual(hit(t), ['entomb-off'], t)
  m.stop(); try { fs.unlinkSync(path.join(os.tmpdir(), `ent-reg-${process.pid}-safety-state.json`)) } catch { /* none */ }
})

test('seal(): a face above the eye cannot be clicked: the roof is closed by jumping and placing against the top of a head-level block (17:18 failures)', async () => {
  const { bot } = rig({ pos: [0.5, 64, 0.5], items: ['stone_pickaxe', 'cobblestone'] }); cave(bot); blockOps(bot); bot.give('cobblestone', 30)
  const base = bot.entity.position.clone(); const events = []
  bot.setControlState = (k, v) => { events.push([k, v]); if (k === 'jump' && v) { bot.entity.position = base.offset(0, 1.15, 0); setTimeout(() => { bot.entity.position = base.clone() }, 330) } }
  const e = makeEntomb({ bot, sleep: (ms) => wait(Math.min(ms, 60)) })
  const r = await e.seal()
  assert.ok(r.ok && !r.roof, 'sides first, fast: ' + JSON.stringify(r))
  assert.ok(await e.closeRoof(), 'roof closed by jumping')
  assert.strictEqual(bot.blockAt(new Vec3(0, 66, 0)).name, 'cobblestone')
  assert.ok(events.some(([k, v]) => k === 'jump' && v === true))
})
test('seal(): never clicks a face the eye is behind (top faces over the head)', async () => {
  const { bot } = rig({ pos: [0.5, 64, 0.5], items: ['stone_pickaxe', 'cobblestone'] }); cave(bot); blockOps(bot); bot.give('cobblestone', 30)
  const clicks = []; const orig = bot.placeBlock
  bot.placeBlock = async (ref, face) => { clicks.push({ ref: ref.position.clone(), face: face.clone() }); return orig(ref, face) }
  await makeEntomb({ bot, sleep: () => Promise.resolve() }).seal()
  const eye = { x: 0.5, y: 65.62, z: 0.5 }
  for (const c of clicks) {
    const fc = { x: c.ref.x + 0.5 + c.face.x * 0.5, y: c.ref.y + 0.5 + c.face.y * 0.5, z: c.ref.z + 0.5 + c.face.z * 0.5 }
    assert.ok((eye.x - fc.x) * c.face.x + (eye.y - fc.y) * c.face.y + (eye.z - fc.z) * c.face.z > 0, `clicked ${c.ref.x},${c.ref.y},${c.ref.z} face ${c.face.x},${c.face.y},${c.face.z} from behind`)
  }
})
test('seal(): the block must really appear (blockUpdate): a placement the server silently ignores is retried and then reported, not counted', async () => {
  const { bot } = rig({ pos: [0.5, 64, 0.5], items: ['stone_pickaxe', 'cobblestone'] }); cave(bot); blockOps(bot); bot.give('cobblestone', 30)
  let calls = 0; bot.placeBlock = async () => { calls++ }                  // answers fine, places nothing: "the block is still air"
  const r = await makeEntomb({ bot, sleep: () => Promise.resolve() }).seal()
  assert.strictEqual(r.ok, false); assert.ok(r.open > 0); assert.strictEqual(r.placed, 0); assert.ok(calls >= 2)
})
