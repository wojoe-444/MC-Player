// Findings persistence. Per bot (inside the bot folder, where the driver thread and the dashboard already look):
//   brain/state/review/findings.json   latest state: open findings with first/last seen, recently resolved, last run
//   brain/state/review/history.jsonl   one line per run
//   REVIEW-FINDINGS.md                 the same, readable (next to chat.log)
const fs = require('fs')
const path = require('path')

const RANK = { high: 3, med: 2, low: 1 }
const MAX_MISSED = 2          // an open finding the model neither repeats nor resolves for 2 runs is closed as "no longer seen"

const dirOf = (bot) => path.join(bot.dir, 'brain', 'state', 'review')
const fileOf = (bot) => path.join(dirOf(bot), 'findings.json')
function load(bot) { try { return JSON.parse(fs.readFileSync(fileOf(bot), 'utf8')) } catch { return null } }

// deterministic high-severity detector flags the model did not cover still reach the findings
const DETECTOR_KIND = { jumping: 'excessive_jumping', pillar_failing: 'pillar_failing', ladder_bobbing: 'ladder_bobbing', oscillating: 'oscillating', stuck: 'stuck', idle: 'idle', wrong_tool: 'wrong_tool', cannot_harvest: 'wrong_tool', no_tool: 'wrong_tool', staircase: 'staircase', surface_blocks: 'surface_blocks', torch_spacing: 'torch_spacing', repeated_failure: 'repeated_failure', lava_in_hand: 'rule_violation', armor_equipped: 'rule_violation', armor_carried: 'rule_violation', tool_tier: 'rule_violation', chat_spam: 'rule_violation', farmland_trampled: 'code_fault' }

// A flag counts as covered when a model finding carries the same kind, or lists the flag's kind in explainsFlags (one root cause can explain flags of other kinds,
// for example a code fault that shows up as repeated_failure). Without this the file gained an extra HIGH "Detector: ..." entry beside the model's own finding.
function detectorFindings(bot, flags, covered) {
  const out = []
  for (const f of flags || []) {
    if (f.sev !== 'high') continue
    const kind = DETECTOR_KIND[f.kind] || 'other'
    if (covered.some(c => c.kind === kind || (Array.isArray(c.explainsFlags) && c.explainsFlags.includes(f.kind)))) continue
    out.push({ key: `${bot.id}-detector-${f.kind}`, kind, severity: 'high', confidence: 'med', title: `Detector: ${f.kind.replace(/_/g, ' ')}`.slice(0, 80), evidence: f.msg, suggestion: 'Raised by the in-bot detector; the model did not comment on it. Watch the bot and check the flagged window.', source: 'detector' })
  }
  return out
}

// Why a finding closed (docs/MEMORY-LOOP.md, phase 2: a finding closes with a reason, it does not just go quiet). Pure.
//   fixed               its work order was fixed by a named PR
//   quiet-after-deploy  it stopped after the bot moved to new code: the likeliest cause, named so a person can check it (a correlation, not a proof)
//   reviewer            the reviewer closed it: gone, or merged into another finding
//   quiet               it stopped with no code change in between
// ctx: { commits: [{ at, commit, subject }] oldest first (the code the bot ran), orders: [work order] }
const SOON_MS = 15 * 60000        // a deploy this shortly before the last sighting still counts: the review that saw it was reading minutes from before
function closeReason(f, how, ctx = {}) {
  const order = (ctx.orders || []).find(o => o && Array.isArray(o.findings) && o.findings.includes(f.key))
  if (order && order.status === 'fixed' && order.pr) return { why: `fixed by PR #${order.pr} (work order ${order.key})`, reason: { code: 'fixed', pr: order.pr, order: order.key } }
  const last = Date.parse(f.lastSeen) || 0, first = Date.parse(f.firstSeen) || 0
  const c = (ctx.commits || []).filter(c => { const t = Date.parse(c.at); return t > first && t > last - SOON_MS }).pop()
  const sub = c ? String(c.subject || '').replace(/\s+/g, ' ').trim() : ''
  if (c) return { why: `went quiet after the bot moved to ${String(c.commit).slice(0, 9)}${sub ? ` "${sub.length > 90 ? sub.slice(0, 89) + '…' : sub}"` : ''}${how === 'reviewer' ? ' (closed by the reviewer)' : ''}`, reason: { code: 'quiet-after-deploy', commit: c.commit, order: order ? order.key : undefined } }
  if (how === 'reviewer') return { why: 'closed by the reviewer: gone, or merged into another finding', reason: { code: 'reviewer', order: order ? order.key : undefined } }
  return { why: `went quiet: not seen in the last ${MAX_MISSED} reviews, with no code change in between`, reason: { code: 'quiet', order: order ? order.key : undefined } }
}

