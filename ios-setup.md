# iPhone setup — one Shortcut does everything

One required Shortcut (MF Sync), one optional (Update MF, for exports) and one Pushcut notification.
Both Shortcuts call your Worker with your `INGEST_SECRET` (replace `<INGEST_SECRET>` below). Your server base URL:

```
https://macrofactor-mcp.<your-subdomain>.workers.dev
```

MacroFactor's Shortcuts actions are official (see github.com/MacroFactor/apple-shortcuts); the
agent never touches the app directly — it queues entries on your Worker and **MF Sync** logs them.

---

## Shortcut 1 — "MF Sync" (the only required Shortcut)

One Shortcut does everything, in this order: **log what the agent queued → report today's totals →
report the recent-foods list.** Every trigger (notification tap, app open/close, nightly automation, Siri,
the agent's `refresh_from_phone`) runs the same thing, so the server is always current.

```
agent → log_food / log_foods_batch → Worker queue + Pushcut push → you tap (or automation / Siri)
      → MF Sync:  GET /pending-all → Log by JSON ×N
                  Macros Remaining → POST /sync-ack   (ack + today's totals, micros, targets)
                  Find Recent Food → POST /foods-seen (food log + saved-foods library)
```

**Build it (Shortcuts app):** name it exactly `MF Sync`.

*Part 1 — log the queue*

1. **Get Contents of URL** — type the URL literally, method **GET**:
   `https://macrofactor-mcp.<your-subdomain>.workers.dev/pending-all?token=<INGEST_SECRET>`
2. **Get Dictionary from Input** ← Contents of URL.
3. **Get Dictionary Value** → key `claim`.
4. **Get Dictionary Value** → key `foods` (from the step-2 dictionary).
5. **Repeat with Each** ← the `foods` value → inside: **Log by JSON** (MacroFactor) ← **Repeat Item**. End Repeat.
   *(Only if you set `ENABLE_WATER_WEIGHT` to "true": repeat the same for keys `water` → **Log Water** (mL)
   and `weight` → **Log Weight** (kg).)*

*Part 2 — today's totals (and the ack)*

6. **Macros Remaining** (MacroFactor) — returns the full Today Summary JSON.
7. **Get Contents of URL** — method **POST**, URL
   `https://macrofactor-mcp.<your-subdomain>.workers.dev/sync-ack?token=<INGEST_SECRET>`
   Headers: `claim` = the step-3 **Dictionary Value**. Request Body: tap **JSON** → switch to **File** ← the
   **Macros Remaining** result.
   This deletes the claimed queue rows, stores today's live totals with every nutrient, fills the day's
   `days` / `micronutrients` rows and derives the day's targets from "remaining to goal".

*Part 3 — recent foods*

8. **Find Recent Food** — no filter. (If the list is huge and slow: Sort by Time Last Consumed, Latest
   First, Limit a few hundred.)
9. **Repeat with Each** ← Recent Food → inside, one **Text** action with the Repeat Item's properties
   separated by `|`, in exactly this order (tap the variable → pick the property):

```
[Name]|[Brand]|[Time Last Consumed]|[Consumption Count]|[Energy]|[Protein (g)]|[Carbs (g)]|[Fat (g)]|[Hours Consumed (24 hr)]
```

   Tap the inserted **Time Last Consumed** and set Date Format → **ISO 8601** (with time). End Repeat.
10. **Combine Text** ← Repeat Results, with **New Lines**.
11. **Get Contents of URL** — method **POST**, Request Body **File** ← Combined Text:
    `https://macrofactor-mcp.<your-subdomain>.workers.dev/foods-seen?token=<INGEST_SECRET>`
    Add `&dry_run=1` plus a **Show Notification** ← Contents of URL the first time to check the parse
    (`shape`, `sample`, `other_days_skipped`, `library_upserted`), then remove it.

Foods last eaten today become today's food-log rows (one per food, at Time Last Consumed); every food in
the list is upserted into the saved-foods library (source `recent`, macros of the portion last logged).

> **Gotchas:** never rename Shortcut variables and never set a variable's Type to **URL**. Type URLs
> directly into the action. Repeat loops over an empty list are simply skipped.

**Triggers**

- **Pushcut** (free tier): Notifications → + → `MacroFactor`, action **Run Shortcut → MF Sync**; copy the
  webhook URL → `npx wrangler secret put PUSHCUT_WEBHOOK_URL`. The agent fires it for logs and for
  `refresh_from_phone`.
- **Automations** (Shortcuts → Automation → +, all **Run Immediately**): App → MacroFactor → *Is Opened* and
  *Is Closed* → MF Sync; Time of Day → **11:50 PM** → MF Sync (the nightly backstop; 11:50 keeps "today"
  on the right date).
- "Hey Siri, MF Sync".

## Shortcut 2 — "Update MF" (optional: refresh history from your phone)

Sends a MacroFactor export straight to the server for parsing — the **.xlsx workbook** (daily
totals, micros, saved foods, targets, training aggregates), the **Food Log .csv**, or the
**Workout Log .csv**. The server auto-detects the file type, so one Shortcut handles all three.

1. New Shortcut, name **Update MF**.
2. Shortcut settings (ⓘ) → enable **Show in Share Sheet** → Accept Types: **Files**.
3. **Get Contents of URL**:
   - URL: `https://macrofactor-mcp.<your-subdomain>.workers.dev/upload-export`
   - Method **POST**
   - Headers: `x-ingest-secret` = `<INGEST_SECRET>`
   - Request Body: **File** → **Shortcut Input**
4. *(Optional)* **Show Notification** ← Contents of URL (`{"ok":true,"days":…}`).

**Use it:** MacroFactor → **More → Data Management → Data Export** → share sheet → **Update MF**.
Repeat for each export you want refreshed. From a computer, `npm run ingest -- file.xlsx` does the same.

---

## What still needs an export

MacroFactor's expenditure (TDEE) and its trend weight (raw weight and body measurements are in Apple
Health), plus workouts/training aggregates if you use MacroFactor Workouts. Nothing else needs Update MF.

## Optional — "MF Today" (refresh today without logging)

MF Sync already refreshes today's totals every time it logs something. If you also want a manual
refresh (e.g. after logging in the app by hand), build a Shortcut with four **Get Nutrition State**
actions (Calories / Protein / Carbs / Fat, Calculation **Consumed**), a **Format Date** (`yyyy-MM-dd`),
and **Get Contents of URL** POST to
`https://…/today?date=[FormattedDate]&energy=[Calories]&protein=[Protein]&carbs=[Carbs]&fat=[Fat]`
with header `x-ingest-secret`. Or simply run MF Sync with an empty queue — it posts the Today
Summary returned by MacroFactor either way once you include the body in step 14.

---

## Optional — "New PR" notification

The server checks your workout log for new all-time PRs on every export upload (and daily via cron).
Create a second Pushcut notification `NewPR` (no action needed), copy its webhook, and
`npx wrangler secret put PUSHCUT_PR_WEBHOOK_URL`. Ask the agent `get_pr_alerts` for details.

---

## Legacy endpoints

`/pending`, `/pending-water`, `/pending-weight`, `/pending-batch` and `/ack-batch` from the upstream
project still work if you already built its per-type Shortcuts, but MF Sync replaces all of them.
