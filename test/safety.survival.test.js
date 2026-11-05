const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'), os = require('os'), path = require('path')
const { Vec3 } = require('vec3')
const { classify, lessonsFor, makeDeaths } = require('../brain/safety/deaths')
const { check, summarize, makeLoadout } = require('../brain/safety/loadout')
const { makeLight } = require('../brain/safety/light')
const { makeEntomb } = require('../brain/safety/entomb')
const createTorches = require('../brain/lighting/torches')
const { mockBot, mcData } = require('./mock-bot')
const { rig, addMob, until, wait } = require('./safety.combat.helpers')

const tmp = (n) => path.join(os.tmpdir(), `surv-${process.pid}-${Math.random().toString(36).slice(2)}-${n}`)
const inv = (o) => Object.entries(o).map(([name, count]) => ({ name, count }))

// ---------------- deaths / lessons ----------------
test('classify: death messages -> cause', () => {
  assert.strictEqual(classify('OzoGo444 was shot by Skeleton').cause, 'archers')
  assert.strictEqual(classify('OzoGo444 was blown up by Creeper').cause, 'creeper')
  assert.strictEqual(classify('OzoGo444 was slain by Zombie').cause, 'melee')
  assert.strictEqual(classify('OzoGo444 was slain by Spider').by, 'spider')
  assert.strictEqual(classify('OzoGo444 fell from a high place').cause, 'fall')
  assert.strictEqual(classify('OzoGo444 hit the ground too hard').cause, 'fall')
  assert.strictEqual(classify('OzoGo444 tried to swim in lava').cause, 'fire/lava')
  assert.strictEqual(classify('OzoGo444 was obliterated by a sonically-charged shriek').cause, 'warden')
  assert.strictEqual(classify('').cause, 'other')
})

test('lessonsFor: dark cave, no torches, no filler, no armor, shot by archers -> loadout requirements and fight tuning', () => {
  const tuning = { req: {}, deaths: [] }
  const r = lessonsFor({ cause: 'archers', underground: true, light: 0, loadout: { torches: 0, filler: 6, food: 12, sword: 1, armor: 0 }, doing: 'fight skeleton', archersNear: 3, trail: [20, 12, 4] }, tuning)
  assert.deepStrictEqual(tuning.req, { torches: 16, filler: 32, armor: 2 })
  assert.strictEqual(tuning.maxArchers, 1); assert.strictEqual(tuning.archerHealthPlus, 2)
  assert.ok(r.say.some(s => /torches/.test(s)) && r.say.some(s => /armor/.test(s)) && r.say.some(s => /cobblestone/.test(s)))
})
test('lessonsFor: killed while hitting a creeper -> sword strike off; otherwise flee earlier', () => {
  const a = { req: {}, deaths: [] }; lessonsFor({ cause: 'creeper', phase: 'approach', loadout: { torches: 20, filler: 40, food: 20, sword: 1, armor: 4 } }, a)
  assert.strictEqual(a.noCreeperStrike, true)
  const b = { req: {}, deaths: [] }; lessonsFor({ cause: 'creeper', phase: 'idle', loadout: { torches: 20, filler: 40, food: 20, sword: 1, armor: 4 } }, b)
  assert.strictEqual(b.creeperRangePlus, 1); assert.ok(!b.noCreeperStrike)
})
test('lessonsFor: well equipped death by fall does not demand gear it already had', () => {
  const t = { req: {}, deaths: [] }; lessonsFor({ cause: 'fall', underground: false, loadout: { torches: 30, filler: 64, food: 20, sword: 1, armor: 4 } }, t)
  assert.deepStrictEqual(t.req, { torches: 16 })
})

