#!/usr/bin/env node
// Smoke test for next/join.js (the patched live bot). Runs it in a scratch copy of the project with mineflayer, the pathfinder
// and the viewer replaced by in-memory stubs, so nothing touches the live bot, the live chat/outbox files or the game.
//   node tools/patch-join.js && node tools/smoke-join.js
// Checks: the brain loads, furnace/queue/stop/chat routing work through the real handleCommand, lava is never held while
// moving, unhandled chat is logged, and a broken brain falls back to legacy behaviour.
const fs = require('fs')
const os = require('os')
const path = require('path')
const cp = require('child_process')

const root = path.resolve(__dirname, '..')
const mode = process.argv[2] || 'brain'      // 'brain' | 'broken'

if (process.env.SMOKE_CHILD) return child()

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-'))
const copy = (src, dst) => { fs.cpSync(src, dst, { recursive: true }) }
const src = (f) => fs.existsSync(path.join(root, 'next', f)) ? path.join(root, 'next', f) : path.join(root, f)
copy(src('join.js'), path.join(tmp, 'join.js'))
copy(src('farm.js'), path.join(tmp, 'farm.js'))
for (const f of ['excavate.js', 'package.json', 'waypoints.json', 'stations.json']) if (fs.existsSync(path.join(root, f))) copy(path.join(root, f), path.join(tmp, f))
copy(path.join(root, 'brain'), path.join(tmp, 'brain'))
fs.rmSync(path.join(tmp, 'brain', 'state'), { recursive: true, force: true })
fs.mkdirSync(path.join(tmp, 'brain', 'state'), { recursive: true })
fs.writeFileSync(path.join(tmp, 'brain', 'state', 'disabled-modules.json'), '["nav"]')   // same as the live bot until the nav module is handed over
if (mode === 'broken') fs.writeFileSync(path.join(tmp, 'brain', 'index.js'), 'module.exports = () => { throw new Error("boom") }')
fs.mkdirSync(path.join(tmp, 'test'))
copy(path.join(root, 'test', 'mock-bot.js'), path.join(tmp, 'test', 'mock-bot.js'))
fs.symlinkSync(path.join(root, 'node_modules'), path.join(tmp, 'node_modules'), 'junction')
fs.copyFileSync(__filename, path.join(tmp, 'smoke-join.js'))

const r = cp.spawnSync(process.execPath, ['-r', './smoke-join.js', 'join.js'], { cwd: tmp, env: { ...process.env, SMOKE_CHILD: '1', SMOKE_MODE: mode, BOT_DASHBOARD_PORT: '-1' }, encoding: 'utf8', timeout: 90000 })
process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '')
const ok = r.status === 0
console.log(ok ? `SMOKE OK (${mode})` : `SMOKE FAILED (${mode}), exit ${r.status}; scratch dir kept: ${tmp}`)
if (ok) fs.rmSync(tmp, { recursive: true, force: true })
process.exit(ok ? 0 : 1)

