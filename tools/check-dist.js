// Fails when the installer would ship a dashboard that cannot open. Two checks:
// 1) dashboard/web/dist is missing files its index.html loads. The installer bundles dist/ and CI does not build it,
// so a dist that is gitignored or half committed ships a blank window (0.1.18 did).
// 2) a file dashboard/server.js requires (by relative path, followed recursively) is not in app/package.json extraResources: server.js dies on
//    require and the window never appears (schematiccast.js + brain/schematic missed the list in #296).
const fs = require('fs')
const path = require('path')
const root = path.join(__dirname, '..')
const dist = path.join(root, 'dashboard', 'web', 'dist')
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
const refs = [...html.matchAll(/(?:src|href)="\/([^"]+\.(?:js|css))"/g)].map((m) => m[1])
if (!refs.length) { console.error('dashboard/web/dist/index.html references no scripts or styles'); process.exit(1) }
const missing = refs.filter((r) => !fs.existsSync(path.join(dist, r)))
if (missing.length) { console.error('dashboard/web/dist is missing ' + missing.join(', ') + ': run npm run build in dashboard/web and commit dist/'); process.exit(1) }
console.log('dist ok: ' + refs.join(', '))

const res = require(path.join(root, 'app', 'package.json')).build.extraResources
const rel = (p) => path.relative(root, p).split(path.sep).join('/')
const shipped = (file) => res.some((r) => {
  const from = path.resolve(root, 'app', r.from)
  const f = path.relative(from, file).split(path.sep).join('/')
  if (f.startsWith('..')) return false
  if (!r.filter) return true
  return r.filter.some((pat) => pat === f || (pat.endsWith('/**') && f.startsWith(pat.slice(0, -2))) || (pat === '*.js' && /^[^/]+\.js$/.test(f)))
})
const resolveReq = (from, spec) => {
  const base = path.resolve(path.dirname(from), spec)
  return [base, base + '.js', path.join(base, 'index.js')].find((c) => fs.existsSync(c) && fs.statSync(c).isFile())
}
const seen = new Set(), unshipped = []
const walk = (file) => {
  if (seen.has(file)) return
  seen.add(file)
  if (!shipped(file)) { unshipped.push(rel(file)); return }
  const src = fs.readFileSync(file, 'utf8')
  for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
    const t = resolveReq(file, m[1])
    if (t) walk(t)
  }
}
walk(path.join(root, 'dashboard', 'server.js'))
if (unshipped.length) { console.error('not shipped in the installer (add to extraResources in app/package.json): ' + unshipped.join(', ')); process.exit(1) }
console.log('package ok: ' + seen.size + ' files reachable from dashboard/server.js are shipped')
