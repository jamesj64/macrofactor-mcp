import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

import * as db from "./db";
import {
  DEFAULT_SOURCE, buildFoodPayload, buildRecipePayload, foodItemShape, intendedTimeField, macroSummary,
  recipeChildShape, validateFoodPayload, type LogFoodArgs,
} from "./nutrients";
import { type MacroFactorFood, type Nutrients } from "./mf-schema";
import {
  getFoodDetail, getOFFProduct, headline, nutrientsFor, resolveAmount, searchOFF, searchUSDA,
  type FoodDetail, type FoodHit,
} from "./foodsearch";
import { handleIngest } from "./ingest";
import { ImportDO } from "./importer";

export { ImportDO };

export interface Env {
  DB: D1Database;
  MCP_OBJECT: DurableObjectNamespace;
  IMPORT_DO: DurableObjectNamespace;
  INGEST_SECRET: string;
  MCP_TOKEN?: string;
  PUSHCUT_WEBHOOK_URL?: string;     // one notification → runs the "MF Sync" Shortcut
  PUSHCUT_PR_WEBHOOK_URL?: string;  // optional "new PR" alert
  USDA_API_KEY?: string;            // optional; DEMO_KEY (30 req/h) without it
  MF_SOURCE?: string;               // `source` stamped on every Log by JSON payload
  USER_TZ?: string;                 // IANA zone that defines "today"
}

const READ_ONLY = { readOnlyHint: true } as const;
const WRITE_HINT = { readOnlyHint: false, destructiveHint: true } as const;

function text(obj: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof obj === "string" ? obj : JSON.stringify(obj, (_k, v) => (v === null ? undefined : v)),
      },
    ],
  };
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

const dateRange = {
  start_date: z.string().optional().describe("YYYY-MM-DD"),
  end_date: z.string().optional().describe("YYYY-MM-DD"),
};

type PushStatus = "queued_only" | "sent" | "push_failed";
interface PushResult { status: PushStatus; detail?: string }

// Ping the phone: one pre-configured Pushcut notification whose action runs the "MF Sync"
// Shortcut. The push carries NO dynamic fields (that needs Pushcut Pro) — everything is already
// queued in D1 and the Shortcut pulls it from /pending-all after the tap.
async function notifyPhone(env: Env): Promise<PushResult> {
  const url = env.PUSHCUT_WEBHOOK_URL;
  if (!url) return { status: "queued_only" };
  try {
    const res = await fetch(url, { method: "POST" });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 150);
      return { status: "push_failed", detail: `${res.status}: ${body}` };
    }
    return { status: "sent" };
  } catch (err) {
    // Network-level failure (DNS / timeout / dropped). The rows are already queued, so surface the
    // recoverable push_failed path rather than throwing a raw MCP error with no recovery hint.
    return { status: "push_failed", detail: String(err).slice(0, 150) };
  }
}

// Queue one or more validated MacroFactorFood payloads (+ optional intended eat-times) and ping
// the phone once.
async function queueFoods(
  env: Env,
  payloads: MacroFactorFood[],
  intendedTimes: (string | undefined)[] = [],
): Promise<PushResult & { ids: number[] }> {
  const now = Date.now();
  const ids = await db.enqueueFoods(env.DB, payloads.map((p) => JSON.stringify(p)), now);
  for (let i = 0; i < payloads.length; i++) {
    const t = intendedTimes[i];
    if (t) await db.recordFoodIntent(env.DB, payloads[i].name, payloads[i].nutrients.energy ?? null, t, now);
  }
  const r = await notifyPhone(env);
  return { ...r, ids };
}

// Human-facing result message for queued item(s), given the push status.
function foodMsg(label: string, r: PushResult): string {
  if (r.status === "queued_only") {
    return (
      `Queued ${label}. The phone push isn't configured yet — set the PUSHCUT_WEBHOOK_URL secret and build the ` +
      `"MF Sync" iPhone Shortcut (see ios-setup.md). Until then it waits on the server; running MF Sync by hand ` +
      `(or "Hey Siri, sync MacroFactor") logs it.`
    );
  }
  if (r.status === "push_failed") {
    return (
      `Queued ${label}, but the Pushcut notification failed (${r.detail}). ` +
      `Run the "MF Sync" Shortcut manually (or via Siri) to log it.`
    );
  }
  return (
    `Sent ${label} to your phone. Tap the MacroFactor notification (or say "Hey Siri, sync MacroFactor") to log it — ` +
    `confirm with get_pending_logs (landed:true) or get_today.`
  );
}

// Compact listing row for search results.
function hitRow(h: FoodHit) {
  return {
    source: h.source,
    id: h.id,
    name: h.name,
    ...(h.brand ? { brand: h.brand } : {}),
    ...(h.category ? { category: h.category } : {}),
    ...(h.serving ? { serving: `${h.serving.description} (${h.serving.grams} g)` } : {}),
    ...(h.per_serving ? { per_serving: h.per_serving } : {}),
    per_100g: h.per100g,
  };
}

// Full detail for get_food_nutrients / fetch: nutrients scaled to the requested amount, plus a
// ready-to-paste log_food argument object.
function detailRow(d: FoodDetail, want: { grams?: number; servings?: number; portion?: string }) {
  const amt = resolveAmount(d, want);
  const nutrients = nutrientsFor(d, amt.grams);
  return {
    source: d.source,
    id: d.id,
    name: d.name,
    ...(d.brand ? { brand: d.brand } : {}),
    ...(d.category ? { category: d.category } : {}),
    amount: amt.label,
    amount_basis: amt.basis,
    nutrients,
    per_100g: headline(d.per100g),
    portions: d.portions.slice(0, 12),
    ...(d.ingredients ? { ingredients: d.ingredients } : {}),
    log_food_args: {
      name: d.brand ? `${d.name} (${d.brand})` : d.name,
      ...(d.brand ? { brand: d.brand } : {}),
      serving: amt.serving,
      nutrients,
      ...(d.barcode ? { barcode: d.barcode } : {}),
    },
    note:
      "`nutrients` is scaled to `amount` (energy kcal; g/mg/mcg per MacroFactor units). Pass `log_food_args` " +
      "straight to log_food (add icon/notes/llm_prompt), or re-call with grams/servings/portion to rescale.",
  };
}

const MCP_INSTRUCTIONS = `MacroFactor nutrition + training server for one user. Reads come from the app's export (and a live
today feed); writes are queued and land in MacroFactor only after the user taps a notification on their iPhone
(or runs the "MF Sync" Shortcut / asks Siri). Logs always land at the CURRENT time — there is no backdating.

Logging playbook ("add a jersey mike's giant turkey sub, no toppings"):
1. search_my_foods / search_food first — the user's saved foods are the most accurate; USDA + Open Food Facts cover
   generic and packaged foods. Chain-restaurant menus are NOT in any database here: web-search the chain's official
   nutrition page, take the item's components (bread, meat, cheese; drop the toppings the user excluded), and sum them.
2. get_food_nutrients turns a search hit into a scaled nutrient dictionary and a ready log_food_args object.
3. Call log_food (one item) or log_foods_batch (a meal) with: an exact name, brand, a fitting icon, a serving
   ({amount:1, label:"giant sub", weight:<g>} or {amount:<g>, unit:"grams"}), the full nutrients you know (at least
   energy/protein/carbs/fat; add fiber/sugars/sodium/saturatedFat when available), notes = your breakdown + source,
   llm_prompt = the user's original words verbatim. State the numbers you used and any assumptions in your reply.
4. Tell the user to tap the notification; get_today (live) or get_pending_logs (landed:true) confirms it.
Never fabricate precision: if a chain publishes ranges or you estimated, say so in notes and in your reply.
Use get_today for "what's left today", weekly_review for check-ins, cancel_pending_log for "never mind".

Data freshness: history tools read the user's last MacroFactor export (data_status shows its age). The user also
syncs MacroFactor to Apple Health, so if this server's history is empty or stale and your client offers an Apple
Health tool/connector, daily calories, protein, carbs, fat and body weight are usually available there. Prefer this
server for today's live totals, targets/remaining, saved foods, and all logging; use Apple Health only to fill gaps.`;

// Recompute all-time PRs from workout_sets, write any new ones to pr_alerts, and fire the
// "New PR" Pushcut push. Runs in a background context (ctx.waitUntil after /upload-export and
// in scheduled()) — a push failure is non-fatal; PRs are already in D1 for get_pr_alerts.
async function checkAndFirePrAlerts(env: Env): Promise<void> {
  const newPrs = await db.checkAndUpdatePrs(env.DB);
  if (newPrs.length === 0) return;
  const url = env.PUSHCUT_PR_WEBHOOK_URL;
  if (!url) return;
  await fetch(url, { method: "POST" }).catch(() => {});
}

// Infer a meal label from the start hour for relog_meal when none is supplied.
function inferMealLabel(date: string, startHour?: number): string {
  if (startHour == null) return `Meal [${date}]`;
  if (startHour >= 5 && startHour < 11) return `Breakfast [${date}]`;
  if (startHour >= 11 && startHour < 15) return `Lunch [${date}]`;
  if (startHour >= 15 && startHour < 18) return `Snack [${date}]`;
  if (startHour >= 18) return `Dinner [${date}]`;
  return `Meal [${date}]`;
}

export class MyMCP extends McpAgent<Env> {
  server = new McpServer({ name: "MacroFactor", version: "0.2.0" }, { instructions: MCP_INSTRUCTIONS });

