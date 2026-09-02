// MacroFactor "Log by JSON" schema — transcribed from the official Swift package at
// github.com/MacroFactor/apple-shortcuts (Sources/Nutrition/*.swift). Keep in sync with upstream.
//
//   MacroFactorFood  { source, icon, name, nutrients, serving, llmPrompt?, barcode?, brand?,
//                      beverage?, notes?, recipe?: [MacroFactorFood] }
//   Nutrient         keys below; grams unless noted (energy kcal; some mg / mcg)
//   Serving          "one" | "per100Grams" | "per100ML" | {amount, unit} | {amount, label, weight}
//   Beverage         "beverage" | "alcohol"
//   Icon             one of ICONS (unknown values decode as foodDefault)
//
// The action logs at the CURRENT time — there is no date/timestamp field.

import { z } from "zod";

// ---- Nutrient keys + units (Properties/Nutrient.swift) ----
export const NUTRIENT_UNITS = {
  energy: "kcal",
  // grams
  protein: "g", carbs: "g", fat: "g", fiber: "g", sugars: "g", sugarsAdded: "g", starch: "g",
  saturatedFat: "g", transFat: "g", monounsaturatedFat: "g", polyunsaturatedFat: "g",
  omega3: "g", omega3ALA: "g", omega3EPA: "g", omega3DHA: "g", omega6: "g",
  alcohol: "g", water: "g",
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
} as const;

export type NutrientKey = keyof typeof NUTRIENT_UNITS;
export type NutrientUnit = (typeof NUTRIENT_UNITS)[NutrientKey];
export type Nutrients = Partial<Record<NutrientKey, number>>;
export const NUTRIENT_KEYS = Object.keys(NUTRIENT_UNITS) as NutrientKey[];
export const isNutrientKey = (k: string): k is NutrientKey => Object.prototype.hasOwnProperty.call(NUTRIENT_UNITS, k);

// The eight nutrients worth showing in compact search results.
export const HEADLINE_KEYS: NutrientKey[] = ["energy", "protein", "carbs", "fat", "fiber", "sugars", "sodium", "saturatedFat"];

