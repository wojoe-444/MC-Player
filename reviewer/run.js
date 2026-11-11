#!/usr/bin/env node
// Spectator reviewer. Usage (all optional flags):
//   node run.js                     one review pass now (what Task Scheduler runs, via launch-reviewer.vbs)
//   node run.js --dry-run           print the system prompt and the evidence that would be sent; no model call
//   node run.js --force             review even when nothing changed since the last pass
//   node run.js --install-task      create the Task Scheduler job (every 10 min; --minutes N)    --uninstall-task   --task-status
//   --ozo DIR --smeo DIR            bot folders (default: the Bot Dashboard app's settings, else ~/Downloads/Minecraft-Survival and Minecraft-Smeo)
//   --model ID --effort LEVEL       default claude-haiku-5-5 at xhigh
//   node run.js --brief-only        answer the bots' dawn brief requests and stop (every normal pass does this first; --no-brief skips it)
//   node run.js --brief-dry-run     print the brief prompts that would be sent; no model call
//   node run.js --dream             the dream job (lib/dream.js): check each bot's memory against its journal, open and update work orders.
//                                   Its own Task Scheduler entry, every 2 h: --install-task --dream (--minutes N), --uninstall-task --dream, --task-status --dream
//   node run.js --dream --force     dream even when the journal has nothing new      --dream-dry-run   print the prompts and the candidates; no model call
//   node run.js --orders            print the work orders, most costly first
//   node run.js --deploy            the deployer on a schedule (lib/deploy.js): judge the last deploy, then put main on the live bots. Its own entry, every 30 min.
//   node run.js --digest            the daily digest (lib/digest.js): at most one a day, after 07:00; --force writes one now. Its own entry, checked hourly.
//   node run.js --fix               the fixer (lib/fixer.js): take the most costly open work order, fix it in the loop folder's own copy of the code, check
//                                   the fix, open the pull request. Its own entry, every 3 h. --only KEY takes that order; --fix-mode merge|pr|local;
//                                   --fix-dry-run prints the order and the prompt, no model call.
//   --code DIR                      the clone the live bots run from (default: the app's setting, else ~/Downloads/MC-Player-live)
//   --loop DIR                      where work orders and run logs live (default: beside the Bot Dashboard app's settings)
const path = require('path')
const { resolveConfig } = require('./lib/config')
const { runReview, logLine } = require('./lib/review')
const { runBriefs } = require('./lib/brief')
const { askClaude, runAgent } = require('./lib/claude')
const schedule = require('./lib/schedule')
const runs = require('./lib/runs')

