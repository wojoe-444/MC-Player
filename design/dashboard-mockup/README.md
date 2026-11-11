# Bot Dashboard design mockup

A redesign of the Bot Dashboard and the app's Claude reviews and Settings pages. It reuses the shipped panels (live view, inventory and items acquired, replay, behavior, structure, memory, logs, progress) unchanged in behavior and re-composes them in a new layout. Nothing in `app/` or `dashboard/` is modified.

## Where the pages went
| Shipped | Mockup |
|---|---|
| Overview | Dashboard (new KPI row from `/api/progress`, both bot cards) |
| Progress, Logs, Memory and data | Same pages; Progress and Memory follow the bot picker in the top bar |
| Per-bot Live, Inventory (with Items acquired), Replay, Behavior, Structure | Sidebar group "Selected bot"; one bot picker in the top bar replaces the two repeated sidebar groups |
| App tab "Claude reviews" | Automation > Claude reviews (behavior reviewer, per-bot findings, triggers, recent reviews) |
| App tab "Settings" (updates, dot when an update is available) | System > Settings; the dot moved to the sidebar item |

Claude reviews and Settings talk to the Electron main process in the real app. The mockup has no main process, so `src/sim.tsx` simulates their state and actions (Review now, Run now, check and install update) with sample data.

## Data
`serve.mjs` GET-proxies `/api`, `/img` and `/tex` to the running dashboard (`DASHBOARD_URL`, default `http://localhost:8765`), so the pages show live bot data and real item textures. If the dashboard is down it answers from `fixtures/` (a local, git-ignored snapshot; refresh with `node snapshot.mjs` while the dashboard is up). Nothing is ever written back.

## Design
- shadcn/ui components (same set as the dashboard), Tailwind v4, Radix, Lucide.
- MUI-style rhythm: 8px spacing (24px card padding and grid gutters), 64px app bar, 256px drawer, grouped navigation with an active highlight.
- Palette: 28 switchable color schemes (12 + 12 + 4 true-neutral ones, every pair checked against WCAG AA) (picker in the app bar and an Appearance card in Settings), each in light and dark; the default is Indigo Ink (ink-navy chrome, indigo primary). Palettes are defined in `src/theme.ts` as a few parameters and expanded into the full token set, so adding one is one line. Status colors keep the same hues in every scheme.
- Inter for text, JetBrains Mono for coordinates and ids.

## Run
```
npm install
npm run build
node serve.mjs 8472      # http://localhost:8472  (or start-mockup.bat)
```
Port 8472 avoids the dashboard's 8765 and the Minecraft LAN port.
