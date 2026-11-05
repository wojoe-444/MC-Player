const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const mcData = require('minecraft-data')('1.21.6')
const { create } = require('../brain/chat/matcher')
const register = require('../brain/chat')
const { REAL, VARIANTS } = require('./chat.phrases')

const BLOCKS = mcData.blocksArray.map(b => b.name)
const ITEMS = mcData.itemsArray.map(i => i.name)
// Walter's real waypoint names (Xaero import + the bot's own), coordinates as in waypoints.json
const WAYPOINTS = [
  ['crafting table', -1051, 151, 2320], ['portal (-4369, 2291)', -4369, 63, 2291], ['portal (-4069, -726)', -4069, 104, -726], ['weird underground portal', -2848, -52, -4372],
  ['portal (-2977, -4493)', -2977, 65, -4493], ['portal (-637, -3030)', -637, 90, -3030], ['ice portal', -1102, 63, -2178], ['seaside winter village', -1085, 63, -3674],
  ['mt jag', 3202, 287, 3199], ['partial portal', 0, 64, 0], ['house', -1060, 64, 2290], ['valley portal', 10, 144, 10], ['mt parros', 500, 90, 500], ['spookville', 100, 70, 100],
  ['first village', -300, 64, 200], ['farm', -1030, 64, 2350], ['the first base', -1500, 64, 1500], ['furnace input chest', -1043, 132, 2273], ['furnace fuel chest', -1043, 131, 2274],
  ['furnace station 1', -1043, 130, 2273], ['furnace station 2', -1051, 153, 2324], ['lava depot 1', -1046, 136, 2314], ['lava depot 2', -1040, 128, 2270], ['home farm', -1000, 64, 2400]
].map(([name, x, y, z]) => ({ name, x, y, z }))

const mk = (extra = {}) => create({
  getWaypoints: () => WAYPOINTS, getBlockNames: () => BLOCKS, getItemNames: () => ITEMS, getPosition: () => ({ x: -1050, z: 2300 }), ...extra
})
const shape = (m, text) => {
  m.pending.clear()
  m.remember('OGWO', 'follow me')
  const d = m.decide('OGWO', text)
  return d.type === 'none' ? null : d.type === 'ask' ? 'ask:' + d.result.intent : d.type === 'say' ? 'say' : d.result.intent
}

test('real Walter chat lines (chat.log) and variants: intent, or null for conversation', () => {
  const m = mk()
  const bad = []
  for (const [text, exp] of [...REAL, ...VARIANTS]) {
    let got = shape(m, text)
    if (exp === 'goto-waypoint' && got === 'goto-waypoint') got = exp
    if (got !== exp) bad.push(`${JSON.stringify(text.slice(0, 80))}: expected ${exp}, got ${got}`)
  }
  assert.deepStrictEqual(bad, [])
})

test('canonical strings are what handleCommand understands', () => {
  const m = mk()
  const c = (t) => m.decide('OGWO', t).canonical
  assert.strictEqual(c('can u pls folow me'), 'follow me')
  assert.strictEqual(c('cmere'), 'come here')
  assert.strictEqual(c('stpo'), 'stay')
  assert.strictEqual(c("what's ur position"), 'what are your coordinates')
  assert.strictEqual(c('how r u'), 'status')
})

test('speed: a line parses in a few milliseconds of CPU (CPU time, so a busy test run does not make it flaky)', () => {
  const m = mk()
  const lines = [...REAL, ...VARIANTS].map(x => x[0])
  for (const l of lines.slice(0, 20)) m.decide('OGWO', l)   // warm up
  const c0 = process.cpuUsage()
  let n = 0
  for (let i = 0; i < 4; i++) for (const l of lines) { m.pending.clear(); m.decide('OGWO', l); n++ }
  const u = process.cpuUsage(c0)
  const ms = (u.user + u.system) / 1000
  assert.ok(ms / n < 20, `avg ${(ms / n).toFixed(2)} ms CPU per line`)
})

