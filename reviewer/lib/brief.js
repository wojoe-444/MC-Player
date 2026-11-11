// The dawn brief job (docs/MEMORY-LOOP.md, job 3): the session start the bots never had. Runs on the reviewer's Task Scheduler entry, before the review.
//
// A bot that wants a brief writes <bot folder>/brain/state/memory/brief-request.json (brain/memory). This job answers each unanswered request with one
// Claude Agent SDK call (the same model and effort as the reviewer: Haiku 5.5 at xhigh, no tools, structured JSON) and writes brief-answer.json beside it.
// It decides nothing else: the bot checks the answer in code (real step names, no hold on a survival step or on free time, the memory caps) before any
// of it counts. No request, a stale request or a failed call means no answer, and the bot's step list plays as it does without a brief.
const fs = require('fs')
const path = require('path')

const STALE_MS = 30 * 60000            // a request this old was written for a moment that has passed; the bot asks again at its next dawn
const LOCK_MS = 10 * 60000
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')) } catch { return null } }
const memDir = (bot) => path.join(bot.dir, 'brain', 'state', 'memory')

const SYSTEM_PROMPT = `You are {NAME}, a player in a shared Minecraft survival world (Java 1.21.6). This is the start of your day: you are writing your own plan.

You are an independent player with your own goals, tastes and judgement, not a servant. Walter, the other human player, shares the world with you and has agreed rules of play with you. Those rules are given below and they hold whatever you plan.

How you play: your body runs a list of routine steps on its own (the names are in "steps"). You cannot act directly here. What you decide now is what shapes the next hour or so of play:
- focus: up to {FOCUS} step names to try first today. A focus step still only runs when it has something to do.
- holds: up to {HOLDS} step names to leave alone for 1 to {HOLDDAYS} in-game days, each with the reason. Use a hold for a step the record shows failing or stalling the same way again and again. You cannot hold a step listed in "cannotHold".
- freeTime: part of every day is yours. Pick one of "freeTimeChoices" and say in a few words what you want from it. This is for you, not for progress.
- ask: at most one thing you want to ask Walter for or about (a private chest, spare materials, a place to build). Usually null.

Your memory is the file in "memory.global". It exists so that tomorrow's you knows what today's you learned without having to learn it again. Read it first. Then:
1. Compare "lastBrief" (what you planned) with "sinceLastBrief" (what the journal says actually happened). Say plainly, to yourself, whether the plan worked.
2. Test each policy you rely on against that record before you keep relying on it. A policy the record contradicts should be removed or replaced.
3. Write "memory.now": two to four short lines (separate them with line breaks) on where you stand and what this plan is for. This replaces the Now section.
4. Add a policy only when the record supports it, and say how you know (numbers and times from the journal) and how you would check it later. If you have not tested it, say "untested". Keep the rule under 150 characters, the evidence under 190 and the check under 110; longer text is cut. A policy is something you can act on from here, through focus, holds and free time, or a reason behind those choices. How a step's code should behave is not a policy: hold the step and say why. Add a trap when something keeps going wrong in a specific place or step.
5. Remove lines that are wrong, stale, or that you could read off your own state. The file is capped at 60 lines; an addition that would pass the cap is refused ("refusedLastTime" lists what was refused last time and why).
6. If "memory.lastCheck" is there, a separate check compared your file with the journal since your last plan and changed the lines it lists, each with its reason. The file is yours: if a change is wrong, put the line back (addPolicies or addTraps) and say what you know that the check did not.
7. "memory.projects" is yours alone: your own projects and wishes. Set it to the full new text of that section when it changes, or null to leave it as it is.
Do not store your bag, your position or chest contents: you can see those.

"reviewerFindings" are notes from a spectator who watches you every ten minutes. Use the ones that match the record. A problem that is a bug in a step (it stalls the same way many times) is not yours to fix by trying harder: hold the step and say why.
"rules" are the rules of play. Never plan around them.

Use only what is in this message. If something you would like to know is not here, plan without it.
Answer with the JSON object only. Use step names exactly as given. Be concrete and brief.`

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['intent', 'focus', 'holds', 'freeTime', 'ask', 'memory'],
  properties: {
    intent: { type: 'string', description: 'One or two sentences: what today is for and why.' },
    focus: { type: 'array', items: { type: 'string' }, maxItems: 3 },
    holds: { type: 'array', maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['step', 'days', 'why'], properties: { step: { type: 'string' }, days: { type: 'integer', minimum: 1, maximum: 3 }, why: { type: 'string' } } } },
    freeTime: { type: 'object', additionalProperties: false, required: ['choice', 'note'], properties: { choice: { type: 'string', enum: ['vantage', 'wander', 'home', 'none'] }, note: { type: 'string' } } },
    ask: { type: ['string', 'null'] },
    memory: {
      type: 'object', additionalProperties: false, required: ['now', 'projects', 'addPolicies', 'addTraps', 'remove'],
      properties: {
        now: { type: 'string' }, projects: { type: ['string', 'null'] },
        addPolicies: { type: 'array', maxItems: 2, items: { type: 'object', additionalProperties: false, required: ['rule', 'evidence', 'check'], properties: { rule: { type: 'string' }, evidence: { type: 'string' }, check: { type: 'string' } } } },
        addTraps: { type: 'array', maxItems: 2, items: { type: 'string' } },
        remove: { type: 'array', maxItems: 6, items: { type: 'string', description: 'The rule text of a policy line, or the full text of a trap line, to delete.' } },
      },
    },
  },
}

