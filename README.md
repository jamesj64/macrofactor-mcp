# MacroFactor MCP

A personal [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI agent
(Claude, ChatGPT, Codex, Cursor, …) **search food macros, read your MacroFactor data, and log food,
water and weight back into MacroFactor** — including requests like *"add a Jersey Mike's giant turkey
sub, no toppings"*, where the agent works out the numbers and logs the result.

Fork of [chaotix345/macrofactor-mcp](https://github.com/chaotix345/macrofactor-mcp) (MIT). This fork adds
external food search (USDA + Open Food Facts), the full official `Log by JSON` schema, one consolidated
iPhone Shortcut, live today-totals from every sync, and OpenAI-connector compatibility.

MacroFactor has no public API and its private Firestore API has been App Check–locked since May 2026,
so this uses only **official** mechanisms:

- **Reads** come from MacroFactor's built-in **Data Export** (`.xlsx` + `.csv`), parsed on the server,
  plus a **live today feed** that every sync refreshes.
- **Writes** go through MacroFactor's official **Apple Shortcuts** actions (`Log by JSON`, `Log Water`,
  `Log Weight`) on your iPhone. The agent queues entries; you tap one notification (or ask Siri) and the
  **MF Sync** Shortcut logs everything queued.

## Architecture

```
   Claude.ai / Claude mobile / Claude Code / ChatGPT / Codex
        │  remote MCP (Streamable HTTP)  https://macrofactor-mcp.<you>.workers.dev/mcp/<MCP_TOKEN>
        ▼
   Cloudflare Worker (McpAgent Durable Object) + D1
     ├─ reads    D1 tables from your export  +  today_summary (live)
     ├─ search   your saved foods  +  USDA FoodData Central  +  Open Food Facts
     └─ writes   queue rows in D1 ──▶ Pushcut push ──▶ iPhone
                                                      │ tap / Siri / automation
                        iPhone Shortcut "MF Sync": GET /pending-all
                          → Log by JSON ×N, Log Water ×N, Log Weight ×N
                          → POST /sync-ack (+ MacroFactor's Today Summary)
```

## How a request flows

*"add jersey mike giant turkey sub no toppings"*

1. The agent checks your own foods first (`search_my_foods` — everything you've eaten, from the phone
   feed). No match, so it web-searches Jersey Mike's **official** nutrition calculator, reads the Giant
   #7 build (bread, turkey, provolone) and drops the Mike's Way toppings using the published component
   values. Official figures beat third-party calculators and guesses; it says which it used.
2. It calls `log_food` with an exact name, brand, icon, serving (`{amount:1, label:"giant sub", weight:…}`),
   the nutrients, `notes` (source URL + breakdown) and `llm_prompt` (your words). Generic and packaged
   foods go through `search_food` / `get_food_nutrients` (USDA + Open Food Facts) instead.
3. The Worker validates the payload against MacroFactor's official schema, queues it, and pings your
   phone. You tap → MF Sync logs it → MacroFactor's returned today summary lands on the server.
4. `get_today` now shows the entry in your live totals; `get_pending_logs` shows `landed:true`.

The server ships MCP *instructions* with this playbook, so any client that supports them (Claude, ChatGPT,
Codex) follows it without extra prompting. Reads and writes are separate on purpose: the agent can request a
refresh (`refresh_from_phone` → "MacroFactor Refresh" notification → MF Nightly) but never a write.

## Tools (42, plus 2 optional)

**Food search**

| Tool | What it does |
|------|--------------|
| `search_food` | Name search across your saved foods + USDA FoodData Central + Open Food Facts; per‑100 g and per‑serving macros, ids for `get_food_nutrients` |
| `get_food_nutrients` | Full MacroFactor nutrient dictionary for a hit, scaled to grams / servings / a named portion, plus a ready `log_food_args` object |
| `lookup_barcode` | UPC/EAN → product with label nutrients (Open Food Facts, then USDA Branded) |
| `search_my_foods` | Your Favorites / Custom Foods / history from the export |
| `search`, `fetch` | Connector‑style wrappers of the above with the result shapes ChatGPT expects |

**Logging** (all land at the current time via MF Sync)

| Tool | What it does |
|------|--------------|
| `log_food` | One entry — flat macros or a full `nutrients` dict, `serving`, `icon`, `brand`, `barcode`, `notes`, `llm_prompt`, optional `recipe[]` breakdown, `intended_time` |
| `log_foods_batch` | Up to 30 separate entries in one tap |
| `log_recipe` | One entry whose nutrients are the sum of its `ingredients[]` (shown as components in the app) |
| `log_saved_food` | A saved Favorite/Custom food by name × servings |
| `relog_meal` | Re‑log a past day's meal (optional hour window) as one entry |
| `log_water`, `log_weight` | Via MacroFactor's dedicated actions — off by default (`ENABLE_WATER_WEIGHT`), since weight usually arrives via Apple Health |
| `get_pending_logs`, `cancel_pending_log` | See what's queued or claimed by the phone; "never mind" |
| `refresh_from_phone` | Ping the phone's read-only "MacroFactor Refresh" notification → MF Nightly re-posts today's totals, recent foods and the saved-foods library (never logs) |

**Reads & analytics** (from the upstream project, unchanged)

`get_today` (live), `get_daily_nutrition`, `get_micronutrients`, `get_food_log`, `get_weight_history`,
`get_expenditure`, `get_steps`, `data_status`, `get_day`, `get_targets`, `get_goal_history`,
`get_adherence`, `weekly_summary`, `weekly_review`, `get_training_volume`, `get_exercise_progress`,
`get_workouts`, `get_prs`, `get_body_metrics`, `get_program`, `forecast_weight`,
`reconcile_energy_balance`, `day_of_week_patterns`, `get_nutrient_timing`, `detect_stall`,
`micro_gap_analysis`, `get_training_day_nutrition`, `get_pr_alerts`.

## Prerequisites

- Node.js ≥ 22 and a Cloudflare account (the Workers free plan is enough; paid works too).
- The MacroFactor iOS app, the Shortcuts app, and (optional) [Pushcut](https://www.pushcut.io) —
  its free tier covers the one notification this needs.
- Optional: a free [USDA FoodData Central API key](https://fdc.nal.usda.gov/api-key-signup)
  (without it the shared `DEMO_KEY` allows ~30 requests/hour).

## Setup

### 1. Install + log in
```bash
npm install
npx wrangler login
```

### 2. Create the database
```bash
npx wrangler d1 create macrofactor
```
Paste the printed `database_id` into `wrangler.jsonc`, then create the tables:
```bash
npm run db:init
```
Set `USER_TZ` in `wrangler.jsonc` to your IANA timezone (it decides what "today" means).

### 3. Secrets
```bash
npx wrangler secret put INGEST_SECRET     # openssl rand -hex 32 — used by your phone/PC endpoints
npx wrangler secret put MCP_TOKEN         # openssl rand -hex 32 — makes the MCP URL unguessable
npx wrangler secret put USDA_API_KEY      # optional but recommended
npx wrangler secret put PUSHCUT_WEBHOOK_URL           # "MacroFactor" notification → MF Sync (writes)
npx wrangler secret put PUSHCUT_REFRESH_WEBHOOK_URL   # "MacroFactor Refresh" notification → MF Nightly (reads)
```

### 4. Deploy
```bash
npm run deploy
```
Note the URL it prints, e.g. `https://macrofactor-mcp.<you>.workers.dev`. `GET /health` should return `{"ok":true,…}`.

### 5. iPhone Shortcut
Follow **[ios-setup.md](./ios-setup.md)** — "MF Sync" (writes) and "MF Nightly" (reads), each with its own Pushcut notification.

### 6. (Optional) Load an export
Only MacroFactor's expenditure (TDEE), trend weight and workout data need an export; everything else comes
from the MF Nightly Shortcut. If you want those: MacroFactor → **More → Data Management → Data Export**,
then share the files to the "Update MF" Shortcut (ios-setup.md) or, from a computer:
```bash
cp ingest.config.example.json ingest.config.json   # fill in workerUrl + ingestSecret
npm run ingest -- path/to/workbook.xlsx path/to/foodlog.csv path/to/workoutlog.csv
```

### 7. Connect an agent

The connector URL is `https://macrofactor-mcp.<you>.workers.dev/mcp/<MCP_TOKEN>` — treat it as a secret.

- **Claude.ai / Claude mobile:** Settings → Connectors → *Add custom connector* → paste the URL, Authentication: **None**.
- **Claude Code:** `claude mcp add --transport http macrofactor "https://macrofactor-mcp.<you>.workers.dev/mcp/<MCP_TOKEN>"`
- **Claude Desktop:** Settings → Connectors → *Add custom connector* (same URL).
- **ChatGPT:** Settings → Connectors → *Create* (needs Developer Mode on Pro/Team/Enterprise) → URL, Authentication **None**.
  The `search` / `fetch` tools satisfy ChatGPT's connector requirements; in Developer Mode all tools are available.
- **OpenAI API (Responses):** `tools: [{ type: "mcp", server_label: "macrofactor", server_url: "https://…/mcp/<MCP_TOKEN>", require_approval: "never" }]`
- **Codex CLI:** `codex mcp add macrofactor --url "https://…/mcp/<MCP_TOKEN>"`
- **Cursor / Windsurf / anything with Streamable HTTP MCP:** same URL.

## Local development

```bash
cp .dev.vars.example .dev.vars   # INGEST_SECRET / MCP_TOKEN for local dev
npm run db:init:local
npm run dev                      # http://localhost:8787
node scripts/local-e2e.mjs       # search → nutrients → log → claim → ack, no phone needed
npm test                         # schema tests against MacroFactor's official sample payloads
```

## Endpoints

| Path | Who calls it | Purpose |
|---|---|---|
| `/mcp/<MCP_TOKEN>` | the agent | MCP (Streamable HTTP) |
| `GET /pending-all?token=` | MF Sync | claim everything queued: `{claim, count, foods[], water[], weight[]}` |
| `POST /sync-ack?token=` (+ `claim` header) | MF Sync | delete the claimed rows; body = Today Summary (Macros Remaining) → live today, day rows, targets |
| `POST /upload-export` | Update MF / `npm run ingest` | parse an export into D1 |
| `POST /today` | MF Nightly | a Today Summary body (Macros Remaining) or nutrient query params for a date; gap-fills `days` + `micronutrients` + targets |
| `POST /foods-seen` | MF Nightly | MacroFactor's Find Recent Food list → today's `food_log` rows (tagged `shortcut`) + saved-foods library (`recent`) |
| `GET /health` | you | D1 check |
| `/pending`, `/pending-water`, `/pending-weight`, `/pending-batch`, `/ack-batch`, `/cancel-pending` | legacy Shortcuts | per‑type queues from upstream |

## Risk

- **Export → reads:** your own data via a feature built for it.
- **Shortcuts → writes:** MacroFactor publishes the Shortcuts actions and their JSON schema; the write
  path always requires the Shortcut to run on your phone. Every payload carries a stable `source`
  identifier (`MF_SOURCE` in `wrangler.jsonc`) as MacroFactor asks.
- No private API. Optional: email `support@macrofactor.com` to confirm automation use in writing.

## Apple Health

MacroFactor syncs daily calories, macros, body weight and measurements to Apple Health. The server tells
agents (in its MCP instructions and in `data_status`) that an Apple Health tool in the client, when
available, is the place for raw weight and body measurements. This server stays the source for totals,
targets, foods and all logging.

## Known limits

- Entries land at **sync time** — MacroFactor's actions have no date field. Pass `intended_time`
  to any food-write tool; the server matches it against the food log on the next feed or export.
- The food log from the phone feed is per distinct food (MacroFactor's "recent foods" list): a food eaten
  twice in a day shows once. Day totals come from the today summary, so they are exact.
- Only MacroFactor's expenditure (TDEE) and trend weight need an export; raw weight and measurements are
  in Apple Health. Water/weight logging is off unless `ENABLE_WATER_WEIGHT` is "true".
- USDA and Open Food Facts don't have chain-restaurant menus; the agent is instructed to use the chain's
  official nutrition calculator/PDF via web search and to cite it in `notes`.
- Weights are stored in kg (MacroFactor exports normalise to kg even if the app shows pounds).

## Make it yours

- `USER_TZ`, `MF_SOURCE` — `wrangler.jsonc` vars.
- Bottleneck KPI (`squatBottleneck()` in `src/db/prs.ts`) and micronutrient RDAs (`MICRO_RDA` in
  `src/db/analytics.ts`) — inherited from upstream; adjust for your lifts / demographic.
- Icon guesses for foods without an explicit icon: `ICON_GUESSES` in `src/nutrients.ts`.

## License

MIT — see [LICENSE](./LICENSE). Upstream © chaotix345; fork changes © jamesj64.
