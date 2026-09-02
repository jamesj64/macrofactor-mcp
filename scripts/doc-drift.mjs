// Doc-drift guard: verifies that the field names documented in docs/claude-project-doc.md's
// per-tool "**Response:**" lines actually exist in the live server's responses.
//
// Guards against the failure mode found 2026-07-05: the doc was regenerated with hallucinated
// response shapes for 5 tools (weekly_summary, get_adherence, get_prs, data_status,
// get_body_metrics) and two review passes missed it, because nothing mechanically compared
// doc field names to reality. This script is that comparison.
//
//   node scripts/doc-drift.mjs      (or: npm run doc-drift)
//
// Rules:
// - A doc token marked optional (`foo?`) may be absent live.
// - Null fields are stripped by the server's serializer, so KNOWN_CONDITIONAL lists
//   documented-but-nullable keys that may legitimately be absent on any given day.
// - A documented non-optional key missing from the live response = FAILURE (exit 1).
// - A live top-level key the doc's Response line never mentions = WARNING only.
// Read-only: calls only read tools; never touches the write queues.

import { existsSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = (process.env.MF_CONNECTOR_URL ||
  (existsSync("connector-url.txt") ? readFileSync("connector-url.txt", "utf8") : "")).trim();
if (!url) {
  console.error("No connector URL. Put it in connector-url.txt or set MF_CONNECTOR_URL.");
  process.exit(1);
}

const doc = readFileSync(new URL("../docs/claude-project-doc.md", import.meta.url), "utf8");

// ---- 1. Parse the doc: tool name -> Map(token -> optional?)
const RESERVED = new Set([
  "bool", "boolean", "string", "number", "int", "float", "null", "true", "false",
  "yyyy", "mm", "dd", "hh", "array", "object",
  // input param names that legitimately appear in Response prose
  "detail", "nutrients",
]);

// tool names referenced in Response prose ("use `get_workouts` for that") are not fields
const TOOL_NAMES = new Set([
  "get_daily_nutrition", "get_micronutrients", "get_food_log", "get_weight_history",
  "get_expenditure", "get_steps", "search_my_foods", "data_status", "get_today", "get_day",
  "get_targets", "get_adherence", "weekly_summary", "weekly_review", "get_goal_history", "get_training_volume",
  "get_exercise_progress", "get_workouts", "get_prs", "get_body_metrics", "get_program",
  "forecast_weight", "reconcile_energy_balance", "day_of_week_patterns", "get_nutrient_timing",
  "detect_stall", "micro_gap_analysis", "get_training_day_nutrition", "get_pr_alerts",
  "get_pending_logs", "cancel_pending_log", "log_food", "log_saved_food", "log_recipe",
  "relog_meal", "log_foods_batch", "log_water", "log_weight",
  "search_food", "get_food_nutrients", "lookup_barcode", "search", "fetch",
]);

function parseClaims(markdown) {
  const claims = new Map();
  const sections = markdown.split(/^#### `/m).slice(1);
  for (const s of sections) {
    const name = s.slice(0, s.indexOf("`"));
    const respIdx = s.indexOf("**Response:**");
    if (respIdx === -1) continue;
    const paraEnd = s.indexOf("\n\n", respIdx);
    const para = s.slice(respIdx, paraEnd === -1 ? undefined : paraEnd);
    // Only structural spans count as field lists: they contain brackets/braces or 2+ commas.
    // Single-word prose references ("`excess` only shown when...") are not field claims.
    const spans = [...para.matchAll(/`([^`]+)`/g)]
      .map((m) => m[1])
      .filter((sp) => /[{}\[\]]/.test(sp) || (sp.match(/,/g)?.length ?? 0) >= 2);
    // join with a comma so a span-final token terminates like a list item
    const code = spans.join(" , ");
    const tokens = new Map();
    const skip = (tok) =>
      RESERVED.has(tok.toLowerCase()) || TOOL_NAMES.has(tok) || tok.startsWith("_");
    // pass 1: field tokens. Quoted tokens only count when they're window keys ("7d");
    // other quoted strings are enum values, not field names.
    for (const m of code.matchAll(/(?:"([0-9]+d)"|([A-Za-z_][A-Za-z0-9_]*))(\?)?(?=\s*[:,}\]])/g)) {
      const tok = m[1] ?? m[2];
      if (skip(tok)) continue;
      const optional = m[3] === "?";
      tokens.set(tok, tokens.has(tok) ? tokens.get(tok) || optional : optional);
    }
    // pass 2: `key:{...}?` / `key:[...]?` marks the key AND every token inside as optional
    for (const m of code.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(\{[^{}]*\}|\[[^\[\]]*\])\?/g)) {
      if (!skip(m[1])) tokens.set(m[1], true);
      for (const im of m[2].matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
        if (!skip(im[0])) tokens.set(im[0], true);
      }
    }
    if (tokens.size) claims.set(name, tokens);
  }
  return claims;
}

// ---- 2. Live calls (read tools only), cheap params
function iso(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 86400_000);
  return d.toISOString().slice(0, 10);
}

const CALLS = {
  get_daily_nutrition: { start_date: iso(4) },
  get_micronutrients: { start_date: iso(4) },
  get_food_log: { start_date: iso(3) },
  get_weight_history: { start_date: iso(12) },
  get_expenditure: { start_date: iso(6) },
  get_steps: { start_date: iso(6) },
  search_my_foods: { query: "oats" },
  data_status: {},
  get_today: {},
  get_day: { date: iso(1) },
  get_targets: { week: true },
  get_adherence: { start_date: iso(5), end_date: iso(1) },
  weekly_summary: {},
  weekly_review: {},
  get_goal_history: {},
  get_training_volume: {},
  get_exercise_progress: { exercise: "Front Squat" },
  get_workouts: {},
  get_prs: {},
  get_body_metrics: {},
  get_program: {},
  forecast_weight: {},
  reconcile_energy_balance: {},
  day_of_week_patterns: {},
  get_nutrient_timing: {},
  detect_stall: {},
  micro_gap_analysis: { days: 28 },
  get_training_day_nutrition: {},
  get_pr_alerts: {},
  get_pending_logs: {},
};

// Documented keys that may legitimately be absent from any given live response,
// beyond the doc's own `?` markers. Every entry needs a reason.
const KNOWN_CONDITIONAL = {
  get_micronutrients: ["value"], // doc's "<nutrient_key>: value" placeholder, not a real key
  get_daily_nutrition: ["fat_percent", "scale_weight", "steps"], // null-stripped on days without a weigh-in / steps sync
  forecast_weight: [
    // calorie-math block is loss-goal-only; ETAs null when slope points away from goal.
    "calorie_math", "avg_intake_kcal", "avg_tdee_kcal", "avg_daily_deficit_kcal",
    "calorie_math_rows", "loss_goal_only", "eta_date", "eta_days",
    "error", "divergence_days", "weeks_relative_to_goal", "required_daily_deficit_kcal",
  ],
  detect_stall: [
    // adaptation block needs a TDEE baseline at goal start; stall_duration only when plateaued
    "stall_duration_days", "tdee_at_goal_start_kcal", "tdee_recent_kcal",
    "actual_tdee_drop_kcal", "expected_tdee_drop_from_weight_loss_kcal", "adaptation_kcal",
  ],
  reconcile_energy_balance: ["interpretation"], // null-stripped if window too thin to interpret
  get_program: ["rest"], // per-set rest is null-stripped when MF auto-manages rest periods
  // queue-row and dispatch-row fields only exist while something is queued / recently dispatched
  get_pending_logs: [
    "landed_ago", "name", "calories", "ml", "kg", "served_ago", "landed",
    "id", "queued_ago", "item_count", "claimed", "items",
  ],
};

// True when the response contains an empty array anywhere — on a fresh deployment (or a
// query with no matches) the per-row fields documented for that array can't appear, so a
// missing token is data-dependent, not doc drift.
function hasEmptyArray(v, depth = 0) {
  if (depth > 14 || v == null) return false;
  if (Array.isArray(v)) return v.length === 0 || v.some((el) => hasEmptyArray(el, depth + 1));
  if (typeof v === "object") return Object.values(v).some((val) => hasEmptyArray(val, depth + 1));
  return false;
}

function deepKeys(v, out = new Set(), depth = 0) {
  if (depth > 14 || v == null) return out;
  if (Array.isArray(v)) {
    for (const el of v.slice(0, 10)) deepKeys(el, out, depth + 1);
  } else if (typeof v === "object") {
    for (const [k, val] of Object.entries(v)) {
      out.add(k);
      deepKeys(val, out, depth + 1);
    }
  }
  return out;
}

// ---- 3. Run
const client = new Client({ name: "doc-drift", version: "0.0.1" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const txt = r.content?.map((c) => c.text).join("\n") ?? "";
  try { return JSON.parse(txt); } catch { return txt; }
}

const claims = parseClaims(doc);
let failures = 0;
let warnings = 0;

for (const [tool, args] of Object.entries(CALLS)) {
  const claimed = claims.get(tool);
  if (!claimed) {
    console.log(`${tool}: SKIP (no Response line parsed from doc)`);
    continue;
  }
  let live;
  try {
    live = await call(tool, args);
  } catch (e) {
    console.log(`${tool}: CALL ERROR ${String(e).slice(0, 120)}`);
    failures++;
    continue;
  }
  const liveKeys = deepKeys(live);
  const conditional = new Set(KNOWN_CONDITIONAL[tool] ?? []);

  const missing = [];
  for (const [tok, optional] of claimed) {
    if (liveKeys.has(tok)) continue;
    if (optional || conditional.has(tok)) continue;
    missing.push(tok);
  }
  // weekly_review's top-level keys are literally the tool names it composes, which the claim
  // parser skips by design — don't warn on keys that are known tool names.
  const undocumentedTop =
    live && typeof live === "object" && !Array.isArray(live)
      ? Object.keys(live).filter((k) => !claimed.has(k) && !TOOL_NAMES.has(k))
      : [];

  if (missing.length) {
    if (hasEmptyArray(live)) {
      warnings++;
      console.log(`${tool}: WARN — documented fields absent, but the response contains empty arrays (no matching data on this deployment): ${missing.join(", ")}`);
    } else {
      failures++;
      console.log(`${tool}: FAIL — doc claims fields the server never returned: ${missing.join(", ")}`);
    }
  } else {
    console.log(`${tool}: PASS (${claimed.size} documented tokens checked)`);
  }
  if (undocumentedTop.length) {
    warnings++;
    console.log(`  warn: live top-level keys not in doc's Response line: ${undocumentedTop.join(", ")}`);
  }
}

console.log(`\ndoc-drift: ${failures ? `${failures} tool(s) FAILED` : "all tools consistent with doc"}${warnings ? ` (${warnings} warning(s))` : ""}`);
process.exit(failures ? 1 : 0);
