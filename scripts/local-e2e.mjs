// End-to-end exercise of a LOCAL dev server (npm run dev) through the MCP endpoint plus the
// phone-facing endpoints, without a phone: list tools → search → nutrients → log → claim → ack.
//
//   npm run dev            (in another terminal; uses .dev.vars for INGEST_SECRET / MCP_TOKEN)
//   node scripts/local-e2e.mjs [base-url]
//
// Env: MF_INGEST_SECRET (default dev-ingest-secret), MF_MCP_TOKEN (default dev-mcp-token).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = (process.argv[2] || "http://localhost:8787").replace(/\/$/, "");
const SECRET = process.env.MF_INGEST_SECRET || "dev-ingest-secret";
const TOKEN = process.env.MF_MCP_TOKEN || "dev-mcp-token";

const client = new Client({ name: "local-e2e", version: "0.0.1" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${TOKEN}`)));

const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`, tools.map((t) => t.name).join(", "));
const instr = client.getInstructions?.();
console.log("instructions:", instr ? `${instr.length} chars` : "none");

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const txt = r.content?.map((c) => c.text).join("\n") ?? "";
  try { return JSON.parse(txt); } catch { return txt; }
}

// --- search + nutrients (live USDA / OFF; DEMO_KEY is fine at this volume) ---
const sf = await call("search_food", { query: "kale raw", limit: 3 });
check("search_food returns usda rows", Array.isArray(sf.usda) && sf.usda.length > 0, JSON.stringify(sf.errors));
const kale = sf.usda?.find((h) => /kale, raw/i.test(h.name)) ?? sf.usda?.[0];
if (kale) {
  const gn = await call("get_food_nutrients", { source: "usda", id: kale.id, grams: 150 });
  check("get_food_nutrients scales to 150 g", gn.nutrients?.energy > 30 && gn.nutrients?.energy < 80, `energy=${gn.nutrients?.energy} vitK=${gn.nutrients?.vitaminK}`);
  check("get_food_nutrients gives log_food_args", gn.log_food_args?.serving?.amount === 150 && gn.log_food_args?.nutrients?.energy != null);
}
const off = await call("search_food", { query: "greek yogurt", sources: ["off"], limit: 3 });
check("search_food OFF rows", Array.isArray(off.off) && off.off.length > 0, JSON.stringify(off.errors));
const bc = await call("lookup_barcode", { barcode: "3017620422003" });
check("lookup_barcode Nutella", /nutella/i.test(bc.name ?? ""), `${bc.name} ${bc.nutrients?.energy} kcal / ${bc.amount}`);

// --- OpenAI-style search/fetch ---
const s = await call("search", { query: "kale" });
check("search (connector) shape", Array.isArray(s.results) && s.results.every((r) => r.id && r.title && "url" in r));
if (s.results?.[0]) {
  const f = await call("fetch", { id: s.results[0].id });
  check("fetch (connector) shape", f.id && f.title && typeof f.text === "string" && "url" in f && f.metadata);
}

