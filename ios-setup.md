# iPhone setup — logging + phone-only refresh

Two optional iOS Shortcuts. Both call your Worker; both use your `INGEST_SECRET`
(set it where you see `<INGEST_SECRET>`). Your MCP server base URL:

```
https://macrofactor-mcp.<your-subdomain>.workers.dev
```

---

## Shortcut 1 — "Update MF" (refresh data from your phone, no PC)

Sends a MacroFactor export straight to the server, which parses it and refreshes the data.
Works for **all three exports** — the **.xlsx workbook** (daily totals, micros, saved foods,
targets, training aggregates), the **Food Log .csv**, and the **Workout Log .csv**. The server
auto‑detects the file type by content, so the same Shortcut handles any of them; share each
file once.

```
MacroFactor → Export (workbook / food log / workout log) → Share → "Update MF" → POST /upload-export → done
```

**Build it (Shortcuts app):**
1. New Shortcut, name **Update MF**.
2. Shortcut settings (ⓘ) → enable **Show in Share Sheet** → Accept Types: **Files**.
3. Add action **Get Contents of URL**:
   - URL: `https://macrofactor-mcp.<your-subdomain>.workers.dev/upload-export`
   - Method: **POST**
   - Headers: add `x-ingest-secret` = `<INGEST_SECRET>`
   - Request Body: **File** → set to **Shortcut Input**
