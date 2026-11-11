// Bot Dashboard: read-only live view of OzoGo444 and Smeo444. Zero dependencies.
// Run: node server.js   ->  http://localhost:8765
const http = require('http');
const fs = require('fs');
const path = require('path');

const WEB = fs.existsSync(path.join(__dirname, 'web', 'dist')) ? path.join(__dirname, 'web', 'dist') : path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 8765);
const ROOT = path.join(__dirname, '..');
// Paths are overridable so the dashboard can watch bots running anywhere (default: runtime/<bot> inside this repo).
const DIR_OZO = process.env.BOT_OZO_DIR || path.join(ROOT, 'runtime', 'ozo');
const DIR_SMEO = process.env.BOT_SMEO_DIR || path.join(ROOT, 'runtime', 'smeo');
const BOTS = {
  ozo:  { id: 'ozo',  name: 'OzoGo444', dir: DIR_OZO, viewer: 3007 },
  smeo: { id: 'smeo', name: 'Smeo444',  dir: DIR_SMEO, viewer: 3008 },
};
// The shared registry (shafts, rooms) both bots write: Downloads/bot-shared/registry.json, a sibling of the bot folders; BOT_REGISTRY overrides.
const REGISTRY = process.env.BOT_REGISTRY || [path.join(DIR_OZO, '..', 'bot-shared', 'registry.json'), path.join(ROOT, '..', 'bot-shared', 'registry.json')].find(f => fs.existsSync(f)) || path.join(DIR_OZO, '..', 'bot-shared', 'registry.json');
const VIEWS = (b) => path.join(b.dir, 'brain', 'state', 'views');
const RING = 2000;

// ---------- log tailing (read-only, offset based) ----------
const state = {};
for (const b of Object.values(BOTS)) {
  state[b.id] = {
    logs: [], seq: 0,
    files: { idle: { file: path.join(b.dir, 'idle.log'), off: -1, partial: '' },
             join: { file: path.join(b.dir, 'join.log'), off: -1, partial: '' } },
    status: null, statusJson: '',
  };
}
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) { try { c.write(msg); } catch {} }
}

function parseIdle(line) {
  const m = line.match(/^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+(.*)$/);
  if (!m) return null;
  const toks = m[2].split(/\s+/);
  let kind = toks[0] === 'autopilot' ? (toks[1] || 'autopilot') : toks[0];
  kind = kind.replace(/[:,]$/, '');
  return { t: m[1], kind, tag: toks[0], text: m[2].slice(0, 400) };
}
function parseJoin(line) {
  if (line.startsWith('Chunk size') || line.includes('partial packet')) return null;
  if (line.startsWith('MSG ')) {
    const text = line.slice(4, 400);
    let kind = 'chat';
    if (/\b(died|was slain|was shot|drowned|burned|fell|blew up|hit the ground)\b/i.test(text)) kind = 'DIED';
    else if (!/^<[^>]+>/.test(text)) kind = 'server';
    return { t: new Date().toISOString(), kind, text };
  }
  if (/^(KICKED|END|ERR|ERROR|SPAWN|spawn|LOGIN|JOINED|RECONNECT)/.test(line)) {
    return { t: new Date().toISOString(), kind: 'conn', text: line.slice(0, 300) };
  }
  return null;
}
function pushLog(bot, entry) {
  const s = state[bot];
  entry.id = ++s.seq; entry.bot = bot;
  s.logs.push(entry);
  if (s.logs.length > RING) s.logs.splice(0, s.logs.length - RING);
  return entry;
}
function pollFile(bot, key, parse, live) {
  const f = state[bot].files[key];
  let st; try { st = fs.statSync(f.file); } catch { return; }
  const BACK = key === 'join' ? 4 * 1024 * 1024 : 600 * 1024;
  const first = f.off < 0;
  if (first) { f.off = Math.max(0, st.size - BACK); f.skipFirst = f.off > 0; }
  if (st.size < f.off) { f.off = 0; f.partial = ''; } // truncated / rotated
  if (st.size === f.off) return;
  const MAXREAD = 8 * 1024 * 1024;
  let start = f.off;
  if (st.size - start > MAXREAD) { start = st.size - MAXREAD; f.partial = ''; f.skipFirst = true; }
  const len = st.size - start;
  const buf = Buffer.alloc(len);
  let fd;
  try { fd = fs.openSync(f.file, 'r'); fs.readSync(fd, buf, 0, len, start); }
  catch { return; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  f.off = st.size;
  const lines = (f.partial + buf.toString('utf8')).split(/\r?\n/);
  f.partial = lines.pop();
  if (f.skipFirst) { lines.shift(); f.skipFirst = false; }
  const fresh = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const e = parse(line); if (!e) continue;
    // join.log has no timestamps; backlog read at startup is not "now"
    if (key === 'join' && first) e.t = null;
    fresh.push(pushLog(bot, e));
  }
  if (fresh.length && live) broadcast('log', fresh.slice(-200));
}