test('makeDeaths: death event appends a post-mortem to lessons.md, writes tuning, says one line after the respawn', async () => {
  const bot = mockBot({ pos: [0, 64, 0] }); bot.username = 'OzoGo444'
  const lessons = tmp('lessons.md'), tune = tmp('tuning.json'), said = []
  fs.writeFileSync(lessons, '# Lessons\n- earlier note\n')
  const d = makeDeaths({ bot, say: (t) => said.push(t), lessonsFile: lessons, tuningFile: tune })
  d.start()
  for (let i = 0; i < 5; i++) { d.sample({ health: 20 - i * 4, pos: { x: -1052, y: 10, z: 2273 }, light: 0, underground: true, loadout: { torches: 0, filler: 6, food: 10, sword: 1, armor: 0, bow: 0 }, mobs: [{ name: 'skeleton', dist: 8 }], doing: 'fight skeleton (several archers)', phase: 'idle' }); await wait(950) }
  bot.emit('messagestr', 'OzoGo444 was shot by Skeleton')
  bot.emit('death')
  const text = fs.readFileSync(lessons, 'utf8')
  assert.match(text, /earlier note/)
  assert.match(text, /\[safety\] DIED \(OzoGo444 was shot by Skeleton\) at -1052,10,2273, underground, light 0/)
  assert.match(text, /Health trail 20>16>12>8>4/); assert.match(text, /0 torches, 6 filler blocks/); assert.match(text, /Adjusted: torches >= 16, filler >= 32, armor >= 2/)
  const t = JSON.parse(fs.readFileSync(tune, 'utf8'))
  assert.strictEqual(t.req.torches, 16); assert.strictEqual(t.deaths[0].cause, 'archers')
  bot.emit('spawn'); await wait(4100)
  assert.strictEqual(said.length, 1); assert.match(said[0], /I died \(archers/)
  d.stop(); fs.unlinkSync(lessons); fs.unlinkSync(tune)
})

test('runtime applies earlier lessons at start: stricter archers, no creeper strike, earlier retreat; Walter\'s explicit creeper choice wins', () => {
  const tune = tmp('tuning.json')
  fs.writeFileSync(tune, JSON.stringify({ req: { torches: 16 }, deaths: [], noCreeperStrike: true, archerHealthPlus: 4, maxArchers: 1, minFightHealthPlus: 2, creeperRangePlus: 2 }))
  const { rt } = rig({ tuningFile: tune })
  assert.strictEqual(rt.getCreeperStrike(), false)
  fs.unlinkSync(tune)
})

// ---------------- loadout ----------------
test('check(): cave needs torches, cobble, food, sword, pickaxe, 2 armor pieces; lessons raise the bar; trip is lighter', () => {
  const none = check({ sword: 0, pickaxe: 0, torches: 0, filler: 0, food: 0, armor: 0 }, 'cave')
  assert.deepStrictEqual(none.missing.map(m => m.what).sort(), ['armor', 'filler', 'food', 'pickaxe', 'sword', 'torches'])
  assert.strictEqual(none.missing.find(m => m.what === 'torches').fix, 'craft 16 torch')
  const full = { sword: 1, pickaxe: 1, torches: 16, filler: 64, food: 12, armor: 2 }
  assert.ok(check(full, 'cave').ok)
  assert.ok(!check(full, 'cave', { torches: 24 }).ok, 'a death by darkness demands more torches')
  assert.ok(check({ sword: 1, torches: 8, food: 8, armor: 0 }, 'trip').ok)
})
test('summarize: counts torches, filler, food (not rotten flesh), armor worn or ready to wear', () => {
  const s = summarize(inv({ torch: 20, cobblestone: 40, stone_sword: 1, stone_pickaxe: 1, bread: 5, rotten_flesh: 9, iron_helmet: 1, iron_boots: 1 }), { head: null, torso: { name: 'iron_chestplate' }, legs: null, feet: null }, mcData.foodsByName)
  assert.strictEqual(s.torches, 20); assert.strictEqual(s.filler, 40); assert.strictEqual(s.food, 5); assert.strictEqual(s.armor, 3); assert.strictEqual(s.armorWorn, 1); assert.strictEqual(s.sword, 1)
})
test('ensure(): equips armor it carries and asks crafting for torches, waiting until they appear; cobble and food are reported, never fetched', async () => {
  const bot = mockBot({ pos: [0, 64, 0] })
  bot.give('stone_sword'); bot.give('stone_pickaxe'); bot.give('bread', 15); bot.give('cobblestone', 70); bot.give('iron_helmet'); bot.give('iron_chestplate')
  const equipped = []; bot.getEquipmentDestSlot = (s) => ({ head: 5, torso: 6, legs: 7, feet: 8 })[s]; bot.inventory.slots = []
  const origEquip = bot.equip; bot.equip = async (it, dest) => { equipped.push(dest); return origEquip(it, dest) }
  const cmds = []
  const commands = { dispatch: (u, text) => { cmds.push(text); setTimeout(() => bot.give('torch', 16), 30); return true } }
  const lo = makeLoadout({ bot, commands, waitMs: 3000, sleep: () => wait(20) })
  const r = await lo.ensure('cave')
  assert.deepStrictEqual(cmds, ['craft 16 torch'])
  assert.ok(r.fixed.includes('torches')); assert.ok(r.ok, JSON.stringify(r.missing))
  assert.ok(equipped.includes('head') && equipped.includes('torso'))
  // missing cobblestone is not fetched from chests: reported only
  bot.take('cobblestone', 70)
  const r2 = await lo.ensure('cave')
  assert.deepStrictEqual(r2.missing.map(m => m.what), ['filler']); assert.strictEqual(cmds.length, 1)
  assert.match(lo.describe({ ok: false, kind: 'cave', missing: r2.missing }), /filler 0\/64/)
})

// ---------------- torch as you go ----------------
function lightRig({ light = 0, torchCount = 10, roof = true } = {}) {
  const bot = mockBot({ pos: [0.5, 12, 0.5] })
  for (let x = -10; x <= 10; x++) for (let z = -10; z <= 10; z++) bot.setBlock(x, 11, z, 'stone')
  if (roof) for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) bot.setBlock(x, 20, z, 'stone')
  bot.give('stone_pickaxe'); if (torchCount) bot.give('torch', torchCount)
  const orig = bot.blockAt
  bot.blockAt = (p) => { const b = orig(p); if (b.name === 'air') b.light = light; return b }
  bot.world = { raycast: () => null }
  bot.placeBlock = async (ref, face) => { const t = ref.position.plus(face); bot.setBlock(t.x, t.y, t.z, 'torch'); bot.take('torch', 1); bot.actions.push(['torch', t.x, t.y, t.z]) }
  const torches = createTorches({ bot, canSee: () => true, sleep: () => Promise.resolve() })
  return { bot, torches, light: makeLight({ bot, torches }) }
}
test('lightHere: underground and dark -> one torch on the floor under the feet, held item restored', async () => {
  const { bot, light } = lightRig(); await bot.equip('stone_pickaxe')
  const r = await light.lightHere()
  assert.ok(r.ok, JSON.stringify(r)); assert.deepStrictEqual(bot.actions.find(a => a[0] === 'torch'), ['torch', 0, 12, 0])
  assert.strictEqual(bot.heldItem.name, 'stone_pickaxe')
  assert.strictEqual((await light.lightHere({})).why, 'cooldown')
})
test('lightHere: not under open sky, not when bright, not with a torch near, not without torches', async () => {
  assert.strictEqual((await lightRig({ roof: false }).light.lightHere()).why, 'open-sky')
  assert.strictEqual((await lightRig({ light: 12 }).light.lightHere()).why, 'bright-enough')
  assert.strictEqual((await lightRig({ torchCount: 0 }).light.lightHere()).why, 'no-torches')
  const n = lightRig(); n.bot.setBlock(3, 12, 0, 'wall_torch'); assert.strictEqual((await n.light.lightHere()).why, 'torch-near')
})
test('due(): torch every 8 blocks; digging or sleeping blocks it', async () => {
  const { bot, light } = lightRig()
  assert.ok(light.due())
  await light.lightHere()
  assert.ok(!light.due())
  bot.entity.position = new Vec3(9.5, 12, 0.5); assert.ok(light.due())
  bot.targetDigBlock = {}; assert.ok(!light.due())
})
test('runtime: walking through a dark cave with torches -> a torch every 8 blocks, nothing while a hostile is near or the bot is digging', async () => {
  const r = rig({ floor: false, pos: [0.5, 12, 0.5], items: ['stone_sword', 'torch'], canSee: () => true, config: { lightCooldownMs: 0 } }); const { bot, rt } = r
  bot.give('torch', 9)
  for (let x = -40; x <= 40; x++) for (let z = -10; z <= 10; z++) { bot.setBlock(x, 11, z, 'stone'); bot.setBlock(x, 20, z, 'stone') }
  const orig = bot.blockAt; bot.blockAt = (p) => { const b = orig(p); if (b.name === 'air') b.light = 0; return b }
  bot.world = { raycast: () => null }
  bot.placeBlock = async (ref, face) => { const t = ref.position.plus(face); bot.setBlock(t.x, t.y, t.z, 'torch'); bot.take('torch', 1); bot.actions.push(['torch', t.x, t.y, t.z]) }
  const torchCount = () => bot.actions.filter(a => a[0] === 'torch').length
  rt.scan(); await wait(150); rt.scan(); await wait(100)
  assert.strictEqual(torchCount(), 1, 'first torch')
  bot.entity.position = new Vec3(4.5, 12, 0.5); rt.scan(); await wait(100); assert.strictEqual(torchCount(), 1, 'too close to the last one')
  bot.entity.position = new Vec3(14.5, 12, 0.5); bot.targetDigBlock = {}; rt.scan(); await wait(100); assert.strictEqual(torchCount(), 1, 'digging')
  bot.targetDigBlock = null; rt.scan(); await wait(150); rt.scan(); await wait(100); assert.strictEqual(torchCount(), 2, 'after 8+ blocks')
  bot.entity.position = new Vec3(26.5, 12, 0.5); addMob(bot, 7, 'zombie', 36.5, 0.5); rt.scan(); await wait(100)
  assert.ok(torchCount() <= 3)
  delete bot.entities[7]
})

