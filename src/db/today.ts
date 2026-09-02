import { todayLocal, extractTodaySummary, safeParse, ageFrom, round, pickNum, getUserTz } from "./utils";
import { resolveTarget } from "./nutrition";
import { NUTRIENT_KEYS, type NutrientKey } from "../mf-schema";

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

// ---- Live day snapshots → gap-fill the export tables ----
// A full `consumed` dictionary (from Log by JSON's Today Summary, or the nightly Shortcut) is
// enough to stand in for the export's "Calories & Macros" and "Micronutrients" rows until a real
// export arrives. Live rows are tagged (days.source = 'live', micronutrients payload._source =
// 'live') so they are updated by later snapshots but never overwrite exported rows.


// MacroFactor nutrient key → the column name MacroFactor uses in its .xlsx export.
export const EXPORT_COLUMN: Partial<Record<NutrientKey, string>> = {
  fiber: "Fiber (g)", sugars: "Sugars (g)", sugarsAdded: "Added Sugars (g)", starch: "Starch (g)",
  saturatedFat: "Saturated Fat (g)", transFat: "Trans Fat (g)", monounsaturatedFat: "Monounsaturated Fat (g)",
  polyunsaturatedFat: "Polyunsaturated Fat (g)", omega3: "Omega-3 (g)", omega3ALA: "Omega-3 ALA (g)",
  omega3EPA: "Omega-3 EPA (g)", omega3DHA: "Omega-3 DHA (g)", omega6: "Omega-6 (g)",
  alcohol: "Alcohol (g)", water: "Water (g)", caffeine: "Caffeine (mg)", choline: "Choline (mg)",
  cholesterol: "Cholesterol (mg)",
  vitaminB1: "B1, Thiamine (mg)", vitaminB2: "B2, Riboflavin (mg)", vitaminB3: "B3, Niacin (mg)",
  vitaminB5: "B5, Pantothenic Acid (mg)", vitaminB6: "B6, Pyridoxine (mg)", vitaminB12: "B12, Cobalamin (mcg)",
  vitaminC: "Vitamin C (mg)", vitaminE: "Vitamin E (mg)", vitaminA: "Vitamin A (mcg)", vitaminD: "Vitamin D (mcg)",
  vitaminK: "Vitamin K (mcg)", folate: "Folate (mcg)",
  calcium: "Calcium (mg)", copper: "Copper (mg)", iron: "Iron (mg)", magnesium: "Magnesium (mg)",
  manganese: "Manganese (mg)", phosphorus: "Phosphorus (mg)", potassium: "Potassium (mg)", sodium: "Sodium (mg)",
  zinc: "Zinc (mg)", selenium: "Selenium (mcg)",
  histidine: "Histidine (g)", isoleucine: "Isoleucine (g)", leucine: "Leucine (g)", lysine: "Lysine (g)",
  methionine: "Methionine (g)", phenylalanine: "Phenylalanine (g)", threonine: "Threonine (g)",
  tryptophan: "Tryptophan (g)", tyrosine: "Tyrosine (g)", valine: "Valine (g)", cystine: "Cystine (g)",
};

export async function recordDaySnapshot(DB: D1Database, date: string, consumed: Record<string, unknown>) {
  const num = (k: string): number | null => pickNum(consumed, k);
  const energy = num("energy"), protein = num("protein"), carbs = num("carbs"), fat = num("fat");
  const stmts: D1PreparedStatement[] = [];
  if (energy != null) {
    stmts.push(
      DB.prepare(
        `INSERT INTO days (date, calories, protein, carbs, fat, alcohol_g, source) VALUES (?, ?, ?, ?, ?, ?, 'live')
         ON CONFLICT(date) DO UPDATE SET
           calories = excluded.calories, protein = excluded.protein, carbs = excluded.carbs, fat = excluded.fat,
           alcohol_g = excluded.alcohol_g
         WHERE days.source = 'live'`,
      ).bind(date, Math.round(energy), round(protein ?? 0, 1), round(carbs ?? 0, 1), round(fat ?? 0, 1), num("alcohol") != null ? round(num("alcohol")!, 1) : null),
    );
  }
  const micro: Record<string, number | string> = {};
  for (const k of NUTRIENT_KEYS) {
    const col = EXPORT_COLUMN[k];
    const v = num(k);
    if (col && v != null) micro[col] = round(v, 2);
  }
  if (Object.keys(micro).length) {
    micro._source = "live";
    stmts.push(
      DB.prepare(
        `INSERT INTO micronutrients (date, payload) VALUES (?, ?)
         ON CONFLICT(date) DO UPDATE SET payload = excluded.payload
         WHERE micronutrients.payload LIKE '%"_source":"live"%'`,
      ).bind(date, JSON.stringify(micro)),
    );
  }
  if (stmts.length) await DB.batch(stmts);
  return { days_row: energy != null, micronutrient_keys: Object.keys(micro).length - (micro._source ? 1 : 0) };
}

