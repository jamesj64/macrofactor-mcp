// Smoke-test the live MCP server: connect via StreamableHTTP, list tools, and call the
// targets / adherence / training tools, printing the key numbers to eyeball against the
// local ground-truth harness. Read-only.
//
//   node scripts/smoke.mjs
//
// Reads the connector URL from connector-url.txt (the secret /mcp/<token> capability URL).

import { existsSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = (process.env.MF_CONNECTOR_URL || (existsSync("connector-url.txt") ? readFileSync("connector-url.txt", "utf8") : "")).trim();
if (!url) {
  console.error("No connector URL. Put it in connector-url.txt or set MF_CONNECTOR_URL.");
  process.exit(1);
}

const client = new Client({ name: "smoke", version: "0.0.1" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));

const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`, tools.map((t) => t.name).join(", "));

// tool_annotations: readOnlyHint on a read tool, destructiveHint on the write tools
{
  const readAnnot = tools.find((t) => t.name === "get_daily_nutrition")?.annotations;
  const logWater = tools.find((t) => t.name === "log_water")?.annotations;
  const logFood = tools.find((t) => t.name === "log_food")?.annotations;
  const annotOk =
    readAnnot?.readOnlyHint === true &&
    logWater?.readOnlyHint === false && logWater?.destructiveHint === true &&
    logFood?.readOnlyHint === false && logFood?.destructiveHint === true;
  console.log("tool_annotations:", annotOk ? "PASS" : `FAIL (read=${JSON.stringify(readAnnot)} water=${JSON.stringify(logWater)})`);
  if (!annotOk) process.exitCode = 1;
}

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const txt = r.content?.map((c) => c.text).join("\n") ?? "";
  try { return JSON.parse(txt); } catch { return txt; }
}

const targets = await call("get_targets");
console.log("\nget_targets:", JSON.stringify(targets, null, 2));

const adh = await call("get_adherence");
console.log("\nget_adherence.summary:", JSON.stringify(adh.summary, null, 2));

const vol = await call("get_training_volume");
console.log("\nget_training_volume:", JSON.stringify({ training_days: vol.training_days, per_muscle: vol.per_muscle?.slice(0, 5) }, null, 2));

const prog = await call("get_exercise_progress", { metric: "1RM" });
console.log("\nget_exercise_progress(1RM):", JSON.stringify(prog.exercises?.map((e) => ({ exercise: e.exercise, last: e.last })), null, 2));

const wk = await call("get_workouts");
console.log("\nget_workouts sessions:", wk.sessions?.length, JSON.stringify(wk.sessions?.[0], null, 2));

const prs = await call("get_prs");
console.log("\nget_prs:", JSON.stringify(prs.exercises, null, 2));

const wk2 = await call("weekly_summary");
console.log("\nweekly_summary as_of:", wk2.as_of, "| goal:", JSON.stringify(wk2.goal));
for (const k of Object.keys(wk2.windows ?? {})) {
  const w = wk2.windows[k];
  console.log(
    `  ${k}: ${w.days_with_data}d data | avg ${w.nutrition.avg_calories}kcal/${w.nutrition.avg_protein}p` +
      ` | cal-on-target ${w.adherence.calorie_on_target_rate_pct}% protein-hit ${w.adherence.protein_hit_rate_pct}%` +
      ` | wt ${w.weight.change_kg ?? "—"}kg (${w.weight.rate_kg_per_week ?? "—"}/wk)` +
      ` | TDEE ${w.expenditure.avg_tdee} drift ${w.expenditure.drift_kcal}` +
      ` | ${w.training.sessions} sessions ${w.training.total_working_sets} sets`,
  );
}
console.log("  recent_prs:", JSON.stringify(wk2.recent_prs));

// edge: bad windows must fall back to the default, not 500
const wkEdge = await call("weekly_summary", { windows: [0] });
const edgeOk = wkEdge && wkEdge.windows && Object.keys(wkEdge.windows).join(",") === "7d,14d,28d";
console.log("  weekly_summary windows:[0] -> default:", edgeOk ? "PASS" : `FAIL (${JSON.stringify(wkEdge).slice(0, 120)})`);
if (!edgeOk) process.exitCode = 1;

// --- /today round-trip: POST a sample Today-Summary payload to a sentinel date, read it back
// via get_today, then clean it up. Verifies the live-today path end to end without touching
// real data (sentinel date 2000-01-01 never appears in any default range). Needs the ingest
// secret + the worker base URL (derived from the connector URL by stripping /mcp/<token>).
let secret = process.env.MF_INGEST_SECRET;
if (!secret && existsSync("ingest.config.json")) {
  try { secret = JSON.parse(readFileSync("ingest.config.json", "utf8")).ingestSecret; } catch {}
}
const base = url.replace(/\/mcp\/[^/]+\/?$/, "").replace(/\/$/, "");
if (secret) {
  const SENTINEL = "2000-01-01";
  const sample = {
    date: SENTINEL,
    consumed: { energy: 1850, protein: 140, carbs: 220, fat: 65, fiber: 28, sodium: 2100 },
    remaining: { energy: { target: 150, maximum: 350 }, protein: { minimum: -15, target: 10 } },
  };
  const post = await fetch(`${base}/today?token=${encodeURIComponent(secret)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sample),
  });
  console.log("\nPOST /today ->", post.status, await post.text());

  const today = await call("get_today", { date: SENTINEL });
  console.log("get_today(sentinel):", JSON.stringify(today, null, 2));
  if (today?.consumed?.calories !== 1850 || today?.remaining_to_target?.calories !== 150) {
    console.error("FAIL: get_today did not reflect the posted sample");
    process.exitCode = 1;
  }

  // query-param path (what the iOS shortcut uses: inline URL variables, no body)
  const qp = await fetch(
    `${base}/today?token=${encodeURIComponent(secret)}&date=${SENTINEL}&energy=2100&protein=160&carbs=180&fat=70`,
    { method: "POST" },
  );
  console.log("POST /today?energy=… ->", qp.status, await qp.text());
  const today2 = await call("get_today", { date: SENTINEL });
  console.log("get_today(sentinel) via query params: calories =", today2?.consumed?.calories);
  if (today2?.consumed?.calories !== 2100 || today2?.consumed?.protein !== 160) {
    console.error("FAIL: query-param /today did not reflect the values");
    process.exitCode = 1;
  }

  // ack_id with unknown dispatch id → server returns {"ack":"unknown_id"}
  // Valid sentinel params so the POST body-parse succeeds — the real shortcut always sends the
  // Log by JSON summary; the ack rides along.
  const ackIdResp = await fetch(
    `${base}/today?token=${encodeURIComponent(secret)}&date=${SENTINEL}&energy=100&ack_id=999999999`,
    { method: "POST" },
  );
  let ackIdBody;
  try { ackIdBody = await ackIdResp.json(); } catch { ackIdBody = null; }
  const ackIdOk = ackIdBody?.ack === "unknown_id";
  console.log("POST /today?ack_id=999999999 ->", ackIdResp.status, ackIdOk ? "PASS" : `FAIL (${JSON.stringify(ackIdBody).slice(0, 120)})`);
  if (!ackIdOk) process.exitCode = 1;

  const del = await fetch(`${base}/today?token=${encodeURIComponent(secret)}&clear=${SENTINEL}`, { method: "POST" });
  console.log("cleanup /today?clear ->", del.status, await del.text());
} else {
  console.log("\n(skipping /today round-trip: no ingest secret — set MF_INGEST_SECRET or ingest.config.json)");
}

