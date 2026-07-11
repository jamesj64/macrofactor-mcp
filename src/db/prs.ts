import { round } from "./utils";

// ---- pr_achievement_notifier: Epley e1RM/heaviest/best-set vs stored baseline ----
export interface NewPr {
  exercise: string;
  metric: string;
  value: number;
  prev_value: number | null;
  pct_gain: number | null;
  set_date: string | null;
}

export async function checkAndUpdatePrs(DB: D1Database): Promise<NewPr[]> {
  const rows = (await DB.prepare(
    `SELECT date, exercise, weight_kg, reps, duration_s, distance_m, distance_km FROM workout_sets
     WHERE ((weight_kg IS NOT NULL AND reps IS NOT NULL)
            OR duration_s IS NOT NULL OR distance_m IS NOT NULL OR distance_km IS NOT NULL)`,
  ).all()).results as any[];

  const byEx = new Map<string, {
    e1rm_kg: number; e1rm_date: string | null;
    heaviest_kg: number; heaviest_date: string | null;
    best_set_volume_kg: number; vol_date: string | null;
    best_duration_s: number; duration_date: string | null;
    best_distance_m: number; distance_date: string | null;
  }>();
  for (const r of rows) {
    const e = byEx.get(r.exercise) ?? {
      e1rm_kg: 0, e1rm_date: null, heaviest_kg: 0, heaviest_date: null, best_set_volume_kg: 0, vol_date: null,
      best_duration_s: 0, duration_date: null, best_distance_m: 0, distance_date: null,
    };
    if (r.weight_kg != null && r.reps != null) {
      const e1 = r.weight_kg * (1 + r.reps / 30);
      if (e1 > e.e1rm_kg) { e.e1rm_kg = e1; e.e1rm_date = r.date; }
      if (r.weight_kg > e.heaviest_kg) { e.heaviest_kg = r.weight_kg; e.heaviest_date = r.date; }
      const v = r.weight_kg * r.reps;
      if (v > e.best_set_volume_kg) { e.best_set_volume_kg = v; e.vol_date = r.date; }
    }
    if (r.duration_s != null && r.duration_s > e.best_duration_s) { e.best_duration_s = r.duration_s; e.duration_date = r.date; }
    const distM = r.distance_m ?? (r.distance_km != null ? r.distance_km * 1000 : null);
    if (distM != null && distM > e.best_distance_m) { e.best_distance_m = distM; e.distance_date = r.date; }
    byEx.set(r.exercise, e);
  }

  const baseRows = (await DB.prepare(`SELECT exercise, metric, value FROM pr_baseline`).all()).results as any[];
  const baseline = new Map<string, number>();
  for (const b of baseRows) baseline.set(`${b.exercise}|${b.metric}`, b.value);
  const isInitialPopulation = baseRows.length === 0;

  const now = Date.now();
  const newPrs: NewPr[] = [];
  const upserts: ReturnType<typeof DB.prepare>[] = [];
  const inserts: ReturnType<typeof DB.prepare>[] = [];

  for (const [exercise, bests] of byEx) {
    // Only track metrics the exercise actually has data for — a duration-only exercise must not
    // seed zero-value weight baselines (and vice versa).
    const checks: Array<[string, number, string | null]> = [];
    if (bests.e1rm_date != null) {
      checks.push(
        ["e1rm_kg", round(bests.e1rm_kg, 1), bests.e1rm_date],
        ["heaviest_kg", round(bests.heaviest_kg, 2), bests.heaviest_date],
        ["best_set_volume_kg", round(bests.best_set_volume_kg, 0), bests.vol_date],
      );
    }
    if (bests.duration_date != null) checks.push(["best_duration_s", round(bests.best_duration_s, 1), bests.duration_date]);
    if (bests.distance_date != null) checks.push(["best_distance_m", round(bests.best_distance_m, 0), bests.distance_date]);
    for (const [metric, value, set_date] of checks) {
      const key = `${exercise}|${metric}`;
      const prev = baseline.get(key) ?? null;
      upserts.push(
        DB.prepare(
          `INSERT INTO pr_baseline (exercise, metric, value, set_date)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(exercise, metric) DO UPDATE SET value=excluded.value, set_date=excluded.set_date`,
        ).bind(exercise, metric, value, set_date),
      );
      if (isInitialPopulation) continue;
      if (prev !== null && value <= prev) continue;
      const pct_gain = prev != null ? round((value - prev) / prev * 100, 1) : null;
      newPrs.push({ exercise, metric, value, prev_value: prev, pct_gain, set_date });
      inserts.push(
        DB.prepare(
          `INSERT INTO pr_alerts (detected_at, exercise, metric, value, prev_value, set_date, pct_gain)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(now, exercise, metric, value, prev, set_date, pct_gain),
      );
    }
  }

  // Upserts first so pr_baseline is durable before alerts — a mid-chunk crash can't leave an
  // alert recorded without its baseline advancing (which would re-fire that PR on the next run).
  const all = [...upserts, ...inserts];
  const CHUNK = 50;
  for (let i = 0; i < all.length; i += CHUNK) {
    await DB.batch(all.slice(i, i + CHUNK));
  }
  return newPrs;
}

// Current front-squat vs back-squat e1RM ratio — an example "bottleneck KPI" (bar load
// only). Computed at read time from workout_sets so it always reflects the latest data; null when
// either lift has no logged sets.
async function squatBottleneck(DB: D1Database) {
  try {
    const rows = (await DB.prepare(
      `SELECT exercise, weight_kg, reps, date FROM workout_sets
       WHERE weight_kg IS NOT NULL AND reps IS NOT NULL
         AND (LOWER(exercise) LIKE '%front squat%' OR LOWER(exercise) LIKE '%back squat%')`,
    ).all()).results as any[];
    let fs: any = null, bs: any = null;
    for (const r of rows) {
      const e1 = round(r.weight_kg * (1 + r.reps / 30), 1);
      const isFront = String(r.exercise).toLowerCase().includes("front squat");
      const cur = isFront ? fs : bs;
      if (!cur || e1 > cur.e1rm_kg) {
        const rec = { exercise: r.exercise, e1rm_kg: e1, date: r.date };
        if (isFront) fs = rec; else bs = rec;
      }
    }
    if (!fs || !bs || !bs.e1rm_kg) return null;
    return {
      front_squat: fs,
      back_squat: bs,
      front_to_back_pct: round((fs.e1rm_kg / bs.e1rm_kg) * 100, 1),
      note: "bar-load e1RM only (no bodyweight contribution); recomputed live from all logged sets",
    };
  } catch {
    return null;
  }
}

export async function getPrAlerts(DB: D1Database, since?: string) {
  const raw = since ? new Date(`${since}T00:00:00Z`).getTime() : NaN;
  const sinceMs = since && !isNaN(raw) ? raw : Date.now() - 30 * 86400000;
  const effective = new Date(sinceMs).toISOString().slice(0, 10);
  const note = "metric units: e1rm_kg = Epley e1RM (kg); heaviest_kg = heaviest single lift (kg); best_set_volume_kg = weight×reps (kg); best_duration_s / best_distance_m appear for timed/distance exercises";
  const kpi = await squatBottleneck(DB);
  try {
    const rows = (await DB.prepare(
      `SELECT detected_at, exercise, metric, value, prev_value, set_date, pct_gain
       FROM pr_alerts WHERE detected_at >= ? ORDER BY detected_at DESC`,
    ).bind(sinceMs).all()).results as any[];
    return { since: effective, count: rows.length, alerts: rows, ...(kpi ? { bottleneck_kpi: kpi } : {}), note };
  } catch (_e) {
    // Degrades gracefully if pr_alerts doesn't exist yet (pre-migration deploy).
    return { since: effective, count: 0, alerts: [], ...(kpi ? { bottleneck_kpi: kpi } : {}), note, error: "pr_alerts table not yet migrated" };
  }
}

// ---- import_idempotency_audit: fingerprint + audit log ----
export async function getLastImportFingerprint(DB: D1Database, file_type: string): Promise<string | null> {
  try {
    const row = await DB.prepare(
      `SELECT fingerprint FROM import_log WHERE file_type = ? ORDER BY created DESC LIMIT 1`,
    ).bind(file_type).first() as { fingerprint: string } | null;
    return row?.fingerprint ?? null;
  } catch (_e) {
    // Degrades gracefully if import_log doesn't exist yet (pre-migration deploy).
    return null;
  }
}

export async function recordImport(
  DB: D1Database, file_type: string, fingerprint: string, counts: Record<string, number>, createdMs: number,
): Promise<void> {
  await DB.prepare(
    `INSERT INTO import_log (created, file_type, fingerprint, counts) VALUES (?, ?, ?, ?)`,
  ).bind(createdMs, file_type, fingerprint, JSON.stringify(counts)).run();
}
