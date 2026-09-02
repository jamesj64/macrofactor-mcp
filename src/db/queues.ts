import { safeParse, ageFrom } from "./utils";

export async function enqueueFood(DB: D1Database, payload: string, createdMs: number): Promise<number> {
  const r = await DB.prepare(`INSERT INTO pending_food (created, payload) VALUES (?, ?)`).bind(createdMs, payload).run();
  return r.meta?.last_row_id ?? 0;
}

// Queue several foods atomically (one D1 batch) so a multi-item meal lands in one sync.
export async function enqueueFoods(DB: D1Database, payloads: string[], createdMs: number): Promise<number[]> {
  if (payloads.length === 0) return [];
  const stmt = DB.prepare(`INSERT INTO pending_food (created, payload) VALUES (?, ?)`);
  const results = await DB.batch(payloads.map((p) => stmt.bind(createdMs, p)));
  return results.map((r) => r.meta?.last_row_id ?? 0);
}

// ---- Consolidated "MF Sync" flow: GET /pending-all claims everything, POST /sync-ack deletes it ----

export interface ClaimedSync {
  claim: number; // unix ms of the claim; the Shortcut echoes it back to /sync-ack
  foods: { id: number; payload: string; batch_id?: number }[];
  water: { id: number; ml: number }[];
  weight: { id: number; kg: number }[];
}

// Claim every unclaimed (or stale-claimed) row across the food, batch, water and weight queues
// under one `claim` stamp. Stale = claimed more than `staleLimitMs` ago without an ack (the
// Shortcut crashed or the phone was offline) — those rows are re-served.
export async function claimAllPending(DB: D1Database, staleLimitMs = 600_000): Promise<ClaimedSync> {
  const claim = Date.now();
  const cutoff = claim - staleLimitMs;
  const cond = `(claimed_at IS NULL OR claimed_at < ?)`;
  const [food, batch, water, weight] = await DB.batch([
    DB.prepare(`SELECT id, payload FROM pending_food WHERE ${cond} ORDER BY id`).bind(cutoff),
    DB.prepare(`SELECT id, items FROM pending_batch WHERE ${cond} ORDER BY id`).bind(cutoff),
    DB.prepare(`SELECT id, ml FROM pending_water WHERE ${cond} ORDER BY id`).bind(cutoff),
    DB.prepare(`SELECT id, kg FROM pending_weight WHERE ${cond} ORDER BY id`).bind(cutoff),
  ]);
  const foods: ClaimedSync["foods"] = (food.results as any[]).map((r) => ({ id: r.id, payload: r.payload }));
  for (const b of batch.results as any[]) {
    const items = safeParse(b.items) as unknown;
    if (Array.isArray(items)) {
      for (const it of items) foods.push({ id: 0, payload: JSON.stringify(it), batch_id: b.id });
    }
  }
  const waters = (water.results as any[]).map((r) => ({ id: r.id, ml: r.ml }));
  const weights = (weight.results as any[]).map((r) => ({ id: r.id, kg: r.kg }));

  const updates: D1PreparedStatement[] = [];
  const stamp = (table: string, ids: number[]) => {
    if (ids.length) updates.push(DB.prepare(`UPDATE ${table} SET claimed_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`).bind(claim, ...ids));
  };
  stamp("pending_food", foods.filter((f) => f.id > 0).map((f) => f.id));
  stamp("pending_batch", (batch.results as any[]).map((b) => b.id));
  stamp("pending_water", waters.map((w) => w.id));
  stamp("pending_weight", weights.map((w) => w.id));
  for (const f of foods) {
    if (f.id > 0) {
      const p = safeParse(f.payload) as any;
      updates.push(
        DB.prepare(
          `INSERT OR REPLACE INTO food_dispatch_log (pending_id, name, calories, served_at_ms, landed_at_ms) VALUES (?, ?, ?, ?, NULL)`,
        ).bind(f.id, p?.name ?? null, p?.nutrients?.energy ?? null, claim),
      );
    }
  }
  if (updates.length) await DB.batch(updates);
  return { claim, foods, water: waters, weight: weights };
}