// --- Smarter-logging tools (log_saved_food / log_water): registration + side-effect-free checks.
// We deliberately do NOT exercise a real log here — that would queue a pending item and ping the
// phone. We assert the tools exist, that an unresolvable saved-food returns not_found WITHOUT
// queuing, and that the new /pending-water endpoint is wired + authed.
const toolNames = tools.map((t) => t.name);
const haveLogTools = ["log_saved_food", "log_water"].every((t) => toolNames.includes(t));
console.log("\nlog_saved_food / log_water registered:", haveLogTools ? "PASS" : "FAIL");
if (!haveLogTools) process.exitCode = 1;

// Body metrics + planned program (read-only).
const bm = await call("get_body_metrics");
const bmOk = bm && Array.isArray(bm.entries);
console.log(
  "\nget_body_metrics:",
  bmOk ? `${bm.entries.length} entries; latest ${JSON.stringify(bm.entries[bm.entries.length - 1])}` : `FAIL (${JSON.stringify(bm).slice(0, 120)})`,
);
if (!bmOk) process.exitCode = 1;

const programOut = await call("get_program");
const programOk = programOut && typeof programOut.count === "number" && Array.isArray(programOut.programs);
console.log(
  "get_program:",
  programOk
    ? `${programOut.count} program(s); ${JSON.stringify(programOut.programs[0]?.summary)}`
    : `FAIL (${JSON.stringify(programOut).slice(0, 120)})`,
);
if (!programOk) process.exitCode = 1;