function readStatus(bot) {
  const b = BOTS[bot], s = state[bot];
  const p = path.join(VIEWS(b), 'latest.json');
  try {
    const st = fs.statSync(p);
    const raw = fs.readFileSync(p, 'utf8');
    if (raw === s.statusJson) return;
    s.statusJson = raw; s.status = JSON.parse(raw);
    const imgs = {};
    for (const k of ['top', 'pov', 'slice']) { try { imgs[k] = fs.statSync(path.join(VIEWS(b), k + '-latest.png')).mtimeMs; } catch {} }
    s.status._img = imgs; s.status._mtime = st.mtimeMs;
  } catch {}
}
function currentGoal(bot) {
  const logs = state[bot].logs;
  let goal = null, plan = null;
  for (let i = logs.length - 1; i >= 0 && (!goal || !plan); i--) {
    const e = logs[i];
    if (!goal && e.kind === 'GOAL') goal = e.text.replace(/^autopilot GOAL\s*/, '');
    if (!plan && e.kind === 'PLAN') plan = e.text.replace(/^autopilot PLAN\s*/, '');
  }
  return { goal, plan };
}
function snapshot() {
  const out = {};
  for (const id of Object.keys(BOTS)) {
    out[id] = { id, name: BOTS[id].name, viewerPort: BOTS[id].viewer, status: state[id].status, ...currentGoal(id) };
  }
  return out;
}
let lastSnap = '';
function tick() {
  for (const id of Object.keys(BOTS)) {
    pollFile(id, 'idle', parseIdle, true);
    pollFile(id, 'join', parseJoin, true);
    readStatus(id);
  }
  const snap = JSON.stringify(snapshot());
  if (snap !== lastSnap) { lastSnap = snap; broadcast('status', JSON.parse(snap)); }
}
for (const id of Object.keys(BOTS)) { pollFile(id, 'idle', parseIdle, false); pollFile(id, 'join', parseJoin, false); readStatus(id); }
setInterval(tick, 1000);
setInterval(() => broadcast('ping', Date.now()), 15000);

// ---------- structure: modes, modules, skills, per-save data (all read-only) ----------
const CODE = process.env.BOT_CODE_DIR || ROOT; // one shared brain codebase; Smeo runs it too with its own state dir
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const stateDirOf = (b) => path.join(b.dir, 'brain', 'state');
const ROOT_DATA = ['waypoints.json', 'stations.json', 'chest-index.json', 'base-notes.md', 'sleep-state.json', 'bots-sleep.json', 'player-pos.json',
  'chat-context.jsonl', 'chat.log', 'narration.log', 'outbox.txt', 'cmd.txt', 'lan-port.txt', 'unhandled.log', 'los.log', 'SURVIVAL-RESULTS.md'];
const HIDE = /\.(png|jpg|key)$|^views$|^reload|^ap-cmd/;

