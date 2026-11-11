// Tiny static server for the built mockup (dist/). Usage: node serve.mjs [port]
import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { extname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(fileURLToPath(new URL(".", import.meta.url)), "dist")
const port = Number(process.argv[2] || process.env.PORT || 8472)
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".png": "image/png" }

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x")
  let p = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "")
  if (p.includes("..")) { res.writeHead(400).end(); return }
  try {
    const file = join(root, p || "index.html")
    const body = await readFile(file)
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }).end(body)
  } catch {
    try { res.writeHead(200, { "content-type": types[".html"] }).end(await readFile(join(root, "index.html"))) } catch { res.writeHead(404).end("not built: run npm run build") }
  }
}).listen(port, "127.0.0.1", () => console.log(`Bot Dashboard mockup on http://localhost:${port}`))
