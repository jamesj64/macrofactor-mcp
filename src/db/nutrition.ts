import { dateClause, safeParse, round, ageFrom, todayLocal, weekdayOf, addDays, daysBetween, mean } from "./utils";
import { foodItemFlags, dayMacroFlag, isImplausibleMicro } from "./quality";
import { MICRO_RDA } from "./analytics";

export async function getDays(DB: D1Database, start?: string, end?: string) {
  const { where, params } = dateClause("date", start, end);
  const rows = (await DB.prepare(`SELECT * FROM days ${where} ORDER BY date`).bind(...params).all())
    .results as any[];

  // Overlay the live "today" feed so the current day is current even when the last full export
  // is older. Rule: for the current calendar date the live macros win (keeping any
  // expenditure/weight/steps the export already has); for an earlier date the live row only
  // fills a gap the export doesn't cover yet — a finalized exported day is never overwritten.
  const live = (await DB.prepare(
    `SELECT date, calories, protein, carbs, fat, updated_at FROM today_summary ${where} ORDER BY date`,
  ).bind(...params).all()).results as any[];
  if (!live.length) return rows;

  const today = todayLocal();
  const byDate = new Map(rows.map((r) => [r.date, r]));
  for (const t of live) {
    const iso = t.updated_at != null ? new Date(Number(t.updated_at)).toISOString() : null;
    const existing = byDate.get(t.date);
    if (t.date === today) {
      const base = existing ?? {
        date: t.date, calories: null, protein: null, carbs: null, fat: null,
        expenditure: null, scale_weight: null, fat_percent: null, trend_weight: null, steps: null,
      };
      const merged: any = { ...base };
      // Current day: the live feed is the freshest truth for the macros, so it wins outright
      // (MacroFactor's big-4 are all-or-nothing — all present once anything is logged, all null
      // before that). The export still supplies expenditure / weight / steps, which it doesn't carry.
      merged.calories = t.calories;
      merged.protein = t.protein;
      merged.carbs = t.carbs;
      merged.fat = t.fat;
      merged.live = true;
      merged.source = "today-summary";
      merged.updated_at = iso;
      byDate.set(t.date, merged);
    } else if (!existing) {
      byDate.set(t.date, {
        date: t.date, calories: t.calories, protein: t.protein, carbs: t.carbs, fat: t.fat,
        expenditure: null, scale_weight: null, fat_percent: null, trend_weight: null, steps: null,
        live: true, source: "today-summary", updated_at: iso,
      });
    }
  }
  return [...byDate.values()]
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map((row) => {
      const flag = row.live === true ? null : dayMacroFlag(row);
      return flag ? { ...row, suspect: flag } : row;
    });
}

const DEFAULT_EXTRA_KEYS = ["Alcohol (g)", "Sugars (g)", "Saturated Fat (g)", "Caffeine (mg)"];

export async function getMicronutrients(
  DB: D1Database,
  start?: string,
  end?: string,
  nutrients?: string[],
  detail?: string,
) {
  const { where, params } = dateClause("date", start, end);
  const r = await DB.prepare(`SELECT date, payload FROM micronutrients ${where} ORDER BY date`)
    .bind(...params)
    .all();

  const defaultKeys = new Set([...Object.keys(MICRO_RDA), ...DEFAULT_EXTRA_KEYS]);

  return (r.results as { date: string; payload: string }[]).map((row) => {
    const parsed = safeParse(row.payload);
    let selectedKeys: string[];
    if (detail === "full") {
      selectedKeys = Object.keys(parsed);
    } else if (nutrients && nutrients.length > 0) {
      const terms = nutrients.map((n) => n.toLowerCase());
      selectedKeys = Object.keys(parsed).filter((k) =>
        terms.some((t) => k.toLowerCase().includes(t)),
      );
    } else {
      selectedKeys = Object.keys(parsed).filter((k) => defaultKeys.has(k));
    }

    const selected: Record<string, unknown> = {};
    const suspect: Record<string, unknown> = {};
    for (const k of selectedKeys) {
      const v = parsed[k];
      selected[k] = v;
      const num = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v as string) : NaN;
      if (Number.isFinite(num) && isImplausibleMicro(k, num)) {
        suspect[k] = v;
      }
    }

    const out: Record<string, unknown> = { date: row.date, ...selected };
    if (Object.keys(suspect).length > 0) out.suspect = suspect;
    return out;
  });
}

