// Server-side MacroFactor .xlsx parser (mirror of scripts/ingest.mjs), used by the
// /upload-export endpoint so the data can be refreshed from the phone alone.

import * as XLSX from "xlsx";

export interface ParsedExport {
  days: Record<string, unknown>[];
  micronutrients: { date: string; payload: string }[];
  food_library: Record<string, unknown>[];
  nutrition_targets: Record<string, unknown>[];
  weight_goals: Record<string, unknown>[];
  muscle_volume: Record<string, unknown>[];
  exercise_metrics: Record<string, unknown>[];
  body_metrics: Record<string, unknown>[];
  training_programs: Record<string, unknown>[];
  exercise_settings: Record<string, unknown>[];
}

// SheetJS builds Date objects in the runtime's local timezone, so local getters recover
// the original calendar date regardless of offset (PC or UTC Worker alike).
function isoDate(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = String(v).trim();
  let mm = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/); // YYYY-MM-DD
  if (mm) return `${mm[1]}-${mm[2].padStart(2, "0")}-${mm[3].padStart(2, "0")}`;
  mm = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/); // DD/MM/YYYY (MacroFactor locale)
  if (mm) return `${mm[3]}-${mm[2].padStart(2, "0")}-${mm[1].padStart(2, "0")}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : isoDate(d);
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isNaN(n) ? null : n;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

// Strip a trailing unit suffix from a column header, e.g. "Front Squat (kg)" -> "Front Squat",
// "Quads (sets)" -> "Quads". Only the three units MacroFactor actually appends to muscle/
// exercise metric columns are stripped, so an exercise legitimately named e.g. "Row (m)"
// isn't mangled (and only the trailing suffix is removed, never one inside the name).
function stripUnit(col: string): string {
  return col.replace(/\s*\((?:kg|reps|sets)\)\s*$/i, "").trim();
}

// Parse the "Training Programs" sheet — an irregular nested layout read as array-of-arrays:
//   r0          = program metadata, cells "Key: Value" (Program, Cycles, Deload, Color, Icon).
//   "Block N"   = block label (column A only).
//   "Cycle N"   = starts a cycle (column A); the rest of that row is the column header.
//   "Rest"      = a scheduled rest day (column A only).
//   other col A = a workout name; its FIRST exercise is in the remaining columns of the same row,
//                 and subsequent rows with an empty column A are further exercises of that workout.
// Each exercise carries up to N planned sets in 4-column groups from column index 4:
//   [Set Type, Rep Range, RIR, Rest].
// Assumes ONE program per sheet (MacroFactor exports exactly one); a second program's metadata
// row would be mis-parsed as a workout. Revisit if multi-program exports ever appear.
function parseProgram(
  aoa: any[][],
): { program: string | null; meta: Record<string, string>; cycles: any[] } | null {
  if (!aoa.length) return null;
  const r0 = aoa[0] || [];
  let program: string | null = null;
  const meta: Record<string, string> = {};
  for (const cell of r0) {
    if (cell == null) continue;
    const s = String(cell);
    const i = s.indexOf(":");
    if (i === -1) continue;
    const k = s.slice(0, i).trim();
    const v = s.slice(i + 1).trim();
    if (k.toLowerCase() === "program") program = v;
    else if (k) meta[k] = v;
  }

  const parseExercise = (cols: any[]) => {
    const sets: any[] = [];
    for (let base = 4; base < cols.length; base += 4) {
      const type = cols[base];
      if (type == null) continue;
      sets.push({
        set: sets.length + 1,
        type,
        rep_range: cols[base + 1] ?? null,
        rir: cols[base + 2] ?? null,
        rest: cols[base + 3] ?? null,
      });
    }
    return { exercise: cols[1] ?? null, skipped: cols[2] ?? null, notes: cols[3] ?? null, sets };
  };

  const cycles: any[] = [];
  let block: string | null = null;
  let cycle: any = null;
  let workout: any = null;
  const ensureCycle = () => {
    if (!cycle) {
      cycle = { cycle: null, block, schedule: [] };
      cycles.push(cycle);
    }
  };
  for (let i = 1; i < aoa.length; i++) {
    const cols = aoa[i] || [];
    const a = cols[0];
    if (a == null) {
      if (workout && cols[1] != null) workout.exercises.push(parseExercise(cols));
      continue;
    }
    const label = String(a).trim();
    if (/^block\s+\d/i.test(label)) {
      block = label;
      continue;
    }
    if (/^cycle\s+\d/i.test(label)) {
      cycle = { cycle: label, block, schedule: [] };
      cycles.push(cycle);
      workout = null;
      continue;
    }
    if (/^rest$/i.test(label)) {
      ensureCycle();
      cycle.schedule.push({ day: "Rest", type: "rest" });
      continue;
    }
    ensureCycle();
    workout = { day: label, type: "workout", exercises: [] };
    cycle.schedule.push(workout);
    if (cols[1] != null) workout.exercises.push(parseExercise(cols));
  }
  return { program, meta, cycles };
}

export function parseExport(data: ArrayBuffer | Uint8Array): ParsedExport {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const wb = XLSX.read(bytes, { type: "array", cellDates: true });

  const rows = (name: string): Record<string, any>[] => {
    const ws = wb.Sheets[name];
    return ws ? (XLSX.utils.sheet_to_json(ws, { defval: null }) as Record<string, any>[]) : [];
  };
  const aoa = (name: string): any[][] => {
    const ws = wb.Sheets[name];
    return ws ? (XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true }) as any[][]) : [];
  };

  const dayMap = new Map<string, Record<string, unknown>>();
  const day = (d: string) => {
    let rec = dayMap.get(d);
    if (!rec) {
      rec = { date: d };
      dayMap.set(d, rec);
    }
    return rec;
  };

  const ingestDaily = (sheet: string, mapping: Record<string, string>) => {
    for (const row of rows(sheet)) {
      const date = isoDate(row.Date);
      if (!date) continue;
      const rec = day(date);
      for (const [col, field] of Object.entries(mapping)) {
        const v = num(row[col]);
        if (v != null) rec[field] = v;
      }
    }
  };

  ingestDaily("Calories & Macros", { "Calories (kcal)": "calories", "Protein (g)": "protein", "Carbs (g)": "carbs", "Fat (g)": "fat" });
  ingestDaily("Expenditure", { Expenditure: "expenditure" });
  ingestDaily("Scale Weight", { "Weight (kg)": "scale_weight", "Fat Percent": "fat_percent" });
  ingestDaily("Weight Trend", { "Trend Weight (kg)": "trend_weight" });
  ingestDaily("Steps", { Steps: "steps" });

  const micronutrients: { date: string; payload: string }[] = [];
  for (const row of rows("Micronutrients")) {
    const date = isoDate(row.Date);
    if (!date) continue;
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (k !== "Date" && v != null) clean[k] = v;
    }
    micronutrients.push({ date, payload: JSON.stringify(clean) });
    const alc = num(row["Alcohol (g)"]);
    if (alc != null) day(date).alcohol_g = alc;
  }

  const food_library: Record<string, unknown>[] = [];
  const addFoods = (sheet: string, source: string) => {
    for (const row of rows(sheet)) {
      const name = row["Food Name"];
      if (!name) continue;
      food_library.push({
        name,
        brand: null,
        source,
        serving_size: row["Serving Size"] ?? null,
        serving_qty: num(row["Serving Qty"]),
        serving_weight_g: num(row["Serving Weight (g)"]),
        calories: num(row["Calories (kcal)"]),
        protein: num(row["Protein (g)"]),
        fat: num(row["Fat (g)"]),
        carbs: num(row["Carbs (g)"]),
      });
    }
  };
  addFoods("Favorites", "favorite");
  addFoods("Custom Foods", "custom");
  for (const row of rows("History")) {
    const name = row["Food Name"];
    if (name) {
      food_library.push({
        name, brand: null, source: "history", serving_size: null, serving_qty: null,
        serving_weight_g: null, calories: null, protein: null, fat: null, carbs: null,
      });
    }
  }

  // --- Nutrition program targets (per program-snapshot x weekday) ---
  const nutrition_targets: Record<string, unknown>[] = [];
  for (const row of rows("Nutrition Program Settings")) {
    const program_date = isoDate(row["Program Update Date"]);
    if (!program_date) continue;
    nutrition_targets.push({
      program_date,
      weekday: str(row["Program Weekday"]),
      calories: num(row["Calories (kcal)"]),
      protein: num(row["Protein (g)"]),
      carbs: num(row["Carbs (g)"]),
      fat: num(row["Fat (g)"]),
      expenditure: num(row["Expenditure (kcal)"]),
      daily_average: num(row["Daily Average (kcal)"]),
      weight: num(row["Weight (kg)"]),
      expenditure_mode: str(row["Expenditure Calculation Mode"]),
    });
  }

  // --- Weight goals ---
  const weight_goals: Record<string, unknown>[] = [];
  for (const row of rows("Weight Goals")) {
    const goal = str(row["Goal"]);
    if (!goal) continue;
    weight_goals.push({
      goal,
      status: str(row["Status"]),
      start_date: isoDate(row["Start Date"]),
      end_date: isoDate(row["End Date"]),
      goal_weight: num(row["Goal Weight (kg)"]),
      goal_rate_pct: num(row["Goal Rate per Week (%)"]),
      starting_scale_weight: num(row["Starting Scale Weight (kg)"]),
      starting_trend_weight: num(row["Starting Trend Weight (kg)"]),
      original_eta_days: num(row["Original ETA (days)"]),
      checkpoint_date: isoDate(row["Trend Weight Goal Checkpoint Date"]),
      checkpoint_weight: num(row["Trend Weight Goal Checkpoint Weight (kg)"]),
      ending_scale_weight: num(row["Ending Scale Weight (kg)"]),
      ending_trend_weight: num(row["Ending Trend Weight (kg)"]),
    });
  }

  // --- Muscle group aggregates (wide -> long, merging Sets + Volume by date x muscle) ---
  const muscleMap = new Map<string, Record<string, unknown>>();
  const muscleRec = (date: string, muscle: string) => {
    const k = `${date}|${muscle}`;
    let rec = muscleMap.get(k);
    if (!rec) {
      rec = { date, muscle, sets: null, volume_kg: null };
      muscleMap.set(k, rec);
    }
    return rec;
  };
  for (const row of rows("Muscle Groups - Sets")) {
    const date = isoDate(row.Date);
    if (!date) continue;
    for (const [col, v] of Object.entries(row)) {
      if (col === "Date") continue;
      const val = num(v);
      if (val != null) muscleRec(date, stripUnit(col)).sets = val;
    }
  }
  for (const row of rows("Muscle Groups - Volume")) {
    const date = isoDate(row.Date);
    if (!date) continue;
    for (const [col, v] of Object.entries(row)) {
      if (col === "Date") continue;
      const val = num(v);
      if (val != null) muscleRec(date, stripUnit(col)).volume_kg = val;
    }
  }
  const muscle_volume = [...muscleMap.values()];

  // --- Per-exercise computed metrics (many wide "Exercises - *" sheets -> long) ---
  const METRIC_SHEETS: Record<string, string> = {
    "Exercises - 1-RM": "1RM",
    "Exercises - 3-RM": "3RM",
    "Exercises - 10-RM": "10RM",
    "Exercises - Total Volume": "total_volume",
    "Exercises - Best Set Volume": "best_set_volume",
    "Exercises - Heaviest Weight": "heaviest_weight",
    "Exercises - Total Reps": "total_reps",
    "Exercises - Best Set Reps": "best_set_reps",
    "Exercises - Total Sets": "total_sets",
  };
  const exercise_metrics: Record<string, unknown>[] = [];
  for (const [sheet, metric] of Object.entries(METRIC_SHEETS)) {
    for (const row of rows(sheet)) {
      const date = isoDate(row.Date);
      if (!date) continue;
      for (const [col, v] of Object.entries(row)) {
        if (col === "Date") continue;
        const val = num(v);
        if (val != null) exercise_metrics.push({ date, exercise: stripUnit(col), metric, value: val });
      }
    }
  }

  // --- Body metrics (circumference measurements in cm + visual body-fat assessment) ---
  // Dedupe by date (last row wins) so a duplicate date can't trip the body_metrics PRIMARY KEY
  // on import; coerce measurement values to numbers and skip ghost rows (a date with no data).
  const bodyMap = new Map<string, Record<string, unknown>>();
  for (const row of rows("Body Metrics")) {
    const date = isoDate(row.Date);
    if (!date) continue;
    const measurements: Record<string, unknown> = {};
    let vbf: number | null = null;
    for (const [k, v] of Object.entries(row)) {
      if (k === "Date" || v == null) continue;
      if (k === "Visual Body Fat Assessment") {
        vbf = num(v);
        continue;
      }
      const mv = num(v);
      if (mv != null) measurements[k] = mv;
    }
    if (vbf == null && Object.keys(measurements).length === 0) continue;
    bodyMap.set(date, { date, visual_body_fat: vbf, measurements: JSON.stringify(measurements) });
  }
  const body_metrics = [...bodyMap.values()];

  // --- Training program (planned template) ---
  const training_programs: Record<string, unknown>[] = [];
  const prog = parseProgram(aoa("Training Programs"));
  if (prog && prog.program) {
    training_programs.push({
      program: prog.program,
      meta: JSON.stringify(prog.meta),
      plan: JSON.stringify(prog.cycles),
    });
  }

  const exercise_settings: Record<string, unknown>[] = [];
  for (const row of rows("Exercise Settings")) {
    const keys = Object.keys(row);
    const nameKey = keys.find((k) => /^exercises?$/i.test(k.trim())) ?? "Exercises";
    const unitKey = keys.find((k) => /weight\s*unit/i.test(k));
    const ex = str(row[nameKey]);
    if (!ex) continue;
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (k !== nameKey && v != null) rest[k] = v;
    }
    exercise_settings.push({
      exercise: ex,
      weight_unit: unitKey ? str(row[unitKey]) : null,
      raw: JSON.stringify(rest),
    });
  }

  const days = [...dayMap.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return {
    days, micronutrients, food_library, nutrition_targets, weight_goals, muscle_volume, exercise_metrics,
    body_metrics, training_programs, exercise_settings,
  };
}

// "09:00 AM" / "07:38 PM" -> "09:00" / "19:38" (24h, for correct ordering)
function to24h(v: unknown): string | null {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])?/);
  if (!m) return s;
  let h = parseInt(m[1], 10);
  const ap = m[3]?.toUpperCase();
  if (ap === "PM" && h < 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

// Minimal RFC4180 CSV parser (handles quoted fields, embedded commas, "" escapes).
// Used instead of SheetJS so the already-ISO date/time text isn't coerced to numbers.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") {
      // Bare CR (old-Mac) ends the row; CRLF is handled by the following \n.
      if (text[i + 1] !== "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      i++; continue;
    }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function decodeCsv(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let text = new TextDecoder().decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  return text;
}

// Read the header line of a CSV so the upload endpoint can tell the food-log CSV from the
// workout-log CSV (both are plain CSVs; only magic bytes distinguish them from the .xlsx).
export function csvHeader(data: ArrayBuffer | Uint8Array): string[] {
  const text = decodeCsv(data);
  const nl = text.search(/\r?\n/);
  const line = nl === -1 ? text : text.slice(0, nl);
  const rows = parseCsv(line);
  return rows.length ? rows[0].map((h) => h.trim()) : [];
}

// Parse MacroFactor's separate "Food Log" CSV export into food_log rows.
export function parseFoodLogCsv(data: ArrayBuffer | Uint8Array): Record<string, unknown>[] {
  const text = decodeCsv(data);
  const rows = parseCsv(text);
  if (rows.length < 2) return [];

  const header = rows[0].map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const iDate = col("Date"), iTime = col("Time"), iName = col("Food Name"),
    iSize = col("Serving Size"), iQty = col("Serving Qty"), iWeight = col("Serving Weight (g)"),
    iCal = col("Calories (kcal)"), iFat = col("Fat (g)"), iCarbs = col("Carbs (g)"), iPro = col("Protein (g)");

  const cell = (r: string[], i: number) => (i >= 0 && i < r.length ? r[i] : null);

  const out: Record<string, unknown>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const date = isoDate(cell(cells, iDate));
    if (!date) continue;
    out.push({
      date,
      time: to24h(cell(cells, iTime)),
      name: cell(cells, iName) || null,
      serving_size: cell(cells, iSize) || null,
      serving_qty: num(cell(cells, iQty)),
      serving_weight_g: num(cell(cells, iWeight)),
      calories: num(cell(cells, iCal)),
      protein: num(cell(cells, iPro)),
      carbs: num(cell(cells, iCarbs)),
      fat: num(cell(cells, iFat)),
    });
  }
  return out;
}

// Parse MacroFactor's separate "Workout Log" CSV export into per-set workout_sets rows.
export function parseWorkoutLogCsv(data: ArrayBuffer | Uint8Array): Record<string, unknown>[] {
  const text = decodeCsv(data);
  const rows = parseCsv(text);
  if (rows.length < 2) return [];

  const header = rows[0].map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const iDate = col("Date"), iWDur = col("Workout Duration"), iWorkout = col("Workout"),
    iEx = col("Exercise"), iBase = col("Exercise Base Weight (kg)"), iType = col("Set Type"),
    iWt = col("Weight (kg)"), iReps = col("Reps"), iRir = col("RIR"), iDur = col("Duration"),
    iDshort = col("Distance short (m)"), iDlong = col("Distance long (km)");

  const cell = (r: string[], i: number) => (i >= 0 && i < r.length ? r[i] : null);

  // 1-based set index within each (date, workout, exercise), in file order.
  const counter = new Map<string, number>();

  const out: Record<string, unknown>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const date = isoDate(cell(cells, iDate));
    if (!date) continue;
    const workout = cell(cells, iWorkout) || null;
    const exercise = cell(cells, iEx) || null;
    const key = `${date}|${workout}|${exercise}`;
    const idx = (counter.get(key) ?? 0) + 1;
    counter.set(key, idx);
    out.push({
      date,
      workout,
      exercise,
      set_index: idx,
      set_type: cell(cells, iType) || null,
      weight_kg: num(cell(cells, iWt)),
      reps: num(cell(cells, iReps)),
      rir: num(cell(cells, iRir)),
      base_weight_kg: num(cell(cells, iBase)),
      duration_s: num(cell(cells, iDur)),
      distance_m: num(cell(cells, iDshort)),
      distance_km: num(cell(cells, iDlong)),
      workout_duration_s: num(cell(cells, iWDur)),
    });
  }
  return out;
}