const nf = await call("log_saved_food", { food: "__no_such_food_zzz__", exact: true });
const nfOk = nf && nf.status === "not_found";
console.log("log_saved_food(not_found, no side effect):", nfOk ? "PASS" : `FAIL (${JSON.stringify(nf).slice(0, 120)})`);
if (!nfOk) process.exitCode = 1;

// /pending-water auth only. We do NOT do a real GET with the valid token: that POPs (deletes) the
// oldest queued water item, so it would silently eat a genuine pending log if one were waiting. The
// bad-token check confirms the route is wired + protected without consuming anything.
if (secret) {
  const pwBad = await fetch(`${base}/pending-water?token=wrong`, { method: "GET" });
  console.log("GET /pending-water (bad token) ->", pwBad.status, pwBad.status === 401 ? "PASS" : "FAIL");
  if (pwBad.status !== 401) process.exitCode = 1;
}

// ============================================================================
// Enhancement tools (2026-07-01)
// ============================================================================

// data_status.last_imports must be an array
{
  const ds = await call("data_status");
  const ok = ds && Array.isArray(ds.last_imports);
  console.log("\ndata_status.last_imports:", ok ? `${ds.last_imports.length} entries PASS` : `FAIL (${JSON.stringify(ds?.last_imports).slice(0, 80)})`);
  if (!ok) process.exitCode = 1;
}

// forecast_weight (handles sufficient + insufficient-data shapes)
{
  const fw = await call("forecast_weight");
  const fwInsufficient = fw && fw.error === "insufficient_data" && typeof fw.data_points === "number";
  // Null-valued fields (error, eta_days, divergence_days) are OMITTED by the compact
  // serializer — treat an absent key as null, never require its presence.
  const fwOk =
    fwInsufficient ||
    (fw && fw.error == null && typeof fw.data_points === "number" && fw.ols_regression &&
      typeof fw.ols_regression.slope_kg_per_week === "number" && fw.calorie_math &&
      (fw.ols_regression.eta_days == null || typeof fw.ols_regression.eta_days === "number") &&
      (fw.divergence_days == null || typeof fw.divergence_days === "number"));
  console.log(
    "\nforecast_weight:",
    fwInsufficient ? `insufficient data (${fw.data_points} pts) — shape OK`
      : fwOk ? `${fw.data_points} pts | slope ${fw.ols_regression.slope_kg_per_week} kg/wk | r² ${fw.ols_regression.r_squared} | OLS ETA ${fw.ols_regression.eta_date ?? "n/a"} | cal ETA ${fw.calorie_math.eta_date ?? "n/a"} | divergence ${fw.divergence_days ?? "n/a"} days`
      : `FAIL (${JSON.stringify(fw).slice(0, 160)})`,
  );
  if (!fwOk) process.exitCode = 1;

  const fwTd = await call("forecast_weight", { target_date: "2026-12-31" });
  const fwTdOk =
    fwTd &&
    (fwTd.required_daily_deficit_kcal == null || typeof fwTd.required_daily_deficit_kcal === "number") &&
    (fwTd.error == null || fwTd.error === "insufficient_data");
  console.log("forecast_weight(target_date):", fwTdOk ? `required_deficit=${fwTd.required_daily_deficit_kcal ?? "n/a"} kcal` : `FAIL (${JSON.stringify(fwTd).slice(0, 120)})`);
  if (!fwTdOk) process.exitCode = 1;
}

