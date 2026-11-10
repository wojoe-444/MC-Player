#!/usr/bin/env node
// Rebuild an incident snapshot (brain/state/snapshots/*.json, written by brain/snapshot on every high telemetry flag) on a trial server.
//
//   node tools/snapshot-rebuild.js <snapshot.json> --print                    list the commands (no server needed)
//   node tools/snapshot-rebuild.js <snapshot.json> --run [--port 25599] [--user TrialA] [--shift dx,dy,dz] [--pace 120] [--verify]
//
// --run connects an op'd offline-mode bot (see .claude/skills/trial-server: setup with --ops TrialA, then `server.js start`) and runs the commands about
// 8 per second, so the server does not kick for spam. It never points at a real world: only localhost, only offline auth.
// --verify compares every rebuilt block with the snapshot afterwards and prints the mismatches.
// The scenario's fail test is the flag kind recorded in the snapshot; the pass test is that the step's goal is reached and the detector stays quiet.
const fs = require('fs')
const { buildCommands, decodeCells } = require('../brain/snapshot')

function parseArgs(argv) {
  const o = { file: null, print: false, run: false, port: 25599, user: 'TrialA', shift: [0, 0, 0], pace: 120, verify: false, host: 'localhost' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--print') o.print = true
    else if (a === '--run') o.run = true
    else if (a === '--verify') o.verify = true
    else if (a === '--port') o.port = Number(argv[++i])
    else if (a === '--user') o.user = argv[++i]
    else if (a === '--pace') o.pace = Number(argv[++i])
    else if (a === '--shift') o.shift = argv[++i].split(',').map(Number)
    else if (!a.startsWith('--')) o.file = a
  }
  return o
}

async function run(snap, o) {
  const mineflayer = require('mineflayer')
  const { Vec3 } = require('vec3')
  const bot = mineflayer.createBot({ host: o.host, port: o.port, username: o.user, version: '1.21.6', auth: 'offline' })
  await new Promise((res, rej) => { bot.once('spawn', res); bot.once('error', rej); bot.once('kicked', (r) => rej(new Error('kicked: ' + r))) })
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const cmds = buildCommands(snap, { shift: o.shift })
  await sleep(1500)
  // the area must be loaded before it is filled: go to the middle first
  const c = snap.bot
  bot.chat(`/tp @s ${(c.x + o.shift[0]).toFixed(1)} ${(c.y + o.shift[1] + 40).toFixed(1)} ${(c.z + o.shift[2]).toFixed(1)}`); await sleep(1500)
  for (const { cmd } of cmds) { bot.chat(cmd); await sleep(o.pace) }
  await sleep(1500)
  if (snap.quickBarSlot != null) { try { bot.setQuickBarSlot(snap.quickBarSlot) } catch { /* ignore */ } }
  let bad = 0
  if (o.verify) {
    const want = decodeCells(snap)
    for (const [k, s] of want) {
      const [x, y, z] = k.split(',').map(Number)
      const b = bot.blockAt(new Vec3(x + o.shift[0], y + o.shift[1], z + o.shift[2]))
      const name = s.split('[')[0]
      if (!b || b.name !== name) { if (bad++ < 20) console.log(`mismatch ${k}: want ${s}, got ${b ? b.name : 'unloaded'}`) }
    }
    console.log(`verify: ${want.size - bad} of ${want.size} blocks match`)
  }
  console.log(`rebuilt ${snap.id} (${snap.flag ? snap.flag.kind : 'no flag'}) as ${o.user} at ${(c.x + o.shift[0]).toFixed(1)} ${(c.y + o.shift[1]).toFixed(1)} ${(c.z + o.shift[2]).toFixed(1)}; ${cmds.length} commands`)
  return bot
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  if (!o.file || (!o.print && !o.run)) { console.error('usage: node tools/snapshot-rebuild.js <snapshot.json> --print | --run [--port N] [--user Name] [--shift dx,dy,dz] [--pace ms] [--verify]'); process.exit(2) }
  const snap = JSON.parse(fs.readFileSync(o.file, 'utf8'))
  if (o.print) { for (const { cmd } of buildCommands(snap, { shift: o.shift })) console.log(cmd); return }
  const bot = await run(snap, o)
  if (!process.env.KEEP_BOT) { bot.quit(); setTimeout(() => process.exit(0), 300) }
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1) })
module.exports = { parseArgs }