// ---- Icons (Properties/Icon.swift). Unknown strings decode as foodDefault in the app. ----
export const ICONS = [
  "water", "coffee", "coffeeCappuccino", "coffeeEspresso", "coffeeIceWhip", "creamer", "juiceApple",
  "juiceLemonade", "juiceOrange", "juiceTomato", "juiceWatermelon", "kefir", "milk", "milkshakeTwoFlavors",
  "milkSoy", "milkRice", "milkshake", "soda", "tea", "teaFruitLemon", "teaFruitOrange", "alcoholBeer",
  "alcoholCocktail", "alcoholLiqueur", "alcoholMassProducedFruity", "alcoholSpirit", "alcoholWhiskey",
  "alcoholWineRed", "alcoholWineWhite", "foodDefault", "plateQuickAdd", "acorn", "almond", "apple", "appleRed",
  "appleSauceBowl", "appleSauceJar", "artichoke", "asparagus", "avocado", "babyMilk", "bacon", "bagel",
  "bagSnackJunkFood", "bakingPan", "bananas", "baoziXiaoLongBao", "beansPan", "beefTarTar", "bellPepperGreen",
  "bellPepperRed", "bellPepperYellow", "biryani", "biscotti", "biscuit", "blueberries", "blueberry",
  "bokChoyXiaoBaiCai", "bowlChopSticks", "breadBaguette", "breadLoafMultigrain", "breadLoafWheat",
  "breadMultigrainTwoSlices", "breadPita", "breadRyeTwoSlicesWithSpread", "breadWheatTwoSlices", "broccoli",
  "burdockRoot", "burgerCheesePattyLettuceTomato", "burgerSesameSeedRoundBun",
  "burgerSesameSeedRoundBunLettuceKetchup", "burgerSquareBreadBunLettuceKetchup", "burritoEnchiladaRollBrown",
  "burritoEnchiladaRollGreen", "burritoEnchiladaRollOrange", "burritoSoftTacoChilis", "butter",
  "butterCrustPastriesSmall", "butterCrustPastryLarge", "butterPlate", "butterPlatePale", "cabbage", "cabbageHead",
  "cakeSliceCheesecake", "cakeSliceChocolateCherry", "cakeSquareChocolate", "cakeSquares", "calzone", "candy",
  "candyBar", "candyToffee", "cannedGoods", "cantaloupe", "carrot", "cashews", "casserole", "cauliflower", "celery",
  "chard", "cheeseSlice", "cheeseString", "cheeseWheel", "cherries", "chestnut", "chicken", "chickenGrilled",
  "chickenNuggetsBBQSauce", "chickenWings", "chiliPeppersGreen", "chiliPeppersRed", "chiliPeppersRedYellow",
  "chipsBaked", "chipsBakedSeasoned", "chipsPotato", "chirashiBowlSushi", "chocolateBars", "chocolateChips",
  "chocolateHotDrinkWhipCream", "chocolateKiss", "cinnamon", "cinnamonRoll", "cocoa", "coconut", "congee", "corn",
  "cottageCheese", "crab", "crackersDigestives", "cranberries", "croissant", "croutons", "cucumber",
  "cupcakeChocolate", "daikon", "dairyIceCream", "date", "deer", "dill", "dinnerRolls",
  "doubleCheeseBurgerSesameSeedRoundBun", "doughnut", "drySpicesBrown", "drySpicesGreen", "drySpicesOlive",
  "drySpicesRed", "drySpicesYellow", "duck", "egg", "eggDeviled", "eggplant", "eggs", "eggTartDanTa", "falafel",
  "fig", "figNewtons", "fish", "frenchFries", "fruitSalad", "garlic", "garlicRoasted", "ginger", "grapefruit",
  "grapesGreen", "grapesRed", "gravy", "greenBeans", "greenBeansFive", "greenOnion", "guacamole", "guava",
  "gummyBears", "honey", "hotDogInBunMustard", "hotDogs", "hummus", "iceCreamDrumstickChocolate",
  "iceCreamDrumstickStrawberry", "iceCreamSandwich", "iceCreamSugarCone", "iceCreamSundae", "jamApricot",
  "jamMarmalade", "jamRed", "jar", "jarOrangeLarge", "jello", "jelloCake", "jerkyBeef", "kaiserRoll", "ketchup",
  "kiwi", "lasagne", "lemon", "lentils", "lettuce", "lettuceHead", "lime", "lobster", "lychee", "macadamiaNut",
  "macAndCheese", "mango", "mapleSyrup", "marshmallow", "mayo", "mayoSqueezeBottle",
  "mealPlateFullEnglishBreakfast", "mealPlateSteakPotatoesVeggies", "mealWaterGlassRice", "meatballs", "meatLoaf",
  "meatLoafPan", "melonHoneydew", "milkCerealBlueBowl", "milkCerealYellowBowl", "mintGum", "muffin", "muffinNuts",
  "mushroom", "mustard", "nut", "nutBrazil", "nutsMixed", "oatmeal", "octopus", "oil", "oliveBlack", "oliveGreen",
  "omelette", "omeletteWithMeat", "onion", "onionRed", "orange", "oreos", "oshirukoZenzaiAdzukiRedBean",
  "overnightOats", "oyster", "pancake", "pancakesStack", "parsley", "peach", "peanut", "peanutButter", "pear",
  "pearAsian", "pearBosc", "pecan", "persimmon", "pie", "pieLatticeCrust", "pineapple", "pineNut", "pistachio",
  "pizzaPepperoni", "pizzaPepperoniMushroom", "plum", "pomegranate", "popcorn", "popTarts", "porkLoin",
  "porkLoinWithDarkRub", "potato", "potatoesPurple", "potatoesRedSweet", "potatoesWhiteRusset", "potatoRed",
  "potPie", "pretzel", "pretzelSticks", "prune", "pumpkin", "pumpkinSeed", "radishes", "raisins", "raspberry",
  "ravioli", "rhubarb", "ribs", "riceBrownBowl", "riceCake", "riceWhiteBowl", "saladBowl", "saladEggsTomatoes",
  "saladPlate", "salami", "salmonFilet", "salsa", "sashimiTuna", "sauceBBQWorcestershire", "sausage", "scallops",
  "seaweedSalad", "shallot", "shrimp", "sloppyJoe", "snowPeas", "softServeChocolateSwirls", "soup", "soupBowl",
  "soupBowlCongee", "soupGreen", "soupPea", "soupRamenPork", "soupRamenRed", "soupRedTomato", "sourCream",
  "spaghettiRedSauce", "spam", "spicesGround", "sproutedMungBean", "squashAcorn", "squid", "starfruit",
  "steakBoneIn", "steakPlate", "steakRaw", "stewPot", "strawberry", "sugarBrownCubes", "sugarWhite",
  "sugarWhiteCubes", "sunflowerSeeds", "sushi", "toast", "tomato", "tostadaLahmacun", "turkey", "turkeyRoast",
  "turnip", "turnover", "vegetables", "waffles", "walnut", "watercress", "watermelon", "wheat", "wheatFlat",
  "wokStirFry", "yogurt", "zucchini",
] as const;
export type Icon = (typeof ICONS)[number];
export const DEFAULT_ICON: Icon = "foodDefault";
const ICON_SET = new Set<string>(ICONS);
export const isIcon = (s: string): s is Icon => ICON_SET.has(s);

// Short list for tool descriptions — the agent can pass any ICONS value, this is just a nudge.
export const ICON_HINTS =
  "chicken, chickenGrilled, turkey, steakPlate, salmonFilet, fish, shrimp, egg, eggs, bacon, sausage, " +
  "burgerCheesePattyLettuceTomato, pizzaPepperoni, breadBaguette, toast, bagel, croissant, " +
  "burritoSoftTacoChilis, sushi, spaghettiRedSauce, riceWhiteBowl, oatmeal, saladBowl, soupBowl, " +
  "yogurt, cheeseSlice, milk, coffee, tea, soda, juiceOrange, alcoholBeer, alcoholWineRed, " +
  "apple, bananas, avocado, potato, frenchFries, broccoli, vegetables, nutsMixed, peanutButter, " +
  "chocolateBars, cakeSquareChocolate, iceCreamSundae, candy, chipsPotato, popcorn, water, foodDefault";