export async function getWeight(DB: D1Database, start?: string, end?: string) {
  const { where, params } = dateClause("date", start, end, 60);
  const extra = where ? `${where} AND` : "WHERE";
  const r = await DB.prepare(
    `SELECT date, scale_weight, fat_percent, trend_weight FROM days
     ${extra} (scale_weight IS NOT NULL OR trend_weight IS NOT NULL)
     ORDER BY date`,
  ).bind(...params).all();
  const rows = r.results as any[];
  let prevFat: number | null = null;
  for (const row of rows) {
    const cur: number | null = row.fat_percent ?? null;
    if (cur != null) {
      if (prevFat != null && Math.abs(cur - prevFat) > 3) {
        row.method_change_suspected = true;
      }
      prevFat = cur;
    }
  }
  return {
    entries: rows,
    note: "fat_percent jumps >3 points between consecutive readings are tagged method_change_suspected:true (usually a device or estimation-method change, not real body-composition change).",
  };
}

export async function getExpenditure(DB: D1Database, start?: string, end?: string) {
  const { where, params } = dateClause("date", start, end, 30);
  const r = await DB.prepare(
    `SELECT date, expenditure, calories, scale_weight, trend_weight FROM days ${where} ORDER BY date`,
  ).bind(...params).all();
  return r.results;
}

export async function getSteps(DB: D1Database, start?: string, end?: string) {
  const { where, params } = dateClause("date", start, end, 30);
  const extra = where ? `${where} AND` : "WHERE";
  const r = await DB.prepare(`SELECT date, steps FROM days ${extra} steps IS NOT NULL ORDER BY date`)
    .bind(...params)
    .all();
  return r.results;
}

export async function getFoodLog(DB: D1Database, start?: string, end?: string) {
  const { where, params } = dateClause("date", start, end, 7);
  const r = await DB.prepare(
    `SELECT date, time, name, serving_size, serving_qty, serving_weight_g, calories, protein, carbs, fat
     FROM food_log ${where} ORDER BY date, time`,
  ).bind(...params).all();
  const rows = r.results as any[];

  let intents: any[] = [];
  try {
    const { where: iWhere, params: iParams } = dateClause("date", start, end, 7);
    intents = (await DB.prepare(
      `SELECT date, name, calories, intended_time, matched_exported_time FROM food_intent_log WHERE status = 'matched'${iWhere ? ` AND ${iWhere.replace(/^WHERE /, "")}` : ""}`,
    ).bind(...iParams).all()).results as any[];
  } catch {
    intents = [];
  }

  const consumed = new Set<number>();
  return rows.map((row) => {
    const flags = foodItemFlags(row);
    const idx = intents.findIndex(
      (it, i) =>
        !consumed.has(i) &&
        it.date === row.date &&
        it.name.toLowerCase() === (row.name ?? "").toLowerCase() &&
        it.matched_exported_time === row.time,
    );
    const out = flags.length ? { ...row, suspect: flags } : { ...row };
    if (idx !== -1) {
      out.intended_time = intents[idx].intended_time;
      consumed.add(idx);
    }
    return out;
  });
}

export async function searchFoods(DB: D1Database, query: string) {
  const r = await DB.prepare(
    `SELECT name, brand, source, serving_size, serving_qty, serving_weight_g, calories, protein, fat, carbs
     FROM food_library
     WHERE name LIKE ?
     ORDER BY (calories IS NULL), name
     LIMIT 25`,
  ).bind(`%${query}%`).all();
  const rows = r.results as any[];
  return {
    loggable: rows.filter((x) => x.calories != null),
    name_only: rows.filter((x) => x.calories == null).map((x) => ({ name: x.name, source: x.source })),
    note:
      "loggable rows have stored per-serving macros and can be logged directly with log_saved_food " +
      "(servings scales the saved serving). name_only rows are history entries without stored macros — " +
      "log those with log_food and explicit macros.",
  };
}

