import { dateClause, daysBetween, mean, round, todayLocal, addDays, safeParse, weekdayOf } from "./utils";
import { resolveTarget } from "./nutrition";
import { isImplausibleMicro } from "./quality";

// ---- reconcile_energy_balance: implied maintenance vs MF TDEE ----
export async function reconcileEnergyBalance(DB: D1Database, start?: string, end?: string) {
  const { where, params } = dateClause("date", start, end, 28);
  const rows = (
    await DB.prepare(
      `SELECT date, calories, expenditure, trend_weight FROM days ${where} ORDER BY date`,
    ).bind(...params).all()
  ).results as any[];

  const withTw = rows.filter((r) => r.trend_weight != null);
  const withIntake = rows.filter((r) => r.calories != null);
  const withExp = rows.filter((r) => r.expenditure != null);

  if (withTw.length < 2) return { error: `Need at least 2 trend_weight readings in the window; found ${withTw.length}.` };
  const twStart = withTw[0].date as string;
  const twEnd = withTw[withTw.length - 1].date as string;
  const spanDays = daysBetween(twStart, twEnd);
  if (spanDays < 14) return { error: `Trend-weight span is only ${spanDays} days; need ≥14 for a reliable estimate.` };

  // Re-filter intake AND expenditure to the trend-weight span so avgIntake, deltaKg, and mfAvgTdee
  // all cover the same period (otherwise gap_kcal compares two different time windows).
  const withIntakeInSpan = withIntake.filter((r) => (r.date as string) >= twStart && (r.date as string) <= twEnd);
  if (withIntakeInSpan.length < 7) return { error: `Fewer than 7 days of logged intake within the trend-weight span; found ${withIntakeInSpan.length}.` };
  const withExpInSpan = withExp.filter((r) => (r.date as string) >= twStart && (r.date as string) <= twEnd);

  const avgIntake = mean(withIntakeInSpan.map((r) => r.calories as number))!;
  const deltaKg = (withTw[withTw.length - 1].trend_weight as number) - (withTw[0].trend_weight as number);
  const impliedSurplus = (deltaKg * 7700) / spanDays;
  const impliedMaintenance = round(avgIntake - impliedSurplus, 0);
  const mfAvgTdee = withExpInSpan.length ? round(mean(withExpInSpan.map((r) => r.expenditure as number))!, 0) : null;
  const gapKcal = mfAvgTdee != null ? round(impliedMaintenance - mfAvgTdee, 0) : null;

  let gapFlag: string | null = null;
  let interpretation: string;
  if (gapKcal == null) {
    interpretation =
      `Implied maintenance is ${impliedMaintenance} kcal/day (${spanDays}-day trend-weight delta ` +
      `${round(deltaKg * 1000, 0)} g, avg intake ${round(avgIntake, 0)} kcal). ` +
      `MF expenditure data unavailable for this window — cannot compute gap.`;
  } else {
    const absGap = Math.abs(gapKcal);
    const sign = gapKcal >= 0 ? "+" : "";
    if (absGap <= 200) {
      gapFlag = "within_noise";
      interpretation = `Implied maintenance (${impliedMaintenance} kcal) aligns with MF's TDEE (${mfAvgTdee} kcal); gap of ${sign}${gapKcal} kcal/day is within normal variability.`;
    } else if (absGap <= 400) {
      gapFlag = "meaningful";
      const dir = gapKcal < 0 ? "lower than" : "higher than";
      const hint = gapKcal < 0
        ? "This often points to under-logging — foods omitted or serving sizes underestimated."
        : "This may reflect over-logging, measurement error, or higher NEAT than MF's model assumes.";
      interpretation = `Implied maintenance (${impliedMaintenance} kcal) is ${absGap} kcal/day ${dir} MF's TDEE (${mfAvgTdee} kcal). ${hint}`;
    } else {
      gapFlag = "investigate_logging";
      const dir = gapKcal < 0 ? "lower than" : "higher than";
      const hint = gapKcal < 0
        ? "A gap this large strongly suggests under-logging — check oils, sauces, bites, drinks, or missed meals."
        : "A gap this large is unusual; verify serving sizes and whether all logged foods are actually consumed.";
      interpretation = `Implied maintenance (${impliedMaintenance} kcal) is ${absGap} kcal/day ${dir} MF's TDEE (${mfAvgTdee} kcal). ${hint}`;
    }
  }

  return {
    window: {
      start: twStart,
      end: twEnd,
      days_with_intake: withIntakeInSpan.length,
      days_with_tdee: withExpInSpan.length,
      trend_weight_span_days: spanDays,
    },
    avg_intake_kcal: round(avgIntake, 0),
    trend_weight_start_kg: round(withTw[0].trend_weight as number, 2),
    trend_weight_end_kg: round(withTw[withTw.length - 1].trend_weight as number, 2),
    trend_weight_delta_kg: round(deltaKg, 3),
    implied_surplus_kcal_per_day: round(impliedSurplus, 0),
    implied_maintenance_kcal: impliedMaintenance,
    mf_avg_tdee: mfAvgTdee,
    gap_kcal: gapKcal,
    gap_flag: gapFlag,
    interpretation,
  };
}