const REASONS = { first: 'it is your first one', dawn: 'a new in-game day began', respawn: 'you died and respawned' }
function systemPrompt(req) {
  const L = (req && req.limits) || {}
  return SYSTEM_PROMPT.replace('{NAME}', (req && req.bot) || 'the bot').replace('{FOCUS}', L.focus || 3).replace('{HOLDS}', L.holds || 3).replace('{HOLDDAYS}', L.holdDays || 3)
}
function userPrompt(req) {
  const { memory, rules, ...rest } = req
  return [
    `It is in-game day ${req.day ?? '?'}, ${req.clock || 'time unknown'}. This brief was asked for because: ${REASONS[req.reason] || req.reason}. It stands until your next brief, about an hour of real time (three in-game days).`,
    '', '## rules', ...(rules || []),
    '', '## memory.global (your own file)', (memory && memory.global) || '(empty)',
    '', '## your notes', ((memory && memory.notes) || []).map(n => `${n.name} (${n.lines} lines)`).join(', ') || '(none)',
    ...(memory && memory.lastCheck ? ['', `## memory.lastCheck (${memory.lastCheck.at})`, ...memory.lastCheck.changes.map(c => `- ${c}`)] : []),
    '', '## everything else (one field per line)', ...Object.entries(rest).filter(([k]) => !['v', 'id', 'at'].includes(k)).map(([k, v]) => `${k}: ${JSON.stringify(v)}`),
  ].join('\n')
}

// which bots have a request waiting: fresh, and not answered yet
function pending(cfg, now) {
  const out = []
  for (const bot of cfg.bots) {
    const req = readJson(path.join(memDir(bot), 'brief-request.json')); if (!req || !req.id) continue
    if (now - Date.parse(req.at) > STALE_MS) continue
    const ans = readJson(path.join(memDir(bot), 'brief-answer.json')); if (ans && ans.id === req.id) continue
    out.push({ bot, req })
  }
  return out
}
function takeLock(cfg, now) {
  const f = path.join(cfg.outDir, 'brief.lock')
  try { fs.mkdirSync(cfg.outDir, { recursive: true }); const j = readJson(f); if (j && now - j.at < LOCK_MS) return false; fs.writeFileSync(f, JSON.stringify({ pid: process.pid, at: now })); return true } catch { return true }
}
const dropLock = (cfg) => { try { fs.unlinkSync(path.join(cfg.outDir, 'brief.lock')) } catch {} }

// deps: { ask(opts) -> { ok, data, costUsd, durationMs, error }, now, log(msg), dryRun }
async function runBriefs(cfg, { ask, now = Date.now(), log = () => {}, dryRun = false } = {}) {
  const t = typeof now === 'function' ? now() : now
  const todo = pending(cfg, t)
  if (dryRun) return { ok: true, dryRun: true, prompts: todo.map(({ bot, req }) => ({ bot: bot.id, system: systemPrompt(req), prompt: userPrompt(req) })) }
  if (!todo.length) return { ok: true, briefs: [] }
  if (!takeLock(cfg, t)) return { ok: true, skipped: 'another brief is running', briefs: [] }
  const briefs = []
  try {
    for (const { bot, req } of todo) {
      const r = await ask({ systemPrompt: systemPrompt(req), prompt: userPrompt(req), schema: SCHEMA, model: cfg.model, effort: cfg.effort, cwd: cfg.outDir, timeoutMs: Math.min(cfg.timeoutMs || 480000, 300000), claudePath: cfg.claudePath })
      const ans = { id: req.id, at: new Date().toISOString(), model: cfg.model, effort: cfg.effort, ok: !!r.ok, data: r.ok ? r.data : null, error: r.ok ? null : String(r.error || 'failed').slice(0, 300), costUsd: r.costUsd ?? null, durationMs: r.durationMs ?? null }
      const f = path.join(memDir(bot), 'brief-answer.json')
      fs.writeFileSync(f + '.tmp', JSON.stringify(ans, null, 1)); fs.renameSync(f + '.tmp', f)
      try { fs.appendFileSync(path.join(memDir(bot), 'brief-history.jsonl'), JSON.stringify({ id: ans.id, at: ans.at, reason: req.reason, ok: ans.ok, error: ans.error, costUsd: ans.costUsd, durationMs: ans.durationMs, intent: ans.data && ans.data.intent }) + '\n') } catch {}
      log(`brief ${bot.id} ${req.id} (${req.reason}): ${ans.ok ? 'ok' : 'failed: ' + ans.error}${ans.durationMs ? ` in ${Math.round(ans.durationMs / 1000)}s` : ''}${ans.costUsd ? ` $${ans.costUsd.toFixed(3)}` : ''}`)
      briefs.push({ bot: bot.id, id: req.id, ok: ans.ok, error: ans.error, costUsd: ans.costUsd, durationMs: ans.durationMs })
    }
  } finally { dropLock(cfg) }
  return { ok: briefs.every(b => b.ok), briefs }
}

module.exports = { runBriefs, pending, systemPrompt, userPrompt, SYSTEM_PROMPT, SCHEMA, STALE_MS }