test('typos and filler words', () => {
  const m = mk()
  for (const t of ['pleeease follw me', 'hey bot, would you mind following me', 'c0me here', 'could u please come here ok', 'FOLLOW ME NOW', 'yo ozogo444 stop plz', 'stop!!!', 'uh follow me, thanks']) {
    const d = m.decide('OGWO', t)
    assert.ok(d.type === 'run' || d.type === 'ask', `${t}: ${d.type}`)
  }
  assert.strictEqual(m.decide('OGWO', 'wait up').canonical, 'stay')
  assert.strictEqual(m.decide('OGWO', 'hold on a sec').canonical, 'stay')
})

test('coordinates: many formats, y optional, decimals floored', () => {
  const m = mk()
  const g = (t) => m.decide('OGWO', t).canonical
  assert.strictEqual(g('go to 100 64 -200'), 'go to 100 64 -200')
  assert.strictEqual(g('go to -1043 2273'), 'go to -1043 2273')
  assert.strictEqual(g('walk to (100, 64, -200)'), 'go to 100 64 -200')
  assert.strictEqual(g('head to x=100 z=-200'), 'go to 100 -200')
  assert.strictEqual(g('can you come to x 100 y 64 z -200 please'), 'go to 100 64 -200')
  assert.strictEqual(g('travel to 100/64/-200'), 'go to 100 64 -200')
  assert.strictEqual(g('go to -1055.5 160.00 2335.5'), 'go to -1056 160 2335')
  assert.strictEqual(g('pls run to 5, 6'), 'go to 5 6')
})

test('coordinates without a verb are confirmed, and things that are not coordinates are ignored', () => {
  const m = mk()
  const d = m.decide('OGWO', '100 64 -200')
  assert.strictEqual(d.type, 'ask')
  assert.strictEqual(d.result.canonical, 'go to 100 64 -200')
  assert.strictEqual(m.decide('OGWO', 'i have 3 4 stacks of wood').type, 'none')
  assert.strictEqual(m.decide('OGWO', 'it took 5 6 hours').type, 'none')
  assert.strictEqual(m.decide('OGWO', "don't go to 100 64 200").canonical, undefined)
})

test('waypoints: exact, partial, typo, aliases; Xaero names with parentheses become coordinates', () => {
  const m = mk()
  const g = (t) => { const d = m.decide('OGWO', t); return d.type === 'run' ? d.canonical : d.type + ':' + (d.result ? d.result.canonical : d.text) }
  assert.strictEqual(g('go to the farm'), 'go to farm')
  assert.strictEqual(g('walk to farm'), 'go to farm')
  assert.strictEqual(g('head over to the house'), 'go to house')
  assert.strictEqual(g('go home'), 'go to house')
  assert.strictEqual(g('go to the frist village'), 'go to first village')
  assert.strictEqual(g('can you come to the crafting table'), 'go to crafting table')
  assert.strictEqual(g('go to lava depot 2'), 'go to lava depot 2')
  assert.strictEqual(g('go to furnace station 1'), 'go to furnace station 1')
  // legacy cannot look up "the first base", so it goes by coordinates
  assert.strictEqual(g('go to the first base'), 'go to -1500 64 1500')
  assert.strictEqual(g('go to ice portal'), 'go to ice portal')
  // a waypoint that is only a partial name is confirmed, not guessed
  const d = m.decide('OGWO', 'go to the base')
  assert.ok(d.type === 'ask' || d.type === 'run', d.type)
  assert.match(d.type === 'ask' ? d.question : d.canonical, /base|-1500/)
})

test('"meet me where I am, at the farm" goes to the farm, not to the player', () => {
  const m = mk()
  assert.strictEqual(m.decide('OGWO', 'can you come meet me where I am now, at the farm?').canonical, 'go to farm')
  assert.strictEqual(m.decide('OGWO', 'come here').canonical, 'come here')
  const f = m.decide('OGWO', 'follow me to the farm')
  assert.strictEqual(f.result.canonical, 'follow me')   // follow wins, but it is confirmed because of the extra words
  assert.notStrictEqual(f.result.intent, 'goto-waypoint')
})

test('statements about places are not orders', () => {
  const m = mk()
  for (const t of ['the farm is nice', 'i was at the farm earlier', 'you would take buckets to the lava depot', 'the house needs a roof', 'the crops are in the chest']) {
    assert.strictEqual(m.decide('OGWO', t).type, 'none', t)
  }
})

