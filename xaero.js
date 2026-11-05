// Read-only reader for Xaero's Minimap waypoints and Xaero's World Map tiles.
// Never writes to the Xaero folders. Safe to require() from the bot (no deps beyond node core).
//
//   const xaero = require('./xaero');
//   xaero.listWorlds();                              // worlds that have map and/or waypoint data
//   xaero.waypoints('HOME DEPOT GOD-EMPEROR', 0);    // dim: 0 overworld, -1 nether, 1 end
//   const map = xaero.openMap('HOME DEPOT GOD-EMPEROR');   // overworld surface layer
//   map.at(-1060, 2323)  // -> { explored, height, rgb:[r,g,b], biome } (height = top block y)
//
// World Map data is a rendered top-down picture (colour + top height + biome per x,z column),
// NOT block ids. It only covers columns the player has seen with the mod running.
// Format decoded from XaerosWorldMap 1.39.10 (cache_1 *.xwmc, save version 2.24).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const XAERO = process.env.XAERO_DIR || path.join(process.env.APPDATA || '', '.minecraft', 'xaero');
const DIM_DIR = { '0': 'null', '-1': 'DIM-1', '1': 'DIM1' };
const DIM_MINIMAP = { '0': 'dim%0', '-1': 'dim%-1', '1': 'dim%1' };

// ---------- waypoints ----------
function listWorlds() {
  const names = new Set();
  for (const sub of ['minimap', 'world-map']) {
    try {
      for (const e of fs.readdirSync(path.join(XAERO, sub), { withFileTypes: true }))
        if (e.isDirectory() && e.name !== 'backup') names.add(e.name);
    } catch {}
  }
  return [...names].map(name => {
    const mm = path.join(XAERO, 'minimap', name), wm = path.join(XAERO, 'world-map', name, DIM_DIR[0], 'cache_1');
    return { name, waypoints: fs.existsSync(path.join(mm, DIM_MINIMAP[0], 'waypoints.txt')), map: fs.existsSync(wm),
             mtime: newest([mm, wm]) };
  }).sort((a, b) => b.mtime - a.mtime);
}
function newest(dirs) {
  let t = 0;
  for (const d of dirs) try { for (const f of fs.readdirSync(d)) t = Math.max(t, fs.statSync(path.join(d, f)).mtimeMs); } catch {}
  return t;
}

// Line format: waypoint:name:initials:x:y:z:color:disabled:type:set:rotate_on_tp:tp_yaw:visibility:destination
// Names may be escaped as §§ for ':' so split carefully.
function waypoints(world, dim = 0) {
  const f = path.join(XAERO, 'minimap', world, DIM_MINIMAP[dim], 'waypoints.txt');
  if (!fs.existsSync(f)) return [];
  const out = [];
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    if (!line.startsWith('waypoint:')) continue;
    const p = line.split(':');
    out.push({ name: p[1].replace(/§§/g, ':'), initials: p[2], x: +p[3], y: p[4] === '~' ? null : +p[4], z: +p[5],
               color: +p[6], disabled: p[7] === 'true', set: p[9], dim });
  }
  return out;
}

// ---------- world map ----------
class Reader {
  constructor(buf) { this.b = buf; this.o = 0; }
  get eof() { return this.o >= this.b.length; }
  u8() { return this.b[this.o++]; }
  i32() { const v = this.b.readInt32BE(this.o); this.o += 4; return v; }
  u16() { const v = this.b.readUInt16BE(this.o); this.o += 2; return v; }
  bytes(n) { const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
  utf() { const n = this.u16(); return this.bytes(n).toString('utf8'); }
}

function inflateXwmc(buf) {
  // single-entry zip with a data descriptor; take the local header and inflate the stream
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error('not a zip');
  const start = 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28);
  return zlib.inflateRawSync(buf.subarray(start));
}

