const BOTS = ['ozo', 'smeo'];
const FILTERS = {
  key:  { label: 'Key',   test: e => ['GOAL', 'PLAN', 'DIED', 'REFLEX', 'ALARM', 'IDLE', 'KNOWN', 'CRAFT_FAIL', 'PLACE_FAIL', 'chat', 'conn'].includes(e.kind) },
  chat: { label: 'Chat',  test: e => ['chat', 'server', 'DIED'].includes(e.kind) },
  act:  { label: 'Actions', test: e => ['GOAL', 'PLAN', 'SCHED', 'nav', 'combat', 'safety'].includes(e.kind) },
  all:  { label: 'All',   test: () => true },
};
const ui = {};         // per-bot DOM + state
let layout = localStorage.getItem('layout') || 'both';
let snap = {};
const logs = { ozo: [], smeo: [] };
const MAXLOG = 1500;

const $ = (h) => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstChild; };
const esc = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const ago = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 90 ? s + 's ago' : s < 5400 ? Math.round(s / 60) + 'm ago' : (s / 3600).toFixed(1) + 'h ago'; };
const hhmmss = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour12: false }) : '';

function build(id, name) {
  const el = $(`
  <section class="card" data-bot="${id}">
    <div class="card-header">
      <div>
        <div class="card-title"><span class="dot"></span>${name}
          <span class="badge secondary" data-f="role">-</span>
          <span class="badge outline mono" data-f="step">-</span>
          <span class="badge outline" data-f="fresh">-</span>
        </div>
        <div class="card-desc" data-f="where">waiting for data</div>
      </div>
    </div>
    <div class="card-content">
      <div class="stats">
        <div class="stat"><label>Health</label><div class="v" data-f="hpv"></div><div class="progress hp"><i data-f="hpb"></i></div></div>
        <div class="stat"><label>Food</label><div class="v" data-f="fv"></div><div class="progress food"><i data-f="fb"></i></div></div>
        <div class="stat"><label>Position</label><div class="v mono" data-f="pos"></div></div>
        <div class="stat"><label>Looking at</label><div class="v" data-f="look"></div></div>
      </div>
      <div class="goal"><b>Goal</b><span data-f="goal">-</span></div>
      <div class="goal" data-f="planbox" style="display:none"><b>Plan</b><span class="clamp" data-f="plan" title="click to expand" onclick="this.classList.toggle('open')"></span></div>
      <div class="bag" data-f="bag"></div>
      <div class="tabs-list" style="margin-top:14px">
        <button class="tab active" data-v="top">Top-down</button>
        <button class="tab" data-v="pov">First-person</button>
        <button class="tab" data-v="3d">3D live</button>
        <button class="tab" data-v="hist">History</button>
      </div>
      <div class="view-wrap" data-f="vw"></div>
      <div class="view-meta" data-f="vm"></div>
    </div>
    <hr class="sep">
    <div style="padding-top:12px">
      <div class="log-bar">
        <div class="tabs-list" data-f="filters">${Object.entries(FILTERS).map(([k, f]) => `<button class="tab${k === 'key' ? ' active' : ''}" data-fl="${k}">${f.label}</button>`).join('')}</div>
        <input class="input" data-f="q" placeholder="search log">
        <button class="btn on" data-f="follow">Follow</button>
        <span class="pause-note" data-f="paused"></span>
      </div>
      <div class="log mono" data-f="log"></div>
    </div>
  </section>`);
  const f = {};
  el.querySelectorAll('[data-f]').forEach(n => f[n.dataset.f] = n);
  const u = { id, name, el, f, view: 'top', filter: 'key', q: '', follow: true, hist: [], histIdx: -1, rendered: 0 };
  ui[id] = u;
  el.querySelectorAll('[data-v]').forEach(b => b.onclick = () => {
    u.view = b.dataset.v;
    el.querySelectorAll('[data-v]').forEach(x => x.classList.toggle('active', x === b));
    renderView(u, true);
  });
  el.querySelectorAll('[data-fl]').forEach(b => b.onclick = () => {
    u.filter = b.dataset.fl;
    el.querySelectorAll('[data-fl]').forEach(x => x.classList.toggle('active', x === b));
    redrawLog(u);
  });
  f.q.oninput = () => { u.q = f.q.value.toLowerCase(); redrawLog(u); };
  f.follow.onclick = () => { u.follow = !u.follow; f.follow.classList.toggle('on', u.follow); if (u.follow) f.log.scrollTop = f.log.scrollHeight; };
  f.log.onscroll = () => {
    const atEnd = f.log.scrollHeight - f.log.scrollTop - f.log.clientHeight < 30;
    if (!atEnd && u.follow) { u.follow = false; f.follow.classList.remove('on'); }
    else if (atEnd && !u.follow) { u.follow = true; f.follow.classList.add('on'); }
  };
  return u;
}