// ---------------------------------------------------------------- child: stubs + scripted conversation
function child() {
  const Module = require('module')
  const { mockBot } = require(path.join(process.cwd(), 'test', 'mock-bot.js'))
  const config = require(path.join(process.cwd(), 'brain', 'furnace-config.json'))
  const { Vec3 } = require('vec3')
  const bot = mockBot({ pos: [-1045, 128, 2276] })
  bot._client = Object.assign(new (require('events'))(), { state: 'play', write() {} })
  bot.loadPlugin = () => {}
  bot.pathfinder.thinkTimeout = 0
  bot.time = { timeOfDay: 1000, day: 7, age: 5000000 }
  bot.quickBarSlot = 0
  bot.nearestEntity = () => null
  bot.pathfinder.goto = bot.tryGoto
  bot.canDig = false
  const sent = []
  bot.chat = (m) => { sent.push(m); console.log('CHAT_OUT', m) }
  bot.players = { OGWO: { username: 'OGWO', entity: { position: new Vec3(-1040, 128, 2276) } } }
  bot.give('stone_sword'); bot.give('cobblestone', 60)
  bot.world.raycast = () => null   // open space (the stub world has no floors)
  for (const u of config.stations.flatMap(s => s.units)) bot.setBlock(...u.furnace, 'furnace')
  bot.addChest(-1043, 131, 2274, 27, { lava_bucket: 1 }); bot.addChest(-1043, 132, 2273, 27, {}); bot.addChest(-1043, 128, 2273, 54, { bucket: 4 })
  bot.addChest(-1051, 154, 2323, 27, {}); bot.addChest(-1051, 155, 2324, 54, {}); bot.addChest(-1051, 151, 2324, 54, {})
  bot.addChest(-1051, 154, 2326, 27, {}); bot.addChest(-1051, 155, 2325, 27, {}); bot.addChest(-1051, 151, 2325, 54, { bucket: 2 })
  for (const d of config.depots) for (let x = d.box.min[0]; x <= d.box.max[0]; x++) for (let y = d.box.min[1]; y <= d.box.max[1]; y++) for (let z = d.box.min[2]; z <= d.box.max[2]; z++) bot.setBlock(x, y, z, 'lava_cauldron')
  class Movements { constructor() { this.blocksToAvoid = new Set(); this.getBlock = () => null } }
  const goals = bot.goals
  goals.GoalNearXZ = class { constructor(x, z, r) { Object.assign(this, { x, z, r }) } }
  goals.GoalFollow = goals.GoalFollow
  const real = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'mineflayer') return { createBot: () => bot }
    if (request === 'mineflayer-pathfinder') return { pathfinder: () => {}, Movements, goals }
    if (request === 'prismarine-viewer') throw new Error('stubbed out')
    return real.apply(this, arguments)
  }
  // The pathfinder stub teleports; real chat echo: the server sends our own lines back as <OzoGo444> text
  const origChat = bot.chat
  bot.chat = (m) => { origChat(m); setImmediate(() => bot.emit('messagestr', `<OzoGo444> ${m}`)) }
  const say = (user, text) => { console.log('WALTER', text); bot.emit('messagestr', `<${user}> ${text}`) }
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const fail = (msg) => { console.log('ASSERT FAILED:', msg); process.exitCode = 1; setTimeout(() => process.exit(1), 100) }
  const expect = (cond, msg) => { if (!cond) fail(msg); else console.log('ok -', msg) }
  const said = (re) => sent.some(m => re.test(m))

  setTimeout(() => { bot.emit('login'); bot.emit('spawn') }, 50)
  setTimeout(async () => {
    try {
      const mode = process.env.SMOKE_MODE
      if (mode === 'broken') {
        say('OGWO', 'inventory'); await wait(2500)
        expect(said(/I have:/), 'legacy inventory still works when the brain failed to load')
        say('OGWO', 'furnace status'); await wait(2500)
        expect(!said(/Furnace lava buckets/), 'brain commands are absent when the brain is broken')
        return process.exit(0)
      }
      say('OGWO', 'furnace status'); await wait(2500)
      expect(said(/Furnace lava buckets: S1 \?|Furnace lava buckets/), 'brain command "furnace status" answered')
      say('OGWO', 'inventory'); await wait(2500)
      expect(said(/I have:/), 'legacy inventory still works through the brain router')
      say('OGWO', 'what are you doing'); await wait(2500)
      expect(said(/Doing: nothing \(idle\)/), 'queue summary')
      say('OGWO', 'follow me'); await wait(1500)
      expect(bot.pathfinder._goal && bot.pathfinder._goal.entity, 'follow me runs through the scheduler nav task and sets a follow goal')
      say('OGWO', 'stay'); await wait(1500)
      expect(bot.pathfinder._goal === null, 'stay clears navigation')
      const n0 = sent.length
      say('OGWO', 'is this fun by the way?'); await wait(3000)
      expect(sent.length > n0, 'small talk gets some reply (router/fastlane canned answer or the ack)')
      say('OGWO', 'zzq blorpt wuggle 7'); await wait(2500)
      expect(fs.readFileSync('unhandled.log', 'utf8').includes('zzq blorpt'), 'a line nobody understands is logged to unhandled.log')
      say('OGWO', 'start furnace upkeep'); await wait(6000)
      expect(said(/Furnace upkeep on/), 'furnace upkeep acknowledged')
      expect(bot.count('lava_bucket') >= 0 && bot.lavaHeldWhileMoving.length === 0, 'lava was never selected while walking')
      const fuel = (x, y, z) => (bot.chestItems(x, y, z).lava_bucket || 0)
      expect(fuel(-1051, 154, 2323) + fuel(-1051, 154, 2326) >= 2, 'lava buckets reached the station 2 fuel chests')
      expect(!bot.heldItem || bot.heldItem.name !== 'lava_bucket', 'hand is safe at the end')
      expect(fs.existsSync('idle.log'), 'idle.log written')
      console.log('--- idle.log ---')
      for (const l of fs.readFileSync('idle.log', 'utf8').split('\n')) if (/MODULE|BRAIN/.test(l)) console.log(l)
      process.exit(process.exitCode || 0)
    } catch (e) { console.log('SMOKE ERROR', e.stack); process.exit(1) }
  }, 7000)
}
