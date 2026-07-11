// Data-quality heuristics. Flags are advisory — values are never altered or deleted.
import { MICRO_RDA } from "./analytics";

const PROTEIN_FOOD = /\b(chicken|beef|steak|pork|lamb|fish|salmon|tuna|prawn|shrimp|egg|whey|protein|yoghurt|yogurt|turkey|mince|bacon|ham|kangaroo)\b/i;

export function foodItemFlags(item: {
  name?: string | null; calories?: number | null; protein?: number | null; carbs?: number | null; fat?: number | null;
}): string[] {
  const flags: string[] = [];
  const kcal = item.calories;
  const p = item.protein, c = item.carbs, f = item.fat;
  if (kcal != null && (p != null || c != null || f != null)) {
    const est = 4 * (p ?? 0) + 4 * (c ?? 0) + 9 * (f ?? 0);
    // 4/4/9 won't see fiber/alcohol/sugar-alcohols, so the tolerance is deliberately loose.
    if (est > 0 && Math.abs(kcal - est) > Math.max(30, kcal * 0.15)) flags.push("kcal_macro_mismatch");
    if (est === 0 && kcal >= 100) flags.push("kcal_macro_mismatch");
  }
  if ((p == null || p === 0) && PROTEIN_FOOD.test(item.name ?? "")) flags.push("zero_protein_on_protein_food");
  return flags;
}

export function dayMacroFlag(day: {
  calories?: number | null; protein?: number | null; carbs?: number | null; fat?: number | null; alcohol_g?: number | null;
}): string | null {
  const kcal = day.calories;
  if (kcal == null || kcal <= 0) return null;
  const est = 4 * (day.protein ?? 0) + 4 * (day.carbs ?? 0) + 9 * (day.fat ?? 0) + 7 * (day.alcohol_g ?? 0);
  if (est === 0) return null;
  return Math.abs(kcal - est) > Math.max(100, kcal * 0.075) ? "kcal_macro_mismatch" : null;
}

// Physiologically-implausible single-day intake caps. Explicit overrides where the generic
// bound (3x UL, else 10x RDA) is too loose to catch real entry errors.
const SANITY_OVERRIDES: Record<string, number> = {
  "Magnesium (mg)": 2000,
  "Sodium (mg)": 15000,
  "Iron (mg)": 100,
  "Zinc (mg)": 100,
  "Vitamin D (mcg)": 250,
};

export function microSanityCap(key: string): number | null {
  if (SANITY_OVERRIDES[key] != null) return SANITY_OVERRIDES[key];
  const ref = MICRO_RDA[key];
  if (!ref) return null;
  return ref.ul != null ? ref.ul * 3 : ref.rda * 10;
}

export function isImplausibleMicro(key: string, value: number): boolean {
  const cap = microSanityCap(key);
  return cap != null && value > cap;
}
