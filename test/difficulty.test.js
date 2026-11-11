// brain/difficulty: reads bot.game.difficulty at login and on change, records changes, reminds while Peaceful. Offline, with a fake bot.
const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os'), path = require('path'), fs = require('fs')
const EE = require('events')
const register = require('../brain/difficulty')

function rig(difficulty) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-'))
  const logs = [], events = []
  const bot = new EE(); bot.game = { difficulty }; bot.entity = null; bot._client = new EE(); bot._journal = { add: (k, f) => events.push({ k, ...f }) }
  const mod = register({ bot, statePath: (f) => path.join(dir, f), log: (tag, m) => logs.push(m) })
  return { bot, mod, logs, events, file: path.join(dir, 'difficulty.json') }
}

test('difficulty: Peaceful at login is logged loudly, recorded and put on the journal', () => {
  const r = rig('peaceful')
  r.mod.check('login')
  assert.ok(r.logs.some(m => /DIFFICULTY PEACEFUL at login/.test(m)))
  assert.ok(r.logs.some(m => /no hostile mob can spawn/.test(m)))
  const j = JSON.parse(fs.readFileSync(r.file, 'utf8'))
  assert.equal(j.difficulty, 'peaceful'); assert.equal(j.peaceful, true)
  assert.equal(r.events.length, 1); assert.equal(r.events[0].sal, 1); assert.equal(r.bot._difficulty.peaceful, true)
})

test('difficulty: Hard at login is recorded quietly (no Peaceful warning), and a change to Peaceful is announced', () => {
  const r = rig('hard')
  r.mod.check('login')
  assert.ok(r.logs.some(m => /DIFFICULTY HARD at login/.test(m)))
  assert.ok(!r.logs.some(m => /PEACEFUL/.test(m)))
  r.bot.game.difficulty = 'peaceful'
  r.mod.check('packet')
  assert.ok(r.logs.some(m => /changed hard -> peaceful/.test(m)))
  const j = JSON.parse(fs.readFileSync(r.file, 'utf8'))
  assert.equal(j.peaceful, true); assert.equal(j.history.length, 2)
  assert.equal(r.events.length, 2)
})

test('difficulty: an unknown or missing value is ignored', () => {
  const r = rig(undefined)
  r.mod.check('poll')
  assert.equal(r.logs.length, 0); assert.equal(fs.existsSync(r.file), false)
})