  async init() {
    db.setUserTz(this.env.USER_TZ);
    const DB = () => this.env.DB;
    const usdaKey = () => this.env.USDA_API_KEY;
    const buildOpts = () => ({ source: this.env.MF_SOURCE || DEFAULT_SOURCE });

    this.server.registerTool(
      "get_daily_nutrition",
      {
        title: "Daily nutrition totals",
        description:
          "Per-day totals: calories, protein, carbs, fat, expenditure (TDEE), scale & trend weight, " +
          "steps, and alcohol_g (grams of alcohol parsed from your export's Micronutrients sheet; omitted when zero/absent). " +
          "Today is overlaid live from your phone when available (tagged live:true), so it's " +
          "current even if your last export is older. Export days where the reported kcal diverges from " +
          "the 4/4/9/7 macro estimate by >7.5% (min 100 kcal) carry suspect:\"kcal_macro_mismatch\" — " +
          "treat those totals with caution (the live-overlaid current day is never flagged). " +
          "Omit both dates for the last 14 days. Days missing here (no export yet) may be available via an " +
          "Apple Health tool in your client — the user syncs MacroFactor to Apple Health.",
        inputSchema: dateRange,
        annotations: READ_ONLY,
      },
      async ({ start_date, end_date }) => text(await db.getDays(DB(), start_date, end_date)),
    );

    this.server.registerTool(
      "get_micronutrients",
      {
        title: "Daily micronutrients",
        description:
          "Per-day micronutrient totals. Default set: the 25 nutrients with NIH reference intakes (MICRO_RDA keys) " +
          "plus Alcohol (g), Sugars (g), Saturated Fat (g), Caffeine (mg) — 29 total. Pass nutrients=[...] to filter to " +
          "nutrients whose name case-insensitively contains any of the given strings (e.g. ['magnesium','zinc']). " +
          "Pass detail='full' to return every raw export column. " +
          "Physiologically implausible single-day values (likely entry errors) are flagged in a per-day suspect:{} " +
          "object — values are never altered, the flag is additive. Omit both dates for the last 14 days.",
        inputSchema: {
          ...dateRange,
          nutrients: z.array(z.string()).optional().describe(
            "filter to nutrients whose name contains any of these (case-insensitive), e.g. ['magnesium']",
          ),
          detail: z.enum(["full"]).optional().describe(
            "'full' returns every raw export column; default returns the curated 29-nutrient set (25 with reference intakes + 4 extras)",
          ),
        },
        annotations: READ_ONLY,
      },
      async ({ start_date, end_date, nutrients, detail }) =>
        text(await db.getMicronutrients(DB(), start_date, end_date, nutrients, detail)),
    );

    this.server.registerTool(
      "get_food_log",
      {
        title: "Food log (individual items)",
        description:
          "Individual foods you logged, with time, serving size and macros — the meal-by-meal detail. " +
          "Items failing a 4/4/9 kcal-vs-macro consistency check (or protein-bearing foods logged with zero protein) " +
          "carry suspect:[...] — treat those macros with caution. Dates YYYY-MM-DD; pass start_date/end_date for ANY " +
          "range up to full history. Omit both for the last 7 days.",
        inputSchema: dateRange,
        annotations: READ_ONLY,
      },
      async ({ start_date, end_date }) => text(await db.getFoodLog(DB(), start_date, end_date)),
    );

    this.server.registerTool(
      "get_weight_history",
      {
        title: "Body weight history",
        description:
          "Scale weight, trend weight (kg) and body-fat % over time. Returns {entries, note} — entries is the " +
          "array of daily rows; consecutive readings where fat_percent jumps >3 points are tagged " +
          "method_change_suspected:true on the later row (usually a device or estimation-method change, not " +
          "real body-composition change). Omit both dates for the last 60 days. Body weight is also synced to " +
          "Apple Health by MacroFactor, so an Apple Health tool in your client can fill dates missing here.",
        inputSchema: dateRange,
        annotations: READ_ONLY,
      },
      async ({ start_date, end_date }) => text(await db.getWeight(DB(), start_date, end_date)),
    );

    this.server.registerTool(
      "get_expenditure",
      {
        title: "Energy expenditure (TDEE)",
        description:
          "MacroFactor's calculated daily energy expenditure (TDEE) alongside intake and weight. " +
          "Omit both dates for the last 30 days.",
        inputSchema: dateRange,
        annotations: READ_ONLY,
      },
      async ({ start_date, end_date }) => text(await db.getExpenditure(DB(), start_date, end_date)),
    );

    this.server.registerTool(
      "get_steps",
      {
        title: "Daily steps",
        description: "Step count per day. Omit both dates for the last 30 days.",
        inputSchema: dateRange,
        annotations: READ_ONLY,
      },
      async ({ start_date, end_date }) => text(await db.getSteps(DB(), start_date, end_date)),
    );

    this.server.registerTool(
      "search_my_foods",
      {
        title: "Search saved foods",
        description:
          "Find foods from your Favorites / Custom Foods / history by name. Returns loggable (stored per-serving macros — feed straight into log_saved_food) separately from name_only history rows (no stored macros).",
        inputSchema: { query: z.string() },
        annotations: READ_ONLY,
      },
      async ({ query }) => text(await db.searchFoods(DB(), query)),
    );

    this.server.registerTool(
      "data_status",
      {
        title: "Data freshness",
        description:
          "How much data is loaded and its most recent date. Use to check if data is stale. If the export data is " +
          "empty or old, note that the user syncs MacroFactor to Apple Health — an Apple Health tool in your client " +
          "(if any) can supply daily calories/macros and body weight for the gap.",
        inputSchema: {},
        annotations: READ_ONLY,
      },
      async () =>
        text({
          ...(await db.dataStatus(DB())),
          alternative_sources:
            "Daily calories/protein/carbs/fat and body weight are also synced by MacroFactor into Apple Health; if this " +
            "export data is stale or missing and an Apple Health tool is available in your client, use it for those " +
            "series. This server remains the source for today's live totals, targets, saved foods and logging.",
        }),
    );

    this.server.registerTool(
      "get_today",
      {
        title: "Today's live nutrition",
        description:
          "Today's running nutrition totals — the FRESHEST view, pushed straight from your phone " +
          "(MacroFactor's Today-Summary shortcut) independent of your last full export. Returns " +
          "calories/protein/carbs/fat consumed so far, your targets, what's remaining to hit them, " +
          "vs-target diffs, and how long ago it updated. Falls back to the exported daily total if " +
          "nothing has been posted live yet. Default response is compact; pass detail:'full' to also " +
          "receive consumed_all (every nutrient logged today) and remaining_raw (MacroFactor's raw " +
          "remaining goals). Pass date=YYYY-MM-DD or omit for today.",
        inputSchema: {
          date: z.string().optional().describe("YYYY-MM-DD; omit for today"),
          detail: z.enum(["full"]).optional().describe("'full' adds consumed_all (every nutrient today) + remaining_raw"),
        },
        annotations: READ_ONLY,
      },
      async ({ date, detail }) => text(await db.getToday(DB(), date, detail)),
    );

    this.server.registerTool(
      "get_day",
      {
        title: "Full single-day view",
        description:
          "EVERYTHING for one date in one call — nutrition totals (live-overlaid when current, incl. " +
          "alcohol), the item-level food log with suspect flags, workout sessions with sets, weight/trend, " +
          "steps, resolved targets and adherence verdict. " +
          "date=YYYY-MM-DD (omit for today).",
        inputSchema: { date: z.string().optional().describe("YYYY-MM-DD; omit for today") },
        annotations: READ_ONLY,
      },
      async ({ date }) => {
        const d = validIsoDate(date ?? new Date().toISOString().slice(0, 10));
        if (!d) return text("date must be YYYY-MM-DD.");
        return text(await db.getDay(DB(), d));
      },
    );

    this.server.registerTool(
      "get_targets",
      {
        title: "Nutrition targets & weight goal",
        description:
          "Your current calorie/macro targets (from your MacroFactor nutrition program) for a given " +
          "date, plus your active weight goal and progress toward it. Targets can cycle by weekday; " +
          "this resolves the correct one. Pass date=YYYY-MM-DD or omit for today; pass week:true to " +
          "also get ALL SEVEN weekday rows of the governing program in one call (high-day vs rest-day " +
          "contrast without 7 separate calls). " +
          "Includes a staleness block (program age + target-vs-current-TDEE delta) so a changed-but-not-re-exported program is detectable.",
        inputSchema: {
          date: z.string().optional().describe("YYYY-MM-DD; omit for today"),
          week: z.boolean().optional().describe("true = include all 7 weekday target rows of the governing program"),
        },
        annotations: READ_ONLY,
      },
      async ({ date, week }) => text(await db.getTargets(DB(), date, week)),
    );

    this.server.registerTool(
      "get_goal_history",
      {
        title: "Weight-goal history (planned vs actual)",
        description:
          "ALL your MacroFactor weight goals — not just the active one get_targets shows — each with " +
          "planned (rate, original ETA) vs actual (trend-weight change, duration, realized rate) and a " +
          "duration-vs-ETA verdict. In-progress goals run to the latest trend reading. Use for " +
          "bulk/cut/recomp retrospectives and sanity-checking a new goal's rate against history.",
        inputSchema: {},
        annotations: READ_ONLY,
      },
      async () => text(await db.getGoalHistory(DB())),
    );

    this.server.registerTool(
      "get_adherence",
      {
        title: "Intake vs target adherence",
        description:
          "Per-day intake vs your nutrition-program targets: calorie/protein/carb/fat diffs, whether " +
          "each day hit target (calories within ±5%, protein ≥95% of target), plus true energy balance " +
          "(intake − expenditure) with cumulative surplus/deficit and estimated kg change. The summary " +
          "includes avg_carb_diff / avg_fat_diff (g/day vs target) — the macro-split gap, not just calories. " +
          "Omit both dates for the last 30 days.",
        inputSchema: dateRange,
        annotations: READ_ONLY,
      },
      async ({ start_date, end_date }) => text(await db.getAdherence(DB(), start_date, end_date)),
    );

    this.server.registerTool(
      "weekly_summary",
      {
        title: "Rolling weekly summary",
        description:
          "ONE compact digest over rolling 7/14/28-day windows — use this instead of pulling raw daily " +
          "rows. Each window returns: average calories & macros (including avg_alcohol_g_per_day and " +
          "drinking_days count), adherence hit-rates (calories on-target, protein), true energy balance + " +
          "estimated kg change, trend-weight change & rate per week, average TDEE + drift, and training " +
          "volume per muscle + session count. Adherence includes avg_carb_diff / avg_fat_diff (g/day vs " +
          "target — the macro-split gap). Plus your weight goal and any PRs set recently. Windows also " +
          "carry actual_span_days (real calendar span of available data) and a coverage_note when data is " +
          "sparse (fewer days logged than the window size). Omit end_date for through-today; pass windows " +
          "to customize (default 7,14,28). For the full weekly check-in bundle use weekly_review.",
        inputSchema: {
          end_date: z.string().optional().describe("YYYY-MM-DD; omit for today"),
          windows: z.array(z.number()).optional().describe("rolling day-windows; default [7, 14, 28]"),
        },
        annotations: READ_ONLY,
      },
      async ({ end_date, windows }) => text(await db.getWeeklySummary(DB(), end_date, windows)),
    );

    this.server.registerTool(
      "weekly_review",
      {
        title: "One-call weekly review bundle",
        description:
          "The whole weekly check-in in ONE call: weekly_summary (rolling 7/14/28-day windows), " +
          "pr_alerts (PRs detected within the longest window, incl. the front-squat:back-squat " +
          "bottleneck_kpi), and day_of_week_patterns (90-day weekday leverage) — all sharing one end " +
          "date so the views can't drift apart. Use this instead of the three separate calls; add " +
          "your wearable's recovery data for the recovery side.",
        inputSchema: {
          end_date: z.string().optional().describe("YYYY-MM-DD; omit for today"),
          windows: z.array(z.number()).optional().describe("rolling day-windows; default [7, 14, 28]"),
        },
        annotations: READ_ONLY,
      },
      async ({ end_date, windows }) => text(await db.getWeeklyReview(DB(), end_date, windows)),
    );

    this.server.registerTool(
      "get_training_volume",
      {
        title: "Training volume per muscle",
        description:
          "MacroFactor's working sets and tonnage (kg) per muscle group over a date range. " +
          "Use to check weekly volume and muscle balance. NOTE: each exercise is credited to every " +
          "muscle it trains (fractionally), so per-muscle totals overlap and sum to MORE than session " +
          "barbell tonnage; tonnage also includes bodyweight contribution. It's a stimulus measure, not " +
          "bar weight — use get_workouts/get_prs for barbell load. Omit both dates for the last 30 days.",
        inputSchema: { ...dateRange, detail: z.enum(["daily"]).optional().describe("'daily' adds the raw per-date-per-muscle rows") },
        annotations: READ_ONLY,
      },
      async ({ start_date, end_date, detail }) => text(await db.getTrainingVolume(DB(), start_date, end_date, detail)),
    );

    this.server.registerTool(
      "get_exercise_progress",
      {
        title: "Per-exercise strength trends",
        description:
          "MacroFactor's per-exercise computed metrics over time: estimated 1RM/3RM/10RM, heaviest weight, " +
          "total/best-set volume, total/best-set reps, total sets. Filter by exercise (partial name) and/or " +
          "metric. Metric values: 1RM, 3RM, 10RM, total_volume, best_set_volume, heaviest_weight, total_reps, " +
          "best_set_reps, total_sets. Returns TWO views: `exercises` = MacroFactor's metrics (for compound " +
          "lifts the weight/volume ones INCLUDE bodyweight contribution, so a 100 kg front squat can show ~160 kg), " +
          "and `barbell` = the actual bar load from your set log (heaviest/total/best-set volume, with a " +
          "per-date series) for direct comparison. Exercises you log in pounds receive *_lb fields " +
          "(reconstructed ×2.20462). Series are capped at 30 points by default (pass all:true for full " +
          "history). Omit dates for the last 90 days.",
        inputSchema: {
          exercise: z.string().optional().describe("partial exercise name, e.g. 'Squat'"),
          metric: z.string().optional().describe("one metric key, e.g. '1RM' or 'heaviest_weight'"),
          ...dateRange,
          all: z.boolean().optional().describe("return full history series (default: last 30 points per series)"),
        },
        annotations: READ_ONLY,
      },
      async ({ exercise, metric, start_date, end_date, all }) =>
        text(await db.getExerciseProgress(DB(), exercise, metric, start_date, end_date, all)),
    );

    this.server.registerTool(
      "get_workouts",
      {
        title: "Workout sessions (sets & reps)",
        description:
          "Your logged workout sessions with per-exercise sets (weight × reps × RIR), session duration, " +
          "per-exercise volume and top set. Timed/distance/assisted sets carry duration_s / distance_m / " +
          "distance_km / base_weight_kg when logged (carries, holds, rows, bike, assisted dips). Exercises " +
          "you log in pounds receive weight_lb/volume_lb/*_lb fields (reconstructed ×2.20462). " +
          "Omit both dates for the last 30 days.",
        inputSchema: dateRange,
        annotations: READ_ONLY,
      },
      async ({ start_date, end_date }) => text(await db.getWorkouts(DB(), start_date, end_date)),
    );

    this.server.registerTool(
      "get_prs",
      {
        title: "Personal records",
        description:
          "Best lifts per exercise computed from your logged sets: estimated 1RM (Epley), heaviest weight, " +
          "and best single-set volume — each with the set and date achieved. Timed/distance exercises " +
          "(carries, holds, bike) additionally report best_duration_s / best_distance_m bests. Exercises " +
          "you log in pounds receive e1rm_lb, heaviest_lb, best_set_volume_lb fields (reconstructed " +
          "×2.20462). Filter by exercise (partial name).",
        inputSchema: { exercise: z.string().optional().describe("partial exercise name") },
        annotations: READ_ONLY,
      },
      async ({ exercise }) => text(await db.getPrs(DB(), exercise)),
    );

    this.server.registerTool(
      "get_body_metrics",
      {
        title: "Body measurements & visual body-fat",
        description:
          "Your logged body measurements (circumferences in cm) and MacroFactor's visual body-fat " +
          "assessment over time, from the Body Metrics sheet. Sparse — only dates you measured appear. " +
          "For scale/trend weight and body-fat %, use get_weight_history. Omit both dates for the last year.",
        inputSchema: dateRange,
        annotations: READ_ONLY,
      },
      async ({ start_date, end_date }) => text(await db.getBodyMetrics(DB(), start_date, end_date)),
    );

    this.server.registerTool(
      "get_program",
      {
        title: "Training program (planned)",
        description:
          "Your PLANNED MacroFactor training program — the template you're following: cycles, the " +
          "workouts in each, and every exercise's planned sets (set type, rep range, RIR, rest), plus " +
          "scheduled rest days. This is what's PROGRAMMED, not what you logged — use get_workouts for " +
          "completed sessions and get_exercise_progress/get_prs for performance. Optional: filter by " +
          "program name.",
        inputSchema: { program: z.string().optional().describe("partial program name, e.g. 'Strong'") },
        annotations: READ_ONLY,
      },
      async ({ program }) => text(await db.getProgram(DB(), program)),
    );

    // ---- Enhancement read/analytics tools (2026-07-01) ----

    this.server.registerTool(
      "forecast_weight",
      {
        title: "Weight forecast & ETA to goal",
        description:
          "Projects when you will reach your goal weight using two independent methods: " +
          "(1) OLS linear regression on up to 56 days of MacroFactor trend weight (using actual " +
          "calendar day spacing, so sparse weighers are handled correctly); " +
          "(2) calorie-math: avg intake vs avg TDEE over the same window × 7700 kcal/kg (loss goals only). " +
          "Returns both ETAs, the divergence between them (a data-quality signal), r² of the regression, " +
          "weeks ahead/behind your goal deadline, and the required daily deficit for an optional target " +
          "date (loss goals only). Needs at least 7 trend_weight rows in the last 56 days; returns " +
          "error='insufficient_data' with data_points shown when below that threshold.",
        inputSchema: {
          target_date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe(
              "YYYY-MM-DD. If provided, also returns the daily deficit required to hit goal weight by " +
              "this exact date (required_daily_deficit_kcal). Omitted for gain goals.",
            ),
        },
        annotations: READ_ONLY,
      },
      async ({ target_date }) => text(await db.getForecastWeight(DB(), target_date)),
    );

    this.server.registerTool(
      "reconcile_energy_balance",
      {
        title: "Reconcile energy balance",
        description:
          "Inverts the energy-balance equation: derives implied maintenance calories from observed " +
          "trend-weight delta and average logged intake over the trend-weight span, then gaps it against " +
          "MacroFactor's algorithmic TDEE. Returns implied_maintenance_kcal, mf_avg_tdee, gap_kcal, a " +
          "gap_flag ('within_noise'|'meaningful'|'investigate_logging'), and a plain-English interpretation. " +
          "Flags gap >200 kcal as meaningful and >400 kcal as investigate-logging. Requires ≥14 days of " +
          "trend-weight span and ≥7 days of logged intake within that span. Uses finalized export data only. " +
          "Omit both dates for the last 28 days.",
        inputSchema: dateRange,
        annotations: READ_ONLY,
      },
      async ({ start_date, end_date }) => text(await db.reconcileEnergyBalance(DB(), start_date, end_date)),
    );

    this.server.registerTool(
      "day_of_week_patterns",
      {
        title: "Day-of-week nutrition patterns",
        description:
          "Groups ~90 days of nutrition and adherence data by calendar weekday (Monday–Sunday). " +
          "Returns per-weekday averages: calories, protein, avg surplus vs target, on-target rates, " +
          "and each weekday's share of the cumulative weekly caloric surplus — pinpointing the single " +
          "highest-leverage day to improve. Omit both dates for the last 90 days.",
        inputSchema: dateRange,
        annotations: READ_ONLY,
      },
      async ({ start_date, end_date }) => text(await db.getDayOfWeekPatterns(DB(), start_date, end_date)),
    );

    this.server.registerTool(
      "get_nutrient_timing",
      {
        title: "Nutrient timing breakdown by time of day",
        description:
          "Aggregates your food log into six named time-of-day windows — fasted (00–06), morning (06–10), " +
          "midday (10–14), afternoon (14–17), evening (17–21), late (21–24) — and returns average " +
          "calories, protein, carbs, and fat per day for each window, plus meal-entry counts. " +
          "Defaults to the last 14 days. Note: log time reflects when the entry was recorded, " +
          "not necessarily when the food was eaten — retroactively added items may skew late-window totals. " +
          "Items with a matched intended_time hint (from log_food/log_foods_batch) are bucketed at the time they were actually eaten.",
        inputSchema: { ...dateRange },
        annotations: READ_ONLY,
      },
      async ({ start_date, end_date }) => text(await db.getNutrientTimingBuckets(DB(), start_date, end_date)),
    );

    this.server.registerTool(
      "detect_stall",
      {
        title: "Weight-loss stall detector",
        description:
          "Classifies your current weight-loss trajectory as plateaued / on-track / adapting-but-losing / " +
          "slower-than-goal-but-not-stalled / off-direction. Compares recent (default 14-day) and medium " +
          "(default 28-day) trend-weight rates against your active MacroFactor goal rate. Computes metabolic " +
          "adaptation as the gap between your actual TDEE drop and the 22 kcal/kg/day expected from weight " +
          "loss alone (a population approximation). Returns is_plateaued, stall_duration_days, and the full " +
          "rate/adaptation breakdown.",
        inputSchema: {
          recent_days: z.number().int().positive().optional().describe("Window in days for the recent rate (default 14)"),
          medium_days: z.number().int().positive().optional().describe("Window in days for the medium rate (default 28)"),
        },
        annotations: READ_ONLY,
      },
      async ({ recent_days, medium_days }) => text(await db.detectStall(DB(), recent_days, medium_days)),
    );

    this.server.registerTool(
      "micro_gap_analysis",
      {
        title: "Micronutrient gap analysis",
        description:
          "Averages each tracked micronutrient over the last N days (default 28) and compares to NIH " +
          "Dietary Reference Intakes for an adult male 19–50. Returns a ranked list of nutrients with " +
          "status deficient / borderline / adequate / excess and % of RDA. avg_per_day is averaged over " +
          "tracked_days (days that key appeared), not the full window — low tracked_days means sparse data. " +
          "Nutrients absent from your data are omitted (untracked, not zero). Excess status is only shown " +
          "when there is a defined Tolerable Upper Intake Level. Use days=90 for a quarterly view. " +
          "Days with a physiologically implausible value for a given nutrient are excluded from its average and counted in excluded_suspect_days.",
        inputSchema: {
          days: z.number().int().min(1).max(365).optional().describe("Look-back window in days (default 28). Use 90 for a quarterly view."),
        },
        annotations: READ_ONLY,
      },
      async ({ days }) => text(await db.getMicroGapAnalysis(DB(), days)),
    );

    this.server.registerTool(
      "get_training_day_nutrition",
      {
        title: "Nutrition by training load",
        description:
          "Classifies each logged day into a training-load tier based on set count from workout_sets " +
          "(rest = 0 sets / light = 1–10 / moderate = 11–20 / heavy = 21+) and compares average actual " +
          "nutrition (calories, protein, carbs, fat, expenditure) per tier against your MacroFactor program " +
          "targets. Returns per-tier averages, average calorie/protein diffs vs target, and a delta-analysis " +
          "flag: whether you actually eat proportionally more on heavy days vs rest, compared to what the " +
          "program prescribes. Nutrition comes from your last export (not the live /today feed). " +
          "Omit both dates for the last 60 days.",
        inputSchema: { ...dateRange, detail: z.enum(["days"]).optional().describe("'days' adds the per-day classified rows") },
        annotations: READ_ONLY,
      },
      async ({ start_date, end_date, detail }) => text(await db.getTrainingDayNutrition(DB(), start_date, end_date, detail)),
    );

    this.server.registerTool(
      "get_pr_alerts",
      {
        title: "Personal record alerts",
        description:
          "Returns lifts that set a new all-time personal record (e1RM, heaviest weight, best set " +
          "volume, or duration/distance bests for timed exercises) detected since the last export " +
          "upload. Checked automatically on every export upload and once daily via cron. Always " +
          "includes bottleneck_kpi — the current front-squat:back-squat e1RM ratio (bar load) — when " +
          "both lifts have logged sets. Omit since_date for the last 30 days.",
        inputSchema: {
          since_date: z.string().optional().describe("YYYY-MM-DD — only return PRs detected on or after this date"),
        },
        annotations: READ_ONLY,
      },
      async ({ since_date }) => text(await db.getPrAlerts(DB(), since_date)),
    );

    // ---- Food search (external databases + saved foods) ----

    const savedRows = async (query: string, limit: number) => {
      const r = await db.searchFoods(DB(), query);
      return (r.loggable as any[]).slice(0, limit).map((f) => ({
        source: "saved" as const,
        name: f.name,
        ...(f.brand ? { brand: f.brand } : {}),
        saved_as: f.source,
        serving: `${f.serving_qty ?? 1} ${f.serving_size ?? "serving"}`.trim() + (f.serving_weight_g ? ` (${f.serving_weight_g} g)` : ""),
        per_serving: { energy: f.calories, protein: f.protein, carbs: f.carbs, fat: f.fat },
        log_with: "log_saved_food",
      }));
    };

    const runSearch = async (
      query: string,
      sources: ("saved" | "usda" | "off")[],
      limit: number,
      opts: { dataTypes?: string[]; brandOwner?: string } = {},
    ) => {
      const want = new Set(sources);
      const [saved, usda, off] = await Promise.allSettled([
        want.has("saved") ? savedRows(query, limit) : Promise.resolve([]),
        want.has("usda") ? searchUSDA(query, usdaKey(), { limit, ...opts }) : Promise.resolve([] as FoodHit[]),
        want.has("off") ? searchOFF(query, { limit }) : Promise.resolve([] as FoodHit[]),
      ]);
      const errors: Record<string, string> = {};
      const val = <T,>(r: PromiseSettledResult<T>, name: string, empty: T): T => {
        if (r.status === "fulfilled") return r.value;
        errors[name] = String(r.reason?.message ?? r.reason).slice(0, 200);
        return empty;
      };
      return {
        saved: val(saved, "saved", []),
        usda: val(usda, "usda", [] as FoodHit[]).map(hitRow),
        off: val(off, "off", [] as FoodHit[]).map(hitRow),
        errors,
      };
    };

    this.server.registerTool(
      "search_food",
      {
        title: "Search food databases",
        description:
          "Find a food and its macros by name across (1) the user's SAVED MacroFactor foods (Favorites / Custom / history " +
          "from the export — most accurate, log with log_saved_food), (2) USDA FoodData Central (whole foods, generic dishes, " +
          "US packaged foods) and (3) Open Food Facts (packaged products worldwide). Rows carry per-100 g and per-serving " +
          "macros plus an id for get_food_nutrients. NOT covered: chain-restaurant menu items (Jersey Mike's, Chipotle, …) — " +
          "for those, web-search the chain's official nutrition page, build the item from its components, and call log_food " +
          "with explicit nutrients. Search short generic terms ('turkey breast deli', 'provolone'), not sentences.",
        inputSchema: {
          query: z.string().min(1).describe("Food name / keywords"),
          sources: z.array(z.enum(["saved", "usda", "off"])).optional().describe("Default: all three"),
          limit: z.number().int().min(1).max(25).optional().describe("Max rows per source (default 6)"),
          data_types: z
            .array(z.enum(["Foundation", "SR Legacy", "Branded", "Survey (FNDDS)"]))
            .optional()
            .describe("USDA data types (default Foundation, SR Legacy, Branded; add 'Survey (FNDDS)' for typical prepared dishes)"),
          brand: z.string().optional().describe("USDA brand-owner filter, e.g. 'Kraft Heinz'"),
        },
        annotations: READ_ONLY,
      },
      async ({ query, sources, limit, data_types, brand }) => {
        const res = await runSearch(query, sources ?? ["saved", "usda", "off"], limit ?? 6, {
          dataTypes: data_types,
          brandOwner: brand,
        });
        const total = res.saved.length + res.usda.length + res.off.length;
        return text({
          query,
          ...res,
          ...(total === 0
            ? {
                hint:
                  "No matches. Try a shorter/generic query, a different spelling, or sources:['usda'] with data_types " +
                  "['Survey (FNDDS)'] for prepared dishes. For chain restaurants use web search on the chain's nutrition page " +
                  "and log_food with explicit nutrients.",
              }
            : {}),
          next: "Call get_food_nutrients(source, id, grams|servings|portion) for the full nutrient dictionary and a ready log_food_args.",
        });
      },
    );

    this.server.registerTool(
      "get_food_nutrients",
      {
        title: "Full nutrients for a food, scaled to an amount",
        description:
          "Fetch the complete nutrient profile of a search_food / lookup_barcode hit (USDA fdcId or Open Food Facts barcode) " +
          "scaled to the amount eaten — grams (or mL for liquids), a number of label/household servings, or a named portion " +
          "(e.g. 'cup', 'slice') — and return a log_food_args object you can pass straight to log_food. Defaults to one label " +
          "serving when known, else 100 g.",
        inputSchema: {
          source: z.enum(["usda", "off"]),
          id: z.string().min(1).describe("fdcId (usda) or barcode (off)"),
          grams: z.number().positive().optional().describe("Amount eaten in grams (mL for liquids)"),
          servings: z.number().positive().optional().describe("Number of label/household servings eaten (default 1 when grams is omitted)"),
          portion: z.string().optional().describe("Pick a household portion by (partial) description from the food's portions list, e.g. 'cup'"),
        },
        annotations: READ_ONLY,
      },
      async ({ source, id, grams, servings, portion }) => {
        let d: FoodDetail | null;
        try {
          d = await getFoodDetail(source, id, usdaKey());
        } catch (e) {
          return text({ status: "error", message: `${source} lookup failed: ${String((e as Error).message).slice(0, 200)}` });
        }
        if (!d) return text({ status: "not_found", message: `No ${source} food with id ${id}.` });
        return text(detailRow(d, { grams, servings, portion }));
      },
    );

    this.server.registerTool(
      "lookup_barcode",
      {
        title: "Look up a packaged food by barcode",
        description:
          "Resolve a UPC/EAN barcode to a product with label nutrients (Open Food Facts first, then USDA Branded). " +
          "Returns the same shape as get_food_nutrients (one label serving by default; pass grams/servings to rescale).",
        inputSchema: {
          barcode: z.string().min(6).describe("Digits only, e.g. 0049000042566"),
          grams: z.number().positive().optional(),
          servings: z.number().positive().optional(),
        },
        annotations: READ_ONLY,
      },
      async ({ barcode, grams, servings }) => {
        const code = barcode.replace(/\D/g, "");
        const errors: Record<string, string> = {};
        let d: FoodDetail | null = null;
        try {
          d = await getOFFProduct(code);
        } catch (e) {
          errors.off = String((e as Error).message).slice(0, 200);
        }
        if (!d) {
          try {
            const hits = await searchUSDA(code, usdaKey(), { limit: 3, dataTypes: ["Branded"] });
            const exact = hits.find((h) => h.barcode && h.barcode.replace(/^0+/, "") === code.replace(/^0+/, "")) ?? hits[0];
            if (exact) d = await getFoodDetail("usda", exact.id, usdaKey());
          } catch (e) {
            errors.usda = String((e as Error).message).slice(0, 200);
          }
        }
        if (!d) return text({ status: "not_found", barcode: code, errors, message: "No product found for this barcode in Open Food Facts or USDA Branded." });
        return text({ ...detailRow(d, { grams, servings }), ...(Object.keys(errors).length ? { errors } : {}) });
      },
    );

    // ---- OpenAI / ChatGPT connector compatibility ----
    // ChatGPT's connector modes expect two read-only tools named `search` and `fetch` with fixed
    // result shapes (results:[{id,title,url}] / {id,title,text,url,metadata}). Thin wrappers.

    const foodUrl = (source: string, id: string) =>
      source === "usda"
        ? `https://fdc.nal.usda.gov/food-details/${encodeURIComponent(id)}/nutrients`
        : source === "off"
          ? `https://world.openfoodfacts.org/product/${encodeURIComponent(id)}`
          : `macrofactor://saved/${encodeURIComponent(id)}`;

    this.server.registerTool(
      "search",
      {
        title: "Search (connector-style)",
        description:
          "Connector-style food search over the user's saved foods, USDA and Open Food Facts. Returns {results:[{id,title,url}]}; " +
          "pass an id to `fetch` for full nutrients. Prefer search_food when you can call it directly.",
        inputSchema: { query: z.string().min(1) },
        annotations: READ_ONLY,
      },
      async ({ query }) => {
        const res = await runSearch(query, ["saved", "usda", "off"], 5);
        const results: { id: string; title: string; url: string }[] = [];
        for (const f of res.saved) {
          results.push({
            id: `saved:${f.name}`,
            title: `${f.name}${f.brand ? ` (${f.brand})` : ""} — ${f.per_serving.energy ?? "?"} kcal per ${f.serving} [saved]`,
            url: foodUrl("saved", f.name),
          });
        }
        for (const h of [...res.usda, ...res.off]) {
          const e = h.per_serving?.energy ?? h.per_100g.energy;
          const per = h.per_serving ? `per ${h.serving}` : "per 100 g";
          results.push({
            id: `${h.source}:${h.id}`,
            title: `${h.name}${h.brand ? ` (${h.brand})` : ""} — ${e ?? "?"} kcal ${per} [${h.source}]`,
            url: foodUrl(h.source, h.id),
          });
        }
        return text({ results });
      },
    );

    this.server.registerTool(
      "fetch",
      {
        title: "Fetch (connector-style)",
        description:
          "Connector-style document fetch for an id returned by `search` (usda:<fdcId>, off:<barcode>, saved:<name>). " +
          "Returns {id,title,text,url,metadata} where metadata carries the nutrient dictionary and log_food_args.",
        inputSchema: { id: z.string().min(1) },
        annotations: READ_ONLY,
      },
      async ({ id }) => {
        const m = id.match(/^(usda|off|saved):(.+)$/);
        if (!m) return text({ id, title: "Unknown id", text: "Ids look like usda:<fdcId>, off:<barcode> or saved:<name>.", url: "", metadata: {} });
        const [, src, key] = m;
        if (src === "saved") {
          const { loggable } = await db.lookupSavedFood(DB(), key, true);
          const f = loggable[0];
          if (!f) return text({ id, title: "Not found", text: `No saved food named "${key}".`, url: foodUrl("saved", key), metadata: {} });
          const n: Nutrients = { energy: f.calories, protein: f.protein ?? undefined, carbs: f.carbs ?? undefined, fat: f.fat ?? undefined };
          return text({
            id,
            title: f.name,
            text: `${f.name}${f.brand ? ` (${f.brand})` : ""}: ${macroSummary(n)} per ${f.serving_qty ?? 1} ${f.serving_size ?? "serving"}. Log with log_saved_food(food:"${f.name}", exact:true).`,
            url: foodUrl("saved", f.name),
            metadata: { source: "saved", saved_as: f.source, per_serving: n },
          });
        }
        let d: FoodDetail | null = null;
        try {
          d = await getFoodDetail(src as "usda" | "off", key, usdaKey());
        } catch (e) {
          return text({ id, title: "Lookup failed", text: String((e as Error).message).slice(0, 200), url: foodUrl(src, key), metadata: {} });
        }
        if (!d) return text({ id, title: "Not found", text: `No ${src} food with id ${key}.`, url: foodUrl(src, key), metadata: {} });
        const row = detailRow(d, {});
        return text({
          id,
          title: `${d.name}${d.brand ? ` (${d.brand})` : ""}`,
          text: `${row.amount}: ${macroSummary(row.nutrients)}. Portions: ${row.portions.map((p) => `${p.description} = ${p.grams} g`).join("; ") || "n/a"}.`,
          url: foodUrl(d.source, d.id),
          metadata: row,
        });
      },
    );

    // ---- Write tools ----

    const invalid = (e: unknown) => text({ status: "invalid", message: String((e as Error).message) });

    this.server.registerTool(
      "log_food",
      {
        title: "Log a food to MacroFactor",
        description:
          "Log ONE food into MacroFactor at the CURRENT time via the user's iPhone (queued → push notification → one tap, " +
          "or the 'MF Sync' Shortcut / Siri). Cannot backdate. Give EITHER the flat macro fields (calories/protein/carbs/fat/…) " +
          "OR a full `nutrients` dictionary (e.g. from get_food_nutrients.log_food_args); with the default serving \"one\" " +
          "these are the TOTALS for the portion eaten. Fill brand, a fitting icon, a serving with the grams eaten when known, " +
          "notes with the component breakdown + source of the numbers, and llm_prompt with the user's original words. " +
          "Optional recipe[] lists sub-components (parent totals are summed from them when calories is omitted). " +
          "For a food the user has SAVED in MacroFactor prefer log_saved_food; for several foods at once use log_foods_batch.",
        inputSchema: {
          ...foodItemShape,
          recipe: z
            .array(z.object(recipeChildShape))
            .max(30)
            .optional()
            .describe("Optional component breakdown, each with its own nutrients; MacroFactor shows them when the entry is expanded"),
          intended_time: intendedTimeField,
        },
        annotations: WRITE_HINT,
      },
      async (args) => {
        let payload: MacroFactorFood;
        try {
          payload = validateFoodPayload(buildFoodPayload(args as unknown as LogFoodArgs, buildOpts()));
        } catch (e) {
          return invalid(e);
        }
        const r = await queueFoods(this.env, [payload], [args.intended_time]);
        return text({
          status: r.status,
          message: foodMsg(`"${payload.name}"`, r),
          logged_as: { name: payload.name, brand: payload.brand, icon: payload.icon, serving: payload.serving, macros: macroSummary(payload.nutrients) },
          queue_id: r.ids[0],
        });
      },
    );

    this.server.registerTool(
      "log_saved_food",
      {
        title: "Log a saved food by name",
        description:
          "Log one of the user's SAVED foods (a Favorite/Custom food that has stored macros) by name × " +
          "servings, pulling its macros from the food library and scaling them. `servings` multiplies the " +
          "food's saved serving (e.g. a favorite saved as 1 bowl / 250 kcal with servings:2 logs " +
          "2 bowls / 500 kcal). If the name matches MORE THAN ONE saved food it returns " +
          "the candidates WITHOUT logging — pick one and re-call with its exact name and exact:true. If the " +
          "match has no stored macros (history/custom name only) it says so — use log_food with explicit " +
          "macros instead. Logs via the phone (tap to confirm), current time only.",
        inputSchema: {
          food: z.string().describe("Name (or part of the name) of a saved Favorite/Custom food"),
          servings: z.number().optional().describe("Multiples of the saved serving (default 1)"),
          exact: z
            .boolean()
            .optional()
            .describe("Match the saved name exactly (case-insensitive). Use after disambiguation."),
          source: z
            .enum(["favorite", "custom", "history"])
            .optional()
            .describe("Restrict to one source (favorite/custom/history) to break a name tie."),
          llm_prompt: foodItemShape.llm_prompt,
          intended_time: intendedTimeField,
        },
        annotations: WRITE_HINT,
      },
      async ({ food, servings, exact, source, llm_prompt, intended_time }) => {
        const n = servings != null && Number.isFinite(servings) && servings > 0 ? servings : 1;
        const { loggable, nameOnly } = await db.lookupSavedFood(DB(), food, !!exact, source);

        if (loggable.length > 1) {
          return text({
            status: "ambiguous",
            message:
              `"${food}" matches ${loggable.length} saved foods. Pick one and re-call log_saved_food ` +
              `with its exact name and exact:true (optionally also source: to break a tie).`,
            candidates: loggable.map((f) => ({
              name: f.name,
              source: f.source,
              saved_serving: `${f.serving_qty ?? 1} ${f.serving_size ?? "serving"}`.trim(),
              per_serving: { calories: f.calories, protein: f.protein, carbs: f.carbs, fat: f.fat },
            })),
          });
        }
        if (loggable.length === 0) {
          if (nameOnly.length > 0) {
            return text({
              status: "no_stored_macros",
              message:
                `Found ${nameOnly.length} saved item(s) matching "${food}", but they have no stored ` +
                `macros (history / custom name only). Use log_food with explicit macros, or pick a ` +
                `Favorite that has values.`,
              matches: nameOnly.slice(0, 10).map((f) => ({ name: f.name, source: f.source })),
            });
          }
          return text({
            status: "not_found",
            message: `No saved food matches "${food}". Try search_my_foods / search_food, or log_food with explicit macros.`,
          });
        }

        const f = loggable[0];
        const r1 = (x: number) => Math.round(x * 10) / 10;
        const qty = f.serving_qty != null ? r1((f.serving_qty as number) * n) : n;
        const weight = f.serving_weight_g != null ? r1((f.serving_weight_g as number) * n) : undefined;
        const scaled: LogFoodArgs = {
          name: n !== 1 ? `${f.name} ×${n}` : f.name,
          brand: f.brand ?? undefined,
          calories: Math.round((f.calories as number) * n),
          protein: f.protein != null ? r1((f.protein as number) * n) : undefined,
          carbs: f.carbs != null ? r1((f.carbs as number) * n) : undefined,
          fat: f.fat != null ? r1((f.fat as number) * n) : undefined,
          // Custom serving when we know the grams, so MacroFactor can rescale it later.
          serving: weight && f.serving_size ? { amount: qty, label: String(f.serving_size), weight } : "one",
          llm_prompt,
        };
        let payload: MacroFactorFood;
        try {
          payload = validateFoodPayload(buildFoodPayload(scaled, buildOpts()));
        } catch (e) {
          return invalid(e);
        }
        const r = await queueFoods(this.env, [payload], [intended_time]);

        const baseServing = `${f.serving_qty ?? 1} ${f.serving_size ?? "serving"}`.trim();
        const effServing = f.serving_qty != null ? `${qty} ${f.serving_size ?? "serving"}`.trim() : `${n}× saved serving`;
        return text({
          status: r.status,
          message: `${foodMsg(`"${scaled.name}"`, r)} (${n}× "${f.name}" [saved as ${baseServing}] → ${effServing}: ${macroSummary(payload.nutrients)})`,
          queue_id: r.ids[0],
        });
      },
    );

    this.server.registerTool(
      "log_recipe",
      {
        title: "Log a recipe (multi-ingredient meal) to MacroFactor",
        description:
          "Log a named meal as ONE entry with a recipe[] breakdown of its ingredients: the entry's nutrients are the " +
          "sum of the ingredients and MacroFactor can show the components when expanded. Good for home-cooked meals and " +
          "for restaurant items you built from published components (bread + meat + cheese …). Logs via the phone " +
          "(tap to confirm), current time only.",
        inputSchema: {
          name: z.string().describe("Meal/recipe name, e.g. 'Chicken stir-fry'"),
          ingredients: z
            .array(z.object(recipeChildShape))
            .min(1)
            .max(30)
            .describe("Ingredients with the nutrients of the portion eaten (flat fields or a nutrients dictionary each)"),
          icon: foodItemShape.icon,
          brand: foodItemShape.brand,
          serving: foodItemShape.serving,
          notes: foodItemShape.notes,
          llm_prompt: foodItemShape.llm_prompt,
          intended_time: intendedTimeField,
        },
        annotations: WRITE_HINT,
      },
      async ({ name, ingredients, icon, brand, serving, notes, llm_prompt, intended_time }) => {
        let payload: MacroFactorFood;
        try {
          payload = validateFoodPayload(
            buildRecipePayload(name, ingredients as unknown as LogFoodArgs[], { icon, brand, serving, notes, llm_prompt }, buildOpts()),
          );
        } catch (e) {
          return invalid(e);
        }
        const r = await queueFoods(this.env, [payload], [intended_time]);
        return text({
          status: r.status,
          message: `${foodMsg(`"${name}"`, r)} (${ingredients.length} ingredients → ${macroSummary(payload.nutrients)})`,
          components: payload.recipe?.map((c) => ({ name: c.name, macros: macroSummary(c.nutrients) })),
          queue_id: r.ids[0],
        });
      },
    );

    this.server.registerTool(
      "relog_meal",
      {
        title: "Re-log a past meal to MacroFactor",
        description:
          "Aggregates food items from a past date's log (optionally filtered to a time-of-day window) " +
          "into a single flat entry and queues it for logging via the iPhone Shortcut. Useful for repeating " +
          "a meal you ate on a previous day. All macros (calories, protein, carbs, fat) are summed across " +
          "matching log items. The entry logs at the CURRENT time — MacroFactor has no backdate field. " +
          "Examples: date='2026-06-28' logs the entire day; add start_hour=12 end_hour=14 to isolate lunch.",
        inputSchema: {
          date: z.string().describe("YYYY-MM-DD — the date to pull the meal from (usually a past date)"),
          start_hour: z
            .number().int().min(0).max(23).optional()
            .describe("Include only items logged at or after this hour (0–23, e.g. 12 for noon). Omit for whole day."),
          end_hour: z
            .number().int().min(0).max(23).optional()
            .describe("Include only items logged before this hour (exclusive, e.g. 14 to cap at 2 pm). Omit for whole day."),
          meal_name: z
            .string().optional()
            .describe("Override the entry name, e.g. 'Lunch'. Auto-inferred from start_hour if omitted."),
          intended_time: intendedTimeField,
        },
        annotations: WRITE_HINT,
      },
      async ({ date, start_hour, end_hour, meal_name, intended_time }) => {
        const isoDate = validIsoDate(date);
        if (!isoDate) return text("date must be YYYY-MM-DD.");
        if (start_hour != null && end_hour != null && start_hour >= end_hour) {
          return text("start_hour must be less than end_hour.");
        }

        const agg = await db.getFoodLogAggregate(this.env.DB, isoDate, start_hour, end_hour);
        if (!agg) {
          const windowNote =
            start_hour != null || end_hour != null
              ? ` between hours ${start_hour ?? 0}–${end_hour ?? 24}`
              : "";
          return text(`No food log items found for ${isoDate}${windowNote}.`);
        }

        const label = meal_name?.trim() || inferMealLabel(isoDate, start_hour);
        const r1 = (x: number) => Math.round(x * 10) / 10;
        const payload = validateFoodPayload(
          buildFoodPayload(
            {
              name: label,
              calories: Math.round(agg.calories),
              protein: r1(agg.protein),
              carbs: r1(agg.carbs),
              fat: r1(agg.fat),
              icon: "plateQuickAdd",
              notes: `Re-logged from ${isoDate}: ${agg.names.join(", ")}`,
            },
            buildOpts(),
          ),
        );

        const r = await queueFoods(this.env, [payload], [intended_time]);
        return text({
          status: r.status,
          message: foodMsg(`"${label}"`, r),
          entry: label,
          items_aggregated: agg.item_count,
          totals: { calories: Math.round(agg.calories), protein: r1(agg.protein), carbs: r1(agg.carbs), fat: r1(agg.fat) },
          items: agg.names,
          queue_id: r.ids[0],
        });
      },
    );

    this.server.registerTool(
      "log_foods_batch",
      {
        title: "Log multiple foods to MacroFactor (batch)",
        description:
          "Log 1–30 foods as SEPARATE MacroFactor entries in a single phone tap — a full meal, a photo-estimated plate, " +
          "or any multi-item log. Each item takes the same fields as log_food (flat macros or a nutrients dictionary, " +
          "serving, icon, brand, notes, llm_prompt). Logs at the current time — cannot backdate.",
        inputSchema: {
          items: z
            .array(z.object({ ...foodItemShape, intended_time: intendedTimeField }))
            .min(1)
            .max(30)
            .describe("Foods to log together. Each item is the nutrients for the portion eaten."),
        },
        annotations: WRITE_HINT,
      },
      async ({ items }) => {
        const payloads: MacroFactorFood[] = [];
        try {
          for (const item of items) payloads.push(validateFoodPayload(buildFoodPayload(item as unknown as LogFoodArgs, buildOpts())));
        } catch (e) {
          return invalid(e);
        }
        const r = await queueFoods(this.env, payloads, items.map((i) => i.intended_time));
        return text({
          status: r.status,
          count: payloads.length,
          message: foodMsg(`${payloads.length} foods`, r),
          items: payloads.map((p) => ({ name: p.name, icon: p.icon, macros: macroSummary(p.nutrients) })),
          queue_ids: r.ids,
        });
      },
    );

    this.server.registerTool(
      "log_water",
      {
        title: "Log water to MacroFactor",
        description:
          "Log a water intake amount (in MILLILITERS) to MacroFactor via the user's iPhone using " +
          "MacroFactor's dedicated Log Water action (credits the hydration ring). Same tap/Shortcut as food. " +
          "Convert other units to mL before calling (1 US fl oz ≈ 30 mL, 1 cup ≈ 240 mL, 1 L = 1000 mL). " +
          "Logs at the current time (cannot backdate).",
        inputSchema: {
          ml: z.number().describe("Amount of water in milliliters, e.g. 500"),
        },
        annotations: WRITE_HINT,
      },
      async ({ ml }) => {
        const amount = Math.round(ml);
        if (!(Number.isFinite(amount) && amount > 0)) {
          return text("Water amount must be a positive number of milliliters.");
        }
        await db.enqueueWater(this.env.DB, amount, Date.now());
        const r = await notifyPhone(this.env);
        return text({ status: r.status, message: foodMsg(`${amount} mL of water`, r) });
      },
    );

    this.server.registerTool(
      "log_weight",
      {
        title: "Log body weight to MacroFactor",
        description:
          "Log a body weight reading to MacroFactor via the user's iPhone using MacroFactor's dedicated " +
          "Log Weight Shortcuts action. Same tap/Shortcut as food. Pass kg directly, " +
          "or pass lbs with unit='lbs' for server-side conversion (÷ 2.20462). " +
          "Logs at the current time (cannot backdate).",
        inputSchema: {
          kg: z.number().describe(
            "Weight value. Interpreted as kg unless unit='lbs', in which case it is the pound " +
            "value and will be converted to kg server-side (÷ 2.20462).",
          ),
          unit: z.enum(["kg", "lbs"]).optional().describe("Unit of the value. Default: 'kg'."),
        },
        annotations: WRITE_HINT,
      },
      async ({ kg, unit }) => {
        const rawKg = unit === "lbs" ? kg / 2.20462 : kg;
        const weightKg = Math.round(rawKg * 1000) / 1000;
        if (!(Number.isFinite(weightKg) && weightKg > 0 && weightKg < 700)) {
          return text("Weight must be a positive finite number (< 700 kg).");
        }
        await db.enqueueWeight(this.env.DB, weightKg, Date.now());
        const r = await notifyPhone(this.env);
        return text({ status: r.status, message: foodMsg(`${weightKg} kg${unit === "lbs" ? ` (${kg} lb)` : ""}`, r) });
      },
    );

    this.server.registerTool(
      "get_pending_logs",
      {
        title: "Queued (not-yet-confirmed) logs",
        description:
          "Everything currently queued for the phone (food / water / weight) with names, ages and whether the phone has " +
          "already claimed it — i.e. logs the user has requested but NOT yet confirmed by tapping. Pairs with cancel_pending_log. " +
          "recent_dispatches shows the last 24h of foods the phone pulled and whether each was confirmed landed.",
        inputSchema: {},
        annotations: READ_ONLY,
      },
      async () => text(await db.getPendingLogs(DB())),
    );

    this.server.registerTool(
      "cancel_pending_log",
      {
        title: "Cancel pending food/water/weight logs",
        description:
          "Deletes queued log entries so they will NOT be sent to MacroFactor. Call this immediately " +
          "when the user says 'never mind', 'cancel', 'undo', or 'don't log that' after a " +
          "log_food/log_water/log_weight/log_foods_batch call. Clears anything queued and not yet synced " +
          "(a sync already running on the phone may still land). The optional queue param targets a specific " +
          "queue; omit it (or pass 'all') to clear everything. Returns counts of what was deleted.",
        inputSchema: {
          queue: z
            .enum(["food", "water", "weight", "batch", "all"])
            .optional()
            .describe("'food', 'water', 'weight', 'batch', or 'all' (default). Omit to cancel everything."),
        },
        annotations: WRITE_HINT,
      },
      async ({ queue = "all" }) => {
        const queues: ("food" | "water" | "weight" | "batch")[] =
          queue === "all" ? ["food", "water", "weight", "batch"] : [queue as "food" | "water" | "weight" | "batch"];
        const counts = await db.cancelPending(this.env.DB, queues);
        const total = counts.food + counts.water + counts.weight + counts.batch;
        if (total === 0) {
          return text({ cancelled: counts, message: "No pending logs found — the queue was already empty." });
        }
        const parts: string[] = [];
        if (counts.food > 0) parts.push(`${counts.food} food`);
        if (counts.water > 0) parts.push(`${counts.water} water`);
        if (counts.weight > 0) parts.push(`${counts.weight} weight`);
        if (counts.batch > 0) parts.push(`${counts.batch} batch`);
        return text({
          cancelled: counts,
          message:
            `Cancelled ${parts.join(", ")} pending log${total > 1 ? "s" : ""}. ` +
            `Nothing will be logged on the next MF Sync.`,
        });
      },
    );
  }
}

