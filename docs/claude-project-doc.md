# MacroFactor MCP — Claude Project Reference

**43 tools as of 2026-09-02 (jamesj64 fork). Paste this file into the Claude project you use with this connector as context.** The server also ships MCP `instructions` with the logging playbook.

---

## 1. What the server is

A Cloudflare Worker backed by a D1 SQLite database. It ingests MacroFactor data via two independent paths and exposes 38 MCP tools:

**Path A — Finalized export:** Upload the MacroFactor `.xlsx` export to `POST /upload-export`. The importer parses every sheet (Nutrition / Food Log / Micronutrients / Workout Sets / Muscle Volume / Exercise Metrics / Weight / Body Metrics / Program / Targets / Weight Goals / Food Library) into D1. All historical read tools draw from this data.

**Path B — Live /today feed:** A MacroFactor "Today-Summary" shortcut on the user's phone POSTs current macros to `POST /today` several times per day, independent of exports. `get_daily_nutrition` and `get_day` overlay this live feed onto the exported data for the current calendar date — live wins for macros (calories/protein/carbs/fat); the export still supplies expenditure, weight, and steps which the live feed doesn't carry. Tagged `live:true`. Earlier dates are gap-filled (not overwritten) by the live feed.

**Write queues:** `log_food`, `log_saved_food`, `log_recipe`, `relog_meal`, `log_foods_batch` write MacroFactorFood rows to `pending_food`; `log_water` / `log_weight` write to `pending_water` / `pending_weight`. One Pushcut notification fires; the user taps it (or says "Hey Siri, MF Sync") → the **MF Sync** Shortcut calls `GET /pending-all`, which claims every queued row and returns `{claim, count, foods[], water[], weight[]}`; the Shortcut loops them through MacroFactor's "Log by JSON" / "Log Water" / "Log Weight" actions and finally `POST /sync-ack?claim=` with MacroFactor's returned Today Summary. Food lands in MacroFactor at sync-time, not queue-time.

**Food search:** `search_food` / `get_food_nutrients` / `lookup_barcode` query USDA FoodData Central and Open Food Facts live (plus `food_library` from the export). `search` / `fetch` are ChatGPT-connector-shaped wrappers.

---

## 2. Write-confirmation loop

```
log_food / log_foods_batch / log_recipe / relog_meal / log_saved_food / log_water / log_weight
  ↓ validated against the official MacroFactorFood schema, enqueued, ONE Pushcut notification
User taps notification (or Siri / app-closed automation) → "MF Sync" Shortcut
  ↓ GET /pending-all  → claims all rows under one `claim` stamp (re-served after 10 min if unacked)
  ↓ Log by JSON ×N, Log Water ×N, Log Weight ×N
  ↓ POST /sync-ack?claim=<stamp>  body = MacroFactor's Today Summary
    → deletes the claimed rows, marks food_dispatch_log.landed_at_ms
    → upserts today_summary (consumed + remaining-vs-goal for every nutrient) → get_today is live
```

**get_pending_logs** shows every queue (with `claimed:true` once the phone has fetched a row) plus `recent_dispatches` (last 24 h of foods the phone has pulled):
- `landed:true` — Shortcut confirmed log landed in MacroFactor AND refreshed today totals
- `landed:false` — phone pulled the item but no `/today` ack received (Shortcut may predate the ack step, or MacroFactor errored; food may still have landed)

**cancel_pending_log** deletes rows from any queue before the user taps. Safe to call immediately after the user says "never mind." For `batch`, also clears claimed-but-not-yet-acked rows. Returns per-queue deleted counts.

**intended_time hints** (HH:MM, 24 h): MacroFactor always logs at the moment the user taps; `intended_time` records when the food was *actually eaten*. After the next food-log export import, the server runs a matching pass (`matchFoodIntents`) against the exported `food_log` table:
- Matches by name (case-insensitive) + calories (±2 kcal) + within ±12 h of intended_time
- Statuses: `pending` (not yet exported), `matched` (unique match), `ambiguous` (multiple candidates), `expired` (>7 days, no export match found)
- Effect: `get_nutrient_timing` buckets matched items at `intended_time` instead of tap-time. No effect until the next export import covers that food.

**PR alerts:** On every `POST /upload-export` (and once daily via cron), the server recomputes all-time PRs from `workout_sets` (Epley e1RM, heaviest weight, best set volume) and fires a Pushcut notification if any new records are set. Results are stored in `pr_alerts`; query via `get_pr_alerts`.

---

## 3. Data semantics & gotchas

### Bodyweight-inclusive MF metrics vs barbell view

MacroFactor adds a per-exercise bodyweight contribution to compound lifts in its `exercise_metrics` and `muscle_volume` tables. A 100 kg user doing a front squat at 60 kg bar weight may see ~160 kg in MacroFactor's 1RM / tonnage figures. The `get_exercise_progress` tool exposes **both** views side-by-side:
- `exercises` — MacroFactor's computed metrics (bodyweight-inclusive for compounds)
- `barbell` — bar load only, derived from raw `workout_sets` (no bodyweight contribution)

`get_training_volume` uses MacroFactor's muscle_volume table (bodyweight-inclusive; use for stimulus tracking, not load tracking).

### Muscle-volume fractional overlap

Each exercise is credited to every muscle it trains, often fractionally. Per-muscle tonnage intentionally **sums to more** than a single session's bar load. Do not sum across muscles to get session volume; use `get_workouts` for that.

### kg storage; *_lb reconstruction

All weights are stored internally in kg. For exercises configured as **Pounds** in MacroFactor's Exercise Settings, all tools that output weight/volume fields append `*_lb` fields reconstructed via `× 2.20462`. Field names: `weight_lb`, `volume_lb`, `top_set.weight_lb`, `e1rm_lb`, `heaviest_lb`, `best_set_volume_lb`. The `display_unit: "lb"` key appears on the exercise object to signal this. Log weights passed via `log_weight` can be passed in lbs with `unit:"lbs"` for server-side conversion (÷ 2.20462).

### Suspect flags — advisory, values never altered

**Food item level** (`get_food_log`): `suspect:["kcal_macro_mismatch"]` when `|calories - (4P + 4C + 9F)| > max(30, calories × 0.15)` or when calories ≥ 100 and estimated macros sum to 0. `suspect:["zero_protein_on_protein_food"]` when a food matching the protein-food regex (chicken, beef, fish, egg, whey, protein, yoghurt, etc.) has null or zero protein logged.

**Day level** (`get_daily_nutrition`): `suspect:"kcal_macro_mismatch"` when `|calories - (4P + 4C + 9F + 7A)| > max(100, calories × 0.075)`. Alcohol_g is included in the day-level 4/4/9/7 estimate. Live-overlaid rows (current day) are **never** flagged. The flag is advisory; the values are returned as-is.

