// Fails when the dashboard server (or anything it requires by a relative path) is not shipped in the installer.
// app/package.json lists the files copied into resources/ one by one; 0.1.2x opened to nothing because dashboard/schematiccast.js (#296)
// and the brain/schematic files it needs were not on that list, so server.js died on require and the window never appeared.
const fs = require('fs')
const path = require('path')
const root = path.join(__dirname, '..')
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
const seen = new Set(), missing = []
const walk = (file) => {
  if (seen.has(file)) return
  seen.add(file)
  if (!shipped(file)) { missing.push(rel(file)); return }
  const src = fs.readFileSync(file, 'utf8')
  for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
    const t = resolveReq(file, m[1])
    if (t) walk(t)
  }
}
walk(path.join(root, 'dashboard', 'server.js'))
if (missing.length) { console.error('not shipped in the installer (add to extraResources in app/package.json): ' + missing.join(', ')); process.exit(1) }
console.log('package ok: ' + seen.size + ' files reachable from dashboard/server.js are shipped')