// reconcile_energy_balance (valid result or data-guard error)
{
  const r = await call("reconcile_energy_balance", {});
  if (r && r.error) {
    console.log("\nreconcile_energy_balance → data guard:", r.error);
  } else if (r && typeof r.implied_maintenance_kcal === "number") {
    const validFlag = r.gap_flag == null || ["within_noise", "meaningful", "investigate_logging"].includes(r.gap_flag);
    const pass = validFlag && typeof r.interpretation === "string" && r.window?.trend_weight_span_days >= 14;
    console.log(`\nreconcile_energy_balance implied=${r.implied_maintenance_kcal} tdee=${r.mf_avg_tdee} gap=${r.gap_kcal} flag=${r.gap_flag} →`, pass ? "PASS" : `FAIL (${JSON.stringify(r).slice(0, 200)})`);
    if (!pass) process.exitCode = 1;
  } else {
    console.error("\nreconcile_energy_balance FAIL: unexpected shape", JSON.stringify(r).slice(0, 200));
    process.exitCode = 1;
  }
}

// day_of_week_patterns
{
  const dow = await call("day_of_week_patterns");
  const ok = dow && typeof dow.days_analyzed === "number" && Array.isArray(dow.weekdays) && dow.weekdays.length <= 7 &&
    dow.weekdays.every((w) => typeof w.weekday === "string" && typeof w.n === "number");
  console.log("\nday_of_week_patterns:", ok ? `${dow.days_analyzed}d; highest-leverage ${dow.highest_leverage_day}` : `FAIL (${JSON.stringify(dow).slice(0, 200)})`);
  if (!ok) process.exitCode = 1;
}

// get_nutrient_timing
{
  const timing = await call("get_nutrient_timing");
  const NAMES = ["fasted", "morning", "midday", "afternoon", "evening", "late"];
  const ok = timing && Array.isArray(timing.buckets) && timing.buckets.length === 6 &&
    timing.buckets.every((b) => NAMES.includes(b.bucket) && typeof b.avg_per_day?.calories === "number" && typeof b.days_with_data === "number");
  console.log("\nget_nutrient_timing:", ok ? `6 buckets; days=${timing.days_with_food_data}` : `FAIL (${JSON.stringify(timing).slice(0, 160)})`);
  if (!ok) process.exitCode = 1;
}

// detect_stall + custom windows + clamp
{
  const stall = await call("detect_stall", {});
  const VALID = ["plateaued", "on-track", "adapting-but-losing", "slower-than-goal-but-not-stalled", "off-direction", "unknown"];
  const ok = stall != null && typeof stall.is_plateaued === "boolean" && VALID.includes(stall.classification) &&
    typeof stall.stall_duration_days === "number" && stall.stall_threshold_kg_per_week === 0.10 && stall.flags != null;
  console.log("\ndetect_stall:", ok ? `${stall.classification} | plateaued=${stall.is_plateaued} | stall=${stall.stall_duration_days}d` : `FAIL (${JSON.stringify(stall).slice(0, 250)})`);
  if (!ok) process.exitCode = 1;

  const clamp = await call("detect_stall", { recent_days: 20, medium_days: 10 });
  const clampOk = clamp && clamp.medium_days > clamp.recent_days;
  console.log("detect_stall clamp:", clampOk ? "PASS" : `FAIL (${JSON.stringify(clamp).slice(0, 160)})`);
  if (!clampOk) process.exitCode = 1;
}

// micro_gap_analysis + 90d
{
  const gap = await call("micro_gap_analysis");
  const ok = gap && gap.window_days === 28 && Array.isArray(gap.results) &&
    (gap.results.length === 0 || (["deficient", "borderline", "adequate", "excess"].includes(gap.results[0].status) && typeof gap.results[0].tracked_days === "number"));
  console.log("\nmicro_gap_analysis:", ok ? `${gap.days_with_data}d; ${gap.results.length} nutrients; top: ${JSON.stringify(gap.results[0] ?? null)}` : `FAIL (${JSON.stringify(gap).slice(0, 160)})`);
  if (!ok) process.exitCode = 1;
  const gap90 = await call("micro_gap_analysis", { days: 90 });
  const gap90Ok = gap90 && gap90.window_days === 90 && Array.isArray(gap90.results);
  console.log("micro_gap_analysis(90d):", gap90Ok ? `${gap90.days_with_data}d` : "FAIL");
  if (!gap90Ok) process.exitCode = 1;
}

// get_training_day_nutrition
{
  const tdn = await call("get_training_day_nutrition", {});
  const ok = tdn && tdn.per_tier && ["rest", "light", "moderate", "heavy"].every((k) => k in tdn.per_tier) &&
    tdn.delta_analysis && (tdn.per_day === undefined || Array.isArray(tdn.per_day));
  console.log("\nget_training_day_nutrition:", ok ? `tiers ${["rest", "light", "moderate", "heavy"].map((k) => `${k}:${tdn.per_tier[k].day_count}`).join(" ")}` : `FAIL (${JSON.stringify(tdn).slice(0, 200)})`);
  if (!ok) process.exitCode = 1;
}

