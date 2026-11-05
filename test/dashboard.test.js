const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const dashboard = require('../brain/dashboard')
const { makeMockApi } = require('../brain/dashboard/mock')

const REAL = path.join(__dirname, '..')

async function boot(api, opts = {}) {
  const d = dashboard.create(api, { port: 0, writeStatusMs: 0, ...opts })
  await d.start()
  return { d, base: `http://127.0.0.1:${d.port()}` }
}

test('register returns the module contract', () => {
  const api = makeMockApi()
  const m = dashboard(api)
  assert.equal(m.name, 'dashboard')
  assert.equal(typeof m.start, 'function')
  assert.equal(typeof m.stop, 'function')
  assert.deepEqual(m.status(), { url: null, port: null })
})

test('serves a full snapshot from mock data', async () => {
  const api = makeMockApi({ realDir: REAL })
  const { d, base } = await boot(api)
  try {
    const s = await (await fetch(base + '/api/status')).json()
    assert.equal(s.bot.online, true)
    assert.equal(s.bot.username, 'OzoGo444')
    assert.deepEqual(s.bot.pos, { x: -1048.5, y: 130, z: 2275.5 })
    assert.equal(s.bot.health, 17)
    assert.equal(s.bot.food, 14)
    assert.equal(s.bot.gameClock, '12:00')
    assert.equal(s.bot.holdingLava, false)
    assert.equal(s.inventory.items.find(i => i.name === 'cobblestone').count, 87)
    assert.equal(s.task.running.name, 'furnace')
    assert.equal(s.task.queue[0].name, 'excavate')
    assert.equal(s.task.parked[0].name, 'farm')
    assert.equal(s.chat.length, 2)
    assert.equal(s.chat[0].text, 'come here <img src=x onerror=alert(1)>')   // raw text; the page only uses textContent
    assert.equal(s.chests.indexed, 24)
    assert.equal(s.chests.indexErrors, 1)
    if (fs.existsSync(path.join(REAL, 'stations.json'))) assert.equal(s.chests.stations.length, 2)
    assert.equal(s.modules.safety.mode, 'warn')
    assert.equal(s.furnace.lava, 2)
  } finally { await d.stop() }
})

test('page, pov image, health check and routing', async () => {
  const api = makeMockApi({ realDir: REAL })
  const { d, base } = await boot(api)
  try {
    const page = await fetch(base + '/')
    assert.equal(page.status, 200)
    assert.match(await page.text(), /OzoGo444/)
    const pov = await fetch(base + '/pov/latest.png')
    const hasPov = fs.existsSync(path.join(api.dir, 'pov', 'latest.png'))
    assert.equal(pov.status, hasPov ? 200 : 404)
    assert.equal((await fetch(base + '/healthz')).status, 200)
    assert.equal((await fetch(base + '/nope')).status, 404)
    assert.equal((await fetch(base + '/../join.js')).status, 404)
    const s = await (await fetch(base + '/api/status')).json()
    assert.equal(s.pov.exists, hasPov)
  } finally { await d.stop() }
})

test('read-only and loopback-only', async () => {
  const api = makeMockApi()
  const { d, base } = await boot(api)
  try {
    assert.equal((await fetch(base + '/api/status', { method: 'POST', body: '{}' })).status, 405)
    assert.equal((await fetch(base + '/api/status', { method: 'DELETE' })).status, 405)
    // wrong Host header (DNS rebinding) is refused
    const http = require('http')
    const code = await new Promise((res, rej) => {
      http.get({ host: '127.0.0.1', port: d.port(), path: '/api/status', headers: { Host: 'evil.example.com' } }, r => { r.resume(); res(r.statusCode) }).on('error', rej)
    })
    assert.equal(code, 403)
    assert.equal(d.status().url, base + '/')
  } finally { await d.stop() }
})

test('holding lava is flagged', async () => {
  const api = makeMockApi()
  api.bot.heldItem = { name: 'lava_bucket', count: 1 }
  const { d, base } = await boot(api)
  try {
    const s = await (await fetch(base + '/api/status')).json()
    assert.equal(s.bot.holdingLava, true)
  } finally { await d.stop() }
})

test('survives a missing bot, missing files and a throwing status.all()', async () => {
  const api = makeMockApi()
  api.bot = null
  api.status.all = () => { throw new Error('boom') }
  for (const f of ['stations.json', 'chest-index.json', 'chat.log']) fs.rmSync(path.join(api.dir, f), { force: true })
  const { d, base } = await boot(api)
  try {
    const s = await (await fetch(base + '/api/status')).json()
    assert.equal(s.bot.online, false)
    assert.deepEqual(s.inventory.items, [])
    assert.deepEqual(s.chat, [])
    assert.equal(s.task.running, null)
    assert.equal(s.chests.indexed, 0)
    assert.equal(s.pov.exists, false)
  } finally { await d.stop() }
})

test('falls back to chat events, then chat.log, when status.all() has no chatTail', async () => {
  const api = makeMockApi()
  const orig = api.status.all
  api.status.all = () => ({ ...orig(), chatTail: undefined })
  const { d, base } = await boot(api)
  try {
    let s = await (await fetch(base + '/api/status')).json()
    assert.equal(s.chat[0].text, 'hello from chat.log')
    api.events.emit('chat', { user: 'OGWO', text: 'live line' })
    s = await (await fetch(base + '/api/status')).json()
    assert.equal(s.chat.at(-1).text, 'live line')
  } finally { await d.stop() }
})

test('writes status.json under statePath and cleans up on stop', async () => {
  const api = makeMockApi()
  const { d } = await boot(api, { writeStatusMs: 50 })
  const file = api.statePath('dashboard-status.json')
  try {
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).bot.username, 'OzoGo444')
  } finally { await d.stop() }
  assert.equal(api.events.listenerCount('chat'), 0)
  assert.equal(d.port(), null)
})

test('port in use: moves to the next port instead of failing', async () => {
  const api = makeMockApi()
  const a = dashboard.create(api, { port: 0, writeStatusMs: 0 })
  await a.start()
  const b = dashboard.create(makeMockApi(), { port: a.port(), writeStatusMs: 0 })
  await b.start()
  try {
    assert.equal(b.port(), a.port() + 1)
  } finally { await a.stop(); await b.stop() }
})
