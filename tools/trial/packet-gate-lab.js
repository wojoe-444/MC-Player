#!/usr/bin/env node
// Packet-gate lab (insights doc, Haiku check 6): run the real join.js + brain on the offline trial server with armor and iron/diamond tools
// in the bag, with a LOG-ONLY gate on every outgoing packet (gate-preload.js), and list every code path that would have broken a rule.
//   node .claude/skills/trial-server/scripts/server.js start
//   node tools/trial/packet-gate-lab.js [--port 25599] [--minutes 5] [--out /tmp/gate-lab]
// Works in a scratch copy of the repo, so the repo and the live bots are untouched. Never point it at the real world.
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const cp = require('child_process')
const mineflayer = require('mineflayer')

const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d }
const PORT = +opt('port', 25599)
const MIN = +opt('minutes', 5)
const OUT = opt('out', path.join(os.tmpdir(), 'gate-lab'))
const root = path.resolve(__dirname, '..', '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(path.join(OUT, 'brain', 'state'), { recursive: true })
for (const f of ['join.js', 'run.js', 'farm.js', 'excavate.js', 'package.json']) fs.copyFileSync(path.join(root, f), path.join(OUT, f))
fs.cpSync(path.join(root, 'brain'), path.join(OUT, 'brain'), { recursive: true, filter: s => !s.includes(path.sep + 'state') })
fs.cpSync(path.join(root, 'vendor'), path.join(OUT, 'vendor'), { recursive: true })
fs.mkdirSync(path.join(OUT, 'brain', 'state'), { recursive: true })
fs.copyFileSync(path.join(root, 'bots', 'ozo', 'profile.json'), path.join(OUT, 'brain', 'state', 'profile.json'))
fs.symlinkSync(path.join(root, 'node_modules'), path.join(OUT, 'node_modules'), 'dir')
const GATE_LOG = path.join(OUT, 'gate.jsonl')

async function main () {
  const ctl = mineflayer.createBot({ host: 'localhost', port: PORT, username: 'TrialB', version: '1.21.6', auth: 'offline' })
  await new Promise((res, rej) => { ctl.once('spawn', res); ctl.once('error', rej) })
  const cmd = async c => { ctl.chat(c); await sleep(250) }
  const child = cp.spawn(process.execPath, ['-r', path.join(__dirname, 'gate-preload.js'), 'join.js'], {
    cwd: OUT, env: { ...process.env, MC_EMAIL: 'TrialA', MC_PORT: String(PORT), TRIAL_PORT: String(PORT), TRIAL_NAME: 'TrialA', GATE_LOG, BOT_DASHBOARD_PORT: '-1', SKIP_HELLO: '1' }, stdio: ['ignore', fs.openSync(path.join(OUT, 'join.log'), 'a'), fs.openSync(path.join(OUT, 'join.log'), 'a')]
  })
  await sleep(15000)
  for (const c of ['/gamemode survival TrialA', '/gamerule doMobSpawning false', '/time set day', '/clear TrialA',
    '/give TrialA minecraft:iron_helmet', '/give TrialA minecraft:iron_chestplate', '/give TrialA minecraft:iron_leggings', '/give TrialA minecraft:iron_boots',
    '/give TrialA minecraft:diamond_chestplate', '/give TrialA minecraft:shield', '/give TrialA minecraft:iron_sword', '/give TrialA minecraft:iron_pickaxe',
    '/give TrialA minecraft:diamond_pickaxe', '/give TrialA minecraft:iron_axe', '/give TrialA minecraft:cobblestone 64', '/give TrialA minecraft:oak_planks 32',
    '/give TrialA minecraft:torch 16', '/give TrialA minecraft:bread 16']) await cmd(c)
  // things Walter might say, and terrain to chew on
  const p = ctl.entity.position.floored()
  for (let i = 0; i < 6; i++) await cmd(`/setblock ${p.x + 3 + i} ${p.y} ${p.z + 3} minecraft:stone`)
  for (let i = 0; i < 4; i++) await cmd(`/setblock ${p.x - 3} ${p.y + i} ${p.z + 3} minecraft:oak_log`)
  const say = ['TrialA put on your armor', 'TrialA mine some stone', 'TrialA craft an iron pickaxe', 'TrialA equip your best gear', 'TrialA chop that tree']
  const end = Date.now() + MIN * 60000
  let i = 0
  while (Date.now() < end) { ctl.chat(say[i++ % say.length]); await sleep(25000) }
  child.kill()
  ctl.quit()
  await sleep(500)
  const lines = fs.existsSync(GATE_LOG) ? fs.readFileSync(GATE_LOG, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  const by = {}
  for (const l of lines) { const k = l.rule + ' | ' + (l.stack && l.stack[0] || '?'); (by[k] = by[k] || { n: 0, how: l.how }).n++ }
  const rows = Object.entries(by).sort((a, b) => b[1].n - a[1].n)
  const md = ['| rule | first stack frame | events | example |', '|---|---|---|---|', ...rows.map(([k, v]) => `| ${k.split(' | ')[0]} | ${k.split(' | ')[1]} | ${v.n} | ${v.how} |`)].join('\n')
  fs.writeFileSync(path.join(OUT, 'summary.md'), md + '\n')
  console.log(`${lines.length} gate events in ${MIN} min\n` + md)
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