// --- write path without a phone ---
await call("cancel_pending_log", {});
const lf = await call("log_food", {
  name: "Jersey Mike's #7 Turkey & Provolone Sub, Giant, no toppings",
  brand: "Jersey Mike's",
  calories: 1010, protein: 62, carbs: 118, fat: 30, fiber: 6, sugar: 12, sodium_mg: 2900, saturated_fat: 12,
  serving: { amount: 1, label: "giant sub", weight: 540 },
  notes: "e2e test entry",
  llm_prompt: "add jersey mike giant turkey sub no toppings",
  intended_time: "12:30",
});
check("log_food queued", ["queued_only", "sent", "push_failed"].includes(lf.status), `${lf.status}: ${lf.message?.slice(0, 80)}`);
const bad = await call("log_food", { name: "no energy", protein: 5 });
check("log_food rejects missing energy", bad.status === "invalid", bad.message);
const lb = await call("log_foods_batch", { items: [{ name: "Banana", calories: 105, carbs: 27 }, { name: "Black coffee", calories: 2, caffeine_mg: 95, beverage: "beverage" }] });
check("log_foods_batch queued 2", lb.count === 2 && lb.queue_ids?.length === 2);
const lr = await call("log_recipe", { name: "Test bowl", ingredients: [{ name: "Rice", calories: 200, carbs: 45 }, { name: "Chicken", calories: 165, protein: 31 }] });
check("log_recipe summed", /365 kcal/.test(lr.message ?? ""), lr.message?.slice(-60));
const WW = tools.some((t) => t.name === "log_water");
if (WW) { await call("log_water", { ml: 500 }); await call("log_weight", { kg: 180, unit: "lbs" }); }
const pend = await call("get_pending_logs", {});
check(`get_pending_logs shows 4 foods${WW ? " + water + weight" : ""}`, pend.food?.length === 4 && (!WW || (pend.water?.length === 1 && pend.weight?.length === 1)), `food=${pend.food?.length} water=${pend.water?.length} weight=${pend.weight?.length}`);

// Simulate the MF Sync Shortcut.
const claimRes = await fetch(`${base}/pending-all?token=${SECRET}`).then((r) => r.json());
check("/pending-all claims everything", claimRes.foods.length === 4 && (!WW || (claimRes.count === 6 && claimRes.water[0] === 500 && Math.abs(claimRes.weight[0] - 81.647) < 0.01)), JSON.stringify({ count: claimRes.count, water: claimRes.water, weight: claimRes.weight }));
const sub = claimRes.foods[0];
check("payload matches official schema keys", ["source", "icon", "name", "nutrients", "serving", "brand", "notes", "llmPrompt"].every((k) => k in sub) && !("_pending_id" in sub) && sub.nutrients.energy === 1010, JSON.stringify(sub).slice(0, 160));
check("recipe children are complete foods", claimRes.foods[3].recipe?.every((c) => c.source && c.icon && c.serving && c.nutrients));
const again = await fetch(`${base}/pending-all?token=${SECRET}`).then((r) => r.json());
check("second claim is empty (rows are claimed)", again.count === 0);
const pend2 = await call("get_pending_logs", {});
check("pending shows claimed:true", pend2.food?.every((f) => f.claimed === true));

const summary = { consumed: { energy: 1282, protein: 93, carbs: 190, fat: 30, water: 500 }, remaining: { energy: { target: 918 }, protein: { target: 87 }, carbs: { target: 60 }, fat: { target: 40 }, water: { minimum: 1500, target: 2000, maximum: 3500 } } };
const ack = await fetch(`${base}/sync-ack?token=${SECRET}&claim=${claimRes.claim}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(summary) }).then((r) => r.json());
check("/sync-ack deletes claimed rows", ack.ok && ack.acked?.foods === 4 && (!WW || (ack.acked?.water === 1 && ack.acked?.weight === 1)), JSON.stringify(ack.acked));
check("/sync-ack stored today summary", ack.today?.consumed?.calories === 1282, JSON.stringify(ack.today));
const pend3 = await call("get_pending_logs", {});
check("queue empty after ack", pend3.total_pending === 0 && pend3.recent_dispatches?.some((d) => d.landed === true && /Jersey/.test(d.name)));
const today = await call("get_today", { detail: "full" });
check("get_today is live with target from remaining", today.live === true && today.consumed?.calories === 1282 && today.remaining_to_target?.calories === 918, JSON.stringify({ c: today.consumed, r: today.remaining_to_target }));

const tg = await call("get_targets", {});
check("targets derived from the sync-ack summary", tg.target?.calories === 2200 && tg.target?.protein === 180, JSON.stringify(tg.target));

// unauthorised
const un = await fetch(`${base}/pending-all?token=nope`);
check("/pending-all rejects bad token", un.status === 401);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