// Delete everything claimed under `claim` and mark the food dispatches as landed.
export async function ackClaim(
  DB: D1Database, claim: number, landedMs: number,
): Promise<{ foods: number; batches: number; water: number; weight: number }> {
  const ids = ((await DB.prepare(`SELECT id FROM pending_food WHERE claimed_at = ?`).bind(claim).all()).results as any[]).map((r) => r.id as number);
  const stmts: D1PreparedStatement[] = [];
  if (ids.length) {
    stmts.push(DB.prepare(`UPDATE food_dispatch_log SET landed_at_ms = ? WHERE pending_id IN (${ids.map(() => "?").join(",")})`).bind(landedMs, ...ids));
  }
  stmts.push(
    DB.prepare(`DELETE FROM pending_food WHERE claimed_at = ?`).bind(claim),
    DB.prepare(`DELETE FROM pending_batch WHERE claimed_at = ?`).bind(claim),
    DB.prepare(`DELETE FROM pending_water WHERE claimed_at = ?`).bind(claim),
    DB.prepare(`DELETE FROM pending_weight WHERE claimed_at = ?`).bind(claim),
  );
  const res = await DB.batch(stmts);
  const del = res.slice(ids.length ? 1 : 0);
  return {
    foods: del[0]?.meta?.changes ?? 0,
    batches: del[1]?.meta?.changes ?? 0,
    water: del[2]?.meta?.changes ?? 0,
    weight: del[3]?.meta?.changes ?? 0,
  };
}

// Returns {id, payload} for the oldest queued food and deletes the row, or null if empty.
export async function popPendingFood(DB: D1Database): Promise<{ id: number; payload: string } | null> {
  const row = (await DB.prepare(`SELECT id, payload FROM pending_food ORDER BY id LIMIT 1`).first()) as
    | { id: number; payload: string }
    | null;
  if (!row) return null;
  await DB.prepare(`DELETE FROM pending_food WHERE id = ?`).bind(row.id).run();
  return row;
}

export async function recordDispatch(DB: D1Database, id: number, payload: string, servedMs: number) {
  const p = safeParse(payload) as any;
  await DB.prepare(
    `INSERT OR REPLACE INTO food_dispatch_log (pending_id, name, calories, served_at_ms, landed_at_ms)
     VALUES (?, ?, ?, ?, NULL)`,
  ).bind(id, p?.name ?? null, p?.nutrients?.energy ?? null, servedMs).run();
}

export async function ackDispatch(DB: D1Database, id: number, landedMs: number): Promise<boolean> {
  const r = await DB.prepare(
    `UPDATE food_dispatch_log SET landed_at_ms = ? WHERE pending_id = ?`,
  ).bind(landedMs, id).run();
  return (r.meta?.changes ?? 0) > 0;
}

export async function getRecentDispatches(DB: D1Database, sinceMs: number) {
  try {
    return (await DB.prepare(
      `SELECT pending_id, name, calories, served_at_ms, landed_at_ms FROM food_dispatch_log
       WHERE served_at_ms >= ? ORDER BY served_at_ms DESC LIMIT 20`,
    ).bind(sinceMs).all()).results as any[];
  } catch {
    return [];
  }
}

// ---- Water logging queue (log_water → /pending-water) ----

export async function enqueueWater(DB: D1Database, ml: number, createdMs: number) {
  await DB.prepare(`INSERT INTO pending_water (created, ml) VALUES (?, ?)`).bind(createdMs, ml).run();
}

// Pop the oldest pending water amount (returns its mL and deletes it), or null.
export async function popPendingWater(DB: D1Database): Promise<number | null> {
  const row = (await DB.prepare(`SELECT id, ml FROM pending_water ORDER BY id LIMIT 1`).first()) as
    | { id: number; ml: number }
    | null;
  if (!row) return null;
  await DB.prepare(`DELETE FROM pending_water WHERE id = ?`).bind(row.id).run();
  return row.ml;
}