export async function dataStatus(DB: D1Database) {
  // Tolerant of a table that doesn't exist yet (e.g. a new table deployed before its migration):
  // such a query returns null rather than rejecting the whole data_status call.
  const q = async (sql: string) => {
    try {
      return (await DB.prepare(sql).first()) as Record<string, unknown> | null;
    } catch {
      return null;
    }
  };
  const liveRow = await q(
    `SELECT date, calories, protein, carbs, fat, updated_at FROM today_summary ORDER BY date DESC LIMIT 1`,
  );
  const today_live = liveRow
    ? {
        date: liveRow.date,
        calories: liveRow.calories,
        protein: liveRow.protein,
        carbs: liveRow.carbs,
        fat: liveRow.fat,
        updated_at: liveRow.updated_at != null ? new Date(Number(liveRow.updated_at)).toISOString() : null,
        updated_ago: ageFrom(liveRow.updated_at as number),
        is_current_day: liveRow.date === todayLocal(),
      }
    : { note: "No live Today-Summary posts yet — set up the 'MF Today → MCP' shortcut for a live 'today'." };
  let last_imports: unknown[] = [];
  try {
    const importRows = (await DB.prepare(
      `SELECT created, file_type, counts FROM import_log ORDER BY created DESC LIMIT 5`,
    ).all()).results as any[];
    last_imports = importRows.map((r) => ({
      uploaded_at: new Date(Number(r.created)).toISOString(),
      file_type: r.file_type,
      counts: JSON.parse(r.counts as string),
    }));
  } catch (_e) {
    // import_log not yet created (pre-migration) — empty list, not a fatal error.
  }

  // Run all count queries in a single batch for performance. On error (e.g. a table that
  // doesn't exist yet fails the whole D1 batch) fall back to the per-query q() path so
  // missing-table tolerance is preserved.
  const countSqls = [
    `SELECT COUNT(*) AS n, MIN(date) AS first, MAX(date) AS last FROM days`,
    `SELECT COUNT(*) AS n, MAX(date) AS last FROM micronutrients`,
    `SELECT COUNT(*) AS n, MIN(date) AS first, MAX(date) AS last FROM food_log`,
    `SELECT COUNT(*) AS n FROM food_library`,
    `SELECT COUNT(*) AS n, MAX(program_date) AS latest_program FROM nutrition_targets`,
    `SELECT COUNT(*) AS n, MIN(date) AS first, MAX(date) AS last FROM workout_sets`,
    `SELECT COUNT(*) AS n, MAX(date) AS last FROM exercise_metrics`,
    `SELECT COUNT(*) AS n FROM pr_baseline`,
    `SELECT COUNT(*) AS n, MAX(detected_at) AS last_detected_ms FROM pr_alerts`,
    `SELECT COUNT(*) AS n, MAX(date) AS last FROM body_metrics`,
    `SELECT COUNT(*) AS n FROM training_programs`,
    `SELECT COUNT(*) AS n FROM pending_food`,
    `SELECT COUNT(*) AS n FROM pending_water`,
    `SELECT COUNT(*) AS n FROM pending_weight`,
    `SELECT COUNT(*) AS n, COALESCE(SUM(item_count), 0) AS total_items FROM pending_batch
       WHERE claimed_at IS NULL OR claimed_at < (CAST(strftime('%s','now') * 1000 AS INTEGER) - 600000)`,
  ];

  const toResult = (rows: (Record<string, unknown> | null)[]) => ({
    days: rows[0],
    micronutrients: rows[1],
    food_log: rows[2],
    food_library: rows[3],
    nutrition_targets: rows[4],
    workout_sets: rows[5],
    exercise_metrics: rows[6],
    pr_baseline: rows[7],
    pr_alerts: rows[8],
    body_metrics: rows[9],
    training_programs: rows[10],
    pending_to_log: rows[11],
    pending_water_to_log: rows[12],
    pending_weight_to_log: rows[13],
    pending_batches_to_log: rows[14],
    last_imports,
    today_live,
  });

  let rows: (Record<string, unknown> | null)[];
  try {
    const stmts = countSqls.map((sql) => DB.prepare(sql));
    const res = await DB.batch(stmts);
    rows = res.map((r) => (r.results?.[0] ?? null) as Record<string, unknown> | null);
  } catch {
    rows = [];
    for (const sql of countSqls) rows.push(await q(sql));
  }

  return toResult(rows);
}

// ---- Targets & adherence ----