// ---- get_nutrient_timing: food_log grouped by hour-of-day (Worker buckets) ----
export async function getNutrientTiming(DB: D1Database, start?: string, end?: string) {
  const { where, params } = dateClause("fl.date", start, end, 14);
  const flTimeFilter = `${where ? `${where} AND` : "WHERE"} fl.time IS NOT NULL`;
  try {
    const r = await DB.prepare(
      `SELECT fl.date,
             CAST(substr(COALESCE(fi.intended_time, fl.time), 1, 2) AS INTEGER) AS hour,
             SUM(fl.calories) AS calories, SUM(fl.protein) AS protein,
             SUM(fl.carbs) AS carbs, SUM(fl.fat) AS fat, COUNT(*) AS entries
       FROM food_log fl
       LEFT JOIN (
         SELECT date, name, matched_exported_time, MIN(intended_time) AS intended_time
         FROM food_intent_log
         WHERE status = 'matched'
         GROUP BY date, LOWER(name), matched_exported_time
       ) fi ON fi.date = fl.date AND LOWER(fi.name) = LOWER(fl.name) AND fi.matched_exported_time = fl.time
       ${flTimeFilter}
       GROUP BY fl.date, CAST(substr(COALESCE(fi.intended_time, fl.time), 1, 2) AS INTEGER)
       ORDER BY fl.date, hour`,
    ).bind(...params).all();
    return r.results as {
      date: string; hour: number; calories: number; protein: number; carbs: number; fat: number; entries: number;
    }[];
  } catch {
    const { where: fbWhere, params: fbParams } = dateClause("date", start, end, 14);
    const timeFilter = `${fbWhere} AND time IS NOT NULL`;
    const r = await DB.prepare(
      `SELECT
         date,
         CAST(substr(time, 1, 2) AS INTEGER) AS hour,
         SUM(calories) AS calories,
         SUM(protein)  AS protein,
         SUM(carbs)    AS carbs,
         SUM(fat)      AS fat,
         COUNT(*)      AS entries
       FROM food_log
       ${timeFilter}
       GROUP BY date, CAST(substr(time, 1, 2) AS INTEGER)
       ORDER BY date, hour`,
    ).bind(...fbParams).all();
    return r.results as {
      date: string; hour: number; calories: number; protein: number; carbs: number; fat: number; entries: number;
    }[];
  }
}

// ---- get_nutrient_timing: Worker-side bucket aggregation ----
export async function getNutrientTimingBuckets(DB: D1Database, start?: string, end?: string) {
  const BUCKETS = [
    { name: "fasted", min: 0, max: 6 },
    { name: "morning", min: 6, max: 10 },
    { name: "midday", min: 10, max: 14 },
    { name: "afternoon", min: 14, max: 17 },
    { name: "evening", min: 17, max: 21 },
    { name: "late", min: 21, max: 24 },
  ] as const;

  const rows = await getNutrientTiming(DB, start, end);
  const dates = new Set(rows.map((r) => r.date));
  const dayCount = dates.size;

  const acc: Record<string, { cal: number; pro: number; carb: number; fat: number; entries: number; days: Set<string> }> = {};
  for (const b of BUCKETS) acc[b.name] = { cal: 0, pro: 0, carb: 0, fat: 0, entries: 0, days: new Set() };

  for (const row of rows) {
    const hour = row.hour;
    const b = BUCKETS.find((b) => hour >= b.min && hour < b.max) ?? BUCKETS[BUCKETS.length - 1];
    const a = acc[b.name];
    a.cal += row.calories ?? 0;
    a.pro += row.protein ?? 0;
    a.carb += row.carbs ?? 0;
    a.fat += row.fat ?? 0;
    a.entries += row.entries ?? 0;
    a.days.add(row.date);
  }

  const d = dayCount || 1;
  const buckets = BUCKETS.map((b) => {
    const a = acc[b.name];
    return {
      bucket: b.name,
      hours: `${String(b.min).padStart(2, "0")}:00–${String(b.max).padStart(2, "0")}:00`,
      days_with_data: a.days.size,
      total_entries: a.entries,
      avg_per_day: {
        calories: Math.round(a.cal / d),
        protein: Math.round((a.pro / d) * 10) / 10,
        carbs: Math.round((a.carb / d) * 10) / 10,
        fat: Math.round((a.fat / d) * 10) / 10,
        entries: Math.round((a.entries / d) * 10) / 10,
      },
    };
  });

  return {
    period: {
      start: rows[0]?.date ?? start ?? null,
      end: rows[rows.length - 1]?.date ?? end ?? null,
    },
    days_with_food_data: dayCount,
    note: "Log time reflects when the entry was recorded, not necessarily when the food was eaten. Rows with no time recorded are excluded. avg_per_day divides each bucket by days_with_food_data (all days with any food), so a bucket you rarely eat in shows a diluted per-day average — use that bucket's days_with_data for an on-active-days view. Items with a matched intended_time hint are bucketed at the time they were EATEN, not the tap-time.",
    buckets,
  };
}

