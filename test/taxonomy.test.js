// P0-P2 of the architecture taxonomy: the module meta, the named priority bands and the glossary stay in step with the code.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { PRIORITY, BANDS, bandOf } = require('../brain/scheduler')
const meta = require('../brain/meta')

const BRAIN = path.join(__dirname, '..', 'brain')
const MODULES = (/const MODULES = \[([^\]]*)\]/.exec(fs.readFileSync(path.join(BRAIN, 'index.js'), 'utf8'))[1].match(/'([^']+)'/g) || []).map(s => s.slice(1, -1))

test('every loaded module has a valid meta.json that its index.js exports', () => {
  assert.ok(MODULES.length >= 24)
  for (const name of MODULES) {
    const m = meta.readMeta(BRAIN, name)
    assert.ok(m, `${name}: meta.json missing`)
    assert.strictEqual(m.name, name)
    assert.deepStrictEqual(meta.validate(m, MODULES), [], name)
    assert.deepStrictEqual(require(path.join(BRAIN, name, 'index.js')).meta, m, `${name}: index.js must export its meta.json`)
  }
})

test('kinds: every kind in the glossary is used, claims are known, combat is a reflex and not a mode', () => {
  const used = new Set(MODULES.map(n => meta.readMeta(BRAIN, n).kind))
  for (const k of meta.KINDS) assert.ok(used.has(k), `no module of kind ${k}`)
  assert.strictEqual(meta.readMeta(BRAIN, 'combat').kind, 'reflex')
  assert.strictEqual(meta.readMeta(BRAIN, 'mode').kind, 'policy')
  assert.strictEqual(meta.KINDS.length, 7)
  assert.strictEqual(meta.TAXONOMY.ladder.length, 5)
})

test('validate() reports a bad kind, a bad claim and an unknown requirement', () => {
  const bad = meta.validate({ name: 'x', kind: 'mode', summary: 's', requires: ['nope'], provides: [], claims: ['teleport'] }, MODULES)
  assert.strictEqual(bad.length, 3)
})

test('priority numbers are unchanged by the names (P2: no behavior change)', () => {
  const legacy = { SAFETY: 100, SLEEP: 80, EAT: 70, CHAT: 50, OUTING: 45, FARM: 40, FURNACE: 30, EXCAVATE: 10, IDLE: 1 }
  for (const [k, v] of Object.entries(legacy)) assert.strictEqual(PRIORITY[k], v, k)
  // the bare literals the modules used before they got names
  assert.strictEqual(PRIORITY.NIGHT, 60); assert.strictEqual(PRIORITY.FOCUS, 60); assert.strictEqual(PRIORITY.SHELTER, 70); assert.strictEqual(PRIORITY.RETREAT, 90)
  assert.strictEqual(PRIORITY.AUTOPILOT, 45); assert.strictEqual(PRIORITY.UPKEEP, 35); assert.strictEqual(PRIORITY.MANUAL, PRIORITY.CHAT - 1)
  assert.strictEqual(PRIORITY.MANUAL_FOCUS, 48); assert.strictEqual(PRIORITY.BAGROOM, PRIORITY.EXCAVATE + 2)
  assert.strictEqual(PRIORITY.MINING_ORDER, PRIORITY.EXCAVATE + 1); assert.strictEqual(PRIORITY.FURNACE_IDLE, PRIORITY.EXCAVATE - 1)
})

test('bands: ordered high to low and every named priority lands in one', () => {
  for (let i = 1; i < BANDS.length; i++) assert.ok(BANDS[i - 1].min > BANDS[i].min)
  assert.strictEqual(bandOf(PRIORITY.SAFETY), 'reflex'); assert.strictEqual(bandOf(PRIORITY.RETREAT), 'reflex')
  assert.strictEqual(bandOf(PRIORITY.SLEEP), 'needs'); assert.strictEqual(bandOf(PRIORITY.NIGHT), 'needs')
  assert.strictEqual(bandOf(PRIORITY.CHAT), 'request'); assert.strictEqual(bandOf(PRIORITY.AUTOPILOT), 'play')
  assert.strictEqual(bandOf(PRIORITY.FURNACE), 'routine'); assert.strictEqual(bandOf(PRIORITY.EXCAVATE), 'background'); assert.strictEqual(bandOf(PRIORITY.IDLE), 'background')
})

test('INTERFACE.md carries the glossary and names every kind', () => {
  const md = fs.readFileSync(path.join(BRAIN, 'INTERFACE.md'), 'utf8')
  assert.match(md, /## 0\. Vocabulary/)
  for (const k of meta.KINDS) assert.ok(md.includes('`' + k + '`'), `glossary lacks ${k}`)
})

test('botname: prompts keep the default name for Ozo and take the profile name for the other bot', () => {
  const botname = require('../brain/botname')
  const talker = require('../brain/pilot/talker'), decide = require('../brain/fastlane/decide')
  assert.match(botname.forName(talker.SYSTEM), /quick voice of OzoGo444/)
  botname.set('Smeo444')
  try {
    assert.match(botname.forName(talker.SYSTEM), /quick voice of Smeo444/); assert.ok(!/OzoGo444/.test(decide.systemPrompt())); assert.match(decide.systemPrompt(), /command picker for Smeo444/)
  } finally { botname.set('OzoGo444') }
  assert.match(decide.systemPrompt(), /OzoGo444/)
})