// GET /pending?token=<INGEST_SECRET>
// Returns (and removes) the oldest queued food as a MacroFactorFood JSON object, so the
// iPhone Shortcut can feed it straight to "Log by JSON". 204 when nothing is queued.
async function handlePending(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!env.INGEST_SECRET || token !== env.INGEST_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }
  const row = await db.popPendingFood(env.DB);
  if (!row) return new Response("", { status: 204 });
  // Audit is best-effort: the pending row is already popped, so a dispatch-log failure must
  // never 500 the response — the food would be lost without ever reaching Log by JSON.
  try {
    await db.recordDispatch(env.DB, row.id, row.payload, Date.now());
  } catch {}
  const food = JSON.parse(row.payload);
  food._pending_id = row.id; // MacroFactor's Log by JSON ignores unknown fields
  return new Response(JSON.stringify(food), { status: 200, headers: { "Content-Type": "application/json" } });
}

// GET /pending-water?token=<INGEST_SECRET>
// Returns (and removes) the oldest queued water amount as a bare number (mL) so the iPhone
// "MF Log Water" Shortcut can feed it straight to MacroFactor's "Log Water" action. 204 when
// nothing is queued. Kept separate from /pending so the food path is untouched.
async function handlePendingWater(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!env.INGEST_SECRET || token !== env.INGEST_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }
  // A D1 hiccup must return an EMPTY 500 — any error text in the body could be fed to the
  // Shortcut's "Log Water" action as if it were a queued amount.
  let ml: number | null;
  try {
    ml = await db.popPendingWater(env.DB);
  } catch {
    return new Response("", { status: 500 });
  }
  if (ml == null) return new Response("", { status: 204 });
  return new Response(String(ml), { status: 200, headers: { "Content-Type": "text/plain" } });
}

