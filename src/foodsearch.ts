// External food databases → MacroFactor nutrient dictionaries.
//   USDA FoodData Central (api.nal.usda.gov/fdc)  — Foundation, SR Legacy, Branded (needs a free key;
//                                                   falls back to DEMO_KEY, 30 req/h)
//   Open Food Facts (world.openfoodfacts.org)       — packaged foods by name or barcode, no key
// Neither covers chain-restaurant menus; the agent uses web search for those.

import {
  HEADLINE_KEYS, NUTRIENT_UNITS, cleanNutrients, isNutrientKey, roundNutrient, scaleNutrients,
  type NutrientKey, type Nutrients, type Serving,
} from "./mf-schema";

export type FoodSource = "usda" | "off";

export interface Portion {
  description: string; // e.g. "1 cup, chopped" / "1 package (255 g)"
  grams: number;
}

export interface FoodHit {
  source: FoodSource;
  id: string;
  name: string;
  brand?: string;
  category?: string;         // USDA dataType / OFF first category
  serving?: Portion;         // the label serving when known
  per100g: Nutrients;        // headline nutrients only (search) or everything (detail)
  per_serving?: Nutrients;   // headline nutrients for `serving`
  barcode?: string;
}

export interface FoodDetail extends FoodHit {
  portions: Portion[];
  ingredients?: string;
  liquid?: boolean;          // per-100 mL rather than per-100 g (OFF)
}

const UA = "macrofactor-mcp/0.2 (+https://github.com/jamesj64/macrofactor-mcp)";
const TIMEOUT_MS = 8000;

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    if (res.status === 429 && url.includes("api_key=DEMO_KEY")) {
      throw new Error("USDA rate limit hit — the shared DEMO_KEY allows ~30 requests/hour. Set the USDA_API_KEY secret (free at fdc.nal.usda.gov/api-key-signup) or retry later.");
    }
    throw new Error(`${res.status} ${res.statusText}${body ? `: ${body}` : ""}`);
  }
  return res.json();
}