test('ambiguous waypoint ("portal") asks which one, nearest first; answer by number, ordinal or name', () => {
  const m = mk()
  let d = m.decide('OGWO', 'go to portal')
  assert.strictEqual(d.type, 'say')
  assert.match(d.text, /^Which portal\? 1\) /)
  d = m.decide('OGWO', 'the second one')
  assert.strictEqual(d.type, 'run')
  assert.match(d.canonical, /^go to -?\d+ -?\d+ -?\d+$/)
  const m2 = mk()
  m2.decide('OGWO', 'go to portal')
  assert.match(m2.decide('OGWO', 'ice portal').canonical, /ice portal/)
  const m3 = mk()
  m3.decide('OGWO', 'go to portal')
  assert.strictEqual(m3.decide('OGWO', 'no').text, 'OK, cancelled.')
  assert.strictEqual(m3.pending.size, 0)
})

test('find <thing>: block names from the registry, ore/plural handling; waypoints win over blocks', () => {
  const m = mk()
  const g = (t) => m.decide('OGWO', t).canonical
  assert.strictEqual(g('find diamonds'), 'find diamond ore')
  assert.strictEqual(g('can you find a crafting table?'), 'find crafting table')
  assert.strictEqual(g('where is the nearest iron'), 'find iron ore')
  assert.strictEqual(g('find me some coal'), 'find coal ore')
  assert.strictEqual(g('locate beds'), 'find bed')
  assert.strictEqual(g('search for chests'), 'find chest')
  assert.strictEqual(g('find lava'), 'find lava')
  assert.strictEqual(m.decide('OGWO', 'find the farm').type, 'none')   // a place, not a block
  assert.strictEqual(m.decide('OGWO', 'find your way home please').type, 'none')
})

test('item questions go to inventory with the item as a slot', () => {
  const m = mk()
  const d = m.decide('OGWO', 'how many torches do you have?')
  assert.strictEqual(d.canonical, 'inventory')
  assert.strictEqual(d.result.slots.item, 'torch')
  assert.strictEqual(m.decide('OGWO', 'got any iron ingots').result.slots.item, 'iron_ingot')
})

test('save a waypoint', () => {
  const m = mk()
  assert.strictEqual(m.decide('OGWO', 'remember this place as the mine entrance').canonical, 'save waypoint mine entrance')
  assert.strictEqual(m.decide('OGWO', 'save waypoint sheep pen').canonical, 'save waypoint sheep pen')
  assert.strictEqual(m.decide('OGWO', 'save this spot as base two').canonical, 'save waypoint base two')
})

test('risky jobs: exact phrase runs, typo is confirmed; yes/no/expiry', () => {
  let clock = 1000
  const m = mk({ now: () => clock })
  assert.strictEqual(m.decide('OGWO', 'harvest the crops').type, 'run')
  let d = m.decide('OGWO', 'harvet the crops')
  assert.strictEqual(d.type, 'ask')
  assert.strictEqual(d.question, 'Did you mean "harvest crops"? (yes/no)')
  assert.ok(m.hasPending('OGWO'))
  d = m.decide('OGWO', 'yes')
  assert.strictEqual(d.type, 'run'); assert.strictEqual(d.canonical, 'harvest crops'); assert.ok(!m.hasPending('OGWO'))
  m.decide('OGWO', 'harvet the crops')
  assert.strictEqual(m.decide('OGWO', 'nope').text, 'OK, cancelled.')
  assert.strictEqual(m.decide('OGWO', 'yes').type, 'none')   // nothing pending: a bare yes is not a command
  m.decide('OGWO', 'harvet the crops')
  clock += 31000
  assert.strictEqual(m.decide('OGWO', 'yes').type, 'none', 'confirmation expired')
  m.decide('OGWO', 'harvet the crops')
  assert.strictEqual(m.decide('OGWO', 'follow me').canonical, 'follow me')   // any other line abandons the question
  assert.strictEqual(m.decide('OGWO', 'yes').type, 'none')
})