// ---------------- fighting back ----------------
test('creeper hit-and-retreat is on by default now', () => {
  const { rt } = rig()
  assert.strictEqual(rt.getCreeperStrike(), true)
})
test('archer at 12 blocks, healthy: the bot closes in zig-zagging (alternating GoalNear points), does not flee', async () => {
  const { bot, sched, rt } = rig({ items: ['stone_sword'] })
  addMob(bot, 7, 'skeleton', 12, 0)
  for (let i = 0; i < 14; i++) { rt.scan(); await wait(120) }
  const near = bot.goalLog.filter(g => /^GoalNear/.test(g.g.constructor.name))
  assert.ok(near.length >= 3, `goals: ${bot.goalLog.map(g => g.g.constructor.name)}`)
  const sides = near.map(g => Math.sign(g.g.z - 0)).filter(Boolean)
  assert.ok(sides.includes(1) && sides.includes(-1), `alternating sides: ${sides}`)
  assert.ok(!bot.goalLog.some(g => g.kind === 'away'), 'never retreated')
  delete bot.entities[7]; await until(() => { rt.scan(); return !sched.running }, 3000)
})

// ---------------- wall-in fixes from the three deaths ----------------
test('wall-in: sculk veins in the target cells are cleared first, then the block goes in (the 16:54 failure)', async () => {
  const { bot } = rig({ pos: [0.5, 64, 0.5], items: ['stone_pickaxe'] }); bot.give('cobblestone', 30)
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) bot.setBlock(x, 63, z, 'stone')
  bot.setBlock(1, 64, 0, 'sculk_vein'); bot.setBlock(-1, 64, 0, 'sculk_vein'); bot.setBlock(0, 65, 1, 'glow_lichen')
  const baseAt = bot.blockAt; bot.blockAt = (p) => { const b = baseAt(p); if (/sculk_vein|glow_lichen/.test(b.name)) b.boundingBox = 'empty'; return b }       // the mock treats every non-air block as solid
  bot.placed = []; bot.dug = []
  bot.placeBlock = async (ref, face) => { const t = ref.position.plus(face); const cur = bot.blockAt(t).name; if (cur !== 'air') throw new Error(`Server refused to place cobblestone at (${t.x}, ${t.y}, ${t.z}): the block is still ${cur}`); bot.setBlock(t.x, t.y, t.z, 'cobblestone'); bot.take('cobblestone', 1); bot.placed.push(t) }
  bot.dig = async (b) => { bot.setBlock(b.position.x, b.position.y, b.position.z, 'air'); bot.dug.push(b.name) }
  const r = await makeEntomb({ bot, sleep: () => Promise.resolve() }).seal()
  assert.ok(r.ok, JSON.stringify(r))
  assert.deepStrictEqual(bot.dug.sort(), ['glow_lichen', 'sculk_vein', 'sculk_vein'])
  for (const [x, y, z] of [[1, 64, 0], [-1, 64, 0], [0, 65, 1]]) assert.strictEqual(bot.blockAt(new Vec3(x, y, z)).name, 'cobblestone')
})
test('wall-in: a second trigger while the first seal is still running does not start another (the doubled 16:55 attempt)', async () => {
  const { bot, rt, said, sched } = rig({ health: 5, food: 10, items: ['stone_sword', 'bread'], pos: [0.5, 64, 0.5] }); bot.give('cobblestone', 30)
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) bot.setBlock(x, 63, z, 'stone')
  let calls = 0
  bot.placeBlock = async (ref, face) => { calls++; await wait(40); const t = ref.position.plus(face); bot.setBlock(t.x, t.y, t.z, 'cobblestone'); bot.take('cobblestone', 1) }
  bot.dig = async () => {}
  addMob(bot, 7, 'zombie', 5.5, 0.5)
  for (let i = 0; i < 20; i++) { rt.scan(); await wait(30) }
  assert.strictEqual(said.filter(t => /sealing myself in/.test(t)).length, 1)
  delete bot.entities[7]; bot.health = 20; bot.consume = async () => {}
  await until(() => { rt.scan(); return !sched.running }, 12000)       // heals, digs out, ends the task
})