// The full weekday pool from the latest program snapshot whose program_date <= date (falls back
// to the earliest program for dates that precede it).
function targetPool(targets: any[], date: string): { pool: any[]; fallback: boolean } {
  if (!targets.length) return { pool: [], fallback: false };
  const past = targets.filter((t) => t.program_date && t.program_date <= date);
  if (past.length) {
    const maxPd = past.reduce((a, t) => (t.program_date > a ? t.program_date : a), past[0].program_date);
    return { pool: past.filter((t) => t.program_date === maxPd), fallback: false };
  }
  const minPd = targets.reduce((a, t) => (a == null || t.program_date < a ? t.program_date : a), null as string | null);
  return { pool: targets.filter((t) => t.program_date === minPd), fallback: true };
}

// Effective nutrition target for a date: the pool row matched to the date's calendar weekday.
export function resolveTarget(targets: any[], date: string): any | null {
  const { pool, fallback } = targetPool(targets, date);
  if (!pool.length) return null;
  const wd = weekdayOf(date);
  const row = pool.find((t) => t.weekday === wd) ?? pool[0];
  return row ? { ...row, _fallback: fallback } : null;
}

const WEEKDAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export async function getTargets(DB: D1Database, date?: string, week?: boolean) {
  const d = date ?? todayLocal();
  const targets = (await DB.prepare(`SELECT * FROM nutrition_targets`).all()).results as any[];
  const t = resolveTarget(targets, d);

  const goals = (await DB.prepare(`SELECT * FROM weight_goals ORDER BY rowid`).all()).results as any[];
  const active = goals.find((g) => g.status === "In Progress") ?? goals[goals.length - 1] ?? null;
  const latest = (await DB.prepare(
    `SELECT date, trend_weight, scale_weight FROM days WHERE trend_weight IS NOT NULL ORDER BY date DESC LIMIT 1`,
  ).first()) as any | null;

  let weight_goal: any = null;
  if (active) {
    const current = latest?.trend_weight ?? null;
    const gw = active.goal_weight ?? null;
    weight_goal = {
      goal: active.goal,
      status: active.status,
      start_date: active.start_date,
      goal_weight_kg: gw,
      goal_rate_pct_per_week: active.goal_rate_pct,
      starting_trend_weight_kg: active.starting_trend_weight ?? active.starting_scale_weight ?? null,
      current_trend_weight_kg: current,
      current_trend_date: latest?.date ?? null,
      to_go_kg: current != null && gw != null ? round(current - gw, 2) : null,
    };
  }

  const programDates = [...new Set(targets.map((t) => t.program_date))].sort();
  const latestProgram = programDates.length ? programDates[programDates.length - 1] : null;
  const exp7 = (await DB.prepare(
    `SELECT AVG(expenditure) AS avg FROM days WHERE expenditure IS NOT NULL AND date >= date('now', '-7 days')`,
  ).first()) as any | null;
  const avgExp7 = exp7?.avg != null ? round(exp7.avg as number, 0) : null;
  const staleness = {
    latest_program_date: latestProgram,
    program_age_days: latestProgram ? daysBetween(latestProgram, d) : null,
    current_avg_expenditure_7d: avgExp7,
    target_vs_expenditure_delta:
      t?.calories != null && avgExp7 != null ? round(t.calories - avgExp7, 0) : null,
    note:
      "program_age_days counts since the last program snapshot in your export — a big age after you changed " +
      "goals in-app means the target shown here is stale; re-export to refresh. target_vs_expenditure_delta = " +
      "target calories − 7-day avg TDEE (your currently-implied surplus/deficit).",
  };
  return {
    date: d,
    weekday: weekdayOf(d),
    target: t
      ? {
          program_date: t.program_date,
          calories: t.calories,
          protein: t.protein,
          carbs: t.carbs,
          fat: t.fat,
          expenditure: t.expenditure,
          daily_average: t.daily_average,
          reference_weight_kg: t.weight,
          expenditure_mode: t.expenditure_mode,
          ...(t._fallback ? { note: "date precedes first program; showing earliest program" } : {}),
        }
      : null,
    ...(week
      ? {
          week: targetPool(targets, d).pool
            .slice()
            .sort((a, b) => WEEKDAY_ORDER.indexOf(a.weekday) - WEEKDAY_ORDER.indexOf(b.weekday))
            .map((w) => ({
              weekday: w.weekday,
              calories: w.calories,
              protein: w.protein,
              carbs: w.carbs,
              fat: w.fat,
              daily_average: w.daily_average,
            })),
        }
      : {}),
    weight_goal,
    programs: { count: programDates.length, dates: programDates },
    staleness,
    units: "kcal / g / kg",
  };
}

