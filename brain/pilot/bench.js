// node brain/pilot/bench.js [model ...]   (needs the OpenRouter key like the router: env OPENROUTER_API_KEY or brain/router/openrouter.key)
// Runs the quick voice against real lines from chat.log with a fixed sample state and prints reply + latency per model. The key is never printed.
const fs = require('fs')
const path = require('path')
const { createTalker, notesReader } = require('./talker')

const ROOT = path.resolve(__dirname, '..', '..')
const models = process.argv.slice(2).length ? process.argv.slice(2) : ['mistralai/ministral-8b-2512']
const N = Number(process.env.BENCH_N || 14)

const lines = fs.readFileSync(path.join(ROOT, 'chat.log'), 'utf8').split(/\r?\n/).filter(l => l.startsWith('OGWO: ')).map(l => l.slice(6))
// a spread: long and short, ideas, questions, feedback
const pick = lines.filter((l, i) => i % Math.max(1, Math.floor(lines.length / N)) === 0).slice(0, N)
pick.push('what is your health', 'thanks!', 'you should not walk into lava')
const state = { doing: 'furnace upkeep (3/5 chests)', queue: ['excavation'], health: 20, food: 17, time: 'day', dimension: 'overworld', walter: { near: false, quietS: 12 }, routines: { farm: 'on', furnace_upkeep: 'on' }, carrying: { food: 24, pickaxe: 'iron', armor_worn: 'none', armor_in_bag: 'iron set' } }
const notes = fs.existsSync(path.join(ROOT, 'brain/state/claude-notes.md')) ? fs.readFileSync(path.join(ROOT, 'brain/state/claude-notes.md'), 'utf8') : ''

;(async () => {
  for (const model of models) {
    const t = createTalker({ config: { model, timeoutMs: 8000, maxTokens: Number(process.env.BENCH_TOKENS || 140), extraBody: process.env.BENCH_EXTRA ? JSON.parse(process.env.BENCH_EXTRA) : {} } })
    if (!t.hasKey()) { console.log('no OpenRouter key found'); return }
    console.log('\n=== ' + model)
    const ms = []
    const recentBot = []
    for (const text of pick) {
      const r = await t.reply({ text, state, notes, history: [], recentBot })
      ms.push(r.ms)
      if (r.action === 'say') recentBot.push(r.text)
      console.log(`[${String(r.ms).padStart(4)}ms ${r.action}${r.action === 'say' ? (r.followup ? ' +fu' : '') : ' ' + r.reason}] ${text.slice(0, 70)}\n        -> ${r.text || (r.rejected ? '(rejected: ' + r.rejected + ')' : '')}`)
    }
    ms.sort((a, b) => a - b)
    console.log(`median ${ms[Math.floor(ms.length / 2)]} ms, max ${ms[ms.length - 1]} ms; ${JSON.stringify(t.status().byReason)}`)
  }
})()