// ---- Nightly "foods seen" feed (Find Recent Food → POST /foods-seen) ----
// Tolerant of whatever shape the Shortcut manages to send: an array of dictionaries, a wrapper
// {items|foods: [...]}, or newline-separated text (names only). Rows are tagged source='shortcut'
// and replaced per date on every post; an export's Food Log CSV replaces everything.

const NAME_KEYS = ["name", "Name", "title", "Title", "food", "Food", "Food Name"];
const TIME_KEYS = ["time", "Time", "timeLastConsumed", "time_last_consumed", "Time Last Consumed", "lastConsumed", "consumedAt", "date", "Date"];
const MACRO_KEYS: Record<string, string[]> = {
  calories: ["calories", "Calories", "energy", "Energy", "kcal", "Calories (kcal)"],
  protein: ["protein", "Protein", "Protein (g)"],
  carbs: ["carbs", "Carbs", "carbohydrates", "Carbohydrates", "Carbs (g)"],
  fat: ["fat", "Fat", "Fat (g)"],
};

function firstKey(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (obj[k] != null && obj[k] !== "") return obj[k];
  return undefined;
}

// "13:05", "1:05 PM", ISO datetimes, or "Sep 2, 2026 at 1:05 PM" → "HH:MM" in the user's zone.
export function toLocalHHMM(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM|am|pm)?$/);
  if (m) {
    let h = parseInt(m[1], 10);
    const ap = m[3]?.toUpperCase();
    if (ap === "PM" && h < 12) h += 12;
    if (ap === "AM" && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${m[2]}`;
  }
  const d = new Date(s.replace(/\bat\b/i, ""));
  if (!Number.isNaN(d.getTime())) {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: getUserTz(), hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
    return parts.replace(/^24/, "00");
  }
  m = s.match(/(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?/);
  if (m) return toLocalHHMM(m[0]);
  return null;
}

export function parseFoodsSeen(body: unknown): { rows: any[]; unrecognized: string[]; shape: string } {
  let list: unknown[] = [];
  let shape = "unknown";
  if (Array.isArray(body)) { list = body; shape = "array"; }
  else if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    const inner = (o.items ?? o.foods ?? o.results ?? o.value) as unknown;
    if (Array.isArray(inner)) { list = inner; shape = "wrapped-array"; }
    else if (Object.keys(o).length && Object.values(o).every((v) => v && typeof v === "object")) { list = Object.values(o); shape = "object-of-objects"; }
    else { list = [o]; shape = "single-object"; }
  } else if (typeof body === "string") {
    list = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => ({ name: l }));
    shape = "text-lines";
  }
  const unrecognized = new Set<string>();
  const rows: any[] = [];
  for (const it of list) {
    if (typeof it === "string") { rows.push({ name: it }); continue; }
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const nutrients = (o.nutrients && typeof o.nutrients === "object" ? o.nutrients : {}) as Record<string, unknown>;
    const name = firstKey(o, NAME_KEYS);
    if (!name) { for (const k of Object.keys(o)) unrecognized.add(k); continue; }
    const g = (macro: string) => {
      const v = firstKey(o, MACRO_KEYS[macro]) ?? (macro === "calories" ? nutrients.energy : nutrients[macro]);
      return pickNum({ v }, "v");
    };
    const serving = o.serving ?? o.Serving ?? o.serving_size ?? o["Serving Size"];
    rows.push({
      name: String(name).trim(),
      time: toLocalHHMM(firstKey(o, TIME_KEYS)),
      serving_size: serving == null ? null : typeof serving === "string" ? serving : JSON.stringify(serving),
      serving_qty: pickNum(o, "serving_qty") ?? pickNum(o, "Serving Qty"),
      serving_weight_g: pickNum(o, "serving_weight_g") ?? pickNum(o, "Serving Weight (g)") ?? pickNum(o, "weight"),
      calories: g("calories"), protein: g("protein"), carbs: g("carbs"), fat: g("fat"),
    });
    for (const k of Object.keys(o)) {
      if (![...NAME_KEYS, ...TIME_KEYS, ...Object.values(MACRO_KEYS).flat(), "nutrients", "serving", "Serving", "serving_size", "Serving Size", "serving_qty", "serving_weight_g", "brand", "Brand", "icon", "source"].includes(k)) unrecognized.add(k);
    }
  }
  return { rows, unrecognized: [...unrecognized], shape };
}

export async function replaceFoodsSeen(DB: D1Database, date: string, rows: any[]): Promise<number> {
  const stmts: D1PreparedStatement[] = [DB.prepare(`DELETE FROM food_log WHERE date = ? AND source = 'shortcut'`).bind(date)];
  const ins = DB.prepare(
    `INSERT INTO food_log (date, time, name, serving_size, serving_qty, serving_weight_g, calories, protein, carbs, fat, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'shortcut')`,
  );
  for (const r of rows) {
    stmts.push(ins.bind(date, r.time ?? null, r.name, r.serving_size ?? null, r.serving_qty ?? null, r.serving_weight_g ?? null, r.calories ?? null, r.protein ?? null, r.carbs ?? null, r.fat ?? null));
  }
  await DB.batch(stmts);
  return rows.length;
}
