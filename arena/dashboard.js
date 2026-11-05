// node dashboard.js  ->  http://localhost:8765   Serves dashboard.html and live results (reads results/trials.jsonl on every request). Localhost only.
const http = require('http'), fs = require('fs'), path = require('path')
const PORT = Number(process.env.PORT) || 8765
http.createServer((req, res) => {
  const u = req.url.split('?')[0]
  try {
    if (u === '/trials.jsonl') { res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); return res.end(fs.readFileSync(path.join(__dirname, 'results', 'trials.jsonl'))) }
    if (u === '/composite.json') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(fs.readFileSync(path.join(__dirname, 'composite.json'))) }
    if (u === '/composite-h7.json') { try { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(fs.readFileSync(path.join(__dirname, 'composite-h7.json'))) } catch { res.writeHead(404); return res.end('{}') } }
    if (u === '/taxonomy.js') { res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' }); return res.end(fs.readFileSync(path.join(__dirname, 'taxonomy.js'))) }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(fs.readFileSync(path.join(__dirname, 'dashboard.html')))
  } catch (e) { res.writeHead(500); res.end(String(e)) }
}).listen(PORT, '127.0.0.1', () => console.log('arena dashboard on http://localhost:' + PORT))