// ---- relog_meal: aggregate a date's food_log (optional hour window) into one entry ----
export async function getFoodLogAggregate(
  DB: D1Database,
  date: string,
  startHour?: number,
  endHour?: number,
): Promise<{ item_count: number; calories: number; protein: number; carbs: number; fat: number; names: string[] } | null> {
  const params: unknown[] = [date];
  let where = "WHERE date = ?";
  if (startHour != null) {
    where += " AND time >= printf('%02d:00', ?)";
    params.push(startHour);
  }
  if (endHour != null) {
    where += " AND time < printf('%02d:00', ?)";
    params.push(endHour);
  }
  const row = (await DB.prepare(
    `SELECT COUNT(*) as item_count,
            COALESCE(SUM(calories), 0) as calories,
            COALESCE(SUM(protein),  0) as protein,
            COALESCE(SUM(carbs),    0) as carbs,
            COALESCE(SUM(fat),      0) as fat,
            GROUP_CONCAT(name, '||') as names
     FROM food_log ${where}`,
  ).bind(...params).first()) as Record<string, unknown> | null;
  if (!row || (row.item_count as number) === 0) return null;
  return {
    item_count: row.item_count as number,
    calories: row.calories as number,
    protein: row.protein as number,
    carbs: row.carbs as number,
    fat: row.fat as number,
    names: row.names ? String(row.names).split("||").filter(Boolean) : [],
  };
}

// ---- day_of_week_patterns: weekday grouping + surplus share ----
export async function getDayOfWeekPatterns(DB: D1Database, start?: string, end?: string) {
  const { where, params } = dateClause("date", start, end, 90);
  const extra = where ? `${where} AND` : "WHERE";
  const days = (await DB.prepare(
    `SELECT date, calories, protein FROM days ${extra} calories IS NOT NULL ORDER BY date`,
  ).bind(...params).all()).results as any[];

  const targets = (await DB.prepare(`SELECT * FROM nutrition_targets`).all()).results as any[];

  const ORDERED = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const buckets = new Map<string, {
    n: number; sumCal: number; sumPro: number; nPro: number;
    sumTargetCal: number; nTarget: number; sumSurplus: number;
    calOnTarget: number; proHit: number; nProTarget: number;
  }>();
  for (const wd of ORDERED) {
    buckets.set(wd, { n: 0, sumCal: 0, sumPro: 0, nPro: 0, sumTargetCal: 0, nTarget: 0, sumSurplus: 0, calOnTarget: 0, proHit: 0, nProTarget: 0 });
  }

  let daysWithTarget = 0;
  for (const day of days) {
    const wd = weekdayOf(day.date);
    const b = buckets.get(wd)!;
    b.n++;
    b.sumCal += day.calories;
    if (day.protein != null) { b.sumPro += day.protein; b.nPro++; }

    const t = resolveTarget(targets, day.date);
    if (t && t.calories != null) {
      daysWithTarget++;
      b.nTarget++;
      b.sumTargetCal += t.calories;
      const surplus = day.calories - t.calories;
      b.sumSurplus += surplus;
      if (Math.abs(surplus) / t.calories <= 0.05) b.calOnTarget++;
      if (day.protein != null && t.protein != null) {
        b.nProTarget++;
        if (day.protein >= 0.95 * t.protein) b.proHit++;
      }
    }
  }

  let grandTotalSurplus = 0;
  for (const b of buckets.values()) grandTotalSurplus += b.sumSurplus;
  const absGrand = Math.abs(grandTotalSurplus);

  const weekdays = ORDERED
    .filter((wd) => (buckets.get(wd)?.n ?? 0) > 0)
    .map((wd) => {
      const b = buckets.get(wd)!;
      const hasTarget = b.nTarget > 0;
      return {
        weekday: wd,
        n: b.n,
        avg_calories: round(b.sumCal / b.n, 0),
        avg_protein: b.nPro ? round(b.sumPro / b.nPro, 0) : null,
        avg_target_calories: hasTarget ? round(b.sumTargetCal / b.nTarget, 0) : null,
        avg_calorie_surplus: hasTarget ? round(b.sumSurplus / b.nTarget, 0) : null,
        calorie_on_target_rate_pct: b.nTarget ? round((b.calOnTarget / b.nTarget) * 100, 0) : null,
        protein_hit_rate_pct: b.nProTarget ? round((b.proHit / b.nProTarget) * 100, 0) : null,
        cumulative_surplus: hasTarget ? round(b.sumSurplus, 0) : null,
        surplus_share_pct: hasTarget && absGrand > 0 ? round((b.sumSurplus / absGrand) * 100, 1) : null,
      };
    })
    .sort((a, b) => ((b.avg_calorie_surplus ?? -Infinity) - (a.avg_calorie_surplus ?? -Infinity)));

  const highestLeverage = weekdays.find((w) => w.avg_calorie_surplus != null)?.weekday ?? null;

  return {
    range: { start: start ?? null, end: end ?? null },
    days_analyzed: days.length,
    days_with_target: daysWithTarget,
    weekdays,
    highest_leverage_day: highestLeverage,
    note: "calorie_on_target = within ±5% of target calories; protein_hit = ≥95% of target protein, evaluated only on days where both intake and target protein are non-null; surplus_share_pct = this weekday's share of the absolute total surplus (null when total is exactly zero). Weekdays with no data are omitted.",
  };
}