// GET /pending-weight?token=<INGEST_SECRET>
// Returns (and removes) the oldest queued weight as a bare kg number (text/plain) so the
// "MF Log Weight" Shortcut can feed it to MacroFactor's Log Weight action. 204 when empty.
async function handlePendingWeight(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!env.INGEST_SECRET || token !== env.INGEST_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }
  // Empty 500 on D1 failure — error text in the body could be logged as a weight (see water).
  let kg: number | null;
  try {
    kg = await db.popPendingWeight(env.DB);
  } catch {
    return new Response("", { status: 500 });
  }
  if (kg == null) return new Response("", { status: 204 });
  return new Response(String(parseFloat(kg.toFixed(3))), { status: 200, headers: { "Content-Type": "text/plain" } });
}

// GET /pending-batch?token=<INGEST_SECRET>
// Claims and returns the oldest unclaimed (or stale-claimed) batch as JSON:
//   { batch_id, count, items: MacroFactorFood[] }. 204 if nothing pending. Stale claims (>10 min) re-served.
async function handlePendingBatch(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return json({ error: "GET only" }, 405);
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!env.INGEST_SECRET || token !== env.INGEST_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }
  const row = await db.claimPendingBatch(env.DB);
  if (!row) return new Response("", { status: 204 });
  // pop=1: delete the batch as it's served so the iOS Shortcut needs no separate /ack-batch
  // call (removes the fragile batch_id-in-URL step). Trade-off: a crash mid-loop loses the
  // rest of the batch instead of re-serving it — acceptable for single-user meal logging.
  if (url.searchParams.get("pop") === "1") await db.ackBatch(env.DB, row.id);
  return json({ batch_id: row.id, count: row.item_count, items: JSON.parse(row.items) });
}