// ---- Serving (Properties/Serving.swift) ----
export const SERVING_UNITS = [
  "grams", "pounds", "ounces", "fluidOuncesUS", "milliliters", "cupsUS", "tablespoonsUS", "teaspoonsUS",
] as const;
export type ServingUnit = (typeof SERVING_UNITS)[number];

export const MeasuredServingSchema = z
  .object({ amount: z.number().positive(), unit: z.enum(SERVING_UNITS) })
  .strict();
// "weight" = grams represented by this serving (amount × label) — MacroFactor uses it to rescale later.
export const CustomServingSchema = z
  .object({ amount: z.number().positive(), label: z.string().min(1), weight: z.number().positive() })
  .strict();
export const ServingSchema = z.union([
  z.literal("one"),
  z.literal("per100Grams"),
  z.literal("per100ML"),
  MeasuredServingSchema,
  CustomServingSchema,
]);
export type Serving = z.infer<typeof ServingSchema>;

export const BeverageSchema = z.enum(["beverage", "alcohol"]);
export type Beverage = z.infer<typeof BeverageSchema>;

// A nutrient dictionary keyed by official names. Unknown keys are rejected (the app would
// silently drop them, which is worse than a loud error here).
export const NutrientsSchema = z.record(z.string(), z.number()).superRefine((obj, ctx) => {
  for (const k of Object.keys(obj)) {
    if (!isNutrientKey(k)) {
      ctx.addIssue({ code: "custom", message: `unknown nutrient key "${k}" — use one of: ${NUTRIENT_KEYS.join(", ")}` });
    }
  }
});

export interface MacroFactorFood {
  source: string;
  icon: Icon;
  name: string;
  nutrients: Nutrients;
  serving: Serving;
  llmPrompt?: string;
  barcode?: string;
  brand?: string;
  beverage?: Beverage;
  notes?: string;
  recipe?: MacroFactorFood[];
}

// Full validator for an outgoing Log by JSON payload (used by tests and by /pending-all as a
// last line of defence — a malformed child would make the Swift decoder reject the WHOLE food).
export const MacroFactorFoodSchema: z.ZodType<MacroFactorFood> = z.lazy(() =>
  z
    .object({
      source: z.string().min(1),
      icon: z.enum(ICONS),
      name: z.string().min(1),
      nutrients: NutrientsSchema,
      serving: ServingSchema,
      llmPrompt: z.string().optional(),
      barcode: z.string().optional(),
      brand: z.string().optional(),
      beverage: BeverageSchema.optional(),
      notes: z.string().optional(),
      recipe: z.array(MacroFactorFoodSchema).optional(),
    })
    .strict(),
) as z.ZodType<MacroFactorFood>;

// ---- Today summary (Sources/Nutrition/MacroFactorTodaySummary.swift) ----
//   { consumed: { <nutrient>: number }, remaining: { <nutrient>: { minimum?, target?, maximum? } } }
// Returned by every MacroFactor Shortcuts action (incl. Log by JSON). Negative remaining = goal surpassed.
export interface GoalConsumptionRemaining { minimum?: number | null; target?: number | null; maximum?: number | null }
export interface MacroFactorTodaySummary {
  consumed: Partial<Record<NutrientKey, number>>;
  remaining: Partial<Record<NutrientKey, GoalConsumptionRemaining>>;
}

// Round a nutrient value to a sensible precision for its unit.
export function roundNutrient(key: NutrientKey, v: number): number {
  const u = NUTRIENT_UNITS[key];
  if (u === "kcal") return Math.round(v);
  if (u === "g") return Math.round(v * 100) / 100;
  return Math.round(v * 10) / 10; // mg / mcg
}

// Drop non-finite / negative values and unknown keys; round the rest.
export function cleanNutrients(input: Record<string, unknown> | undefined | null): Nutrients {
  const out: Nutrients = {};
  if (!input) return out;
  for (const [k, v] of Object.entries(input)) {
    if (!isNutrientKey(k)) continue;
    const n = typeof v === "number" ? v : parseFloat(String(v));
    if (!Number.isFinite(n) || n < 0) continue;
    out[k] = roundNutrient(k, n);
  }
  return out;
}

// Multiply every nutrient by `factor` (e.g. grams/100 for per-100 g data).
export function scaleNutrients(n: Nutrients, factor: number): Nutrients {
  const out: Nutrients = {};
  for (const [k, v] of Object.entries(n) as [NutrientKey, number][]) {
    if (v == null) continue;
    out[k] = roundNutrient(k, v * factor);
  }
  return out;
}

export function sumNutrients(list: Nutrients[]): Nutrients {
  const acc: Record<string, number> = {};
  for (const n of list) for (const [k, v] of Object.entries(n)) if (v != null) acc[k] = (acc[k] ?? 0) + v;
  return cleanNutrients(acc);
}