// ---- forecast_weight: OLS (calendar-day x-axis) + calorie-math ETA ----
export async function getForecastWeight(DB: D1Database, target_date?: string) {
  const today = todayLocal();
  const windowStart = addDays(today, -55); // 56 days inclusive

  const rows = (
    await DB.prepare(
      `SELECT date, trend_weight, calories, expenditure
       FROM days WHERE date >= ? AND date <= ? AND trend_weight IS NOT NULL
       ORDER BY date`,
    ).bind(windowStart, today).all()
  ).results as any[];

  const n = rows.length;
  const nullOls = { slope_kg_per_day: null, slope_kg_per_week: null, r_squared: null, eta_date: null, eta_days: null };
  const nullCal = { avg_intake_kcal: null, avg_tdee_kcal: null, avg_daily_deficit_kcal: null, calorie_math_rows: 0, loss_goal_only: true, eta_date: null, eta_days: null };

  const goals = (await DB.prepare(`SELECT * FROM weight_goals ORDER BY rowid`).all()).results as any[];
  const goal = goals.find((g) => g.status === "In Progress") ?? goals[goals.length - 1] ?? null;
  const goalWeight: number | null = goal?.goal_weight ?? null;

  const baseShape = (extra: Record<string, unknown>) => ({
    as_of: today,
    data_window_days: 56,
    data_points: n,
    ...extra,
    goal: goal
      ? {
          goal: goal.goal,
          goal_weight_kg: goal.goal_weight != null ? round(goal.goal_weight, 2) : null,
          goal_rate_pct: goal.goal_rate_pct ?? null,
          start_date: goal.start_date ?? null,
          end_date: goal.end_date ?? null,
          status: goal.status,
        }
      : null,
  });

  if (n < 7) {
    return baseShape({
      error: "insufficient_data",
      current_trend_weight_kg: n > 0 ? round(rows[n - 1].trend_weight as number, 2) : null,
      goal_weight_kg: goalWeight != null ? round(goalWeight, 2) : null,
      kg_remaining: null,
      ols_regression: nullOls,
      calorie_math: nullCal,
      divergence_days: null,
      weeks_relative_to_goal: null,
      required_daily_deficit_kcal: null,
      note: `Only ${n} trend_weight data point(s) in the last 56 days — need at least 7 for a regression.`,
    });
  }

  const refDate = rows[0].date as string;
  const xs = rows.map((r) => daysBetween(refDate, r.date as string));
  const ys = rows.map((r) => r.trend_weight as number);
  const xm = mean(xs)!;
  const ym = mean(ys)!;
  let Sxy = 0, Sxx = 0, Syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - xm;
    const dy = ys[i] - ym;
    Sxy += dx * dy;
    Sxx += dx * dx;
    Syy += dy * dy;
  }
  const slope = Sxx > 0 ? Sxy / Sxx : 0;
  const r2 = Sxx > 0 && Syy > 0 ? (Sxy * Sxy) / (Sxx * Syy) : null;
  const currentTrend = ys[n - 1];

  const calRows = rows.filter((r) => r.calories != null && r.expenditure != null);
  const avgIntake = mean(calRows.map((r) => r.calories as number));
  const avgTdee = mean(calRows.map((r) => r.expenditure as number));
  const avgDeficit = avgIntake != null && avgTdee != null ? avgTdee - avgIntake : null;

  let olsEtaDays: number | null = null;
  let olsEtaDate: string | null = null;
  if (goalWeight != null && slope !== 0) {
    const raw = (goalWeight - currentTrend) / slope;
    if (raw > 0 && raw < 3650) {
      olsEtaDays = Math.round(raw);
      olsEtaDate = addDays(today, olsEtaDays);
    }
  }

  let calEtaDays: number | null = null;
  let calEtaDate: string | null = null;
  if (goalWeight != null && avgDeficit != null && avgDeficit > 0) {
    const kgRemaining = currentTrend - goalWeight;
    if (kgRemaining > 0) {
      const raw = Math.round((kgRemaining * 7700) / avgDeficit);
      if (raw > 0 && raw < 3650) {
        calEtaDays = raw;
        calEtaDate = addDays(today, calEtaDays);
      }
    }
  }

  const divergenceDays = olsEtaDays != null && calEtaDays != null ? Math.abs(olsEtaDays - calEtaDays) : null;

  let weeksRelative: number | null = null;
  if (goal?.end_date && olsEtaDate) {
    weeksRelative = round(daysBetween(olsEtaDate, goal.end_date as string) / 7, 1);
  }

  let requiredDailyDeficit: number | null = null;
  if (target_date && goalWeight != null && currentTrend > goalWeight) {
    const daysAvail = daysBetween(today, target_date);
    if (daysAvail > 0) {
      requiredDailyDeficit = Math.round(((currentTrend - goalWeight) * 7700) / daysAvail);
    }
  }

  return baseShape({
    error: null,
    current_trend_weight_kg: round(currentTrend, 2),
    goal_weight_kg: goalWeight != null ? round(goalWeight, 2) : null,
    kg_remaining: goalWeight != null ? round(currentTrend - goalWeight, 2) : null,
    ols_regression: {
      slope_kg_per_day: round(slope, 4),
      slope_kg_per_week: round(slope * 7, 3),
      r_squared: r2 != null ? round(r2, 3) : null,
      eta_date: olsEtaDate,
      eta_days: olsEtaDays,
    },
    calorie_math: {
      avg_intake_kcal: avgIntake != null ? round(avgIntake) : null,
      avg_tdee_kcal: avgTdee != null ? round(avgTdee) : null,
      avg_daily_deficit_kcal: avgDeficit != null ? round(avgDeficit) : null,
      calorie_math_rows: calRows.length,
      loss_goal_only: true,
      eta_date: calEtaDate,
      eta_days: calEtaDays,
    },
    divergence_days: divergenceDays,
    weeks_relative_to_goal: weeksRelative,
    required_daily_deficit_kcal: requiredDailyDeficit,
    note: n < 14 ? `Only ${n} trend_weight points — regression may be unreliable; 28+ recommended.` : null,
  });
}

