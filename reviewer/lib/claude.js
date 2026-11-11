// One Claude Agent SDK call: Haiku, high reasoning effort, our own system prompt, no tools, structured JSON answer.
// Auth is the Claude Code login on this computer (Walter's subscription). ANTHROPIC_API_KEY is removed from the child's environment so the
// SDK cannot fall back to metered API billing; the OpenRouter credit is gone and is not used here.
const hint = (msg) => /login|auth|credential|401|api key/i.test(msg) ? `${msg} (run \`claude\` once in a terminal to log in)` : msg
async function loadSdk() { return import('@anthropic-ai/claude-agent-sdk') }

function childEnv(env = process.env) {
  const e = { ...env }
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) delete e[k]
  // no ambient memory either: these jobs must judge from the evidence in their prompt alone. A trial brief on 2026-11-11 quoted a rule that was only in
  // the surrounding Claude session's memory, never in its prompt. (autoMemoryEnabled: false in the call's settings covers Claude Code's own memory folder.)
  for (const k of Object.keys(e)) if (/^CLAUDE_(COWORK_)?MEMORY/.test(k)) delete e[k]
  e.CLAUDE_AGENT_SDK_CLIENT_APP = 'mc-player-reviewer/0.1.0'
  return e
}

// opts: { systemPrompt, prompt, schema, model, effort, cwd, timeoutMs, claudePath, sdk? }  -> { ok, data, costUsd, durationMs, error }
async function askClaude(opts) {
  const started = Date.now()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs || 480000)
  try {
    const sdk = opts.sdk || await loadSdk()
    const q = sdk.query({
      prompt: opts.prompt,
      options: {
        model: opts.model, effort: opts.effort, systemPrompt: opts.systemPrompt,
        tools: [], allowedTools: [], settingSources: [], settings: { autoMemoryEnabled: false }, persistSession: false, maxTurns: 4,
        outputFormat: { type: 'json_schema', schema: opts.schema },
        cwd: opts.cwd, env: childEnv(opts.env), abortController: ac,
        ...(opts.claudePath ? { pathToClaudeCodeExecutable: opts.claudePath } : {}),
      },
    })
    let result = null
    for await (const m of q) if (m.type === 'result') result = m
    if (!result) return { ok: false, error: 'no result message from the SDK', durationMs: Date.now() - started }
    if (result.subtype !== 'success' || result.is_error) return { ok: false, error: hint(`${result.subtype}: ${(result.errors || []).join('; ') || result.result || 'failed'}`.slice(0, 500)), durationMs: Date.now() - started }
    let data = result.structured_output
    if (!data && typeof result.result === 'string') { try { data = JSON.parse(result.result.replace(/^```(?:json)?\s*|\s*```$/g, '')) } catch {} }
    if (!data) return { ok: false, error: 'the answer was not structured JSON', durationMs: Date.now() - started }
    return { ok: true, data, costUsd: result.total_cost_usd, durationMs: Date.now() - started }
  } catch (e) {
    const msg = ac.signal.aborted ? `timed out after ${Math.round((opts.timeoutMs || 480000) / 1000)}s` : String(e && e.message || e)
    return { ok: false, error: hint(msg), durationMs: Date.now() - started }
  } finally { clearTimeout(timer) }
}

module.exports = { askClaude, childEnv }
