# iPhone setup — one Shortcut logs everything

Two Shortcuts (one required, one optional) and one Pushcut notification. Both Shortcuts call your
Worker with your `INGEST_SECRET` (replace `<INGEST_SECRET>` below). Your server base URL:

```
https://macrofactor-mcp.<your-subdomain>.workers.dev
```

MacroFactor's Shortcuts actions are official (see github.com/MacroFactor/apple-shortcuts); the
agent never touches the app directly — it queues entries on your Worker and **MF Sync** logs them.

---

## Shortcut 1 — "MF Sync" (required: food, water and weight logging)

```
agent → log_food / log_foods_batch / log_water / log_weight
      → Worker queue + Pushcut push → you tap (or "Hey Siri, sync MacroFactor")
      → MF Sync: GET /pending-all → Log by JSON ×N, Log Water ×N, Log Weight ×N → POST /sync-ack
```

`/pending-all` returns one dictionary: `{ claim, count, foods: [...], water: [...], weight: [...] }`.
Every item the agent queued since the last sync is logged in one run, and the last MacroFactor
result (a Today Summary with consumed + remaining-vs-goal for every nutrient) is posted back so
`get_today` is live. Nothing is deleted from the queue until the ack arrives; if the Shortcut
crashes, the items are re-served after 10 minutes.

**Build it (Shortcuts app):**