// ---- detect_stall: plateau vs metabolic-adaptation classifier ----
export async function detectStall(DB: D1Database, recentDays = 14, mediumDays = 28) {
  if (mediumDays <= recentDays) mediumDays = recentDays * 2;
  const STALL = 0.10; // kg/week

  const allRows = (await DB.prepare(
    `SELECT date, trend_weight, expenditure
     FROM days
     WHERE (trend_weight IS NOT NULL OR expenditure IS NOT NULL)
       AND date >= date('now', '-365 days')
     ORDER BY date ASC`,
  ).all()).results as any[];

  const goals = (await DB.prepare(`SELECT * FROM weight_goals ORDER BY rowid`).all()).results as any[];

  const twRows = allRows.filter((r) => r.trend_weight != null);
  const expRows = allRows.filter((r) => r.expenditure != null);
  const today = todayLocal();

  function rateWindow(days: number): { rate: number; span_days: number } | null {
    if (twRows.length < 2) return null;
    const last = twRows[twRows.length - 1];
    const cutoff = addDays(last.date, -days);
    const first = twRows.find((r) => r.date >= cutoff);
    if (!first || first.date === last.date) return null;
    const span = daysBetween(first.date, last.date);
    return { rate: round((last.trend_weight - first.trend_weight) / (span / 7), 3), span_days: span };
  }

  const recent = rateWindow(recentDays);
  const medium = rateWindow(mediumDays);

  const active = goals.find((g: any) => g.status === "In Progress") ?? goals[goals.length - 1] ?? null;
  let goalBlock: any = null;
  let goalRateKgPerWeek: number | null = null;
  if (active) {
    const startWt = active.starting_trend_weight ?? active.starting_scale_weight ?? null;
    if (active.goal_rate_pct != null && startWt != null) {
      const mag = (active.goal_rate_pct / 100) * startWt;
      const isLoss = String(active.goal ?? "").toLowerCase().includes("lose");
      goalRateKgPerWeek = round(isLoss ? -Math.abs(mag) : Math.abs(mag), 3);
    }
    goalBlock = {
      goal: active.goal,
      start_date: active.start_date ?? null,
      goal_weight_kg: active.goal_weight ?? null,
      goal_rate_pct_per_week: active.goal_rate_pct ?? null,
      goal_rate_kg_per_week: goalRateKgPerWeek,
      starting_trend_weight_kg: active.starting_trend_weight ?? active.starting_scale_weight ?? null,
    };
  }

  const isPlateaued = recent != null ? Math.abs(recent.rate) < STALL : false;

  let stallDurationDays = 0;
  if (isPlateaued && twRows.length >= 2) {
    let stallSince = twRows[0].date;
    outer: for (let i = twRows.length - 1; i >= 1; i--) {
      const end = twRows[i];
      for (let j = i - 1; j >= 0; j--) {
        const ref = twRows[j];
        if (daysBetween(ref.date, end.date) >= 7) {
          const span = daysBetween(ref.date, end.date);
          const rate = (end.trend_weight - ref.trend_weight) / (span / 7);
          // The stall began AFTER this moving window — use the next (more recent) point.
          if (Math.abs(rate) >= STALL) { stallSince = twRows[i + 1]?.date ?? end.date; break outer; }
          break;
        }
      }
    }
    stallDurationDays = daysBetween(stallSince, today);
  }

  let adaptationBlock: any = null;
  const recentSlice = expRows.slice(-Math.max(recentDays, 7)); // respect recentDays, floor at 7 for stability
  const recentTdee = recentSlice.length
    ? round(recentSlice.reduce((a: number, r: any) => a + r.expenditure, 0) / recentSlice.length, 0)
    : null;

  let noTdeeBaseline = false;
  if (active?.start_date) {
    const startExpRows = expRows.filter((r: any) => r.date >= active.start_date).slice(0, 14);
    const startTdee = startExpRows.length >= 1
      ? round(startExpRows.reduce((a: number, r: any) => a + r.expenditure, 0) / startExpRows.length, 0)
      : null;
    const firstAfterStart = twRows.find((r: any) => r.date >= active.start_date);
    const lastTw = twRows[twRows.length - 1];
    const weightChangeKg = firstAfterStart && lastTw
      ? round(lastTw.trend_weight - firstAfterStart.trend_weight, 2)
      : null;
    noTdeeBaseline = startTdee == null;
    const actualDrop = startTdee != null && recentTdee != null ? startTdee - recentTdee : null;
    const expectedDrop = weightChangeKg != null ? round(Math.abs(weightChangeKg) * 22, 0) : null;
    const adaptationKcal = actualDrop != null && expectedDrop != null ? round(actualDrop - expectedDrop, 0) : null;
    adaptationBlock = {
      tdee_at_goal_start_kcal: startTdee,
      tdee_recent_kcal: recentTdee,
      actual_tdee_drop_kcal: actualDrop,
      weight_change_kg: weightChangeKg,
      expected_tdee_drop_from_weight_loss_kcal: expectedDrop,
      adaptation_kcal: adaptationKcal,
      population_approximation_note:
        "22 kcal/kg/day is a population BMR slope (Mifflin-St Jeor approximation); individual values vary by ±50 kcal/kg.",
    };
  }

  let classification = "unknown";
  if (recent != null) {
    if (isPlateaued) {
      classification = "plateaued";
    } else if (goalRateKgPerWeek != null && goalRateKgPerWeek !== 0) {
      const dir = goalRateKgPerWeek < 0 ? -1 : 1;
      if (dir * recent.rate < 0) {
        classification = "off-direction";
      } else {
        const pctOfGoal = (dir * recent.rate) / (dir * goalRateKgPerWeek);
        if (pctOfGoal >= 0.75) {
          classification = "on-track";
        } else if (adaptationBlock?.adaptation_kcal != null && adaptationBlock.adaptation_kcal > 150) {
          classification = "adapting-but-losing";
        } else {
          classification = "slower-than-goal-but-not-stalled";
        }
      }
    }
  }

  return {
    as_of: today,
    recent_days: recentDays,
    medium_days: mediumDays,
    stall_threshold_kg_per_week: STALL,
    goal: goalBlock,
    rates: {
      recent_kg_per_week: recent?.rate ?? null,
      recent_span_days: recent?.span_days ?? null,
      medium_kg_per_week: medium?.rate ?? null,
      medium_span_days: medium?.span_days ?? null,
    },
    is_plateaued: isPlateaued,
    classification,
    stall_duration_days: stallDurationDays,
    adaptation: adaptationBlock,
    flags: {
      no_active_goal: active == null,
      insufficient_recent_data: twRows.length < 2,
      no_tdee_baseline: noTdeeBaseline,
    },
  };
}

