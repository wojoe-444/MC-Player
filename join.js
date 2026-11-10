const mineflayer = require('mineflayer')
// The LAN port changes every time Walter reopens the world: lan-port.txt (first line) or env MC_PORT; 56585 is the last known value.
// Smeo444's cached Minecraft token kept failing with "Profile not found" on every reconnect (the profile was created after its first sign-in);
// for that account (MC_FRESH_MCA_TOKEN=1), fetch a fresh one each start from the cached Xbox tokens (no new sign-in)
if (!process.env.MC_EMAIL) { console.error('MC_EMAIL is not set (the Microsoft account email for this bot; see bots/README.md)'); process.exit(1) }
if (process.env.MC_FRESH_MCA_TOKEN) { try { for (const f of require('fs').readdirSync('auth-cache')) if (/_mca-cache\.json$/.test(f)) require('fs').unlinkSync('auth-cache/' + f) } catch {} }
const LAN_PORT = Number(process.env.MC_PORT) || (() => { try { return parseInt(require('fs').readFileSync('lan-port.txt', 'utf8'), 10) } catch { return 0 } })() || 56585
const bot = mineflayer.createBot({
  // MC_EMAIL: a second bot account runs this same code from its own folder (cwd = its state, logs and auth cache)
  host: 'localhost', port: LAN_PORT, username: process.env.MC_EMAIL,
  auth: 'microsoft', version: '1.21.6', profilesFolder: './auth-cache',
  disableChatSigning: true // signed-chat acknowledgements break after incoming chat and the server kicks with chat_validation_failed
})
// The packet gate (brain/gate, rules in brain/gate/rules.json): every rule of play checked where packets leave the bot. noArmor and chatRate are enforced, the rest log only: violations are
// recorded with their call site in brain/state/gate-log.json (read it with `node tools/gate-report.js`) and the packet goes out unchanged. GATE=off disables it.
if (process.env.GATE !== 'off') { try { require('./brain/gate').install(bot, { stateDir: require('path').join(process.cwd(), 'brain', 'state'), log: (l) => console.log('[gate] ' + l) }) } catch (e) { console.log('gate not installed: ' + e.message) } }
// Body lease, watch stage (brain/motor/lease.js): which loops flip the same movement key against each other. Records only; brain/state/lease-log.json, `node tools/lease-report.js`. LEASE=off disables it.
if (process.env.LEASE !== 'off') { try { require('./brain/motor/lease').install(bot, { stateDir: require('path').join(process.cwd(), 'brain', 'state'), log: (l) => console.log('[lease] ' + l) }) } catch (e) { console.log('lease not installed: ' + e.message) } }
// NO ARMOR (Walter 2026-11-10, Act 2) until diamond gear with Mending: the rule sits on bot.equip itself, so no module, timer or planner tool can
// put armor on (join.js's own 8 s wearArmor timer did, after #188 closed the brain modules). Lifted by ALLOW_ARMOR=1 or gear.allowArmor = true.
const armorAllowed = () => process.env.ALLOW_ARMOR === '1' || !!require('./brain/safety/gear').allowArmor
{ const eq = bot.equip; bot.equip = async function (item, dest) { if (/^(head|torso|legs|feet)$/.test(String(dest)) && !armorAllowed()) throw new Error('no armor (Act 2 rule)'); return eq.apply(this, arguments) } }
bot._armorAllowed = armorAllowed
// Every placement looks at its target at once. mineflayer's placeBlock turns the head without forcing it (about 0.15 rad a tick), so
// at the top of a pillar jump the place went out ticks later with the feet back in the cell: the server refused it. In the lab (PR #206) the
// default waited 10.6 ticks and ended with the feet in the cell in 19 of 30 runs; forceLook waited 0 ticks, 0 of 30. One wrapper here covers
// every caller (seven pillar copies, torches, farms, builds, entomb).
function forcePlaceLook() {
  if (bot._placeForced || typeof bot._placeBlockWithOptions !== 'function') return
  bot._placeForced = true
  bot.placeBlock = (ref, face) => bot._placeBlockWithOptions(ref, face, { forceLook: true, swingArm: 'right' })
}
forcePlaceLook(); bot.once('login', forcePlaceLook); bot.once('spawn', forcePlaceLook)
// Keep the recipe book the server sends at login (before the crafting module loads; mineflayer drops it). Used for fast bulk crafting (brain/crafting).
bot._recipeBook = new Map()
// damage types arrive once, in the configuration phase: kept so each damage_event can be named (Walter: which hits come from berry bushes?)
bot._client.on('registry_data', (p) => { try { if (/damage_type$/.test(p.id)) { bot._damageTypes = p.entries.map(e => e.key.replace(/^minecraft:/, '')); require('fs').mkdirSync('brain/state', { recursive: true }); require('fs').writeFileSync('brain/state/damage-types.json', JSON.stringify(bot._damageTypes)) } } catch {} })
bot._client.on('recipe_book_add', (p) => { if (p.replace) bot._recipeBook.clear(); for (const e of p.entries || []) bot._recipeBook.set(e.recipe.displayId, e.recipe.display) })
bot._client.on('recipe_book_remove', (p) => { for (const id of p.recipeIds || []) bot._recipeBook.delete(id) })
const FABRIC = ['fabric:registry/sync/direct','fabric:registry/sync/nbt','fabric:registry/sync/complete','fabric:accepted_attachments_v1','c:version','c:register','fabric:custom_ingredient_sync']
const c = bot._client
c.on('custom_payload', (p) => {
  console.log('CP', c.state, p.channel, p.data && p.data.length, p.channel.startsWith('c:') || p.channel.startsWith('forge') ? Buffer.from(p.data).toString('hex') : '')
  if (c.state !== 'configuration') return
  if (p.channel === 'minecraft:register') c.write('custom_payload', { channel: 'minecraft:register', data: Buffer.from(FABRIC.join('\0')) })
  else if (p.channel === 'fabric:accepted_attachments_v1') c.write('custom_payload', { channel: 'fabric:accepted_attachments_v1', data: Buffer.from([0]) })
  else if (p.channel === 'fabric:custom_ingredient_sync') c.write('custom_payload', { channel: 'fabric:custom_ingredient_sync', data: Buffer.from([1, 0]) })
  else if (p.channel === 'c:version') c.write('custom_payload', { channel: 'c:version', data: Buffer.from([1, 1]) })
  else if (p.channel === 'c:register') {
    const d = Buffer.from(p.data)
    const head = d.subarray(0, 2 + d[1]) // version varint + phase string
    c.write('custom_payload', { channel: 'c:register', data: Buffer.concat([head, Buffer.from([0])]) })
  }
  else if (p.channel === 'fabric:registry/sync/direct' && p.data.length === 0) c.write('custom_payload', { channel: 'fabric:registry/sync/complete', data: Buffer.alloc(0) })
})
c.on('state',(s) => console.log('STATE', s))
bot.once('login', () => console.log('LOGIN'))
bot.once('spawn', () => {
  const p = bot.entity.position
  console.log('SPAWNED', bot.username, bot.version, p.x.toFixed(1), p.y.toFixed(1), p.z.toFixed(1), bot.game.dimension, bot.game.gameMode)
  console.log('PLAYERS', Object.keys(bot.players).join(','))
  if (!process.env.SKIP_HELLO) bot.chat("Hello from Walter's Claude agent (alt account)! Just saying hi.")
  setTimeout(() => { const me = bot.entity.position; const o = bot.players.OGWO; console.log('STATUS', JSON.stringify({ health: bot.health, food: bot.food, time: bot.time.timeOfDay, ogwo: o && o.entity ? { pos: o.entity.position, dist: o.entity.position.distanceTo(me) } : 'not in range', mobs: Object.values(bot.entities).filter(e => e.type === 'hostile').length })) }, 6000)
})
// Movement only: pathfinder is configured so it never digs or places blocks.
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
let mineflayerViewer = null
try { mineflayerViewer = require('prismarine-viewer').mineflayer } catch (e) { console.log('VIEWER_UNAVAILABLE', e.message.split('\n')[0]) }
bot.loadPlugin(pathfinder)
let BRAIN = null // set by the brain loader near the bottom of this file (brain/index.js); null = legacy behaviour
const isDoorName = (n) => (n.endsWith('_door') && n !== 'iron_door') || n.endsWith('_fence_gate')
function setupMovement() {
  const mv = new Movements(bot)
  mv.canDig = false
  mv.allow1by1towers = false
  mv.allowParkour = false
  mv.scafoldingBlocks = []
  mv.maxDropDown = 3
  mv.infiniteLiquidDropdownDistance = false // the library lets bots drop any height into water; that took the bot 120 blocks down a water shaft
  mv.canOpenDoors = false // doors/gates are handled by tendDoors() below, not by the library
  // Never walk through these (fire, webs and lava are already avoided by default).
  for (const n of ['cactus', 'sweet_berry_bush', 'magma_block', 'campfire', 'soul_campfire', 'soul_fire', 'powder_snow', 'wither_rose', 'pointed_dripstone', 'bamboo_sapling']) {
    const b = bot.registry.blocksByName[n]; if (b) mv.blocksToAvoid.add(b.id)
  }
  const floorHazards = new Set(['magma_block', 'campfire', 'soul_campfire', 'cactus'].map(n => bot.registry.blocksByName[n]?.id).filter(Boolean))
  // Closed doors/gates count as passable for planning; tendDoors() opens them as the bot arrives and closes them behind.
  const origGetBlock = mv.getBlock.bind(mv)
  mv.getBlock = (pos, dx, dy, dz) => {
    const b = origGetBlock(pos, dx, dy, dz)
    if (b && b.name && isDoorName(b.name)) { b.physical = false; b.safe = true }
    else if (b && floorHazards.has(b.type)) { b.physical = false; b.safe = false }
    return b
  }
  bot.pathfinder.setMovements(mv)
  bot.pathfinder.thinkTimeout = 4000
}

