import type { Env } from "./index";

// Columns allowed per table (also defines insert order). The local upload script
// (scripts/ingest.mjs) sends rows keyed by these names.
export const TABLES: Record<string, string[]> = {
  days: [
    "date", "calories", "protein", "carbs", "fat", "expenditure",
    "scale_weight", "fat_percent", "trend_weight", "steps", "alcohol_g",
  ],
  micronutrients: ["date", "payload"],
  food_library: [
    "name", "brand", "source", "serving_size", "serving_qty",
    "serving_weight_g", "calories", "protein", "fat", "carbs",
  ],
  food_log: [
    "date", "time", "name", "serving_size", "serving_qty",
    "serving_weight_g", "calories", "protein", "carbs", "fat",
  ],
  nutrition_targets: [
    "program_date", "weekday", "calories", "protein", "carbs", "fat",
    "expenditure", "daily_average", "weight", "expenditure_mode",
  ],
  weight_goals: [
    "goal", "status", "start_date", "end_date", "goal_weight", "goal_rate_pct",
    "starting_scale_weight", "starting_trend_weight", "original_eta_days",
    "checkpoint_date", "checkpoint_weight", "ending_scale_weight", "ending_trend_weight",
  ],
  workout_sets: [
    "date", "workout", "exercise", "set_index", "set_type", "weight_kg", "reps",
    "rir", "base_weight_kg", "duration_s", "distance_m", "distance_km", "workout_duration_s",
  ],
  muscle_volume: ["date", "muscle", "sets", "volume_kg"],
  exercise_metrics: ["date", "exercise", "metric", "value"],
  body_metrics: ["date", "visual_body_fat", "measurements"],
  training_programs: ["program", "meta", "plan"],
  exercise_settings: ["exercise", "weight_unit", "raw"],
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// POST /ingest
//   { secret, op: "clear", tables?: string[] }
//   { secret, op: "insert", table: string, rows: Record<string, unknown>[] }
export async function handleIngest(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  if (!env.INGEST_SECRET || body.secret !== env.INGEST_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  if (body.op === "clear") {
    const tables = Array.isArray(body.tables) ? (body.tables as string[]) : Object.keys(TABLES);
    const cleared: string[] = [];
    for (const t of tables) {
      if (TABLES[t]) {
        await env.DB.prepare(`DELETE FROM ${t}`).run();
        cleared.push(t);
      }
    }
    return json({ ok: true, cleared });
  }

  if (body.op === "insert") {
    const table = String(body.table ?? "");
    const cols = TABLES[table];
    if (!cols) return json({ error: `unknown table: ${table}` }, 400);

    const rows = Array.isArray(body.rows) ? (body.rows as Record<string, unknown>[]) : [];
    if (rows.length === 0) return json({ ok: true, inserted: 0 });

    const placeholders = `(${cols.map(() => "?").join(", ")})`;
    const stmt = env.DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES ${placeholders}`);
    const batch = rows.map((row) => stmt.bind(...cols.map((c) => row[c] ?? null)));
    await env.DB.batch(batch);
    return json({ ok: true, inserted: rows.length });
  }

  return json({ error: "unknown op (expected 'clear' or 'insert')" }, 400);
}
