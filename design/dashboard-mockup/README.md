# Bot Dashboard design mockup

A standalone mockup of the Bot Dashboard pages in a new look. It is **not** the shipped app: it does not talk to the bots, uses sample data (`src/data.ts`), and nothing in `app/` or `dashboard/` was changed.

Pages: Dashboard, Progress (roadmap, builds, per-day numbers), Inventory (with Items acquired), Claude reviews, Settings.

Design choices
- shadcn/ui components (the same set the dashboard already uses), Tailwind v4, Radix, Lucide.
- MUI-style rhythm: 8px spacing (`p-2/4/6`, 24px grid gutters and card padding), 64px app bar, 256px drawer, grouped navigation with an active-item highlight.
- Palette: ink-navy chrome, indigo primary, emerald / amber / rose / sky for status, light and dark themes (toggle in the app bar). Tokens are in `src/index.css`.
- Inter for text, JetBrains Mono for coordinates and ids.

Run it
```
npm install
npm run build
node serve.mjs 8472      # http://localhost:8472  (or start-mockup.bat)
```
`npm run dev` serves with hot reload on 8472 too. Port 8472 avoids the dashboard's 8765 and the Minecraft LAN port.