let staticCache = null;
function staticInfo() {
  if (staticCache) return staticCache;
  const idx = readText(path.join(CODE, 'brain', 'index.js')) || '';
  const mm = idx.match(/const MODULES = \[([^\]]*)\]/);
  const names = mm ? [...mm[1].matchAll(/'([^']+)'/g)].map(x => x[1]) : [];
  const modules = names.map(name => {
    const dir = path.join(CODE, 'brain', name);
    const head = (readText(path.join(dir, 'index.js')) || '').split(/\r?\n/).slice(0, 8);
    let desc = '';
    for (const l of head) { const c = l.match(/^\/\/\s?(.*)$/); if (c) { desc = c[1].replace(/^brain\/[\w-]+:?\s*/, '').trim(); if (desc.length > 8) break; } }
    let files = []; try { files = fs.readdirSync(dir); } catch {}
    // meta.json (kind, requires, provides, claims): the module's place in the shared vocabulary, see brain/INTERFACE.md section 0
    const meta = readJson(path.join(dir, 'meta.json')) || {};
    return { name, desc: (meta.summary || desc).slice(0, 260), files: files.length, readme: files.includes('README.md'),
      kind: meta.kind || null, requires: meta.requires || [], provides: meta.provides || [], claims: meta.claims || [] };
  });
  const sk = readText(path.join(CODE, 'brain', 'autopilot', 'skills.js')) || '';
  const skills = [...new Set([...sk.matchAll(/^\s*S\.([a-zA-Z]+)\s*=\s*(?:async\s*)?(?:function|\()/gm)].map(x => x[1]))];
  // vocabulary, ladder catalog and priority bands come from the brain code itself (older code folders without them just omit the sections)
  let taxonomy = readJson(path.join(CODE, 'brain', 'taxonomy.json')), ladder = null, bands = null;
  try { ladder = require(path.join(CODE, 'brain', 'ladder.js')).catalog(path.join(CODE, 'brain')); } catch {}
  try { const sc = require(path.join(CODE, 'brain', 'scheduler.js')); bands = { bands: sc.BANDS || null, priority: sc.PRIORITY || null }; } catch {}
  staticCache = { modules, skills, taxonomy, ladder, bands };
  return staticCache;
}

function taskStates(bot) {
  const tasks = new Map();
  for (const e of state[bot].logs) {
    if (e.tag !== 'SCHED') continue;
    const m = e.text.match(/^SCHED (\w+) ([\w:-]+)/); if (!m) continue;
    const [, ev, name] = m;
    if (ev === 'queued') { if (!tasks.has(name)) tasks.set(name, { status: 'queued', t: e.t }); }
    else if (ev === 'start' || ev === 'resume') tasks.set(name, { status: 'running', t: e.t });
    else if (ev === 'paused') tasks.set(name, { status: 'paused', t: e.t });
    else if (ev === 'done' || ev === 'cancelled') tasks.delete(name);
  }
  return [...tasks].map(([name, v]) => ({ name, ...v }));
}

function lastSeenByTag(bot) {
  const seen = {};
  for (const e of state[bot].logs) {
    if (!e.tag || !e.t) continue;
    const tg = e.tag.replace(/[:,]$/, ''); const key = /^[a-z]/.test(tg) ? tg : null;
    if (key) { const s = seen[key] || (seen[key] = { n: 0, t: null }); s.n++; s.t = e.t; }
  }
  return seen;
}

const fileSummaryCache = new Map();
function summarize(p, name, size) {
  const ext = path.extname(name);
  if (ext === '.json') {
    if (size > 3e6) return 'large json';
    const j = readJson(p);
    if (j === null) return 'unparseable json';
    if (Array.isArray(j)) return `list of ${j.length}`;
    if (j && typeof j === 'object') { const k = Object.keys(j); return `${k.length} keys: ` + k.slice(0, 6).join(', ') + (k.length > 6 ? ', ...' : ''); }
    return String(j).slice(0, 80);
  }
  if (ext === '.jsonl' || ext === '.log') {
    if (size > 3e6) return `${(size / 1e6).toFixed(1)} MB log`;
    const t = readText(p) || ''; const n = t ? t.split('\n').filter(Boolean).length : 0;
    return `${n} lines`;
  }
  const first = (readText(p) || '').split(/\r?\n/).find(l => l.trim()) || '';
  return first.slice(0, 100);
}
function listFiles(bot) {
  const b = BOTS[bot], out = [];
  const add = (group, dir, names) => {
    for (const name of names) {
      if (HIDE.test(name)) continue;
      const p = path.join(dir, name); let st; try { st = fs.statSync(p); } catch { continue; }
      if (!st.isFile()) continue;
      const ck = p; const c = fileSummaryCache.get(ck);
      let summary; if (c && c.m === st.mtimeMs && c.s === st.size) summary = c.v; else { summary = summarize(p, name, st.size); fileSummaryCache.set(ck, { m: st.mtimeMs, s: st.size, v: summary }); }
      out.push({ group, name, size: st.size, mtime: st.mtimeMs, summary });
    }
  };
  let names = []; try { names = fs.readdirSync(stateDirOf(b)); } catch {}
  add('state', stateDirOf(b), names.sort());
  add('root', b.dir, ROOT_DATA);
  return out;
}

