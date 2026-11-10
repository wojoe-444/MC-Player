#!/usr/bin/env node
// Spectator reviewer. Usage (all optional flags):
//   node run.js                     one review pass now (what Task Scheduler runs, via launch-reviewer.vbs)
//   node run.js --dry-run           print the system prompt and the evidence that would be sent; no model call
//   node run.js --force             review even when nothing changed since the last pass
//   node run.js --install-task      create the Task Scheduler job (every 10 min; --minutes N)    --uninstall-task   --task-status
//   --ozo DIR --smeo DIR            bot folders (default: the Bot Dashboard app's settings, else ~/Downloads/Minecraft-Survival and Minecraft-Smeo)
//   --model ID --effort LEVEL       default claude-haiku-5-5 at xhigh
const path = require('path')
const { resolveConfig } = require('./lib/config')
const { runReview } = require('./lib/review')
const { askClaude } = require('./lib/claude')
const schedule = require('./lib/schedule')

async function main() {
  const cfg = resolveConfig({ argv: process.argv.slice(2) })
  const f = cfg.args.flags
  if (f.has('install-task')) {
    const r = await schedule.install({ scriptPath: path.resolve(__filename), outDir: cfg.outDir, minutes: cfg.minutes })
    console.log(r.ok ? `Installed Task Scheduler job "${schedule.TASK_NAME}": every ${cfg.minutes} min while you are logged in, hidden window, runs ${r.nodeExe} ${__filename}` : `Could not install: ${r.error}`)
    return r.ok ? 0 : 1
  }
  if (f.has('uninstall-task')) { const r = await schedule.uninstall(); console.log(r.ok ? 'Removed the Task Scheduler job.' : `Could not remove: ${r.error}`); return r.ok ? 0 : 1 }
  if (f.has('task-status')) { console.log(JSON.stringify(await schedule.status(), null, 1)); return 0 }
  const r = await runReview(cfg, { ask: askClaude, force: f.has('force'), dryRun: f.has('dry-run') })
  if (r.dryRun) { console.log('--- system prompt ---\n' + r.system + '\n\n--- user prompt ---\n' + r.prompt); return 0 }
  console.log(JSON.stringify(r))
  return r.ok ? 0 : 1
}
main().then(c => process.exit(c), e => { console.error(e && e.stack || e); process.exit(1) })
