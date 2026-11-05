// Offline rig for brain/fastlane: a scriptable fake OpenRouter chat-completions endpoint and a catalog like the live bot's.
const fs = require('fs')
const os = require('os')
const path = require('path')
const catalogLib = require('../brain/router/catalog')
const { createFastlane, regFrom } = require('../brain/fastlane')
const { mockBot } = require('./mock-bot')
const { reply, fakeFetch, COMMANDS } = require('./router.helpers')

const SECRET = 'sk-or-v1-FASTLANESECRET0123456789abcdef'
const cmds = COMMANDS.map(c => ({ ...c, canonical: String(c.help).split('|').map(s => s.trim()) }))
const WP = [{ name: 'farm', x: -1030, y: 64, z: 2350 }, { name: 'house', x: -1060, y: 64, z: 2290 }, { name: 'portal (-637, -3030)', x: -637, y: 90, z: -3030 }]
const catalog = catalogLib.build({ commands: cmds, waypoints: WP })
const bot = mockBot({ pos: [-1045, 128, 2276] })
const reg = regFrom(bot)

// what OpenRouter returns for a chat completion whose message content is `content` (an object is sent as JSON text)
const completion = (content, model = 'someprovider/free-model-9b:free') => ({
  id: 'gen-1', model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 1500, completion_tokens: 30 }
})

// opts: { fetch, config, env, withKey, files, validate }
function rig(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fastlane-'))
  const logs = []
  const fl = createFastlane({
    now: opts.now || (() => Date.now()),
    log: (tag, msg) => logs.push(`${tag} ${msg}`),
    statePath: (f) => path.join(dir, f),
    fetch: opts.fetch,
    keyFile: opts.keyFile || path.join(dir, 'none.key'),
    env: opts.withKey === false ? {} : { OPENROUTER_API_KEY: SECRET, ...(opts.env || {}) },
    config: { timeoutMs: 150, ...(opts.config || {}) },
    ...(opts.validate ? { validate: opts.validate } : {})
  })
  const ask = (text, o = {}) => fl.decide({ user: 'OGWO', text, state: { doing: 'idle', health: 20, food: 18 }, catalog, reg, ...o })
  return { fl, dir, logs, ask, log: () => { try { return fs.readFileSync(path.join(dir, 'fastlane-log.jsonl'), 'utf8') } catch { return '' } } }
}

module.exports = { rig, completion, reply, fakeFetch, catalog, reg, bot, SECRET, WP }
