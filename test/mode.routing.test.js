// "task mode" used to be swallowed by the core "queue" command (/^tasks?\b/ matched "task mode"), so the stance could never be switched back by chat.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { mockBot } = require('./mock-bot')
const attach = require('../brain')

test('through the real router: "autonomous mode" and "task mode" both reach the mode module; "task queue" and "tasks" still list the queue', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moderoute-')), stateDir = path.join(dir, 'state'); fs.mkdirSync(stateDir)
  fs.writeFileSync(path.join(stateDir, 'profile.json'), JSON.stringify({ version: 1, name: 'A', role: 'hillclimber', stance: 'task', planner: { enabled: false } }))
  const bot = mockBot({ pos: [0, 64, 0] }); const said = []
  const brain = attach({ bot, say: (t) => said.push(t), goals: bot.goals, tryGoto: bot.tryGoto, stopNav() {}, dir, stateDir, ownerName: 'A', handleCommand: () => false, jobs: {}, routines: { farm: false },
    saveRoutines() {}, navigateRaw() {}, navActive: () => false, stopAllLegacy() {}, sleepWanted: () => false,
    moduleEntries: [{ name: 'mode', path: path.join(__dirname, '..', 'brain', 'mode', 'index.js') }], safetyCooldownMs: 0, idleAfterMs: 50 })
  try {
    assert.strictEqual(brain.commands.dispatch('A', 'autonomous mode'), true)
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(stateDir, 'profile.json'), 'utf8')).stance, 'autonomous')
    assert.strictEqual(brain.commands.dispatch('A', 'task mode'), true)
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(stateDir, 'profile.json'), 'utf8')).stance, 'task')
    assert.ok(said.some(t => /^Task mode:/.test(t)), 'the mode reply was sent: ' + JSON.stringify(said))
    said.length = 0
    brain.commands.dispatch('A', 'tasks'); brain.commands.dispatch('A', 'task queue')
    assert.strictEqual(said.filter(t => /^Doing:/.test(t)).length, 2)
  } finally { brain.stop() }
})