// POST /ack-batch?token=<INGEST_SECRET>&id=<batch_id>
// Deletes the batch row after the iOS Shortcut loop completes. 200 { ok, id } / 404 if not found.
async function handleAckBatch(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!env.INGEST_SECRET || token !== env.INGEST_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }
  const rawId = url.searchParams.get("id");
  const id = rawId != null ? parseInt(rawId, 10) : NaN;
  if (!Number.isFinite(id) || id <= 0) {
    return json({ error: "id must be a positive integer" }, 400);
  }
  const deleted = await db.ackBatch(env.DB, id);
  if (!deleted) return json({ ok: false, error: "not found", id }, 404);
  return json({ ok: true, id });
}

// DELETE|POST /cancel-pending?token=<INGEST_SECRET>[&queue=food|water|weight|batch|all]
// Clears all rows from the targeted pending queue(s). Returns JSON per-queue counts.
// Method-guarded (DELETE/POST) so a stray GET can't silently wipe a queue.
async function handleCancelPending(request: Request, env: Env): Promise<Response> {
  if (request.method !== "DELETE" && request.method !== "POST") return json({ error: "DELETE or POST only" }, 405);
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!env.INGEST_SECRET || token !== env.INGEST_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }
  const queueParam = url.searchParams.get("queue") ?? "all";
  const queues: ("food" | "water" | "weight" | "batch")[] =
    queueParam === "food" ? ["food"] :
    queueParam === "water" ? ["water"] :
    queueParam === "weight" ? ["weight"] :
    queueParam === "batch" ? ["batch"] :
    ["food", "water", "weight", "batch"];
  const counts = await db.cancelPending(env.DB, queues);
  return json(counts);
}

