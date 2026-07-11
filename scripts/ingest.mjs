// Upload MacroFactor exports to the Worker, which parses them server-side and refreshes D1.
// Accepts the .xlsx workbook (daily totals / micros / saved foods) and/or the food-log .csv.
// The server auto-detects which is which.
//
// Usage:
//   node scripts/ingest.mjs path/to/MacroFactor-export.xlsx
//   node scripts/ingest.mjs path/to/export.xlsx path/to/foodlog.csv
//
// Config: ingest.config.json (copy ingest.config.example.json) with workerUrl + ingestSecret,
// or MF_WORKER_URL / MF_INGEST_SECRET env vars.

import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (files.length === 0) {
  console.error("Usage: node scripts/ingest.mjs <export.xlsx | foodlog.csv> [more files ...]");
  process.exit(1);
}

let cfg = {};
if (existsSync("ingest.config.json")) cfg = JSON.parse(readFileSync("ingest.config.json", "utf8"));
const WORKER_URL = (process.env.MF_WORKER_URL || cfg.workerUrl || "").replace(/\/$/, "");
const SECRET = process.env.MF_INGEST_SECRET || cfg.ingestSecret;
if (!WORKER_URL || !SECRET) {
  console.error("Missing config. Set workerUrl + ingestSecret in ingest.config.json (or MF_WORKER_URL / MF_INGEST_SECRET).");
  process.exit(1);
}

for (const f of files) {
  if (!existsSync(f)) {
    console.error(`! not found: ${f}`);
    continue;
  }
  const bytes = readFileSync(f);
  const res = await fetch(`${WORKER_URL}/upload-export`, {
    method: "POST",
    headers: { "x-ingest-secret": SECRET },
    body: bytes,
  });
  console.log(`${f} -> HTTP ${res.status} ${await res.text()}`);
}