// --- Navigation wrapper: goal tracking, stuck recovery, door tending ---
let navGoal = null, navLabel = '', navDynamic = false, navLast = null, navStuckTicks = 0, navResets = 0
const openedByUs = new Map() // key -> block position (lower half for doors)
function navigate(goal, label, dynamic = false) { if (BRAIN) return BRAIN.navigate(goal, label, dynamic); return navigateRaw(goal, label, dynamic) }
function navigateRaw(goal, label, dynamic = false) {
  navGoal = goal; navLabel = label || ''; navDynamic = dynamic
  navLast = bot.entity.position.clone(); navStuckTicks = 0; navResets = 0
  bot.pathfinder.setGoal(goal, dynamic)
}
function stopNav() { navGoal = null; bot.pathfinder.setGoal(null); bot.clearControlStates() }
function doorKey(b) {
  const pr = b.getProperties ? b.getProperties() : {}
  const y = (pr.half === 'upper') ? b.position.y - 1 : b.position.y
  return `${b.position.x},${y},${b.position.z}`
}
async function tendDoors() {
  if (!navGoal && openedByUs.size === 0) return
  const me = bot.entity.position
  try {
    if (navGoal) {
      const ids = bot.registry.blocksArray.filter(b => isDoorName(b.name)).map(b => b.id)
      for (const p of bot.findBlocks({ matching: ids, maxDistance: 3, count: 12 })) {
        const b = bot.blockAt(p); if (!b) continue
        const pr = b.getProperties ? b.getProperties() : {}
        if (pr.open === true || pr.half === 'upper') continue
        if (Math.hypot(p.x + 0.5 - me.x, p.z + 0.5 - me.z) > 2.2 || Math.abs(p.y - me.y) > 2) continue
        openedByUs.set(doorKey(b), p.clone())
        await bot.activateBlock(b)
      }
    }
    for (const [k, p] of [...openedByUs]) {
      const d = Math.hypot(p.x + 0.5 - me.x, p.z + 0.5 - me.z)
      if (d >= 3.2 && d <= 4.4 && Math.abs(p.y - me.y) <= 3) {
        const b = bot.blockAt(p)
        if (b && b.getProperties && b.getProperties().open === true) await bot.activateBlock(b)
        openedByUs.delete(k)
      } else if (d > 4.4) openedByUs.delete(k)
    }
  } catch (e) { /* door interaction is best effort */ }
}
setInterval(tendDoors, 200)
// Stuck watchdog: every 2s, if we should be moving but made < 0.4 blocks of progress, jump and re-plan; give up after 3 tries.
setInterval(() => {
  if (!navGoal || !bot.entity) return
  const p = bot.entity.position
  if (bot.pathfinder.isMoving() || !navDynamic) {
    if (navLast && p.distanceTo(navLast) < 0.4) navStuckTicks++; else navStuckTicks = 0
    navLast = p.clone()
    if (navStuckTicks >= 3) {
      navStuckTicks = 0; navResets++
      if (navResets > 3) { const g = navGoal; stopNav(); say(`I'm stuck at ${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)} and can't reach ${navLabel || 'there'}.`); return }
      bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 400)
      bot.pathfinder.setGoal(null); setTimeout(() => navGoal && bot.pathfinder.setGoal(navGoal, navDynamic), 500)
    }
  }
}, 2000)
bot.on('goal_reached', () => { if (!navDynamic) navGoal = null })
bot.once('spawn', () => {
  setupMovement()
  try { if (mineflayerViewer) mineflayerViewer(bot, { port: Number(process.env.VIEWER_PORT) || 3007, firstPerson: true, viewDistance: 6 }); console.log('VIEWER http://localhost:' + (Number(process.env.VIEWER_PORT) || 3007)) }
  catch (e) { console.log('VIEWER_ERROR', e.message) }
  if (process.env.PENDING_CMD) setTimeout(() => handleCommand('OGWO', process.env.PENDING_CMD), 8000)
})
// Outgoing chat is queued, one message per 1.2s, with consecutive duplicates dropped: sending bursts gets the bot
// kicked ("chat_validation_failed") and floods Walter's chat.
const chatQueue = []
let lastSaid = ''
function say(t) {
  // Walter: keep raw diagnostics like "furnace lit=true" out of chat; they go to furnace-debug.log instead.
  if (/\blit=(true|false)\b/.test(t)) { try { require('fs').appendFileSync('furnace-debug.log', `${new Date().toISOString()} ${t}\n`) } catch {} return }
  if (t === lastSaid && chatQueue.length) return
  // Walter: no routine narration, and the same line at most once per 5 minutes.
  if (NARRATION.test(String(t).trim())) { try { require('fs').appendFileSync('narration.log', `${new Date().toISOString()} ${t}
`) } catch {} return }
  const nowMs = Date.now(), prev = saidAt.get(t)
  if (prev && nowMs - prev < 300000) return
  saidAt.set(t, nowMs); if (saidAt.size > 300) { for (const [k, v] of saidAt) if (nowMs - v > 300000) saidAt.delete(k) }
  lastSaid = t; chatQueue.push(t)
}
const saidAt = new Map()
const NARRATION = /^\((?:Pausing|Starting|Finished|Going back|Resuming|Queued|Holding|Done|Paused|Cancell?ed)\b.*\)\.?$|^It's night\. Heading to the bed|^In bed\.$|^Awake\.$|^Clear\.$|^Sleeping through this night|^Backing away \(no sword\)|^(?:zombie|skeleton|creeper|spider|husk|drowned|witch|enderman)\b.*\b(?:approaching|blocks?)\b/i
// Survival-only rule: the bot never sends a slash command (no /tp, /gamemode, /give ...), whatever the text says.
// One exception, for the survival-trial harness only (brain/survival): "/time set 1000" resets a night-start life to day (Walter 2026-11-01, cheats on).
// Harness reset commands only (Walter 2026-11-03: the goal is hillclimbing, not a no-cheats run; break looped failures with commands): time reset, teleport home, set the respawn point.
// 2026-11-04 Walter: looped failures should be reset with commands (creative to put a bed back, etc.), the goal is hillclimbing, not a no-cheats run.
// Still only commands about the bot itself: time, its position, its respawn point, its game mode, items given to it.
let RESET_CMD = /^$/
bot.once('login', () => { const n = bot.username.replace(/[^A-Za-z0-9_]/g, ''); RESET_CMD = new RegExp(String.raw`^\/(time set (1000|day)|tp ${n} -?\d+ -?\d+ -?\d+|spawnpoint ${n} -?\d+ -?\d+ -?\d+|gamemode (creative|survival) ${n}|give ${n} [a-z_]+( \d{1,3})?|effect clear ${n})$`) })
let lastChatSend = 0   // one message per 1.15 s at most (Walter's rate rule), sent as soon as that gap has passed instead of on a fixed 1.2 s tick
setInterval(() => { if (Date.now() - lastChatSend < 1150) return; const m = chatQueue.shift(); if (m) { lastChatSend = Date.now(); if (m.trim().startsWith('/') && !RESET_CMD.test(m.trim())) { console.log('BLOCKED_SLASH', m.slice(0, 60)); return } try { bot.chat(m) } catch (e) { console.log('CHAT_ERROR', e.message) } } }, 100)

// Crafting: only when Walter asks. Uses an existing crafting table (never places/breaks blocks).
let crafting = false
const count = (name) => bot.inventory.items().filter(i => i.name === name).reduce((s, i) => s + i.count, 0)
async function craftItem(name, n, table) {
  const id = bot.registry.itemsByName[name].id
  const recipe = bot.recipesFor(id, null, 1, table)[0]
  if (!recipe) throw new Error(`no recipe/ingredients for ${name}`)
  await bot.craft(recipe, n, table)
}
async function craftToolSet() {
  if (crafting) return say('Already working on it.')
  crafting = true
  try {
    const logs = bot.inventory.items().filter(i => i.name.endsWith('_log') || i.name.endsWith('_stem'))
    const plankName = logs.length ? logs[0].name.replace(/_(log|stem)$/, m => m === '_stem' ? '_planks' : '_planks') : null
    const cobble = count('cobblestone')
    const havePlanks = bot.inventory.items().filter(i => i.name.endsWith('_planks')).reduce((s, i) => s + i.count, 0)
    say(`I have ${cobble} cobblestone, ${logs.reduce((s, i) => s + i.count, 0)} logs, ${havePlanks} planks.`)
    const table = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 64 })
    if (!table) { say("I can't find a crafting table within 64 blocks. Point me to one (or say where) and ask again."); return }
    say(`Found a crafting table at ${table.position.x}, ${table.position.y}, ${table.position.z}. Heading there.`)
    navGoal = new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2); navDynamic = false; navLabel = 'the crafting table'
    try { await bot.pathfinder.goto(navGoal) } finally { navGoal = null }
    // Needs: 11 cobble (pick 3, axe 3, shovel 1, sword 2, hoe 2), 9 sticks (5 craft = 10), so 10+ planks.
    const need = { stone_pickaxe: 1, stone_axe: 1, stone_shovel: 1, stone_sword: 1, stone_hoe: 1 }
    const useStone = cobble >= 11
    const planksNeeded = (useStone ? 10 : 10 + 11) // sticks + (wooden tools need 11 planks)
    const planksNow = () => bot.inventory.items().filter(i => i.name.endsWith('_planks')).reduce((s, i) => s + i.count, 0)
    while (planksNow() < planksNeeded && bot.inventory.items().some(i => i.name.endsWith('_log'))) {
      const log = bot.inventory.items().find(i => i.name.endsWith('_log'))
      await craftItem(log.name.replace('_log', '_planks'), 1, null)
    }
    if (planksNow() < 10) throw new Error(`only ${planksNow()} planks, need at least 10`)
    await craftItem('stick', 5, null)
    const kit = useStone ? ['stone_pickaxe', 'stone_axe', 'stone_shovel', 'stone_sword', 'stone_hoe'] : ['wooden_pickaxe', 'wooden_axe', 'wooden_shovel', 'wooden_sword', 'wooden_hoe']
    for (const k of kit) await craftItem(k, 1, table)
    say(`Done: crafted ${kit.map(k => k.replace(/_/g, ' ')).join(', ')}.`)
  } catch (e) {
    say(`Couldn't finish crafting: ${e.message}`.slice(0, 230))
    console.log('CRAFT_ERROR', e.stack)
  } finally { crafting = false }
}
// Navigation self-test: visits one of each landmark near the bot, logs success/failure to nav-test.log. Movement only.
let testing = false
async function tryGoto(goal, label, ms = 45000, opts = {}) {
  // With the brain's nav module loaded every go-to is nav's escalating one (brain/nav/reach.js): normal path first, then digging planner,
  // tunnel / bridge / pillar, sidesteps, and base blocks it broke are put back. `opts.escalate === false` keeps it to one plain attempt.
  const navApi = BRAIN && BRAIN.api && BRAIN.api.nav
  if (navApi && navApi.goto) {
    const prevQuiet = quietNav; quietNav = true
    try { return await navApi.goto(goal, { label, ms, ...opts }) } finally { quietNav = prevQuiet }
  }
  const t0 = Date.now()
  navGoal = goal; navDynamic = false; navLabel = label; navLast = bot.entity.position.clone(); navStuckTicks = 0; navResets = 0
  let timer
  const prevQuiet = quietNav; quietNav = true // internal moves never announce "Here."
  try {
    await Promise.race([bot.pathfinder.goto(goal), new Promise((_, rj) => { timer = setTimeout(() => rj(new Error('timeout')), ms) })])
    return { label, ok: true, secs: +((Date.now() - t0) / 1000).toFixed(1) }
  } catch (e) {
    return { label, ok: false, secs: +((Date.now() - t0) / 1000).toFixed(1), err: e.message }
  } finally { clearTimeout(timer); bot.pathfinder.setGoal(null); navGoal = null; quietNav = prevQuiet }
}
async function runNavTest() {
  if (testing) return say('Navigation test already running.')
  testing = true; quietNav = true
  const fs = require('fs'), start = bot.entity.position.clone(), out = []
  const reg = bot.registry
  const idsOf = (pred) => reg.blocksArray.filter(b => pred(b.name)).map(b => b.id)
  const kinds = [
    ['crafting table', idsOf(n => n === 'crafting_table')],
    ['door', idsOf(n => n.endsWith('_door') && n !== 'iron_door')],
    ['fence gate', idsOf(n => n.endsWith('_fence_gate'))],
    ['ladder', idsOf(n => n === 'ladder')],
    ['stairs', idsOf(n => n.endsWith('_stairs'))],
    ['bed', idsOf(n => n.endsWith('_bed'))],
    ['chest', idsOf(n => n === 'chest' || n === 'barrel')]
  ]
  say('Starting navigation test: visiting a few landmarks. Say "stop" to cancel.')
  for (const [name, ids] of kinds) {
    if (!testing) break
    const pts = bot.findBlocks({ matching: ids, maxDistance: 48, count: 20 })
    if (!pts.length) { out.push({ label: name, ok: null, err: 'none within 48 blocks' }); continue }
    pts.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
    const p = pts[0]
    const r = await tryGoto(new goals.GoalNear(p.x, p.y, p.z, name === 'door' || name === 'fence gate' ? 1 : 2), `${name} at ${p.x}, ${p.y}, ${p.z}`)
    out.push(r)
    fs.appendFileSync('nav-test.log', JSON.stringify(r) + '\n')
  }
  const back = await tryGoto(new goals.GoalNear(start.x, start.y, start.z, 2), 'back to start')
  out.push(back)
  fs.appendFileSync('nav-test.log', JSON.stringify(back) + '\n')
  const open = [...openedByUs.keys()].length
  fs.appendFileSync('nav-test.log', JSON.stringify({ doorsStillOpenedByUs: open }) + '\n')
  const ok = out.filter(r => r.ok === true).length, bad = out.filter(r => r.ok === false), none = out.filter(r => r.ok === null)
  say(`Nav test: ${ok}/${out.length} ok.` + (bad.length ? ' Failed: ' + bad.map(r => `${r.label} (${r.err})`).join('; ') : '') + (none.length ? ' Not found: ' + none.map(r => r.label).join(', ') : ''))
  testing = false; quietNav = false
}

