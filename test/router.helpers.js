// Offline rig for brain/router: a fake brain api (commands, events, say, statePath) and a scriptable fake OpenRouter.
const EventEmitter = require('events')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { mockBot } = require('./mock-bot')

const SECRET = 'sk-or-v1-TESTSECRET0123456789abcdef'

// what the Decisions API returns for the "command" (+ optional "place") and "directed" questions
function decision({ label, p = 0.95, directed = 0.95, place = null, placeP = 0.9, second = null }) {
  const probs = { [label]: p }
  if (second) probs[second[0]] = second[1]
  else if (label !== 'none') probs.none = +(1 - p).toFixed(3)
  const answers = { directed: { type: 'noul', noul: directed }, command: { type: 'choice', choice: label, confidence: p, probabilities: probs } }
  if (place) answers.place = { type: 'choice', choice: place, confidence: placeP, probabilities: { [place]: placeP } }
  return { model: 'baseten/elephant-1-20261021:free', provider: 'BaseTen', answers, usage: { input_tokens: 900, output_tokens: 5 } }
}
const chatOk = (obj) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ model: 'openrouter/free-test', choices: [{ message: { content: typeof obj === 'string' ? obj : JSON.stringify(obj) } }] }) })
const reply = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => typeof body === 'string' ? body : JSON.stringify(body) })

// script: array of responders (function(req) | object | Error), consumed in order; the last one repeats
function fakeFetch(script) {
  const calls = []
  const f = async (url, init) => {
    const body = JSON.parse(init.body)
    const call = { url, headers: init.headers, body, signal: init.signal }
    calls.push(call)
    let s = script[Math.min(calls.length - 1, script.length - 1)]
    if (typeof s === 'function') s = await s(call)
    if (s instanceof Error) throw s
    if (s && s.hang) await new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    return s && s.status ? s : reply(200, s)
  }
  f.calls = calls
  return f
}

const COMMANDS = [
  { name: 'furnace-start', help: 'start furnace upkeep', risk: 'high' },
  { name: 'furnace-status', help: 'furnace status' },
  { name: 'queue', help: 'what are you doing' },
  { name: 'excavate-resume', help: 'resume excavation', risk: 'high' },
  { name: 'excavate-start', help: 'excavate', risk: 'high' },
  { name: 'resume', help: 'resume tasks', risk: 'high' },
  { name: 'craft-item', help: 'craft <item> [count]', risk: 'high' }
]

// opts: { mode, fetch, config, env, withKey, events, handled(canonical)->bool }
function rig(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-'))
  const bot = mockBot({ pos: [-1045, 128, 2276] })
  fs.writeFileSync(path.join(dir, 'waypoints.json'), JSON.stringify({ farm: { x: -1030, y: 64, z: 2350 }, house: { x: -1060, y: 64, z: 2290 }, 'portal (-637, -3030)': { x: -637, y: 90, z: -3030 } }))
  const said = [], dispatched = [], logs = []
  const events = new EventEmitter()
  const registered = COMMANDS.map(c => ({ ...c, canonical: String(c.help).split('|').map(s => s.trim()) }))
  const added = []
  const api = {
    bot, ownerName: 'OGWO', dir, events,
    now: () => Date.now(),
    say: (t) => said.push(t),
    log: (tag, msg) => logs.push(`${tag} ${msg}`),
    statePath: (f) => path.join(dir, f),
    scheduler: { status: () => ({ running: null }) },
    commands: {
      add: (c) => { added.push(c); registered.push({ name: c.name, help: c.help || '', risk: c.risk || 'low', canonical: String(c.help || '').split('|').map(s => s.trim()) }); return true },
      list: () => registered.map(c => ({ name: c.name, help: c.help, risk: c.risk || 'low', canonical: c.canonical })),
      dispatch: (user, text) => { dispatched.push(text); return opts.handled ? opts.handled(text) : true }
    },
    routerOptions: {
      fetch: opts.fetch,
      keyFile: path.join(dir, 'none.key'),
      env: opts.withKey === false ? {} : { OPENROUTER_API_KEY: SECRET, ...(opts.env || {}) },
      config: { mode: opts.mode || 'live', ackAfterMs: 40, timeoutMs: 120, decisionModel: true, fastlane: !!opts.flFetch, ...(opts.config || {}) },
      fastlane: opts.flFetch ? { fetch: opts.flFetch, env: { OPENROUTER_API_KEY: SECRET }, config: { maxPerDay: 0, cacheMs: 0, ...(opts.flConfig || {}) } } : undefined
    }
  }
  const mod = require('../brain/router')(api)
  // like brain/index.js route(): the 'chat' event first, then onChat, then (when nothing else took the line) fallback
  const say = (user, text, o = {}) => {
    if (!o.fromCmd) events.emit('chat', { user, text })
    if (mod.onChat(user, text)) return true
    return mod.fallback(user, text)
  }
  return { api, mod, bot, said, dispatched, logs, dir, say, events, added, unhandled: () => { try { return fs.readFileSync(path.join(dir, 'unhandled.log'), 'utf8') } catch { return '' } }, routerLog: () => { try { return fs.readFileSync(path.join(dir, 'router-log.jsonl'), 'utf8') } catch { return '' } } }
}

module.exports = { rig, decision, chatOk, reply, fakeFetch, SECRET, COMMANDS }
