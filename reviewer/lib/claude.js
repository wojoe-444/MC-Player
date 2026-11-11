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

// One agent session with tools (the fixer). Unlike askClaude this one can read and change files, so every tool call goes through `gate` first:
//   - built-in tools are limited to opts.builtins (file tools only: no shell, no web, no sub-agents)
//   - a PreToolUse hook asks gate(toolName, input) -> { allow, why } before every call, and canUseTool refuses whatever the hook did not see
//   - opts.tools are our own in-process tools ({ name, description, shape: (z) => zod shape, handler: async (args) => text }), served as mcp__<server>__<name>
// No settings files, no session saved, no memory, no API key (the Claude login on this computer pays, as for askClaude).
// -> { ok, data, text, costUsd, durationMs, turns, calls: [{ tool, input, denied? }], error }
async function runAgent(opts) {
  const started = Date.now(), calls = []
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs || 30 * 60000)
  const server = opts.server || 'fixer'
  // how long one of our own tools may take. Said twice (the server's own limit and the environment), because a MCP_TOOL_TIMEOUT of 60 s inherited
  // from the surrounding environment cut every test-suite run off in a trial on 2026-11-11, and the session spent its whole time retrying.
  const toolMs = opts.toolTimeoutMs || 35 * 60000
  const short = (v) => { try { const t = JSON.stringify(v); return t.length > 300 ? t.slice(0, 299) + '…' : t } catch { return '' } }
  const decide = (name, input) => {
    let d; try { d = opts.gate ? opts.gate(name, input || {}) : { allow: false, why: 'no gate' } } catch (e) { d = { allow: false, why: `gate error: ${e.message}` } }
    calls.push({ tool: name, input: short(input), ...(d.allow ? {} : { denied: d.why || 'not allowed' }) })
    if (opts.onCall) { try { opts.onCall(calls[calls.length - 1]) } catch { /* a log line must not stop the session */ } }
    return d
  }
  try {
    const sdk = opts.sdk || await loadSdk()
    const z = opts.zod || (await import('zod')).z
    const mine = (opts.tools || []).map(t => sdk.tool(t.name, t.description, t.shape(z), async (args) => {
      let text; try { text = await t.handler(args) } catch (e) { text = `error: ${e && e.message || e}` }
      return { content: [{ type: 'text', text: String(text == null ? '' : text).slice(0, opts.maxToolText || 24000) }] }
    }))
    const names = mine.map(t => `mcp__${server}__${t.name}`)
    const q = sdk.query({
      prompt: opts.prompt,
      options: {
        model: opts.model, effort: opts.effort, systemPrompt: opts.systemPrompt,
        tools: opts.builtins || [], allowedTools: [], settingSources: [], settings: { autoMemoryEnabled: false }, persistSession: false, maxTurns: opts.maxTurns || 120,
        mcpServers: mine.length ? { [server]: sdk.createSdkMcpServer({ name: server, version: '0.1.0', tools: mine, timeout: toolMs }) } : {}, strictMcpConfig: true,
        hooks: { PreToolUse: [{ hooks: [async (input) => {
          if (input.tool_name === 'StructuredOutput') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }      // the final answer, not a tool with effects
          const d = decide(input.tool_name, input.tool_input)
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.allow ? 'allow' : 'deny', permissionDecisionReason: d.allow ? 'inside the fixer\'s limits' : (d.why || 'not allowed') } }
        }] }] },
        canUseTool: async (name) => ({ behavior: 'deny', message: `${name} is not available in this session` }),      // only reached when the hook did not decide
        outputFormat: { type: 'json_schema', schema: opts.schema },
        cwd: opts.cwd, env: { ...childEnv(opts.env), MCP_TOOL_TIMEOUT: String(toolMs) }, abortController: ac,
        ...(opts.claudePath ? { pathToClaudeCodeExecutable: opts.claudePath } : {}),
      },
    })
    let result = null
    for await (const m of q) if (m.type === 'result') result = m
    const base = { durationMs: Date.now() - started, calls, tools: names }
    if (!result) return { ok: false, error: 'no result message from the SDK', ...base }
    base.costUsd = result.total_cost_usd; base.turns = result.num_turns
    if (result.subtype !== 'success' || result.is_error) return { ok: false, error: hint(`${result.subtype}: ${(result.errors || []).join('; ') || result.result || 'failed'}`.slice(0, 500)), ...base }
    let data = result.structured_output
    if (!data && typeof result.result === 'string') { try { data = JSON.parse(result.result.replace(/^```(?:json)?\s*|\s*```$/g, '')) } catch {} }
    if (!data) return { ok: false, error: 'the answer was not structured JSON', text: String(result.result || '').slice(0, 2000), ...base }
    return { ok: true, data, ...base }
  } catch (e) {
    const msg = ac.signal.aborted ? `timed out after ${Math.round((opts.timeoutMs || 30 * 60000) / 60000)} min` : String(e && e.message || e)
    return { ok: false, error: hint(msg), durationMs: Date.now() - started, calls }
  } finally { clearTimeout(timer) }
}

module.exports = { askClaude, runAgent, childEnv }
