// Read-only smoke test of the DEPLOYED server: lists tools and exercises the food-search tools
// (needs connector-url.txt = the secret /mcp/<token> URL). Never touches the write queues.
//   node scripts/smoke-food.mjs

import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const url = readFileSync("connector-url.txt", "utf8").trim();
const client = new Client({ name: "prod-smoke", version: "0.0.1" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
const { tools } = await client.listTools();
console.log("tools:", tools.length, "| instructions:", (client.getInstructions?.() ?? "").length, "chars");
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); const t = r.content?.map(c => c.text).join(""); try { return JSON.parse(t); } catch { return t; } };
const sf = await call("search_food", { query: "kale raw", limit: 3 });
console.log("search_food: usda", sf.usda?.length, "off", sf.off?.length, "saved", sf.saved?.length, "errors", JSON.stringify(sf.errors));
const id = sf.usda?.[0]?.id;
if (id) { const gn = await call("get_food_nutrients", { source: "usda", id, portion: "cup" }); console.log("get_food_nutrients:", gn.name, "|", gn.amount, "|", JSON.stringify(gn.log_food_args?.serving), "| energy", gn.nutrients?.energy, "vitK", gn.nutrients?.vitaminK, "| keys", Object.keys(gn.nutrients ?? {}).length); }
const bc = await call("lookup_barcode", { barcode: "3017620422003" });
console.log("lookup_barcode:", bc.name, bc.nutrients?.energy, "kcal /", bc.amount);
const s = await call("search", { query: "chobani greek yogurt" });
console.log("search (connector):", s.results?.length, "results; first:", s.results?.[0]?.title);
const st = await call("data_status", {});
console.log("data_status:", JSON.stringify(st).slice(0, 160));
const pend = await call("get_pending_logs", {});
console.log("pending:", pend.total_pending);
await client.close();