// Door test: find the nearest door/gate (up to 128 blocks), walk to one side, then through it to the other side, and report.
async function runDoorTest() {
  quietNav = true
  try {
    const Vec3 = require('vec3').Vec3
    const ids = bot.registry.blocksArray.filter(b => (b.name.endsWith('_door') && b.name !== 'iron_door') || b.name.endsWith('_fence_gate')).map(b => b.id)
    const pts = bot.findBlocks({ matching: ids, maxDistance: 128, count: 40 }).filter(p => { const b = bot.blockAt(p); const pr = b.getProperties ? b.getProperties() : {}; return pr.half !== 'upper' })
    if (!pts.length) return say('No doors or gates within 128 blocks of me, so I could not test them.')
    pts.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
    const p = pts[0], b = bot.blockAt(p), pr = b.getProperties()
    say(`Testing a ${b.name} at ${p.x}, ${p.y}, ${p.z}, ${Math.round(p.distanceTo(bot.entity.position))} blocks away.`)
    // door axis: facing north/south => passage runs along z; east/west => along x
    const alongZ = ['north', 'south'].includes(pr.facing)
    const dir = alongZ ? { x: 0, z: 1 } : { x: 1, z: 0 }
    const sideA = { x: p.x - dir.x * 2, z: p.z - dir.z * 2 }, sideB = { x: p.x + dir.x * 2, z: p.z + dir.z * 2 }
    const me = bot.entity.position
    const near = me.distanceTo(new Vec3(sideA.x, p.y, sideA.z)) < me.distanceTo(new Vec3(sideB.x, p.y, sideB.z))
    const [from, to] = near ? [sideA, sideB] : [sideB, sideA]
    const r1 = await tryGoto(new goals.GoalNear(from.x, p.y, from.z, 1), 'approach side', 90000)
    if (!r1.ok) return say(`Could not even reach the near side of the door: ${r1.err}.`)
    const r2 = await tryGoto(new goals.GoalNear(to.x, p.y, to.z, 1), 'through the door', 30000)
    await new Promise(r => setTimeout(r, 2500))
    const still = bot.blockAt(p), open = !!(still && still.getProperties && still.getProperties().open === true)
    say(r2.ok ? `Went through the door in ${r2.secs}s. Door is now ${open ? 'still OPEN (did not close it)' : 'closed again'}.` : `Could not get through the door: ${r2.err}.`)
    require('fs').appendFileSync('nav-test.log', JSON.stringify({ door: b.name, at: p, approach: r1, through: r2, openAfter: open }) + '\n')
  } catch (e) { say(`Door test error: ${e.message}`.slice(0, 200)) } finally { quietNav = false }
}

// Room scan (read-only): flood-fills open space around the bot, reports size/materials/exits and writes room-map.txt layer by layer.
function describeRoom() {
  const Vec3 = require('vec3').Vec3
  const start = bot.entity.position.floored()
  const LIMIT = 30000, R = 24
  const seen = new Set(), queue = [start], cells = []
  const key = (v) => `${v.x},${v.y},${v.z}`
  const passable = (v) => { const b = bot.blockAt(v); return b && b.boundingBox === 'empty' }
  seen.add(key(start))
  let leaked = false, unloaded = 0
  const dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]
  while (queue.length && cells.length < LIMIT) {
    const v = queue.shift(); cells.push(v)
    for (const [dx, dy, dz] of dirs) {
      const n = v.offset(dx, dy, dz)
      if (seen.has(key(n))) continue
      if (Math.abs(n.x - start.x) > R || Math.abs(n.z - start.z) > R || Math.abs(n.y - start.y) > R) { leaked = true; continue }
      const b = bot.blockAt(n)
      if (!b) { unloaded++; continue }
      if (b.boundingBox === 'empty' && !isDoorName(b.name)) { seen.add(key(n)); queue.push(n) }
    }
  }
  const xs = cells.map(c => c.x), ys = cells.map(c => c.y), zs = cells.map(c => c.z)
  const min = new Vec3(Math.min(...xs), Math.min(...ys), Math.min(...zs)), max = new Vec3(Math.max(...xs), Math.max(...ys), Math.max(...zs))
  const cellSet = new Set(cells.map(key))
  const tally = (m, n) => { m[n] = (m[n] || 0) + 1 }
  const floor = {}, ceiling = {}, walls = {}, exits = []
  for (const c of cells) {
    const below = bot.blockAt(c.offset(0, -1, 0)), above = bot.blockAt(c.offset(0, 1, 0))
    if (below && !cellSet.has(key(c.offset(0, -1, 0))) && below.boundingBox !== 'empty') tally(floor, below.name)
    if (above && !cellSet.has(key(c.offset(0, 1, 0))) && above.boundingBox !== 'empty') tally(ceiling, above.name)
    for (const [dx, , dz] of [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]) {
      const n = bot.blockAt(c.offset(dx, 0, dz)); if (!n) continue
      if (n.boundingBox !== 'empty') { tally(walls, n.name); if (isDoorName(n.name) || /trapdoor|glass|ladder/.test(n.name)) exits.push(`${n.name} @ ${n.position.x},${n.position.y},${n.position.z}`) }
    }
  }
  const top = (m, k = 4) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, k).map(([n, c]) => n).join('/')
  // layer map
  const lines = [`Room scan from ${start.x},${start.y},${start.z}; bbox ${min.x},${min.y},${min.z} to ${max.x},${max.y},${max.z}; cells ${cells.length}; leaked=${leaked}; unloadedEdges=${unloaded}`, "Legend: '.' open, '#' solid, '@' bot, '~' liquid, 'D' door/gate, '+' ladder/other non-solid-but-not-air", '']
  for (let y = max.y + 1; y >= min.y - 1; y--) {
    lines.push(`--- y=${y} (rows z=${min.z - 1}..${max.z + 1}, cols x=${min.x - 1}..${max.x + 1}) ---`)
    for (let z = min.z - 1; z <= max.z + 1; z++) {
      let row = ''
      for (let x = min.x - 1; x <= max.x + 1; x++) {
        const b = bot.blockAt(new Vec3(x, y, z))
        const isMe = x === start.x && y === start.y && z === start.z
        row += isMe ? '@' : !b ? '?' : cellSet.has(`${x},${y},${z}`) ? '.' : isDoorName(b.name) ? 'D' : /water|lava/.test(b.name) ? '~' : b.boundingBox === 'empty' ? (b.name === 'air' || b.name === 'cave_air' ? ' ' : '+') : '#'
      }
      lines.push(row)
    }
  }
  require('fs').writeFileSync('room-map.txt', lines.join('\n'))
  const dx = max.x - min.x + 1, dy = max.y - min.y + 1, dz = max.z - min.z + 1
  const closed = !leaked && unloaded === 0
  const lights = bot.findBlocks({ matching: ['torch', 'lantern', 'glowstone', 'sea_lantern', 'shroomlight'].map(n => bot.registry.blocksByName[n]?.id).filter(Boolean), maxDistance: 12, count: 20 }).length
  say(`I'm at ${start.x}, ${start.y}, ${start.z}. The open space around me is ${dx} x ${dz} blocks wide (x ${min.x}..${max.x}, z ${min.z}..${max.z}) and ${dy} tall (y ${min.y}..${max.y}), ${cells.length} open blocks, ${closed ? 'fully enclosed' : 'NOT fully enclosed (it connects out)'}.`)
  say(`Floor: ${top(floor) || 'none'}. Ceiling: ${top(ceiling) || 'open/none'}. Walls: ${top(walls)}. Exits/openings: ${exits.length ? [...new Set(exits)].slice(0, 4).join('; ') : 'none seen'}. Light sources nearby: ${lights}.`)
  return true
}

