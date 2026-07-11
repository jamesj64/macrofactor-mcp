-- MacroFactor MCP — D1 schema
-- Run with:  npm run db:init   (remote)  /  npm run db:init:local
--
-- Shape matches MacroFactor's spreadsheet export: per-day summary sheets (keyed by date)
-- merged into `days`, all micronutrients per day in `micronutrients`, and the food
-- library (Favorites / Custom Foods / History) in `food_library`.

CREATE TABLE IF NOT EXISTS days (
  date         TEXT PRIMARY KEY,   -- YYYY-MM-DD
  calories     REAL,
  protein      REAL,
  carbs        REAL,
  fat          REAL,
  expenditure  REAL,               -- MacroFactor calculated TDEE
  scale_weight REAL,               -- raw scale weight (kg)
  fat_percent  REAL,               -- body fat % (if logged)
  trend_weight REAL,               -- smoothed trend weight (kg)
  steps        REAL,
  alcohol_g    REAL
);

CREATE TABLE IF NOT EXISTS micronutrients (
  date    TEXT PRIMARY KEY,        -- YYYY-MM-DD
  payload TEXT                     -- JSON: { "Fiber (g)": 20, "Sodium (mg)": 2701, ... }
);

-- Saved foods with macros — used by search_my_foods to reuse known values when logging.
CREATE TABLE IF NOT EXISTS food_library (
  name             TEXT,
  brand            TEXT,
  source           TEXT,           -- 'favorite' | 'custom' | 'history'
  serving_size     TEXT,
  serving_qty      REAL,
  serving_weight_g REAL,
  calories         REAL,
  protein          REAL,
  fat              REAL,
  carbs            REAL
);
CREATE INDEX IF NOT EXISTS idx_food_library_name ON food_library(name);

-- Individual food-log items (from MacroFactor's separate Food Log CSV export).
CREATE TABLE IF NOT EXISTS food_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  date             TEXT NOT NULL,   -- YYYY-MM-DD
  time             TEXT,            -- HH:MM (24h)
  name             TEXT,
  serving_size     TEXT,
  serving_qty      REAL,
  serving_weight_g REAL,
  calories         REAL,
  protein          REAL,
  carbs            REAL,
  fat              REAL
);
CREATE INDEX IF NOT EXISTS idx_food_log_date ON food_log(date);