function renderStatus(u) {
  const s = snap[u.id]; if (!s) return;
  const st = s.status, f = u.f;
  if (!st) { f.where.textContent = 'no latest.json yet'; return; }
  const age = Date.now() - new Date(st.at).getTime();
  f.role.textContent = st.role || '-';
  f.step.textContent = (st.step || "no step") + (st.sleeping ? ' (sleeping)' : '');
  const fresh = age < 150000;
  f.fresh.className = 'badge outline ' + (fresh ? 'ok' : age < 600000 ? 'warn' : 'bad');
  f.fresh.innerHTML = `<i class="dot"></i>${fresh ? 'live' : 'stale'} · ${ago(age)}`;
  u.el.querySelector('.card-title .dot').style.background = fresh ? 'hsl(142 71% 45%)' : 'hsl(0 84% 60%)';
  const clock = (t) => { const h = Math.floor(((t / 1000) + 6) % 24), m = Math.floor((t % 1000) * 0.06); return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'); };
  f.where.textContent = `${st.me ? st.me.join(', ') : '?'} · day clock ${clock(st.time || 0)} · ${st.spawnable ?? '?'} mob-spawnable cells · ${st.torches ?? '?'} torches known`;
  f.hpv.textContent = `${st.hp} / 20`; f.hpb.style.width = Math.min(100, (st.hp || 0) * 5) + '%';
  f.fv.textContent = `${st.food} / 20`; f.fb.style.width = Math.min(100, (st.food || 0) * 5) + '%';
  f.pos.textContent = st.me ? st.me.join(', ') : '?';
  f.look.textContent = st.lookingAt ? `${st.lookingAt.block} (${st.lookingAt.dist}m)` : 'nothing';
  f.goal.textContent = s.goal || '-';
  f.planbox.style.display = s.plan ? '' : 'none'; f.plan.textContent = s.plan || '';
  const bag = Object.entries(st.bag || {}).sort((a, b) => b[1] - a[1]);
  f.bag.innerHTML = bag.map(([k, n]) => `<span class="badge secondary">${esc(k.replace(/_/g, ' '))} <b>${n}</b></span>`).join('') +
    (st.armor && st.armor.length ? st.armor.map(a => `<span class="badge outline">${esc(typeof a === 'string' ? a : a.name || '?')}</span>`).join('') : '');
  renderView(u, false);
}

function imgMeta(u, kind) {
  const m = snap[u.id] && snap[u.id].status && snap[u.id].status._img;
  return m ? m[kind] : 0;
}
function renderView(u, force) {
  const f = u.f, v = u.view;
  const key = v + ':' + (v === 'hist' ? u.histIdx + ':' + u.histKind : imgMeta(u, v));
  if (!force && u.shown === key) return;
  u.shown = key;
  if (v === '3d') {
    const port = snap[u.id] ? snap[u.id].viewerPort : (u.id === 'ozo' ? 3007 : 3008);
    f.vw.innerHTML = `<iframe src="http://${location.hostname}:${port}/" title="prismarine viewer"></iframe>`;
    f.vm.innerHTML = `<span>Live prismarine-viewer on port ${port}. If it stays black, the web bundle cannot render 1.21.6 — use First-person instead.</span><a class="btn" target="_blank" href="http://${location.hostname}:${port}/">Open</a>`;
    return;
  }
  if (v === 'hist') return renderHist(u, force);
  const t = imgMeta(u, v);
  const cls = v === 'top' ? 'pix' : '';
  f.vw.innerHTML = `<img class="${cls}" src="/img/${u.id}/${v}?t=${t}" alt="${v}" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'view-empty',textContent:'no image yet'}))">`;
  const age = t ? ago(Date.now() - t) : 'n/a';
  f.vm.innerHTML = `<span>${v === 'top' ? 'Top-down map; purple = mob-spawnable cells' : 'Four-way first-person sheet'} · updated ${age}</span><span>refreshes every ~60 s</span>`;
}
async function renderHist(u, force) {
  const f = u.f;
  if (force || !u.hist.length) {
    u.histKind = u.histKind || 'pov';
    const files = await (await fetch(`/api/history/${u.id}/${u.histKind}`)).json();
    u.hist = files; u.histIdx = files.length - 1;
  }
  const n = u.hist.length;
  if (!n) { f.vw.innerHTML = '<div class="view-empty">no history images</div>'; f.vm.innerHTML = ''; return; }
  const file = u.hist[u.histIdx];
  f.vw.innerHTML = `<img class="${u.histKind === 'top' ? 'pix' : ''}" src="/img/${u.id}/h/${file}">`;
  const when = file.match(/(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)/);
  const d = when ? new Date(`${when[1]}T${when[2]}:${when[3]}:${when[4]}Z`) : null;
  f.vm.innerHTML = `<span>${d ? d.toLocaleTimeString([], { hour12: false }) : file} · frame ${u.histIdx + 1}/${n}</span>
    <span><button class="btn ${u.histKind === 'pov' ? 'on' : ''}" data-hk="pov">First-person</button> <button class="btn ${u.histKind === 'top' ? 'on' : ''}" data-hk="top">Top-down</button></span>
    <input type="range" min="0" max="${n - 1}" value="${u.histIdx}" style="flex-basis:100%">`;
  f.vm.querySelector('input').oninput = (e) => { u.histIdx = +e.target.value; u.shown = null; renderHist(u, false); };
  f.vm.querySelectorAll('[data-hk]').forEach(b => b.onclick = () => { u.histKind = b.dataset.hk; u.hist = []; renderHist(u, true); });
}

function lineHtml(e) {
  const dim = ['SCHED', 'nav', 'safety', 'breath', 'RELOAD', 'router', 'lag'].includes(e.kind) ? ' dim' : '';
  return `<div class="ln ${esc(e.kind)}${dim}"><span class="t">${hhmmss(e.t)}</span><span class="k" title="${esc(e.kind)}">${esc(e.kind)}</span><span class="x">${esc(e.text.replace(/^(autopilot )?(GOAL|PLAN|REFLEX|ALARM|IDLE|KNOWN|CRAFT_FAIL|PLACE_FAIL)\s*/, '').replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s*/, ''))}</span></div>`;
}
function passes(u, e) { return FILTERS[u.filter].test(e) && (!u.q || e.text.toLowerCase().includes(u.q)); }
function redrawLog(u) {
  const rows = logs[u.id].filter(e => passes(u, e)).slice(-600);
  u.f.log.innerHTML = rows.map(lineHtml).join('');
  if (u.follow) u.f.log.scrollTop = u.f.log.scrollHeight;
}
function appendLogs(id, entries) {
  const u = ui[id], arr = logs[id];
  const seen = arr.length ? arr[arr.length - 1].id : 0;
  const fresh = entries.filter(e => e.id > seen);
  if (!fresh.length) return;
  arr.push(...fresh); if (arr.length > MAXLOG) arr.splice(0, arr.length - MAXLOG);
  const rows = fresh.filter(e => passes(u, e));
  if (!rows.length) return;
  u.f.log.insertAdjacentHTML('beforeend', rows.map(lineHtml).join(''));
  while (u.f.log.childElementCount > 800) u.f.log.firstElementChild.remove();
  if (u.follow) u.f.log.scrollTop = u.f.log.scrollHeight;
}

function setLayout(l) {
  layout = l; localStorage.setItem('layout', l);
  document.querySelectorAll('#layout .tab').forEach(b => b.classList.toggle('active', b.dataset.l === l));
  const g = document.getElementById('grid');
  g.classList.toggle('single', l !== 'both');
  for (const id of BOTS) ui[id].el.style.display = (l === 'both' || l === id) ? '' : 'none';
}

function connect() {
  const conn = document.getElementById('conn');
  const set = (cls, txt) => { conn.className = 'badge outline ' + cls; conn.innerHTML = `<i class="dot"></i><span>${txt}</span>`; };
  const es = new EventSource('/api/stream');
  es.addEventListener('init', (ev) => {
    const d = JSON.parse(ev.data); snap = d.snapshot;
    for (const id of BOTS) { logs[id] = d.logs[id] || []; redrawLog(ui[id]); renderStatus(ui[id]); }
    set('ok', 'live');
  });
  es.addEventListener('status', (ev) => { snap = JSON.parse(ev.data); for (const id of BOTS) renderStatus(ui[id]); });
  es.addEventListener('log', (ev) => { const es_ = JSON.parse(ev.data); for (const id of BOTS) appendLogs(id, es_.filter(e => e.bot === id)); });
  es.addEventListener('ping', () => set('ok', 'live'));
  es.onerror = () => set('bad', 'reconnecting');
}

(function main() {
  const grid = document.getElementById('grid');
  grid.append(build('ozo', 'OzoGo444').el, build('smeo', 'Smeo444').el);
  document.querySelectorAll('#layout .tab').forEach(b => b.onclick = () => setLayout(b.dataset.l));
  setLayout(layout);
  setInterval(() => { for (const id of BOTS) renderStatus(ui[id]); }, 5000); // keep "x s ago" fresh
  connect();
})();