// Excavation job (see excavate.js). Auto-resumes after a reconnect if it was active.
const excavation = require('./excavate')({ bot, say, goals, tryGoto, isDoorName })
bot.once('spawn', () => setTimeout(() => { if (!BRAIN && excavation.shouldAutoResume()) excavation.resume() }, 12000))

// Furnace survey (read-only, opens nothing): clusters furnaces, notes hoppers/chests/droppers around them, signs, lit state.
function describeFurnaces() {
  const Vec3 = require('vec3').Vec3
  const id = (n) => bot.registry.blocksByName[n]?.id
  const furn = bot.findBlocks({ matching: [id('furnace'), id('blast_furnace'), id('smoker')].filter(Boolean), maxDistance: 160, count: 300 })
  if (!furn.length) return say('I cannot find any furnaces within 160 blocks of me.')
  const clusters = []
  for (const p of furn) { const c = clusters.find(c => c.pts.some(q => q.distanceTo(p) <= 6)); if (c) c.pts.push(p); else clusters.push({ pts: [p] }) }
  const lines = [`Furnace survey from ${bot.entity.position.floored()}; ${furn.length} furnaces in ${clusters.length} cluster(s)`]
  clusters.sort((a, b) => a.pts[0].distanceTo(bot.entity.position) - b.pts[0].distanceTo(bot.entity.position))
  clusters.forEach((c, i) => {
    const xs = c.pts.map(p => p.x), ys = c.pts.map(p => p.y), zs = c.pts.map(p => p.z)
    const min = new Vec3(Math.min(...xs) - 4, Math.min(...ys) - 3, Math.min(...zs) - 4), max = new Vec3(Math.max(...xs) + 4, Math.max(...ys) + 3, Math.max(...zs) + 4)
    const tally = {}, extra = []
    let lit = 0
    for (let x = min.x; x <= max.x; x++) for (let y = min.y; y <= max.y; y++) for (let z = min.z; z <= max.z; z++) {
      const b = bot.blockAt(new Vec3(x, y, z)); if (!b) continue
      if (/furnace|smoker/.test(b.name)) { const pr = b.getProperties ? b.getProperties() : {}; if (pr.lit) lit++ }
      if (/^(hopper|chest|trapped_chest|barrel|dropper|dispenser|observer|comparator|repeater|redstone_lamp|lever|button|stone_button|oak_button|piston|sticky_piston|lava|water|campfire)$/.test(b.name) || /_sign$|_wall_sign$/.test(b.name) || /furnace|smoker/.test(b.name)) {
        tally[b.name] = (tally[b.name] || 0) + 1
        if (/sign/.test(b.name)) { try { extra.push(`sign@${x},${y},${z}: ${b.getSignText().flat().join(' ').trim()}`) } catch {} }
        if (b.name === 'hopper') { const pr = b.getProperties(); extra.push(`hopper@${x},${y},${z} facing ${pr.facing}`) }
        if (/chest|barrel/.test(b.name)) { const pr = b.getProperties ? b.getProperties() : {}; extra.push(`${b.name}@${x},${y},${z} ${pr.facing ? 'facing ' + pr.facing : ''} ${pr.type && pr.type !== 'single' ? pr.type : ''}`.trim()) }
        if (b.name === 'lava') extra.push(`lava@${x},${y},${z}`)
      }
    }
    lines.push(`\n## Cluster ${i + 1}: ${c.pts.length} furnaces, ${lit} lit now; area ${min} .. ${max}`)
    lines.push('Nearby: ' + Object.entries(tally).map(([n, k]) => `${k} ${n}`).join(', '))
    lines.push(...extra.slice(0, 60))
    lines.push('Furnaces: ' + c.pts.slice(0, 40).map(p => `${p.x},${p.y},${p.z}`).join(' | '))
  })
  require('fs').writeFileSync('furnace-scan.txt', lines.join('\n'))
  const c0 = clusters[0], t = lines.slice(1).find(l => l.startsWith('Nearby:')) || ''
  say(`Found ${furn.length} furnaces in ${clusters.length} group(s). Nearest group: ${c0.pts.length} furnaces around ${c0.pts[0].x}, ${c0.pts[0].y}, ${c0.pts[0].z}. ${t}`.slice(0, 235))
}

// "find <thing>": block clusters within 160 blocks (partial names work: "bed" = any *_bed) plus chests that hold it
// according to chest-index.json. Read-only; full list in find-<name>.txt.
function loadChestIndex() { try { return JSON.parse(require('fs').readFileSync('chest-index.json', 'utf8').replace(/^﻿/, '')) } catch { return {} } }
function findBlocksCmd(raw) {
  const base = raw.trim().replace(/\s+/g, '_').replace(/([^s])s$/, '$1') // plural -> singular, but keep glass/moss/grass
  const names = bot.registry.blocksArray.map(b => b.name).filter(n => n === base || n === base + '_block' || n.endsWith('_' + base))
  const idx = loadChestIndex()
  const inChests = Object.entries(idx).filter(([, v]) => v.items && Object.keys(v.items).some(n => n.includes(base))).map(([k, v]) => `${k}: ${Object.entries(v.items).filter(([n]) => n.includes(base)).map(([n, c]) => c + ' ' + n).join(', ')}`)
  const me = bot.entity.position
  let msg = ''
  if (names.length) {
    const ids = names.map(n => bot.registry.blocksByName[n].id)
    const pts = bot.findBlocks({ matching: ids, maxDistance: 160, count: 1500 })
    if (pts.length) {
      const groups = []
      for (const p of pts) { const g = groups.find(g => g.pts.some(q => q.distanceTo(p) <= 6)); if (g) g.pts.push(p); else groups.push({ pts: [p] }) }
      groups.sort((x, y) => x.pts[0].distanceTo(me) - y.pts[0].distanceTo(me))
      const desc = groups.map((g, i) => { const xs = g.pts.map(p => p.x), ys = g.pts.map(p => p.y), zs = g.pts.map(p => p.z); return `#${i + 1}: ${g.pts.length}x at x ${Math.min(...xs)}..${Math.max(...xs)}, y ${Math.min(...ys)}..${Math.max(...ys)}, z ${Math.min(...zs)}..${Math.max(...zs)}` })
      require('fs').writeFileSync(`find-${base}.txt`, [desc.join(String.fromCharCode(10)), '', pts.map(p => `${p.x},${p.y},${p.z}`).join(String.fromCharCode(10)), '', 'In chests:', inChests.join(String.fromCharCode(10))].join(String.fromCharCode(10)))
      msg = `${pts.length} ${base} blocks in ${groups.length} group(s). ${desc.slice(0, 2).join(' ; ')}`
    }
  }
  if (inChests.length) msg += ` Chests holding ${base}: ${inChests.slice(0, 3).join(' | ')}${inChests.length > 3 ? ' (+' + (inChests.length - 3) + ' more)' : ''}.`
  if (!msg) msg = names.length || Object.keys(idx).length ? `No ${base} found within 160 blocks${Object.keys(idx).length ? ' or in the ' + Object.keys(idx).length + ' chests I have indexed' : ' (say "index chests" and I will read the chests nearby)'}.` : `I don't know a block called "${raw.trim()}". Say "index chests" so I can also search chest contents.`
  say(msg.slice(0, 235))
}

// Chest index (read-only): walks to every chest/barrel within a radius, opens it just to read, never takes anything.
let indexing = false
async function indexChests(radius = 64) {
  if (indexing) return say('Already indexing chests.')
  indexing = true
  try {
    const fs = require('fs'), idx = loadChestIndex()
    const ids = ['chest', 'trapped_chest', 'barrel'].map(n => bot.registry.blocksByName[n].id)
    const me = bot.entity.position
    const pts = bot.findBlocks({ matching: ids, maxDistance: radius, count: 600 }).sort((p, q) => p.distanceTo(me) - q.distanceTo(me))
    const seen = new Set(), todo = []
    for (const p of pts) {
      if (seen.has(p.toString())) continue
      seen.add(p.toString())
      const blk = bot.blockAt(p), pr = blk.getProperties ? blk.getProperties() : {}
      if (pr.type === 'left' || pr.type === 'right') {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const q = p.offset(dx, 0, dz), bb = bot.blockAt(q); if (bb && bb.name === blk.name && !seen.has(q.toString()) && bb.getProperties().type && bb.getProperties().type !== 'single') { seen.add(q.toString()); break } }
      }
      todo.push(p)
    }
    say(`Indexing ${todo.length} chests within ${radius} blocks (read only, nothing taken). Say "stop" to cancel; then "find wool" etc. works from the index.`)
    let n = 0
    for (const p of todo) {
      if (!indexing) break
      const key = `${p.x},${p.y},${p.z}`
      const r = await tryGoto(new goals.GoalNear(p.x, p.y, p.z, 3), 'a chest', 30000)
      if (!r.ok && bot.entity.position.distanceTo(p.offset(0.5, 0.5, 0.5)) > 4.8) { idx[key] = { error: r.err, at: Date.now() }; continue }
      try {
        const cont = await bot.openContainer(bot.blockAt(p)), tally = {}
        for (const it of cont.containerItems()) tally[it.name] = (tally[it.name] || 0) + it.count
        idx[key] = { items: tally, slots: cont.inventoryStart, at: Date.now() }
        cont.close(); n++
      } catch (e) { idx[key] = { error: e.message, at: Date.now() } }
      if (n % 8 === 0) fs.writeFileSync('chest-index.json', JSON.stringify(idx))
      await new Promise(r => setTimeout(r, 250))
    }
    fs.writeFileSync('chest-index.json', JSON.stringify(idx))
    say(`Indexed ${n} chests (${Object.keys(idx).length} total in chest-index.json). Try "find wool".`)
  } catch (e) { say(`Chest indexing failed: ${e.message}`.slice(0, 200)); console.log('INDEX_ERROR', e.stack) } finally { indexing = false }
}