// Validate a string starts with a real calendar date (YYYY-MM-DD); returns the date or null.
// Rejects impossible dates like 2024-13-99 by round-tripping through Date.
function validIsoDate(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === iso ? iso : null;
}

// POST /today  — ingest MacroFactor's Today-Summary JSON ({consumed, remaining}) so the current
//   day stays fresh without a full export. Auth: x-ingest-secret header or ?token=.
//   Date: body.date or ?date=YYYY-MM-DD (the phone's LOCAL date) if supplied, else the user's
//   USER_TZ calendar date (NOT UTC — a dateless post after local midnight would otherwise
//   land on the previous day's row).
// POST /today?clear=YYYY-MM-DD  — delete one date's live row (hygiene / bad post).
async function handleToday(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const tok = request.headers.get("x-ingest-secret") || url.searchParams.get("token");
  if (!env.INGEST_SECRET || tok !== env.INGEST_SECRET) return json({ error: "unauthorized" }, 401);
  if (request.method !== "POST") return json({ error: "POST only" }, 405);

  const ackIdRaw = url.searchParams.get("ack_id");
  let ack: string | null = null;
  if (ackIdRaw != null) {
    const ackId = parseInt(ackIdRaw, 10);
    ack = Number.isFinite(ackId) && ackId > 0 && (await db.ackDispatch(env.DB, ackId, Date.now()))
      ? "ok"
      : "unknown_id";
  }

  const clear = url.searchParams.get("clear");
  if (clear) {
    const cd = validIsoDate(clear) ?? clear.slice(0, 10);
    await db.deleteToday(env.DB, cd);
    return json({ ok: true, cleared: cd });
  }

  // Build the payload. Prefer macro query params (?energy=&protein=&carbs=&fat=) — the easiest
  // thing to assemble in Shortcuts (inline URL variables, no JSON-body field juggling) — and fall
  // back to parsing the request body as MacroFactor's Today-Summary JSON {consumed, remaining}.
  const q = url.searchParams;
  const qnum = (v: string | null): number | null => {
    if (v == null || v === "") return null;
    const n = parseFloat(v.replace(/[^0-9.\-]/g, "")); // tolerate "2876 Cal", "1,850", etc.
    return Number.isNaN(n) ? null : n;
  };
  const qConsumed: Record<string, number> = {};
  for (const [param, key] of [
    ["energy", "energy"], ["calories", "energy"], ["protein", "protein"],
    ["carbs", "carbs"], ["fat", "fat"], ["fiber", "fiber"], ["water", "water"],
  ] as const) {
    const n = qnum(q.get(param));
    if (n != null) qConsumed[key] = n;
  }

  let raw = "";
  let payload: any;
  if (Object.keys(qConsumed).length) {
    payload = { consumed: qConsumed };
    raw = JSON.stringify(payload);
  } else {
    // Tolerant body parse — Shortcuts may send JSON, a JSON string, or a multipart file.
    try {
      const ctype = request.headers.get("content-type") || "";
      if (ctype.includes("multipart/form-data")) {
        const form = await request.formData();
        for (const v of form.values()) {
          raw = typeof v === "string" ? v : await (v as File).text();
          break;
        }
      } else {
        raw = await request.text();
      }
      payload = JSON.parse(raw);
    } catch {
      // Echo what we actually received so a misconfigured shortcut is easy to diagnose from the phone.
      return json(
        {
          error:
            "no macro query params and the body wasn't valid JSON — pass ?energy=&protein=&carbs=&fat= " +
            "or POST MacroFactor's Today-Summary JSON {consumed, remaining}",
          content_type: request.headers.get("content-type") || null,
          received_length: (raw || "").length,
          received_start: (raw || "").slice(0, 200),
        },
        400,
      );
    }
    if (!payload || typeof payload !== "object") return json({ error: "expected a JSON object" }, 400);
  }

  const date =
    validIsoDate(payload.date) || validIsoDate(url.searchParams.get("date")) || db.todayLocal();

  const ex = db.extractTodaySummary(payload);
  await db.upsertToday(env.DB, date, ex, raw, Date.now(), url.searchParams.get("source") || "today-summary-shortcut");
  return json({
    ok: true,
    date,
    consumed: { calories: ex.calories, protein: ex.protein, carbs: ex.carbs, fat: ex.fat },
    had_remaining: !!ex.remaining,
    ...(ack != null ? { ack } : {}),
  });
}