// ---- log_weight queue (log_weight → /pending-weight) ----
export async function enqueueWeight(DB: D1Database, kg: number, createdMs: number) {
  await DB.prepare(`INSERT INTO pending_weight (created, kg) VALUES (?, ?)`).bind(createdMs, kg).run();
}

export async function popPendingWeight(DB: D1Database): Promise<number | null> {
  const row = (await DB.prepare(`SELECT id, kg FROM pending_weight ORDER BY id LIMIT 1`).first()) as
    | { id: number; kg: number }
    | null;
  if (!row) return null;
  await DB.prepare(`DELETE FROM pending_weight WHERE id = ?`).bind(row.id).run();
  return row.kg;
}

// ---- log_foods_batch queue (log_foods_batch → /pending-batch + /ack-batch) ----
export async function enqueueBatch(DB: D1Database, items: string, itemCount: number, createdMs: number): Promise<number> {
  const r = await DB.prepare(
    `INSERT INTO pending_batch (created, items, item_count, claimed_at) VALUES (?, ?, ?, NULL)`,
  ).bind(createdMs, items, itemCount).run();
  const id = r.meta.last_row_id;
  if (!id) throw new Error("enqueueBatch: D1 did not return last_row_id");
  return id;
}

export async function claimPendingBatch(
  DB: D1Database, staleLimitMs = 600_000,
): Promise<{ id: number; items: string; item_count: number } | null> {
  const cutoff = Date.now() - staleLimitMs;
  const row = (await DB.prepare(
    `SELECT id, items, item_count FROM pending_batch
     WHERE claimed_at IS NULL OR claimed_at < ?
     ORDER BY id LIMIT 1`,
  ).bind(cutoff).first()) as { id: number; items: string; item_count: number } | null;
  if (!row) return null;
  await DB.prepare(`UPDATE pending_batch SET claimed_at = ? WHERE id = ?`).bind(Date.now(), row.id).run();
  return row;
}

export async function ackBatch(DB: D1Database, id: number): Promise<boolean> {
  const r = await DB.prepare(`DELETE FROM pending_batch WHERE id = ?`).bind(id).run();
  return (r.meta?.changes ?? 0) > 0;
}

export async function getPendingLogs(DB: D1Database) {
  const [food, water, weight, batch, dispatches] = await Promise.all([
    DB.prepare(`SELECT id, created, payload, claimed_at FROM pending_food ORDER BY id`).all(),
    DB.prepare(`SELECT id, created, ml, claimed_at FROM pending_water ORDER BY id`).all(),
    DB.prepare(`SELECT id, created, kg, claimed_at FROM pending_weight ORDER BY id`).all(),
    DB.prepare(`SELECT id, created, item_count, claimed_at, items FROM pending_batch ORDER BY id`).all(),
    getRecentDispatches(DB, Date.now() - 86400000),
  ]);
  const foods = (food.results as any[]).map((r) => {
    const p = safeParse(r.payload);
    return {
      id: r.id, name: (p as any).name ?? null, calories: (p as any).nutrients?.energy ?? null,
      queued_ago: ageFrom(r.created), claimed: r.claimed_at != null,
    };
  });
  const waters = (water.results as any[]).map((r) => ({ id: r.id, ml: r.ml, queued_ago: ageFrom(r.created), claimed: r.claimed_at != null }));
  const weights = (weight.results as any[]).map((r) => ({ id: r.id, kg: r.kg, queued_ago: ageFrom(r.created), claimed: r.claimed_at != null }));
  const batches = (batch.results as any[]).map((r) => ({
    id: r.id, item_count: r.item_count, claimed: r.claimed_at != null, queued_ago: ageFrom(r.created),
    items: (safeParse(r.items) as unknown as any[])?.map?.((i: any) => i?.name).filter(Boolean) ?? [],
  }));
  const recent_dispatches = dispatches.map((d: any) => ({
    name: d.name, calories: d.calories,
    served_ago: ageFrom(d.served_at_ms),
    landed: d.landed_at_ms != null,
    ...(d.landed_at_ms != null ? { landed_ago: ageFrom(d.landed_at_ms) } : {}),
  }));
  return {
    food: foods, water: waters, weight: weights, batches,
    total_pending: foods.length + waters.length + weights.length + batches.length,
    recent_dispatches,
    note:
      "Items listed here are queued on the server and NOT yet logged — they land in MacroFactor only " +
      "after the user taps the notification (or runs the 'MF Sync' Shortcut / asks Siri). Use cancel_pending_log to remove. " +
      "claimed:true = the phone has fetched it but not yet confirmed; it is re-served after 10 min if no ack arrives. " +
      "recent_dispatches (last 24h) shows foods the phone has pulled; landed:true means the Shortcut confirmed " +
      "the log landed in MacroFactor (and refreshed today's live totals in the same step).",
  };
}

