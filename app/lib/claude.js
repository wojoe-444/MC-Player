// Headless Claude Code runner: `claude -p --model haiku`, prompt on stdin. Uses the CLI's own login (the user's
// subscription), so no API key is handled here. The model is told which tools it may use; anything else is denied.
const { spawn } = require('child_process')

// opts: { command, model, prompt, cwd, addDirs, allowedTools, timeoutMs, spawnFn }
// Resolves to { ok, text, error, durationMs, costUsd }. Never rejects.
function runClaude(opts) {
  const {
    command = 'claude', model = 'haiku', prompt, cwd, addDirs = [], timeoutMs = 180000,
    allowedTools = ['Read', 'Glob', 'Grep'], spawnFn = spawn,
  } = opts
  const args = ['-p', '--model', model, '--output-format', 'json', '--no-session-persistence']
  if (allowedTools.length) args.push('--allowedTools', allowedTools.join(','))
  if (addDirs.length) args.push('--add-dir', ...addDirs)
  const started = Date.now()
  return new Promise((resolve) => {
    let out = '', err = '', done = false, child
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve({ durationMs: Date.now() - started, ...r }) }
    try {
      // On Windows `claude` is a .cmd shim, which needs a shell. The args here are fixed flags, not user text.
      child = spawnFn(command, args, { cwd, shell: process.platform === 'win32', windowsHide: true })
    } catch (e) { return resolve({ ok: false, error: String(e.message || e), durationMs: 0 }) }
    const timer = setTimeout(() => { try { child.kill() } catch {}; finish({ ok: false, error: `timed out after ${Math.round(timeoutMs / 1000)}s` }) }, timeoutMs)
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.once('error', e => finish({ ok: false, error: e.code === 'ENOENT' ? `\`${command}\` not found: install Claude Code and run \`claude\` once to log in` : String(e.message || e) }))
    child.once('close', (code) => {
      let j = null
      try { j = JSON.parse(out) } catch {}
      if (code === 0 && j && typeof j.result === 'string' && !j.is_error) return finish({ ok: true, text: j.result.trim(), costUsd: j.total_cost_usd })
      finish({ ok: false, error: (j && j.result) || err.trim().slice(0, 500) || `exit code ${code}` })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(prompt)
  })
}

module.exports = { runClaude }
