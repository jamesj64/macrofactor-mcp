// Validates that what we send to MacroFactor's "Log by JSON" action matches the official schema
// (github.com/MacroFactor/apple-shortcuts) — including the sample payloads from its test suite.
import { describe, expect, it } from "vitest";
import {
  ICONS, MacroFactorFoodSchema, NUTRIENT_KEYS, NUTRIENT_UNITS, ServingSchema, cleanNutrients, scaleNutrients, sumNutrients,
} from "../src/mf-schema";
import { buildFoodPayload, buildRecipePayload, collectNutrients, guessIcon, validateFoodPayload } from "../src/nutrients";

// Verbatim from Tests/NutritionTests/Samples/JsonSamplesFood.swift (trailing commas removed).
const OFFICIAL_SAMPLES = [
  {
    icon: "coffeeEspresso",
    name: "Morning Coffee",
    nutrients: { caffeine: 30, water: 36 },
    serving: "one",
    source: "my-shot-logger",
  },
  {
    barcode: "123456789",
    beverage: "beverage",
    brand: "Finca Monteblanco",
    icon: "coffeeEspresso",
    llmPrompt: "light roast turbo espresso shot",
    name: "Purple Caturra Washed, Extractamundo Dos",
    notes: "Not fruity enough. Loosen grind, charge roast hotter.",
    nutrients: { caffeine: 30, water: 36 },
    serving: { amount: 1, label: "pull", weight: 40 },
    source: "my-shot-logger",
  },
  {
    barcode: "123456789",
    beverage: "beverage",
    brand: "Finca Monteblanco",
    icon: "coffeeEspresso",
    llmPrompt: "light roast turbo espresso shot",
    name: "Purple Caturra Washed, Extractamundo Dos",
    notes: "Not fruity enough. Loosen grind, charge roast hotter.",
    nutrients: { caffeine: 30, water: 36 },
    serving: { amount: 40, unit: "grams" },
    source: "my-shot-logger",
  },
];

const OFFICIAL_KEYS = ["barcode", "beverage", "brand", "icon", "llmPrompt", "name", "notes", "nutrients", "recipe", "serving", "source"];

// Every nutrient key from the official Nutrient.swift table.
const OFFICIAL_NUTRIENTS = [
  "energy", "carbs", "fat", "protein", "alcohol", "caffeine", "water", "cholesterol", "choline", "cystine", "histidine",
  "isoleucine", "leucine", "lysine", "methionine", "phenylalanine", "threonine", "tryptophan", "tyrosine", "valine", "fiber",
  "starch", "sugars", "sugarsAdded", "monounsaturatedFat", "polyunsaturatedFat", "saturatedFat", "transFat", "omega3",
  "omega3ALA", "omega3EPA", "omega3DHA", "omega6", "folate", "vitaminA", "vitaminB1", "vitaminB2", "vitaminB3", "vitaminB5",
  "vitaminB6", "vitaminB12", "vitaminC", "vitaminD", "vitaminE", "vitaminK", "calcium", "copper", "iron", "magnesium",
  "manganese", "phosphorus", "potassium", "selenium", "sodium", "zinc",
];

describe("official schema transcription", () => {
  it("accepts every official sample payload", () => {
    for (const s of OFFICIAL_SAMPLES) expect(MacroFactorFoodSchema.safeParse(s).success, JSON.stringify(s)).toBe(true);
  });
  it("knows exactly the official nutrient keys", () => {
    expect([...NUTRIENT_KEYS].sort()).toEqual([...OFFICIAL_NUTRIENTS].sort());
    expect(NUTRIENT_UNITS.energy).toBe("kcal");
    expect(NUTRIENT_UNITS.sodium).toBe("mg");
    expect(NUTRIENT_UNITS.vitaminD).toBe("mcg");
  });
  it("has the fallback icon and the 300+ icon names", () => {
    expect(ICONS).toContain("foodDefault");
    expect(ICONS.length).toBeGreaterThan(300);
    expect(new Set(ICONS).size).toBe(ICONS.length);
  });
  it("encodes servings like the Swift enum", () => {
    for (const v of ["one", "per100Grams", "per100ML", { amount: 150, unit: "grams" }, { amount: 2, label: "handfuls", weight: 100 }]) {
      expect(ServingSchema.safeParse(v).success, JSON.stringify(v)).toBe(true);
    }
    for (const v of ["two", { amount: 1 }, { amount: 1, unit: "cups" }, { amount: 1, label: "x" }]) {
      expect(ServingSchema.safeParse(v).success, JSON.stringify(v)).toBe(false);
    }
  });
  it("rejects unknown nutrient keys and unknown top-level keys", () => {
    expect(MacroFactorFoodSchema.safeParse({ ...OFFICIAL_SAMPLES[0], nutrients: { calories: 5 } }).success).toBe(false);
    expect(MacroFactorFoodSchema.safeParse({ ...OFFICIAL_SAMPLES[0], _pending_id: 1 }).success).toBe(false);
  });
});