function structure(bot) {
  const b = BOTS[bot], sd = stateDirOf(b), info = staticInfo();
  // the bot profile (profile.json, falling back to role.json / mode.json / think-off / disabled-modules.json)
  let profile = null;
  try { profile = require(path.join(CODE, 'brain', 'profile.js')).createProfile({ stateDir: sd, botName: b.name }).get(); } catch {}
  const disabled = profile ? profile.disabledModules : (readJson(path.join(sd, 'disabled-modules.json')) || []);
  const seen = lastSeenByTag(bot);
  const now = Date.now();
  const modules = info.modules.map(m => {
    const s = seen[m.name] || null;
    const age = s && s.t ? now - new Date(s.t).getTime() : null;
    return { ...m, status: disabled.includes(m.name) ? 'disabled' : (age !== null && age < 600000 ? 'active' : 'loaded'), lastSeen: s ? s.t : null, lines: s ? s.n : 0 };
  });
  let steps = (profile ? profile.steps : (readJson(path.join(sd, 'role.json')) || {}).steps) || null;
  if (!steps) {
    const plan = [...state[bot].logs].reverse().find(e => e.kind === 'PLAN' && /processes loaded: /.test(e.text));
    if (plan) steps = plan.text.split('processes loaded: ')[1].split(' > ');
  }
  const mode = profile ? { mode: profile.stance, since: profile.stanceSince } : (readJson(path.join(sd, 'mode.json')) || {});
  const reflexes = readJson(path.join(sd, 'reflexes.json'));      // written by the brain every 2 s when a lease changes
  return {
    profile, taxonomy: info.taxonomy, ladder: info.ladder, bands: info.bands, reflexes,
    mode: { mode: mode.mode || 'unknown', since: mode.since || null, role: profile ? profile.role : ((readJson(path.join(sd, 'role.json')) || {}).role || null),
      safety: (readJson(path.join(sd, 'safety-state.json')) || {}).mode || null,
      thinkOff: profile ? !profile.planner.enabled : fs.existsSync(path.join(sd, 'think-off')), goals: readJson(path.join(sd, 'goals.json')) },
    scheduler: readJson(path.join(sd, 'scheduler.json')),
    tasks: taskStates(bot),
    modules, skills: info.skills, steps,
    files: listFiles(bot),
    strategy: (readText(path.join(sd, 'strategy.md')) || '').slice(0, 4000) || null,
  };
}

// Behavior tree / state graph. Contract (written by the bot, read here): brain/state/behavior-tree.json
//   { updatedAt, machine, nodes:[{id,label,parent?,entry?,type?}], transitions:[{from,to,label?}], active:[ids], history:[{at,from,to}] }
// Until that file exists, a placeholder graph is derived from the autopilot plan steps and the latest "GOAL step X" log lines.
// Dashcam clips (brain/pilot-kit, format v1) in brain/state/clips/*.json. Listing reads a small summary of each, cached by mtime.
const clipSummary = new Map();
function listClips(bot) {
  const dir = path.join(stateDirOf(BOTS[bot]), "clips");
  let names = []; try { names = fs.readdirSync(dir).filter(f => /^[\w.-]+\.json$/.test(f)).sort().reverse(); } catch {}
  const out = [];
  for (const name of names) {
    const p = path.join(dir, name); let st; try { st = fs.statSync(p); } catch { continue; }
    let c = clipSummary.get(p);
    if (!c || c.m !== st.mtimeMs) {
      const j = readJson(p);
      if (!j || !Array.isArray(j.samples)) continue;
      const kinds = {}; for (const e of j.events || []) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
      const hp = j.samples.map(x => x.hp).filter(x => typeof x === "number");
      c = { m: st.mtimeMs, v: { name, size: st.size, reason: j.reason || name.replace(/^.*-(\w+)\.json$/, "$1"), savedAt: j.savedAt || null,
        durationMs: j.samples.length ? j.samples[j.samples.length - 1].t : 0, samples: j.samples.length, minHp: hp.length ? Math.min(...hp) : null,
        events: kinds, hasMap: !!j.map, version: j.v } };
      clipSummary.set(p, c);
    }
    out.push(c.v);
  }
  return out;
}

