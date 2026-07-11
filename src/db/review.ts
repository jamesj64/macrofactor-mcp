import { addDays, todayLocal } from "./utils";
import { getWeeklySummary } from "./nutrition";
import { getPrAlerts } from "./prs";
import { getDayOfWeekPatterns } from "./analytics";

// One-call weekly review: the exact bundle a "Weekly review" playbook pulls
// (weekly_summary + get_pr_alerts + day_of_week_patterns), guaranteed to share one end date
// instead of drifting across three sequential calls.
export async function getWeeklyReview(DB: D1Database, end_date?: string, windows?: number[]) {
  const end = end_date ?? todayLocal();
  const valid = (windows ?? []).filter((n) => n > 0);
  const maxN = valid.length ? Math.max(...valid) : 28;
  const summary = await getWeeklySummary(DB, end, windows);
  const alerts = await getPrAlerts(DB, addDays(end, -(maxN - 1)));
  const patterns = await getDayOfWeekPatterns(DB, addDays(end, -89), end);
  return {
    as_of: end,
    weekly_summary: summary,
    pr_alerts: alerts,
    day_of_week_patterns: patterns,
    note:
      "Composite for the weekly review, all sharing one end date: weekly_summary windows (default " +
      "7/14/28d), PR alerts detected within the longest window (incl. the front-squat:back-squat " +
      "bottleneck_kpi), and day-of-week patterns over the 90 days ending at as_of. Pair with " +
      "your wearable's recovery data for the recovery side.",
  };
}