// Returns { major, minor, biomes:[...], textures: Map(tx*8+tz -> {rgba:Buffer(16384), heights:Int16Array(4096), biomeIdx?}) }
function parseRegion(buf) {
  const r = new Reader(inflateXwmc(buf));
  const ver = r.i32(), major = ver >>> 16, minor = ver & 0xffff;
  if (major !== 2 || minor < 19 || minor > 24) throw new Error(`unsupported Xaero cache version ${major}.${minor}`);
  r.i32(); // cache hash
  r.i32(); // reload version
  r.i32(); // highlights hash
  const caveStart = r.i32();
  const caveDepth = minor >= 24 ? r.i32() : 0;
  for (let b; (b = r.u8()) !== 0xff;) r.i32(); // per-texture version list
  const biomes = [];
  const nb = r.i32();
  for (let i = 0; i < nb; i++) {
    const flag = r.u8();
    if (flag === 255) biomes.push(null);
    else if (flag === 0) biomes.push(r.utf());
    else throw new Error('old biome id format');
    if (minor <= 20) r.u16();
  }
  const textures = new Map();
  while (!r.eof) {
    const b = r.u8();
    if (b === 0xff) break;
    const tx = b >> 4, tz = b & 15;
    const rgba = Buffer.from(r.bytes(16384));
    if (minor >= 14) r.u8(); // has-light flag
    const readBits13 = () => { // 1024 longs, 4 x 13-bit entries each (bit 0 first)
      const out = new Int16Array(4096);
      for (let i = 0; i < 1024; i++) {
        const v = r.b.readBigUInt64BE(r.o); r.o += 8;
        for (let k = 0; k < 4; k++) out[i * 4 + k] = Number((v >> BigInt(13 * k)) & 0x1fffn);
      }
      return out;
    };
    const hv = readBits13(); // bit12 = height known, low 12 bits = signed height
    if (minor >= 17) readBits13(); // top heights (incl. water/transparent), unused here
    // biome index storage
    let biomePal = null, biomeData = null;
    const n = r.i32();
    if (n > 0) {
      biomePal = [];
      for (let i = 0; i < n; i++) { const v = r.i32(); biomePal.push(v); if (v !== -1) r.u16(); }
      if (minor === 19 || r.u8() === 1) {
        biomeData = Buffer.from(r.bytes(1024 * 8));
      }
    }
    const heights = new Int16Array(4096), known = new Uint8Array(4096);
    for (let i = 0; i < 4096; i++) {
      const v = hv[i];
      if (v >> 12) { known[i] = 1; heights[i] = (v & 0xfff) << 20 >> 20; }
    }
    textures.set(tx * 8 + tz, { rgba, heights, known, biomePal, biomeData });
  }
  return { major, minor, caveStart, caveDepth, biomes, textures };
}

// 13-bit entries, consistent (no straddle): 4 per long
function biomeIndexAt(biomeData, i) {
  const perLong = 4; // floor(64/13)=4 entries per long
  const lg = Math.floor(i / perLong), sub = i % perLong;
  const off = lg * 8; // big-endian long
  const hi = biomeData.readUInt32BE(off), lo = biomeData.readUInt32BE(off + 4);
  const val = (BigInt(hi) << 32n | BigInt(lo)) >> BigInt(sub * 13) & 0x1fffn;
  return Number(val);
}