4. (Optional) Add **Show Notification** = the **Contents of URL** result (you'll see `{"ok":true,"days":…}`).

**Use it:** MacroFactor → **More → Data Management → Data Export** → run the export →
on the share sheet tap **Update MF**. ~2s later Claude sees fresh data. Repeat for each of
the three exports (workbook, food log, workout log) you want to refresh.

*If MacroFactor saves the export to Files instead of showing a share sheet:* make the
Shortcut start with **Get File** (Files picker) instead of using Share Sheet input.

The endpoint accepts the file as a raw body or multipart, so either Shortcut style works.

---

## Shortcut 2 — "MF Log from Claude" (log food via Claude)

When you ask Claude to log a food, the Worker queues it and pings Pushcut. You tap the
notification; this Shortcut pulls the queued food and logs it.

```
Claude → log_food → Worker queue + Pushcut → tap → this Shortcut → Log by JSON → MacroFactor
```

**Build it (Shortcuts app):**
1. New Shortcut, name **MF Log from Claude**.
2. Add **Get Contents of URL**:
   - URL: `https://macrofactor-mcp.<your-subdomain>.workers.dev/pending?token=<INGEST_SECRET>`
   - Method: **GET**
3. Add **If** → condition: **Contents of URL** → **has any value**. Put the next four steps *inside* the If.
4. Add **Get Dictionary from Input** ← **Contents of URL**.
5. Add **Get Dictionary Value** → key `_pending_id` in the dictionary from step 4. (Shortcuts labels this result **Dictionary Value**.)
6. Add **Log by JSON** (the MacroFactor action) ← **Contents of URL** (the step-2 variable — not the dictionary).
7. Add **Get Contents of URL**:
   - URL: `https://macrofactor-mcp.<your-subdomain>.workers.dev/today?token=<INGEST_SECRET>&ack_id=[Dictionary Value]`
   - Method: **POST**
   - Request Body: **File** → **Log by JSON result**
8. **End If**.

> **Gotchas:** never rename variables and never set a variable's Type to **URL** — coercing a response to URL type throws *"couldn't convert from Dictionary to URL."* The POST in step 7 does two things at once: it confirms that the food log landed in MacroFactor **and** refreshes the live today data — one tap, both done.

**Pushcut:**
1. Pushcut → **Notifications → +** → name it `LogFood`.
2. Set its action to **Run Shortcut → MF Log from Claude**.
3. Copy the notification's **Webhook URL** (`https://api.pushcut.io/<secret>/notifications/LogFood`).
4. That URL goes on the server as the `PUSHCUT_WEBHOOK_URL` secret:
   ```bash
   npx wrangler secret put PUSHCUT_WEBHOOK_URL   # paste the webhook URL
   npm run deploy
   ```

**Use it:** tell Claude *"log a flat white, 120 cal, 6g protein"* → tap the push → logged.

> **Saved foods reuse this exact shortcut — no extra setup.** Asking Claude *"log 2 serves of
> my muesli"* calls `log_saved_food`, which looks the food up in your library, scales its saved
> macros, and queues it through the same `/pending` → Log by JSON path. Same tap, same shortcut.

Notes:
- `Log by JSON` logs at the **current time** (no backdating).
- Pushcut free tier works (the Shortcut fetches `/pending`). Pushcut Pro can pass the food
  inline instead, but it isn't required.

---

## Shortcut 3 — "MF Today → MCP" (keep today live, no export)

Pushes today's running totals to the server so Claude's view of *today* stays current without a
full export. MacroFactor has **no single "today summary" action** — the only action that reads
totals is **Get Nutrition State**, which returns ONE nutrient at a time (pick a nutrient +
"Consumed"). So the shortcut reads the four macros and passes them to the server as URL query
params (`?energy=&protein=&carbs=&fat=`); the server stores them and overlays today onto
`get_today`, `data_status`, and `get_daily_nutrition`. (`energy` = kcal.)

> Why query params, not a JSON body: building a URL with inline variables is far less error-prone
> in Shortcuts than the JSON request-body key/value editor. The endpoint also still accepts a
> posted `{consumed, remaining}` JSON body if you ever wire one up.

**Build it (Shortcuts app):**
1. New Shortcut, name **MF Today → MCP**.
2. **Get Nutrition State** → Nutrient **Calories**, Calculation **Consumed**.
3. **Get Nutrition State** → Nutrient **Protein**, Calculation **Consumed**.
4. **Get Nutrition State** → Nutrient **Carbs**, Calculation **Consumed**.
5. **Get Nutrition State** → Nutrient **Fat**, Calculation **Consumed**.
   *(If a later Get Nutrition State shows "from JSON" pointing at the previous step, clear that
   input so it reads today's live state like the first one.)*
6. **Format Date** → Date **Current Date**, Format **Custom** `yyyy-MM-dd` (tags your local day,
   not the server's UTC day — matters near midnight).
7. **Get Contents of URL**:
   - **URL** (one text field, insert the result variables inline):
     `https://macrofactor-mcp.<your-subdomain>.workers.dev/today?date=[FormattedDate]&energy=[Calories]&protein=[Protein]&carbs=[Carbs]&fat=[Fat]`
   - **Method**: POST
   - **Headers**: `x-ingest-secret` = `<INGEST_SECRET>` (same as the Update MF shortcut)
   - **Request Body**: none (no JSON fields)
8. *(Optional)* **Show Notification** = the **Contents of URL** result → you'll see
   `{"ok":true,"date":"…","consumed":{"calories":…,"protein":…}}`.

**Automate it (so you never run it by hand):**
- **Best — fire it right after you log food:** Shortcuts → **Automation** tab → **+** →
  **App** → **MacroFactor** → **Is Closed** → **Run Immediately** (turn *off* "Ask Before
  Running") → **Run Shortcut** → **MF Today → MCP**. Every time you close MacroFactor, today
  refreshes within seconds. *(App-close automations with Run Immediately need iOS 16.4+. If yours
  still asks to confirm, use the time backstops below.)*
- **Backstops — a couple of fixed times:** Automation → **+** → **Time of Day** → e.g. **1:00 PM**
  and **9:00 PM** → Run Immediately → run **MF Today → MCP**.

**Hygiene:** a bad row can be wiped with
`POST https://…/today?token=<INGEST_SECRET>&clear=YYYY-MM-DD`.

**Use it:** ask Claude *"what's left for today?"* or *"how am I tracking vs my targets right
now?"* → it calls `get_today` and sees totals that are seconds old, not last-export old.

---

## Shortcut 4 — "MF Log Water" (log water via Claude)

When you ask Claude to log water, the Worker queues the amount (in mL) and pings a **second**
Pushcut notification. You tap it; this Shortcut pulls the amount and logs it with MacroFactor's
**dedicated Log Water action** (which credits your water target/ring — unlike logging water as a
food). This is fully separate from the food path, so your "MF Log from Claude" shortcut is untouched.

```
Claude → log_water → Worker water-queue + Pushcut → tap → this Shortcut → Log Water → MacroFactor
```

**Build it (Shortcuts app):**
1. New Shortcut, name **MF Log Water**.
2. Add **Get Contents of URL**:
   - URL: `https://macrofactor-mcp.<your-subdomain>.workers.dev/pending-water?token=<INGEST_SECRET>`
   - Method: **GET**
   *(returns a bare number, e.g. `500`, or nothing when the queue is empty)*
3. Add **If** → condition: **Contents of URL** → **has any value**. This guards against a stale or
   duplicate tap when nothing is queued — an empty (204) result would otherwise log 0 mL. Put the
   next step *inside* the If.
4. Add MacroFactor's **Log Water** action → Amount: **Contents of URL**.
   - In the action, set the **unit to mL** (the server always sends millilitres). The unit is
     editable right in the action — make sure it isn't left on fl oz.
5. **End If**.

**Pushcut:**
1. Pushcut → **Notifications → +** → name it `LogWater` (a *new* notification, separate from `LogFood`).
2. Set its action to **Run Shortcut → MF Log Water**.
3. Copy the notification's **Webhook URL** (`https://api.pushcut.io/<secret>/notifications/LogWater`).
4. Put it on the server as the `PUSHCUT_WATER_WEBHOOK_URL` secret:
   ```bash
   npx wrangler secret put PUSHCUT_WATER_WEBHOOK_URL   # paste the LogWater webhook URL
   npm run deploy
   ```

**Use it:** tell Claude *"log 500 ml of water"* (or *"log a pint of water"* — Claude converts to
mL) → tap the push → logged.

Notes:
- Until you set `PUSHCUT_WATER_WEBHOOK_URL`, `log_water` still **queues** the amount and tells you;
  it just can't ping the phone yet. You can run **MF Log Water** by hand to flush the queue.
- The amount is whole millilitres. Claude converts other units (1 US fl oz ≈ 30 mL, 1 cup ≈ 240 mL,
  1 L = 1000 mL) before calling.

---

## Shortcut 5 — "MF Log Weight" (log body weight via Claude)

A clone of the water shortcut, using MacroFactor's dedicated **Log Weight** action. The server
always stores + returns **kg**.

> **Unit check first:** confirm whether MacroFactor's Log Weight action expects **kg** or your
> app's display unit (**lbs**). Steps below assume kg (most users outside the US). If your
> MacroFactor is set to lbs, add a **Calculate** step (multiply by `2.20462`) before the Log Weight
> action and feed it the result instead.

**Build it (Shortcuts app):**
1. New Shortcut, name **MF Log Weight**.
2. Add **Get Contents of URL**:
   - URL: `https://macrofactor-mcp.<your-subdomain>.workers.dev/pending-weight?token=<INGEST_SECRET>`
   - Method: **GET** *(returns a bare kg number, e.g. `75.5`, or nothing when empty)*
3. Add **If** → condition: **Contents of URL** → **has any value** (guards an empty 204). Put the
   next step *inside* the If.
4. **kg setup:** add MacroFactor's **Log Weight** action → Weight: **Contents of URL**.
   **lbs setup:** add **Calculate** (Contents of URL × `2.20462`) → then **Log Weight** with that result.
5. **End If**.

**Pushcut:** new notification `LogWeight` → **Run Shortcut → MF Log Weight** → copy its webhook →
```bash
npx wrangler secret put PUSHCUT_WEIGHT_WEBHOOK_URL   # paste the LogWeight webhook URL
npm run deploy
```

**Use it:** *"log my weight, 75.4 kg"* → tap the push → logged. Until the secret is set, `log_weight`
queues the value and tells you; run **MF Log Weight** by hand to flush it.

---

## Shortcut 6 — "MF Log Batch" (log a whole meal in one tap)

When you ask Claude to log several foods at once (`log_foods_batch` — great for a full meal or a
photo-estimated plate), the Worker queues them as one batch and pings a Pushcut notification. You
tap once; this Shortcut loops over every item and logs each via **Log by JSON**. The `pop=1` query
param makes the server delete the batch as it's served, so **no separate ack step is needed**.

```
Claude → log_foods_batch → Worker batch-queue + Pushcut → tap → loop Log by JSON ×N → MacroFactor
```

**Build it (Shortcuts app):**
1. New Shortcut, name **MF Log Batch**.
2. **Get Contents of URL** → Method **GET**, and **type the URL literally** (not from a variable):
   `https://macrofactor-mcp.<your-subdomain>.workers.dev/pending-batch?token=<INGEST_SECRET>&pop=1`
3. **Get Dictionary from Input** ← **Contents of URL**.
4. **Get Dictionary Value** → key `items` in the dictionary from step 3.
5. **Repeat with Each** ← the `items` result:
   - **Log by JSON** (MacroFactor action) ← **Repeat Item**.
6. **End Repeat**.

*(Optional — refresh today after the batch):*

7. **If** → condition: **Log by JSON result** → **has any value**. Put the next step inside.
8. **Get Contents of URL**:
   - URL: `https://macrofactor-mcp.<your-subdomain>.workers.dev/today?token=<INGEST_SECRET>`
   - Method: **POST**
   - Request Body: **File** → **Log by JSON result**
9. **End If**. *(Refreshes today's running totals — no `ack_id` needed since batches are already cleared via `pop=1` when the Shortcut reads them.)*

> **Gotchas (learned the hard way):** type the URL **directly** into Get Contents of URL — don't build
> it from a separate Text action + variable. And **never rename a variable or set its Type to "URL"**:
> a response coerced to URL throws *"couldn't convert from Dictionary to URL."* No `If` guard is
> needed — with `pop=1` you only tap when Claude actually sent a batch.

**Pushcut:** new notification `LogBatch` → **Run Shortcut → MF Log Batch** → copy its webhook →
```bash
npx wrangler secret put PUSHCUT_BATCH_WEBHOOK_URL   # paste the LogBatch webhook URL
npm run deploy
```

**Use it:** *"log my lunch: 200g chicken, a cup of rice, broccoli, a tbsp of olive oil"* → one push →
one tap → all four logged. With `pop=1` the batch is cleared as it's read, so it never double-logs;
the trade-off is that a crash mid-loop loses the rest of that batch (fine for one user). The
`/ack-batch` endpoint still exists for backward compatibility but the Shortcut no longer uses it.

---

## Notification 7 — "New PR" (proactive lift PR alerts, no Shortcut)

The server checks your workout log for new all-time PRs on every export upload (and once daily via
cron). To get a lock-screen ping when you hit one:

1. Pushcut → **Notifications → +** → name it `NewPR`. (No "Run Shortcut" action needed — tapping it
   just opens Pushcut/Claude; you then ask Claude `get_pr_alerts` for specifics.)
2. Copy its webhook URL →
   ```bash
   npx wrangler secret put PUSHCUT_PR_WEBHOOK_URL   # paste the NewPR webhook URL
   npm run deploy
   ```

Free-tier Pushcut text is static ("check Claude"); the PR details live in `get_pr_alerts`. The very
first export after deploy silently seeds the PR baseline (no flood of "every lift is a PR").