function pick(n: Nutrients, keys: NutrientKey[]): Nutrients {
  const out: Nutrients = {};
  for (const k of keys) if (n[k] != null) out[k] = n[k];
  return out;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

function titleCaseIfShouting(str: string): string {
  if (str !== str.toUpperCase() || !/[A-Z]/.test(str)) return str;
  return str.toLowerCase().replace(/(^|[\s\-/(])([a-z])/g, (m, pre, ch) => pre + ch.toUpperCase());
}

// =====================================================================================
// USDA FoodData Central
// =====================================================================================

const FDC = "https://api.nal.usda.gov/fdc/v1";

// FDC nutrient NUMBER → MacroFactor key. `fallback` entries only fill a key that is still empty
// (e.g. Atwater energy when the standard 208 is absent). Units are converted to NUTRIENT_UNITS.
const USDA_BY_NUMBER: Record<string, { key: NutrientKey; fallback?: boolean; iuToMcg?: number }> = {
  "208": { key: "energy" }, "957": { key: "energy", fallback: true }, "958": { key: "energy", fallback: true },
  "203": { key: "protein" }, "204": { key: "fat" }, "205": { key: "carbs" },
  "291": { key: "fiber" }, "269": { key: "sugars" }, "269.3": { key: "sugars", fallback: true },
  "539": { key: "sugarsAdded" }, "209": { key: "starch" },
  "606": { key: "saturatedFat" }, "605": { key: "transFat" },
  "645": { key: "monounsaturatedFat" }, "646": { key: "polyunsaturatedFat" }, "601": { key: "cholesterol" },
  "307": { key: "sodium" }, "306": { key: "potassium" }, "301": { key: "calcium" }, "303": { key: "iron" },
  "304": { key: "magnesium" }, "305": { key: "phosphorus" }, "309": { key: "zinc" }, "312": { key: "copper" },
  "315": { key: "manganese" }, "317": { key: "selenium" },
  "401": { key: "vitaminC" }, "404": { key: "vitaminB1" }, "405": { key: "vitaminB2" }, "406": { key: "vitaminB3" },
  "410": { key: "vitaminB5" }, "415": { key: "vitaminB6" }, "418": { key: "vitaminB12" },
  "417": { key: "folate" }, "435": { key: "folate", fallback: true },
  "320": { key: "vitaminA" }, "328": { key: "vitaminD" }, "324": { key: "vitaminD", fallback: true, iuToMcg: 0.025 },
  "323": { key: "vitaminE" }, "430": { key: "vitaminK" }, "421": { key: "choline" },
  "262": { key: "caffeine" }, "221": { key: "alcohol" }, "255": { key: "water" },
  "512": { key: "histidine" }, "503": { key: "isoleucine" }, "504": { key: "leucine" }, "505": { key: "lysine" },
  "506": { key: "methionine" }, "508": { key: "phenylalanine" }, "502": { key: "threonine" },
  "501": { key: "tryptophan" }, "509": { key: "tyrosine" }, "510": { key: "valine" }, "507": { key: "cystine" },
  "851": { key: "omega3ALA" }, "629": { key: "omega3EPA" }, "621": { key: "omega3DHA" },
};

// Convert an FDC value in `from` units to the MacroFactor unit for `key`.
function convertUnit(key: NutrientKey, value: number, from: string, iuToMcg?: number): number | null {
  const to = NUTRIENT_UNITS[key];
  // FDC spells micrograms "UG" in search results and "µg" in detail responses (U+00B5 / U+03BC).
  const f = from.replace(/[\u00b5\u03bc\u039c]/g, "U").toUpperCase();
  if (f === "IU") return iuToMcg != null && to === "mcg" ? value * iuToMcg : null;
  if (f === "KJ") return to === "kcal" ? value / 4.184 : null;
  if (f === "KCAL") return to === "kcal" ? value : null;
  const gramsIn = f === "G" ? 1 : f === "MG" ? 1e-3 : f === "UG" || f === "MCG" ? 1e-6 : null;
  if (gramsIn == null) return null;
  const gramsOut = to === "g" ? 1 : to === "mg" ? 1e-3 : to === "mcg" ? 1e-6 : null;
  if (gramsOut == null) return null;
  return (value * gramsIn) / gramsOut;
}

// Normalise FDC foodNutrients from either the search shape ({nutrientNumber, unitName, value})
// or the detail shape ({nutrient:{number, unitName}, amount}) into per-100 g MacroFactor keys.
function usdaNutrients(list: any[] | undefined): Nutrients {
  const out: Record<string, number> = {};
  const fromFallback = new Set<string>();
  for (const fn of list ?? []) {
    const number = String(fn.nutrientNumber ?? fn.nutrient?.number ?? "");
    const unit = String(fn.unitName ?? fn.nutrient?.unitName ?? "");
    const raw = fn.value ?? fn.amount;
    const map = USDA_BY_NUMBER[number];
    if (!map || typeof raw !== "number") continue;
    const v = convertUnit(map.key, raw, unit, map.iuToMcg);
    if (v == null) continue;
    if (map.fallback) {
      if (out[map.key] == null) { out[map.key] = v; fromFallback.add(map.key); }
    } else if (out[map.key] == null || fromFallback.has(map.key)) {
      out[map.key] = v;
      fromFallback.delete(map.key);
    }
  }
  return cleanNutrients(out);
}

function usdaPortions(food: any): Portion[] {
  const out: Portion[] = [];
  // Branded: label serving
  if (typeof food.servingSize === "number" && food.servingSize > 0) {
    const unit = String(food.servingSizeUnit ?? "g").toLowerCase();
    const grams = unit === "g" || unit === "ml" || unit === "grm" || unit === "mlt" ? food.servingSize : null;
    if (grams != null) {
      const label = food.householdServingFullText ? String(food.householdServingFullText).trim() : `${food.servingSize} ${unit}`;
      out.push({ description: label, grams: r1(grams) });
    }
  }
  // Search shape (SR Legacy / Foundation)
  for (const m of food.foodMeasures ?? []) {
    if (typeof m.gramWeight === "number" && m.gramWeight > 0 && m.disseminationText) {
      out.push({ description: String(m.disseminationText), grams: r1(m.gramWeight) });
    }
  }
  // Detail shape
  for (const p of food.foodPortions ?? []) {
    if (typeof p.gramWeight !== "number" || p.gramWeight <= 0) continue;
    const desc =
      p.portionDescription && p.portionDescription !== "Quantity not specified"
        ? String(p.portionDescription)
        : [p.amount, p.measureUnit?.name && p.measureUnit.name !== "undetermined" ? p.measureUnit.name : null, p.modifier]
            .filter((x) => x != null && x !== "")
            .join(" ")
            .trim();
    if (desc) out.push({ description: desc, grams: r1(p.gramWeight) });
  }
  // de-dupe by description
  const seen = new Set<string>();
  return out.filter((p) => (seen.has(p.description) ? false : (seen.add(p.description), true)));
}

function usdaHit(food: any, full: boolean): FoodDetail {
  const per100g = usdaNutrients(food.foodNutrients);
  const portions = usdaPortions(food);
  const serving = portions[0];
  // Prefer the consumer-facing brand ("Lucky Charms") over the corporate owner ("GENERAL MILLS SALES INC.");
  // owner strings are usually shouting, so title-case them when they are the only option.
  const brand = food.brandName
    ? String(food.brandName).trim()
    : food.brandOwner
      ? titleCaseIfShouting(String(food.brandOwner).trim())
      : undefined;
  return {
    source: "usda",
    id: String(food.fdcId),
    name: String(food.description ?? "").trim(),
    brand,
    category: food.dataType ? String(food.dataType) : undefined,
    serving,
    per100g: full ? per100g : pick(per100g, HEADLINE_KEYS),
    per_serving: serving ? pick(scaleNutrients(per100g, serving.grams / 100), HEADLINE_KEYS) : undefined,
    barcode: food.gtinUpc ? String(food.gtinUpc) : undefined,
    portions,
    ingredients: food.ingredients ? String(food.ingredients).slice(0, 300) : undefined,
  };
}

export async function searchUSDA(
  query: string,
  apiKey: string | undefined,
  opts: { limit?: number; dataTypes?: string[]; brandOwner?: string } = {},
): Promise<FoodHit[]> {
  const params = new URLSearchParams({
    api_key: apiKey || "DEMO_KEY",
    query,
    pageSize: String(Math.min(Math.max(opts.limit ?? 8, 1), 25)),
    dataType: (opts.dataTypes ?? ["Foundation", "SR Legacy", "Branded"]).join(","),
  });
  if (opts.brandOwner) params.set("brandOwner", opts.brandOwner);
  const data = await getJson(`${FDC}/foods/search?${params}`);
  return (data.foods ?? []).map((f: any) => {
    const d = usdaHit(f, false);
    // keep search rows compact — portions only in detail
    const { portions: _p, ingredients: _i, ...hit } = d;
    return hit;
  });
}

export async function getUSDAFood(fdcId: string, apiKey: string | undefined): Promise<FoodDetail> {
  const params = new URLSearchParams({ api_key: apiKey || "DEMO_KEY" });
  const data = await getJson(`${FDC}/food/${encodeURIComponent(fdcId)}?${params}`);
  return usdaHit(data, true);
}

// =====================================================================================
// Open Food Facts
// =====================================================================================

const OFF = "https://world.openfoodfacts.org";

// OFF stores every nutriment per 100 g/mL in GRAMS (energy in kJ/kcal, alcohol in % vol),
// regardless of the display unit — so mg keys are ×1000 and mcg keys ×1e6.
const OFF_KEYS: [string, NutrientKey, number][] = [
  ["energy-kcal", "energy", 1],
  ["proteins", "protein", 1], ["carbohydrates", "carbs", 1], ["fat", "fat", 1], ["fiber", "fiber", 1],
  ["sugars", "sugars", 1], ["added-sugars", "sugarsAdded", 1], ["starch", "starch", 1],
  ["saturated-fat", "saturatedFat", 1], ["trans-fat", "transFat", 1],
  ["monounsaturated-fat", "monounsaturatedFat", 1], ["polyunsaturated-fat", "polyunsaturatedFat", 1],
  ["omega-3-fat", "omega3", 1], ["omega-6-fat", "omega6", 1],
  ["cholesterol", "cholesterol", 1000], ["sodium", "sodium", 1000], ["potassium", "potassium", 1000],
  ["calcium", "calcium", 1000], ["iron", "iron", 1000], ["magnesium", "magnesium", 1000],
  ["phosphorus", "phosphorus", 1000], ["zinc", "zinc", 1000], ["copper", "copper", 1000],
  ["manganese", "manganese", 1000], ["selenium", "selenium", 1e6],
  ["vitamin-c", "vitaminC", 1000], ["vitamin-b1", "vitaminB1", 1000], ["vitamin-b2", "vitaminB2", 1000],
  ["vitamin-pp", "vitaminB3", 1000], ["pantothenic-acid", "vitaminB5", 1000], ["vitamin-b6", "vitaminB6", 1000],
  ["vitamin-b12", "vitaminB12", 1e6], ["folates", "folate", 1e6], ["vitamin-a", "vitaminA", 1e6],
  ["vitamin-d", "vitaminD", 1e6], ["vitamin-e", "vitaminE", 1000], ["vitamin-k", "vitaminK", 1e6],
  ["choline", "choline", 1000], ["caffeine", "caffeine", 1000], ["water", "water", 1],
];

function offNutrients(nutriments: any, suffix: "_100g" | "_serving"): Nutrients {
  const out: Record<string, number> = {};
  if (!nutriments) return {};
  for (const [offKey, key, factor] of OFF_KEYS) {
    const v = nutriments[`${offKey}${suffix}`];
    if (typeof v === "number") out[key] = v * factor;
  }
  if (out.energy == null && typeof nutriments[`energy${suffix}`] === "number") {
    const unit = String(nutriments.energy_unit ?? "kJ").toLowerCase();
    out.energy = unit === "kcal" ? nutriments[`energy${suffix}`] : nutriments[`energy${suffix}`] / 4.184;
  }
  const alc = nutriments[`alcohol${suffix}`];
  if (typeof alc === "number") out.alcohol = alc * 0.789; // % vol → g per 100 mL
  return cleanNutrients(out);
}

function offHit(p: any, full: boolean): FoodDetail {
  const per100 = offNutrients(p.nutriments, "_100g");
  const servingGrams = typeof p.serving_quantity === "number" ? p.serving_quantity : parseFloat(String(p.serving_quantity ?? ""));
  const serving = Number.isFinite(servingGrams) && servingGrams > 0
    ? { description: String(p.serving_size ?? `${servingGrams} g`).trim(), grams: r1(servingGrams) }
    : undefined;
  let perServing = offNutrients(p.nutriments, "_serving");
  if (Object.keys(perServing).length === 0 && serving) perServing = scaleNutrients(per100, serving.grams / 100);
  const cat = Array.isArray(p.categories_tags) && p.categories_tags.length
    ? String(p.categories_tags[p.categories_tags.length - 1]).replace(/^[a-z]{2}:/, "").replace(/-/g, " ")
    : undefined;
  const name = [p.product_name, p.quantity].filter(Boolean).join(", ").trim() || `OFF ${p.code}`;
  const liquid = /\b(ml|l|litre|liter|fl\.? ?oz)\b/i.test(String(p.quantity ?? p.serving_size ?? ""));
  return {
    source: "off",
    id: String(p.code),
    name,
    brand: Array.isArray(p.brands) ? String(p.brands[0] ?? "").trim() || undefined : p.brands ? String(p.brands).split(",")[0].trim() : undefined,
    category: cat,
    serving,
    per100g: full ? per100 : pick(per100, HEADLINE_KEYS),
    per_serving: Object.keys(perServing).length ? pick(perServing, HEADLINE_KEYS) : undefined,
    barcode: String(p.code),
    portions: serving ? [serving] : [],
    ingredients: p.ingredients_text ? String(p.ingredients_text).slice(0, 300) : undefined,
    liquid,
  };
}

const OFF_FIELDS = "code,product_name,brands,quantity,serving_size,serving_quantity,nutriments,categories_tags,ingredients_text";

// OFF has two search APIs: search-a-licious (search.openfoodfacts.org, fast, returns `hits`) and the
// legacy CGI search (world.openfoodfacts.org/cgi/search.pl, returns `products`, frequently 503).
// Try the new one first and fall back to the legacy one.
export async function searchOFF(query: string, opts: { limit?: number } = {}): Promise<FoodHit[]> {
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 25);
  const toHits = (products: any[]) =>
    products
      .filter((p) => p && p.nutriments && (p.nutriments["energy-kcal_100g"] != null || p.nutriments.energy_100g != null))
      .map((p) => {
        const { portions: _p, ingredients: _i, liquid: _l, ...hit } = offHit(p, false);
        return hit;
      });
  let firstErr: unknown;
  try {
    const params = new URLSearchParams({ q: query, page_size: String(limit), fields: OFF_FIELDS });
    const data = await getJson(`https://search.openfoodfacts.org/search?${params}`);
    return toHits(data.hits ?? []);
  } catch (e) {
    firstErr = e;
  }
  try {
    const params = new URLSearchParams({
      search_terms: query, search_simple: "1", action: "process", json: "1",
      page_size: String(limit), sort_by: "unique_scans_n", fields: OFF_FIELDS,
    });
    const data = await getJson(`${OFF}/cgi/search.pl?${params}`);
    return toHits(data.products ?? []);
  } catch (e) {
    throw new Error(`Open Food Facts search unavailable (${String((firstErr as Error)?.message ?? firstErr).slice(0, 80)}; legacy: ${String((e as Error).message).slice(0, 80)})`);
  }
}

export async function getOFFProduct(barcode: string): Promise<FoodDetail | null> {
  const params = new URLSearchParams({ fields: OFF_FIELDS });
  const data = await getJson(`${OFF}/api/v2/product/${encodeURIComponent(barcode)}?${params}`);
  if (!data || data.status !== 1 || !data.product) return null;
  return offHit(data.product, true);
}

// =====================================================================================
// Shared helpers
// =====================================================================================

export async function getFoodDetail(source: FoodSource, id: string, usdaKey?: string): Promise<FoodDetail | null> {
  if (source === "usda") return getUSDAFood(id, usdaKey);
  return getOFFProduct(id);
}

// Resolve "how much" into grams + a MacroFactor Serving object + a human label.
//   grams          → {amount: grams, unit: "grams"}          (or milliliters for liquids)
//   servings [+ portion index/label] → custom {amount, label, weight}
//   nothing        → one label serving if known, else 100 g
export function resolveAmount(
  d: FoodDetail,
  want: { grams?: number; servings?: number; portion?: string },
): { grams: number; serving: Serving; label: string; basis: string } {
  const unit = d.liquid ? "milliliters" : "grams";
  if (want.grams != null && want.grams > 0) {
    return { grams: want.grams, serving: { amount: r1(want.grams), unit }, label: `${r1(want.grams)} ${d.liquid ? "mL" : "g"}`, basis: "grams" };
  }
  let portion: Portion | undefined;
  if (want.portion) {
    const q = want.portion.toLowerCase();
    portion = d.portions.find((p) => p.description.toLowerCase() === q) ?? d.portions.find((p) => p.description.toLowerCase().includes(q));
  }
  portion = portion ?? d.serving ?? d.portions[0];
  if (portion) {
    const n = want.servings != null && want.servings > 0 ? want.servings : 1;
    const grams = r1(portion.grams * n);
    return {
      grams,
      serving: { amount: n, label: portion.description, weight: grams },
      label: `${n} × ${portion.description} (${grams} ${d.liquid ? "mL" : "g"})`,
      basis: "portion",
    };
  }
  const n = want.servings != null && want.servings > 0 ? want.servings : 1;
  const grams = r1(100 * n);
  return { grams, serving: { amount: grams, unit }, label: `${grams} ${d.liquid ? "mL" : "g"}`, basis: "per100" };
}

export function nutrientsFor(d: FoodDetail, grams: number): Nutrients {
  return scaleNutrients(d.per100g, grams / 100);
}

// Keep a compact 8-nutrient view for listings.
export function headline(n: Nutrients): Nutrients {
  return pick(n, HEADLINE_KEYS);
}

export { isNutrientKey, roundNutrient };
