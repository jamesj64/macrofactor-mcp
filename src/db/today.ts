import { todayLocal, extractTodaySummary, safeParse, ageFrom, round, pickNum, getUserTz } from "./utils";
import { resolveTarget, targetPool } from "./nutrition";
import { weekdayOf } from "./utils";
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

const WEEKDAYS7 = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// Targets derived from a Today Summary: goal = consumed + remaining.target. Written as a 7-row
// "program" dated `date` (expenditure_mode = 'live-derived'), copying the other weekdays from the
// program in force so weekday cycling is preserved; an export's own program rows replace it later.
async function recordDerivedTargets(DB: D1Database, date: string, consumed: Record<string, unknown>, remaining: Record<string, unknown>) {
  const goal = (k: string): number | null => {
    const c = pickNum(consumed, k);
    const r = (remaining as any)?.[k];
    const t = r && typeof r === "object" ? pickNum(r, "target") : null;
    return c != null && t != null ? round(c + t, k === "energy" ? 0 : 1) : null;
  };
  const energy = goal("energy");
  if (energy == null) return false;
  const todayRow = { calories: energy, protein: goal("protein"), carbs: goal("carbs"), fat: goal("fat") };
  const existing = (await DB.prepare(`SELECT * FROM nutrition_targets`).all()).results as any[];
  const { pool } = targetPool(existing.filter((t) => t.program_date !== date), date);
  const wd = weekdayOf(date);
  const stmts: D1PreparedStatement[] = [DB.prepare(`DELETE FROM nutrition_targets WHERE program_date = ?`).bind(date)];
  const ins = DB.prepare(
    `INSERT INTO nutrition_targets (program_date, weekday, calories, protein, carbs, fat, expenditure, daily_average, weight, expenditure_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live-derived')`,
  );
  const rows = WEEKDAYS7.map((day) => {
    const prev = pool.find((t) => t.weekday === day) ?? pool[0];
    const r = day === wd || !prev ? todayRow : { calories: prev.calories, protein: prev.protein, carbs: prev.carbs, fat: prev.fat };
    return { day, ...r, expenditure: prev?.expenditure ?? null, weight: prev?.weight ?? null };
  });
  const avg = round(rows.reduce((a, r) => a + (r.calories ?? 0), 0) / 7, 0);
  for (const r of rows) stmts.push(ins.bind(date, r.day, r.calories, r.protein, r.carbs, r.fat, r.expenditure, avg, r.weight));
  await DB.batch(stmts);
  return true;
}

