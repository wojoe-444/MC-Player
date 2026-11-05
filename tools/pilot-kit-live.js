// Live test for brain/pilot-kit against a throwaway server (see .claude/skills/trial-server). Not part of `node --test test/`.
//   node .claude/skills/trial-server/scripts/server.js setup --dir .trial-server --port 25610 && node .../server.js start --dir .trial-server
//   node tools/pilot-kit-live.js [port]          (needs mineflayer, mineflayer-pathfinder, vec3 and canvas resolvable, e.g. after `npm install`)
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const register = require('../brain/pilot-kit')

const PORT = Number(process.argv[2]) || 25610
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-kit-'))
let pass = 0, failN = 0
const check = (name, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); ok ? pass++ : failN++ }

const bot = mineflayer.createBot({ host: 'localhost', port: PORT, username: 'TrialA', version: '1.21.6' })
bot.on('error', e => console.log('ERR', e.message))
bot.loadPlugin(pathfinder)
bot.once('spawn', async () => {
  const cmd = async (c) => { bot.chat(c); await sleep(220) }
  try {
    bot.pathfinder.setMovements(Object.assign(new Movements(bot), { canDig: false }))
    const events = new EventEmitter()
    const api = { bot, events, goals, log: () => {}, now: Date.now, statePath: (f) => path.join(tmp, f), scheduler: { status: () => ({ running: { name: 'test-task' } }) } }
    const mod = register(api); mod.start()
    const kit = bot._kit

    await cmd('/gamemode survival'); await cmd('/gamerule doMobSpawning false'); await cmd('/gamerule doImmediateRespawn true'); await cmd('/time set 18000'); await cmd('/gamerule doDaylightCycle false')
    await cmd('/clear @s'); await cmd('/kill @e[type=!minecraft:player]')
    await cmd('/tp @s 0 -60 0'); await sleep(1500)
    const g = bot.entity.position.floored(), Y = g.y   // standing on ground at Y-1
    const fill = (x1, y1, z1, x2, y2, z2, b) => cmd(`/fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} minecraft:${b}`)

    // ---------- result.js ----------
    const R = kit.result
    const ok1 = await R.wrap('craft', async () => ({ ok: true, note: 'crafted 4 planks', n: 4 }))()
    check('result: ok envelope keeps note and extras', ok1.ok && ok1.note === 'crafted 4 planks' && ok1.data && ok1.data.n === 4 && typeof ok1.ms === 'number')
    const bad = await R.wrap('goto', async () => { throw new Error('no path to the chest') })()
    check('result: thrown error becomes NO_PATH', !bad.ok && bad.error.code === 'NO_PATH')
    const abort = await R.wrap('x', async () => { const e = new Error('stop'); e.name = 'AbortError'; throw e })().then(() => 'swallowed', e => e.name)
    check('result: AbortError still propagates', abort === 'AbortError')
    const legacy = await R.wrap('stash', async () => ({ ok: false, note: 'not enough cobblestone' }))()
    check('result: legacy {ok:false,note} classified', !legacy.ok && legacy.error.code === 'NO_ITEM', legacy.error && legacy.error.code)

    // ---------- observe.js ----------
    const o1 = kit.observe({})
    check('observe: first call has state and no events', o1.vitals.hp === 20 && o1.events.length === 0 && typeof o1.cursor === 'number')
    events.emit('chat', { user: 'Walter', text: 'hello bot' })
    await cmd('/summon minecraft:zombie 6 ' + Y + ' 0 {PersistenceRequired:1b,NoAI:1b}')
    await sleep(500)
    const o2 = kit.observe({ since: o1.cursor })
    check('observe: second call returns only the new chat event', o2.events.length === 1 && o2.events[0].type === 'chat' && o2.cursor === o1.cursor + 1, JSON.stringify(o2.events.map(e => e.type)))
    check('observe: zombie in line of sight is listed', o2.nearby.hostiles.some(h => h.name === 'zombie'), JSON.stringify(o2.nearby.hostiles))
    const o3 = kit.observe({ since: o2.cursor })
    check('observe: nothing new means empty events', o3.events.length === 0)
    check('observe: text form is short', kit.observeText({ since: o1.cursor }).split('\n').length <= 8)
    await cmd('/kill @e[type=!minecraft:player]')

    // ---------- slice.js (no x-ray) ----------
    // a solid block of rock around us, with a corridor to the east that ends in exposed gold, plus ore the bot cannot see
    await fill(g.x - 12, Y - 3, g.z - 6, g.x + 12, Y + 6, g.z + 6, 'stone')   // the flat world floor is y=-64, so stay above it
    await fill(g.x - 1, Y, g.z, g.x + 9, Y + 1, g.z, 'air')                           // corridor at the bot's height
    await cmd(`/setblock ${g.x + 10} ${Y} ${g.z} minecraft:gold_ore`)                // exposed at the end of the corridor: in view
    await cmd(`/setblock ${g.x + 6} ${Y + 4} ${g.z} minecraft:diamond_ore`)           // buried in rock: must NOT show
    await fill(g.x - 8, Y + 3, g.z, g.x - 5, Y + 4, g.z, 'air')                       // sealed pocket
    await cmd(`/setblock ${g.x - 9} ${Y + 3} ${g.z} minecraft:iron_ore`)             // ore in the pocket wall: hidden from outside
    await cmd(`/tp @s ${g.x + 0.5} ${Y} ${g.z + 0.5} -90 0`); await sleep(1500)
    const t0 = Date.now()
    const sj = require('../brain/pilot-kit/slice').capture(bot, { axis: 'z' })
    const capMs = Date.now() - t0
    const s = kit.slice({ axis: 'z', scale: 10 })
    const names = sj.palette.join(',')
    check('slice: rock and exposed gold are drawn', sj.palette.includes('stone') && sj.palette.includes('gold_ore'), names)
    check('slice: buried diamond is hidden (no x-ray)', !sj.palette.includes('diamond_ore'), names)
    check('slice: ore inside a sealed pocket is hidden', !sj.palette.includes('iron_ore'), names)
    check('slice: png written', fs.existsSync(s.file) && fs.statSync(s.file).size > 1000, s.file)
    const hidden = sj.rows.flat().filter(v => v === -1).length, total = sj.rows.flat().length
    check('slice: most underground cells are drawn as unknown', hidden / total > 0.5, hidden + '/' + total)
    console.log('     slice capture took ' + capMs + ' ms for ' + total + ' cells')

    // ---------- place.js ----------
    await fill(g.x - 12, Y, g.z - 6, g.x + 12, Y + 6, g.z + 6, 'air')
    await cmd('/give @s minecraft:cobblestone 32'); await sleep(400)
    await cmd(`/tp @s ${g.x + 0.5} ${Y} ${g.z + 0.5}`); await sleep(800)
    // a floating target with only a side neighbour: put one stone block 2 cells up and ask for the cell next to it
    await cmd(`/setblock ${g.x + 3} ${Y + 2} ${g.z} minecraft:stone`); await sleep(400)
    const p1 = await kit.placeAnyFace({ pos: { x: g.x + 3, y: Y + 2, z: g.z + 1 }, item: 'cobblestone' })
    check('place: floating cell with only a side neighbour', p1.ok && p1.face !== 'below', p1.note)
    // out of reach: target 9 blocks away on the ground, must walk
    await fill(g.x + 8, Y - 1, g.z - 2, g.x + 12, Y - 1, g.z + 2, 'stone')
    const p2 = await kit.placeAnyFace({ pos: { x: g.x + 10, y: Y, z: g.z }, item: 'cobblestone' })
    check('place: walks closer when out of reach', p2.ok && p2.walked, p2.note)
    const p3 = await kit.placeAnyFace({ pos: { x: g.x + 10, y: Y, z: g.z }, item: 'cobblestone' })
    check('place: occupied cell is refused cleanly', !p3.ok && p3.error && p3.error.code === 'FAILED', p3.note)
    const p4 = await kit.placeAnyFace({ pos: { x: g.x + 20, y: Y + 30, z: g.z }, item: 'cobblestone' })
    check('place: no neighbour at all is reported', !p4.ok, p4.note)

    // ---------- dashcam.js ----------
    await cmd(`/tp @s ${g.x + 0.5} ${Y} ${g.z + 0.5}`); await sleep(500)
    await cmd('/summon minecraft:zombie ' + (g.x + 5) + ' ' + Y + ' ' + g.z + ' {PersistenceRequired:1b,NoAI:1b}')
    await sleep(12000)
    const st = kit.dashcam.status()
    check('dashcam: buffering about 10 samples a second', st.buffered >= 100 && st.bufferedMs >= 9000, JSON.stringify({ n: st.buffered, ms: st.bufferedMs }))
    kit.dashcam.save('manual')
    await sleep(300)
    const dir = path.join(tmp, 'clips')
    let files = fs.readdirSync(dir).filter(f => f.endsWith('manual.json'))
    check('dashcam: manual clip written', files.length === 1)
    const clip = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'))
    const rate = clip.samples.length / ((clip.samples[clip.samples.length - 1].t) / 1000)
    check('dashcam: clip sample rate near 10 Hz', rate > 8 && rate < 12, rate.toFixed(1) + ' Hz, ' + clip.samples.length + ' samples')
    check('dashcam: clip sees the zombie and the task name', clip.samples.some(x => x.m.some(m => m[0] === 'zombie')) && clip.samples[0].a.includes('test-task'))
    check('dashcam: clip has a terrain map', clip.map && clip.map.cells.length === 41 * 41)
    console.log('     clip size', Math.round(fs.statSync(path.join(dir, files[0])).size / 1024) + ' KB for ' + (clip.samples[clip.samples.length - 1].t / 1000).toFixed(1) + ' s')
    await cmd('/damage @s 12 minecraft:generic'); await sleep(7000)    // big hit: saved after the 5 s post-roll
    files = fs.readdirSync(dir).filter(f => f.endsWith('big_hit.json'))
    check('dashcam: big hit saves a clip after the post-roll', files.length === 1)
    if (files.length) { const c2 = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8')); check('dashcam: big hit clip contains the damage event', c2.events.some(e => e.type === 'damage'), JSON.stringify(c2.events.filter(e => e.type === 'damage'))) }
    await cmd('/effect give @s minecraft:instant_health 1 10'); await sleep(800)
    await cmd('/kill @s'); await sleep(1500)
    files = fs.readdirSync(dir).filter(f => f.endsWith('death.json'))
    check('dashcam: death saves a clip at once', files.length === 1)
    const dEvents = kit.observe({ since: 0 }).events.map(e => e.type)
    check('observe: death and damage reached the cursor stream', dEvents.includes('death') && dEvents.includes('damage'), dEvents.join(','))
    mod.stop()
  } catch (e) { console.log('FATAL', e.stack); failN++ }
  console.log(`\n${pass} passed, ${failN} failed`)
  bot.quit(); setTimeout(() => process.exit(failN ? 1 : 0), 500)
})