// ---- micro_gap_analysis: avg micros vs NIH DRI (keys = real export headers) ----
// Keys MUST match the verbatim "Micronutrients" sheet column headers (verified against a
// real MacroFactor export). NIH DRI for adult male 19-50. UL = Tolerable Upper Intake.
export const MICRO_RDA: Record<string, { rda: number; unit: string; ul?: number }> = {
  "Fiber (g)":                  { rda: 38,   unit: "g" },
  "Sodium (mg)":                { rda: 2300, unit: "mg",  ul: 2300 },
  "Potassium (mg)":             { rda: 3400, unit: "mg" },
  "Calcium (mg)":               { rda: 1000, unit: "mg",  ul: 2500 },
  "Iron (mg)":                  { rda: 8,    unit: "mg",  ul: 45 },
  "Magnesium (mg)":             { rda: 420,  unit: "mg" },
  "Zinc (mg)":                  { rda: 11,   unit: "mg",  ul: 40 },
  "Phosphorus (mg)":            { rda: 700,  unit: "mg",  ul: 4000 },
  "Selenium (mcg)":             { rda: 55,   unit: "mcg", ul: 400 },
  "Copper (mg)":                { rda: 0.9,  unit: "mg",  ul: 10 },
  "Manganese (mg)":             { rda: 2.3,  unit: "mg",  ul: 11 },
  "Choline (mg)":               { rda: 550,  unit: "mg",  ul: 3500 },
  "Vitamin A (mcg)":            { rda: 900,  unit: "mcg", ul: 3000 },
  "Vitamin C (mg)":             { rda: 90,   unit: "mg",  ul: 2000 },
  "Vitamin D (mcg)":            { rda: 20,   unit: "mcg", ul: 100 },
  "Vitamin E (mg)":             { rda: 15,   unit: "mg",  ul: 1000 },
  "Vitamin K (mcg)":            { rda: 120,  unit: "mcg" },
  "B1, Thiamine (mg)":          { rda: 1.2,  unit: "mg" },
  "B2, Riboflavin (mg)":        { rda: 1.3,  unit: "mg" },
  "B3, Niacin (mg)":            { rda: 16,   unit: "mg",  ul: 35 },
  "B5, Pantothenic Acid (mg)":  { rda: 5,    unit: "mg" },
  "B6, Pyridoxine (mg)":        { rda: 1.3,  unit: "mg",  ul: 100 },
  "Folate (mcg)":               { rda: 400,  unit: "mcg", ul: 1000 },
  "B12, Cobalamin (mcg)":       { rda: 2.4,  unit: "mcg" },
  "Omega-3 (g)":                { rda: 1.6,  unit: "g" },
};

