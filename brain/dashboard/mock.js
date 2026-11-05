// Runs the dashboard against fake data, without the bot or a Minecraft server:
//   node brain/dashboard/mock.js [port]        (default 3011; Ctrl+C to stop)
// Works on a scratch copy in %TEMP%; nothing in the Minecraft-Agent folder is read for writing or changed.
const fs = require('fs')
const os = require('os')
const path = require('path')
const EventEmitter = require('events')
const dashboard = require('./index')

function makeMockApi({ realDir } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-mock-'))
  fs.mkdirSync(path.join(dir, 'pov'))
  fs.mkdirSync(path.join(dir, 'state'))
  const real = (f) => (realDir ? path.join(realDir, f) : null)
  // real station layout if present, so the mock looks like the live world
  if (real('stations.json') && fs.existsSync(real('stations.json'))) fs.copyFileSync(real('stations.json'), path.join(dir, 'stations.json'))
  const pov = realDir && fs.existsSync(path.join(realDir, 'pov')) ? fs.readdirSync(path.join(realDir, 'pov')).find(f => /\.png$/i.test(f)) : null
  if (pov) fs.copyFileSync(path.join(realDir, 'pov', pov), path.join(dir, 'pov', 'latest.png'))
  const idx = {}
  for (let i = 0; i < 24; i++) {
    const key = `${-1060 + i * 2},${64 + (i % 5)},${2300 + i}`
    idx[key] = i === 7 ? { error: 'Took to long to decide path to goal!', at: Date.now() - 3600e3 }
      : { slots: i % 2 ? 54 : 27, items: { cobblestone: 64 * (i % 4), wool: i % 3 ? 12 : 0, bucket: i % 5 === 0 ? 3 : 0, iron_ingot: 17 }, at: Date.now() - i * 600e3 }
    for (const k of Object.keys(idx[key].items || {})) if (!idx[key].items[k]) delete idx[key].items[k]
  }
  fs.writeFileSync(path.join(dir, 'chest-index.json'), JSON.stringify(idx))
  fs.writeFileSync(path.join(dir, 'chat.log'), 'OGWO: hello from chat.log\n')

  const bot = new EventEmitter()
  Object.assign(bot, {
    username: 'OzoGo444', health: 17, food: 14, foodSaturation: 2, isSleeping: false,
    game: { dimension: 'overworld', gameMode: 'survival' }, time: { timeOfDay: 6000, day: 1836 },
    entity: { position: { x: -1048.5, y: 130, z: 2275.5 }, yaw: 1.2, pitch: 0.1, onGround: true },
    heldItem: { name: 'stone_pickaxe', count: 1 }
  })
  const items = [{ name: 'cobblestone', count: 64, displayName: 'Cobblestone' }, { name: 'cobblestone', count: 23, displayName: 'Cobblestone' },
    { name: 'bucket', count: 3, displayName: 'Bucket' }, { name: 'white_wool', count: 5, displayName: 'White Wool' }, { name: 'bread', count: 7, displayName: 'Bread' }]
  bot.inventory = { items: () => items }

  const t0 = Date.now()
  const api = {
    bot, dir, now: () => Date.now(), events: new EventEmitter(), logs: [],
    statePath: (f) => path.join(dir, 'state', f),
    log: (tag, msg) => { api.logs.push({ t: Date.now(), tag, msg }); console.log(`[${tag}] ${msg}`) },
    status: {
      all() {
        const s = Math.round((Date.now() - t0) / 1000)
        return {
          scheduler: {
            running: { name: 'furnace', priority: 30, status: 'running', progress: `${(s % 10) + 1}/10 chests`, runningS: s },
            queue: [{ name: 'excavate', priority: 10, status: 'paused', progress: '', ageS: 400 }],
            parked: [{ name: 'farm', priority: 20, status: 'parked', parkReason: 'stopped by Walter', ageS: 90 }],
            routines: [{ name: 'furnace', enabled: true, priority: 30 }, { name: 'farm', enabled: false, priority: 20 }],
            quietForS: 42, history: [{ agoS: 5, msg: 'start furnace' }, { agoS: 60, msg: 'paused excavate' }]
          },
          furnace: { lastRun: '5 min ago', fuel: { S1: 4, S2: 6 }, lava: 2 },
          modules: { safety: { mode: 'warn', hostilesNear: 0 }, chat: { unhandled: 1 } },
          chatTail: [{ t: Date.now() - 60e3, user: 'OGWO', text: 'come here <img src=x onerror=alert(1)>' }, { t: Date.now() - 50e3, user: 'OzoGo444', text: 'On my way.' }],
          logTail: [{ t: Date.now(), tag: 'furnace', msg: 'filled 2 buckets at depot 1' }],
          bot: {}
        }
      }
    }
  }
  return api
}

module.exports = { makeMockApi }

if (require.main === module) {
  const api = makeMockApi({ realDir: path.join(__dirname, '..', '..') })
  const port = Number(process.argv[2] || 3011)
  const d = dashboard.create(api, { port, writeStatusMs: 5000 })
  // wiggle the numbers so the page visibly updates
  let n = 0
  const mover = setInterval(() => {
    n++
    api.bot.entity.position.x = -1048.5 + Math.sin(n / 4) * 3
    api.bot.health = 14 + (n % 7)
    api.bot.food = 20 - (n % 12)
    if (n % 5 === 0) api.events.emit('chat', { user: 'OGWO', text: 'ping ' + n })
  }, 2000)
  d.start().then(() => console.log(`mock dashboard: http://127.0.0.1:${d.port()}/  (Ctrl+C to stop)`))
  process.on('SIGINT', async () => { clearInterval(mover); await d.stop(); process.exit(0) })
}
