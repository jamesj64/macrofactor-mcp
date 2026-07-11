import { todayLocal, extractTodaySummary, safeParse, ageFrom, round, pickNum } from "./utils";
import { resolveTarget } from "./nutrition";

// ---- Live "today" feed (MacroFactor Today-Summary shortcut → POST /today) ----

export async function upsertToday(
  DB: D1Database,
  date: string,
  ex: ReturnType<typeof extractTodaySummary>,
  raw: string,
  updatedMs: number,
  source: string,
) {
  await DB.prepare(
    `INSERT INTO today_summary (date, calories, protein, carbs, fat, consumed, remaining, raw, updated_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       calories=excluded.calories, protein=excluded.protein, carbs=excluded.carbs, fat=excluded.fat,
       consumed=excluded.consumed, remaining=excluded.remaining, raw=excluded.raw,
       updated_at=excluded.updated_at, source=excluded.source`,
  )
    .bind(
      date,
      ex.calories,
      ex.protein,
      ex.carbs,
      ex.fat,
      JSON.stringify(ex.consumed ?? {}),
      ex.remaining ? JSON.stringify(ex.remaining) : null,
      raw,
      updatedMs,
      source,
    )
    .run();
}

export async function deleteToday(DB: D1Database, date: string) {
  await DB.prepare(`DELETE FROM today_summary WHERE date = ?`).bind(date).run();
}

export async function getToday(DB: D1Database, date?: string, detail?: string) {
  const d = date ?? todayLocal();
  const row = (await DB.prepare(`SELECT * FROM today_summary WHERE date = ?`).bind(d).first()) as any | null;

  const targets = (await DB.prepare(`SELECT * FROM nutrition_targets`).all()).results as any[];
  const t = resolveTarget(targets, d);
  const target =
    t && t.calories != null ? { calories: t.calories, protein: t.protein, carbs: t.carbs, fat: t.fat } : null;

  if (!row) {
    const dayRow = (await DB.prepare(
      `SELECT date, calories, protein, carbs, fat FROM days WHERE date = ?`,
    ).bind(d).first()) as any | null;
    return {
      date: d,
      live: false,
      source: dayRow ? "export" : null,
      consumed: dayRow
        ? { calories: dayRow.calories, protein: dayRow.protein, carbs: dayRow.carbs, fat: dayRow.fat }
        : null,
      target,
      note: dayRow
        ? "No live Today-Summary post for this date yet; showing the exported daily total (only as fresh " +
          "as your last export). Set up the 'MF Today → MCP' shortcut (ios-setup.md) to make today live."
        : "No live today data and no export covers this date. Set up the 'MF Today → MCP' shortcut " +
          "(ios-setup.md) to POST today's totals from your phone.",
    };
  }

  const consumed_all = safeParse(row.consumed ?? "{}");
  const remaining_raw = row.remaining ? safeParse(row.remaining) : null;
  const headline = { calories: row.calories, protein: row.protein, carbs: row.carbs, fat: row.fat } as Record<
    string,
    number | null
  >;

  // Remaining to hit target: prefer MacroFactor's own `remaining.<nutrient>.target`; otherwise
  // derive target − consumed. (>0 = still to consume, <0 = over.)
  const remTo = (macro: string, mfKey: string): number | null => {
    const mf = (remaining_raw as any)?.[mfKey];
    const dp = macro === "calories" ? 0 : 1;
    if (mf && typeof mf === "object" && mf.target != null) return round(Number(mf.target), dp);
    if (target && (target as any)[macro] != null && headline[macro] != null)
      return round((target as any)[macro] - (headline[macro] as number), dp);
    return null;
  };
  const remaining_to_target = {
    calories: remTo("calories", "energy"),
    protein: remTo("protein", "protein"),
    carbs: remTo("carbs", "carbs"),
    fat: remTo("fat", "fat"),
  };

  let vs_target: any = null;
  if (target && target.calories && headline.calories != null) {
    const C = headline.calories as number;
    vs_target = {
      calorie_diff: round(C - target.calories, 0),
      calorie_pct: round((C / target.calories) * 100, 1),
      calorie_on_target: Math.abs(C - target.calories) / target.calories <= 0.05,
      protein_diff:
        headline.protein != null && target.protein != null ? round((headline.protein as number) - target.protein, 1) : null,
      protein_hit:
        headline.protein != null && target.protein != null ? (headline.protein as number) >= 0.95 * target.protein : false,
    };
  }

  const alc = round(pickNum(consumed_all, "alcohol") ?? 0, 1);

  return {
    date: d,
    live: true,
    is_current_day: d === todayLocal(),
    updated_at: row.updated_at != null ? new Date(Number(row.updated_at)).toISOString() : null,
    updated_ago: ageFrom(row.updated_at),
    source: row.source ?? "today-summary",
    consumed: headline,
    ...(alc ? { alcohol_g: alc } : {}),
    target,
    remaining_to_target,
    vs_target,
    ...(detail === "full" ? { consumed_all, remaining_raw } : {}),
    note:
      "Live feed from MacroFactor's Today-Summary shortcut (independent of your last export). " +
      "remaining_to_target > 0 = still to consume, < 0 = over. Pass detail:'full' for every nutrient " +
      "logged today (consumed_all — MacroFactor keys, energy=kcal, others g/mg/mcg, sparse) and " +
      "MacroFactor's raw remaining goals (remaining_raw).",
  };
}

// ---- Saved-food logging (log_saved_food) ----

// Resolve a saved-food name to candidate rows, split into `loggable` (has stored macros, so it
// can be scaled and logged) and `nameOnly` (history/custom rows with null macros). `exact` does a
// case-insensitive whole-name match (used to commit after disambiguation); otherwise substring.
export async function lookupSavedFood(
  DB: D1Database,
  query: string,
  exact = false,
  source?: string,
): Promise<{ loggable: any[]; nameOnly: any[] }> {
  // Escape LIKE metacharacters so a query of "%" / "_" can't match every row (which would turn a
  // genuine not_found into a misleading "ambiguous"); exact uses plain equality. An optional source
  // narrows the search to break ties between same-named rows from different sources.
  const clauses = [exact ? "LOWER(name) = LOWER(?)" : "name LIKE ? ESCAPE '\\'"];
  const binds: string[] = [exact ? query : `%${query.replace(/[%_\\]/g, "\\$&")}%`];
  if (source) {
    clauses.push("source = ?");
    binds.push(source);
  }
  const rows = (await DB.prepare(
    `SELECT name, brand, source, serving_size, serving_qty, serving_weight_g, calories, protein, fat, carbs
     FROM food_library WHERE ${clauses.join(" AND ")} ORDER BY (calories IS NULL), source, name LIMIT 25`,
  ).bind(...binds).all()).results as any[];
  return {
    loggable: rows.filter((r) => r.calories != null),
    nameOnly: rows.filter((r) => r.calories == null),
  };
}