// get_pr_alerts (read-only) + bottleneck_kpi self-consistency
{
  const alerts = await call("get_pr_alerts");
  const ok = alerts && typeof alerts.count === "number" && Array.isArray(alerts.alerts);
  console.log("\nget_pr_alerts:", ok ? `count=${alerts.count}` : `FAIL (${JSON.stringify(alerts).slice(0, 120)})`);
  if (!ok) process.exitCode = 1;
  const k = alerts?.bottleneck_kpi;
  const kOk = k == null || (k.front_squat?.e1rm_kg > 0 && k.back_squat?.e1rm_kg > 0
    && Math.abs(k.front_to_back_pct - (k.front_squat.e1rm_kg / k.back_squat.e1rm_kg) * 100) < 0.2);
  console.log("  bottleneck_kpi:", kOk ? (k ? `FS:BS ${k.front_to_back_pct}% PASS` : "absent (no squat data) PASS") : `FAIL (${JSON.stringify(k)})`);
  if (!kOk) process.exitCode = 1;
}

// weekly_review composite: all three sections present and sharing one end date
{
  const wr = await call("weekly_review");
  const ok = wr && wr.weekly_summary != null && wr.weekly_summary.as_of === wr.as_of
    && wr.pr_alerts != null && Array.isArray(wr.pr_alerts.alerts)
    && wr.day_of_week_patterns != null && Array.isArray(wr.day_of_week_patterns.weekdays);
  console.log("\nweekly_review:", ok ? `as_of=${wr.as_of} (summary+alerts+patterns) PASS` : `FAIL (${JSON.stringify(wr).slice(0, 200)})`);
  if (!ok) process.exitCode = 1;
}

// get_goal_history: planned/actual blocks per goal
{
  const gh = await call("get_goal_history");
  const ok = gh && typeof gh.count === "number" && Array.isArray(gh.goals)
    && (gh.count === 0 || (gh.goals[0].planned != null && gh.goals[0].actual != null));
  console.log("\nget_goal_history:", ok ? `count=${gh.count} PASS` : `FAIL (${JSON.stringify(gh).slice(0, 160)})`);
  if (!ok) process.exitCode = 1;
}

// get_targets week:true returns the governing program's full weekday schedule
{
  const tw = await call("get_targets", { week: true });
  const ok = tw && Array.isArray(tw.week) && tw.week.length >= 1
    && tw.week.every((w) => typeof w.weekday === "string");
  console.log("\nget_targets week:true:", ok ? `${tw.week.length} weekday rows PASS` : `FAIL (${JSON.stringify(tw?.week).slice(0, 120)})`);
  if (!ok) process.exitCode = 1;
}

// get_adherence macro-split aggregates (avg_carb_diff/avg_fat_diff; absent only when no targeted days)
{
  const a = await call("get_adherence");
  const s = a?.summary;
  const ok = s != null && (s.days_with_target === 0
    || (typeof s.avg_carb_diff === "number" && typeof s.avg_fat_diff === "number"));
  console.log("\nget_adherence macro-split:", ok ? `carb ${s.avg_carb_diff}g / fat ${s.avg_fat_diff}g vs target PASS` : `FAIL (${JSON.stringify(s).slice(0, 160)})`);
  if (!ok) process.exitCode = 1;
}

// relog_meal — no-data + bad-hours guards return WITHOUT queuing
{
  const noData = await call("relog_meal", { date: "2000-01-01" });
  const ndTxt = typeof noData === "string" ? noData : JSON.stringify(noData);
  const ndOk = ndTxt.includes("No food log items");
  console.log("\nrelog_meal(no-data):", ndOk ? "PASS" : `FAIL (${ndTxt.slice(0, 120)})`);
  if (!ndOk) process.exitCode = 1;

  const badHours = await call("relog_meal", { date: "2026-01-01", start_hour: 14, end_hour: 12 });
  const bhTxt = typeof badHours === "string" ? badHours : JSON.stringify(badHours);
  const bhOk = bhTxt.includes("start_hour");
  console.log("relog_meal(bad-hours):", bhOk ? "PASS" : `FAIL (${bhTxt.slice(0, 120)})`);
  if (!bhOk) process.exitCode = 1;
}

