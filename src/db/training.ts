import { dateClause, round, safeParse } from "./utils";

const KG_TO_LB = 2.20462;
const lb = (kg: number | null | undefined) => (kg == null ? null : Math.round(kg * KG_TO_LB * 10) / 10);

async function getExerciseUnits(DB: D1Database): Promise<Map<string, string>> {
  try {
    const rows = (await DB.prepare(`SELECT exercise, weight_unit FROM exercise_settings`).all()).results as any[];
    return new Map(rows.filter((r) => r.weight_unit).map((r) => [r.exercise, r.weight_unit]));
  } catch {
    return new Map();
  }
}

// ---- Training ----

export async function getTrainingVolume(DB: D1Database, start?: string, end?: string, detail?: string) {
  const { where, params } = dateClause("date", start, end, 30);
  const rows = (await DB.prepare(
    `SELECT date, muscle, sets, volume_kg FROM muscle_volume ${where} ORDER BY date, muscle`,
  ).bind(...params).all()).results as any[];

  const byMuscle = new Map<string, any>();
  const dates = new Set<string>();
  for (const r of rows) {
    dates.add(r.date);
    const m = byMuscle.get(r.muscle) ?? { muscle: r.muscle, total_sets: 0, total_volume_kg: 0, days_trained: 0 };
    if (r.sets != null) m.total_sets += r.sets;
    if (r.volume_kg != null) m.total_volume_kg += r.volume_kg;
    m.days_trained++;
    byMuscle.set(r.muscle, m);
  }
  const per_muscle = [...byMuscle.values()]
    .map((m) => ({ ...m, total_sets: round(m.total_sets, 1), total_volume_kg: round(m.total_volume_kg, 0) }))
    .sort((a, b) => b.total_sets - a.total_sets);

  return {
    range: { start: start ?? null, end: end ?? null },
    training_days: dates.size,
    basis:
      "MacroFactor-computed per-muscle figures. (1) Each exercise is credited to EVERY muscle it " +
      "trains, often fractionally — so muscles OVERLAP and per-muscle totals intentionally sum to far " +
      "MORE than a single session's barbell tonnage (e.g. one front squat counts toward quads, glutes, " +
      "adductors…). (2) Tonnage INCLUDES bodyweight contribution for compound lifts. These are " +
      "training-stimulus measures, not bar weight; do not compare them to barbell tonnage. For barbell " +
      "load lifted, use get_workouts / get_prs. Weights in kg.",
    per_muscle,
    ...(detail === "daily" ? { daily: rows } : {}),
  };
}