// GET /pending-all?token=<INGEST_SECRET>
// The "MF Sync" Shortcut's single fetch. Claims every queued food / water / weight row and returns
//   { claim, count, foods: [MacroFactorFood...], water: [mL...], weight: [kg...] }
// Always 200 with (possibly empty) arrays so the Shortcut's Repeat loops are simply no-ops.
// Rows stay claimed until POST /sync-ack echoes `claim`; unacked claims are re-served after 10 min.
async function handlePendingAll(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return json({ error: "GET only" }, 405);
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!env.INGEST_SECRET || token !== env.INGEST_SECRET) return json({ error: "unauthorized" }, 401);
  const c = await db.claimAllPending(env.DB);
  const foods: unknown[] = [];
  for (const f of c.foods) {
    try {
      const p = JSON.parse(f.payload);
      if (p && typeof p === "object") {
        delete p._pending_id;
        foods.push(p);
      }
    } catch {
      // a corrupt row must not break the whole sync; it is dropped on ack
    }
  }
  return json({
    claim: c.claim,
    count: foods.length + c.water.length + c.weight.length,
    foods,
    water: c.water.map((w) => w.ml),
    weight: c.weight.map((w) => parseFloat(Number(w.kg).toFixed(3))),
  });
}

// POST /sync-ack?token=<INGEST_SECRET>&claim=<ms>[&date=YYYY-MM-DD]   (claim may also be a `claim` header)
// Body (optional): the MacroFactorTodaySummary returned by the last Log by JSON / Log Water /
// Log Weight action — {consumed, remaining}. Deletes the claimed rows, marks the food dispatches
// landed, and refreshes the live today row from the summary.
async function handleSyncAck(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  const url = new URL(request.url);
  const token = request.headers.get("x-ingest-secret") || url.searchParams.get("token");
  if (!env.INGEST_SECRET || token !== env.INGEST_SECRET) return json({ error: "unauthorized" }, 401);

  // The claim stamp may arrive as a header (easiest to wire in Shortcuts) or a query param.
  const claimRaw = request.headers.get("claim") || request.headers.get("x-claim") || url.searchParams.get("claim");
  const claim = claimRaw != null ? parseInt(claimRaw, 10) : NaN;
  const acked = Number.isFinite(claim) && claim > 0 ? await db.ackClaim(env.DB, claim, Date.now()) : null;

  // Tolerant body parse — Shortcuts may send JSON, a JSON string, a multipart file, or nothing.
  let raw = "";
  let payload: any = null;
  try {
    const ctype = request.headers.get("content-type") || "";
    if (ctype.includes("multipart/form-data")) {
      const form = await request.formData();
      for (const v of form.values()) {
        raw = typeof v === "string" ? v : await (v as File).text();
        break;
      }
    } else {
      raw = await request.text();
    }
    if (raw.trim()) payload = JSON.parse(raw);
    if (typeof payload === "string") payload = JSON.parse(payload); // double-encoded by Shortcuts
    // "Repeat Results" from the Shortcut is a list of every iteration's summary — keep the last one.
    if (Array.isArray(payload)) {
      const withConsumed = payload.filter((x) => x && typeof x === "object" && (x as any).consumed);
      payload = withConsumed.length ? withConsumed[withConsumed.length - 1] : null;
    }
    // JSON-mode Shortcuts bodies wrap the summary in a single key, e.g. {"summary": {consumed, remaining}}.
    if (payload && typeof payload === "object" && !payload.consumed) {
      const vals = Object.values(payload);
      const inner = vals.length === 1 ? vals[0] : payload.summary;
      if (inner && typeof inner === "object" && (inner as any).consumed) payload = inner;
    }
  } catch {
    payload = null;
  }

  let today: unknown = null;
  if (payload && typeof payload === "object" && payload.consumed && typeof payload.consumed === "object") {
    const date = validIsoDate(url.searchParams.get("date")) || db.todayLocal();
    const ex = db.extractTodaySummary(payload);
    await db.upsertToday(env.DB, date, ex, raw, Date.now(), "mf-sync");
    today = { date, consumed: { calories: ex.calories, protein: ex.protein, carbs: ex.carbs, fat: ex.fat }, had_remaining: !!ex.remaining };
  }
  return json({
    ok: true,
    ...(acked ? { acked } : { acked: null, note: claimRaw ? "unknown claim" : "no claim given" }),
    today,
    ...(payload == null && raw.trim() ? { body_ignored: raw.slice(0, 120) } : {}),
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Every endpoint is hit by unattended callers (iOS Shortcuts, Pushcut, the connector) — an
    // uncaught exception must return diagnosable JSON, not Cloudflare's generic HTML error page.
    try {
      return await route(request, env, ctx);
    } catch (e) {
      return json({ error: "internal", detail: String(e).slice(0, 300) }, 500);
    }
  },

  // Daily fallback PR check (cron in wrangler.jsonc). The primary trigger is the /upload-export
  // hook above; this catches days the user does not upload.
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await checkAndFirePrAlerts(env);
  },
};

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  db.setUserTz(env.USER_TZ);
  const url = new URL(request.url);

  if (url.pathname === "/ingest") return handleIngest(request, env);
  if (url.pathname === "/upload-export") {
    if (request.method !== "POST") return new Response("POST only", { status: 405 });
    const t = request.headers.get("x-ingest-secret") || url.searchParams.get("token");
    if (!env.INGEST_SECRET || t !== env.INGEST_SECRET) return new Response("unauthorized", { status: 401 });
    // Accept the .xlsx as either the raw request body or a multipart file field
    // (iOS Shortcuts may send it either way).
    let body: ArrayBuffer;
    if ((request.headers.get("content-type") || "").includes("multipart/form-data")) {
      const form = await request.formData();
      let file: File | null = null;
      for (const v of form.values()) if (v instanceof File) { file = v; break; }
      if (!file) return new Response("no file in form data", { status: 400 });
      body = await file.arrayBuffer();
    } else {
      body = await request.arrayBuffer();
    }
    const stub = env.IMPORT_DO.get(env.IMPORT_DO.idFromName("import"));
    const doResp = await stub.fetch("https://do.internal/parse", { method: "POST", body });
    // After a NON-SKIPPED import, check for new lift PRs in the background (doesn't block the
    // upload response). Clone so peeking the body here doesn't consume the stream returned to
    // the caller; a duplicate upload (skipped:true) changes no data, so we don't re-scan.
    if (doResp.ok) {
      const peek = doResp.clone();
      ctx.waitUntil(
        peek
          .json()
          .then((j: any) => (j && j.skipped ? undefined : checkAndFirePrAlerts(env)))
          .catch(() => checkAndFirePrAlerts(env)),
      );
    }
    return doResp;
  }
  if (url.pathname === "/today") return handleToday(request, env);
  if (url.pathname === "/pending-all") return handlePendingAll(request, env);
  if (url.pathname === "/sync-ack") return handleSyncAck(request, env);
  if (url.pathname === "/pending") return handlePending(request, env);
  if (url.pathname === "/pending-water") return handlePendingWater(request, env);
  if (url.pathname === "/pending-weight") return handlePendingWeight(request, env);
  if (url.pathname === "/pending-batch") return handlePendingBatch(request, env);
  if (url.pathname === "/ack-batch") return handleAckBatch(request, env);
  if (url.pathname === "/cancel-pending") return handleCancelPending(request, env);
  if (url.pathname === "/health") {
    // Real dependency check — a hardcoded "ok" could never detect a dead or unmigrated D1 binding.
    try {
      const row = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM days`).first()) as { n: number } | null;
      return json({ ok: true, days: row?.n ?? 0 });
    } catch (e) {
      return json({ ok: false, error: String(e).slice(0, 200) }, 503);
    }
  }

  // MCP endpoint. If MCP_TOKEN is set, the agent is served natively at the secret
  // path /mcp/<token> so the authless connector URL is unguessable. No rewriting —
  // the transport must own the real request path for its streaming to work.
  const mcpPath = env.MCP_TOKEN ? `/mcp/${env.MCP_TOKEN}` : "/mcp";
  if (url.pathname === mcpPath) {
    return MyMCP.serve(mcpPath).fetch(request, env, ctx);
  }
  if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
    return new Response("unauthorized", { status: 401 });
  }

  return new Response(
    "MacroFactor MCP server.\nEndpoints: /mcp (connector), /upload-export (export refresh), " +
      "/pending-all + /sync-ack (MF Sync Shortcut), /today (live today feed), " +
      "/pending, /pending-water, /pending-weight, /pending-batch + /ack-batch (legacy per-type queues), " +
      "/cancel-pending (clear queues), /health\n",
    { status: 404 },
  );
}