// Full weight-goal history with planned-vs-actual per goal. get_targets only ever surfaces the
// active goal; this exposes every row of weight_goals for bulk/cut/recomp retrospectives.
export async function getGoalHistory(DB: D1Database) {
  const goals = (await DB.prepare(`SELECT * FROM weight_goals ORDER BY rowid`).all()).results as any[];
  const latest = (await DB.prepare(
    `SELECT date, trend_weight FROM days WHERE trend_weight IS NOT NULL ORDER BY date DESC LIMIT 1`,
  ).first()) as any | null;

  const entries = goals.map((g) => {
    const inProgress = g.status === "In Progress";
    const startWt = g.starting_trend_weight ?? g.starting_scale_weight ?? null;
    const endWt = inProgress ? latest?.trend_weight ?? null : g.ending_trend_weight ?? g.ending_scale_weight ?? null;
    const endDate = inProgress ? latest?.date ?? null : g.end_date ?? null;
    const durationDays = g.start_date && endDate ? daysBetween(g.start_date, endDate) : null;
    const changeKg = startWt != null && endWt != null ? round(endWt - startWt, 2) : null;
    const rateKgWk = changeKg != null && durationDays ? round(changeKg / (durationDays / 7), 3) : null;
    const ratePctWk = rateKgWk != null && startWt ? round((rateKgWk / startWt) * 100, 2) : null;
    return {
      goal: g.goal,
      status: g.status,
      start_date: g.start_date,
      end_date: g.end_date,
      goal_weight_kg: g.goal_weight,
      planned: {
        rate_pct_per_week: g.goal_rate_pct,
        original_eta_days: g.original_eta_days,
      },
      actual: {
        as_of: endDate,
        duration_days: durationDays,
        starting_trend_weight_kg: startWt != null ? round(startWt, 2) : null,
        ending_trend_weight_kg: endWt != null ? round(endWt, 2) : null,
        weight_change_kg: changeKg,
        rate_kg_per_week: rateKgWk,
        rate_pct_per_week: ratePctWk,
      },
      ...(g.checkpoint_date ? { checkpoint: { date: g.checkpoint_date, weight_kg: g.checkpoint_weight } } : {}),
      ...(durationDays != null && g.original_eta_days != null
        ? { vs_plan: { duration_vs_eta_days: round(durationDays - g.original_eta_days, 0) } }
        : {}),
    };
  });

  return {
    count: entries.length,
    goals: entries,
    note:
      "Every MacroFactor weight goal, oldest first (get_targets shows only the active one). actual.* uses " +
      "trend weight; for an In-Progress goal it runs to the latest trend reading. planned.rate_pct_per_week " +
      "is unsigned — direction comes from the goal type. Maintenance goals legitimately show near-zero rates.",
  };
}

