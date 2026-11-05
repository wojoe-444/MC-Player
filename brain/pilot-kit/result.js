// brain/pilot-kit/result.js: one result format for every pilot command.
//   { ok, cmd, note, data?, error?: { code, message, hint? }, ms, level? }
// Backwards compatible with what skills return today ({ ok, note, ...extra }): extra keys are kept under `data`, `note` stays the human line.
// AbortError is never swallowed, so scheduler aborts still stop the skill.
// closed list; UNKNOWN = a failure whose message we could not classify (so wrapping a legacy return never throws)
const CODES = ['NO_PATH', 'NO_ITEM', 'UNSAFE', 'ABORTED', 'TIMEOUT', 'BAD_ARGS', 'NOT_READY', 'FAILED', 'UNKNOWN']
const RULES = [
  ['ABORTED', /abort|cancel/i],
  ['TIMEOUT', /timeout|timed out|too long/i],
  ['NO_PATH', /no path|nopath|unreachable|cannot reach|can't reach|path.*(blocked|not found)|stuck/i],
  ['NO_ITEM', /not enough|no .* in (the )?(bag|inventory|chest)|don't have|do not have|missing (item|ingredient)|out of/i],
  ['UNSAFE', /lava|unsafe|danger|refus|no-dig|property|not allowed|forbidden|creeper/i],
  ['BAD_ARGS', /bad arg|invalid|unknown (item|block|place|name)|missing arg|required|expected/i],
  ['NOT_READY', /not ready|readiness|gate|night|too dark|low health|hungry/i]
]
const classify = (msg) => { const m = String(msg || ''); for (const [code, re] of RULES) if (re.test(m)) return code; return 'UNKNOWN' }

function normalize(cmd, raw, ms, level) {
  const out = { ok: true, cmd, note: '', ms }
  if (level) out.level = level
  if (raw === undefined || raw === null || raw === true) return out
  if (raw === false) { out.ok = false; out.error = { code: 'FAILED', message: 'returned false' }; return out }
  if (typeof raw === 'string' || typeof raw === 'number') { out.note = String(raw); return out }
  if (typeof raw === 'object') {
    const { ok, note, error, err, why, reason, ...rest } = raw
    out.ok = ok === undefined ? !(error || err) : !!ok
    out.note = note !== undefined ? String(note) : ''
    if (!out.ok) {
      const message = String(error && error.message || error || err || why || reason || note || 'failed')
      out.error = { code: (error && error.code && CODES.includes(error.code)) ? error.code : classify(message), message }
      if (error && error.hint) out.error.hint = error.hint
    }
    if (Object.keys(rest).length) out.data = rest
  }
  return out
}

// wrap(name, fn, { level, hint }): returns an async function that always resolves to an envelope (never throws, except AbortError)
function wrap(name, fn, opts = {}) {
  return async function wrapped(...args) {
    const t0 = Date.now()
    try {
      const raw = await fn.apply(this, args)
      return normalize(name, raw, Date.now() - t0, opts.level)
    } catch (e) {
      if (e && e.name === 'AbortError') throw e
      const message = String(e && e.message || e)
      const env = { ok: false, cmd: name, note: '', ms: Date.now() - t0, error: { code: classify(message), message: message.slice(0, 240) } }
      if (opts.hint) env.error.hint = opts.hint
      if (opts.level) env.level = opts.level
      return env
    }
  }
}

// one line for a model or a log: "craft ok (1.2s): crafted 4 planks" / "goto FAILED NO_PATH (3.0s): ..."
const line = (r) => `${r.cmd} ${r.ok ? 'ok' : 'FAILED ' + (r.error ? r.error.code : '')} (${(r.ms / 1000).toFixed(1)}s)${r.note ? ': ' + r.note : (r.error ? ': ' + r.error.message : '')}`.slice(0, 300)

module.exports = { wrap, normalize, classify, line, CODES }
module.exports.meta = { name: 'result', version: 1 }