export async function getExerciseProgress(
  DB: D1Database,
  exercise?: string,
  metric?: string,
  start?: string,
  end?: string,
  all?: boolean,
) {
  const conds: string[] = [];
  const p: string[] = [];
  if (start) { conds.push("date >= ?"); p.push(start); }
  if (end) { conds.push("date <= ?"); p.push(end); }
  if (!start && !end) conds.push("date >= date('now', '-90 days')");
  if (exercise) { conds.push("exercise LIKE ?"); p.push(`%${exercise}%`); }
  if (metric) { conds.push("metric = ?"); p.push(metric); }
  const rows = (await DB.prepare(
    `SELECT date, exercise, metric, value FROM exercise_metrics WHERE ${conds.join(" AND ")} ORDER BY exercise, metric, date`,
  ).bind(...p).all()).results as any[];

  const units = await getExerciseUnits(DB);

  const groups = new Map<string, any>();
  for (const r of rows) {
    const k = `${r.exercise}|${r.metric}`;
    const g = groups.get(k) ?? { exercise: r.exercise, metric: r.metric, points: [] as any[] };
    g.points.push({ date: r.date, value: r.value });
    groups.set(k, g);
  }
  const exercises = [...groups.values()].map((g) => {
    const vs = g.points.map((pt: any) => pt.value);
    const first = g.points[0], last = g.points[g.points.length - 1];
    const totalPoints = g.points.length;
    const series = !all && totalPoints > 30 ? g.points.slice(-30) : g.points;
    const truncated = !all && totalPoints > 30;
    return {
      exercise: g.exercise,
      metric: g.metric,
      n: totalPoints,
      first: first.value,
      last: last.value,
      max: Math.max(...vs),
      change: round(last.value - first.value, 2),
      ...(truncated ? { series_truncated: true, total_points: totalPoints } : {}),
      series,
    };
  });
  // Barbell-load cross-reference straight from the raw set log (bar weight only, NO bodyweight
  // contribution), so MacroFactor's bodyweight-inclusive figures above can be compared
  // side-by-side with what was actually on the bar. Same exercise/date filters.
  const wConds: string[] = ["weight_kg IS NOT NULL", "reps IS NOT NULL"];
  const wp: string[] = [];
  if (start) { wConds.push("date >= ?"); wp.push(start); }
  if (end) { wConds.push("date <= ?"); wp.push(end); }
  if (!start && !end) wConds.push("date >= date('now', '-90 days')");
  if (exercise) { wConds.push("exercise LIKE ?"); wp.push(`%${exercise}%`); }
  const wrows = (await DB.prepare(
    `SELECT date, exercise, weight_kg, reps FROM workout_sets WHERE ${wConds.join(" AND ")} ORDER BY exercise, date`,
  ).bind(...wp).all()).results as any[];

  const bbl = new Map<string, any>();
  for (const r of wrows) {
    const g = bbl.get(r.exercise) ?? {
      exercise: r.exercise, heaviest_kg: 0, total_volume_kg: 0, best_set_volume_kg: 0, _byDate: new Map<string, any>(),
    };
    const v = r.weight_kg * r.reps;
    g.heaviest_kg = Math.max(g.heaviest_kg, r.weight_kg);
    g.total_volume_kg += v;
    g.best_set_volume_kg = Math.max(g.best_set_volume_kg, v);
    const d = g._byDate.get(r.date) ?? { date: r.date, heaviest_kg: 0, total_volume_kg: 0, sets: 0 };
    d.heaviest_kg = Math.max(d.heaviest_kg, r.weight_kg);
    d.total_volume_kg += v;
    d.sets += 1;
    g._byDate.set(r.date, d);
    bbl.set(r.exercise, g);
  }
  const barbell = [...bbl.values()].map((g) => {
    const isPounds = units.get(g.exercise) === "Pounds";
    const allByDate = [...g._byDate.values()].map((d: any) => ({
      date: d.date, heaviest_kg: round(d.heaviest_kg, 2), total_volume_kg: round(d.total_volume_kg, 0), sets: d.sets,
    }));
    const totalByDate = allByDate.length;
    const by_date = !all && totalByDate > 30 ? allByDate.slice(-30) : allByDate;
    const byDateTruncated = !all && totalByDate > 30;
    return {
      exercise: g.exercise,
      ...(isPounds ? { display_unit: "lb" } : {}),
      heaviest_kg: round(g.heaviest_kg, 2),
      ...(isPounds ? { heaviest_lb: lb(round(g.heaviest_kg, 2)) } : {}),
      total_volume_kg: round(g.total_volume_kg, 0),
      best_set_volume_kg: round(g.best_set_volume_kg, 0),
      ...(byDateTruncated ? { series_truncated: true, total_points: totalByDate } : {}),
      by_date,
    };
  });

  return {
    range: { start: start ?? null, end: end ?? null },
    basis:
      "Two side-by-side views. `exercises` = MacroFactor-computed metrics; for compound lifts the " +
      "weight/volume metrics (1RM, 3RM, 10RM, heaviest_weight, total_volume, best_set_volume) INCLUDE " +
      "MacroFactor's per-exercise bodyweight contribution, so they exceed bar load (e.g. a 100 kg front " +
      "squat can show ~160 kg; overhead press has none and matches the bar). `barbell` = the actual load " +
      "on the bar, computed from your raw set log (no bodyweight). reps/sets metrics are unaffected. Weights in kg. " +
      "Exercises you log in Pounds receive *_lb fields (reconstructed ×2.20462). Series are capped at 30 points " +
      "by default; pass all:true for full history, or check series_truncated/total_points.",
    exercises,
    barbell,
  };
}