-- Live "today" feed from MacroFactor's official Today-Summary Apple Shortcut, POSTed to
-- /today straight from the phone — so the current day stays fresh without a full export.
-- One row per date (upserted); `consumed`/`remaining`/`raw` keep the verbatim payload
-- (MacroFactorTodaySummary: consumed.energy is kcal, other nutrients g/mg/mcg; sparse).
CREATE TABLE IF NOT EXISTS today_summary (
  date       TEXT PRIMARY KEY,   -- YYYY-MM-DD (caller's local date, else server UTC)
  calories   REAL,               -- consumed.energy (kcal)
  protein    REAL,               -- consumed.protein (g)
  carbs      REAL,               -- consumed.carbs (g)
  fat        REAL,               -- consumed.fat (g)
  consumed   TEXT,               -- JSON: verbatim `consumed` block (all nutrients incl. micros)
  remaining  TEXT,               -- JSON: verbatim `remaining` block (per-nutrient goal deltas)
  raw        TEXT,               -- JSON: verbatim full posted payload
  updated_at INTEGER,            -- unix ms of the last POST (for staleness)
  source     TEXT
);

-- Outgoing log_food requests waiting for the iPhone Shortcut to pull from GET /pending.
CREATE TABLE IF NOT EXISTS pending_food (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  created INTEGER NOT NULL,         -- unix ms
  payload TEXT NOT NULL            -- MacroFactorFood JSON string
);

-- Outgoing log_water requests waiting for the "MF Log Water" Shortcut to pull from
-- GET /pending-water (bare mL number → MacroFactor's dedicated "Log Water" action).
CREATE TABLE IF NOT EXISTS pending_water (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  created INTEGER NOT NULL,         -- unix ms
  ml      INTEGER NOT NULL         -- amount in milliliters (always rounded to a whole number)
);

-- Nutrition program targets (from the workbook's "Nutrition Program Settings" sheet).
-- One row per program-snapshot (program_date) x weekday; supports calorie/macro cycling.
-- Effective target for a date D = row from the latest program_date <= D matching D's weekday.
CREATE TABLE IF NOT EXISTS nutrition_targets (
  program_date     TEXT,           -- YYYY-MM-DD the program took effect
  weekday          TEXT,           -- 'Monday' .. 'Sunday'
  calories         REAL,
  protein          REAL,
  carbs            REAL,
  fat              REAL,
  expenditure      REAL,           -- program's expenditure estimate
  daily_average    REAL,           -- week's average calorie target
  weight           REAL,           -- program reference weight (kg)
  expenditure_mode TEXT            -- 'Dynamic' | 'Static' | ...
);
CREATE INDEX IF NOT EXISTS idx_nutrition_targets_date ON nutrition_targets(program_date);

-- Weight goal(s) (from the workbook's "Weight Goals" sheet).
CREATE TABLE IF NOT EXISTS weight_goals (
  goal                  TEXT,      -- 'Maintenance' | 'Lose' | 'Gain' | ...
  status                TEXT,      -- 'In Progress' | 'Completed' | ...
  start_date            TEXT,      -- YYYY-MM-DD
  end_date              TEXT,
  goal_weight           REAL,      -- kg
  goal_rate_pct         REAL,      -- % bodyweight per week
  starting_scale_weight REAL,
  starting_trend_weight REAL,
  original_eta_days     REAL,
  checkpoint_date       TEXT,
  checkpoint_weight     REAL,
  ending_scale_weight   REAL,
  ending_trend_weight   REAL
);

-- Per-set workout detail (from MacroFactor's separate Workout Log CSV export).
CREATE TABLE IF NOT EXISTS workout_sets (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  date               TEXT NOT NULL, -- YYYY-MM-DD
  workout            TEXT,          -- e.g. 'Push Pull Legs (Workout A)'
  exercise           TEXT,
  set_index          INTEGER,       -- 1-based order within (date, workout, exercise)
  set_type           TEXT,          -- 'Standard Set' | 'Warm-Up' | ...
  weight_kg          REAL,
  reps               REAL,
  rir                REAL,          -- reps in reserve
  base_weight_kg     REAL,
  duration_s         REAL,          -- for timed exercises
  distance_m         REAL,
  distance_km        REAL,
  workout_duration_s REAL           -- whole-session duration (repeated per set)
);
CREATE INDEX IF NOT EXISTS idx_workout_sets_date ON workout_sets(date);
CREATE INDEX IF NOT EXISTS idx_workout_sets_ex ON workout_sets(exercise);

-- MacroFactor's per-day, per-muscle aggregates (from "Muscle Groups - Sets/Volume" sheets).
CREATE TABLE IF NOT EXISTS muscle_volume (
  date      TEXT,                   -- YYYY-MM-DD
  muscle    TEXT,                   -- 'Quads' | 'Glutes' | ...
  sets      REAL,                   -- working sets (fractional: partial muscle credit)
  volume_kg REAL                    -- tonnage (kg)
);
CREATE INDEX IF NOT EXISTS idx_muscle_volume_date ON muscle_volume(date);

-- MacroFactor's per-day, per-exercise computed metrics (from "Exercises - *" sheets).
CREATE TABLE IF NOT EXISTS exercise_metrics (
  date     TEXT,                    -- YYYY-MM-DD
  exercise TEXT,
  metric   TEXT,                    -- '1RM'|'3RM'|'10RM'|'total_volume'|'best_set_volume'|
                                    -- 'heaviest_weight'|'total_reps'|'best_set_reps'|'total_sets'
  value    REAL
);
CREATE INDEX IF NOT EXISTS idx_exercise_metrics ON exercise_metrics(exercise, metric, date);

-- Body measurements + visual body-fat (from the workbook's "Body Metrics" sheet). Sparse: one
-- row per date you measured. `measurements` is a JSON dict of the non-null circumference columns
-- (e.g. {"Waist (cm)": 81, ...}); `visual_body_fat` is MacroFactor's visual body-fat assessment.
CREATE TABLE IF NOT EXISTS body_metrics (
  date            TEXT PRIMARY KEY,  -- YYYY-MM-DD
  visual_body_fat REAL,
  measurements    TEXT               -- JSON dict of non-null measurement columns
);

-- Planned training program(s) (from the workbook's "Training Programs" sheet). One row per
-- program; the nested cycle/workout/exercise/set plan is stored as JSON (see parse.ts/parseProgram).
CREATE TABLE IF NOT EXISTS training_programs (
  program TEXT PRIMARY KEY,          -- program name, e.g. 'Push Pull Legs'
  meta    TEXT,                      -- JSON: {Cycles, Deload, Color, Icon, ...}
  plan    TEXT                       -- JSON: [{cycle, block, schedule:[{day,type,exercises:[...]}]}]
);

-- ===== Enhancement tables (2026-07-01) =====

-- Outgoing log_weight requests waiting for the "MF Log Weight" Shortcut to pull from
-- GET /pending-weight (bare kg REAL -> MacroFactor's confirmed "Log Weight" action).
CREATE TABLE IF NOT EXISTS pending_weight (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  created INTEGER NOT NULL,          -- unix ms
  kg      REAL NOT NULL              -- weight in kilograms (3 decimal places, e.g. 75.456)
);

-- Outgoing log_foods_batch requests. One row per batch. Items are a JSON array of
-- MacroFactorFood objects (same shape as pending_food.payload). claimed_at is set by
-- GET /pending-batch so the iOS Shortcut can ack after its Repeat loop; NULL = unclaimed.
-- Stale claimed rows (claimed_at older than 10 min) are re-served on the next GET.
CREATE TABLE IF NOT EXISTS pending_batch (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created    INTEGER NOT NULL,       -- unix ms
  items      TEXT    NOT NULL,       -- JSON array of MacroFactorFood objects
  item_count INTEGER NOT NULL,       -- denormalized length; avoids parsing items for status queries
  claimed_at INTEGER                 -- unix ms; NULL = unclaimed; set on GET /pending-batch
);

-- Audit log of every successful /upload-export import. Used for idempotency (skip
-- re-processing an identical upload) and to answer "did I already upload today?".
CREATE TABLE IF NOT EXISTS import_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created     INTEGER NOT NULL,      -- unix ms when the upload was received
  file_type   TEXT NOT NULL,         -- 'workbook' | 'food_log' | 'workout_log'
  fingerprint TEXT NOT NULL,         -- SHA-256 hex of the raw upload bytes
  counts      TEXT NOT NULL          -- JSON: row counts per table, e.g. {"days":365,...}
);
CREATE INDEX IF NOT EXISTS idx_import_log_type ON import_log(file_type, created);

-- Stored all-time bests per exercise per metric. Updated on every PR check.
CREATE TABLE IF NOT EXISTS pr_baseline (
  exercise TEXT NOT NULL,
  metric   TEXT NOT NULL,            -- 'e1rm_kg' | 'heaviest_kg' | 'best_set_volume_kg'
  value    REAL NOT NULL,
  set_date TEXT,                     -- YYYY-MM-DD of the set that achieved this value
  PRIMARY KEY (exercise, metric)
);

-- Append-only log of new personal records detected by checkAndUpdatePrs.
CREATE TABLE IF NOT EXISTS pr_alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  detected_at INTEGER NOT NULL,      -- unix ms when the Worker detected it
  exercise    TEXT NOT NULL,
  metric      TEXT NOT NULL,
  value       REAL NOT NULL,         -- new all-time best
  prev_value  REAL,                  -- previous best; NULL on first sighting
  set_date    TEXT,                  -- YYYY-MM-DD of the set
  pct_gain    REAL                   -- (value-prev)/prev*100 rounded 1dp; NULL when prev_value NULL
);
CREATE INDEX IF NOT EXISTS idx_pr_alerts_detected ON pr_alerts(detected_at);

-- Covering index for the all-time PR scans (getPrs / checkAndUpdatePrs / weekly recent_prs).
CREATE INDEX IF NOT EXISTS idx_workout_sets_pr
  ON workout_sets(exercise, weight_kg DESC, reps) WHERE weight_kg IS NOT NULL AND reps IS NOT NULL;

-- Per-exercise app settings (from the workbook's "Exercise Settings" sheet). weight_unit is the
-- unit the user LOGS in ("Pounds"/"Kilograms") — the export silently converts to kg.
CREATE TABLE IF NOT EXISTS exercise_settings (
  exercise    TEXT PRIMARY KEY,
  weight_unit TEXT,
  raw         TEXT               -- JSON of the remaining sheet columns
);

-- Audit trail of foods served to the phone (popped from pending_food) and whether the
-- Shortcut confirmed them landed (ack via POST /today?ack_id=). Enables get_pending_logs
-- to answer "did my log actually land?".
CREATE TABLE IF NOT EXISTS food_dispatch_log (
  pending_id   INTEGER PRIMARY KEY,
  name         TEXT,
  calories     REAL,
  served_at_ms INTEGER NOT NULL,
  landed_at_ms INTEGER
);

-- Intended eat-times for queued foods (writes always log at tap-time; MacroFactor has no
-- backdate). Matched to exported food_log rows on import so timing analytics can use the
-- INTENDED time instead of the tap time.
CREATE TABLE IF NOT EXISTS food_intent_log (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  queued_at_ms          INTEGER NOT NULL,
  date                  TEXT NOT NULL,      -- UTC date at queue time
  name                  TEXT NOT NULL,
  calories              REAL,
  intended_time         TEXT NOT NULL,      -- HH:MM (24h, user-local)
  matched_exported_time TEXT,
  status                TEXT NOT NULL DEFAULT 'pending'  -- pending|matched|ambiguous|expired
);