function behavior(bot) {
  const sd = stateDirOf(BOTS[bot]);
  const file = path.join(sd, 'behavior-tree.json');
  const j = readJson(file);
  if (j && Array.isArray(j.nodes)) {
    let mtime = 0; try { mtime = fs.statSync(file).mtimeMs; } catch {}
    return { placeholder: false, source: 'brain/state/behavior-tree.json', mtime, ...j };
  }
  const s = structure(bot);
  const steps = s.steps || [];
  const stepEvents = state[bot].logs.filter(e => e.tag === 'autopilot' && e.kind === 'GOAL' && /^autopilot GOAL step \S+/.test(e.text));
  const history = []; let prev = null;
  for (const e of stepEvents.slice(-25)) {
    const to = e.text.match(/step (\S+)/)[1];
    history.push({ at: e.t, from: prev, to }); prev = to;
  }
  const active = stepEvents.length ? [stepEvents[stepEvents.length - 1].text.match(/step (\S+)/)[1]] : [];
  const nodes = [{ id: 'root', label: 'autopilot', entry: true, type: 'root' }, ...steps.map(id => ({ id, label: id, parent: null }))];
  const transitions = steps.map((id, i) => ({ from: 'root', to: id, label: i === 0 ? 'highest priority' : undefined }));
  return { placeholder: true, source: 'derived from autopilot plan and GOAL log lines (no behavior-tree.json yet)', mtime: 0, machine: 'autopilot',
    nodes, transitions, active: active.length ? ['root', ...active] : ['root'], history, mode: s.mode.mode };
}

// example of the contract, used for UI testing: /api/behavior/ozo?sample=1
const SAMPLE_TREE = { placeholder: false, source: "sample", mtime: Date.now(), machine: "root", active: ["survive", "eat"],
  nodes: [{ id: "idle", label: "idle", entry: true }, { id: "survive", label: "survive" }, { id: "gather", label: "gather" },
    { id: "eat", label: "eat", parent: "survive", entry: true }, { id: "flee", label: "flee", parent: "survive" }, { id: "heal", label: "heal", parent: "survive" }],
  transitions: [{ from: "idle", to: "survive", label: "hurt" }, { from: "survive", to: "gather", label: "safe" }, { from: "gather", to: "idle" },
    { from: "eat", to: "flee", label: "mob near" }, { from: "flee", to: "heal", label: "far" }, { from: "heal", to: "eat", label: "hp<20" }],
  history: [{ at: new Date().toISOString(), from: "idle", to: "survive" }] };

function fileContent(bot, group, name) {
  if (!/^[\w.-]+$/.test(name)) return null;
  const b = BOTS[bot];
  const dir = group === 'state' ? stateDirOf(b) : group === 'root' && ROOT_DATA.includes(name) ? b.dir : null;
  if (!dir || HIDE.test(name)) return null;
  const p = path.join(dir, name);
  let st; try { st = fs.statSync(p); } catch { return null; }
  if (!st.isFile()) return null;
  const CAP = 200 * 1024;
  let text, truncated = false;
  if (st.size <= CAP) text = fs.readFileSync(p, 'utf8');
  else {
    const fromEnd = /\.(jsonl|log|txt)$/.test(name) || name === 'lessons.md';
    const buf = Buffer.alloc(CAP); const fd = fs.openSync(p, 'r');
    try { fs.readSync(fd, buf, 0, CAP, fromEnd ? st.size - CAP : 0); } finally { fs.closeSync(fd); }
    text = buf.toString('utf8'); truncated = fromEnd ? 'showing the last 200 KB' : 'showing the first 200 KB';
    if (fromEnd) text = text.slice(text.indexOf('\n') + 1);
  }
  if (name.endsWith('.json') && !truncated) { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch {} }
  return { name, group, size: st.size, mtime: st.mtimeMs, truncated, text };
}