export async function getWorkouts(DB: D1Database, start?: string, end?: string) {
  const { where, params } = dateClause("date", start, end, 30);
  const rows = (await DB.prepare(
    `SELECT date, workout, exercise, set_index, set_type, weight_kg, reps, rir,
            base_weight_kg, duration_s, distance_m, distance_km, workout_duration_s
     FROM workout_sets ${where} ORDER BY date, workout, exercise, set_index`,
  ).bind(...params).all()).results as any[];

  const units = await getExerciseUnits(DB);
  const sessions = new Map<string, any>();
  for (const r of rows) {
    const sk = `${r.date}|${r.workout}`;
    let s = sessions.get(sk);
    if (!s) {
      s = {
        date: r.date,
        workout: r.workout,
        duration_min: r.workout_duration_s != null ? round(r.workout_duration_s / 60, 0) : null,
        exercises: new Map<string, any>(),
      };
      sessions.set(sk, s);
    }
    let e = s.exercises.get(r.exercise);
    if (!e) { e = { exercise: r.exercise, sets: [] as any[], volume_kg: 0, top_set: null as any }; s.exercises.set(r.exercise, e); }
    e.sets.push({
      set: r.set_index, weight_kg: r.weight_kg, reps: r.reps, rir: r.rir, type: r.set_type,
      base_weight_kg: r.base_weight_kg, duration_s: r.duration_s, distance_m: r.distance_m, distance_km: r.distance_km,
    });
    if (r.weight_kg != null && r.reps != null) {
      e.volume_kg += r.weight_kg * r.reps;
      if (!e.top_set || r.weight_kg > e.top_set.weight_kg) e.top_set = { weight_kg: r.weight_kg, reps: r.reps };
    }
  }
  const out = [...sessions.values()].map((s) => ({
    date: s.date,
    workout: s.workout,
    duration_min: s.duration_min,
    exercises: [...s.exercises.values()].map((e: any) => {
      const isPounds = units.get(e.exercise) === "Pounds";
      const sets = isPounds
        ? e.sets.map((set: any) => ({ ...set, weight_lb: lb(set.weight_kg) }))
        : e.sets;
      const top_set = e.top_set && isPounds
        ? { ...e.top_set, weight_lb: lb(e.top_set.weight_kg) }
        : e.top_set;
      return {
        exercise: e.exercise,
        ...(isPounds ? { display_unit: "lb" } : {}),
        sets,
        volume_kg: round(e.volume_kg, 0),
        ...(isPounds ? { volume_lb: lb(round(e.volume_kg, 0)) } : {}),
        top_set,
      };
    }),
  }));
  return {
    range: { start: start ?? null, end: end ?? null },
    sessions: out,
    units_note: "MacroFactor exports kg; *_lb fields are reconstructed (×2.20462) for exercises you log in pounds (from Exercise Settings).",
  };
}

export async function getPrs(DB: D1Database, exercise?: string) {
  let sql = `SELECT date, exercise, weight_kg, reps, duration_s, distance_m, distance_km FROM workout_sets
             WHERE ((weight_kg IS NOT NULL AND reps IS NOT NULL)
                    OR duration_s IS NOT NULL OR distance_m IS NOT NULL OR distance_km IS NOT NULL)`;
  const p: string[] = [];
  if (exercise) { sql += ` AND exercise LIKE ?`; p.push(`%${exercise}%`); }
  const rows = (await DB.prepare(sql).bind(...p).all()).results as any[];

  const byEx = new Map<string, any>();
  for (const r of rows) {
    const e = byEx.get(r.exercise) ?? {
      exercise: r.exercise,
      e1rm_kg: 0, e1rm_set: null,
      heaviest_kg: 0, heaviest_set: null,
      best_set_volume_kg: 0, best_volume_set: null,
      best_duration_s: 0, best_duration_set: null,
      best_distance_m: 0, best_distance_set: null,
    };
    if (r.weight_kg != null && r.reps != null) {
      const e1 = r.weight_kg * (1 + r.reps / 30); // Epley
      if (e1 > e.e1rm_kg) { e.e1rm_kg = e1; e.e1rm_set = { weight_kg: r.weight_kg, reps: r.reps, date: r.date }; }
      if (r.weight_kg > e.heaviest_kg) { e.heaviest_kg = r.weight_kg; e.heaviest_set = { weight_kg: r.weight_kg, reps: r.reps, date: r.date }; }
      const v = r.weight_kg * r.reps;
      if (v > e.best_set_volume_kg) { e.best_set_volume_kg = v; e.best_volume_set = { weight_kg: r.weight_kg, reps: r.reps, date: r.date }; }
    }
    if (r.duration_s != null && r.duration_s > e.best_duration_s) {
      e.best_duration_s = r.duration_s;
      e.best_duration_set = { duration_s: r.duration_s, weight_kg: r.weight_kg, date: r.date };
    }
    const distM = r.distance_m ?? (r.distance_km != null ? r.distance_km * 1000 : null);
    if (distM != null && distM > e.best_distance_m) {
      e.best_distance_m = distM;
      e.best_distance_set = { distance_m: distM, duration_s: r.duration_s, date: r.date };
    }
    byEx.set(r.exercise, e);
  }
  const units = await getExerciseUnits(DB);
  const exercises = [...byEx.values()]
    .map((e) => {
      const isPounds = units.get(e.exercise) === "Pounds";
      const mapped: any = { exercise: e.exercise };
      if (e.e1rm_set) {
        mapped.e1rm_kg = round(e.e1rm_kg, 1);
        mapped.e1rm_set = e.e1rm_set;
        mapped.heaviest_kg = e.heaviest_kg;
        mapped.heaviest_set = e.heaviest_set;
        mapped.best_set_volume_kg = round(e.best_set_volume_kg, 0);
        mapped.best_volume_set = e.best_volume_set;
        if (isPounds) {
          mapped.e1rm_lb = lb(mapped.e1rm_kg);
          mapped.heaviest_lb = lb(mapped.heaviest_kg);
          mapped.best_set_volume_lb = lb(mapped.best_set_volume_kg);
          mapped.display_unit = "lb";
        }
      }
      if (e.best_duration_set) { mapped.best_duration_s = round(e.best_duration_s, 1); mapped.best_duration_set = e.best_duration_set; }
      if (e.best_distance_set) { mapped.best_distance_m = round(e.best_distance_m, 0); mapped.best_distance_set = e.best_distance_set; }
      return mapped;
    })
    .sort((a, b) => (b.e1rm_kg ?? 0) - (a.e1rm_kg ?? 0));
  return {
    exercises,
    method:
      "e1RM = weight × (1 + reps/30) (Epley); weights in kg. Timed/distance exercises (carries, holds, " +
      "rows, bike) additionally report best_duration_s / best_distance_m bests; weight-PR fields are " +
      "omitted for exercises with no weight×reps sets.",
  };
}

