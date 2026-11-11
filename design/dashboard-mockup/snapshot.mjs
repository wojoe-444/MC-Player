// Refresh fixtures/ (git-ignored) from the running Bot Dashboard so the mockup still has data when it is down.
// Usage: node snapshot.mjs [http://localhost:8765]
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const base = process.argv[2] || "http://localhost:8765"
const dir = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures")
await mkdir(dir, { recursive: true })
const get = async (path) => (await fetch(base + path)).text()
const save = async (name, path) => { await writeFile(join(dir, name), await get(path)); console.log("saved", name) }

await save("progress.json", "/api/progress")
for (const w of ["1h", "8h", "24h", "7d", "all"]) await save(`acquired-${w}.json`, `/api/acquired?window=${w}`)
for (const b of ["ozo", "smeo"]) {
  await save(`behavior-${b}.json`, `/api/behavior/${b}`)
  await save(`clips-${b}.json`, `/api/clips/${b}`)
  await save(`structure-${b}.json`, `/api/structure/${b}`)
  for (const k of ["pov", "top"]) await save(`history-${b}-${k}.json`, `/api/history/${b}/${k}`)
  const clips = JSON.parse(await get(`/api/clips/${b}`))
  if (clips[0]) await save(`clip-${b}.json`, `/api/clip/${b}/${clips[0].name}`)
}
// first SSE event (init) = snapshot + recent logs
const ctl = new AbortController()
const res = await fetch(base + "/api/stream", { signal: ctl.signal })
let buf = ""
for await (const chunk of res.body) { buf += Buffer.from(chunk).toString(); if (buf.includes("\n\n")) break }
ctl.abort()
await writeFile(join(dir, "stream-init.txt"), buf.split("\n\n")[0] + "\n\n")
console.log("saved stream-init.txt")
