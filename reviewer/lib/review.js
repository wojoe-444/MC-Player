// One review pass over all bots. Dependencies are injected so it is testable without Claude or a bot.
const fs = require('fs')
const path = require('path')
const { collectBot, forModel } = require('./collect')
const { SYSTEM_PROMPT, SCHEMA, BUILTIN_DETECTORS, buildUserPrompt } = require('./prompt')
const findings = require('./findings')
const proposals = require('./proposals')
const orders = require('./orders')

function lockPath(cfg) { return path.join(cfg.outDir, 'reviewer.lock') }
function takeLock(cfg, now) {
  fs.mkdirSync(cfg.outDir, { recursive: true })
  const f = lockPath(cfg)
  try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (now - j.at < 15 * 60000) return false } catch {}
  fs.writeFileSync(f, JSON.stringify({ pid: process.pid, at: now }))
  return true
}
const dropLock = (cfg) => { try { fs.unlinkSync(lockPath(cfg)) } catch {} }

function logLine(cfg, msg, now) {
  try {
    fs.mkdirSync(cfg.outDir, { recursive: true })
    const f = path.join(cfg.outDir, 'reviewer.log')
    fs.appendFileSync(f, `${new Date(now).toISOString()} ${msg}\n`)
    if (fs.statSync(f).size > 256 * 1024) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split('\n').slice(-800).join('\n'))
  } catch {}
}

function readLast(cfg) { try { return JSON.parse(fs.readFileSync(path.join(cfg.outDir, 'last-run.json'), 'utf8')) } catch { return {} } }
function writeLast(cfg, o) { try { fs.mkdirSync(cfg.outDir, { recursive: true }); fs.writeFileSync(path.join(cfg.outDir, 'last-run.json'), JSON.stringify(o, null, 1)) } catch {} }

