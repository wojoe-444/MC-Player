// App settings, stored as JSON in the Electron userData folder (never in the repo).
// Pure Node: no electron import, so it can be unit tested.
const fs = require('fs')
const os = require('os')
const path = require('path')

function defaults(home = os.homedir()) {
  const dl = path.join(home, 'Downloads')
  return {
    dashboard: {
      port: 8765,
      // The live bots still run from these folders (see CLAUDE.md / repo README).
      ozoDir: path.join(dl, 'Minecraft-Survival'),
      smeoDir: path.join(dl, 'Minecraft-Smeo'),
      codeDir: path.join(dl, 'Minecraft-Survival'),
    },
    claude: {
      command: 'claude',           // headless runs use the Claude Code CLI, i.e. the user's subscription, not API billing
      model: 'haiku',
      timeoutMs: 3 * 60 * 1000,
    },
    triggers: {
      review: { enabled: true, intervalMin: 5 },
    },
  }
}

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base
  const out = { ...base }
  for (const k of Object.keys(over)) {
    out[k] = base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) ? merge(base[k], over[k]) : over[k]
  }
  return out
}

class Config {
  constructor(file, home) {
    this.file = file
    this.data = defaults(home)
    this.load()
  }
  load() {
    try { this.data = merge(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8'))) } catch {}
    return this.data
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2))
  }
  // Update a dotted path, e.g. set('triggers.review.intervalMin', 10)
  set(dotted, value) {
    const keys = dotted.split('.')
    let o = this.data
    for (const k of keys.slice(0, -1)) o = o[k] = (o[k] && typeof o[k] === 'object') ? o[k] : {}
    o[keys[keys.length - 1]] = value
    this.save()
  }
}

module.exports = { Config, defaults, merge }