describe("buildFoodPayload", () => {
  it("emits only official keys, a valid icon, and a source", () => {
    const p = buildFoodPayload({
      name: "Jersey Mike's #7 Turkey & Provolone Sub, Giant, no toppings",
      brand: "Jersey Mike's",
      calories: 1010, protein: 62, carbs: 118, fat: 30, fiber: 6, sugar: 12, sodium_mg: 2900, saturated_fat: 12,
      serving: { amount: 1, label: "giant sub", weight: 540 },
      notes: "bread + turkey + provolone from jerseymikes.com nutrition, no Mike's Way toppings",
      llm_prompt: "add jersey mike giant turkey sub no toppings",
      intended_time: "12:30",
    });
    expect(Object.keys(p).every((k) => OFFICIAL_KEYS.includes(k))).toBe(true);
    expect(p.source).toBe("claude-macrofactor-mcp");
    expect(p.icon).toBe("breadBaguette"); // "sub" rule outranks "turkey"
    expect(p.nutrients).toEqual({ energy: 1010, protein: 62, carbs: 118, fat: 30, fiber: 6, sugars: 12, sodium: 2900, saturatedFat: 12 });
    expect(p.serving).toEqual({ amount: 1, label: "giant sub", weight: 540 });
    expect(p.llmPrompt).toBe("add jersey mike giant turkey sub no toppings");
    expect((p as any).intended_time).toBeUndefined();
    expect(validateFoodPayload(p)).toEqual(p);
  });

  it("lets the nutrients dictionary override flat fields and validates keys", () => {
    const n = collectNutrients({ name: "x", calories: 100, protein: 5, nutrients: { energy: 120, vitaminC: 12.34 } });
    expect(n).toEqual({ energy: 120, protein: 5, vitaminC: 12.3 });
    expect(() => validateFoodPayload(buildFoodPayload({ name: "x", nutrients: { bogus: 1 } as any }))).toThrow(/energy|bogus/);
  });

  it("requires energy", () => {
    expect(() => validateFoodPayload(buildFoodPayload({ name: "x", protein: 10 }))).toThrow(/energy/);
  });

  it("falls back to foodDefault for unknown icons and uses the MF_SOURCE override", () => {
    const p = buildFoodPayload({ name: "mystery thing", calories: 1, icon: "notAnIcon" }, { source: "my-source" });
    expect(p.icon).toBe("foodDefault");
    expect(p.source).toBe("my-source");
  });

  it("guesses sensible icons", () => {
    expect(guessIcon("Grilled chicken breast")).toBe("chickenGrilled");
    expect(guessIcon("Flat white")).toBe("coffeeCappuccino");
    expect(guessIcon("IPA")).toBe("alcoholBeer");
    expect(guessIcon("Protein shake")).toBe("milkshake");
    expect(guessIcon("zzz", "alcohol")).toBe("alcoholCocktail");
  });
});

describe("recipes", () => {
  it("builds complete children and sums the parent", () => {
    const p = buildRecipePayload("Turkey sub", [
      { name: "Bread", calories: 400, protein: 14, carbs: 78, fat: 4 },
      { name: "Turkey", calories: 300, protein: 40, carbs: 4, fat: 10, icon: "turkey" },
      { name: "Provolone", calories: 200, protein: 14, carbs: 2, fat: 16 },
    ]);
    expect(p.nutrients).toEqual({ energy: 900, protein: 68, carbs: 84, fat: 30 });
    expect(p.recipe).toHaveLength(3);
    // Every child must itself be a complete MacroFactorFood (Swift decoding is all-or-nothing).
    for (const c of p.recipe!) {
      expect(c.source).toBeTruthy();
      expect(c.serving).toBe("one");
      expect(ICONS).toContain(c.icon);
    }
    expect(p.recipe![1].icon).toBe("turkey");
    expect(MacroFactorFoodSchema.safeParse(p).success).toBe(true);
  });
});

describe("nutrient math", () => {
  it("scales and sums with unit-aware rounding", () => {
    expect(scaleNutrients({ energy: 165, protein: 31, sodium: 74 }, 1.5)).toEqual({ energy: 248, protein: 46.5, sodium: 111 });
    expect(sumNutrients([{ energy: 1.4, fat: 0.333 }, { energy: 1.4, fat: 0.333 }])).toEqual({ energy: 3, fat: 0.67 });
    expect(cleanNutrients({ energy: -1, protein: NaN, carbs: "12.345" as any, nope: 3 })).toEqual({ carbs: 12.35 });
  });
});