// Station inspection (read-only): opens each chest next to the furnace stations just to read its contents, takes nothing.
// Also surveys lava source blocks. Results -> stations.json / lava-scan.txt, summary in chat.
let inspecting = false
async function inspectStations() {
  if (inspecting) return say('Already inspecting.')
  inspecting = true
  try {
    const fs = require('fs'), Vec3 = require('vec3').Vec3
    const furn = bot.findBlocks({ matching: bot.registry.blocksByName.furnace.id, maxDistance: 160, count: 300 })
    const hoppers = new Set(bot.findBlocks({ matching: bot.registry.blocksByName.hopper.id, maxDistance: 160, count: 400 }).map(p => p.toString()))
    const stations = furn.filter(p => hoppers.has(p.offset(0, 1, 0).toString()) || hoppers.has(p.offset(0, -1, 0).toString()))
    const chestIds = ['chest', 'barrel'].map(n => bot.registry.blocksByName[n].id)
    const out = []
    const seen = new Set()
    // group stations by proximity
    const groups = []
    for (const p of stations) { const g = groups.find(g => g.some(q => q.distanceTo(p) <= 8)); if (g) g.push(p); else groups.push([p]) }
    for (const [gi, g] of groups.entries()) {
      const c = g[0]
      const chests = bot.findBlocks({ matching: chestIds, maxDistance: 160, count: 200 }).filter(p => p.distanceTo(c) <= 8 && !seen.has(p.toString()))
      const st = { station: gi + 1, furnaces: g.map(p => `${p.x},${p.y},${p.z}`), chests: [] }
      for (const p of chests) {
        seen.add(p.toString())
        const r = await tryGoto(new goals.GoalNear(p.x, p.y, p.z, 3), 'a chest', 40000)
        if (!r.ok && bot.entity.position.distanceTo(p.offset(0.5, 0.5, 0.5)) > 4.8) { st.chests.push({ at: `${p.x},${p.y},${p.z}`, error: r.err }); continue }
        try {
          const b = bot.blockAt(p)
          const cont = await bot.openContainer(b)
          const tally = {}
          for (const it of cont.containerItems()) tally[it.name] = (tally[it.name] || 0) + it.count
          const slots = cont.inventoryStart
          st.chests.push({ at: `${p.x},${p.y},${p.z}`, slots, used: cont.containerItems().length, items: tally })
          cont.close()
        } catch (e) { st.chests.push({ at: `${p.x},${p.y},${p.z}`, error: e.message }) }
        await new Promise(r => setTimeout(r, 300))
      }
      out.push(st)
    }
    fs.writeFileSync('stations.json', JSON.stringify(out, null, 2))
    for (const st of out) {
      const bits = st.chests.map(c => c.error ? `${c.at}: ERR` : `${c.at}: ${Object.entries(c.items).map(([n, k]) => `${k} ${n}`).join(', ') || 'empty'}`)
      say(`Station ${st.station} (${st.furnaces[0]}): ${bits.join(' | ')}`.slice(0, 235))
    }
    // lava survey: source blocks only
    const lavaId = bot.registry.blocksByName.lava.id
    const lava = bot.findBlocks({ matching: lavaId, maxDistance: 160, count: 3000 }).filter(p => { const b = bot.blockAt(p); const pr = b.getProperties ? b.getProperties() : {}; return pr.level === 0 || pr.level === undefined })
    const lg = []
    for (const p of lava) { const g = lg.find(g => g.pts.some(q => q.distanceTo(p) <= 5)); if (g) g.pts.push(p); else lg.push({ pts: [p] }) }
    const lines = lg.map((g, i) => { const xs = g.pts.map(p => p.x), ys = g.pts.map(p => p.y), zs = g.pts.map(p => p.z); return `lava body ${i + 1}: ${g.pts.length} source blocks, x ${Math.min(...xs)}..${Math.max(...xs)}, y ${Math.min(...ys)}..${Math.max(...ys)}, z ${Math.min(...zs)}..${Math.max(...zs)}` })
    fs.writeFileSync('lava-scan.txt', lines.join('\n'))
    say(`Lava sources within 160 blocks: ${lg.length} body(ies). ${lines.slice(0, 3).join(' ; ')}`.slice(0, 235))
  } catch (e) { say(`Inspection failed: ${e.message}`.slice(0, 200)); console.log('INSPECT_ERROR', e.stack) } finally { inspecting = false }
}

// Bed routine (Walter's rule): at dusk, if it has been >= 3 nights since the bot last slept, find a bed and sleep, and ping
// Walter once if he is not in bed (the night only skips when everyone sleeps). Sleeping every 3rd night keeps the time
// since last rest under the 72000-tick phantom limit. State persists in sleep-state.json.
const SLEEP_FILE = 'sleep-state.json'
// Uses game time (bot.time.age): due when >= 48000 ticks since the bot last woke, i.e. every 3rd night, safely under the 72000-tick phantom limit.
// (bot.time.day is unreliable on this server, it reads 0.) 'sleep' in chat forces it.
const SLEEP_DUE_TICKS = 48000
// Walter: spectators do not count towards sleeping. When every other player is a spectator (gamemode 3) the bot is the only one who has to
// sleep, so it sleeps EVERY night instead of every third night. Anyone else in survival, creative or adventure brings back the 3-night rule.
const onlySurvivalPlayer = () => { const others = Object.values(bot.players).filter(p => p.username !== bot.username); return others.length > 0 && others.every(p => p.gamemode === 3) }
const sleepIsDue = () => onlySurvivalPlayer() || bot.time.age - sleepState.lastWakeAge >= SLEEP_DUE_TICKS
let sleepState = { lastWakeAge: -1e9, pingedDay: -99 }
try { sleepState = { ...sleepState, ...JSON.parse(require('fs').readFileSync(SLEEP_FILE, 'utf8').replace(/^﻿/, '')) } } catch {}
const saveSleep = () => require('fs').writeFileSync(SLEEP_FILE, JSON.stringify(sleepState))
let sleepBusy = false, sleepRetryAt = 0
async function bedRoutine(force = false) {
  if (sleepBusy || (!force && Date.now() < sleepRetryAt) || !bot.entity || !bot.time || bot.game.dimension !== 'overworld') return
  const tod = bot.time.timeOfDay, day = Math.floor(bot.time.age / 24000)
  const night = tod >= 12542 && tod < 23460
  if (!night && force) say('It is not night yet, so I cannot sleep.')
  if (!night) return
  if (bot.isSleeping) return
  const due = force || sleepIsDue()
  if (!due || excavation.isRunning() || crafting || inspecting) return
  sleepBusy = true
  try {
    const bedIds = bot.registry.blocksArray.filter(b => b.name.endsWith('_bed')).map(b => b.id)
    const pts = bot.findBlocks({ matching: bedIds, maxDistance: 160, count: 40 }).sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
    const bed = pts.map(p => bot.blockAt(p)).find(b => b && b.getProperties && b.getProperties().part === 'head') || (pts[0] && bot.blockAt(pts[0]))
    if (!bed) { if (sleepState.pingedDay !== day) { say("It's getting dark, but I can't find a bed within 160 blocks."); sleepState.pingedDay = day; saveSleep() } return }
    say(`It's night. Heading to the bed at ${bed.position.x}, ${bed.position.y}, ${bed.position.z} to sleep.`)
    const r = await tryGoto(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2), 'the bed', 90000)
    if (!r.ok) { say(`I couldn't reach the bed (${r.err}). Retrying in a minute.`); sleepRetryAt = Date.now() + 60000; return }
    try {
      await bot.sleep(bed)
      say('In bed.')
      // Ping only if the night has still not skipped after 20 s in bed (reading Walter's pose from metadata proved unreliable).
      setTimeout(() => {
        if (bot.isSleeping && sleepState.pingedDay !== day) { say('OGWO, it is night and I am in bed, but the night has not skipped yet. Please get into a bed so we can sleep through it.'); sleepState.pingedDay = day; saveSleep() }
      }, 20000)
    } catch (e) { say(`I couldn't sleep: ${e.message}`.slice(0, 200)); sleepRetryAt = Date.now() + 60000 }
  } finally { sleepBusy = false }
}
setInterval(() => { if (BRAIN) return; bedRoutine().catch(e => console.log('BED_ERROR', e.message)) }, 15000)
bot.on('wake', () => { say('Awake.'); console.log('WOKE'); sleepState.lastWakeAge = bot.time.age; saveSleep() })

// Nether travel (Walter: the Nether is often the fastest way to far places). The bot only walks into an existing portal
// (no lighting or building), waits for the dimension switch, and reports where it arrived. Coordinates: Nether = overworld / 8.
let portalBusy = false
async function usePortal(wantDim) {
  if (portalBusy) return say('Already travelling through a portal.')
  portalBusy = true
  try {
    const dimName = (d) => (d || '').replace('minecraft:', '')
    const start = dimName(bot.game.dimension)
    if (start === wantDim) return say(`I'm already in the ${wantDim === 'the_nether' ? 'Nether' : 'overworld'}.`)
    const id = bot.registry.blocksByName.nether_portal.id
    // After arriving, Minecraft needs the player to leave the portal and re-enter it: step out sideways (along the portal plane's normal) first.
    const inPortal = bot.blockAt(bot.entity.position.floored())
    if (inPortal && inPortal.name === 'nether_portal') {
      const axis = (inPortal.getProperties() || {}).axis
      const sides = axis === 'x' ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]]
      const feet = bot.entity.position.floored()
      const ok = (dx, dz) => [1, 2].every(k => { const a = bot.blockAt(feet.offset(dx * k, 0, dz * k)), h = bot.blockAt(feet.offset(dx * k, 1, dz * k)), f = bot.blockAt(feet.offset(dx * k, -1, dz * k)); return a && h && f && a.boundingBox === 'empty' && h.boundingBox === 'empty' && f.boundingBox === 'block' && !/lava|fire|magma/.test(f.name + a.name) })
      const side = sides.find(([dx, dz]) => ok(dx, dz))
      if (!side) return say("I'm standing in the portal but there is no safe spot beside it to step out to. Staying put.")
      const out = await tryGoto(new goals.GoalBlock(feet.x + side[0] * 2, feet.y, feet.z + side[1] * 2), 'beside the portal', 15000)
      if (!out.ok) return say(`I couldn't step out of the portal safely (${out.err}).`)
      await new Promise(res => setTimeout(res, 1500))
    }
    const me = bot.entity.position
    const pts = bot.findBlocks({ matching: id, maxDistance: 160, count: 200 }).sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
    if (!pts.length) return say(`I can't see a nether portal within 160 blocks of here.`)
    // stand in the lowest cell of the nearest portal (feet level), not the top cell
    const p = pts.filter(q => q.distanceTo(pts[0]) <= 6).sort((a, b) => a.y - b.y || a.distanceTo(me) - b.distanceTo(me))[0]
    say(`Heading into the portal at ${p.x}, ${p.y}, ${p.z} (${Math.round(p.distanceTo(me))} blocks away).`)
    const r = await tryGoto(new goals.GoalBlock(p.x, p.y, p.z), 'the portal', 90000)
    if (!r.ok) return say(`I couldn't get into the portal (${r.err}).`)
    bot.clearControlStates()
    for (let i = 0; i < 40; i++) {            // wait up to 20 s inside the portal for the switch
      await new Promise(res => setTimeout(res, 500))
      if (dimName(bot.game.dimension) !== start) break
    }
    if (dimName(bot.game.dimension) === start) return say('The portal did not take me through (maybe it is inactive).')
    await new Promise(res => setTimeout(res, 3000)) // let chunks load
    const q = bot.entity.position
    say(`I'm in the ${dimName(bot.game.dimension) === 'the_nether' ? 'Nether' : 'overworld'} at ${Math.round(q.x)}, ${Math.round(q.y)}, ${Math.round(q.z)}.`)
  } catch (e) { say(`Portal trip failed: ${e.message}`.slice(0, 200)) } finally { portalBusy = false }
}

