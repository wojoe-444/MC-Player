// brain/nav must keep Walter's rules and INTERFACE.md section 5 by construction: scan the source for the things it must never do.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const dir = path.join(__dirname, '..', 'brain', 'nav')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'))
const src = (f) => fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

const FORBIDDEN = [
  [/\.position\s*=[^=]/, 'assigns a position (teleport-like)'],
  [/position\.(set|update|add|subtract|translate)\(/, 'moves the bot by writing its position'],
  [/velocity\.(x|y|z)\s*=/, 'writes velocity'],
  [/teleport|\/tp\b|\/teleport/i, 'teleport commands'],
  [/\.chat\(/, 'talks outside api.say'],
  [/\bsetInterval\s*\(/, 'unstoppable interval (INTERFACE section 5, rule 6)'],
  [/process\.(exit|on)\(/, 'process-level handlers'],
  [/\.dig\(|\.placeBlock\(|\.stopDigging\(|canDig\s*=\s*true/, 'digs or places blocks (Walter rule 2)', ['reach.js', 'navigator.js']],
  [/createServer|\.listen\(/, 'opens a port']
]

test('no forbidden calls anywhere in brain/nav', () => {
  for (const f of files) {
    const s = src(f)
    for (const [re, why, allowedIn = []] of FORBIDDEN) {
      // doors.js/stuck.js legitimately press control states; they never write positions
      if (allowedIn.includes(f)) continue
      assert.ok(!re.test(s), `${f}: ${why} (${re})`)
    }
  }
})

test('digging and placing live only in reach.js (the escalating go-to) and navigator.js switches the planner into dig mode in one place', () => {
  const nav = src('navigator.js'), reach = src('reach.js')
  assert.strictEqual((nav.match(/canDig\s*=\s*true/g) || []).length, 1, 'navigator.js: canDig = true only in enterDigMode')
  assert.ok(/enterDigMode\(\)/.test(nav) && /leaveDigMode\(/.test(nav))
  assert.ok(!/\.dig\(|\.placeBlock\(/.test(nav), 'navigator.js itself never digs or places')
  assert.ok(/bot\.dig\(/.test(reach) && /bot\.placeBlock\(/.test(reach))
  // the things that must stay unbreakable
  for (const n of ['chest', 'furnace', 'ladder', 'bed', 'barrel', 'crafting_table', 'bedrock', 'obsidian']) assert.ok(require('../brain/nav/reach').PROTECTED.test(n), n)
})

test('file writes go through api.statePath only (index.js) and nothing else writes at all', () => {
  for (const f of files) {
    const s = src(f)
    const writes = /writeFileSync|appendFileSync|writeFile\(|createWriteStream|mkdirSync|renameSync/.test(s)
    if (f === 'index.js') assert.ok(/stateFile\s*=\s*api\.statePath\(/.test(s) && !/appendFileSync|createWriteStream|mkdirSync/.test(s), 'index.js writes only its state file')
    else if (f === 'nether.js') assert.ok(/this\.file/.test(s) && !/appendFileSync|createWriteStream/.test(s), 'nether.js writes only the file it is given (api.statePath in nether-trip.js)')
    else assert.ok(!writes, `${f} must not write files`)
  }
})

test('timers: only one-shot setImmediate/setTimeout, and every long-lived hook is a bot listener that stop() removes', () => {
  for (const f of files) {
    const s = src(f)
    for (const m of s.matchAll(/setTimeout\s*\(/g)) assert.fail(`${f}: setTimeout found; nav is tick driven`)
  }
})

test('the module exports the interface: register(api) with meta, handle with name/start/stop/status/provides/navigate', () => {
  const register = require('../brain/nav')
  assert.strictEqual(typeof register, 'function')
  assert.strictEqual(register.meta.name, 'nav'); assert.strictEqual(register.meta.version, 1); assert.strictEqual(register.meta.kind, 'service')
})

test('README documents the commands and the join.js notes', () => {
  const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8')
  for (const word of ['go to', 'Xaero', 'doors', 'stuck', 'Nether', 'line of sight', 'join.js', 'Here.', 'nether-network.json']) assert.ok(readme.includes(word), word)
})
