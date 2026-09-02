// Dev utility: call every read-only tool on the deployed server (connector-url.txt) and print the
// top-level shape of each response — used to keep the output schemas in src/output-schemas.ts honest.
//   node scripts/introspect-outputs.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const url = readFileSync("connector-url.txt", "utf8").trim();
const c = new Client({ name: "introspect", version: "0" });
await c.connect(new StreamableHTTPClientTransport(new URL(url)));
const { tools } = await c.listTools();
const READ = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
const ARGS = {
  get_food_nutrients: { source: "usda", id: "2775303", servings: 1 },
  lookup_barcode: { barcode: "3017620422003" },
  search_food: { query: "kale", limit: 2 },
  search_my_foods: { query: "a" },
  search: { query: "kale" },
  fetch: { id: "usda:2775303" },
  get_exercise_progress: { metric: "1RM" },
  forecast_weight: {},
};
const shape = (v, depth = 0) => {
  if (v === null) return "null";
  if (Array.isArray(v)) return depth > 1 ? "array" : `array<${v.length ? shape(v[0], depth + 1) : "?"}>`;
  if (typeof v === "object") return depth > 1 ? "object" : Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, shape(x, depth + 1)]));
  return typeof v;
};
const out = {};
for (const name of READ) {
  try {
    const r = await c.callTool({ name, arguments: ARGS[name] ?? {} });
    const txt = r.content?.map((x) => x.text).join("") ?? "";
    let v; try { v = JSON.parse(txt); } catch { v = txt; }
    out[name] = { top: Array.isArray(v) ? "array" : typeof v, shape: shape(v) };
  } catch (e) { out[name] = { error: String(e.message).slice(0, 120) }; }
}
writeFileSync("/tmp/shapes.json", JSON.stringify(out, null, 1));
for (const [k, v] of Object.entries(out)) console.log(k, "=>", v.top ?? v.error, JSON.stringify(v.shape ?? "").slice(0, 300));
await c.close();
