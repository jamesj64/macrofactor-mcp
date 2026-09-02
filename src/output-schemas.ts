// Output schemas (MCP `outputSchema`) for every tool, so clients can show models the shape of a
// result. Shapes were taken from real responses (scripts/introspect-outputs.mjs). They are
// deliberately LOOSE — every field optional, nested analytics as open objects — because the SDK
// validates each response against its schema and a too-strict schema would turn a good answer into
// a tool error. Array-returning tools are wrapped as { items, count } (structuredContent must be an
// object).

import { z } from "zod";

const num = z.number().nullable().optional();
const int = z.number().int().nullable().optional();
const str = z.string().nullable().optional();
const bool = z.boolean().nullable().optional();
const any = z.unknown().optional();
const anyObj = z.record(z.string(), z.unknown()).nullable().optional();
const anyList = z.array(z.unknown()).optional();
const list = <T extends z.ZodRawShape>(shape: T) => z.array(z.looseObject(shape)).optional();
const obj = <T extends z.ZodRawShape>(shape: T) => z.looseObject(shape).nullable().optional();

const nutrientMap = z.record(z.string(), z.unknown()).optional().describe("MacroFactor nutrient keys → value (energy kcal; g / mg / mcg)");
const macros4 = { calories: num, protein: num, carbs: num, fat: num };

// Fields every tool may add (validation messages, hints).
const common = { message: str, error: str, note: str, hint: str, status: str };

const foodHit = {
  source: z.enum(["usda", "off"]).optional(),
  id: str,
  name: str,
  brand: str,
  category: str,
  serving: str.describe("label serving, e.g. '1 cup (36 g)'"),
  per_serving: nutrientMap,
  per_100g: nutrientMap,
};

const foodDetail = {
  ...common,
  source: str,
  id: str,
  name: str,
  brand: str,
  category: str,
  amount: str.describe("what `nutrients` is scaled to, e.g. '1 × 1 cup (36 g)'"),
  amount_basis: str,
  nutrients: nutrientMap,
  per_100g: nutrientMap,
  portions: list({ description: str, grams: num }),
  ingredients: str,
  barcode: str,
  log_food_args: anyObj.describe("ready to pass to log_food: name, brand?, serving, nutrients, barcode?"),
  errors: anyObj,
};

const dayRow = {
  date: str, ...macros4, expenditure: num, scale_weight: num, fat_percent: num, trend_weight: num, steps: num,
  alcohol_g: num, live: bool, source: str, updated_at: str, suspect: any,
};

const wrapped = <T extends z.ZodRawShape>(shape: T, what: string) => ({
  items: z.array(z.looseObject(shape)).optional().describe(what),
  count: int,
  ...common,
});

const logResult = { ...common, queue_id: int, queue_ids: z.array(z.number()).optional(), logged_as: anyObj, items: anyList, components: anyList, candidates: anyList, matches: anyList };

// Each schema is a LOOSE object (additionalProperties: true in the emitted JSON schema) so neither the
// server nor a validating client rejects a response that carries an extra field.
const L = <T extends z.ZodRawShape>(shape: T) => z.looseObject(shape);