export async function getAdherence(DB: D1Database, start?: string, end?: string) {
  const { where, params } = dateClause("date", start, end, 30);
  const extra = where ? `${where} AND` : "WHERE";
  const days = (await DB.prepare(
    `SELECT date, calories, protein, carbs, fat, expenditure FROM days
     ${extra} calories IS NOT NULL ORDER BY date`,
  ).bind(...params).all()).results as any[];
  const targets = (await DB.prepare(`SELECT * FROM nutrition_targets`).all()).results as any[];

  const today = todayLocal();
  const perDay: any[] = [];
  let calOnTarget = 0, calEval = 0, proHit = 0, proEval = 0;
  let sumCalDiff = 0, sumProDiff = 0, sumPro = 0, nWithTarget = 0, nWithPro = 0;
  let cumVsTarget = 0, cumVsExp = 0, nExp = 0;
  let sumCarbDiff = 0, nCarbDiff = 0, sumFatDiff = 0, nFatDiff = 0;

  for (const day of days) {
    const C = day.calories, P = day.protein, Cb = day.carbs, F = day.fat, E = day.expenditure;
    const balance = C != null && E != null ? round(C - E, 0) : null;
    if (balance != null) { cumVsExp += balance; nExp++; }

    const t = resolveTarget(targets, day.date);
    const entry: any = {
      date: day.date,
      ...(day.date === today ? { partial: true } : {}),
      intake: { calories: C, protein: P, carbs: Cb, fat: F },
      target: null,
      vs_target: null,
      energy_balance_vs_expenditure: balance,
    };

    if (t && t.calories != null && C != null) {
      const calDiff = round(C - t.calories, 0);
      const calOk = Math.abs(C - t.calories) / t.calories <= 0.05;
      const proDiff = P != null && t.protein != null ? round(P - t.protein, 1) : null;
      const proOk = P != null && t.protein != null ? P >= 0.95 * t.protein : false;
      const carbDiff = Cb != null && t.carbs != null ? round(Cb - t.carbs, 0) : null;
      const fatDiff = F != null && t.fat != null ? round(F - t.fat, 0) : null;
      entry.target = { calories: t.calories, protein: t.protein, carbs: t.carbs, fat: t.fat };
      entry.vs_target = {
        calorie_diff: calDiff,
        calorie_pct: round((C / t.calories) * 100, 1),
        calorie_on_target: calOk,
        protein_diff: proDiff,
        protein_hit: proOk,
        carb_diff: carbDiff,
        fat_diff: fatDiff,
      };
      calEval++; if (calOk) calOnTarget++;
      if (P != null && t.protein != null) { proEval++; if (proOk) proHit++; sumProDiff += proDiff as number; }
      if (carbDiff != null) { sumCarbDiff += carbDiff; nCarbDiff++; }
      if (fatDiff != null) { sumFatDiff += fatDiff; nFatDiff++; }
      sumCalDiff += calDiff; cumVsTarget += calDiff; nWithTarget++;
      if (P != null) { sumPro += P; nWithPro++; }
    }
    perDay.push(entry);
  }

  const summary = {
    days_evaluated: days.length,
    days_with_target: nWithTarget,
    calorie_on_target_rate_pct: calEval ? round((calOnTarget / calEval) * 100, 0) : null,
    protein_hit_rate_pct: proEval ? round((proHit / proEval) * 100, 0) : null,
    avg_calorie_diff: nWithTarget ? round(sumCalDiff / nWithTarget, 0) : null,
    avg_protein_diff: proEval ? round(sumProDiff / proEval, 1) : null,
    avg_carb_diff: nCarbDiff ? round(sumCarbDiff / nCarbDiff, 1) : null,
    avg_fat_diff: nFatDiff ? round(sumFatDiff / nFatDiff, 1) : null,
    avg_protein: nWithPro ? round(sumPro / nWithPro, 0) : null,
    cumulative_vs_target_kcal: nWithTarget ? round(cumVsTarget, 0) : null,
    cumulative_vs_expenditure_kcal: nExp ? round(cumVsExp, 0) : null,
    est_kg_change_from_balance: nExp ? round(cumVsExp / 7700, 2) : null,
    note: "calorie_on_target = within ±5% of target; protein_hit = ≥95% of target; +diff = surplus/over (avg_carb_diff/avg_fat_diff in g/day vs target). est_kg uses 7700 kcal/kg.",
  };

  return { range: { start: start ?? null, end: end ?? null }, summary, per_day: perDay };
}

// ---- Weekly summary (rolling digest over finalized daily data) ----

