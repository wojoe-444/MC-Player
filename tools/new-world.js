#!/usr/bin/env node
// Makes a clean copy of the bot for a different world, so nothing from the old world (waypoints, bases, chests, goals, saved focus, learned state) carries over,
// and the old world's folder stays exactly as it is (you can switch back by starting the old folder again). Only ONE bot may run at a time: it is the same account.
//
//   node tools/new-world.js <target-dir> <lan-port> [--keep-config]
//     copies code + config (brain/, join.js, run.js, farm.js, excavate.js, package.json, tools/, test/, docs) and a node_modules junction;
//     does NOT copy brain/state/, waypoints.json, stations.json, chest-index.json, exc-state.json, sleep-state.json, routine-state.json, logs, pov/, backups, find-*.txt;
//     writes lan-port.txt, an empty waypoints.json, and tells you which config files still hold old-world coordinates (edit those in the copy).
//   then, from the target dir:  node run.js   (stop the old bot first)
const fs = require('fs')
const path = require('path')

const src = path.resolve(__dirname, '..')
const dst = path.resolve(process.argv[2] || '')
const port = parseInt(process.argv[3], 10)
if (!process.argv[2] || !port) { console.error('usage: node tools/new-world.js <target-dir> <lan-port>'); process.exit(1) }
if (dst === src || dst.startsWith(src + path.sep)) { console.error('target must be a different folder, outside the old one'); process.exit(1) }

const SKIP_DIR = new Set(['node_modules', 'backup', 'logs', 'pov', 'next', 'auth-cache', 'state', '.git'])
const SKIP_FILE = /^(waypoints|stations|chest-index|exc-state|sleep-state|routine-state|room-map)\.(json|txt)$|^find-.*\.txt$|\.log$|^(chat|outbox|cmd|unhandled|chat-context)\.(log|txt|jsonl)$|^player-pos\.json$|^_p\d+\.js$|^furnace-scan\.txt$|^lava-scan\.txt$|^los\.log$|^idle\.log$/
let copied = 0
function copy(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) { if (SKIP_DIR.has(e.name)) continue; copy(path.join(from, e.name), path.join(to, e.name)) }
    else if (!SKIP_FILE.test(e.name)) { fs.copyFileSync(path.join(from, e.name), path.join(to, e.name)); copied++ }
  }
}
copy(src, dst)
fs.mkdirSync(path.join(dst, 'brain', 'state'), { recursive: true })
fs.writeFileSync(path.join(dst, 'lan-port.txt'), port + '\n')
fs.writeFileSync(path.join(dst, 'waypoints.json'), '{}\n')
fs.writeFileSync(path.join(dst, 'brain', 'state', 'disabled-modules.json'), '["mining","build","villagers"]')   // world-specific jobs off until the new base exists
try { fs.symlinkSync(path.join(src, 'node_modules'), path.join(dst, 'node_modules'), 'junction') } catch (e) { console.log('node_modules junction failed: ' + e.message) }
try { fs.cpSync(path.join(src, 'auth-cache'), path.join(dst, 'auth-cache'), { recursive: true }) } catch (e) { console.log('auth-cache not copied: ' + e.message) }

console.log(`Copied ${copied} files to ${dst}; port ${port}.`)
console.log('Config files that hold OLD-WORLD coordinates and need blanking or editing in the copy before the bot uses those features:')
for (const f of ['brain/furnace-config.json', 'brain/mining/config.json', 'brain/excavation/config.json', 'brain/build/config.json', 'brain/routines/config.json', 'brain/treefarm/config.json', 'brain/safety/config.json', 'brain/villagers/config.json', 'brain/nav/config.json', 'brain/crafting/config.json', 'brain/bagroom.js (house chest)', 'brain/state (reserved.json etc., not copied)']) console.log('  - ' + f)
console.log('Modules disabled in the copy until the new base exists: mining, build, villagers (brain/state/disabled-modules.json).')
console.log('Start it with:  cd ' + dst + '  &&  node run.js   (stop the old bot first)')
