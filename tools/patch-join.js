#!/usr/bin/env node
// Builds patched copies of join.js and farm.js in next/ so the brain/ modules can be switched on at the next batched restart.
// The live files are NEVER modified unless you pass --apply (do that only together with the restart, after agreeing it with
// the coordinator). Every edit is anchored on an exact string that must occur exactly once; if the driver has changed the
// code around an anchor the tool stops and says which one, instead of guessing.
//
//   node tools/patch-join.js            build next/join.js + next/farm.js, syntax-check, print the diff
//   node tools/patch-join.js --apply    back up the live files to backup/<timestamp>/ and copy next/* over them
//   NO_BRAIN=1 node join.js             (after applying) starts the bot with the brain switched off
const fs = require('fs')
const path = require('path')
const cp = require('child_process')

const root = path.resolve(__dirname, '..')
const out = path.join(root, 'next')
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8')

const EDITS = {
  'join.js': [
    { id: 'brain-var', find: `bot.loadPlugin(pathfinder)\n`,
      repl: `bot.loadPlugin(pathfinder)\nlet BRAIN = null // set by the brain loader near the bottom of this file (brain/index.js); null = legacy behaviour\n` },
    { id: 'navigate-wrapper', find: `function navigate(goal, label, dynamic = false) {\n`,
      repl: `function navigate(goal, label, dynamic = false) { if (BRAIN) return BRAIN.navigate(goal, label, dynamic); return navigateRaw(goal, label, dynamic) }\nfunction navigateRaw(goal, label, dynamic = false) {\n` },
    { id: 'bed-interval-gate', find: `setInterval(() => { bedRoutine().catch(`, repl: `setInterval(() => { if (BRAIN) return; bedRoutine().catch(` },
    { id: 'idle-interval-gate', find: `Date.now() - lastChatAt < 120000 || anyTaskBusy()) return`,
      repl: `BRAIN || Date.now() - lastChatAt < 120000 || anyTaskBusy()) return` },
    { id: 'no-excavation-autoresume', find: `if (excavation.shouldAutoResume()) excavation.resume()`, repl: `if (!BRAIN && excavation.shouldAutoResume()) excavation.resume()` },
    { id: 'stop-hook', find: `excavation.stop(); farm.stop(); stopNav(); say('Staying put.')`, repl: `excavation.stop(); farm.stop(); BRAIN && BRAIN.userStop(); stopNav(); say('Staying put.')` },
    { id: 'chat-route', find: `if (!handleCommand(g[1], g[2])) say('Got it, one moment.')`, repl: `if (!routeChat(g[1], g[2])) say('Got it, one moment.')` },
    { id: 'cmd-route', find: `console.log('CMD', line); handleCommand('OGWO', line)`, repl: `console.log('CMD', line); routeChat('OGWO', line, true)` },
    { id: 'brain-loader', find: `bot.on('kicked', r =>`,
      repl: `// --- brain: scheduler, furnace upkeep, optional safety/chat/dashboard modules (see brain/INTERFACE.md). NO_BRAIN=1 disables it. ---
function routeChat(user, text, fromCmd = false) {
  if (BRAIN) { try { return BRAIN.route(user, text, { handleCommand, fromCmd }) } catch (e) { console.log('BRAIN_ROUTE_ERROR', e.stack || e.message) } }
  return handleCommand(user, text)
}
bot.once('spawn', () => setTimeout(() => {
  if (process.env.NO_BRAIN) return console.log('BRAIN disabled (NO_BRAIN)')
  try {
    BRAIN = require('./brain')({
      bot, say, goals, tryGoto, stopNav, navigateRaw, navActive: () => !!navGoal, handleCommand, farm, excavation,
      jobs: { @@JOBS@@ },
      routines, saveRoutines: () => require('fs').writeFileSync(ROUTINE_FILE, JSON.stringify(routines)),
      sleepWanted: () => !sleepBusy && Date.now() >= sleepRetryAt && bot.time.age - sleepState.lastWakeAge >= SLEEP_DUE_TICKS,
      stopAllLegacy: () => { testing = false; indexing = false; excavation.stop(); farm.stop(); stopNav() }
    })
    console.log('BRAIN loaded')
  } catch (e) { BRAIN = null; console.log('BRAIN_LOAD_ERROR', e.stack || e.message) }
}, 4000))
bot.on('kicked', r =>` }
  ],
  'farm.js': [
    { id: 'no-auto-eat-while-busy', find: `if (eating || !bot.entity || bot.food === undefined || bot.food > 14 || bot.isSleeping) return`,
      repl: `if (eating || !bot.entity || bot.food === undefined || bot.food > 14 || bot.isSleeping || bot.noAutoEat) return` }
  ]
}