class XaeroMap {
  constructor(world, dim = 0, opts = {}) {
    this.world = world; this.dim = dim;
    this.dir = path.join(XAERO, 'world-map', world, DIM_DIR[dim], opts.cave ? 'caves' : 'cache_1');
    this.regions = new Map(); // "rx_rz" -> { reg, mtime, checked }
    this.recheckMs = opts.recheckMs ?? 5000;
  }
  files() {
    try { return fs.readdirSync(this.dir).filter(f => f.endsWith('.xwmc')).map(f => f.slice(0, -5).split('_').map(Number)); }
    catch { return []; }
  }
  // Parsed region, re-read from disk if Xaero rewrote the file (checked at most every `recheckMs`).
  region(rx, rz) {
    const k = rx + '_' + rz, now = Date.now(), f = path.join(this.dir, k + '.xwmc');
    let e = this.regions.get(k);
    if (e && now - e.checked < this.recheckMs) return e.reg;
    let mtime = 0;
    try { mtime = fs.statSync(f).mtimeMs; } catch {}
    if (e && e.mtime === mtime) { e.checked = now; return e.reg; }
    let reg = null;
    if (mtime) try { reg = parseRegion(fs.readFileSync(f)); } catch (err) { reg = { error: err.message, textures: new Map(), biomes: [] }; }
    this.regions.set(k, { reg, mtime, checked: now });
    return reg;
  }
  refresh() { this.regions.clear(); }
  // Closest unexplored column to (x,z), scanning rings every `step` blocks. null if none within maxR.
  nearestUnexplored(x, z, { step = 16, maxR = 1024 } = {}) {
    for (let r = step; r <= maxR; r += step)
      for (let a = -r; a <= r; a += step)
        for (const [px, pz] of [[x + a, z - r], [x + a, z + r], [x - r, z + a], [x + r, z + a]])
          if (!this.isExplored(px, pz)) return { x: px, z: pz, dist: Math.hypot(px - x, pz - z) };
    return null;
  }
  // Explored column info or { explored:false }
  at(x, z) {
    x = Math.floor(x); z = Math.floor(z);
    const rx = Math.floor(x / 512), rz = Math.floor(z / 512);
    const reg = this.region(rx, rz);
    if (!reg) return { explored: false };
    const lx = x - rx * 512, lz = z - rz * 512;
    const tex = reg.textures.get((lx >> 6) * 8 + (lz >> 6));
    if (!tex) return { explored: false };
    const px = lx & 63, pz = lz & 63, i = pz * 64 + px;
    const c = i * 4;
    const a = tex.rgba[c]; // see COLOUR NOTE below
    if (!tex.known[i] && a === 0 && tex.rgba[c + 1] === 0 && tex.rgba[c + 2] === 0 && tex.rgba[c + 3] === 0) return { explored: false };
    let biome = null;
    if (tex.biomePal) biome = reg.biomes[tex.biomePal[tex.biomeData ? biomeIndexAt(tex.biomeData, i) : 0]] ?? null;
    return { explored: true, height: tex.known[i] ? tex.heights[i] : null, rgb: [tex.rgba[c + 1], tex.rgba[c + 2], tex.rgba[c + 3]], biome };
  }
  isExplored(x, z) { return this.at(x, z).explored; }
  // bounding box of region files that exist (in blocks)
  bounds() {
    const f = this.files(); if (!f.length) return null;
    const xs = f.map(a => a[0]), zs = f.map(a => a[1]);
    return { minX: Math.min(...xs) * 512, maxX: (Math.max(...xs) + 1) * 512 - 1, minZ: Math.min(...zs) * 512, maxZ: (Math.max(...zs) + 1) * 512 - 1, regions: f.length };
  }
}

function openMap(world, dim = 0, opts) { return new XaeroMap(world, dim, opts); }

// ---------- PNG export (top-down image of a block rectangle) ----------
function crc32(buf) {
  let c, crc = ~0;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return ~crc >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function renderPng(map, x0, z0, x1, z1, scale = 1) {
  const w = (x1 - x0 + 1) * scale, h = (z1 - z0 + 1) * scale;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    const p = map.at(x, z), rgb = p.explored ? p.rgb : [20, 20, 20];
    for (let dz = 0; dz < scale; dz++) for (let dx = 0; dx < scale; dx++) {
      const row = (z - z0) * scale + dz, col = (x - x0) * scale + dx, o = row * (w * 3 + 1) + 1 + col * 3;
      raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

module.exports = { XAERO, listWorlds, waypoints, openMap, XaeroMap, parseRegion, renderPng };
