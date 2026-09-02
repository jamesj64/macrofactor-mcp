// D1 query helpers. All dates are YYYY-MM-DD strings.

export function dateClause(col: string, start?: string, end?: string, defaultDays = 14) {
  const clauses: string[] = [];
  const params: string[] = [];
  if (start) {
    clauses.push(`${col} >= ?`);
    params.push(start);
  }
  if (end) {
    clauses.push(`${col} <= ?`);
    params.push(end);
  }
  if (!start && !end) {
    clauses.push(`${col} >= date('now', '-${defaultDays} days')`);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

export function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function round(n: number, d = 0): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

// "x min ago" / "x h ago" / "x d ago" from a unix-ms timestamp, for freshness display.
export function ageFrom(ms: number | null | undefined): string | null {
  if (ms == null) return null;
  const diff = Date.now() - Number(ms);
  if (diff < 0) return "just now";
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} h ago`;
  return `${Math.round(hr / 24)} d ago`;
}

// Coerce a possibly-string nutrient value to a number; null when absent/blank.
export function pickNum(obj: any, key: string): number | null {
  if (!obj || typeof obj !== "object") return null;
  const v = obj[key];
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isNaN(v) ? null : v;
  const n = parseFloat(String(v));
  return Number.isNaN(n) ? null : n;
}

// Pull the headline macros out of a MacroFactorTodaySummary payload. Tolerant: accepts the
// full {consumed, remaining} struct, or a bare flat nutrient dict, and treats null as absent.
// `consumed.energy` is kcal; protein/carbs/fat are grams.
export function extractTodaySummary(payload: any): {
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  consumed: Record<string, unknown>;
  remaining: Record<string, unknown> | null;
} {
  const p = payload && typeof payload === "object" ? payload : {};
  const consumed =
    p.consumed && typeof p.consumed === "object"
      ? p.consumed
      : p.energy != null || p.protein != null || p.carbs != null || p.fat != null
        ? p
        : {};
  const remaining = p.remaining && typeof p.remaining === "object" ? p.remaining : null;
  // Round the headline macros (the Today-Summary action returns long floats); the verbatim
  // `consumed` block keeps full precision for get_today's consumed_all.
  const r0 = (n: number | null) => (n == null ? null : Math.round(n));
  const r1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);
  return {
    calories: r0(pickNum(consumed, "energy")),
    protein: r1(pickNum(consumed, "protein")),
    carbs: r1(pickNum(consumed, "carbs")),
    fat: r1(pickNum(consumed, "fat")),
    consumed,
    remaining,
  };
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Calendar weekday name for an ISO date, computed in UTC so it never drifts with the
// Worker's runtime timezone.
export function weekdayOf(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

// The user's home timezone (IANA, e.g. "America/Los_Angeles"), configured via the USER_TZ var in
// wrangler.jsonc and applied with setUserTz() at request entry. "Today" on this single-user server
// means the owner's local calendar date: resolving it in the wrong zone lands post-midnight /today
// posts on the previous day's live row.
let USER_TZ = "UTC";

export function setUserTz(tz: string | undefined | null): void {
  if (!tz || tz === USER_TZ) return;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz }); // throws on an invalid zone
    USER_TZ = tz;
  } catch {
    // keep the previous zone; a typo in wrangler vars shouldn't take the server down
  }
}

export function getUserTz(): string {
  return USER_TZ;
}

export function todayLocal(): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: USER_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

export function addDays(date: string, delta: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

export function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