// identifiers the injected loader refers to; the tool refuses to build if one has disappeared (a ReferenceError at spawn would
// otherwise silently disable the brain). OPTIONAL ones are simply left out of the jobs list.
const REQUIRED = ['bedRoutine', 'sleepBusy', 'sleepRetryAt', 'sleepState', 'SLEEP_DUE_TICKS', 'routines', 'ROUTINE_FILE', 'navGoal', 'testing', 'indexing', 'farm', 'excavation', 'tryGoto', 'stopNav', 'say', 'goals', 'handleCommand', 'indexChests', 'inspectStations', 'craftToolSet', 'runNavTest', 'runDoorTest']
const OPTIONAL = ['usePortal']
const defined = (src, n) => new RegExp(String.raw`\b(?:function|const|let|var)\s+${n}\b`).test(src) ||
  new RegExp(String.raw`\b(?:const|let|var)\s[^;\n]*[,{\s]${n}\s*(?:=|,|\})`).test(src)   // comma lists and destructuring

function patch(file) {
  let src = read(file)
  if (file === 'join.js') {
    const missing = REQUIRED.filter(n => !defined(src, n))
    if (missing.length) throw new Error(`join.js no longer defines: ${missing.join(', ')}. Update tools/patch-join.js.`)
    const jobs = ['bedRoutine', 'indexChests', 'inspectStations', 'craftToolSet', 'runNavTest', 'runDoorTest', ...OPTIONAL.filter(n => defined(src, n))].join(', ')
    for (const e of EDITS[file]) e.repl = e.repl.replace('@@JOBS@@', jobs)
  }
  if (/BRAIN|noAutoEat/.test(src) && file !== 'farm.js') throw new Error(`${file} already contains brain hooks; refusing to patch twice`)
  const done = []
  for (const e of EDITS[file]) {
    const n = src.split(e.find).length - 1
    if (n !== 1) throw new Error(`${file}: anchor "${e.id}" matched ${n} times (expected 1). The code around it changed; update tools/patch-join.js.`)
    src = src.replace(e.find, () => e.repl)
    done.push(e.id)
  }
  return { src, done }
}

function main() {
  const apply = process.argv.includes('--apply')
  fs.mkdirSync(out, { recursive: true })
  for (const file of Object.keys(EDITS)) {
    const { src, done } = patch(file)
    fs.writeFileSync(path.join(out, file), src)
    cp.execFileSync(process.execPath, ['--check', path.join(out, file)])
    console.log(`next/${file}: ${done.length} edits (${done.join(', ')}), syntax OK`)
    try { console.log(cp.spawnSync('diff', ['-u', path.join(root, file), path.join(out, file)], { encoding: 'utf8' }).stdout) } catch {}
  }
  if (!apply) return console.log('Built next/. Nothing live was touched. Review the diff, then at the batched restart: node tools/patch-join.js --apply')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const bdir = path.join(root, 'backup', stamp)
  fs.mkdirSync(bdir, { recursive: true })
  for (const file of Object.keys(EDITS)) { fs.copyFileSync(path.join(root, file), path.join(bdir, file)); fs.copyFileSync(path.join(out, file), path.join(root, file)) }
  console.log(`Applied. Originals saved in backup/${stamp}/. Restart the bot (run.js) to load the brain; roll back by copying the backup over.`)
}
try { main() } catch (e) { console.error('PATCH FAILED:', e.message); process.exit(1) }