// New write-tool registration (no functional calls — they'd queue + fire a push)
{
  const need = ["log_weight", "log_recipe", "relog_meal", "log_foods_batch", "cancel_pending_log"];
  const ok = need.every((t) => toolNames.includes(t));
  console.log("\nnew write tools registered:", ok ? "PASS" : `FAIL (missing ${need.filter((t) => !toolNames.includes(t)).join(", ")})`);
  if (!ok) process.exitCode = 1;
}

// ============================================================================
// PR2 feature assertions
// ============================================================================

// get_day: alcohol_g surfaced (number or absent) and food_items array shape
{
  const date = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const day = await call("get_day", { date });
  const alcoholOk = day && (day.nutrition == null || day.nutrition.alcohol_g == null || typeof day.nutrition.alcohol_g === "number");
  const itemsOk = day && (day.food_items == null || Array.isArray(day.food_items));
  const ok = alcoholOk && itemsOk;
  console.log(
    `\nget_day(${date}):`,
    ok
      ? `alcohol_g=${day.nutrition?.alcohol_g ?? "null"} items=${day.food_items?.length ?? 0} PASS`
      : `FAIL (alcohol_g=${day?.nutrition?.alcohol_g} food_items_array=${itemsOk})`,
  );
  if (!ok) process.exitCode = 1;
}

// get_pending_logs: total_pending is a number
{
  const pl = await call("get_pending_logs", {});
  const ok = pl && typeof pl.total_pending === "number" && (pl.recent_dispatches == null || Array.isArray(pl.recent_dispatches));
  console.log("\nget_pending_logs:", ok ? `total_pending=${pl.total_pending} recent_dispatches=${pl.recent_dispatches == null ? "null" : pl.recent_dispatches.length} PASS` : `FAIL (${JSON.stringify(pl).slice(0, 120)})`);
  if (!ok) process.exitCode = 1;
}

// search_my_foods: loggable is an array
{
  const sf = await call("search_my_foods", { query: "oats" });
  const ok = sf && Array.isArray(sf.loggable) && (sf.name_only == null || Array.isArray(sf.name_only));
  console.log("\nsearch_my_foods(oats):", ok ? `${sf.loggable.length} results PASS` : `FAIL (${JSON.stringify(sf).slice(0, 120)})`);
  if (!ok) process.exitCode = 1;
}

// get_targets: staleness object present with latest_program_date key
{
  const tgt = await call("get_targets");
  const ok = tgt && tgt.staleness != null && typeof tgt.staleness.latest_program_date !== "undefined";
  console.log(
    "\nget_targets.staleness:",
    ok
      ? `latest_program_date=${tgt.staleness.latest_program_date} PASS`
      : `FAIL (${JSON.stringify(tgt?.staleness).slice(0, 120)})`,
  );
  if (!ok) process.exitCode = 1;
}

// get_today: default shape has no consumed_all; detail:"full" shape has it (only assert when live row exists)
{
  const todayDefault = await call("get_today", {});
  const todayFull = await call("get_today", { detail: "full" });
  if (todayDefault?.live === true) {
    const noConsumedAll = !("consumed_all" in todayDefault);
    const hasConsumedAll = "consumed_all" in (todayFull ?? {});
    const ok = noConsumedAll && hasConsumedAll;
    console.log(
      "\nget_today detail=default vs full:",
      ok ? "PASS" : `FAIL (default_has_consumed_all=${!noConsumedAll} full_has=${hasConsumedAll})`,
    );
    if (!ok) process.exitCode = 1;
  } else {
    console.log("\nget_today detail=default vs full: SKIP (no live row today)");
  }
}

// get_micronutrients: full detail row has >= keys than default row (when both have rows)
{
  const mnDef = await call("get_micronutrients", {});
  const mnFull = await call("get_micronutrients", { detail: "full" });
  const defRows = Array.isArray(mnDef) ? mnDef : Array.isArray(mnDef?.rows) ? mnDef.rows : null;
  const fullRows = Array.isArray(mnFull) ? mnFull : Array.isArray(mnFull?.rows) ? mnFull.rows : null;
  if (defRows?.[0] && fullRows?.[0]) {
    const defKeys = Object.keys(defRows[0]).length;
    const fullKeys = Object.keys(fullRows[0]).length;
    const ok = fullKeys >= defKeys;
    console.log(
      "\nget_micronutrients default vs full keys:",
      ok ? `PASS (full=${fullKeys} >= default=${defKeys})` : `FAIL (full=${fullKeys} < default=${defKeys})`,
    );
    if (!ok) process.exitCode = 1;
  } else {
    console.log("\nget_micronutrients default vs full keys: SKIP (no rows available)");
  }
}