// merge one run's answer for one bot into the stored state; pure (returns the new state)
function merge(prev, bot, answer, { now, run, evidence, age = true, context = {} }) {
  const at = new Date(now).toISOString()
  const open = new Map(((prev && prev.open) || []).map(f => [f.key, f]))
  const resolved = [...((prev && prev.recentlyResolved) || [])]
  const seen = new Set()
  const incoming = [...(answer.findings || []), ...detectorFindings(bot, evidence && evidence.activeDetectorFlags, answer.findings || [])]
  for (const f of incoming) {
    seen.add(f.key)
    // a key that comes back after being resolved is the same problem returning: keep its history instead of starting at "seen in 1 run"
    let old = open.get(f.key)
    if (!old) { const i = resolved.findIndex(r => r.key === f.key); if (i >= 0) { const r = resolved[i]; resolved.splice(i, 1); old = { firstSeen: r.firstSeen, seenRuns: r.seenRuns || 0 } } }
    const order = (context.orders || []).find(o => o && (o.status === 'open' || o.status === 'parked') && Array.isArray(o.findings) && o.findings.includes(f.key))
    open.set(f.key, { source: 'model', ...f, firstSeen: old ? old.firstSeen : at, lastSeen: at, seenRuns: (old ? old.seenRuns : 0) + 1, missedRuns: 0, ...(order ? { workOrder: order.key } : {}) })
  }
  for (const key of answer.resolved || []) {
    const old = open.get(key)
    if (old && !seen.has(key)) { open.delete(key); resolved.unshift({ ...old, resolvedAt: at, ...closeReason(old, 'reviewer', context) }) }
  }
  for (const [key, f] of [...open]) {
    if (seen.has(key) || !age) continue
    const missed = (f.missedRuns || 0) + 1
    if (missed >= MAX_MISSED) { open.delete(key); resolved.unshift({ ...f, resolvedAt: at, ...closeReason(f, 'quiet', context) }) } else open.set(key, { ...f, missedRuns: missed })
  }
  return {
    bot: bot.name, id: bot.id, updatedAt: at, status: open.size ? 'issues' : 'ok', summary: answer.summary || '',
    open: [...open.values()].sort((a, b) => (RANK[b.severity] - RANK[a.severity]) || (b.lastSeen > a.lastSeen ? 1 : -1)),
    recentlyResolved: resolved.slice(0, 15),
    bag: evidence && evidence.telemetrySummary && evidence.telemetrySummary.now ? evidence.telemetrySummary.now.bag : undefined,
    detectorEvents: prev && prev.detectorEvents,
    lastRun: run,
  }
}

function offlineState(prev, bot, { now, run, reason }) {
  const at = new Date(now).toISOString()
  return { ...(prev || { open: [], recentlyResolved: [] }), bot: bot.name, id: bot.id, updatedAt: at, status: 'offline', summary: reason, lastRun: run }
}

function toMarkdown(s, { model } = {}) {
  const L = [`# Review findings: ${s.bot}`, '', `_Updated ${s.updatedAt}${model ? ` by ${model}` : ''}. Status: **${s.status}**. ${s.summary || ''}_`, '',
    'Written by the spectator reviewer (reviewer/). Read by the driver thread and shown in the Bot Dashboard app. Never posted to game chat.', '']
  if (!s.open.length) L.push(s.status === 'offline' ? '_Bot looks offline; nothing reviewed._' : '_No open findings._', '')
  for (const f of s.open) {
    L.push(`## [${f.severity.toUpperCase()}] ${f.title}`, `\`${f.key}\` · ${f.kind} · confidence ${f.confidence} · first seen ${f.firstSeen} · seen in ${f.seenRuns} run(s)${f.source === 'detector' ? ' · detector only' : ''}${f.workOrder ? ` · work order \`${f.workOrder}\`` : ''}`, '',
      `**Evidence:** ${f.evidence}`, '', `**Suggestion:** ${f.suggestion}`, '')
  }
  if ((s.detectorEvents || []).length) {
    L.push('## Detectors the reviewer wrote', '', 'Small non-blocking checks the reviewer turns judgement into. Enabled only after replaying them on captured telemetry (fires on the bad window, quiet on normal play). Source and origin: brain/state/detectors/.', '')
    for (const e of s.detectorEvents.slice().reverse()) L.push(e.action === 'enabled'
      ? `- ENABLED \`custom_${e.name}\` (${e.at}): ${e.title || ''}. ${e.why || ''} Fired on ${e.validated.firedOnBad.length}/${e.validated.badWindows.length} bad windows, ${e.validated.firedOnNormal.length}/${e.validated.normalWindows} normal.`
      : `- rejected \`${e.name}\` (${e.at}): ${e.reason}`)
    L.push('')
  }
  if (s.recentlyResolved.length) {
    L.push('## Recently resolved', '')
    for (const f of s.recentlyResolved.slice(0, 8)) L.push(`- ${f.title} (\`${f.key}\`) resolved ${f.resolvedAt}: ${f.why}`)
    L.push('')
  }
  return L.join('\n')
}

function save(bot, state, { model } = {}) {
  fs.mkdirSync(dirOf(bot), { recursive: true })
  const tmp = fileOf(bot) + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1)); fs.renameSync(tmp, fileOf(bot))
  fs.appendFileSync(path.join(dirOf(bot), 'history.jsonl'), JSON.stringify({ at: state.updatedAt, status: state.status, summary: state.summary, open: state.open.map(f => `${f.severity}:${f.key}`), run: state.lastRun }) + '\n')
  try { fs.writeFileSync(path.join(bot.dir, 'REVIEW-FINDINGS.md'), toMarkdown(state, { model })) } catch {}
  trimHistory(bot)
}
function trimHistory(bot) {
  const f = path.join(dirOf(bot), 'history.jsonl')
  try { if (fs.statSync(f).size > 512 * 1024) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(-400).join('\n') + '\n') } catch {}
}

module.exports = { load, save, merge, offlineState, toMarkdown, detectorFindings, closeReason, fileOf, dirOf, MAX_MISSED }
