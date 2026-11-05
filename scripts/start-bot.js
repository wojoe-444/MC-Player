#!/usr/bin/env node
// Start one bot under the supervisor (run.js), from its own runtime folder.
//   node scripts/start-bot.js ozo
//   node scripts/start-bot.js smeo
//
// Both bots run the same code (this repo's join.js + brain/). What differs is per-bot config in bots/<bot>/:
//   bot.json            name, viewer port, extra env
//   bot.local.env       KEY=VALUE lines, NOT committed (MC_EMAIL, optionally MC_PORT); copy from bot.local.env.example
//   profile.json        who the bot is: name, role, stance, planner on/off, disabled modules (copied to brain/state/profile.json the first time)
//   seed/               files copied into the runtime folder the first time (never overwritten afterwards)
// Everything the bot writes (logs, brain/state, auth-cache, waypoints, chat files) lives in runtime/<bot>/ (gitignored).
// Set BOT_RUNTIME_DIR to point at an existing runtime folder instead (e.g. a bot folder that is already running).
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const bot = process.argv[2]
const repo = path.join(__dirname, '..')
const cfgDir = path.join(repo, 'bots', String(bot))
if (!bot || !fs.existsSync(path.join(cfgDir, 'bot.json'))) {
  const known = fs.readdirSync(path.join(repo, 'bots')).filter(d => fs.existsSync(path.join(repo, 'bots', d, 'bot.json')))
  console.error('usage: node scripts/start-bot.js <' + known.join('|') + '>'); process.exit(2)
}
const cfg = JSON.parse(fs.readFileSync(path.join(cfgDir, 'bot.json'), 'utf8').replace(/^﻿/, ''))   // bot.json files were saved with a BOM

function readEnvFile(file) {
  const out = {}
  if (!fs.existsSync(file)) return out
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

function copySeed(from, to) {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name)
    if (e.isDirectory()) { fs.mkdirSync(b, { recursive: true }); copySeed(a, b) }
    else if (!fs.existsSync(b)) { fs.mkdirSync(path.dirname(b), { recursive: true }); fs.copyFileSync(a, b) }
  }
}

const runtime = process.env.BOT_RUNTIME_DIR ? path.resolve(process.env.BOT_RUNTIME_DIR) : path.join(repo, 'runtime', bot)
fs.mkdirSync(runtime, { recursive: true })
if (fs.existsSync(path.join(cfgDir, 'seed'))) copySeed(path.join(cfgDir, 'seed'), runtime)
// the bot profile (name, role, stance, planner, disabled modules) lives in brain/state/profile.json of the runtime folder: seeded once, then the bot itself
// updates it (the stance switch). A runtime folder that already has the old role.json / mode.json / disabled-modules.json files and no profile.json keeps using those.
const profileSeed = path.join(cfgDir, 'profile.json'), profileDest = path.join(runtime, 'brain', 'state', 'profile.json')
const legacyState = ['role.json', 'mode.json', 'disabled-modules.json'].some(f => fs.existsSync(path.join(runtime, 'brain', 'state', f)))
if (fs.existsSync(profileSeed) && !fs.existsSync(profileDest) && !legacyState) { fs.mkdirSync(path.dirname(profileDest), { recursive: true }); fs.copyFileSync(profileSeed, profileDest) }

const env = { ...process.env, ...(cfg.env || {}), ...readEnvFile(path.join(cfgDir, 'bot.local.env')) }
if (cfg.viewerPort && !env.VIEWER_PORT) env.VIEWER_PORT = String(cfg.viewerPort)
if (!env.MC_EMAIL) { console.error(`MC_EMAIL missing: create bots/${bot}/bot.local.env (see bot.local.env.example)`); process.exit(1) }

console.log(`starting ${cfg.name} (${bot}) in ${runtime}`)
const child = spawn(process.execPath, [path.join(repo, 'run.js')], { cwd: runtime, env, stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 0))