// deps: { ask(opts) -> {ok,data,costUsd,durationMs,error}, now }
async function runReview(cfg, { ask, now = Date.now(), force = false, dryRun = false } = {}) {
  const t = typeof now === 'function' ? now() : now
  if (!dryRun && !takeLock(cfg, t)) return { ok: true, skipped: 'another review is running' }
  try {
    const last = readLast(cfg)
    const prevState = Object.fromEntries(cfg.bots.map(b => [b.id, findings.load(b)]))
    const ev = Object.fromEntries(cfg.bots.map(b => [b.id, collectBot(b, { now: t, staleMin: cfg.staleMin, since: last.at ? Date.parse(last.at) : 0 })]))
    const active = cfg.bots.filter(b => ev[b.id].active)
    const signature = cfg.bots.map(b => ev[b.id].signature).join('||')

    // what a closing finding is checked against: the code each bot has run, and the work orders (lib/findings.js closeReason)
    let allOrders = []; try { allOrders = cfg.loopDir ? orders.list(cfg.loopDir) : [] } catch { /* no loop folder yet */ }
    const ctxOf = (b) => ({ commits: orders.botCommits(b), orders: allOrders })
    const runBase = (extra) => ({ at: new Date(t).toISOString(), model: cfg.model, effort: cfg.effort, ...extra })
    const saveOffline = () => {
      for (const b of cfg.bots.filter(b => !ev[b.id].active)) {
        const reason = !ev[b.id].exists ? 'Bot folder not found.' : 'No telemetry or log activity in the last ' + cfg.staleMin + ' minutes: the bot looks offline.'
        findings.save(b, findings.offlineState(prevState[b.id], b, { now: t, run: runBase({ skipped: 'offline' }), reason }), { model: cfg.model })
      }
    }

    // detector proposals can only be validated with >= MIN_NORMAL_WINDOWS captured normal windows; without them the 1 Hz window digests (about a third of the prompt) are dead weight and invite proposals that are bound to be rejected
    const canPropose = (b) => proposals.loadWindows(b).filter(w => w.kind === 'normal').length >= proposals.MIN_NORMAL_WINDOWS
    const payload = active.map(b => ({
      bot: b.name, folder: b.dir, telemetry: ev[b.id].telemetry === 'live' ? 'live' : 'missing (no telemetry module in this bot yet: judge from the logs only)',
      ...forModel(ev[b.id]),
      ...(canPropose(b) ? { detectorProposals: 'open', windows: proposals.windowDigests(b) } : { detectorProposals: 'closed: fewer than ' + proposals.MIN_NORMAL_WINDOWS + ' normal windows captured so far, so a new detector cannot be validated; return proposedDetectors []' }),
      existingDetectors: [...BUILTIN_DETECTORS, ...proposals.customList(b)],
      detectorEvents: ((prevState[b.id] && prevState[b.id].detectorEvents) || []).slice(-5).map(e => ({ name: e.name, action: e.action, reason: e.reason })),
      previousReview: prevState[b.id] && prevState[b.id].status !== 'offline' ? { at: prevState[b.id].updatedAt, summary: prevState[b.id].summary, bag: prevState[b.id].bag } : null,
      recentlyResolved: ((prevState[b.id] && prevState[b.id].recentlyResolved) || []).slice(0, 10).map(f => ({ key: f.key, title: f.title, resolvedAt: f.resolvedAt })),
      previousOpenFindings: ((prevState[b.id] && prevState[b.id].open) || []).map(f => ({ key: f.key, kind: f.kind, severity: f.severity, title: f.title, firstSeen: f.firstSeen, seenRuns: f.seenRuns, evidence: String(f.evidence || '').slice(0, 300), suggestion: String(f.suggestion || '').slice(0, 160) })),
    }))
    const prompt = buildUserPrompt({ now: t, bots: payload })
    if (dryRun) return { ok: true, dryRun: true, system: SYSTEM_PROMPT, prompt, active: active.map(b => b.name) }

    if (!active.length) { saveOffline(); writeLast(cfg, { at: new Date(t).toISOString(), signature, skipped: 'all offline' }); logLine(cfg, 'skipped: all bots offline', t); return { ok: true, skipped: 'all bots offline' } }
    if (!force && last.signature === signature && last.ok) {
      logLine(cfg, 'skipped: nothing changed since the last review', t)
      return { ok: true, skipped: 'nothing changed since the last review' }
    }

    const res = await ask({ systemPrompt: SYSTEM_PROMPT, prompt, schema: SCHEMA, model: cfg.model, effort: cfg.effort, cwd: cfg.outDir, timeoutMs: cfg.timeoutMs, claudePath: cfg.claudePath })
    if (!res.ok) {
      logLine(cfg, `FAILED: ${res.error}`, t)
      writeLast(cfg, { ...last, failedAt: new Date(t).toISOString(), error: res.error })
      // detector-only findings still go out, so a Claude outage does not hide a bot that is jumping on the spot
      for (const b of active) {
        const answer = { summary: 'Claude review failed; showing in-bot detector findings only.', findings: [], resolved: [] }
        const st = findings.merge(prevState[b.id], b, answer, { now: t, run: runBase({ error: res.error }), evidence: ev[b.id], age: false, context: ctxOf(b) })
        findings.save(b, st, { model: cfg.model })
      }
      saveOffline()
      return { ok: false, error: res.error }
    }
    const byName = new Map((res.data.bots || []).map(x => [String(x.bot).toLowerCase(), x]))
    for (const b of active) {
      const answer = byName.get(b.name.toLowerCase()) || { summary: 'The model did not answer for this bot.', findings: [], resolved: [] }
      const st = findings.merge(prevState[b.id], b, answer, { now: t, run: runBase({ costUsd: res.costUsd, durationMs: res.durationMs }), evidence: ev[b.id], context: ctxOf(b) })
      // model-written detectors: validated against captured windows, enabled only if they pass; the outcome is shown in the findings
      const evs = proposals.process(b, answer.proposedDetectors, { now: t, model: cfg.model })
      st.detectorEvents = [...((prevState[b.id] && prevState[b.id].detectorEvents) || []), ...evs].slice(-10)
      findings.save(b, st, { model: cfg.model })
    }
    saveOffline()
    writeLast(cfg, { at: new Date(t).toISOString(), signature, ok: true, costUsd: res.costUsd })
    logLine(cfg, `ok ${active.map(b => b.name).join('+')} ${res.durationMs}ms cost=${res.costUsd ?? '?'}`, t)
    return { ok: true, reviewed: active.map(b => b.name), costUsd: res.costUsd, durationMs: res.durationMs }
  } finally { if (!dryRun) dropLock(cfg) }
}

module.exports = { runReview, lockPath, readLast, logLine }
