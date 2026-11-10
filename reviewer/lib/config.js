// Where the bots live and how the reviewer talks to Claude. Plain Node, no SDK import.
const fs = require('fs')
const os = require('os')
const path = require('path')

const BOT_DEFS = [
  { id: 'ozo', name: 'OzoGo444', folder: 'Minecraft-Survival', env: 'BOT_OZO_DIR', cfgKey: 'ozoDir' },
  { id: 'smeo', name: 'Smeo444', folder: 'Minecraft-Smeo', env: 'BOT_SMEO_DIR', cfgKey: 'smeoDir' },
]

// the Bot Dashboard app keeps its settings in %APPDATA%/<productName>/config.json (packaged) or mc-player-app (from source)
function appConfigCandidates(env = process.env, home = os.homedir()) {
  const roots = [env.APPDATA, path.join(home, 'AppData', 'Roaming'), path.join(home, 'Library', 'Application Support'), path.join(home, '.config')].filter(Boolean)
  const out = []
  for (const r of roots) for (const n of ['Bot Dashboard', 'mc-player-app']) out.push(path.join(r, n, 'config.json'))
  return out
}
function readAppConfig(env, home, exists = fs.existsSync) {
  for (const f of appConfigCandidates(env, home)) {
    if (!exists(f)) continue
    try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch {}
  }
  return null
}

function parseArgs(argv) {
  const a = { flags: new Set(), opts: {} }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (!t.startsWith('--')) continue
    const k = t.slice(2)
    if (['ozo', 'smeo', 'out', 'model', 'effort', 'minutes', 'claude-path'].includes(k)) a.opts[k] = argv[++i]
    else a.flags.add(k)
  }
  return a
}

function resolveConfig({ argv = [], env = process.env, home = os.homedir(), exists = fs.existsSync } = {}) {
  const args = parseArgs(argv)
  const app = readAppConfig(env, home, exists)
  const bots = BOT_DEFS.map(b => ({
    id: b.id, name: b.name,
    dir: args.opts[b.id] || env[b.env] || (app && app.dashboard && app.dashboard[b.cfgKey]) || path.join(home, 'Downloads', b.folder),
  }))
  return {
    bots, args,
    outDir: args.opts.out || env.REVIEWER_DIR || path.join(home, '.mc-player', 'reviewer'),
    model: args.opts.model || env.REVIEWER_MODEL || 'claude-haiku-5-5',
    effort: args.opts.effort || env.REVIEWER_EFFORT || 'xhigh',
    timeoutMs: Number(env.REVIEWER_TIMEOUT_MS) || 8 * 60000,
    staleMin: Number(env.REVIEWER_STALE_MIN) || 5,
    claudePath: args.opts['claude-path'] || env.REVIEWER_CLAUDE_PATH || undefined,
    minutes: Math.max(1, Math.round(Number(args.opts.minutes) || 10)),
  }
}

module.exports = { resolveConfig, parseArgs, BOT_DEFS, appConfigCandidates }