export const OUT: Record<string, z.ZodObject<any>> = {
  // ---- reads ----
  get_daily_nutrition: L(wrapped(dayRow, "one row per day")),
  get_micronutrients: L(wrapped({ date: str, suspect: anyObj }, "one row per day; other keys are export column names like 'Fiber (g)', 'Sodium (mg)'")),
  get_food_log: L(wrapped(
    { date: str, time: str, name: str, serving_size: str, serving_qty: num, serving_weight_g: num, ...macros4, suspect: anyList, intended_time: str },
    "individual logged foods",
  )),
  get_weight_history: L({
    entries: list({ date: str, scale_weight: num, scale_weight_lb: num, trend_weight: num, trend_weight_lb: num, fat_percent: num, method_change_suspected: bool }),
    ...common,
  }),
  get_expenditure: L(wrapped({ date: str, expenditure: num, calories: num, scale_weight: num, trend_weight: num }, "one row per day")),
  get_steps: L(wrapped({ date: str, steps: num }, "one row per day")),
  search_my_foods: L({
    loggable: list({ name: str, brand: str, source: str, serving_size: str, serving_qty: num, serving_weight_g: num, calories: num, protein: num, fat: num, carbs: num }),
    name_only: list({ name: str, source: str }),
    ...common,
  }),
  data_status: L({
    days: anyObj, micronutrients: anyObj, food_log: anyObj, food_library: anyObj, nutrition_targets: anyObj,
    workout_sets: anyObj, exercise_metrics: anyObj, today_live: anyObj, last_import: anyObj, alternative_sources: str, ...common,
  }),
  get_today: L({
    date: str, live: bool, is_current_day: bool, updated_at: str, updated_ago: str, source: str,
    consumed: obj(macros4), alcohol_g: num, target: obj(macros4), remaining_to_target: obj(macros4), vs_target: anyObj,
    consumed_all: nutrientMap, remaining_raw: anyObj, ...common,
  }),
  get_day: L({ date: str, weekday: str, nutrition: anyObj, food_log: anyList, weight: anyObj, steps: num, target: anyObj, vs_target: anyObj, workouts: anyList, adherence: any, ...common }),
  get_targets: L({ date: str, weekday: str, target: anyObj, week: anyList, weight_goal: anyObj, staleness: anyObj, ...common }),
  get_goal_history: L({ count: int, goals: anyList, ...common }),
  get_adherence: L({ range: anyObj, summary: anyObj, days: anyList, ...common }),
  weekly_summary: L({ as_of: str, is_partial_today: bool, goal: anyObj, windows: anyObj.describe("'7d' | '14d' | '28d' → window digest"), recent_prs: anyList, ...common }),
  weekly_review: L({ as_of: str, weekly_summary: anyObj, pr_alerts: anyObj, day_of_week_patterns: anyObj, ...common }),
  get_training_volume: L({ range: anyObj, training_days: int, basis: str, per_muscle: anyList, daily: anyList, ...common }),
  get_exercise_progress: L({ range: anyObj, basis: str, exercises: anyList, barbell: anyList, ...common }),
  get_workouts: L({ range: anyObj, sessions: anyList, units_note: str, ...common }),
  get_prs: L({ exercises: anyList, method: str, ...common }),
  get_body_metrics: L({ range: anyObj, units: str, entries: anyList, ...common }),
  get_program: L({ count: int, programs: anyList, ...common }),
  forecast_weight: L({ as_of: str, data_window_days: int, data_points: int, ols_regression: anyObj, calorie_math: anyObj, goal: anyObj, divergence: any, ...common }),
  reconcile_energy_balance: L({ implied_maintenance_kcal: num, mf_avg_tdee: num, gap_kcal: num, gap_flag: str, interpretation: str, ...common }),
  day_of_week_patterns: L({ range: anyObj, days_analyzed: int, days_with_target: int, weekdays: anyList, highest_leverage_day: str, ...common }),
  get_nutrient_timing: L({ period: anyObj, days_with_food_data: int, buckets: anyList, ...common }),
  detect_stall: L({
    as_of: str, recent_days: int, medium_days: int, stall_threshold_kg_per_week: num, goal: anyObj, rates: anyObj,
    is_plateaued: bool, classification: str, stall_duration_days: int, adaptation: anyObj, ...common,
  }),
  micro_gap_analysis: L({ window_days: int, start_date: str, end_date: str, days_with_data: int, results: anyList, ...common }),
  get_training_day_nutrition: L({ range: anyObj, tier_definitions: anyObj, per_tier: anyObj, delta_analysis: anyObj, units: str, days: anyList, ...common }),
  get_pr_alerts: L({ since: str, count: int, alerts: anyList, bottleneck_kpi: any, ...common }),

  // ---- food search ----
  search_food: L({ query: str, saved: anyList, usda: list(foodHit), off: list(foodHit), errors: anyObj, next: str, ...common }),
  get_food_nutrients: L(foodDetail),
  lookup_barcode: L(foodDetail),
  search: L({ results: list({ id: str, title: str, url: str }) }),
  fetch: L({ id: str, title: str, text: str, url: str, metadata: anyObj }),

  // ---- writes ----
  log_food: L(logResult),
  log_saved_food: L(logResult),
  log_recipe: L(logResult),
  relog_meal: L({ ...logResult, entry: str, items_aggregated: int, totals: obj(macros4) }),
  log_foods_batch: L({ ...logResult, count: int }),
  log_water: L({ ...common }),
  log_weight: L({ ...common }),
  refresh_from_phone: L({ ...common }),
  get_pending_logs: L({ food: anyList, water: anyList, weight: anyList, batches: anyList, total_pending: int, recent_dispatches: anyList, ...common }),
  cancel_pending_log: L({ cancelled: anyObj, ...common }),
};