**Micronutrient level** (`get_micronutrients`): `suspect:{}` object per day listing nutrients with physiologically implausible single-day values. Sanity caps: explicit overrides for Magnesium (2000 mg), Sodium (15000 mg), Iron (100 mg), Zinc (100 mg), Vitamin D (250 mcg); otherwise 3× UL (if defined) or 10× RDA. Known failure mode: a custom food with a mis-entered nutrient amount produces a run of elevated readings for that nutrient, with only the most extreme day tripping the cap — treat the whole run as unreliable until the entry is corrected in MacroFactor and a fresh export lands.

### micro_gap_analysis: excluded_suspect_days

In `micro_gap_analysis`, days with a implausible value for a given nutrient are excluded from its `avg_per_day` and counted in `excluded_suspect_days`. The raw values remain visible via `get_micronutrients`. `avg_per_day` is averaged over `tracked_days` (days the key appeared), not the full window — low `tracked_days` = sparse data.

### get_targets staleness block

`get_targets` includes a `staleness` block with these fields: `latest_program_date` (newest program snapshot in the export), `program_age_days` (days between that snapshot and the queried date — a large value after an in-app goal change means the target shown is stale; re-export to refresh), `current_avg_expenditure_7d`, and `target_vs_expenditure_delta` (target calories − 7-day avg TDEE = the currently-implied surplus/deficit), plus a `note`.

### weekly_summary: honest windows and alcohol

Each window (`actual_span_days`) reflects the real calendar span of available data, which may be less than the window size. `coverage_note` appears when fewer days are logged than the window. Alcohol: `avg_alcohol_g_per_day` and `drinking_days` are included per window. Source: the `alcohol_g` column on the `days` table, which is populated from the "Alcohol (g)" row in the Micronutrients sheet of the export (not the food log directly). Omitted from a day if zero or absent from the export.

### Compact vs full responses