// get_food_log: any row with a suspect field must have Array.isArray(row.suspect) === true
{
  const fl = await call("get_food_log", {});
  const rows = Array.isArray(fl?.items) ? fl.items : Array.isArray(fl) ? fl : [];
  const suspectRows = rows.filter((r) => "suspect" in r);
  const ok = suspectRows.every((r) => Array.isArray(r.suspect));
  console.log(
    "\nget_food_log suspect field:",
    ok
      ? `PASS (${suspectRows.length} row(s) with suspect field)`
      : `FAIL (non-array suspect: ${suspectRows.filter((r) => !Array.isArray(r.suspect)).map((r) => JSON.stringify(r.suspect)).slice(0, 3).join(",")})`,
  );
  if (!ok) process.exitCode = 1;
}

// New endpoint auth checks (bad token / method / id — no side effects on the queues)
if (secret) {
  const checks = [
    ["GET /pending-weight (bad token)", await fetch(`${base}/pending-weight?token=wrong`), 401],
    ["GET /pending-batch (bad token)", await fetch(`${base}/pending-batch?token=wrong`), 401],
    ["POST /ack-batch (bad token)", await fetch(`${base}/ack-batch?token=wrong&id=1`, { method: "POST" }), 401],
    ["POST /ack-batch (unknown id)", await fetch(`${base}/ack-batch?token=${encodeURIComponent(secret)}&id=999999`, { method: "POST" }), 404],
    ["POST /ack-batch (bad id)", await fetch(`${base}/ack-batch?token=${encodeURIComponent(secret)}&id=abc`, { method: "POST" }), 400],
    ["GET /ack-batch (wrong method)", await fetch(`${base}/ack-batch?token=${encodeURIComponent(secret)}&id=1`), 405],
    ["DELETE /cancel-pending (bad token)", await fetch(`${base}/cancel-pending?token=wrong&queue=all`, { method: "DELETE" }), 401],
  ];
  for (const [label, res, want] of checks) {
    const ok = res.status === want;
    console.log(`${label} ->`, res.status, ok ? "PASS" : `FAIL (want ${want})`);
    if (!ok) process.exitCode = 1;
  }
}

// ============================================================================
// PR3 read-tool coverage
// ============================================================================

// get_daily_nutrition: returns an array; each row has a date string
{
  const dn = await call("get_daily_nutrition", {});
  const rows = Array.isArray(dn) ? dn : Array.isArray(dn?.rows) ? dn.rows : null;
  const ok = rows != null && (rows.length === 0 || typeof rows[0].date === "string");
  console.log("\nget_daily_nutrition:", ok ? `${rows.length} rows PASS` : `FAIL (${JSON.stringify(dn).slice(0, 120)})`);
  if (!ok) process.exitCode = 1;
}

// get_weight_history: returns {entries: [...]}
{
  const wh = await call("get_weight_history", {});
  const ok = wh && Array.isArray(wh.entries);
  console.log("\nget_weight_history:", ok ? `${wh.entries.length} entries PASS` : `FAIL (${JSON.stringify(wh).slice(0, 120)})`);
  if (!ok) process.exitCode = 1;
}

// get_expenditure / get_steps: both return flat arrays
{
  const exp = await call("get_expenditure", {});
  const expOk = Array.isArray(exp);
  console.log("\nget_expenditure:", expOk ? `${exp.length} rows PASS` : `FAIL (${JSON.stringify(exp).slice(0, 120)})`);
  if (!expOk) process.exitCode = 1;

  const steps = await call("get_steps", {});
  const stepsOk = Array.isArray(steps);
  console.log("get_steps:", stepsOk ? `${steps.length} rows PASS` : `FAIL (${JSON.stringify(steps).slice(0, 120)})`);
  if (!stepsOk) process.exitCode = 1;
}

await client.close();
console.log(process.exitCode ? "\nFAILED" : "\nOK");