// Items acquired (brain/acquired writes brain/state/acquired.jsonl: one { t, item, n } line per dropped item the bot picked up; chest withdrawals are not in it).
// /api/acquired?window=1h|8h|24h|7d|all -> { window, since, now, trackingSince, bots: { ozo: { item: n }, smeo: { item: n } } }
const ACQ_WINDOWS = { '1h': 3600e3, '8h': 8 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3, all: Infinity };
const acqCache = new Map();
function acquiredEntries(bot) {
  const p = path.join(stateDirOf(BOTS[bot]), 'acquired.jsonl');
  let st; try { st = fs.statSync(p); } catch { return []; }
  const c = acqCache.get(p);
  if (c && c.m === st.mtimeMs && c.s === st.size) return c.v;
  const v = [];
  for (const line of (readText(p) || '').split('\n')) {
    if (!line) continue;
    try { const j = JSON.parse(line); if (j && typeof j.item === 'string' && j.n > 0 && Number.isFinite(j.t)) v.push({ t: j.t, item: j.item, n: j.n }); } catch {}
  }
  acqCache.set(p, { m: st.mtimeMs, s: st.size, v });
  return v;
}
function acquired(windowKey) {
  const key = Object.prototype.hasOwnProperty.call(ACQ_WINDOWS, windowKey) ? windowKey : '8h';
  const now = Date.now(), since = ACQ_WINDOWS[key] === Infinity ? 0 : now - ACQ_WINDOWS[key];
  const bots = {}; let trackingSince = null;
  for (const id of Object.keys(BOTS)) {
    const sum = {};
    for (const e of acquiredEntries(id)) {
      if (trackingSince === null || e.t < trackingSince) trackingSince = e.t;
      if (e.t >= since) sum[e.item] = (sum[e.item] || 0) + e.n;
    }
    bots[id] = sum;
  }
  return { window: key, since, now, trackingSince, bots };
}

// Progress page: roadmap phases, builds with their inspection verdicts, per-day numbers (dashboard/progress.js). Cached for 10 s.
const { buildProgress } = require('./progress');
let progressCache = null;
function progress() {
  if (progressCache && Date.now() - progressCache.at < 10000) return progressCache.v;
  const v = buildProgress({ bots: Object.values(BOTS), codeDir: CODE, registryFile: REGISTRY });
  progressCache = { at: Date.now(), v };
  return v;
}