// Play like a regular player (Walter): no attacks through walls. The server accepts attack packets without any line-of-sight check,
// which let the bot hit a monster through a solid block ("Monster Hunter" with nobody in the room). Every attack, from any module, now
// needs a clear line from the eye to some part of the target; otherwise it is skipped and logged to los.log.
function clearLineTo(e) {
  try {
    const eye = bot.entity.position.offset(0, bot.entity.eyeHeight, 0)
    const h = e.height || 1.8
    for (const dy of [h * 0.5, h * 0.9, 0.25]) {
      const to = e.position.offset(0, dy, 0)
      const dir = to.minus(eye), dist = dir.norm()
      if (dist < 0.05) return true
      const hit = bot.world.raycast(eye, dir.scaled(1 / dist), dist)
      if (!hit) return true            // nothing solid between the eye and this point of the target
    }
    return false
  } catch (e2) { return true }         // if the check itself fails, do not block fights (fail open, but log)
}
bot.once('spawn', () => {
  const rawAttack = bot.attack.bind(bot)
  let lastLog = 0
  bot.attack = (target, ...rest) => {
    if (target && target.position && !clearLineTo(target)) {
      if (Date.now() - lastLog > 3000) { lastLog = Date.now(); try { require('fs').appendFileSync('los.log', `${new Date().toISOString()} blocked attack on ${target.name || target.type} at ${target.position}\n`) } catch {} }
      return
    }
    return rawAttack(target, ...rest)
  }
})

// Farm (harvest + replant) and auto-eat, see farm.js.
const farm = require('./farm')({ bot, say, goals, tryGoto })

// Idle routines (Walter: default to a routine in undirected time). Runs only when nothing else is going on and Walter has
// been quiet for 2 minutes; any chat message from him resets that, and "stop" ends the current task. Persisted in routine-state.json.
const ROUTINE_FILE = 'routine-state.json'
let routines = { farm: false, lastFarmRun: 0 }
try { routines = { ...routines, ...JSON.parse(require('fs').readFileSync(ROUTINE_FILE, 'utf8').replace(/^﻿/, '')) } } catch {}
function setRoutine(name, on) { routines[name] = on; require('fs').writeFileSync(ROUTINE_FILE, JSON.stringify(routines)) }
let lastChatAt = Date.now()
const anyTaskBusy = () => excavation.isRunning() || farm.isBusy() || crafting || inspecting || indexing || sleepBusy || testing || bot.isSleeping || bot.pathfinder.isMoving()
setInterval(() => {
  try {
    if (!bot.entity || !bot.time || bot.game.dimension !== 'overworld' || portalBusy || BRAIN || Date.now() - lastChatAt < 120000 || anyTaskBusy()) return
    if (routines.farm && bot.time.timeOfDay < 12000 && Date.now() - routines.lastFarmRun > 20 * 60000) {
      routines.lastFarmRun = Date.now(); require('fs').writeFileSync(ROUTINE_FILE, JSON.stringify(routines))
      console.log('IDLE farm routine'); farm.harvest({ store: true })
    }
  } catch (e) { console.log('IDLE_ERROR', e.message) }
}, 30000)

// Waypoints (name -> coords) persist in waypoints.json.
const WP_FILE = 'waypoints.json'
const loadWp = () => { try { return JSON.parse(require('fs').readFileSync(WP_FILE, 'utf8')) } catch { return {} } }
const saveWp = (w) => require('fs').writeFileSync(WP_FILE, JSON.stringify(w, null, 2))