// ---- food_intent_log: record + match intended eat-times for queued foods ----

export async function recordFoodIntent(DB: D1Database, name: string, calories: number | null, intendedTime: string, queuedMs: number) {
  await DB.prepare(
    `INSERT INTO food_intent_log (queued_at_ms, date, name, calories, intended_time) VALUES (?, ?, ?, ?, ?)`,
  ).bind(queuedMs, new Date(queuedMs).toISOString().slice(0, 10), name, calories, intendedTime).run();
}

const toMin = (t: string) => parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3, 5), 10);

export async function matchFoodIntents(DB: D1Database): Promise<{ matched: number; ambiguous: number }> {
  const cutoff = Date.now() - 7 * 86400000;
  await DB.prepare(`UPDATE food_intent_log SET status='expired' WHERE status='pending' AND queued_at_ms < ?`).bind(cutoff).run();
  const intents = (await DB.prepare(
    `SELECT id, date, name, calories, intended_time FROM food_intent_log WHERE status = 'pending'`,
  ).all()).results as any[];
  let matched = 0, ambiguous = 0;
  for (const it of intents) {
    const cands = (await DB.prepare(
      `SELECT time FROM food_log WHERE date = ? AND LOWER(name) = LOWER(?) AND time IS NOT NULL
       AND (calories IS NULL OR ? IS NULL OR ABS(calories - ?) <= 2)`,
    ).bind(it.date, it.name, it.calories, it.calories).all()).results as any[];
    const inWindow = cands.filter((c) => Math.abs(toMin(c.time) - toMin(it.intended_time)) <= 12 * 60);
    if (inWindow.length === 1) {
      await DB.prepare(
        `UPDATE food_intent_log SET status='matched', matched_exported_time=? WHERE id=?`,
      ).bind(inWindow[0].time, it.id).run();
      matched++;
    } else if (inWindow.length > 1) {
      await DB.prepare(`UPDATE food_intent_log SET status='ambiguous' WHERE id=?`).bind(it.id).run();
      ambiguous++;
    }
    // 0 candidates: stay pending — the export may not cover this food yet.
  }
  return { matched, ambiguous };
}

// ---- cancel_pending_log: clear ALL rows (claimed or not) from the pending queues ----
// A row claimed by the phone but not yet acked is cleared too — if the Shortcut is mid-run the
// food may still land; get_pending_logs.recent_dispatches shows what actually happened.
export async function cancelPending(
  DB: D1Database,
  queues: ("food" | "water" | "weight" | "batch")[],
): Promise<{ food: number; water: number; weight: number; batch: number }> {
  const out = { food: 0, water: 0, weight: 0, batch: 0 };
  const tables: Record<string, string> = {
    food: "pending_food", water: "pending_water", weight: "pending_weight", batch: "pending_batch",
  };
  for (const q of queues) {
    const r = await DB.prepare(`DELETE FROM ${tables[q]}`).run();
    out[q] = r.meta?.changes ?? 0;
  }
  return out;
}