// Item icons: the prismarine-viewer texture pack for 1.21.6 already on disk (read-only), items first, then block faces.
// Bases page: the ant-farm cast of a base (dashboard/basecast.js). The base list and the dug-block log live next to the registry in bot-shared/.
const basecast = require('./basecast');
const schematiccast = require('./schematiccast');
const arenacast = require('./arenacast');
const castCache = new Map();
function castOpts() { return { sharedDir: path.dirname(REGISTRY), registryFile: REGISTRY, botDirs: Object.values(BOTS), codeDir: CODE }; }
// The schematic agent (dashboard/schematicagent.js): its queue lives in bot-shared/schematic-agent, shared with the bots. Finished requests drop the catalog caches so the new
// schematic shows at once.
const schematicAgent = require('./schematicagent').createService({
  sharedDir: path.dirname(REGISTRY), dirs: () => require('../brain/schematic/store').dirsFor({ sharedDir: path.dirname(REGISTRY) }).concat(Object.values(BOTS).map(b => path.join(b.dir || b, 'brain', 'state', 'schematics'))),
  onChange: () => castCache.clear(), log: (m) => console.log(m),
});
schematicAgent.start();
// POST bodies are small JSON; a page on another origin cannot send application/json without a preflight this server does not answer, and a request that names another origin is refused too
function readJsonBody(req, res, then) {
  const origin = req.headers.origin;
  if (origin) { try { if (new URL(origin).host !== req.headers.host) return send(res, 403, 'wrong origin'); } catch { return send(res, 403, 'wrong origin'); } }
  if (!/^application\/json/i.test(req.headers['content-type'] || '')) return send(res, 415, 'send application/json');
  let n = 0; const chunks = [];
  req.on('data', (c) => { n += c.length; if (n > 65536) { send(res, 413, 'too big'); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { let b; try { b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return send(res, 400, 'not JSON'); } then(b); });
}
function castCached(id, fn) {
  const c = castCache.get(id);
  if (c && Date.now() - c.at < 15000) return c.v;
  const v = fn();
  castCache.set(id, { at: Date.now(), v });
  return v;
}

const TEX = path.join(CODE, "node_modules", "prismarine-viewer", "public", "textures", "1.21.6");
const texCache = new Map();
function texture(name) {
  if (texCache.has(name)) return texCache.get(name);
  const tries = [["items", name], ["blocks", name], ["blocks", name + "_front"], ["blocks", name + "_side"], ["blocks", name + "_top"], ["blocks", name + "_stage7"], ["blocks", name.replace(/_slab$|_stairs$|_fence$|_wall$/, "")], ["blocks", name.replace(/_slab$|_stairs$|_fence$|_wall$/, "") + "s"], ["blocks", name.replace(/_planks$/, "") + "_planks"]];
  let found = null;
  for (const [d, n] of tries) { const p = path.join(TEX, d, n + ".png"); if (fs.existsSync(p)) { found = p; break; } }
  texCache.set(name, found);
  return found;
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
function send(res, code, body, type = 'text/plain') { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); }
function sendFile(res, p, extra = {}) {
  fs.readFile(p, (err, data) => {
    if (err) return send(res, 404, 'not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...extra });
    res.end(data);
  });
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  if (p === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const init = { snapshot: snapshot(), logs: {} };
    for (const id of Object.keys(BOTS)) init.logs[id] = state[id].logs.slice(-600);
    res.write(`event: init\ndata: ${JSON.stringify(init)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  let sm;
  if ((sm = p.match(/^\/tex\/([a-z0-9_]+)\.png$/))) {
    const f = texture(sm[1]);
    if (!f) return send(res, 404, "no texture");
    return sendFile(res, f, { "Cache-Control": "max-age=86400" });
  }
  if ((sm = p.match(/^\/api\/structure\/(ozo|smeo)$/))) return send(res, 200, JSON.stringify(structure(sm[1])), 'application/json');
  if ((sm = p.match(/^\/api\/clips\/(ozo|smeo)$/))) return send(res, 200, JSON.stringify(listClips(sm[1])), 'application/json');
  if ((sm = p.match(/^\/api\/clip\/(ozo|smeo)\/([\w.-]+\.json)$/))) return sendFile(res, path.join(stateDirOf(BOTS[sm[1]]), 'clips', sm[2]));
  if ((sm = p.match(/^\/api\/behavior\/(ozo|smeo)$/))) return send(res, 200, JSON.stringify(u.searchParams.get('sample') ? SAMPLE_TREE : behavior(sm[1])), 'application/json');
  if ((sm = p.match(/^\/api\/file\/(ozo|smeo)\/(state|root)\/([\w.-]+)$/))) {
    const r = fileContent(sm[1], sm[2], sm[3]);
    return r ? send(res, 200, JSON.stringify(r), 'application/json') : send(res, 404, 'not found');
  }
  // spectator reviewer (reviewer/): latest findings per bot, and the in-bot telemetry summary they are based on
  if (p === '/api/findings') return send(res, 200, JSON.stringify(Object.fromEntries(Object.values(BOTS).map(b => [b.id, readJson(path.join(stateDirOf(b), 'review', 'findings.json'))]))), 'application/json');
  if ((sm = p.match(/^\/api\/telemetry\/(ozo|smeo)$/))) return send(res, 200, JSON.stringify(readJson(path.join(stateDirOf(BOTS[sm[1]]), 'telemetry', 'summary.json'))), 'application/json');
  if (p === '/api/bases') return send(res, 200, JSON.stringify(castCached('*', () => basecast.basesIndex(castOpts()))), 'application/json');
  if ((sm = p.match(/^\/api\/bases\/([\w.-]+)$/))) {
    const cast = castCached('base:' + sm[1], () => basecast.baseCast(castOpts(), sm[1]));
    return cast ? send(res, 200, JSON.stringify(cast), 'application/json') : send(res, 404, 'no such base');
  }
  // speedrun bench (tools/bench): test arenas, their previews, scored runs. Read-only.
  if (p === '/api/arenas') return send(res, 200, JSON.stringify(arenacast.index(CODE)), 'application/json');
  if ((sm = p.match(/^\/api\/arenas\/([\w.-]+)\/preview$/))) { const pv = arenacast.preview(CODE, sm[1]); return pv ? send(res, 200, JSON.stringify(pv), 'application/json') : send(res, 404, 'no preview'); }
  if ((sm = p.match(/^\/api\/arena-runs\/([\w.-]+)$/))) { const r = arenacast.run(CODE, sm[1]); return r ? send(res, 200, JSON.stringify(r), 'application/json') : send(res, 404, 'no such run'); }
  if (p === '/api/schematics') return send(res, 200, JSON.stringify(castCached('schematics', () => schematiccast.index(castOpts()))), 'application/json');
  if ((sm = p.match(/^\/api\/schematics\/([\w.-]+)$/))) {
    const variant = u.searchParams.get('variant') || '';
    const sc = castCached('schematic:' + sm[1] + ':' + variant, () => schematiccast.detail(castOpts(), sm[1], variant || undefined));
    return sc ? send(res, 200, JSON.stringify(sc), 'application/json') : send(res, 404, 'no such schematic');
  }
  // the schematic agent: ask for a build in words (people here, the bots through bot-shared), watch the queue, cancel, and the bots' daily cap
  if (p === '/api/schematic-agent' && req.method === 'GET') return send(res, 200, JSON.stringify(schematicAgent.info()), 'application/json');
  if ((sm = p.match(/^\/api\/schematic-agent\/requests\/([\w-]+)$/)) && req.method === 'GET') {
    const r = schematicAgent.get(sm[1]);
    return r ? send(res, 200, JSON.stringify(r), 'application/json') : send(res, 404, 'no such request');
  }
  if (req.method === 'POST' && p.startsWith('/api/schematic-agent/')) {
    return readJsonBody(req, res, (body) => {
      let out;
      if (p === '/api/schematic-agent/requests') out = schematicAgent.create(body);
      else if (p === '/api/schematic-agent/config') out = { ok: true, config: schematicAgent.setConfig(body) };
      else if ((sm = p.match(/^\/api\/schematic-agent\/requests\/([\w-]+)\/cancel$/))) out = schematicAgent.cancel(sm[1]);
      else return send(res, 404, 'not found');
      return send(res, out.ok ? 200 : 400, JSON.stringify(out), 'application/json');
    });
  }
  if (p === '/api/progress') return send(res, 200, JSON.stringify(progress()), 'application/json');
  if (p === '/api/acquired') return send(res, 200, JSON.stringify(acquired(u.searchParams.get('window'))), 'application/json');
  if (p === '/api/snapshot') return send(res, 200, JSON.stringify(snapshot()), 'application/json');
  let m;
  if ((m = p.match(/^\/img\/(ozo|smeo)\/(top|pov|slice)$/))) {
    return sendFile(res, path.join(VIEWS(BOTS[m[1]]), m[2] + '-latest.png'));
  }
  if ((m = p.match(/^\/api\/history\/(ozo|smeo)\/(top|pov)$/))) {
    let files = [];
    try { files = fs.readdirSync(VIEWS(BOTS[m[1]])).filter(f => f.startsWith(m[2] + '-2') && f.endsWith('.png')).sort(); } catch {}
    return send(res, 200, JSON.stringify(files), 'application/json');
  }
  if ((m = p.match(/^\/img\/(ozo|smeo)\/h\/([\w.-]+\.png)$/))) {
    return sendFile(res, path.join(VIEWS(BOTS[m[1]]), m[2]), { 'Cache-Control': 'max-age=3600' });
  }
  const rel = p === '/' ? 'index.html' : p.slice(1);
  const file = path.normalize(path.join(WEB, rel));
  if (!file.startsWith(WEB)) return send(res, 403, 'no');
  // SPA routes (no file extension) fall back to index.html
  if (!path.extname(file) && !fs.existsSync(file)) return sendFile(res, path.join(WEB, 'index.html'));
  sendFile(res, file);
}).listen(PORT, '127.0.0.1', () => console.log(`Bot Dashboard on http://localhost:${PORT}`));