test('stop is never held up by a question, and wins in a multi-sentence line', () => {
  const m = mk()
  m.decide('OGWO', 'harvet the crops')
  const d = m.decide('OGWO', 'stop')
  assert.strictEqual(d.type, 'run'); assert.strictEqual(d.canonical, 'stay')
  assert.strictEqual(m.decide('OGWO', "It's spamming Here. again. stop it").canonical, 'stay')
  assert.strictEqual(m.decide('OGWO', 'no wait stop').canonical, 'stay')
})

test('negations: "don\'t follow" stops, other negated jobs do nothing', () => {
  const m = mk()
  assert.strictEqual(m.decide('OGWO', "don't follow me").canonical, 'stay')
  assert.strictEqual(m.decide('OGWO', 'do not come here').canonical, 'stay')
  assert.strictEqual(m.decide('OGWO', "don't harvest yet").type, 'none')
  assert.strictEqual(m.decide('OGWO', 'dont stop').type, 'none')
  assert.strictEqual(m.decide('OGWO', 'dont fight').canonical, 'do not fight')
})

test('topic memory: "do that again" and "go there"', () => {
  const m = mk()
  assert.strictEqual(m.decide('OGWO', 'do that again').type, 'none', 'nothing to repeat yet')
  m.remember('OGWO', 'go to 100 64 200')
  assert.strictEqual(m.decide('OGWO', 'do that again').canonical, 'go to 100 64 200')
  m.remember('OGWO', 'inventory')
  assert.strictEqual(m.decide('OGWO', 'once more').canonical, 'inventory')
  m.remember('OGWO', 'go to 5 6')
  m.remember('OGWO', 'follow me')
  assert.strictEqual(m.decide('OGWO', 'go back there').canonical, 'go to 5 6')
  // memory is per user
  assert.strictEqual(m.decide('Other', 'again').type, 'none')
})

test('only commands registered by the integrator are offered (brain-native intents)', () => {
  let cmds = []
  const m = mk({ getCommands: () => cmds })
  assert.strictEqual(m.decide('OGWO', 'keep the furnaces running').type, 'none')
  assert.strictEqual(m.decide('OGWO', 'follow me').canonical, 'follow me', 'legacy-handled intents are always on')
  cmds = [{ name: 'furnace', help: 'start furnace upkeep', risk: 'high', canonical: ['start furnace upkeep'] }]
  assert.strictEqual(m.decide('OGWO', 'keep the furnaces running').result.intent, 'furnace-start')
  // a command the chat module has never heard of becomes matchable from its own help text
  cmds = cmds.concat([{ name: 'dance', help: 'dance | do a dance | boogie', risk: 'low', canonical: ['dance', 'do a dance', 'boogie'] }])
  assert.strictEqual(m.decide('OGWO', 'do a danse').canonical, 'dance')
})

test('slash commands, empty and huge input never match', () => {
  const m = mk()
  for (const t of ['/kill @e', '/stop', '', '   ', 'x'.repeat(600), null, undefined, 42]) assert.strictEqual(m.decide('OGWO', t).type, 'none', String(t).slice(0, 20))
})

test('quickAck is short and fast', () => {
  const m = mk()
  assert.strictEqual(m.quickAck('is this fun for you?'), 'Let me think about that.')
  assert.strictEqual(m.quickAck('the lava is in cauldrons'), 'Got it, one moment.')
})

// ---------------------------------------------------------------- register() wiring ----