// ---- Body metrics & planned training program (from the workbook) ----

export async function getBodyMetrics(DB: D1Database, start?: string, end?: string) {
  const { where, params } = dateClause("date", start, end, 365);
  const rows = (await DB.prepare(
    `SELECT date, visual_body_fat, measurements FROM body_metrics ${where} ORDER BY date`,
  ).bind(...params).all()).results as any[];
  const entries = rows.map((r) => ({
    date: r.date,
    visual_body_fat: r.visual_body_fat,
    measurements: safeParse(r.measurements ?? "{}"),
  }));
  // When no dates are given the query applies a rolling 365-day window. Surface the effective start
  // so an empty result isn't misread as "no body metrics ever exist" — older ones may be excluded.
  const defaulted = !start && !end;
  const effectiveStart = start ?? (defaulted ? new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10) : null);
  return {
    range: {
      start: effectiveStart,
      end: end ?? null,
      ...(defaulted ? { default_window_days: 365 } : {}),
    },
    units: "circumferences in cm; visual_body_fat = MacroFactor's visual body-fat assessment (%)",
    note:
      "Sparse — only dates you took measurements appear. Defaults to the last 365 days; pass start_date to " +
      "retrieve older measurements (if entries is empty, earlier ones may exist). measurements is empty {} on " +
      "a date where only visual body-fat (or nothing) was recorded. For scale/trend weight + body-fat % use " +
      "get_weight_history.",
    entries,
  };
}

export async function getProgram(DB: D1Database, program?: string) {
  const p: string[] = [];
  let where = "";
  if (program) {
    where = ` WHERE program LIKE ? ESCAPE '\\'`;
    p.push(`%${program.replace(/[%_\\]/g, "\\$&")}%`);
  }
  const rows = (await DB.prepare(`SELECT program, meta, plan FROM training_programs${where}`).bind(...p).all())
    .results as any[];

  const programs = rows.map((r) => {
    const meta = safeParse(r.meta ?? "{}");
    let cycles: any[] = [];
    try {
      const parsed = JSON.parse(r.plan ?? "[]");
      if (Array.isArray(parsed)) cycles = parsed;
    } catch {
      cycles = [];
    }
    const workoutDays = cycles.flatMap((c) => (c?.schedule ?? []).filter((s: any) => s?.type === "workout"));
    const exNames = new Set<string>();
    for (const w of workoutDays) for (const e of w.exercises ?? []) if (e?.exercise) exNames.add(e.exercise);
    return {
      program: r.program,
      meta,
      summary: {
        cycles: cycles.length,
        workout_sessions: workoutDays.length,
        rest_days: cycles.reduce(
          (a, c) => a + (c?.schedule ?? []).filter((s: any) => s?.type === "rest").length,
          0,
        ),
        distinct_workouts: [...new Set(workoutDays.map((w: any) => w.day))],
        distinct_exercises: [...exNames],
      },
      cycles,
    };
  });

  return {
    count: programs.length,
    programs,
    note:
      "Your PLANNED MacroFactor training program (the template you follow) — NOT your logged sessions; " +
      "use get_workouts for what you actually did. Each exercise lists its planned sets (type, rep range, " +
      "RIR, rest). 'Rest' schedule entries are programmed rest days.",
  };
}