1. New Shortcut, name **MF Sync**. (Siri phrase = the name: "Hey Siri, MF Sync".)
2. **Get Contents of URL** — type the URL literally (don't build it from a variable):
   `https://macrofactor-mcp.<your-subdomain>.workers.dev/pending-all?token=<INGEST_SECRET>`
   Method **GET**.
3. **Get Dictionary from Input** ← **Contents of URL**.
4. **Get Dictionary Value** → key `claim` (call the result *Claim* by leaving its name alone; you'll insert it as a variable later).
5. **Get Dictionary Value** → key `foods` in the step-3 dictionary.
6. **Repeat with Each** ← the `foods` value:
   - **Log by JSON** (MacroFactor action) ← **Repeat Item**.
7. **End Repeat**.
8. **Get Dictionary Value** → key `water` in the step-3 dictionary.
9. **Repeat with Each** ← the `water` value:
   - **Log Water** (MacroFactor action) ← **Repeat Item**, unit **mL** (the server always sends millilitres).
10. **End Repeat**.
11. **Get Dictionary Value** → key `weight` in the step-3 dictionary.
12. **Repeat with Each** ← the `weight` value:
    - **Log Weight** (MacroFactor action) ← **Repeat Item**. The server sends **kg**. If the action
      wants your display unit (lbs), insert **Calculate** (Repeat Item × 2.20462) first.
13. **End Repeat**.
14. **Get Contents of URL**:
    - URL: `https://macrofactor-mcp.<your-subdomain>.workers.dev/sync-ack?token=<INGEST_SECRET>`
    - Method **POST**
    - Headers: add `claim` = the **Dictionary Value** from step 4 (tap the value field → Select Variable).
      (Inserting it into the URL as `&claim=…` works too; the header is just easier to wire.)
    - Request Body: tap **JSON** on the Request Body row and switch it to **File**, then set the file to the
      **Log by JSON** result from step 6 (the last one wins). Staying in JSON mode also works: add one
      **Dictionary** field with key `summary` = the Log by JSON result. If you skip the body the ack still
      clears the queue; you just won't get live today totals.
15. *(Optional)* **Show Notification** ← the step-14 result — you'll see `{"ok":true,"acked":{...},"today":{...}}`.

> **Gotchas:** never rename Shortcut variables and never set a variable's Type to **URL** (coercing a
> response to URL throws *"couldn't convert from Dictionary to URL"*). Type URLs directly into the
> action. Repeat loops over an empty list are simply skipped, so running MF Sync with nothing queued
> is harmless.

**Pushcut (free tier is enough — one notification definition):**

1. Install Pushcut → **Notifications → +** → name it `MacroFactor`, title/text e.g. "Tap to log".
2. Action: **Run Shortcut → MF Sync**.
3. Copy the notification's **Webhook URL** (`https://api.pushcut.io/<secret>/notifications/MacroFactor`).
4. On the server:
   ```bash
   npx wrangler secret put PUSHCUT_WEBHOOK_URL   # paste the webhook URL
   ```

**Hands-free options:**
- "Hey Siri, MF Sync" runs it without a notification.
- Shortcuts → **Automation → + → App → MacroFactor → Is Closed → Run Immediately → MF Sync**
  flushes anything queued whenever you close the app.
- Time-of-day automations (e.g. 1 PM / 9 PM, Run Immediately) as backstops. iOS may delay these
  when the phone is idle or in Low Power Mode.
- Without Pushcut, entries still queue; the agent tells you to run MF Sync.

---

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

## Shortcut 3 — "MF Nightly" (optional: history without exports)

Runs itself every night (Automation → Time of Day → **11:50 PM** → Run Immediately → MF Nightly) and
pushes the day's totals and the day's foods, so the export is only needed occasionally.

MacroFactor exposes two read actions: **Get Nutrition State** (one nutrient per call — Calculation
*Consumed*, *Remaining to Goal*, *Remaining to Minimum* or *Remaining to Maximum*) and **Find Recent Food**,
whose results carry Name, Brand, Time Last Consumed, Consumption Count, Hours Consumed (24 hr), and every
nutrient (Energy, Protein (g), … Zinc (mg)).

**Part A — today's totals**

1. Add one **Get Nutrition State** per nutrient, Calculation **Consumed**: Calories, Protein, Carbs, Fat,
   then any micros you care about (Fiber, Sugars, Saturated Fat, Sodium, Potassium, Calcium, Iron,
   Magnesium, Vitamin D, Water, Alcohol, Caffeine…). Leave *from JSON* empty so it reads today's live state.
2. Optionally add **Get Nutrition State** with Calculation **Remaining to Goal** for Calories / Protein /
   Carbs / Fat — this captures the day's targets.
3. **Get Contents of URL** — POST, header `x-ingest-secret` = `<INGEST_SECRET>`, no body. Type the URL and
   insert each result variable after its `=` (param names are MacroFactor's nutrient keys; `rem_` prefix =
   Remaining to Goal):

```
https://macrofactor-mcp.<your-subdomain>.workers.dev/today?energy=[Calories]&protein=[Protein]&carbs=[Carbs]&fat=[Fat]&fiber=[Fiber]&sugars=[Sugars]&saturatedFat=[SatFat]&sodium=[Sodium]&potassium=[Potassium]&calcium=[Calcium]&iron=[Iron]&magnesium=[Magnesium]&vitaminD=[VitD]&water=[Water]&rem_energy=[CalRem]&rem_protein=[ProRem]
```

Keys: energy, protein, carbs, fat, fiber, sugars, sugarsAdded, starch, saturatedFat, transFat,
monounsaturatedFat, polyunsaturatedFat, omega3, omega6, cholesterol, choline, alcohol, caffeine, water,
sodium, potassium, calcium, iron, magnesium, manganese, phosphorus, zinc, copper, selenium, folate,
vitaminA, vitaminB1, vitaminB2, vitaminB3, vitaminB5, vitaminB6, vitaminB12, vitaminC, vitaminD, vitaminE,
vitaminK (plus the amino acids). The server writes the `days` and `micronutrients` rows for that date
(tagged live; a later export replaces them).

**Part B — today's foods**

4. **Find Recent Food** — Add Filter: **Time Last Consumed** *is in the last* **24 hours**. Sort by Time
   Last Consumed. Limit off.
5. **Repeat with Each** ← Recent Food. Inside the loop add ONE **Text** action containing the Repeat Item's
   properties separated by `|`, in exactly this order (tap the variable → pick the property):

```
[Name]|[Brand]|[Time Last Consumed]|[Consumption Count]|[Energy]|[Protein (g)]|[Carbs (g)]|[Fat (g)]|[Hours Consumed (24 hr)]
```

   Hours Consumed is a list and goes last: if Shortcuts spreads it over extra lines, the server folds
   those into the food above. **End Repeat.**
6. **Combine Text** ← Repeat Results, with **New Lines**.
7. **Get Contents of URL** — POST, Request Body **File** ← Combined Text:

```
https://macrofactor-mcp.<your-subdomain>.workers.dev/foods-seen?token=<INGEST_SECRET>
```

   Append `&dry_run=1` the first time and add **Show Notification** ← Contents of URL to check the parse
   (`shape`, `sample`, `unrecognized_keys`) without storing; then remove it. A JSON array of dictionaries
   or `{items:[…]}` is accepted too.

The server turns each food into one `food_log` row per consumption (Consumption Count × Hours Consumed,
the last one at Time Last Consumed) tagged `shortcut`; an export's Food Log CSV replaces them.

**Still export-only:** MacroFactor's expenditure (TDEE) and trend weight, your saved-foods library,
workouts and training aggregates. A monthly export covers those.

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
