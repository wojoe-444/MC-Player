// Fails when dashboard/web/dist is missing files its index.html loads. The installer bundles dist/ and CI does not build it,
// so a dist that is gitignored or half committed ships a blank window (0.1.18 did).
const fs = require('fs')
const path = require('path')
const dist = path.join(__dirname, '..', 'dashboard', 'web', 'dist')
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
const refs = [...html.matchAll(/(?:src|href)="\/([^"]+\.(?:js|css))"/g)].map((m) => m[1])
if (!refs.length) { console.error('dashboard/web/dist/index.html references no scripts or styles'); process.exit(1) }
const missing = refs.filter((r) => !fs.existsSync(path.join(dist, r)))
if (missing.length) { console.error('dashboard/web/dist is missing ' + missing.join(', ') + ': run npm run build in dashboard/web and commit dist/'); process.exit(1) }
console.log('dist ok: ' + refs.join(', '))
