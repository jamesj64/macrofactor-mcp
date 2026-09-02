// Durable Object that parses an uploaded MacroFactor export and refreshes D1.
// Auto-detects the file type:
//   .xlsx workbook   -> days, micronutrients, food_library, nutrition_targets,
//                       weight_goals, muscle_volume, exercise_metrics, body_metrics,
//                       training_programs
//   food-log .csv    -> food_log
//   workout-log .csv -> workout_sets
// CSVs are disambiguated by their header row (both are plain CSVs), and an unrecognised
// CSV is rejected rather than defaulting to a destructive food_log refresh.
// Runs in a DO (not the outer Worker) so the parse isn't bound by the free-tier
// 10ms-CPU limit on Worker fetch handlers.

import { DurableObject } from "cloudflare:workers";
import { parseExport, parseFoodLogCsv, parseWorkoutLogCsv, csvHeader } from "./parse";
import { TABLES } from "./ingest";
import * as db from "./db";
import type { Env } from "./index";

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

// Refresh a table: DELETE the old rows then insert the new ones. The DELETE and the first
// chunk of inserts go in a single D1 batch (batches are transactional), so a mid-insert
// failure can never leave the table empty — at worst it keeps the old rows or a partial set,
// never zero. Pass an empty `rows` to clear a table that is legitimately empty in this export.
// Rows that did NOT come from an export survive an upload: the saved-foods library rows built from
// the nightly Find Recent Food feed (source = 'recent'). Everything else is replaced wholesale.
const KEEP_ON_REPLACE: Record<string, string> = {
  food_library: `WHERE IFNULL(source, '') <> 'recent'`,
};

async function replace(DB: D1Database, table: string, rows: Record<string, unknown>[]) {
  const cols = TABLES[table];
  if (!cols) return;
  const del = DB.prepare(`DELETE FROM ${table} ${KEEP_ON_REPLACE[table] ?? ""}`);
  if (rows.length === 0) {
    await del.run();
    return;
  }
  const placeholders = `(${cols.map(() => "?").join(", ")})`;
  const stmt = DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES ${placeholders}`);
  const bound = rows.map((r) => stmt.bind(...cols.map((c) => r[c] ?? null)));
  const CHUNK = 50;
  for (let i = 0; i < bound.length; i += CHUNK) {
    const chunk = bound.slice(i, i + CHUNK);
    // First batch carries the DELETE so the swap is atomic and never bottoms out at empty.
    await DB.batch(i === 0 ? [del, ...chunk] : chunk);
  }
}

export class ImportDO extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const buf = await request.arrayBuffer();
    if (!buf || buf.byteLength === 0) return json({ error: "empty body" }, 400);

    const u8 = new Uint8Array(buf);
    const isXlsx = u8[0] === 0x50 && u8[1] === 0x4b; // ZIP magic "PK" => .xlsx workbook
    const DB = this.env.DB;

    // Capture receipt time before any processing (used as import_log.created).
    const receivedMs = Date.now();

    // SHA-256 fingerprint of the raw upload bytes (SubtleCrypto is global in Workers/DOs).
    const hashBuf = await crypto.subtle.digest("SHA-256", buf);
    const fingerprint = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    try {
      if (isXlsx) {
        // Idempotency: skip re-processing an identical workbook (degrades gracefully pre-migration).
        if ((await db.getLastImportFingerprint(DB, "workbook")) === fingerprint) {
          return json({ ok: true, skipped: true, type: "workbook" });
        }
        const p = parseExport(buf);
        // A real MacroFactor workbook always has daily rows. Bail before wiping anything if
        // the file parsed to nothing (wrong/corrupt file) instead of clearing every table.
        if (p.days.length === 0) {
          return json({ error: "workbook parsed no daily data — not importing (wrong or corrupt .xlsx?)" }, 400);
        }
        await replace(DB, "days", p.days);
        await replace(DB, "micronutrients", p.micronutrients);
        await replace(DB, "food_library", p.food_library);
        await replace(DB, "nutrition_targets", p.nutrition_targets);
        await replace(DB, "weight_goals", p.weight_goals);
        await replace(DB, "muscle_volume", p.muscle_volume);
        await replace(DB, "exercise_metrics", p.exercise_metrics);
        await replace(DB, "body_metrics", p.body_metrics);
        await replace(DB, "training_programs", p.training_programs);
        await replace(DB, "exercise_settings", p.exercise_settings);
        const counts = {
          days: p.days.length,
          micronutrients: p.micronutrients.length,
          food_library: p.food_library.length,
          nutrition_targets: p.nutrition_targets.length,
          weight_goals: p.weight_goals.length,
          muscle_volume: p.muscle_volume.length,
          exercise_metrics: p.exercise_metrics.length,
          body_metrics: p.body_metrics.length,
          training_programs: p.training_programs.length,
          exercise_settings: p.exercise_settings.length,
        };
        await db.recordImport(DB, "workbook", fingerprint, counts, receivedMs);
        return json({ ok: true, type: "workbook", ...counts });
      }

      // CSV: positively identify the type by header. Reject anything we don't recognise so a
      // stray/empty/mis-picked CSV can't silently wipe a table.
      const header = csvHeader(buf);
      const isWorkout = header.includes("Exercise") && (header.includes("Set Type") || header.includes("Reps"));
      const isFood = header.includes("Food Name") && header.includes("Date");

      if (isWorkout) {
        if ((await db.getLastImportFingerprint(DB, "workout_log")) === fingerprint) {
          return json({ ok: true, skipped: true, type: "workout_log" });
        }
        const sets = parseWorkoutLogCsv(buf);
        if (sets.length === 0) return json({ error: "workout CSV had no data rows — not importing" }, 400);
        await replace(DB, "workout_sets", sets);
        const counts = { workout_sets: sets.length };
        await db.recordImport(DB, "workout_log", fingerprint, counts, receivedMs);
        return json({ ok: true, type: "workout_log", ...counts });
      }
      if (isFood) {
        if ((await db.getLastImportFingerprint(DB, "food_log")) === fingerprint) {
          return json({ ok: true, skipped: true, type: "food_log" });
        }
        const items = parseFoodLogCsv(buf);
        if (items.length === 0) return json({ error: "food-log CSV had no data rows — not importing" }, 400);
        await replace(DB, "food_log", items);
        const counts = { food_log: items.length };
        await db.recordImport(DB, "food_log", fingerprint, counts, receivedMs);
        const intents = await db.matchFoodIntents(DB);
        return json({ ok: true, type: "food_log", ...counts, intents });
      }
      return json(
        { error: "unrecognised CSV — expected a MacroFactor food-log or workout-log export", header },
        400,
      );
    } catch (e) {
      return json({ error: `parse failed: ${(e as Error).message}` }, 400);
    }
  }
}
