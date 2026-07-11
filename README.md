# MacroFactor MCP

A personal [Model Context Protocol](https://modelcontextprotocol.io) server that lets
**Claude.ai** read your MacroFactor nutrition data and log food back into MacroFactor.

MacroFactor has no public API, so this uses only **official** mechanisms:

- **Reads** come from MacroFactor's built‑in **Data Export** (`.xlsx`), parsed locally and
  uploaded to the server.
- **Writes** (logging food) go through MacroFactor's official **Apple Shortcuts**
  `Log by JSON` action on your iPhone, triggered via a notification you tap to confirm.

No reverse‑engineering, no private API — so no meaningful ToS/ban risk (see "Risk").

## Architecture

```
        reads                                   writes
  ┌──────────────┐   export.xlsx   ┌─────────────────────┐   /mcp    ┌──────────┐
  │ MacroFactor  │ ──────────────▶ │ scripts/ingest.mjs  │           │ Claude.ai│
  │   app (iOS)  │   (manual)      │ (local parse+upload)│           │   web    │
  └──────────────┘                 └──────────┬──────────┘           └────┬─────┘
        ▲                                      │ /ingest                   │ tool calls
        │ Log by JSON (tap)                    ▼                           ▼
  ┌─────┴────────┐   push    ┌────────────────────────────────────────────────┐
  │ iPhone       │ ◀──────── │  Cloudflare Worker (this repo)                   │
  │ Shortcut     │  Pushcut  │  • /mcp   authless MCP (read & log tools)        │
  └──────────────┘           │  • /upload-export  parses an export, refreshes D1│
                             │  • /today  live today feed from the phone        │
                             │  • /pending(-water) queues for iPhone Shortcut   │
                             └────────────────────────────────────────────────┘
```

## Tools exposed to Claude

| Tool | What it does |
|------|--------------|
| `get_daily_nutrition` | Daily calories / protein / carbs / fat / expenditure / weight / steps |
| `get_micronutrients` | Daily micros — fiber, sugars, sodium, vitamins, minerals, amino acids |
| `get_food_log` | Individual foods you ate, with time + macros (meal‑by‑meal); includes `alcohol` field, `suspect` flag for entries that may be inaccurate, and optional `detail` parameter for extended nutrient columns |
| `get_weight_history` | Scale weight (kg and lbs), trend weight, body‑fat % |
| `get_expenditure` | MacroFactor's calculated TDEE vs intake |
| `get_steps` | Daily step count |
| `search_my_foods` | Your Favorites / Custom Foods / history, with per‑serving macros |
| `data_status` | How fresh the loaded data is (incl. the live "today" feed) |
| `get_today` | Today's running totals **live from your phone** (no export needed) — consumed, micros, targets, what's left, freshness |
| `get_targets` | Calorie/macro targets for a date (resolves weekday cycling) + weight‑goal progress; `week:true` returns all 7 weekday rows of the governing program |
| `get_goal_history` | Every weight goal ever set, with planned (rate, ETA) vs actual (trend change, duration, realized rate) per goal |
| `get_adherence` | Per‑day intake vs target — hit‑rate, surplus/deficit, avg carb/fat gap vs target, true energy balance, est. kg change |
| `weekly_summary` | ONE digest over rolling 7/14/28‑day windows — avg calories/macros, adherence (incl. carb/fat gap), trend‑weight rate, TDEE drift, training volume, recent PRs |
| `weekly_review` | The whole weekly check-in in one call: `weekly_summary` + `get_pr_alerts` + `day_of_week_patterns`, sharing one end date |
| `get_training_volume` | Working sets + tonnage per muscle group over a range |
| `get_exercise_progress` | MacroFactor's per‑exercise metrics over time (1RM/3RM/10RM, heaviest, volume, reps, sets) |
| `get_workouts` | Logged sessions with per‑exercise sets (weight × reps × RIR), duration, top set; timed/distance/assisted sets carry duration/distance/base-weight fields |
| `get_prs` | Personal records per exercise — estimated 1RM (Epley), heaviest weight, best‑set volume; duration/distance bests for timed exercises |
| `get_body_metrics` | Body measurements (cm) + visual body‑fat assessment over time |
| `get_program` | Your **planned** training program — cycles, workouts, each exercise's planned sets (type, rep range, RIR, rest) + rest days |
| `forecast_weight` | When you'll hit goal weight — OLS trend regression **and** a calorie-math ETA; their divergence flags TDEE miscalibration. Optional `target_date` → required daily deficit |
| `reconcile_energy_balance` | Your **implied** maintenance calories (from weight delta + intake) vs MacroFactor's TDEE — catches under/over-logging |
| `day_of_week_patterns` | Per-weekday averages + each weekday's share of your weekly surplus — pinpoints the single highest-leverage day |
| `get_nutrient_timing` | Food log bucketed by time of day (fasted/morning/midday/afternoon/evening/late) — reveals protein distribution |
| `detect_stall` | Plateau vs **metabolic adaptation** vs intake-drift classifier with an adaptation_kcal estimate |
| `micro_gap_analysis` | 28-day micronutrient averages vs NIH RDAs → ranked deficiency list (real export columns) |
| `get_training_day_nutrition` | Nutrition grouped by training-load tier (rest/light/moderate/heavy) — do you eat more on heavy days? |
| `get_pr_alerts` | Lifts that hit a new all-time PR (e1RM / heaviest / best-set volume / duration / distance), detected automatically on each export; includes the live front-squat:back-squat e1RM ratio (`bottleneck_kpi`) |
| `log_food` | Send a food to your phone to log in MacroFactor — optional `intended_time` records when you ate it and matches against the Food Log CSV on the next export import |
| `log_saved_food` | Log one of your saved Favorites/Custom foods by name × servings — scales the food's stored macros; disambiguates when the name matches more than one; accepts `intended_time` |
| `log_water` | Log water (mL) via MacroFactor's dedicated **Log Water** action on your phone |
| `log_weight` | Log a body weight (kg or lbs) via MacroFactor's dedicated **Log Weight** action on your phone |
| `log_recipe` | Log a named multi-ingredient meal — sums macros, attaches a `recipe[]` breakdown (reuses the food push); accepts `intended_time` |
| `relog_meal` | Re-log a past day's meal (optional hour window) as one entry — "log yesterday's lunch" in one tap; accepts `intended_time` |
| `log_foods_batch` | Log up to 20 foods in a **single** phone tap — ideal for a full meal or photo-estimated intake; each item accepts `intended_time` |
| `cancel_pending_log` | Delete queued-but-not-yet-tapped food/water/weight/batch logs ("never mind") |
| `get_day` | Full picture of a single day — nutrition totals, food log entries, body weight, and workout in one call |
| `get_pending_logs` | Queued (not-yet-tapped) food dispatches and recent dispatch history with `landed` status — see whether Claude's log reached MacroFactor |

**Proactive:** when you upload an export (and once daily via cron), the server checks your lift
log for new personal records and fires a Pushcut **"New PR"** push (set `PUSHCUT_PR_WEBHOOK_URL`);
tap it and ask Claude `get_pr_alerts` for specifics.

**Write-path audit log:** every food dispatch is recorded in `food_dispatch_log` (queued, landed, or cancelled); optional `intended_time` on all five food-write tools is stored in `food_intent_log` and matched against the Food Log CSV on the next export import. When Shortcut 2 runs after a tap, it POSTs `?ack_id=N` to `/today`, which simultaneously marks the dispatch **landed** in the audit log and refreshes live today data.

> **Three exports**, all sent to the same `/upload-export` endpoint (auto‑detected by content):
> the **.xlsx workbook** (daily totals, all micronutrients, saved‑food library, **nutrition
> targets + weight goals**, **body measurements + visual body‑fat**, your **planned training
> program**, and MacroFactor's **per‑muscle / per‑exercise training aggregates**); the **Food
> Log .csv** (every item you ate, with time + macros); and the
> **Workout Log .csv** (every set: weight, reps, RIR). Upload any subset — each refreshes only
> its own tables.
>
> **Strength numbers:** `get_prs` and `get_workouts` report the **barbell load** from your
> logged sets. `get_exercise_progress` and `get_training_volume` mirror **MacroFactor's own
> figures**, which (a) **include bodyweight contribution** for compound lifts — so a 100 kg
> front squat can show as ~160 kg — and (b) for per-muscle volume, **credit each exercise to every
> muscle it trains**, so per-muscle tonnage overlaps and sums to more than the session's bar
> tonnage. All correct; they just measure different things (bar load vs. training stimulus).

## Prerequisites

- **Node.js ≥ 22** (Wrangler requires it — you're warned if not). Use nvm/volta or the
  official installer.
- A free **Cloudflare** account.
- The MacroFactor iOS app (for the optional logging path).

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
Copy the printed `database_id` into `wrangler.jsonc` (replace `REPLACE_WITH_YOUR_D1_DATABASE_ID`),
then create the tables:
```bash
npm run db:init
```

### 3. Set the secrets
```bash
npx wrangler secret put INGEST_SECRET   # pick any strong random string
npx wrangler secret put MCP_TOKEN       # recommended — protects the MCP endpoint (see step 6)
```

### 4. Deploy
```bash
npm run deploy
```
Note the URL it prints, e.g. `https://macrofactor-mcp.<you>.workers.dev`.

### 5. Load your data
1. In MacroFactor: **More → Data Management → Data Export** → run the export and get the
   `.xlsx` onto this PC (AirDrop/iCloud/email). One file is all you need.
2. `cp ingest.config.example.json ingest.config.json` and fill in your Worker URL + the
   `INGEST_SECRET` you chose.
3. Upload (pass any subset of the three exports):
   ```bash
   npm run ingest -- "C:\path\to\workbook.xlsx" "C:\path\to\foodlog.csv" "C:\path\to\workoutlog.csv"
   ```
   Re‑run any time you export fresh data (each file replaces only its own tables).

### 6. Connect to Claude.ai
Claude.ai → **Settings → Connectors → Add custom connector**:
- URL: `https://macrofactor-mcp.<you>.workers.dev/mcp/<MCP_TOKEN>`
- Authentication: **None** (the secret token in the URL *is* the auth)

If you skipped `MCP_TOKEN` the URL is plain `/mcp` — **not recommended**: without a token,
anyone who learns your Worker URL can read your nutrition/health data and queue food logs
to your phone. Treat the full connector URL as a secret either way.

Ask things like *"what was my protein this week?"* or *"how does my intake compare to my
expenditure this month?"*

### 7. (Optional) Log food via Claude
See **[ios-setup.md](./ios-setup.md)** to wire up Pushcut + the iPhone Shortcut, then:
```bash
npx wrangler secret put PUSHCUT_WEBHOOK_URL
```
`log_saved_food`, `log_recipe`, and `relog_meal` reuse this same path (no extra setup). To also
log **water** via Claude (`log_water`), add the small "MF Log Water" shortcut + its own Pushcut
notification (see ios-setup.md), then:
```bash
npx wrangler secret put PUSHCUT_WATER_WEBHOOK_URL
```
`log_weight` and `log_foods_batch` each need their own small shortcut + Pushcut notification
(see ios-setup.md), then their own webhook secret:
```bash
npx wrangler secret put PUSHCUT_WEIGHT_WEBHOOK_URL   # for log_weight
npx wrangler secret put PUSHCUT_BATCH_WEBHOOK_URL    # for log_foods_batch
```
For proactive **PR alerts**, create a Pushcut "New PR" notification and set its webhook:
```bash
npx wrangler secret put PUSHCUT_PR_WEBHOOK_URL
```

## Risk

- **Data export → reads:** clean. Your own data via a feature built for it.
- **Apple Shortcuts → writes:** low risk. MacroFactor publishes the Shortcuts integration
  and endorses LLM‑driven `Log by JSON`; the write path requires a physical tap.
- We avoid the private Firestore API (App Check–blocked since ~May 2026, and a ToS breach).
- Optional: email `support@macrofactor.com` to confirm automation use in writing.

## Known limits

- Food-write tools log at the **tap time** — MacroFactor's Log by JSON action uses the current time when the Shortcut runs. Pass `intended_time` to any food-write tool to store your intended eat-time server-side; it is matched against the Food Log CSV on the next import.
- Reads are as fresh as your last export/upload. Refresh from your phone with the
  "Update MF" Shortcut (POSTs the export to `/upload-export`) or from a PC with
  `npm run ingest` — see [ios-setup.md](./ios-setup.md).
- `get_food_log` needs the **Food Log CSV** and the training tools need the **Workout Log
  CSV**; the `.xlsx` workbook gives daily totals + micros + saved foods + targets +
  body metrics + planned training program + per‑muscle/per‑exercise training aggregates.
- `get_exercise_progress` for `1RM`/`3RM`/`10RM` only returns data once MacroFactor has
  computed those estimates (needs a few logged sessions); until then use `get_prs` or the
  `heaviest_weight` / `total_volume` metrics.
- Weights are in **kg** (MacroFactor exports normalise to kg even if your app shows pounds).

## Make it yours

Three constants encode preferences you'll want to adjust:

- **Timezone** — `USER_TZ` in `src/db/utils.ts` decides what "today" means (defaults to
  `UTC`). Set it to your IANA timezone (e.g. `America/New_York`) or post-midnight `/today`
  updates can land on the wrong day.
- **Bottleneck KPI** — `squatBottleneck()` in `src/db/prs.ts` tracks a front-squat :
  back-squat e1RM ratio surfaced by `get_pr_alerts` / `weekly_review`. Swap the exercise
  pair for your own, or ignore it — it returns `null` when either lift is absent.
- **Micronutrient RDAs** — `MICRO_RDA` in `src/db/analytics.ts` uses NIH DRI values for an
  adult male 19–50. Adjust the table for your demographic.

## License

MIT — see [LICENSE](./LICENSE).
