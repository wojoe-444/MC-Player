// Checks that every canonical string the chat module can emit for a legacy-handled intent is really understood by the live
// handleCommand() in join.js. The function is cut out of join.js (read only) and run against recording stubs; join.js is never started.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { INTENTS } = require('../brain/chat/intents')
const { create } = require('../brain/chat/matcher')

const DIR = path.join(__dirname, '..')
const src = (() => { try { return fs.readFileSync(path.join(DIR, 'join.js'), 'utf8') } catch { return null } })()
const start = src ? src.indexOf('function handleCommand(user, text) {') : -1
let end = -1
if (start >= 0) { const m = /\n}\n/.exec(src.slice(start)); if (m) end = start + m.index + 2 }
const skip = start < 0 || end < 0 ? 'join.js or handleCommand() not found' : false

const WP = { farm: { x: 1, y: 2, z: 3 }, house: { x: 4, y: 5, z: 6 }, 'furnace station 1': { x: 7, y: 8, z: 9 } }

// A scope where every unknown name is a recording stub (callable, constructible, any property).
function harness() {
  const calls = []
  const rec = (p) => new Proxy(function () {}, {
    get(_, k) {
      if (k === Symbol.iterator) return function* () {}
      if (k === Symbol.toPrimitive) return () => 0
      if (k === 'valueOf') return () => 0
      if (k === 'then' || typeof k === 'symbol') return undefined
      return rec(p + '.' + String(k))
    },
    apply() { calls.push(p); return rec(p + '()') },
    construct() { calls.push('new ' + p); return rec('new ' + p) }
  })
  const over = {
    say: (t) => { calls.push('say'); if (typeof t === 'string') calls.push('say:' + t); return true },
    loadWp: () => WP, saveWp: () => { calls.push('saveWp') }, require: require, console, Math, JSON, Object, Number, String, Array,
    goals: { GoalNear: function () { calls.push('GoalNear') }, GoalNearXZ: function () { calls.push('GoalNearXZ') }, GoalFollow: function () { calls.push('GoalFollow') } },
    navigate: () => { calls.push('navigate') },
    bot: rec('bot'), WP_FILE: 'waypoints.json'
  }
  const scope = new Proxy({}, {
    has: (_, k) => typeof k === 'string' && k !== 'handleCommand',
    get: (_, k) => {
      if (k === Symbol.unscopables) return undefined
      if (k in over) return over[k]
      if (k in globalThis) return globalThis[k]
      return rec(String(k))
    }
  })
  // eslint-disable-next-line no-new-func
  const fn = new Function('scope', `with (scope) { ${src.slice(start, end)}; return handleCommand }`)(scope)
  return { run(text) { calls.length = 0; let handled; try { handled = fn('OGWO', text) } catch (e) { handled = 'threw:' + e.message } return { handled, calls: calls.slice() } } }
}

// canonical -> a call (or say text) that proves the right branch of handleCommand ran
const EXPECT = {
  'follow me': 'GoalFollow', 'come here': 'GoalNear', stay: 'stopNav', inventory: 'bot.inventory.items', status: 'say:Health',
  'what are your coordinates': "say:I'm at", "what's around": 'say:Within', 'what time is it': 'say:', "who's nearby": 'say:Players:', 'wake up': 'say:Up.',
  'list waypoints': 'say:Waypoints:', 'describe the room': 'describeRoom', 'scan furnaces': 'describeFurnaces', 'harvest crops': 'farm.harvest',
  'store crops': 'farm.storeCrops', 'farm routine on': 'setRoutine', 'farm routine off': 'setRoutine', 'index chests': 'indexChests', 'inspect stations': 'inspectStations',
  'craft tool set': 'craftToolSet', sleep: 'bedRoutine', hi: 'say:Hi Walter', 'excavation status': 'excavation.status', 'resume excavation': 'excavation.resume', excavate: 'excavation.start',
  'go to 10 64 -3': 'GoalNear', 'go to 10 -3': 'GoalNearXZ', 'find diamond ore': 'findBlocksCmd', 'save waypoint sheep pen': 'say:Saved waypoint "sheep pen"',
  'go to farm': 'navigate', 'go to house': 'navigate', 'go to furnace station 1': 'navigate'
}

test('every legacy-handled canonical runs the intended branch of the real handleCommand', { skip }, () => {
  const h = harness()
  const bad = []
  for (const [canon, want] of Object.entries(EXPECT)) {
    const r = h.run(canon)
    const hit = r.calls.some(c => c === want || (want.endsWith(':') ? c.startsWith(want) : c.startsWith(want)))
    if (!hit) bad.push(`"${canon}" -> handled=${r.handled} calls=${r.calls.slice(0, 4).join(',')} (wanted ${want})`)
  }
  assert.deepStrictEqual(bad, [])
})

test('every non-brain intent in the table has a canonical that is checked above', { skip }, () => {
  const missing = INTENTS.filter(i => !i.brain && !['again'].includes(i.id)).map(i => i.canonical).filter(c => !(c in EXPECT) && !/^(?:excavation status|resume excavation|excavate)$/.test(c))
  assert.deepStrictEqual(missing, [])
})

test('what the matcher emits for real phrasings is handled by the real handleCommand', { skip }, () => {
  const { REAL, VARIANTS } = require('./chat.phrases')
  const md = require('minecraft-data')('1.21.6')
  const wps = Object.entries(WP).map(([name, v]) => ({ name, ...v }))
  const m = create({ getWaypoints: () => wps, getBlockNames: () => md.blocksArray.map(b => b.name), getItemNames: () => md.itemsArray.map(b => b.name) })
  const h = harness()
  const bad = []
  for (const [text, exp] of [...REAL, ...VARIANTS]) {
    if (!exp) continue
    m.pending.clear()
    const d = m.decide('OGWO', text)
    const canonical = d.canonical || (d.result && d.result.canonical)
    if (!canonical || d.result.intent === 'goto-choice') continue
    if (d.result.intent === 'again' || d.result.intent === 'hello' && false) continue
    const intent = INTENTS.find(i => i.id === d.result.intent)
    if (d.result.intent === 'craft-item') continue
    if (intent && intent.brain) continue                    // brain commands are registered by the integrator, not in join.js
    const r = h.run(canonical)
    if (r.handled !== true) bad.push(`${JSON.stringify(text)} -> "${canonical}" not handled (${r.handled})`)
  }
  assert.deepStrictEqual(bad, [])
})

test('the harness itself can tell handled from unhandled (guards against a vacuous pass)', { skip }, () => {
  const h = harness()
  assert.strictEqual(h.run('blorp zzz').handled, false)
  assert.strictEqual(h.run('stay').handled, true)
  assert.strictEqual(h.run('go to the first base').handled, false, 'legacy cannot look up names with a leading "the": the matcher sends coordinates instead')
})
