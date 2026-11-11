// The memory loop as the app shows it (docs/MEMORY-LOOP.md): its scheduled jobs, the ranked work orders, each bot's memory file and last memory check,
// and the run log. Pure Node, no electron import, so it can be unit tested. Everything is read from this computer; nothing here calls a model.
const fs = require('fs')
const path = require('path')

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')) } catch { return null } }
const readText = (f, max = 20000) => { try { return fs.readFileSync(f, 'utf8').slice(0, max) } catch { return null } }

// the reviewer package's own modules (bundled with the app, or ../reviewer from source); null when the folder is missing
function loadLib(reviewerDir) {
  try {
    const lib = (n) => require(path.join(reviewerDir, 'lib', n))
    return { schedule: lib('schedule'), orders: lib('orders'), runs: lib('runs'), config: lib('config'), deploy: lib('deploy'), digest: lib('digest'), fixer: lib('fixer') }
  } catch { return null }
}

const JOB_IDS = ['dream', 'fix', 'deploy', 'digest']          // jobs this tab installs; the review job (which also answers the dawn briefs) keeps its buttons on the Claude reviews tab

// bots: [{ id, name, dir }]. status(job) -> the Task Scheduler state of one job (injected: it shells out to schtasks)
async function loopState({ lib, loopDir, bots, status, running = {}, codeDir = null, fixMode = null }) {
  if (!lib) return { available: false }
  const jobs = []
  for (const id of JOB_IDS) { const j = lib.schedule.JOBS[id]; jobs.push({ id, title: j.title, about: j.about, taskName: j.name, minutes: j.minutes, maxMinutes: j.maxMinutes, running: !!running[id], task: await status(j) }) }
  const review = lib.schedule.JOBS.review
  const mem = (b, ...p) => path.join(b.dir, 'brain', 'state', 'memory', ...p)
  return {
    available: true, loopDir, jobs,
    // the fixer: its mode, its own working copy, whether the GitHub CLI was usable on its last run, and where each open order stands with it
    fix: lib.fixer ? lib.fixer.fixState({ loopDir, fixMode: fixMode || undefined }) : null,
    code: { dir: codeDir, isClone: !!codeDir && fs.existsSync(path.join(codeDir, '.git')), hasDeployer: !!codeDir && fs.existsSync(path.join(codeDir, 'tools', 'deployer.js')), last: codeDir ? lib.deploy.deployLog(codeDir, 4) : [] },
    digest: lib.digest.latest(loopDir),
    reviewTask: { title: review.title, taskName: review.name, task: await status(review) },
    orders: lib.orders.list(loopDir).slice(0, 40).map(o => ({ key: o.key, title: o.title, status: o.status, kind: o.kind, costMin: o.costMin, problem: o.problem, suggestion: o.suggestion, openedAt: o.openedAt, updatedAt: o.updatedAt, seenDreams: o.seenDreams, reopens: o.reopens, pr: o.pr, closed: o.closed, findings: o.findings, bots: Object.fromEntries(Object.entries(o.bots || {}).map(([k, v]) => [k, { costMin: v.costMin, line: v.line, evidence: v.evidence }])) })),
    runs: lib.runs.read({ loopDir }, { limit: 40 }),
    bots: bots.map(b => {
      const brief = readJson(mem(b, 'brief.json')), last = readJson(mem(b, 'dream', 'last.json'))
      return {
        id: b.id, name: b.name, memory: readText(mem(b, 'global.md')),
        brief: brief ? { at: brief.at, day: brief.day, intent: brief.intent, focus: brief.focus, holds: brief.holds, freeTime: brief.freeTime, ask: brief.ask } : null,
        lastCheck: last ? { at: last.at, changes: (last.memory && last.memory.changes) || [], calls: last.calls, skippedSteps: last.skippedSteps, costUsd: last.costUsd, dropped: last.dropped } : null,
      }
    }),
  }
}

module.exports = { loopState, loadLib, JOB_IDS }
