// One-call composite of a single date — nutrition, weight, and training in one response.
import { round, weekdayOf } from "./utils";
import { getDays, getFoodLog, resolveTarget } from "./nutrition";
import { getWorkouts } from "./training";

export async function getDay(DB: D1Database, date: string) {
  const [days, food, workouts, targets] = await Promise.all([
    getDays(DB, date, date),
    getFoodLog(DB, date, date),
    getWorkouts(DB, date, date),
    DB.prepare(`SELECT * FROM nutrition_targets`).all().then((r) => r.results as any[]),
  ]);
  const day = (days as any[])[0] ?? null;
  const t = resolveTarget(targets, date);
  const target = t && t.calories != null ? { calories: t.calories, protein: t.protein, carbs: t.carbs, fat: t.fat } : null;

  let vs_target: any = null;
  if (day?.calories != null && target?.calories) {
    vs_target = {
      calorie_diff: round(day.calories - target.calories, 0),
      calorie_on_target: Math.abs(day.calories - target.calories) / target.calories <= 0.05,
      protein_diff: day.protein != null && target.protein != null ? round(day.protein - target.protein, 1) : null,
      protein_hit: day.protein != null && target.protein != null ? day.protein >= 0.95 * target.protein : false,
    };
  }

  const sessions = (workouts as any).sessions as any[];
  return {
    date,
    weekday: weekdayOf(date),
    nutrition: day
      ? {
          calories: day.calories, protein: day.protein, carbs: day.carbs, fat: day.fat,
          expenditure: day.expenditure, alcohol_g: day.alcohol_g,
          live: day.live, suspect: day.suspect,
        }
      : null,
    weight: day ? { scale_kg: day.scale_weight, trend_kg: day.trend_weight, fat_percent: day.fat_percent } : null,
    steps: day?.steps ?? null,
    target,
    vs_target,
    food_items: food,
    training: sessions.length ? sessions : null,
    note:
      "Composite view of one date: exported nutrition (live-overlaid when current), per-item food log " +
      "(with suspect flags), logged workout sessions, weight and resolved target. For rolling context use " +
      "weekly_summary; for the live intraday state use get_today.",
  };
}