function fakeApi({ owner = 'OGWO', handled = () => true, commands = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-test-'))
  fs.writeFileSync(path.join(dir, 'waypoints.json'), JSON.stringify(Object.fromEntries(WAYPOINTS.map(w => [w.name, { x: w.x, y: w.y, z: w.z }]))))
  fs.mkdirSync(path.join(dir, 'state'))
  const api = {
    bot: { registry: mcData, entity: { position: { x: -1050, y: 64, z: 2300 } } },
    dir, ownerName: owner, said: [], dispatched: [], logs: [], clock: 1e6,
    say(t) { api.said.push(t) },
    log(tag, msg) { api.logs.push(`${tag}: ${msg}`) },
    now: () => api.clock,
    statePath: (f) => path.join(dir, 'state', f),
    commands: { list: () => commands, dispatch(u, t) { api.dispatched.push(t); return handled(t) } }
  }
  return api
}

test('register: fallback dispatches a fuzzy match; handled lines are not answered', () => {
  const api = fakeApi()
  const mod = register(api)
  assert.strictEqual(mod.name, 'chat')
  assert.strictEqual(mod.fallback('OGWO', 'can u folow me'), true)
  assert.deepStrictEqual(api.dispatched, ['follow me'])
  assert.deepStrictEqual(api.said, [], 'the chat module itself says nothing when it just dispatches')
})

test('register: onChat consumes only answers to its own questions', () => {
  const api = fakeApi()
  const mod = register(api)
  assert.strictEqual(mod.onChat('OGWO', 'harvet the crops'), false)
  assert.strictEqual(mod.fallback('OGWO', 'harvet the crops'), true)
  assert.deepStrictEqual(api.said, ['Did you mean "harvest crops"? (yes/no)'])
  assert.deepStrictEqual(api.dispatched, [])
  assert.strictEqual(mod.onChat('OGWO', 'yes'), true)
  assert.deepStrictEqual(api.dispatched, ['harvest crops'])
  assert.strictEqual(mod.onChat('OGWO', 'yes'), false, 'no question pending any more')
  // an unrelated line while a question is open falls through to the normal chain and drops the question
  mod.fallback('OGWO', 'harvet the crops')
  assert.strictEqual(mod.onChat('OGWO', 'come here'), false)
  assert.strictEqual(mod.onChat('OGWO', 'yes'), false)
})

test('register: unknown lines are ignored silently; near misses are logged for the driver', () => {
  const api = fakeApi()
  const mod = register(api)
  assert.strictEqual(mod.fallback('OGWO', 'is this fun for you by the way?'), false)
  assert.strictEqual(mod.fallback('OGWO', 'harvest time'), false)
  assert.deepStrictEqual(api.said, [])
  const log = fs.readFileSync(api.statePath('chat-nearmiss.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.strictEqual(log.length, 1)
  assert.strictEqual(log[0].text, 'harvest time')
  assert.strictEqual(log[0].guess, 'time')
})

test('register: a command nobody handled returns false so the integrator acks and logs it', () => {
  const api = fakeApi({ handled: () => false })
  const mod = register(api)
  assert.strictEqual(mod.fallback('OGWO', 'folow me'), false)
  assert.ok(api.logs.some(l => /NOT handled/.test(l)))
})

test('register: only the owner is obeyed', () => {
  const api = fakeApi()
  const mod = register(api)
  assert.strictEqual(mod.fallback('SomeoneElse', 'folow me'), false)
  assert.strictEqual(mod.onChat('SomeoneElse', 'yes'), false)
  assert.deepStrictEqual(api.dispatched, [])
})

test('register: remembers what ran ("do that again"), picks up waypoints.json changes, status() is JSON', () => {
  const api = fakeApi()
  const mod = register(api)
  mod.fallback('OGWO', 'go to the farm')
  assert.deepStrictEqual(api.dispatched, ['go to farm'])
  mod.fallback('OGWO', 'do that agian')
  assert.deepStrictEqual(api.dispatched, ['go to farm', 'go to farm'])
  const wp = JSON.parse(fs.readFileSync(path.join(api.dir, 'waypoints.json'), 'utf8'))
  wp['sheep pen'] = { x: 1, y: 2, z: 3 }
  fs.writeFileSync(path.join(api.dir, 'waypoints.json'), JSON.stringify(wp))
  const later = new Date(Date.now() + 5000); fs.utimesSync(path.join(api.dir, 'waypoints.json'), later, later)
  mod.fallback('OGWO', 'walk to the sheep pen')
  assert.strictEqual(api.dispatched[2], 'go to sheep pen')
  assert.doesNotThrow(() => JSON.stringify(mod.status()))
  assert.ok(mod.status().run >= 3)
})

test('register: survives a bot with no registry and a missing waypoints file', () => {
  const api = fakeApi()
  api.bot = {}
  fs.unlinkSync(path.join(api.dir, 'waypoints.json'))
  const mod = register(api)
  assert.strictEqual(mod.fallback('OGWO', 'folow me'), true)
  assert.strictEqual(mod.fallback('OGWO', 'go to the farm'), false, 'no such waypoint: never guess a job instead')
})

// ---------------------------------------------------------------- brain/crafting: craft <item> [count], find <item> ----

const CRAFTING_CMDS = [
  { name: 'craft-item', help: 'craft <item> [count]', risk: 'high', canonical: ['craft <item> [count]'] },
  { name: 'find-item', help: 'find <item>', risk: 'low', canonical: ['find <item>'] }
]
const withCrafting = () => mk({ getCommands: () => CRAFTING_CMDS })

test('craft: item and count slots from fuzzy phrasings', () => {
  const m = withCrafting()
  const c = (t) => { const d = m.decide('OGWO', t); return d.type === 'run' ? d.canonical : d.type + ':' + (d.result ? d.result.canonical : d.text) }
  assert.strictEqual(c('make me some torches'), 'craft torch')
  assert.strictEqual(c('can u craft 10 glass panes'), 'craft glass pane 10')
  assert.strictEqual(c('craft glass pane x16'), 'craft glass pane 16')
  assert.strictEqual(c('craft 16 glass pane'), 'craft glass pane 16')
  assert.strictEqual(c('make me a chest'), 'craft chest')
  assert.strictEqual(c('create a stack of sticks'), 'craft stick 64')
  assert.strictEqual(c('hey bot, would you make 4 chests please?'), 'craft chest 4')
  assert.strictEqual(c('craft a dozen torches'), 'craft torch 12')
  assert.strictEqual(c('make yourself a stone pickaxe'), 'craft stone pickaxe')
  assert.strictEqual(c('could you craft me three iron ingots'), 'craft iron ingot 3')
  assert.strictEqual(c('craft planks'), 'craft planks')            // a family: brain/crafting asks which wood
  assert.strictEqual(c('craft pickaxe'), 'craft pickaxe')
})

test('craft: a typo is confirmed before it is crafted; unknown words are not claimed', () => {
  const m = withCrafting()
  let d = m.decide('OGWO', 'can u craft 10 galss panes')
  assert.strictEqual(d.type, 'ask')
  assert.strictEqual(d.question, 'Did you mean "craft glass pane 10"? (yes/no)')
  assert.strictEqual(m.decide('OGWO', 'yes').canonical, 'craft glass pane 10')
  d = m.decide('OGWO', 'make me some tourches')
  assert.strictEqual(d.type, 'ask'); assert.strictEqual(d.result.canonical, 'craft torch')
  for (const t of ['make sure you are careful', 'make it rain', 'craft flurbwidget', 'how do you craft a torch', 'crafting is fun', 'i want to make a base', 'make a note of this']) {
    assert.strictEqual(m.decide('OGWO', t).type, 'none', t)
  }
})

test('craft: the tool-set job keeps its own intent, and the item rule needs the crafting module', () => {
  const m = withCrafting()
  for (const t of ['craft tools', 'make yourself some tools', 'make yourself a basic tool set', 'craft a tool set']) assert.strictEqual(m.decide('OGWO', t).canonical, 'craft tool set', t)
  const bare = mk({ getCommands: () => [] })
  assert.strictEqual(bare.decide('OGWO', 'make me some torches').type, 'none')
  assert.strictEqual(mk({ getCommands: () => [] }).decide('OGWO', 'follow me').canonical, 'follow me')
})

test('find: plain items (not blocks) are searched when brain/crafting is present', () => {
  const m = withCrafting()
  assert.strictEqual(m.decide('OGWO', 'find iron ingots').canonical, 'find iron ingot')
  assert.strictEqual(m.decide('OGWO', 'where are the glass panes').canonical, 'find glass pane')
  assert.strictEqual(m.decide('OGWO', 'find the secret base').type, 'none')
  assert.strictEqual(mk({ getCommands: () => [] }).decide('OGWO', 'find iron ingots').type, 'none', 'legacy find only knows blocks')
})

test('the "<item>" help texts do not become literal phrases', () => {
  const m = withCrafting()
  assert.notStrictEqual(m.decide('OGWO', 'craft item').type, 'run', 'a single partial hit (item_frame) is confirmed, never run')
  assert.ok(!m.decide('OGWO', 'craft item').result || m.decide('OGWO', 'craft item').result.canonical !== 'craft <item> [count]')
})
