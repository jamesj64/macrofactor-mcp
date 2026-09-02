# iPhone setup — two Shortcuts, read and write kept apart

| Shortcut | Direction | Triggered by |
|---|---|---|
| **MF Sync** | write: logs what the agent queued into MacroFactor | Pushcut "MacroFactor" tap, Siri |
| **MF Nightly** | read: today's totals + recent foods → server | 11:50 PM automation, app open/close, Pushcut "MacroFactor Refresh" (the agent's `refresh_from_phone`), Siri |
| **Update MF** (optional) | export upload | share sheet |

The agent can *ask* for a refresh but can never make the phone log something without your tap. Both
Shortcuts call your Worker with your `INGEST_SECRET` (replace `<INGEST_SECRET>` below). Base URL:

```
https://macrofactor-mcp.<your-subdomain>.workers.dev
```

---

## Shortcut 1 — "MF Sync" (write)

```
agent → log_food / log_foods_batch → Worker queue + Pushcut "MacroFactor" → you tap
      → MF Sync: GET /pending-all → Log by JSON ×N → POST /sync-ack (+ MacroFactor's returned summary)
```

1. **Get Contents of URL** — type the URL literally, method **GET**:
   `https://macrofactor-mcp.<your-subdomain>.workers.dev/pending-all?token=<INGEST_SECRET>`
2. **Get Dictionary from Input** ← Contents of URL.
3. **Get Dictionary Value** → key `claim`.
4. **Get Dictionary Value** → key `foods` (from the step-2 dictionary).
5. **Repeat with Each** ← the `foods` value → inside: **Log by JSON** (MacroFactor) ← **Repeat Item**. End Repeat.
   *(Only if `ENABLE_WATER_WEIGHT` is "true" in wrangler.jsonc: same for `water` → **Log Water** (mL) and
   `weight` → **Log Weight** (kg).)*
6. **Get Contents of URL** — method **POST**, URL
   `https://macrofactor-mcp.<your-subdomain>.workers.dev/sync-ack?token=<INGEST_SECRET>`
   Headers: `claim` = the step-3 **Dictionary Value**. Request Body: tap **JSON** → **File** ← the **Log by
   JSON** result from step 5 (the last iteration's; it is MacroFactor's Today Summary, so the ack also
   refreshes today's totals). An empty body just clears the queue.
7. *(Optional)* **Show Notification** ← the step-6 result.

**Pushcut:** Notifications → + → name `MacroFactor`, action **Run Shortcut → MF Sync** → copy the webhook URL →
`npx wrangler secret put PUSHCUT_WEBHOOK_URL`.

> **Gotchas:** never rename Shortcut variables and never set a variable's Type to **URL**. Type URLs
> directly into the action. Repeat loops over an empty list are simply skipped.

---

## Shortcut 2 — "MF Nightly" (read)

```
MF Nightly: Macros Remaining → POST /today        (today's totals, micros, targets)
            Find Recent Food → POST /foods-seen   (today's food log + saved-foods library)
```

*Part A — today's totals*

1. **Macros Remaining** (MacroFactor action) — returns the full Today Summary JSON.
2. **Get Contents of URL** — method **POST**, header `x-ingest-secret` = `<INGEST_SECRET>`, Request Body
   **File** ← the Macros Remaining result:
   `https://macrofactor-mcp.<your-subdomain>.workers.dev/today`

*Part B — recent foods*

3. **Find Recent Food** — no filter. (If the list is huge and slow: Sort by Time Last Consumed, Latest
   First, Limit a few hundred.)
4. **Repeat with Each** ← Recent Food → inside, one **Text** action with the Repeat Item's properties
   separated by `|`, in exactly this order (tap the variable → pick the property):

```
[Name]|[Brand]|[Time Last Consumed]|[Consumption Count]|[Energy]|[Protein (g)]|[Carbs (g)]|[Fat (g)]|[Hours Consumed (24 hr)]
```

   Tap the inserted **Time Last Consumed** and set Date Format → **ISO 8601** (with time). End Repeat.
5. **Combine Text** ← Repeat Results, with **New Lines**.
6. **Get Contents of URL** — method **POST**, Request Body **File** ← Combined Text:
   `https://macrofactor-mcp.<your-subdomain>.workers.dev/foods-seen?token=<INGEST_SECRET>`
   Add `&dry_run=1` plus **Show Notification** ← Contents of URL the first time to check the parse
   (`shape`, `sample`, `other_days_skipped`, `library_upserted`), then remove both.

What the server does: `/today` stores today's live totals with every nutrient, fills the day's `days` /
`micronutrients` rows and derives targets from "remaining to goal". `/foods-seen` writes one `food_log` row
per food last eaten today (at its Time Last Consumed — Consumption Count / Hours Consumed are lifetime stats,
so a second helping of the same food shows once) and upserts *every* food into the saved-foods library
(source `recent`, macros of the portion last logged). Those rows survive export uploads.

**Pushcut:** a second notification → name `MacroFactor Refresh`, action **Run Shortcut → MF Nightly** → copy
its webhook URL → `npx wrangler secret put PUSHCUT_REFRESH_WEBHOOK_URL`. This is what the agent's
`refresh_from_phone` tool fires. (Free tier allows 3 notification definitions.)

**Automations** (Shortcuts → Automation → +, all **Run Immediately**):
- Time of Day → **11:50 PM** → MF Nightly (11:50 keeps "today" on the right date).
- App → MacroFactor → *Is Closed* → MF Nightly, so hand-logging in the app is picked up immediately.

---

## Shortcut 3 — "Update MF" (optional: exports)

Only MacroFactor's expenditure (TDEE), its trend weight, and workouts/training aggregates need an export;
raw weight and body measurements are in Apple Health. Skip this unless you want those.

1. New Shortcut **Update MF** → ⓘ → **Show in Share Sheet** → Accept Types: **Files**.
2. **Get Contents of URL** — POST, URL `https://macrofactor-mcp.<your-subdomain>.workers.dev/upload-export`,
   header `x-ingest-secret` = `<INGEST_SECRET>`, Request Body **File** → **Shortcut Input**.
3. *(Optional)* **Show Notification** ← Contents of URL.

Use: MacroFactor → **More → Data Management → Data Export** → share sheet → **Update MF** (workbook .xlsx,
Food Log .csv, Workout Log .csv — any subset). From a computer: `npm run ingest -- file.xlsx`.

---

## Optional — "New PR" notification

Pushcut notification `NewPR` (no action) → `npx wrangler secret put PUSHCUT_PR_WEBHOOK_URL`; the server fires
it when an export upload reveals a new lift PR.

## Legacy endpoints

`/pending`, `/pending-water`, `/pending-weight`, `/pending-batch`, `/ack-batch` from the upstream project
still work if you built its per-type Shortcuts; MF Sync replaces all of them.