export async function getWeeklySummary(DB: D1Database, end_date?: string, windowsArg?: number[]) {
  const end = end_date ?? todayLocal();
  let windows = (windowsArg && windowsArg.length ? windowsArg : [7, 14, 28])
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  if (!windows.length) windows = [7, 14, 28];
  const maxN = Math.max(...windows);
  const start = addDays(end, -(maxN - 1));

  const days = (await DB.prepare(
    `SELECT date, calories, protein, carbs, fat, alcohol_g, expenditure, trend_weight, scale_weight, steps
     FROM days WHERE date >= ? AND date <= ? ORDER BY date`,
  ).bind(start, end).all()).results as any[];
  const targets = (await DB.prepare(`SELECT * FROM nutrition_targets`).all()).results as any[];
  const mv = (await DB.prepare(
    `SELECT date, muscle, sets, volume_kg FROM muscle_volume WHERE date >= ? AND date <= ?`,
  ).bind(start, end).all()).results as any[];
  const allSets = (await DB.prepare(
    `SELECT date, exercise, weight_kg, reps FROM workout_sets WHERE weight_kg IS NOT NULL AND reps IS NOT NULL`,
  ).all()).results as any[];

  const goals = (await DB.prepare(`SELECT * FROM weight_goals ORDER BY rowid`).all()).results as any[];
  const goal = goals.find((g) => g.status === "In Progress") ?? goals[goals.length - 1] ?? null;

  // All-time best e1RM per exercise (with the date achieved), to flag recently-set PRs.
  const bestByEx = new Map<string, { e1rm: number; weight: number; reps: number; date: string }>();
  for (const s of allSets) {
    const e1 = s.weight_kg * (1 + s.reps / 30);
    const cur = bestByEx.get(s.exercise);
    if (!cur || e1 > cur.e1rm) bestByEx.set(s.exercise, { e1rm: e1, weight: s.weight_kg, reps: s.reps, date: s.date });
  }

  const block = (N: number) => {
    const wStart = addDays(end, -(N - 1));
    const wd = days.filter((r) => r.date >= wStart && r.date <= end);

    const cal = wd.filter((r) => r.calories != null).map((r) => r.calories);
    const pro = wd.filter((r) => r.protein != null).map((r) => r.protein);
    const carb = wd.filter((r) => r.carbs != null).map((r) => r.carbs);
    const fat = wd.filter((r) => r.fat != null).map((r) => r.fat);
    const alc = wd.filter((r) => r.alcohol_g != null && r.alcohol_g > 0);
    const actualSpan = wd.length >= 2 ? daysBetween(wd[0].date, wd[wd.length - 1].date) + 1 : wd.length;

    let calEval = 0, calOn = 0, proEval = 0, proHit = 0, sumCalDiff = 0, cumVsExp = 0, nExp = 0;
    let sumCarbDiff = 0, nCarbDiff = 0, sumFatDiff = 0, nFatDiff = 0;
    for (const r of wd) {
      if (r.calories != null && r.expenditure != null) { cumVsExp += r.calories - r.expenditure; nExp++; }
      const t = resolveTarget(targets, r.date);
      if (t && t.calories > 0 && r.calories != null) {
        calEval++;
        if (Math.abs(r.calories - t.calories) / t.calories <= 0.05) calOn++;
        sumCalDiff += r.calories - t.calories;
        if (r.protein != null && t.protein != null) { proEval++; if (r.protein >= 0.95 * t.protein) proHit++; }
        if (r.carbs != null && t.carbs != null) { sumCarbDiff += r.carbs - t.carbs; nCarbDiff++; }
        if (r.fat != null && t.fat != null) { sumFatDiff += r.fat - t.fat; nFatDiff++; }
      }
    }

    const tw = wd.filter((r) => r.trend_weight != null);
    let weight: any = {
      start_kg: null, end_kg: null, change_kg: null, rate_kg_per_week: null, rate_pct_per_week: null, span_days: null,
    };
    if (tw.length >= 2) {
      const a = tw[0], b = tw[tw.length - 1];
      const span = daysBetween(a.date, b.date) || 1;
      const change = b.trend_weight - a.trend_weight;
      const ratePerWeek = change / (span / 7);
      weight = {
        start_kg: round(a.trend_weight, 2),
        end_kg: round(b.trend_weight, 2),
        change_kg: round(change, 2),
        span_days: span,
        rate_kg_per_week: round(ratePerWeek, 3),
        rate_pct_per_week: a.trend_weight ? round((ratePerWeek / a.trend_weight) * 100, 2) : null,
      };
    } else if (tw.length === 1) {
      weight.start_kg = weight.end_kg = round(tw[0].trend_weight, 2);
    }

    const exp = wd.filter((r) => r.expenditure != null);
    const expVals = exp.map((r) => r.expenditure);
    const expDrift = exp.length >= 2 ? round(exp[exp.length - 1].expenditure - exp[0].expenditure, 0) : null;

    const wmv = mv.filter((r) => r.date >= wStart && r.date <= end);
    const muscle = new Map<string, { sets: number; volume_kg: number }>();
    for (const r of wmv) {
      const m = muscle.get(r.muscle) ?? { sets: 0, volume_kg: 0 };
      if (r.sets != null) m.sets += r.sets;
      if (r.volume_kg != null) m.volume_kg += r.volume_kg;
      muscle.set(r.muscle, m);
    }
    const per_muscle = [...muscle.entries()]
      .map(([m, v]) => ({ muscle: m, sets: round(v.sets, 1), volume_kg: round(v.volume_kg, 0) }))
      .sort((a, b) => b.sets - a.sets);
    const sessionDates = new Set(allSets.filter((s) => s.date >= wStart && s.date <= end).map((s) => s.date));

    return {
      window_days: N,
      range: { start: wStart, end },
      days_with_data: wd.length,
      actual_span_days: actualSpan,
      ...(wd.length < N ? { coverage_note: `only ${wd.length} of ${N} days have data — treat this window as ~${actualSpan}d of history` } : {}),
      nutrition: {
        avg_calories: cal.length ? round(mean(cal)!, 0) : null,
        avg_protein: pro.length ? round(mean(pro)!, 0) : null,
        avg_carbs: carb.length ? round(mean(carb)!, 0) : null,
        avg_fat: fat.length ? round(mean(fat)!, 0) : null,
        avg_alcohol_g_per_day: wd.length ? round(wd.reduce((a, r) => a + (r.alcohol_g ?? 0), 0) / wd.length, 1) : null,
        drinking_days: alc.length,
        logged_days: cal.length,
      },
      adherence: {
        calorie_on_target_rate_pct: calEval ? round((calOn / calEval) * 100, 0) : null,
        protein_hit_rate_pct: proEval ? round((proHit / proEval) * 100, 0) : null,
        avg_calorie_diff: calEval ? round(sumCalDiff / calEval, 0) : null,
        avg_carb_diff: nCarbDiff ? round(sumCarbDiff / nCarbDiff, 1) : null,
        avg_fat_diff: nFatDiff ? round(sumFatDiff / nFatDiff, 1) : null,
        days_with_target: calEval,
      },
      energy_balance: {
        cumulative_vs_expenditure_kcal: nExp ? round(cumVsExp, 0) : null,
        avg_daily_balance_kcal: nExp ? round(cumVsExp / nExp, 0) : null,
        est_kg_change: nExp ? round(cumVsExp / 7700, 2) : null,
        days: nExp,
      },
      weight,
      expenditure: { avg_tdee: expVals.length ? round(mean(expVals)!, 0) : null, drift_kcal: expDrift },
      training: {
        sessions: sessionDates.size,
        total_working_sets: round(per_muscle.reduce((a, m) => a + m.sets, 0), 1),
        per_muscle: per_muscle.slice(0, 8),
      },
    };
  };

  const recent_prs = [...bestByEx.entries()]
    .filter(([, b]) => b.date >= start && b.date <= end)
    .map(([exercise, b]) => ({
      exercise,
      e1rm_kg: round(b.e1rm, 1),
      top_set: `${round(b.weight, 1)}kg × ${b.reps}`,
      date: b.date,
      days_ago: daysBetween(b.date, end),
    }))
    .sort((a, b) => a.days_ago - b.days_ago);

  const windowsOut: Record<string, any> = {};
  for (const N of windows) windowsOut[`${N}d`] = block(N);

  return {
    as_of: end,
    is_partial_today: end === todayLocal(),
    goal: goal
      ? {
          goal: goal.goal,
          status: goal.status,
          goal_weight_kg: goal.goal_weight,
          goal_rate_pct_per_week: goal.goal_rate_pct,
        }
      : null,
    windows: windowsOut,
    recent_prs,
    note:
      "Rolling digest over your finalized daily data (exports), not the live 'today' feed. Averages are " +
      "over days that have data (see days_with_data / logged_days). weight rate uses trend weight at the " +
      "window's first vs last available point. expenditure.drift_kcal = TDEE change across the window. " +
      "adherence = calories within ±5% of target / protein ≥95% of target. recent_prs = all-time e1RM " +
      "bests first achieved within the longest window. For today's live partial use get_today.",
  };
}