async function main() {
  const cfg = resolveConfig({ argv: process.argv.slice(2) })
  const f = cfg.args.flags
  const job = schedule.JOBS[['dream', 'deploy', 'digest', 'fix'].find(j => f.has(j)) || 'review']
  if (f.has('install-task')) {
    const r = await schedule.install({ scriptPath: path.resolve(__filename), outDir: cfg.outDir, minutes: cfg.args.opts.minutes ? cfg.minutes : job.minutes, job })
    console.log(r.ok ? `Installed Task Scheduler job "${job.name}": every ${r.minutes} min while you are logged in, hidden window, runs ${r.nodeExe} ${__filename} ${job.args.join(' ')}` : `Could not install: ${r.error}`)
    return r.ok ? 0 : 1
  }
  if (f.has('uninstall-task')) { const r = await schedule.uninstall(undefined, job); console.log(r.ok ? `Removed the Task Scheduler job "${job.name}".` : `Could not remove: ${r.error}`); return r.ok ? 0 : 1 }
  if (f.has('task-status')) { console.log(JSON.stringify(await schedule.status(undefined, job), null, 1)); return 0 }
  if (f.has('orders')) { const { list, toMarkdown } = require('./lib/orders'); console.log(toMarkdown(list(cfg.loopDir), new Date().toISOString())); return 0 }
  if (f.has('deploy')) {
    const r = await require('./lib/deploy').runDeploy(cfg, { log: (m) => logLine(cfg, m, Date.now()), tests: !f.has('no-tests') })
    console.log(JSON.stringify(r)); return r.ok ? 0 : 1
  }
  if (f.has('digest')) {
    const r = require('./lib/digest').runDigest(cfg, { force: f.has('force'), log: (m) => logLine(cfg, m, Date.now()) })
    console.log(r.text || JSON.stringify(r)); return r.ok ? 0 : 1
  }
  if (f.has('fix') || f.has('fix-dry-run')) {
    const r = await require('./lib/fixer').runFix(cfg, { agent: runAgent, ask: askClaude, only: cfg.args.opts.only || null, dryRun: f.has('fix-dry-run'), log: (m) => logLine(cfg, m, Date.now()) })
    if (r.dryRun) { console.log(r.order ? `order ${r.order} on ${r.branch} (${r.mode} mode)\n\n--- system ---\n${r.system}\n\n--- prompt ---\n${r.prompt}` : 'no open work order to take'); return 0 }
    console.log(JSON.stringify(r)); return r.ok ? 0 : 1
  }
  if (f.has('dream') || f.has('dream-dry-run')) {
    const { runDream } = require('./lib/dream')
    const d = await runDream(cfg, { ask: askClaude, force: f.has('force'), dryRun: f.has('dream-dry-run'), log: (m) => logLine(cfg, m, Date.now()) })
    if (d.dryRun) { for (const b of d.bots) { console.log(`=== ${b.bot}: ${b.skipped || `${(b.candidates || []).length} candidates`} ===`); for (const c of b.candidates || []) console.log(`  ${c.costMin} min  ${c.key}: ${c.line}`); for (const p of b.prompts || []) console.log(`\n--- ${p.bot} ${p.step}: system ---\n${p.system}\n\n--- ${p.bot} ${p.step}: prompt ---\n${p.prompt}`) } return 0 }
    console.log(JSON.stringify({ ok: d.ok, skipped: d.skipped, bots: d.bots.map(b => ({ bot: b.bot, ok: b.ok, skipped: b.skipped, summary: b.summary, error: b.error })) }))
    return d.ok ? 0 : 1
  }
  // the dawn briefs first: a bot is waiting on its plan for the day (lib/brief.js); a failure here never stops the review
  if (f.has('brief-dry-run')) { const b = await runBriefs(cfg, { dryRun: true }); for (const p of b.prompts) console.log(`--- ${p.bot}: system ---\n${p.system}\n\n--- ${p.bot}: prompt ---\n${p.prompt}\n`); if (!b.prompts.length) console.log('no bot has a brief request waiting'); return 0 }
  let briefs = null
  if (!f.has('dry-run') && !f.has('no-brief')) { try { briefs = await runBriefs(cfg, { ask: askClaude, log: (m) => logLine(cfg, m, Date.now()) }) } catch (e) { logLine(cfg, 'brief job failed: ' + (e && e.message || e), Date.now()) } }
  for (const b of (briefs && briefs.briefs) || []) runs.append(cfg, 'brief', { bot: b.bot, ok: b.ok, summary: b.ok ? `answered ${b.id}` : `failed: ${b.error}`, costUsd: b.costUsd, durationMs: b.durationMs })
  if (f.has('brief-only')) { console.log(JSON.stringify(briefs)); return briefs && briefs.ok ? 0 : 1 }
  const r = await runReview(cfg, { ask: askClaude, force: f.has('force'), dryRun: f.has('dry-run') })
  if (r.dryRun) { console.log('--- system prompt ---\n' + r.system + '\n\n--- user prompt ---\n' + r.prompt); return 0 }
  if (!r.skipped) runs.append(cfg, 'review', { ok: r.ok, summary: r.ok ? `reviewed ${(r.reviewed || []).join(' and ')}` : `failed: ${r.error}`, costUsd: r.costUsd, durationMs: r.durationMs })
  console.log(JSON.stringify(r))
  return r.ok ? 0 : 1
}
main().then(c => process.exit(c), e => { console.error(e && e.stack || e); process.exit(1) })