export async function recordDaySnapshot(
  DB: D1Database, date: string, consumed: Record<string, unknown>, remaining?: Record<string, unknown> | null,
) {
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
  let targets = false;
  if (remaining && typeof remaining === "object") {
    try { targets = await recordDerivedTargets(DB, date, consumed, remaining); } catch { targets = false; }
  }
  return { days_row: energy != null, micronutrient_keys: Object.keys(micro).length - (micro._source ? 1 : 0), targets };
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

// Pipe-delimited line format for the MF Nightly Shortcut (one Text action per Recent Food, with the
// entity's properties inserted in this order; trailing fields may be omitted):
// "Hours Consumed (24 hr)" is a LIST property; Shortcuts joins list items with newlines when it
// inserts them into Text, so it goes last and bare numeric lines are folded into the previous food.
export const FOOD_LINE_FIELDS = [
  "Name", "Brand", "Time Last Consumed", "Consumption Count", "Energy", "Protein (g)", "Carbs (g)", "Fat (g)",
  "Hours Consumed (24 hr)",
] as const;

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

// Calendar date (YYYY-MM-DD, user's zone) from an ISO datetime or "Sep 2, 2026 at 1:05 PM"; null when
// the value carries no date (a bare time, or unparseable).
export function toLocalDate(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (/^\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM|am|pm)?$/.test(s)) return null;
  const d = new Date(s.replace(/\bat\b/i, ""));
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: getUserTz(), year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

const numOrNull = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

// "8, 13" / "8 13" / "[8,13]" → [8, 13]
function parseHours(v: unknown): number[] {
  if (v == null) return [];
  const src = Array.isArray(v) ? v.map(String).join(",") : String(v);
  return (src.match(/\d{1,2}/g) ?? []).map((x) => parseInt(x, 10)).filter((h) => h >= 0 && h <= 23);
}

// One Recent Food → ONE food_log row at its Time Last Consumed. MacroFactor's Consumption Count and
// Hours Consumed describe the food's whole history, not the current day, so they are kept only as
// diagnostics (a second helping of the same food on the same day shows once; day totals come from
// the Today Summary, not from these rows).
function expandFood(f: {
  name: string; brand?: string | null; date: string | null; time: string | null; count: number | null; hours: number[];
  calories: number | null; protein: number | null; carbs: number | null; fat: number | null;
  serving_size?: string | null; serving_qty?: number | null; serving_weight_g?: number | null;
}): any[] {
  return [{
    name: f.name,
    brand: f.brand ?? null,
    date: f.date,
    time: f.time,
    serving_size: f.serving_size ?? null, serving_qty: f.serving_qty ?? null, serving_weight_g: f.serving_weight_g ?? null,
    calories: f.calories, protein: f.protein, carbs: f.carbs, fat: f.fat,
    lifetime_count: f.count, usual_hours: f.hours,
  }];
}

function fromObject(o: Record<string, unknown>): any[] | null {
  const nutrients = (o.nutrients && typeof o.nutrients === "object" ? o.nutrients : {}) as Record<string, unknown>;
  const name = firstKey(o, NAME_KEYS);
  if (!name) return null;
  const g = (macro: string) => numOrNull(firstKey(o, MACRO_KEYS[macro]) ?? (macro === "calories" ? nutrients.energy : nutrients[macro]));
  const serving = o.serving ?? o.Serving ?? o.serving_size ?? o["Serving Size"];
  const when = firstKey(o, TIME_KEYS);
  return expandFood({
    name: String(name).trim(),
    brand: (firstKey(o, ["brand", "Brand"]) as string | undefined) ?? null,
    date: toLocalDate(when),
    time: toLocalHHMM(when),
    count: numOrNull(firstKey(o, ["count", "Count", "Consumption Count", "consumption_count", "consumptionCount"])),
    hours: parseHours(firstKey(o, ["hours", "Hours", "Hours Consumed (24 hr)", "Hours Consumed", "hours_consumed", "hoursConsumed"])),
    calories: g("calories"), protein: g("protein"), carbs: g("carbs"), fat: g("fat"),
    serving_size: serving == null ? null : typeof serving === "string" ? serving : JSON.stringify(serving),
    serving_qty: numOrNull(o.serving_qty ?? o["Serving Qty"]),
    serving_weight_g: numOrNull(o.serving_weight_g ?? o["Serving Weight (g)"] ?? o.weight),
  });
}

interface LineFood {
  name: string; brand: string | null; date: string | null; time: string | null; count: number | null; hours: number[];
  calories: number | null; protein: number | null; carbs: number | null; fat: number | null;
}

function fromLine(line: string): LineFood | null {
  const parts = line.split("|").map((p) => p.trim());
  if (!parts[0]) return null;
  const [name, brand, time, count, energy, protein, carbs, fat, ...rest] = parts;
  return {
    name, brand: brand || null, date: toLocalDate(time), time: toLocalHHMM(time), count: numOrNull(count), hours: parseHours(rest.join(",")),
    calories: numOrNull(energy), protein: numOrNull(protein), carbs: numOrNull(carbs), fat: numOrNull(fat),
  };
}

// Text-lines body → foods. A line with no "|" that is only numbers/commas continues the previous
// food's Hours Consumed list (Shortcuts splits list properties onto their own lines).
function fromLines(lines: string[]): any[] {
  const foods: LineFood[] = [];
  for (const line of lines) {
    if (!line.includes("|") && /^[\d,\s]+$/.test(line) && foods.length) {
      foods[foods.length - 1].hours.push(...parseHours(line));
      continue;
    }
    const f = fromLine(line);
    if (f) foods.push(f);
  }
  return foods.flatMap((f) => expandFood(f));
}

export function parseFoodsSeen(body: unknown): { rows: any[]; unrecognized: string[]; shape: string } {
  let list: unknown[] = [];
  let shape = "unknown";
  const textLines = (t: string) => t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (Array.isArray(body)) { list = body; shape = "array"; }
  else if (typeof body === "string") { list = textLines(body); shape = "text-lines"; }
  else if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    const inner = (o.items ?? o.foods ?? o.results ?? o.value) as unknown;
    const txt = (o.lines ?? o.text ?? o.body) as unknown;
    if (Array.isArray(inner)) { list = inner; shape = "wrapped-array"; }
    else if (typeof txt === "string") { list = textLines(txt); shape = "wrapped-text"; }
    else if (Object.keys(o).length && Object.values(o).every((v) => v && typeof v === "object")) { list = Object.values(o); shape = "object-of-objects"; }
    else { list = [o]; shape = "single-object"; }
  }
  const unrecognized = new Set<string>();
  const rows: any[] = [];
  const strings = list.filter((x): x is string => typeof x === "string");
  if (strings.length) rows.push(...fromLines(strings));
  for (const it of list) {
    if (typeof it === "string") continue;
    if (!it || typeof it !== "object") continue;
    const r = fromObject(it as Record<string, unknown>);
    if (!r) { for (const k of Object.keys(it as object)) unrecognized.add(k); continue; }
    rows.push(...r);
  }
  return { rows, unrecognized: [...unrecognized], shape };
}