export async function getMicroGapAnalysis(DB: D1Database, days = 28) {
  const end = todayLocal();
  const start = addDays(end, -(days - 1));

  const r = await DB.prepare(
    `SELECT date, payload FROM micronutrients WHERE date >= ? AND date <= ? ORDER BY date`,
  ).bind(start, end).all();

  const rows = r.results as { date: string; payload: string }[];
  const sums: Record<string, number> = {};
  const counts: Record<string, number> = {};
  const excluded: Record<string, number> = {};
  for (const row of rows) {
    const parsed = safeParse(row.payload);
    for (const [k, v] of Object.entries(parsed)) {
      const num = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
      if (!Number.isFinite(num)) continue;
      if (isImplausibleMicro(k, num)) {
        excluded[k] = (excluded[k] ?? 0) + 1;
        continue;
      }
      sums[k] = (sums[k] ?? 0) + num;
      counts[k] = (counts[k] ?? 0) + 1;
    }
  }

  type Status = "deficient" | "borderline" | "adequate" | "excess";
  const RANK: Record<Status, number> = { deficient: 0, borderline: 1, adequate: 2, excess: 3 };
  const results: {
    nutrient: string; avg_per_day: number; tracked_days: number; unit: string; rda: number; pct_rda: number; status: Status;
  }[] = [];

  for (const [nutrient, ref] of Object.entries(MICRO_RDA)) {
    const count = counts[nutrient];
    if (!count) continue; // untracked in this window — omit, never impute zero
    const avg = round(sums[nutrient] / count, 1);
    const pct_rda = Math.round((avg / ref.rda) * 100);
    let status: Status;
    if (ref.ul != null && (avg > ref.ul || pct_rda >= 200)) {
      status = "excess";
    } else if (pct_rda >= 90) {
      status = "adequate";
    } else if (pct_rda >= 66) {
      status = "borderline";
    } else {
      status = "deficient";
    }
    results.push({ nutrient, avg_per_day: avg, tracked_days: count, unit: ref.unit, rda: ref.rda, pct_rda, status });
  }

  results.sort((a, b) => RANK[a.status] - RANK[b.status] || a.pct_rda - b.pct_rda);
  return {
    window_days: days,
    start_date: start,
    end_date: end,
    days_with_data: rows.length,
    results,
    ...(Object.keys(excluded).length ? { excluded_suspect_days: excluded } : {}),
    note: "avg_per_day is averaged over tracked_days (days that key appeared), not the full window — low tracked_days means sparse data. Nutrients absent from your data are omitted (untracked, not zero). days with a physiologically implausible value (e.g. an entry error) are excluded from that nutrient's average and counted in excluded_suspect_days — the raw values remain visible via get_micronutrients.",
  };
}

