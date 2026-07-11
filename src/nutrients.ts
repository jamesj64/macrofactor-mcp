// MacroFactor "Log by JSON" schema helpers.
// Source of truth: github.com/MacroFactor/apple-shortcuts
//   Nutrition.doccarchive -> MacroFactorFood, Nutrient, Serving
//
// A logged food (MacroFactorFood) requires: icon, name, nutrients, serving, source.
// Nutrient values are grams unless noted below. The food is logged at the CURRENT
// time — there is no date/timestamp field.

export const NUTRIENT_UNITS: Record<string, string> = {
  energy: "kcal",
  // grams
  protein: "g", carbs: "g", fat: "g", fiber: "g", sugars: "g", sugarsAdded: "g",
  saturatedFat: "g", transFat: "g", monounsaturatedFat: "g", polyunsaturatedFat: "g",
  alcohol: "g", water: "g", starch: "g",
  omega3: "g", omega3ALA: "g", omega3EPA: "g", omega3DHA: "g", omega6: "g",
  histidine: "g", isoleucine: "g", leucine: "g", lysine: "g", methionine: "g",
  phenylalanine: "g", threonine: "g", tryptophan: "g", tyrosine: "g", valine: "g", cystine: "g",
  // milligrams
  caffeine: "mg", choline: "mg", cholesterol: "mg",
  vitaminB1: "mg", vitaminB2: "mg", vitaminB3: "mg", vitaminB5: "mg", vitaminB6: "mg",
  vitaminC: "mg", vitaminE: "mg",
  calcium: "mg", copper: "mg", iron: "mg", magnesium: "mg", manganese: "mg",
  phosphorus: "mg", potassium: "mg", sodium: "mg", zinc: "mg",
  // micrograms
  folate: "mcg", vitaminA: "mcg", vitaminB12: "mcg", vitaminD: "mcg", vitaminK: "mcg", selenium: "mcg",
};

// Friendly tool argument name -> MacroFactor nutrient key.
const ARG_TO_KEY: Record<string, string> = {
  calories: "energy",
  protein: "protein",
  carbs: "carbs",
  fat: "fat",
  fiber: "fiber",
  sugar: "sugars",
  sodium_mg: "sodium",
  saturated_fat: "saturatedFat",
  alcohol_g: "alcohol",
  caffeine_mg: "caffeine",
};

export interface LogFoodArgs {
  name: string;
  calories: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  fiber?: number;
  sugar?: number;
  sodium_mg?: number;
  saturated_fat?: number;
  alcohol_g?: number;
  caffeine_mg?: number;
  beverage?: "alcohol" | "beverage";
  llm_prompt?: string;
  brand?: string;
  notes?: string;
}

// Builds the MacroFactorFood JSON object. The caller passes TOTAL nutrients for the
// portion actually eaten, so we log it as a single serving ("one").
export function buildFoodPayload(args: LogFoodArgs): Record<string, unknown> {
  const nutrients: Record<string, number> = {};
  for (const [arg, key] of Object.entries(ARG_TO_KEY)) {
    const v = (args as unknown as Record<string, unknown>)[arg];
    if (typeof v === "number" && !Number.isNaN(v)) nutrients[key] = v;
  }

  const food: Record<string, unknown> = {
    icon: "foodDefault",
    name: args.name,
    nutrients,
    serving: "one",
    source: "claude-macrofactor-mcp",
  };
  if (args.brand) food.brand = args.brand;
  if (args.notes) food.notes = args.notes;
  if (args.beverage) food.beverage = args.beverage;
  if (args.llm_prompt) food.llmPrompt = args.llm_prompt;
  return food;
}

export interface RecipeIngredient {
  name: string;
  calories: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  fiber?: number;
  sugar?: number;
  sodium_mg?: number;
  saturated_fat?: number;
}

// Maps a RecipeIngredient's friendly arg names to MF nutrient keys (same ARG_TO_KEY table
// buildFoodPayload uses). Returns only the keys the caller supplied (finite numbers).
function mapIngredientNutrients(ing: RecipeIngredient): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [arg, key] of Object.entries(ARG_TO_KEY)) {
    const v = (ing as unknown as Record<string, unknown>)[arg];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

// Builds a MacroFactorFood whose nutrients are the SUM of all ingredients, with a recipe[]
// child array attached for MacroFactor's expandable breakdown. Children are { name, nutrients }
// only (no icon/serving/source) to avoid ambiguity about nested-item decoding. SAFE FALLBACK:
// if MacroFactor ignores recipe[] in "Log by JSON", the summed parent macros still log correctly.
// (recipe[] expandable rendering in the MacroFactor UI is unverified.)
export function buildRecipePayload(
  recipeName: string,
  ingredients: RecipeIngredient[],
): Record<string, unknown> {
  const children = ingredients.map((ing) => ({
    name: ing.name,
    nutrients: mapIngredientNutrients(ing),
  }));
  const sum: Record<string, number> = {};
  for (const child of children) {
    for (const [k, v] of Object.entries(child.nutrients)) {
      sum[k] = (sum[k] ?? 0) + v;
    }
  }
  for (const k of Object.keys(sum)) {
    sum[k] = k === "energy" ? Math.round(sum[k]) : Math.round(sum[k] * 10) / 10;
  }
  return {
    icon: "foodDefault",
    name: recipeName,
    nutrients: sum,
    serving: "one",
    source: "claude-macrofactor-mcp",
    recipe: children,
  };
}