export async function replaceFoodsSeen(
  DB: D1Database, date: string, rows: any[],
): Promise<{ stored: number; library: number; other_days: number }> {
  // Food log: only foods whose last consumption falls on `date` (or that carry no date at all).
  const todays = rows.filter((r) => !r.date || r.date === date);
  const stmts: D1PreparedStatement[] = [DB.prepare(`DELETE FROM food_log WHERE date = ? AND source = 'shortcut'`).bind(date)];
  const ins = DB.prepare(
    `INSERT INTO food_log (date, time, name, serving_size, serving_qty, serving_weight_g, calories, protein, carbs, fat, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'shortcut')`,
  );
  for (const r of todays) {
    const name = r.brand ? `${r.name} (${r.brand})` : r.name;
    stmts.push(ins.bind(date, r.time ?? null, name, r.serving_size ?? null, r.serving_qty ?? null, r.serving_weight_g ?? null, r.calories ?? null, r.protein ?? null, r.carbs ?? null, r.fat ?? null));
  }

  // Saved-foods library from EVERY food in the post (any date): one 'recent' row per distinct food,
  // macros as last logged (one portion). Export rows (favorite/custom/history) are left alone and
  // win ties; the importer preserves 'recent' rows across uploads.
  const seen = new Map<string, any>();
  for (const r of rows) if (r.calories != null) seen.set(`${r.name}\u0000${r.brand ?? ""}`, r);
  const delLib = DB.prepare(`DELETE FROM food_library WHERE source = 'recent' AND name = ? AND IFNULL(brand, '') = ?`);
  const insLib = DB.prepare(
    `INSERT INTO food_library (name, brand, source, serving_size, serving_qty, serving_weight_g, calories, protein, fat, carbs)
     VALUES (?, ?, 'recent', ?, 1, ?, ?, ?, ?, ?)`,
  );
  for (const r of seen.values()) {
    stmts.push(delLib.bind(r.name, r.brand ?? ""));
    stmts.push(insLib.bind(r.name, r.brand ?? null, r.serving_size ?? "portion (as last logged)", r.serving_weight_g ?? null, r.calories, r.protein ?? null, r.fat ?? null, r.carbs ?? null));
  }
  // D1 batches are limited in size; chunk large library refreshes.
  for (let i = 0; i < stmts.length; i += 100) await DB.batch(stmts.slice(i, i + 100));
  return { stored: todays.length, library: seen.size, other_days: rows.length - todays.length };
}