function handleCommand(user, text) {
  const raw = text.toLowerCase()
  // Strip filler so "hey, can you please follow me?" matches like "follow me".
  const t = raw.replace(/[^\w\s',.-]/g, ' ')
    .replace(/\b(hey|yo|claude|bot|ozogo444|please|pls|plz|can you|could you|would you|will you|can u|go ahead and|just|now|for me)\b/g, ' ')
    .replace(/\s+/g, ' ').trim()
  if (/^(hi|hello|hey|yo|sup)\b/.test(raw) && raw.split(/\s+/).length <= 3) { say('Hi Walter! Try: follow me, come here, stay, go to x y z, inventory, status, what is around.'); return true }
  if (/\b(describe|scan|understand|explain)\b.*\broom\b|\broom\b.*\b(describe|scan|understand)|\bwhat room\b|\bthis room\b.*\b(look|like)/.test(t)) { try { describeRoom() } catch (e) { say(`Room scan failed: ${e.message}`.slice(0, 200)) } return true }
  if (/(excavat|carv|digging|dig out).*\b(status|progress|going|far)\b|\b(status|progress|how)\b.*(excavat|carv|digging)/.test(t)) { excavation.status(); return true }
  if (/\b(resume|continue)\b.*(excavat|dig|carv)/.test(t)) { excavation.resume(); return true }
  if (/^(excavate|carve)\b|\b(start|begin|get started|do it)\b.*(excavat|carv|digging)/.test(t)) { excavation.start(); return true }
  if (/^(sleep|go to bed|time (to|for) (sleep|bed)|let.?s sleep|go sleep)\b/.test(t)) { bedRoutine(true); return true }
  if (/\bnarrat\w*\b/.test(t)) {
    const lvl = /\b(off|stop|none|disable|quiet)\b/.test(t) ? 'off' : /\b(high|more|full|verbose|on|enable|all)\b/.test(t) ? 'high' : /\b(low|less|medium|brief|some)\b/.test(t) ? 'low' : null
    if (lvl) { setNarration(lvl); say(`Narration ${lvl}.`) } else say(`Narration is ${narration.level}. Say "narration high", "narration low" or "narration off".`)
    return true
  }
  if (/\b(put on|wear|equip)\b.*\barmou?r\b|\barmou?r\b.*\b(on|equip)/.test(t)) { wearArmor().then(() => { const worn = ['head', 'torso', 'legs', 'feet'].map(sl => { const it = bot.inventory.slots[bot.getEquipmentDestSlot(sl)]; return `${sl}: ${it ? it.name.replace(/_/g, ' ') : 'none'}` }); say(`Worn: ${worn.join(', ')}.`); const spare = bot.inventory.items().filter(i => /_(helmet|chestplate|leggings|boots)$/.test(i.name)).map(i => i.name.replace(/_/g, ' ')); if (spare.length) say(`Armor in the bag: ${spare.join(', ')}.`) }); return true }
  const takeM = /^take (\d+) ([a-z_ ]+?) from (.+)$/.exec(t)
  if (takeM) {
    const spots = [...takeM[3].matchAll(/(-?\d+)[ ,]+(-?\d+)[ ,]+(-?\d+)/g)].map(m => [Number(m[1]), Number(m[2]), Number(m[3])])
    if (spots.length) {
      const run = () => takeFromChests(takeM[2].trim().replace(/\s+/g, '_').replace(/s$/, ''), Number(takeM[1]), spots)
      // as a chat-priority scheduler task, so idle jobs (furnace, farm, excavation) are paused instead of fighting over the pathfinder goal
      if (BRAIN && BRAIN.scheduler) BRAIN.scheduler.submit({ name: 'take-items', priority: require('./brain/scheduler').PRIORITY.CHAT, onUserStop: 'cancel', abort: () => stopNav(), run: async () => { await run() } })
      else run()
      return true
    }
  }
  if (/\btest\b.*\bdoor/.test(t)) { runDoorTest(); return true }
  if (/\btest\b.*\bnav/.test(t)) { runNavTest(); return true }
  if (/\b(nether)\b/.test(t) && /\b(go|take|travel|head|enter|through|into|to)\b/.test(t) && !/\b(leave|out of|back from)\b/.test(t)) { usePortal('the_nether'); return true }
  if (/\b(leave|exit|out of)\b.*\bnether\b|\b(go|head|come|get) back\b.*\b(overworld|home)\b|\bback to the overworld\b|\bto the overworld\b/.test(t)) { usePortal('overworld'); return true }
  if (/\bfarm routine\b.*\b(on|start|enable)\b|\b(start|enable|turn on)\b.*\bfarm routine\b/.test(t)) { setRoutine('farm', true); say('Farm routine on: when I am idle, about every 20 minutes in daytime I harvest ripe crops, replant, and store extras in the house chest.'); return true }
  if (/\bfarm routine\b.*\b(off|stop|disable)\b|\b(stop|disable|turn off)\b.*\bfarm routine\b/.test(t)) { setRoutine('farm', false); say('Farm routine off.'); return true }
  if (/\bstore\b.*\b(crops|food|harvest)\b/.test(t)) { farm.storeCrops(); return true }
  if (/\b(harvest|get (some )?food|gather (food|crops)|pick (the )?crops|farm (the )?crops)\b/.test(t)) { farm.harvest({ store: true }); return true }
  if (/\b(inspect|check|read)\b.*\b(stations?|chests?|furnaces)\b/.test(t)) { inspectStations(); return true }
  if (/\b(index|catalog|catalogue|map)\b.*\bchests?\b/.test(t)) { indexChests(); return true }
  if (/^(wake up|get out of bed|get up)\b/.test(t)) { if (bot.isSleeping) bot.wake().catch(() => {}); say('Up.'); return true }
  const fb = /^(?:find|locate|where (?:is|are))\s+(?:the\s+|all\s+|any\s+)?([a-z_ ]+?)$/.exec(t)
  if (fb && !/furnace/.test(fb[1])) { findBlocksCmd(fb[1]); return true }
  if (/\b(scan|survey|find|look at|where are|show)\b.*\bfurnaces?\b/.test(t)) { try { describeFurnaces() } catch (e) { say(`Furnace scan failed: ${e.message}`.slice(0, 200)) } return true }
  if (/\b(stay|stop|wait|halt|freeze|cancel|hold on|hold still|pause)\b/.test(t)) { testing = false; indexing = false; excavation.stop(); farm.stop(); BRAIN && BRAIN.userStop(); stopNav(); say('Staying put.'); return true }
  const coords = /(?:go|walk|run|move|head|travel|get)\s*(?:to|over to)?\s*\(?\s*(-?\d+)[\s,]+(-?\d+)(?:[\s,]+(-?\d+))?/.exec(t)
  if (coords) {
    const [x, a, b] = [coords[1], coords[2], coords[3]].map(v => v === undefined ? undefined : Number(v))
    if (b === undefined) { say(`Heading to x=${x}, z=${a}.`); navigate(new goals.GoalNearXZ(x, a, 2), `x=${x}, z=${a}`) }
    else { say(`Heading to ${x}, ${a}, ${b}.`); navigate(new goals.GoalNear(x, a, b, 2), `${x}, ${a}, ${b}`) }
    return true
  }
  const setWp = /(?:set|save|add|mark|remember)\s*(?:a\s*)?(?:waypoint|this (?:place|spot|location)|here)?\s*(?:as|called|named)?\s*(\w[\w -]*)$/.exec(t)
  if (setWp && /waypoint|remember|mark|save|this (place|spot)/.test(t)) {
    const p = bot.entity.position, w = loadWp(), name = setWp[1].trim()
    w[name] = { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) }
    saveWp(w); say(`Saved waypoint "${name}" at ${w[name].x}, ${w[name].y}, ${w[name].z}.`); return true
  }
  if (/\bwaypoints?\b.*(list|what|show|have)|^(list|show) waypoints/.test(t)) {
    const w = loadWp(); say(Object.keys(w).length ? 'Waypoints: ' + Object.entries(w).map(([n, c]) => `${n} (${c.x}, ${c.y}, ${c.z})`).join('; ') : 'No waypoints saved yet.'); return true
  }
  const goWp = /(?:go|walk|head|travel|take me|run)\s*(?:to|over to)?\s*(?:the\s*)?(\w[\w -]*)$/.exec(t)
  if (goWp) {
    const w = loadWp(), k = Object.keys(w).find(n => n.toLowerCase() === goWp[1].trim())
    if (k) {
      const dist = Math.round(bot.entity.position.distanceTo(new (require('vec3').Vec3)(w[k].x, w[k].y, w[k].z)))
      if (dist > 160) { say(`${k} is ${dist} blocks away at ${w[k].x}, ${w[k].y}, ${w[k].z}, outside the loaded area. I can't path that far yet.`); return true }
      say(`Going to ${k} (${dist} blocks).`); navigate(new goals.GoalNear(w[k].x, w[k].y, w[k].z, 2), k); return true }
  }
  if (/who.?s (nearby|around|here|online)|players|who is (nearby|around)/.test(t)) {
    const me = bot.entity.position
    say('Players: ' + (Object.values(bot.players).filter(p => p.username !== bot.username).map(p => p.entity ? `${p.username} (${Math.round(p.entity.position.distanceTo(me))} blocks)` : `${p.username} (out of range)`).join(', ') || 'just me')); return true
  }
  if (/what time|time of day|is it (day|night)|\btime\b/.test(t)) { const d = bot.time.timeOfDay; say(`${d < 12000 ? 'Day' : d < 13000 ? 'Dusk' : d < 23000 ? 'Night' : 'Dawn'} (tick ${d}).`); return true }
  if (/\b(craft|tool ?set|make yourself)\b/.test(t)) { craftToolSet(); return true }
  if (/\bfollow\b/.test(t)) {
    const target = bot.players[user] && bot.players[user].entity
    if (!target) { say(`I can't see you (${user}), too far away to follow.`); return true }
    say('Following you. Say "stay" to stop.')
    navigate(new goals.GoalFollow(target, 3), 'you', true)
    return true
  }
  if (/\b(come|walk to me|run to me|get over here|over here|to me)\b/.test(t)) {
    const target = bot.players[user] && bot.players[user].entity
    if (!target) { say(`I can't see you (${user}), too far away to path to.`); return true }
    say('On my way.')
    navigate(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2), 'you')
    return true
  }
  if (/walk to me|come (here|to me)/.test(t)) {
    const target = bot.players[user] && bot.players[user].entity
    if (!target) return say(`I can't see you (${user}), too far away to path to.`)
    say('On my way.')
    navigate(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2), 'you')
    return true
  }
  if (/craft|tool ?set|make yourself/.test(t)) { craftToolSet(); return true }
  if (/inventor|what.*(holding|carrying|have on you|got)|\bbag\b/.test(t)) {
    const items = bot.inventory.items()
    if (!items.length) { say('My inventory is empty.'); return true }
    const tally = {}
    for (const i of items) tally[i.displayName || i.name] = (tally[i.displayName || i.name] || 0) + i.count
    say('I have: ' + Object.entries(tally).map(([n, c]) => `${c} ${n}`).join(', '))
    return true
  }
  if (/^(hi|hello|hey)\b/.test(t)) { say('Hi Walter! I can follow, come to you, stay, and report status, inventory and what is around.'); return true }
  if (/health|status|how are you|\bhp\b|hungry|food/.test(t)) {
    say(`Health ${Math.round(bot.health)}/20, food ${Math.round(bot.food)}/20, ${bot.game.dimension}, ${bot.time.timeOfDay < 13000 ? 'daytime' : 'night'}, world day ${bot.time.day} (time of day ${bot.time.timeOfDay} of 24000).`)
    return true
  }
  if (/what.?s around|what do you see|what can you see|look around|\blook\b|nearby|surroundings/.test(t)) {
    const me = bot.entity.position
    const ents = Object.values(bot.entities).filter(e => e !== bot.entity && e.position.distanceTo(me) < 24)
    const tally = {}
    for (const e of ents) { const k = e.username || e.name || e.type; tally[k] = (tally[k] || 0) + 1 }
    const mobs = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, c]) => `${c} ${n}`).join(', ') || 'nothing'
    const want = ['chest', 'furnace', 'crafting_table', 'white_bed', 'red_bed', 'lava', 'water'].map(n => bot.registry.blocksByName[n]).filter(Boolean)
    const found = []
    for (const b of want) { const n = bot.findBlocks({ matching: b.id, maxDistance: 16, count: 50 }).length; if (n) found.push(`${n} ${b.name}`) }
    say(`Within ~24 blocks: ${mobs}. Blocks within 16: ${found.join(', ') || 'none of the notable ones'}.`)
    return true
  }
  if (/where are you|\bwhere\b.*\byou\b|your (position|coords|coordinates|location)|\b(coords|position|location)\b/.test(t)) {
    const p = bot.entity.position
    say(`I'm at ${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)} (${bot.game.dimension}), health ${Math.round(bot.health)}/20.`)
    return true
  }
  if (/follow me/.test(t)) {
    const target = bot.players[user] && bot.players[user].entity
    if (!target) return say(`I can't see you (${user}), too far away to follow.`)
    say('Following you. Say "stay" to stop.')
    navigate(new goals.GoalFollow(target, 3), 'you', true)
    return true
  }
  if (/^(stay|stop)\b/.test(t)) { stopNav(); say('Staying put.'); return true }
  return false
}
let quietNav = false
bot.on('goal_reached', () => { if (!quietNav) say('Here.') })
bot.on('path_update', (r) => { if (r.status === 'noPath') { try { require('fs').appendFileSync('narration.log', `${new Date().toISOString()} noPath
`) } catch {} } })