`get_today` default is compact: `consumed` (calories/protein/carbs/fat), `target`, `remaining_to_target`, `vs_target`, `updated_ago`. Pass `detail:"full"` to also get `consumed_all` (every nutrient logged today, MacroFactor keys, sparse) and `remaining_raw` (MacroFactor's raw remaining goals object).

`get_micronutrients` default is the curated 29-nutrient set (25 NIH-RDA nutrients + Alcohol g, Sugars g, Saturated Fat g, Caffeine mg). Pass `detail:"full"` for every raw column.

`get_training_volume` with `detail:"daily"` adds per-date per-muscle raw rows. `get_exercise_progress` series capped at 30 points; pass `all:true` for full history. `get_training_day_nutrition` with `detail:"days"` adds per-day classified rows.

**null and omitted keys are equivalent.** JSON serialization strips null values from the response (the `text()` function uses `(_k, v) => v === null ? undefined : v`). A missing key means the same as null.

---

## 4. Per-tool reference

### READS — Nutrition

---

#### `get_daily_nutrition`
Per-day macro totals, TDEE, scale/trend weight, steps, and alcohol_g.

| Param | Type | Default |
|---|---|---|
| start_date | YYYY-MM-DD (optional) | 14 days ago |
| end_date | YYYY-MM-DD (optional) | today |

**Response:** Array of day objects: `{date, calories, protein, carbs, fat, expenditure, scale_weight, trend_weight, fat_percent, steps, alcohol_g?, live?, suspect?, source?, updated_at?}`. Current day is live-overlaid (`live:true`, `source:"today-summary"`). `suspect:"kcal_macro_mismatch"` on finalized days where reported kcal diverges from 4/4/9/7 estimate by >7.5% (min 100 kcal). `alcohol_g` omitted when zero.

**When to use:** Rolling calorie / macro / weight trend context. Always covers today live.

---

#### `get_micronutrients`
Per-day micronutrient totals from the Micronutrients export sheet.

| Param | Type | Default |
|---|---|---|
| start_date | YYYY-MM-DD (optional) | 14 days ago |
| end_date | YYYY-MM-DD (optional) | today |
| nutrients | string[] (optional) | — |
| detail | "full" (optional) | — |

**Response:** Array of `{date, <nutrient_key>: value, ..., suspect?: {<key>: value}}`. Default set: 25 NIH-reference nutrients + Alcohol (g), Sugars (g), Saturated Fat (g), Caffeine (mg) — 29 total. `nutrients` param filters to names containing any term (case-insensitive). `detail:"full"` returns all export columns. `suspect` object on days with implausible values (never altered).

**When to use:** Micronutrient adequacy checks, vitamin D, omega-3, fiber gaps. Pass `nutrients:["magnesium","zinc"]` to narrow. Use `micro_gap_analysis` for averaged status vs RDA.

---

#### `get_food_log`
Individual logged food items with time, serving, and macros.

| Param | Type | Default |
|---|---|---|
| start_date | YYYY-MM-DD (optional) | 7 days ago |
| end_date | YYYY-MM-DD (optional) | today |

**Response:** Array of `{date, time, name, calories, protein, carbs, fat, fiber?, sugar?, sodium_mg?, brand?, suspect?:[]}`. `suspect` is an array of flag strings: `"kcal_macro_mismatch"`, `"zero_protein_on_protein_food"`.

**When to use:** Meal-by-meal breakdown, spotting entry errors, checking what was eaten at a specific time. Note: `time` reflects when logged in MacroFactor (which equals tap-time for MCP-queued foods, unless intended_time matched).

---

#### `get_weight_history`
Scale weight, trend weight (kg), and body-fat % over time.

| Param | Type | Default |
|---|---|---|
| start_date | YYYY-MM-DD (optional) | 60 days ago |
| end_date | YYYY-MM-DD (optional) | today |

**Response:** `{entries: [{date, scale_weight, trend_weight, fat_percent?, method_change_suspected?}], note}` — weights in kg but the field names are NOT suffixed `_kg`. `method_change_suspected:true` on the later row when consecutive fat_percent readings jump >3 points (signals device/method change, not real composition change).

**When to use:** Weight trend, body composition over time. For scale/trend weight in a macro context, `get_daily_nutrition` includes these fields. Use this for the `{entries, note}` shape specifically.

---

#### `get_expenditure`
Daily TDEE alongside intake and weight.

| Param | Type | Default |
|---|---|---|
| start_date | YYYY-MM-DD (optional) | 30 days ago |
| end_date | YYYY-MM-DD (optional) | today |

**Response:** Array of `{date, calories, expenditure, scale_weight, trend_weight}`.

**When to use:** Comparing intake vs TDEE, checking metabolic adaptation over time.

---

#### `get_steps`
Daily step count.

| Param | Type | Default |
|---|---|---|
| start_date | YYYY-MM-DD (optional) | 30 days ago |
| end_date | YYYY-MM-DD (optional) | today |

**Response:** Array of `{date, steps}`.

---

#### `search_my_foods`
Search the food library (Favorites / Custom Foods / logged history) by name.

| Param | Type |
|---|---|
| query | string (required) |

**Response:** `{loggable: [{name, source, serving_size, serving_qty, calories, protein, carbs, fat}], name_only: [{name, source}], note}`. `loggable` = has stored macros (feed into `log_saved_food`). `name_only` = history/custom rows with no stored macros (use `log_food` with explicit macros instead).

**When to use:** Before `log_saved_food` to confirm the food exists and see its serving size.

---

#### `data_status`
Data freshness check — how much data is loaded and its most recent date.

No params.

**Response:** Flat per-table count objects at top level — `days:{n,first,last}, micronutrients:{n,last}, food_log:{n,first,last}, food_library:{n}, nutrition_targets:{n,latest_program}, workout_sets:{n,first,last}, exercise_metrics:{n,last}, pr_baseline:{n}, pr_alerts:{n,last_detected_ms}, body_metrics:{n,last}, training_programs:{n}` — plus queue counts (`pending_to_log, pending_water_to_log, pending_weight_to_log, pending_batches_to_log`), `last_imports:[{uploaded_at, file_type, counts:{...}}]` (last 5 uploads — the actual export-freshness signal; read `last_imports[0].uploaded_at`), and `today_live:{date, calories, protein, carbs, fat, updated_at, updated_ago, is_current_day}` (or a note string when no live post exists). There is no last_export_date field and no row_counts wrapper.

**When to use:** Confirm data is current before making nutrition recommendations. Check after a user says they uploaded a new export.

---

### READS — Today / Day

---

#### `get_today`
Today's live running nutrition totals — freshest possible view.

| Param | Type | Default |
|---|---|---|
| date | YYYY-MM-DD (optional) | today |
| detail | "full" (optional) | — |

**Response:** `{date, live:bool, is_current_day?:bool, updated_at?, updated_ago?, source, consumed:{calories,protein,carbs,fat}, alcohol_g?, target:{calories,protein,carbs,fat}?, remaining_to_target:{calories,protein,carbs,fat}?, vs_target:{calorie_diff,calorie_pct,calorie_on_target,protein_diff,protein_hit}?, note}`. Falls back to `live:false, source:"export"` if no live post exists for the date — that branch returns ONLY `{date, live, source, consumed, target, note}`; `is_current_day`, `updated_at`, `updated_ago`, `remaining_to_target` and `vs_target` are omitted entirely, and `source`/`consumed` are null when no export day exists either. `remaining_to_target > 0` = still to consume; `< 0` = over. `detail:"full"` adds `consumed_all` (every nutrient in MacroFactor's Today-Summary format, energy=kcal) and `remaining_raw` (MacroFactor's raw remaining goals object).

**When to use:** Start of any meal-planning or logging conversation — check what's consumed and remaining today. Far more current than `get_daily_nutrition` for today.

---

#### `get_day`
Everything for one date in one call.

| Param | Type | Default |
|---|---|---|
| date | YYYY-MM-DD (optional) | today |

**Response:** `{date, weekday, nutrition:{calories,protein,carbs,fat,expenditure,alcohol_g,live,suspect}?, weight:{scale_kg,trend_kg,fat_percent}?, steps, target:{calories,protein,carbs,fat}?, vs_target:{calorie_diff,calorie_on_target,protein_diff,protein_hit}?, food_items:[...], training:[...sessions]?, note}`. Nutrition is live-overlaid when current. food_items carries suspect flags.

**When to use:** Single-day deep-dive combining nutrition, training, and weight. Preferred over calling multiple tools for one date. Pairs well with your wearable's recovery data for the same date.

---

### READS — Targets & Adherence

---

#### `get_targets`
Current nutrition targets and weight goal for a given date.

| Param | Type | Default |
|---|---|---|
| date | YYYY-MM-DD (optional) | today |
| week | bool (optional) | false |

**Response:** `{date, weekday, target:{program_date,calories,protein,carbs,fat,expenditure,daily_average,reference_weight_kg,expenditure_mode}?, week?:[{weekday,calories,protein,carbs,fat,daily_average}], weight_goal:{goal,status,start_date,goal_weight_kg,goal_rate_pct_per_week,starting_trend_weight_kg,current_trend_weight_kg,current_trend_date,to_go_kg}?, programs:{count,dates}, staleness:{latest_program_date,program_age_days,current_avg_expenditure_7d,target_vs_expenditure_delta,note}, units}`. `staleness` is always present; a large `program_age_days` after an in-app program change means the target is stale (re-export to refresh). `week:true` adds all seven weekday rows of the governing program (Monday→Sunday) — the whole high-day/rest-day cycle in one call.

**When to use:** Check exact targets before logging or when assessing adherence. Handles weekday-cycling programs (e.g. higher carbs on training days); pass `week:true` to see the full weekly cycle at once.

---

#### `get_goal_history`
Every MacroFactor weight goal ever set, with planned-vs-actual per goal.

| Param | Type | Default |
|---|---|---|
| — | no parameters | |

**Response:** `{count, goals:[{goal, status, start_date, end_date?, goal_weight_kg?, planned:{rate_pct_per_week, original_eta_days?}, actual:{as_of, duration_days, starting_trend_weight_kg, ending_trend_weight_kg, weight_change_kg, rate_kg_per_week, rate_pct_per_week}, checkpoint:{date, weight_kg}?, vs_plan:{duration_vs_eta_days}?}], note}`. Goals are oldest-first. `actual.*` uses trend weight; an In-Progress goal's `actual` runs to the latest trend reading. `planned.rate_pct_per_week` is unsigned (direction comes from the goal type); maintenance goals legitimately show near-zero actual rates.

**When to use:** Bulk/cut/recomp retrospectives ("how did the last cut actually go vs plan?"), sanity-checking a new goal's rate against what was actually achieved before. `get_targets` only ever shows the active goal.

---

#### `get_adherence`
Per-day intake vs target with true energy balance.

| Param | Type | Default |
|---|---|---|
| start_date | YYYY-MM-DD (optional) | 30 days ago |
| end_date | YYYY-MM-DD (optional) | today |

**Response:** `{range:{start,end}, summary:{days_evaluated, days_with_target, calorie_on_target_rate_pct, protein_hit_rate_pct, avg_calorie_diff, avg_protein_diff, avg_carb_diff, avg_fat_diff, avg_protein, cumulative_vs_target_kcal, cumulative_vs_expenditure_kcal, est_kg_change_from_balance, note}, per_day:[{date, partial?, intake:{calories,protein,carbs,fat}, target:{calories,protein,carbs,fat}|null, vs_target:{calorie_diff, calorie_pct, calorie_on_target:bool, protein_diff, protein_hit:bool, carb_diff, fat_diff}|null, energy_balance_vs_expenditure}]}`. NOT a bare array — per-day rows are nested under `per_day`, and the cumulative figures exist only in `summary`. `calorie_on_target`: within ±5% of target calories. `protein_hit`: ≥95% of target protein. `avg_carb_diff` / `avg_fat_diff` = average g/day vs target (+ = over) — the macro-split gap even when calories are on target. `energy_balance_vs_expenditure` = intake − expenditure (not intake − target). `est_kg_change_from_balance` = cumulative balance ÷ 7700 kcal/kg.

**When to use:** Quantifying adherence streaks, identifying which days over/under. Use `weekly_summary` for rolled-up rates.

---

### READS — Summaries

---

#### `weekly_summary`
Rolling 7/14/28-day digest — one call instead of pulling raw rows.

| Param | Type | Default |
|---|---|---|
| end_date | YYYY-MM-DD (optional) | today |
| windows | number[] (optional) | [7, 14, 28] |

**Response:** `{as_of, is_partial_today, goal:{goal, status, goal_weight_kg, goal_rate_pct_per_week}|null, windows:{"7d":{...}, "14d":{...}, "28d":{...}}, recent_prs:[{exercise, e1rm_kg, top_set, date, days_ago}], note}`. `windows` is an OBJECT keyed `"<N>d"` (not an array), and the top-level goal key is `goal` (not `weight_goal`). Each window block: `{window_days, range:{start,end}, days_with_data, actual_span_days, nutrition:{avg_calories, avg_protein, avg_carbs, avg_fat, avg_alcohol_g_per_day, drinking_days, logged_days}, adherence:{calorie_on_target_rate_pct, protein_hit_rate_pct, avg_calorie_diff, avg_carb_diff, avg_fat_diff, days_with_target}, energy_balance:{cumulative_vs_expenditure_kcal, avg_daily_balance_kcal, est_kg_change, days}, weight:{start_kg, end_kg, change_kg, span_days, rate_kg_per_week, rate_pct_per_week}, expenditure:{avg_tdee, drift_kcal}, training:{sessions, total_working_sets, per_muscle:[{muscle, sets, volume_kg}]}, coverage_note?}`. `coverage_note` when data days < window size. `avg_carb_diff` / `avg_fat_diff` = average g/day vs target (+ = over).

**When to use:** Weekly/monthly check-in summary. Preferred over assembling multiple daily queries. For the full weekly-review bundle (this + PR alerts + weekday patterns) use `weekly_review`.

---

#### `weekly_review`
The whole weekly check-in bundle in one call.

| Param | Type | Default |
|---|---|---|
| end_date | YYYY-MM-DD (optional) | today |
| windows | number[] (optional) | [7, 14, 28] |

**Response:** `{as_of, weekly_summary:{...}, pr_alerts:{...}, day_of_week_patterns:{...}, note}` — the three sections are exactly the responses of `weekly_summary`, `get_pr_alerts` (since = start of the longest window, incl. `bottleneck_kpi`), and `day_of_week_patterns` (the 90 days ending at `as_of`), guaranteed to share one end date.

**When to use:** The weekly review playbook — replaces the `weekly_summary` + `get_pr_alerts` + `day_of_week_patterns` three-call sequence. Pair with your wearable's recovery trends for the recovery side.

---

### READS — Training

---

#### `get_training_volume`
Working sets and tonnage per muscle group over a date range.

| Param | Type | Default |
|---|---|---|
| start_date | YYYY-MM-DD (optional) | 30 days ago |
| end_date | YYYY-MM-DD (optional) | today |
| detail | "daily" (optional) | — |

**Response:** `{range, training_days, basis:"...", per_muscle:[{muscle, total_sets, total_volume_kg, days_trained}], daily?:[...]}`. **IMPORTANT:** (1) Per-muscle totals overlap — each exercise is credited to every muscle it trains. Do not sum muscles for session volume. (2) Tonnage includes bodyweight contribution for compounds. These are stimulus measures, not bar weight.

**When to use:** Weekly set volume per muscle, muscle balance check, checking MEV/MAV proximity. Use `get_workouts` for actual bar load.

---

#### `get_exercise_progress`
Per-exercise MacroFactor computed metrics + barbell load cross-reference.

| Param | Type | Default |
|---|---|---|
| exercise | string (partial name, optional) | all |
| metric | string (optional) | all metrics |
| start_date | YYYY-MM-DD (optional) | 90 days ago |
| end_date | YYYY-MM-DD (optional) | today |
| all | boolean (optional) | false (30 points) |

Available metrics: `1RM`, `3RM`, `10RM`, `total_volume`, `best_set_volume`, `heaviest_weight`, `total_reps`, `best_set_reps`, `total_sets`.

**Response:** `{range, basis:"...", exercises:[{exercise, metric, n, first, last, max, change, series:[{date,value}], series_truncated?, total_points?}], barbell:[{exercise, display_unit?, heaviest_kg, heaviest_lb?, total_volume_kg, best_set_volume_kg, by_date:[{date,heaviest_kg,total_volume_kg,sets}], series_truncated?, total_points?}]}`. `exercises` view is bodyweight-inclusive for compounds; `barbell` view is bar-only. Pound-configured exercises get `*_lb` fields.

**When to use:** Strength trend over time, comparing MF's e1RM estimate vs actual bar load. Use `filter exercise:"Front Squat"` for a specific lift.

---

#### `get_workouts`
Workout sessions with per-exercise sets, reps, RIR, and volume.

| Param | Type | Default |
|---|---|---|
| start_date | YYYY-MM-DD (optional) | 30 days ago |
| end_date | YYYY-MM-DD (optional) | today |

**Response:** `{range, sessions:[{date, workout, duration_min, exercises:[{exercise, display_unit?, sets:[{set, weight_kg, weight_lb?, reps, rir, type, base_weight_kg?, duration_s?, distance_m?, distance_km?}], volume_kg, volume_lb?, top_set:{weight_kg, weight_lb?, reps}}]}], units_note}`. `type` = set type (Standard, Warm-Up, etc.). Timed / distance / assisted sets (carries, holds, bike, assisted dips) carry `duration_s` / `distance_m` / `distance_km` / `base_weight_kg` when logged; null fields are stripped, so pure barbell sets show none of them.

**When to use:** Post-workout review, checking what was done on a specific date, comparing planned vs logged.

---

#### `get_prs`
Best lifts per exercise (e1RM, heaviest, best set volume) from all logged sets.

| Param | Type | Default |
|---|---|---|
| exercise | string (partial name, optional) | all |

**Response:** `{exercises:[{exercise, display_unit?, e1rm_kg, e1rm_lb?, e1rm_set:{weight_kg, reps, date}, heaviest_kg, heaviest_lb?, heaviest_set:{weight_kg, reps, date}, best_set_volume_kg, best_set_volume_lb?, best_volume_set:{weight_kg, reps, date}, best_duration_s?, best_duration_set:{duration_s, date}?, best_distance_m?, best_distance_set:{distance_m, date}?}], method}`. NOT a bare array. Dates live inside each `*_set.date` — there are no top-level `*_date` fields — and the volume-PR set is named `best_volume_set` (not `best_set`). e1RM = Epley formula (weight × (1 + reps/30)). Timed/distance exercises additionally report `best_duration_s` / `best_distance_m`; exercises with no weight×reps sets omit the weight-PR fields entirely.

**When to use:** Checking current PRs before a session, celebrating achievements, setting targets.

---

### READS — Body & Program

---

#### `get_body_metrics`
Body measurements (circumferences) and visual body-fat assessments.

| Param | Type | Default |
|---|---|---|
| start_date | YYYY-MM-DD (optional) | 1 year ago |
| end_date | YYYY-MM-DD (optional) | today |

**Response:** `{range:{start, end?, default_window_days?}, units, note, entries:[{date, visual_body_fat?, measurements:{<name>: <cm>, ...}}]}` — sparse, only dates with measurements appear. Per-measurement keys live inside `measurements` (empty `{}` when only visual body-fat was recorded), not at the entry's top level. For scale/trend weight and fat%, use `get_weight_history`.

---

#### `get_program`
Planned MacroFactor training program template.

| Param | Type | Default |
|---|---|---|
| program | string (partial name, optional) | all programs |

**Response:** `{count, programs:[{program, meta, summary:{cycles, workout_sessions, rest_days, distinct_workouts, distinct_exercises}, cycles:[{cycle, block, schedule:[{day, type, exercises:[{exercise, sets:[{set, type, rep_range, rir, rest}]}]}]}]}], note}`. This is the template (what's programmed), not what was logged. For completed sessions use `get_workouts`.

---

### READS — Analytics

---

#### `forecast_weight`
Weight-loss ETA using OLS regression + calorie math.

| Param | Type |
|---|---|
| target_date | YYYY-MM-DD (optional) |

**Response:** `{as_of, data_window_days:56, data_points, error:null|"insufficient_data", current_trend_weight_kg, goal_weight_kg, kg_remaining, ols_regression:{slope_kg_per_day, slope_kg_per_week, r_squared, eta_date, eta_days}, calorie_math:{avg_intake_kcal, avg_tdee_kcal, avg_daily_deficit_kcal, calorie_math_rows, loss_goal_only:true, eta_date, eta_days}, divergence_days, weeks_relative_to_goal, required_daily_deficit_kcal, goal:{...}, note?}`. `calorie_math` only applies to loss goals (positive deficit). OLS uses actual calendar-day spacing so sparse weighers are handled. Needs ≥7 trend_weight rows in last 56 days. `divergence_days` = |OLS ETA − calorie-math ETA| in days (data quality signal). `weeks_relative_to_goal` = positive = ahead, negative = behind the program end_date.

**When to use:** "When will I hit my goal weight?" / pacing check vs deadline.

---

#### `reconcile_energy_balance`
Implied maintenance calories from observed weight change vs MacroFactor's algorithmic TDEE.

| Param | Type | Default |
|---|---|---|
| start_date | YYYY-MM-DD (optional) | 28 days ago |
| end_date | YYYY-MM-DD (optional) | today |

**Response:** `{window:{start,end,days_with_intake,days_with_tdee,trend_weight_span_days}, avg_intake_kcal, trend_weight_start_kg, trend_weight_end_kg, trend_weight_delta_kg, implied_maintenance_kcal, implied_surplus_kcal_per_day, mf_avg_tdee, gap_kcal, gap_flag:"within_noise"|"meaningful"|"investigate_logging", interpretation}`. Gap flags: ≤200 kcal = within_noise; 200–400 kcal = meaningful; >400 kcal = investigate_logging. Requires ≥14 days trend-weight span AND ≥7 days logged intake in that span. Uses export data only (no live feed).

**When to use:** Logging accuracy check, suspected under-logging, validating whether MF's TDEE model is calibrated for this user.

---

#### `day_of_week_patterns`
Nutrition and adherence grouped by calendar weekday.

| Param | Type | Default |
|---|---|---|
| start_date | YYYY-MM-DD (optional) | 90 days ago |
| end_date | YYYY-MM-DD (optional) | today |

**Response:** `{range, days_analyzed, days_with_target, weekdays:[{weekday, n, avg_calories, avg_protein, avg_target_calories, avg_calorie_surplus, calorie_on_target_rate_pct, protein_hit_rate_pct, cumulative_surplus, surplus_share_pct}], highest_leverage_day, note}`. Sorted by `avg_calorie_surplus` descending. `surplus_share_pct` = this weekday's share of the total absolute surplus (the single most impactful day to fix). `calorie_on_target` = within ±5%; `protein_hit` = ≥95%.

**When to use:** Identifying which day of the week causes the most surplus ("you're overshooting every Saturday").

---

#### `get_nutrient_timing`
Macros averaged by six time-of-day windows.

| Param | Type | Default |
|---|---|---|
| start_date | YYYY-MM-DD (optional) | 14 days ago |
| end_date | YYYY-MM-DD (optional) | today |

Buckets: `fasted` 00–06, `morning` 06–10, `midday` 10–14, `afternoon` 14–17, `evening` 17–21, `late` 21–24.

**Response:** `{period:{start,end}, days_with_food_data, note, buckets:[{bucket, hours, days_with_data, total_entries, avg_per_day:{calories,protein,carbs,fat,entries}}]}`. `avg_per_day` divides by `days_with_food_data` (all days with any food); use `days_with_data` for an "on-days-I-ate-in-this-window" view. Log time = when recorded in MacroFactor; retroactively added items skew late. Items with a matched `intended_time` hint are bucketed at actual eat-time.

**When to use:** Checking peri-workout protein timing, late-night eating patterns, pre-bed carb windows.

---

#### `detect_stall`
Weight-loss plateau classifier with metabolic adaptation estimate.

| Param | Type | Default |
|---|---|---|
| recent_days | int (optional) | 14 |
| medium_days | int (optional) | 28 |

**Response:** `{as_of, recent_days, medium_days, stall_threshold_kg_per_week:0.10, goal:{...}, rates:{recent_kg_per_week,recent_span_days,medium_kg_per_week,medium_span_days}, is_plateaued:bool, classification, stall_duration_days, adaptation:{tdee_at_goal_start_kcal,tdee_recent_kcal,actual_tdee_drop_kcal,expected_tdee_drop_from_weight_loss_kcal,adaptation_kcal,population_approximation_note}, flags:{no_active_goal,insufficient_recent_data,no_tdee_baseline}}`. Classifications: `plateaued` / `on-track` / `adapting-but-losing` / `slower-than-goal-but-not-stalled` / `off-direction` / `unknown`. `adaptation_kcal` = actual TDEE drop − expected (22 kcal/kg × weight lost). Positive adaptation_kcal indicates metabolic adaptation beyond what weight loss alone predicts. 22 kcal/kg is a population approximation.

**When to use:** "Is my client in a stall?" When weight hasn't moved in a few weeks. Differentiates true plateau from slower-than-optimal progress.

---

#### `micro_gap_analysis`
Average micronutrient intake vs NIH DRI (adult male 19–50).

| Param | Type | Default |
|---|---|---|
| days | int 1–365 (optional) | 28 |

**Response:** `{window_days, start_date, end_date, days_with_data, results:[{nutrient, avg_per_day, tracked_days, unit, rda, pct_rda, status:"deficient"|"borderline"|"adequate"|"excess"}], excluded_suspect_days?:{<nutrient>: <days_excluded>}, note}`. Sorted: deficient first, then borderline, adequate, excess. `avg_per_day` averaged over `tracked_days` only. Nutrients absent from export are omitted (not zero). `excess` only shown when a Tolerable Upper Intake Level is defined. `excluded_suspect_days` present when implausible values were excluded.

**When to use:** Quarterly micronutrient check, fiber intake, identifying consistent deficiencies. Use `days:90` for a quarterly view.

---

#### `get_training_day_nutrition`
Nutrition stratified by training-load tier (rest / light / moderate / heavy).

| Param | Type | Default |
|---|---|---|
| start_date | YYYY-MM-DD (optional) | 60 days ago |
| end_date | YYYY-MM-DD (optional) | today |
| detail | "days" (optional) | — |

Tiers: `rest` (0 sets), `light` (1–10 sets), `moderate` (11–20 sets), `heavy` (21+ sets). Set count from `workout_sets` table (all set types including warm-ups). **MacroFactor-logged sets only:** externally logged training (classes, wearable-only sessions) is invisible here, so externally-trained days classify as `rest` — the `rest` tier conflates true rest days with them. Valid mainly when all lifting is logged in MacroFactor; do NOT use it to assess fueling on externally-trained days.

**Response:** `{range, note, tier_definitions, per_tier:{rest:{day_count,avg_calories,avg_protein,avg_carbs,avg_fat,avg_expenditure,avg_target_calories,avg_target_protein,avg_cal_vs_target,avg_pro_vs_target,days_with_target,days_with_nutrition}, light:{...}, moderate:{...}, heavy:{...}}, delta_analysis:{heavy_vs_rest_actual_kcal,heavy_vs_rest_programmed_kcal,delta_proportional,light_vs_rest_actual_kcal,...,note}, units, per_day?:[...]}`. `delta_proportional:true` means the user's actual heavy-vs-rest calorie delta ≥ programmed delta. Nutrition from export only.

**When to use:** Checking if the user actually eats more on heavy training days vs what the program prescribes.

---

#### `get_pr_alerts`
Personal record achievements detected since the last export upload.

| Param | Type | Default |
|---|---|---|
| since_date | YYYY-MM-DD (optional) | 30 days ago |

**Response:** `{since, count, alerts:[{detected_at, exercise, metric, value, prev_value?, set_date, pct_gain?}], bottleneck_kpi:{front_squat:{exercise, e1rm_kg, date}, back_squat:{exercise, e1rm_kg, date}, front_to_back_pct, note}, note}`. `detected_at` is epoch milliseconds (the field is NOT named `detected_at_ms`); `prev_value` and `pct_gain` are omitted on first-ever records for an exercise/metric. Metrics: `e1rm_kg` (Epley), `heaviest_kg`, `best_set_volume_kg`, plus `best_duration_s` / `best_distance_m` for timed/distance exercises. `bottleneck_kpi` = the CURRENT front-squat:back-squat e1RM ratio (bar load only, recomputed live on every call — present whenever both lifts have logged sets, regardless of whether an alert fired). Checked automatically on every export upload and once daily via cron.

**When to use:** Weekly review, congratulating PRs. Complements `get_prs` (all-time bests) with recency and prev_value context.

---

### WRITES

---

#### `search_food`
Name search across the user's saved foods (export), USDA FoodData Central and Open Food Facts.

| Param | Type |
|---|---|
| query | string (required) |
| sources | ("saved"\|"usda"\|"off")[] — default all |
| limit | int 1–25 per source (default 6) |
| data_types | USDA data types; add "Survey (FNDDS)" for typical prepared dishes |
| brand | USDA brand-owner filter |

**Response:** `{query, saved: [{source, name, brand?, saved_as, serving, per_serving, log_with}], usda: [{source, id, name, brand?, category?, serving?, per_serving?, per_100g}], off: [...same...], errors: {}, hint?, next}`. `per_100g` / `per_serving` carry energy (kcal), protein, carbs, fat, fiber, sugars, sodium (mg), saturatedFat.

**When to use:** First step for any food the user hasn't saved. Chain-restaurant items are NOT in these sources — web-search the chain's nutrition page and use `log_food` with explicit nutrients.

---

#### `get_food_nutrients`
Full nutrient dictionary for a `search_food` / `lookup_barcode` hit, scaled to an amount.

| Param | Type |
|---|---|
| source | "usda" \| "off" (required) |
| id | fdcId or barcode (required) |
| grams | number — amount eaten (mL for liquids) |
| servings | number — label/household servings (default 1 when grams omitted) |
| portion | string — pick a portion by (partial) description, e.g. "cup" |

**Response:** `{source, id, name, brand?, category?, amount, amount_basis, nutrients, per_100g, portions: [{description, grams}], ingredients?, log_food_args: {name, brand?, serving, nutrients, barcode?}, note}`. `nutrients` uses MacroFactor keys/units and is scaled to `amount`.

**When to use:** Between `search_food` and `log_food`; pass `log_food_args` straight through (add icon / notes / llm_prompt).

---

#### `lookup_barcode`
UPC/EAN → product with label nutrients (Open Food Facts, then USDA Branded).

| Param | Type |
|---|---|
| barcode | string (required) |
| grams, servings | as in get_food_nutrients |

**Response:** same shape as `get_food_nutrients`, or `{status:"not_found", barcode, errors, message}`.

---

#### `search` / `fetch`
ChatGPT-connector-shaped wrappers. `search(query)` → `{results: [{id, title, url}]}` with ids like `usda:<fdcId>`, `off:<barcode>`, `saved:<name>`. `fetch(id)` → `{id, title, text, url, metadata}` where `metadata` is the `get_food_nutrients` row (or the saved food's per-serving macros). Prefer `search_food` / `get_food_nutrients` when the client exposes all tools.

---

#### `log_food`
Log ONE food. Flat macro fields OR a full `nutrients` dictionary (dictionary wins).

| Param | Type | Required |
|---|---|---|
| name | string | yes |
| calories | number (kcal) | unless `nutrients.energy` |
| protein / carbs / fat / fiber / sugar / saturated_fat / alcohol_g | number (g) | no |
| sodium_mg / caffeine_mg | number (mg) | no |
| nutrients | {energy, protein, …, vitaminD, …} — official MacroFactor keys/units | no |
| serving | "one" (default) \| "per100Grams" \| "per100ML" \| {amount, unit} \| {amount, label, weight} | no |
| icon | MacroFactor icon name (guessed from the name when omitted) | no |
| brand, barcode, notes, llm_prompt | string | no |
| beverage | "alcohol" \| "beverage" | no |
| recipe | [{name, calories \| nutrients, …}] component breakdown (parent summed when calories omitted) | no |
| intended_time | "HH:MM" (24h) | no |

With serving `"one"` the nutrients are the totals for the portion eaten; with a measured/custom serving they describe that amount (`weight` = grams represented). The payload is validated against the official schema before queueing; an invalid one returns `{status:"invalid", message}` without queueing.

**Returns:** `{status: "sent"|"queued_only"|"push_failed", message, logged_as: {name, brand?, icon, serving, macros}, queue_id}`.

**When to use:** Any food with known/estimated nutrients that isn't a saved food. Put the breakdown and the source of the numbers in `notes`, the user's original words in `llm_prompt`.

---

#### `log_saved_food`
Log a saved Favorite/Custom food by name, scaling by servings.

| Param | Type | Required |
|---|---|---|
| food | string (name or partial) | yes |
| servings | number | no (default 1) |
| exact | boolean | no |
| source | "favorite"\|"custom"\|"history" | no |
| intended_time | "HH:MM" (24h) | no |

`servings` multiplies the saved serving size (e.g. a favorite saved as 1 bowl / 250 kcal → `servings:2` logs 2 bowls / 500 kcal). Returns `ambiguous` with candidates if >1 match; use `exact:true` + `source:` to disambiguate. Returns `no_stored_macros` if match has no calories. Returns `not_found` if no match.

**Returns:** Match status + scaled macro summary + dispatch message.

---

#### `log_recipe`
One entry whose nutrients are the SUM of its ingredients, each attached as a complete child food in `recipe[]`.

| Param | Type |
|---|---|
| name | string (required) |
| ingredients | [{name, calories \| nutrients, protein, …, serving?, icon?, brand?, notes?}] 1–30 (required) |
| icon, brand, serving, notes, llm_prompt, intended_time | as in log_food |

**Returns:** `{status, message, components: [{name, macros}], queue_id}`.

**When to use:** Home-cooked meals, or restaurant items built from published components (bread + meat + cheese).

---

#### `relog_meal`
Re-log a past date's food log aggregated into one entry.

| Param | Type | Required |
|---|---|---|
| date | YYYY-MM-DD | yes |
| start_hour | int 0–23 | no (whole day) |
| end_hour | int 0–23 (exclusive) | no |
| meal_name | string | no |
| intended_time | "HH:MM" (24h) | no |

Aggregates all food_log items for `date` (optionally filtered to `[start_hour, end_hour)`) into a flat summed entry. Meal label auto-inferred from `start_hour`: 05–10 = Breakfast, 11–14 = Lunch, 15–17 = Snack, ≥18 = Dinner. Logs at current tap-time (cannot backdate).

**Returns:** Aggregate summary (item_count, names, totals) + dispatch message.

---

#### `log_foods_batch`
1–30 foods as SEPARATE entries in one sync. Each item takes the same fields as `log_food` (plus `intended_time`). Items are validated and enqueued atomically (one D1 batch) to `pending_food`; one notification fires.

**Returns:** `{status, count, message, items: [{name, icon, macros}], queue_ids}`.

---

#### `log_water`
Log water intake.

| Param | Type | Required |
|---|---|---|
| ml | number (positive) | yes |

Convert before calling: 1 US fl oz ≈ 30 mL, 1 cup ≈ 240 mL, 1 L = 1000 mL. Uses `PUSHCUT_WATER_WEBHOOK_URL` and "MF Log Water" Shortcut. Rounded to nearest mL.

**Returns:** Status message with mL amount.

---

#### `log_weight`
Log a body weight reading.

| Param | Type | Required |
|---|---|---|
| kg | number | yes |
| unit | "kg"\|"lbs" | no (default "kg") |

Pass `unit:"lbs"` for automatic server-side conversion (÷ 2.20462). Uses `PUSHCUT_WEIGHT_WEBHOOK_URL` and "MF Log Weight" Shortcut.

**Returns:** Status message with kg value (after conversion).

---

### QUEUE MANAGEMENT

---

#### `get_pending_logs`
Show everything queued across all four write queues + recent dispatch history.

No params.

**Response:** `{food:[{id,name,calories,queued_ago}], water:[{id,ml,queued_ago}], weight:[{id,kg,queued_ago}], batches:[{id,item_count,claimed,queued_ago,items:[<names>]}], total_pending, recent_dispatches:[{name,calories,served_ago,landed:bool,landed_ago?}], note}`. `recent_dispatches` covers last 24 h. `landed:true` = confirmed in MacroFactor. `landed:false` = phone pulled it, no confirmation received.

**When to use:** After any log_* call to confirm dispatch status. Before a session if unsure what's pending.

---

#### `cancel_pending_log`
Delete queued entries so they will NOT be logged.

| Param | Type | Default |
|---|---|---|
| queue | "food"\|"water"\|"weight"\|"batch"\|"all" | "all" |

Safe to call even if queue is empty. For `batch`, also clears claimed-but-not-yet-acked rows (batch that Shortcut has started but not finished). Returns per-queue deleted counts.

**When to use:** User says "never mind" / "cancel" / "don't log that" immediately after any log_* call. Call before the user taps the notification.

---

## 5. Changed since the 21-tool doc

The previous doc described 21 tools based on an earlier version. The following changes have occurred:

### New tools (15 added)

| Tool | Added |
|---|---|
| `get_day` | 2026-07-01 — single-date composite (nutrition+food+training+weight+targets) |
| `get_pending_logs` | 2026-07-01 — queue status + dispatch history with landed:bool |
| `forecast_weight` | 2026-07-01 — OLS + calorie-math ETA to goal weight |
| `reconcile_energy_balance` | 2026-07-01 — implied maintenance vs MF TDEE, logging accuracy signal |
| `day_of_week_patterns` | 2026-07-01 — weekday nutrition patterns + surplus_share_pct |
| `get_nutrient_timing` | 2026-07-01 — 6-bucket time-of-day macro breakdown |
| `detect_stall` | 2026-07-01 — plateau classifier + metabolic adaptation estimate |
| `micro_gap_analysis` | 2026-07-01 — average micros vs NIH DRI, deficient/borderline/adequate/excess |
| `get_training_day_nutrition` | 2026-07-01 — nutrition by rest/light/moderate/heavy training tier |
| `get_pr_alerts` | 2026-07-01 — PR achievements detected on export upload / daily cron |
| `log_recipe` | 2026-07-01 — multi-ingredient meal with recipe[] children |
| `relog_meal` | 2026-07-01 — re-log a past date's food aggregated into one entry |
| `log_foods_batch` | 2026-07-01 — 1–20 items in a single phone tap via batch queue |
| `get_steps` | pre-existing on the server (daily step counts) — was missing from the previous doc |
| `log_weight` | 2026-07-01 — weight queue → /pending-weight → "MF Log Weight" Shortcut |

### Reshaped tools

**`get_weight_history`** — now returns `{entries:[...], note}` instead of a bare array. Code consuming the response must access `.entries`.

**`search_my_foods`** — now returns `{loggable:[...], name_only:[...]}` instead of a flat list. `loggable` = has stored macros; `name_only` = history/custom without macros.

**`get_today`** — default is now **compact** (calories/protein/carbs/fat + targets + diffs). Pass `detail:"full"` to restore every nutrient (`consumed_all`) and MacroFactor's raw remaining goals (`remaining_raw`). Also accepts a `date` param (not just today).

**`get_micronutrients`** — default is now **curated** (~33 nutrients with NIH reference intakes or common-interest status). Pass `detail:"full"` for every export column. `nutrients:["magnesium"]` for targeted filter.

**`get_training_volume`** — added `detail:"daily"` param for per-date-per-muscle raw rows.

**`get_exercise_progress`** — now returns TWO views (`exercises` for MF-computed + `barbell` for bar-load-only); added `all:true` param; added `*_lb` fields for pound-configured exercises; series capped at 30 points by default.

**`get_workouts`** — added `*_lb` fields (weight_lb, volume_lb, top_set.weight_lb) for pound-configured exercises; added `display_unit:"lb"` flag on exercise object.

**`get_prs`** — added `e1rm_lb`, `heaviest_lb`, `best_set_volume_lb` for pound-configured exercises.

**`weekly_summary`** — added `avg_alcohol_g_per_day`, `drinking_days`, `actual_span_days`, `coverage_note`, `tdee_drift_kcal`, and per-muscle volume to each window.

**`log_food` / `log_saved_food` / `log_recipe` / `relog_meal` / `log_foods_batch`** — all accept `intended_time:"HH:MM"` to correct nutrient-timing analytics after the next export. `log_food` / `log_foods_batch` also accept `alcohol_g`, `caffeine_mg`, and `beverage:"alcohol"|"beverage"`.

**`get_pending_logs`** — `recent_dispatches` now includes `landed:bool` (confirmed via /today ack step) and `landed_ago` (when the ack arrived).

**`cancel_pending_log`** — previously only cleared the food queue; now targets any of food/water/weight/batch/all.

### Removed / renamed

No tools were removed. All 21 tools from the previous doc are present.

### Changed 2026-07-06

**`get_workouts` / `get_prs` / `get_pr_alerts`** — timed, distance, and assisted sets are no longer dropped: set rows expose `duration_s` / `distance_m` / `distance_km` / `base_weight_kg` when logged, `get_prs` reports `best_duration_s` / `best_distance_m` bests for those exercises, and PR alerts can fire on the new metrics. Nothing changes for pure barbell data — responses are byte-identical until a timed/distance set is logged.

**NEW: `weekly_review`** — the weekly-check-in bundle (`weekly_summary` + `get_pr_alerts` + `day_of_week_patterns`) in one call, sharing one end date. Use it in place of the three-call sequence in the weekly-review playbook.

**NEW: `get_goal_history`** — every weight goal with planned-vs-actual (trend-weight change, duration, realized rate vs `original_eta_days`). `get_targets` still shows only the active goal.

**`get_pr_alerts`** — now always carries `bottleneck_kpi` (current front-squat:back-squat e1RM ratio, bar load, recomputed live) when both lifts have logged sets.

**`get_adherence` / `weekly_summary`** — adherence now aggregates `avg_carb_diff` / `avg_fat_diff` (g/day vs target), quantifying the macro-split gap that used to require summing per-day rows.

**`get_targets`** — new `week:true` param returns all seven weekday target rows of the governing program in one call.

### Doc corrections (2026-07-05)

Response shapes for `weekly_summary`, `get_adherence`, `get_prs`, `data_status`, and `get_body_metrics` were previously documented wrong (flat arrays / phantom fields / wrong wrappers) and have been corrected against the live server. Also fixed: the micronutrient default-set count (25 NIH-RDA + 4 extras = 29 total, not "29 RDA / ~33"), `get_pr_alerts`'s timestamp field name (`detected_at`, not `detected_at_ms`), `get_today`'s export-fallback field omissions, and a new warning that `get_training_day_nutrition` tiers count MacroFactor-logged sets only (externally logged training reads as `rest`).


---

## 6. Changed in the jamesj64 fork (2026-09-02)

- **Food search:** `search_food`, `get_food_nutrients`, `lookup_barcode` (USDA FoodData Central + Open Food Facts + saved foods); `search` / `fetch` for ChatGPT connectors.
- **Full official schema on writes:** `log_food` / `log_foods_batch` / `log_recipe` accept `nutrients` (all 55 MacroFactor keys), `serving` objects, `icon`, `barcode`, `llm_prompt`, `recipe[]`; payloads are validated before queueing. Recipe children are complete MacroFactorFood objects.
- **One Shortcut:** `GET /pending-all` + `POST /sync-ack` replace the five per-type Shortcuts; one Pushcut notification (`PUSHCUT_WEBHOOK_URL`). `log_foods_batch` now queues individual `pending_food` rows. Claimed rows are re-served after 10 min without an ack.
- **Live today from every sync:** `/sync-ack` stores the Today Summary MacroFactor returns from Log by JSON.
- **Config:** `USER_TZ` and `MF_SOURCE` are `wrangler.jsonc` vars; `USDA_API_KEY` secret. `PUSHCUT_WATER/WEIGHT/BATCH_WEBHOOK_URL` removed.
- **Apple Health hint:** the MCP instructions, `data_status` (`alternative_sources`), `get_daily_nutrition` and `get_weight_history` tell the agent that MacroFactor also syncs daily energy/macros and body weight to Apple Health, so an Apple Health tool in the client can fill gaps when export data is stale.
- **Tests:** `npm test` validates payloads against MacroFactor's official sample JSON; `scripts/local-e2e.mjs` exercises the whole write path against `npm run dev` without a phone.