// ---- get_training_day_nutrition: nutrition grouped by training-load tier ----
export async function getTrainingDayNutrition(DB: D1Database, start?: string, end?: string, detail?: string) {
  const { where, params } = dateClause("date", start, end, 60);

  const setCounts = (await DB.prepare(
    `SELECT date, COUNT(*) as set_count FROM workout_sets ${where} GROUP BY date`,
  ).bind(...params).all()).results as any[];

  const days = (await DB.prepare(
    `SELECT date, calories, protein, carbs, fat, expenditure FROM days ${where} ORDER BY date`,
  ).bind(...params).all()).results as any[];

  const targets = (await DB.prepare(`SELECT * FROM nutrition_targets`).all()).results as any[];

  const setByDate = new Map<string, number>();
  for (const r of setCounts) setByDate.set(r.date, Number(r.set_count));

  function classifyTier(sets: number): "rest" | "light" | "moderate" | "heavy" {
    if (sets === 0) return "rest";
    if (sets <= 10) return "light";
    if (sets <= 20) return "moderate";
    return "heavy";
  }

  const TIERS = ["rest", "light", "moderate", "heavy"] as const;
  const acc: Record<string, {
    day_count: number; cal: number[]; pro: number[]; carb: number[]; fat: number[]; exp: number[];
    tgt_cal: number[]; tgt_pro: number[]; cal_diff: number[]; pro_diff: number[]; days_with_target: number;
  }> = {};
  for (const k of TIERS) {
    acc[k] = { day_count: 0, cal: [], pro: [], carb: [], fat: [], exp: [], tgt_cal: [], tgt_pro: [], cal_diff: [], pro_diff: [], days_with_target: 0 };
  }

  const perDay: any[] = [];
  for (const day of days) {
    const sets = setByDate.get(day.date) ?? 0;
    const tier = classifyTier(sets);
    const t = resolveTarget(targets, day.date);
    const a = acc[tier];
    a.day_count++;
    if (day.calories != null) a.cal.push(day.calories);
    if (day.protein != null) a.pro.push(day.protein);
    if (day.carbs != null) a.carb.push(day.carbs);
    if (day.fat != null) a.fat.push(day.fat);
    if (day.expenditure != null) a.exp.push(day.expenditure);

    let tgt_cal: number | null = null;
    let tgt_pro: number | null = null;
    if (t && t.calories != null) {
      a.tgt_cal.push(t.calories);
      a.days_with_target++;
      tgt_cal = t.calories;
      if (day.calories != null) a.cal_diff.push(day.calories - t.calories);
      if (t.protein != null) {
        a.tgt_pro.push(t.protein);
        tgt_pro = t.protein;
        if (day.protein != null) a.pro_diff.push(day.protein - t.protein);
      }
    }

    perDay.push({
      date: day.date, set_count: sets, tier,
      calories: day.calories, protein: day.protein, carbs: day.carbs, fat: day.fat, expenditure: day.expenditure,
      target_calories: tgt_cal, target_protein: tgt_pro,
    });
  }

  function tierSummary(k: string) {
    const a = acc[k];
    return {
      day_count: a.day_count,
      avg_calories: a.cal.length ? round(mean(a.cal)!, 0) : null,
      avg_protein: a.pro.length ? round(mean(a.pro)!, 1) : null,
      avg_carbs: a.carb.length ? round(mean(a.carb)!, 1) : null,
      avg_fat: a.fat.length ? round(mean(a.fat)!, 1) : null,
      avg_expenditure: a.exp.length ? round(mean(a.exp)!, 0) : null,
      avg_target_calories: a.tgt_cal.length ? round(mean(a.tgt_cal)!, 0) : null,
      avg_target_protein: a.tgt_pro.length ? round(mean(a.tgt_pro)!, 1) : null,
      avg_cal_vs_target: a.cal_diff.length ? round(mean(a.cal_diff)!, 0) : null,
      avg_pro_vs_target: a.pro_diff.length ? round(mean(a.pro_diff)!, 1) : null,
      days_with_target: a.days_with_target,
      days_with_nutrition: a.cal.length,
    };
  }

  const perTier = {
    rest: tierSummary("rest"), light: tierSummary("light"),
    moderate: tierSummary("moderate"), heavy: tierSummary("heavy"),
  };

  function delta(a: number | null, b: number | null): number | null {
    return a != null && b != null ? round(a - b, 0) : null;
  }
  const hvActual = delta(perTier.heavy.avg_calories, perTier.rest.avg_calories);
  const hvProgramd = delta(perTier.heavy.avg_target_calories, perTier.rest.avg_target_calories);

  const defaulted = !start && !end;
  return {
    range: { start: start ?? null, end: end ?? null, ...(defaulted ? { default_window_days: 60 } : {}) },
    note: "set_count = all rows in workout_sets for the date (Standard + Warm-Up sets). Days in `days` with no workout_sets rows are classified as rest. Nutrition values come from your exported data (not the live /today feed) — use get_today for the live current day. avg_cal_vs_target is averaged over days where both actual and target calories are non-null.",
    tier_definitions: { rest: "0 sets", light: "1–10 sets", moderate: "11–20 sets", heavy: "21+ sets" },
    per_tier: perTier,
    delta_analysis: {
      heavy_vs_rest_actual_kcal: hvActual,
      heavy_vs_rest_programmed_kcal: hvProgramd,
      delta_proportional: hvActual != null && hvProgramd != null ? hvActual >= hvProgramd : null,
      light_vs_rest_actual_kcal: delta(perTier.light.avg_calories, perTier.rest.avg_calories),
      light_vs_rest_programmed_kcal: delta(perTier.light.avg_target_calories, perTier.rest.avg_target_calories),
      moderate_vs_rest_actual_kcal: delta(perTier.moderate.avg_calories, perTier.rest.avg_calories),
      moderate_vs_rest_programmed_kcal: delta(perTier.moderate.avg_target_calories, perTier.rest.avg_target_calories),
      note: "delta_proportional = actual heavy-vs-rest calorie delta >= programmed delta; null when either tier has no nutrition data in the window.",
    },
    ...(detail === "days" ? { per_day: perDay } : {}),
    units: "kcal / g",
  };
}