// the bot profile (bots/<bot>/profile.json in brain/state, with role.json etc. as fallback); read on demand, cached for 2 s
let _botProfile = null
const botProfile = () => _botProfile || (_botProfile = require('./brain/profile').createProfile({ stateDir: require('path').resolve('brain', 'state'), botName: bot.username }))
function addressedToMe(t) {
  const ozo = /\bozo(go)?(444)?\b/i.test(t), smeo = /\bsmeo(444)?\b/i.test(t)
  if (ozo || smeo) return /^ozo/i.test(bot.username) ? ozo : smeo
  try { return botProfile().get().role === 'assistant' } catch { return false }
}
// Two-way chat: player messages go to chat.log (watched by Claude); lines Claude appends to outbox.txt are said in game.
const fs = require('fs')
bot.on('messagestr', m => {
  console.log('MSG', m)
  const g = /^<([^>]+)> (.*)$/.exec(m) || /^(\S+) whispers to you: (.*)$/.exec(m)
  // two bots share the world (Walter 2026-11-04): they never answer each other, and a request goes to the bot it names
  // ("ozo ...", "smeo ..."); one that names neither goes to the assistant (brain/state/role.json), the hillclimber ignores it
  if (g && g[1] !== bot.username && !/^(OzoGo444|Smeo444)$/.test(g[1]) && addressedToMe(g[2])) {
    fs.appendFileSync('chat.log', `${g[1]}: ${g[2]}\n`)
    logChatContext(g[1], g[2])
    lastChatAt = Date.now()
    if (!routeChat(g[1], g[2])) say('Got it, one moment.')
  }
})
fs.writeFileSync('outbox.txt', '')
// Claude's control channel: lines appended to cmd.txt run as if OGWO typed them in chat (no restart needed).
fs.writeFileSync('cmd.txt', '')
setInterval(() => {
  try {
    const t = fs.readFileSync('cmd.txt', 'utf8')
    if (!t.trim()) return
    fs.writeFileSync('cmd.txt', '')
    for (const line of t.split(/\r?\n/).filter(Boolean)) { console.log('CMD', line); routeChat('OGWO', line, true) }
  } catch (e) { console.log('CMD_ERROR', e.message) }
}, 500)
setInterval(() => {
  try {
    const t = fs.readFileSync('outbox.txt', 'utf8')
    if (!t.trim()) return
    fs.writeFileSync('outbox.txt', '')
    for (const line of t.split(/\r?\n/).filter(Boolean)) for (let i = 0; i < line.length; i += 240) chatQueue.push(line.slice(i, i + 240))
  } catch (e) { console.log('OUTBOX_ERROR', e.message) }
}, 250)
// Take a specific item from specific chests: only on an explicit "take N item from x y z [and x y z ...]" command (Walter agreed to each case).
// Walks to the chest, requires a clear line to it (survival-legit), opens it, withdraws only that item up to N, closes it, reports.
async function takeFromChests(itemName, n, spots) {
  const item = bot.registry.itemsByName[itemName]
  if (!item) return say(`I don't know an item called "${itemName}".`)
  let taken = 0
  for (const s of spots) {
    if (taken >= n) break
    const p = new (require('vec3').Vec3)(s[0], s[1], s[2])
    const blk = bot.blockAt(p)
    if (!blk || !/chest|barrel/.test(blk.name)) { say(`There's no chest at ${s.join(', ')}.`); continue }
    const r = await tryGoto(new goals.GoalNear(p.x, p.y, p.z, 3), 'a chest', 40000)
    if (!r.ok && bot.entity.position.distanceTo(p.offset(0.5, 0.5, 0.5)) > 4.8) { say(`I couldn't reach the chest at ${s.join(', ')} (${r.err}).`); continue }
    // survival-legit: a clear line to the chest, walking to a viewpoint if something (a hopper, a wall) is in the way, like a player would
    const seen = await require('./brain/los').ensureLineOfSight({ bot, goals, tryGoto, target: blk, label: 'a spot with a clear view of the chest' })
    if (!seen) { say(`I can't find a spot with a clear view of the chest at ${s.join(', ')}, so I won't open it.`); continue }
    let cont
    try {
      cont = await bot.openContainer(blk)
      const have = cont.containerCount(item.id, null)
      const take = Math.min(have, n - taken)
      if (take > 0) { await cont.withdraw(item.id, null, take); taken += take }
    } catch (e) { say(`Couldn't take from ${s.join(', ')}: ${e.message}`.slice(0, 160)) } finally { try { cont && cont.close() } catch {} }
  }
  say(taken >= n ? `Took ${taken} ${itemName.replace(/_/g, ' ')}.` : `Took ${taken} of ${n} ${itemName.replace(/_/g, ' ')} (that's all the chests had).`)
}

// Narration toggle (Walter): "narration high|low|off". High (the current setting) narrates what the bot is doing and why in short lines
// in parentheses: task starts/pauses/resumes from the scheduler and how the message router read each message. At most one line per 4 s.
const NARR_FILE = 'narration.json'
let narration = { level: 'high' }
try { narration = { ...narration, ...JSON.parse(require('fs').readFileSync(NARR_FILE, 'utf8').replace(/^﻿/, '')) } } catch {}
const NARR_RANK = { off: 0, low: 1, high: 2 }
let lastNarrAt = 0
function narrate(text, min = 'high') {
  if ((NARR_RANK[narration.level] ?? 0) < NARR_RANK[min]) return
  if (Date.now() - lastNarrAt < 4000) return
  lastNarrAt = Date.now(); say(`(${text})`)
}
function setNarration(level) { narration.level = level; try { require('fs').writeFileSync(NARR_FILE, JSON.stringify(narration)) } catch {} }
function narrateSchedulerLog(m) {
  let g
  if ((g = /^start (\S+)/.exec(m))) return narrate(`Starting ${g[1]} because nothing more important is waiting.`)
  if ((g = /^resume (\S+)/.exec(m))) return narrate(`Going back to ${g[1]}.`)
  if ((g = /^paused (\S+)/.exec(m))) return narrate(`Pausing ${g[1]} for something more urgent.`)
  if ((g = /^done (\S+)/.exec(m))) return narrate(`Finished ${g[1]}.`, 'low')
  if ((g = /^queued (\S+)/.exec(m))) { const name = g[1]; return void setTimeout(() => { try { if (BRAIN && BRAIN.scheduler.status().queue.some(t => t.name === name)) narrate(`Queued ${name} for when I'm free.`) } catch {} }, 1500) }   // only if it really has to wait: tasks that start at once are not 'queued'
}
// (router decision narration removed: Walter heard it as noise; the pilot feed and "router last" cover it)

// Wear the best armor in the inventory (Walter: "you haven't put on the armor you made yet"). Only items already carried, never from chests.
const ARMOR_SLOT = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' }
const ARMOR_RANK = ['leather', 'golden', 'chainmail', 'iron', 'diamond', 'netherite']
let wearingArmor = false
async function wearArmor() {
  if (wearingArmor || !bot.entity || bot.isSleeping || typeof bot.getEquipmentDestSlot !== 'function' || !armorAllowed()) return
  wearingArmor = true
  try {
    for (const it of bot.inventory.items()) {
      const m = /^(netherite|diamond|iron|chainmail|golden|leather)_(helmet|chestplate|leggings|boots)$/.exec(it.name)
      if (!m) continue
      const slot = ARMOR_SLOT[m[2]], cur = bot.inventory.slots[bot.getEquipmentDestSlot(slot)]
      if (cur) { const cm = /^(\w+?)_/.exec(cur.name); if (cm && ARMOR_RANK.indexOf(cm[1]) >= ARMOR_RANK.indexOf(m[1])) continue }
      await bot.equip(it, slot)
      say(`Put on ${it.name.replace(/_/g, ' ')}.`)
    }
  } catch (e) { console.log('ARMOR_ERROR', e.message) } finally { wearingArmor = false }
}
setInterval(() => { wearArmor().catch(() => {}) }, 8000)

// Where was the player when they spoke? (Walter: so "expand this hallway" still means something when the bot is not with him.)
// Player positions are only known while the player is inside the server's tracking range, so the last seen position is remembered
// (player-pos.json, refreshed every 2 s) and each chat line gets a snapshot in chat-context.jsonl: {t,user,text,pos,seenAgoS,yaw,pitch,facing,dim,bot}.
const playerSeen = {}
const facingOf = (yaw) => { const a = ((yaw * 180 / Math.PI) % 360 + 360) % 360; return ['north', 'north-west', 'west', 'south-west', 'south', 'south-east', 'east', 'north-east'][Math.round(a / 45) % 8] }
setInterval(() => {
  try {
    for (const p of Object.values(bot.players)) {
      if (!p.entity || p.username === bot.username) continue
      const e = p.entity
      playerSeen[p.username] = { x: +e.position.x.toFixed(1), y: +e.position.y.toFixed(1), z: +e.position.z.toFixed(1), yaw: e.yaw, pitch: e.pitch, dim: bot.game.dimension, at: Date.now() }
    }
    if (Object.keys(playerSeen).length) require('fs').writeFileSync('player-pos.json', JSON.stringify(playerSeen))
  } catch (e) { /* position logging must never disturb the bot */ }
}, 2000)
function logChatContext(user, text) {
  try {
    const s = playerSeen[user], me = bot.entity && bot.entity.position
    const rec = { t: new Date().toISOString(), user, text, pos: s ? [s.x, s.y, s.z] : null, seenAgoS: s ? Math.round((Date.now() - s.at) / 1000) : null,
      yaw: s ? +s.yaw.toFixed(2) : null, pitch: s ? +s.pitch.toFixed(2) : null, facing: s ? facingOf(s.yaw) : null, dim: s ? s.dim : null,
      bot: me ? [+me.x.toFixed(1), +me.y.toFixed(1), +me.z.toFixed(1)] : null }
    require('fs').appendFileSync('chat-context.jsonl', JSON.stringify(rec) + '\n')
  } catch (e) { /* ignore */ }
}
// --- brain: scheduler, furnace upkeep, optional safety/chat/dashboard modules (see brain/INTERFACE.md). NO_BRAIN=1 disables it. ---
function routeChat(user, text, fromCmd = false) {
  if (BRAIN) { try { return BRAIN.route(user, text, { handleCommand, fromCmd }) } catch (e) { console.log('BRAIN_ROUTE_ERROR', e.stack || e.message) } }
  return handleCommand(user, text)
}
bot.once('spawn', () => setTimeout(() => {
  if (process.env.NO_BRAIN) return console.log('BRAIN disabled (NO_BRAIN)')
  try {
    BRAIN = require('./brain')({
      dir: process.cwd(), stateDir: require('path').join(process.cwd(), 'brain', 'state'),
      bot, say, goals, tryGoto, stopNav, navigateRaw, navActive: () => !!navGoal, handleCommand, farm, excavation,
      jobs: { bedRoutine, indexChests, inspectStations, craftToolSet, runNavTest, runDoorTest, usePortal },
      routines, saveRoutines: () => require('fs').writeFileSync(ROUTINE_FILE, JSON.stringify(routines)),
      sleepWanted: () => !sleepBusy && Date.now() >= sleepRetryAt && sleepIsDue(),
      stopAllLegacy: () => { testing = false; indexing = false; excavation.stop(); farm.stop(); stopNav() }
    })
    console.log('BRAIN loaded')
    try { BRAIN.scheduler.on('log', narrateSchedulerLog) } catch (e) { console.log('NARRATE_HOOK_ERROR', e.message) }
  } catch (e) { BRAIN = null; console.log('BRAIN_LOAD_ERROR', e.stack || e.message) }
}, 4000))
bot.on('kicked', r => console.log('KICKED', JSON.stringify(r).slice(0, 600)))
bot.on('error', e => console.log('ERROR', e.stack || e.message))
// Crash guard: a bad command must not drop the bot. Real disconnects exit so run.js reconnects with backoff.
process.on('uncaughtException', e => console.log('UNCAUGHT', e.stack || e.message))
process.on('unhandledRejection', e => console.log('UNHANDLED_REJECTION', (e && e.stack) || e))
bot.on('end', r => { console.log('END', r); setTimeout(() => process.exit(1), 500) })
