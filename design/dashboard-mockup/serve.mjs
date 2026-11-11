// Static server for the built mockup (dist/) plus a read-only data layer.
//   node serve.mjs [port]
// /api, /img and /tex are GET-proxied to the real Bot Dashboard (DASHBOARD_URL, default http://localhost:8765)
// so the mockup shows live bot data. If that server is not running, the same routes answer from fixtures/
// (a local, git-ignored snapshot of real responses; run `node snapshot.mjs` while the dashboard is up to refresh).
import { createServer, request as httpRequest } from "node:http"
import { readFile } from "node:fs/promises"
import { extname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"

const here = fileURLToPath(new URL(".", import.meta.url))
const root = join(here, "dist")
const fixtures = join(here, "fixtures")
const port = Number(process.argv[2] || process.env.PORT || 8472)
const upstream = new URL(process.env.DASHBOARD_URL || "http://localhost:8765")
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".png": "image/png" }

const fixture = async (name) => readFile(join(fixtures, name))
const json = (res, body) => res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(body)

// Map an API path to a fixture file name, or null.
function fixtureFor(path, query) {
  let m
  if (path === "/api/progress") return "progress.json"
  if (path === "/api/acquired") return `acquired-${query.get("window") || "8h"}.json`
  if ((m = path.match(/^\/api\/behavior\/(\w+)$/))) return `behavior-${m[1]}.json`
  if ((m = path.match(/^\/api\/clips\/(\w+)$/))) return `clips-${m[1]}.json`
  if ((m = path.match(/^\/api\/clip\/(\w+)\//))) return `clip-${m[1]}.json`
  if ((m = path.match(/^\/api\/structure\/(\w+)$/))) return `structure-${m[1]}.json`
  if ((m = path.match(/^\/api\/history\/(\w+)\/(\w+)$/))) return `history-${m[1]}-${m[2]}.json`
  return null
}

function proxy(req, res, onFail) {
  const p = httpRequest({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: "GET", headers: { accept: req.headers.accept || "*/*" }, timeout: 4000 }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers)
    up.pipe(res)
    res.on("close", () => up.destroy())
  })
  p.on("timeout", () => p.destroy(new Error("timeout")))
  p.on("error", () => { if (!res.headersSent) onFail(); else res.end() })
  p.end()
}

async function fallbackApi(path, query, res) {
  if (path === "/api/stream") {
    // The recorded first SSE event (init), then keep-alive pings so the page stays "live".
    let init = ""
    try { init = (await fixture("stream-init.txt")).toString() } catch { /* none */ }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" })
    res.write(init.endsWith("\n\n") ? init : init + "\n\n")
    const t = setInterval(() => res.write("event: ping\ndata: 1\n\n"), 15000)
    res.on("close", () => clearInterval(t))
    return
  }
  const name = fixtureFor(path, query)
  if (name) { try { return json(res, await fixture(name)) } catch { /* fall through */ } }
  res.writeHead(404, { "content-type": "application/json" }).end("{}")
}

createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return }
  const url = new URL(req.url, "http://x")
  const path = url.pathname
  if (path.startsWith("/api/") || path.startsWith("/img/") || path.startsWith("/tex/")) {
    return proxy(req, res, () => (path.startsWith("/api/") ? fallbackApi(path, url.searchParams, res) : res.writeHead(404).end()))
  }
  const rel = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, "")
  if (rel.includes("..")) { res.writeHead(400).end(); return }
  try {
    const file = join(root, rel || "index.html")
    const body = await readFile(file)
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }).end(body)
  } catch {
    try { res.writeHead(200, { "content-type": types[".html"] }).end(await readFile(join(root, "index.html"))) } catch { res.writeHead(404).end("not built: run npm run build") }
  }
}).listen(port, "127.0.0.1", () => console.log(`Bot Dashboard mockup on http://localhost:${port} (data: ${upstream.origin}, fixtures as fallback)`))
