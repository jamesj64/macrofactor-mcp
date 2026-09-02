// Builds MacroFactor "Log by JSON" payloads (MacroFactorFood) from tool arguments.
// Schema source of truth: src/mf-schema.ts (transcribed from github.com/MacroFactor/apple-shortcuts).
//
// A logged food requires: source, icon, name, nutrients, serving. Nutrient values are grams
// unless noted (energy kcal; several mg / mcg). The food is logged at the CURRENT time.

import { z } from "zod";
import {
  BeverageSchema, DEFAULT_ICON, ICON_HINTS, MacroFactorFoodSchema, NUTRIENT_UNITS, NutrientsSchema,
  ServingSchema, cleanNutrients, isIcon, sumNutrients,
  type Icon, type MacroFactorFood, type Nutrients, type Serving,
} from "./mf-schema";

export { NUTRIENT_UNITS };

export const DEFAULT_SOURCE = "claude-macrofactor-mcp";

// Friendly flat tool-argument name -> MacroFactor nutrient key.
const ARG_TO_KEY: Record<string, keyof typeof NUTRIENT_UNITS> = {
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
  // flat convenience fields (all optional; `nutrients` wins on conflict)
  calories?: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  fiber?: number;
  sugar?: number;
  sodium_mg?: number;
  saturated_fat?: number;
  alcohol_g?: number;
  caffeine_mg?: number;
  // full official dictionary
  nutrients?: Record<string, number>;
  serving?: Serving;
  icon?: string;
  brand?: string;
  barcode?: string;
  notes?: string;
  llm_prompt?: string;
  beverage?: "alcohol" | "beverage";
  recipe?: LogFoodArgs[];
  // server-side only (not part of the payload)
  intended_time?: string;
}

export interface BuildOpts {
  source?: string;
}

// ---- zod shapes shared by log_food / log_foods_batch / log_recipe ----

const timeHHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const servingDesc =
  "How much this entry represents. \"one\" (default) = the nutrients are the TOTAL for the portion eaten. " +
  "{amount, unit} = a measured amount (unit: grams|milliliters|ounces|pounds|fluidOuncesUS|cupsUS|tablespoonsUS|teaspoonsUS) " +
  "and the nutrients describe that amount. {amount, label, weight} = a custom serving (e.g. {amount:1, label:\"giant sub\", weight:520}); " +
  "weight is the grams represented, so MacroFactor can rescale later. \"per100Grams\"/\"per100ML\" = nutrients are per 100 g/mL.";

const nutrientsDesc =
  "Full nutrient dictionary keyed by MacroFactor names — energy (kcal); protein, carbs, fat, fiber, sugars, sugarsAdded, " +
  "saturatedFat, transFat, monounsaturatedFat, polyunsaturatedFat, cholesterol(mg), starch, alcohol, water, caffeine(mg) (g unless noted); " +
  "sodium, potassium, calcium, iron, magnesium, phosphorus, zinc, copper, manganese, choline, vitaminB1/B2/B3/B5/B6, vitaminC, vitaminE (mg); " +
  "selenium, folate, vitaminA, vitaminB12, vitaminD, vitaminK (mcg); amino acids (g). Overrides the flat fields when both are given. " +
  "get_food_nutrients returns one ready to paste here.";

export const foodItemShape = {
  name: z.string().min(1).describe("Food title as it should appear in MacroFactor, e.g. \"Jersey Mike's #7 Turkey & Provolone, Giant, no toppings\""),
  calories: z.number().nonnegative().optional().describe("kcal for the entry (required unless nutrients.energy is given)"),
  protein: z.number().nonnegative().optional().describe("grams"),
  carbs: z.number().nonnegative().optional().describe("grams"),
  fat: z.number().nonnegative().optional().describe("grams"),
  fiber: z.number().nonnegative().optional().describe("grams"),
  sugar: z.number().nonnegative().optional().describe("grams"),
  sodium_mg: z.number().nonnegative().optional().describe("milligrams"),
  saturated_fat: z.number().nonnegative().optional().describe("grams"),
  alcohol_g: z.number().nonnegative().optional().describe("grams of ethanol (a standard drink ≈ 14 g US / 10 g AU)"),
  caffeine_mg: z.number().nonnegative().optional().describe("milligrams"),
  nutrients: NutrientsSchema.optional().describe(nutrientsDesc),
  serving: ServingSchema.optional().describe(servingDesc),
  icon: z.string().optional().describe(`MacroFactor icon name shown in the food log. Common: ${ICON_HINTS}. Guessed from the name when omitted; unknown names fall back to foodDefault.`),
  brand: z.string().optional().describe("Manufacturer / restaurant, e.g. \"Jersey Mike's\""),
  barcode: z.string().optional().describe("Packaged-food barcode (UPC/EAN) if known"),
  notes: z.string().optional().describe("Free-text notes stored on the entry — put the component breakdown or source of the numbers here"),
  llm_prompt: z.string().optional().describe("The user's ORIGINAL request verbatim (e.g. \"add jersey mike giant turkey sub no toppings\"). MacroFactor stores it so estimates can be re-analysed later."),
  beverage: BeverageSchema.optional().describe("Tag drinks: 'beverage' (counts toward hydration) or 'alcohol' (alcoholic-drink counter)"),
};

export const recipeChildShape = {
  name: foodItemShape.name,
  calories: foodItemShape.calories,
  protein: foodItemShape.protein,
  carbs: foodItemShape.carbs,
  fat: foodItemShape.fat,
  fiber: foodItemShape.fiber,
  sugar: foodItemShape.sugar,
  sodium_mg: foodItemShape.sodium_mg,
  saturated_fat: foodItemShape.saturated_fat,
  alcohol_g: foodItemShape.alcohol_g,
  caffeine_mg: foodItemShape.caffeine_mg,
  nutrients: foodItemShape.nutrients,
  serving: foodItemShape.serving,
  icon: foodItemShape.icon,
  brand: foodItemShape.brand,
  notes: foodItemShape.notes,
};

export const intendedTimeField = timeHHMM
  .optional()
  .describe("HH:MM (24h) when the food was actually EATEN. MacroFactor always logs at tap-time; this hint corrects nutrient-timing analytics after your next food-log export.");

// ---- icon guessing (only when the caller gives no valid icon) ----

const ICON_GUESSES: [RegExp, Icon][] = [
  [/\b(espresso)\b/i, "coffeeEspresso"], [/\b(cappuccino|latte|flat white)\b/i, "coffeeCappuccino"],
  [/\bcoffee\b/i, "coffee"], [/\b(tea|matcha|chai)\b/i, "tea"], [/\b(beer|ipa|lager|stout)\b/i, "alcoholBeer"],
  [/\b(red wine|merlot|cabernet|pinot noir|shiraz)\b/i, "alcoholWineRed"], [/\b(white wine|chardonnay|sauvignon|riesling|ros[eé])\b/i, "alcoholWineWhite"],
  [/\b(wine)\b/i, "alcoholWineRed"], [/\b(whisk(e)?y|bourbon|scotch)\b/i, "alcoholWhiskey"],
  [/\b(vodka|gin|rum|tequila|spirit)\b/i, "alcoholSpirit"], [/\b(cocktail|margarita|mojito|martini)\b/i, "alcoholCocktail"],
  [/\b(soda|cola|coke|pepsi|sprite|dr pepper)\b/i, "soda"], [/\b(orange juice|oj)\b/i, "juiceOrange"],
  [/\b(apple juice)\b/i, "juiceApple"], [/\b(lemonade)\b/i, "juiceLemonade"], [/\b(juice)\b/i, "juiceOrange"],
  [/\b(milkshake|protein shake|shake|smoothie)\b/i, "milkshake"], [/\b(soy milk)\b/i, "milkSoy"],
  [/\b(milk)\b/i, "milk"], [/\b(kefir)\b/i, "kefir"], [/\b(water)\b/i, "water"],
  [/\b(bacon)\b/i, "bacon"], [/\b(sausage|bratwurst|chorizo)\b/i, "sausage"], [/\b(hot ?dog)\b/i, "hotDogInBunMustard"],
  [/\b(cheeseburger|double cheeseburger)\b/i, "burgerCheesePattyLettuceTomato"], [/\b(burger)\b/i, "burgerSesameSeedRoundBun"],
  [/\b(pizza)\b/i, "pizzaPepperoni"], [/\b(sub|sandwich|hoagie|baguette|panini|wrap)\b/i, "breadBaguette"],
  [/\b(bagel)\b/i, "bagel"], [/\b(croissant)\b/i, "croissant"], [/\b(toast)\b/i, "toast"], [/\b(pita|naan|flatbread)\b/i, "breadPita"],
  [/\b(bread|roll|bun)\b/i, "breadWheatTwoSlices"], [/\b(burrito|taco|enchilada|quesadilla)\b/i, "burritoSoftTacoChilis"],
  [/\b(sushi|maki|nigiri)\b/i, "sushi"], [/\b(ramen)\b/i, "soupRamenPork"], [/\b(pho|soup|broth|chowder|stew)\b/i, "soupBowl"],
  [/\b(spaghetti|pasta|penne|linguine|fettuccine|bolognese)\b/i, "spaghettiRedSauce"], [/\b(lasagn[ae])\b/i, "lasagne"],
  [/\b(ravioli|tortellini)\b/i, "ravioli"], [/\b(mac and cheese|mac & cheese|macaroni)\b/i, "macAndCheese"],
  [/\b(fried rice|stir[- ]?fry)\b/i, "wokStirFry"], [/\b(brown rice)\b/i, "riceBrownBowl"], [/\b(rice)\b/i, "riceWhiteBowl"],
  [/\b(oatmeal|oats|porridge)\b/i, "oatmeal"], [/\b(overnight oats)\b/i, "overnightOats"], [/\b(cereal|granola)\b/i, "milkCerealBlueBowl"],
  [/\b(pancake)/i, "pancakesStack"], [/\b(waffle)/i, "waffles"], [/\b(omelet)/i, "omelette"], [/\b(eggs?)\b/i, "eggs"],
  [/\b(salad|greens)\b/i, "saladBowl"], [/\b(yogurt|yoghurt|skyr)\b/i, "yogurt"], [/\b(cottage cheese)\b/i, "cottageCheese"],
  [/\b(cheese)\b/i, "cheeseSlice"], [/\b(butter)\b/i, "butter"], [/\b(peanut butter|almond butter)\b/i, "peanutButter"],
  [/\b(grilled chicken|chicken breast)\b/i, "chickenGrilled"], [/\b(nugget)/i, "chickenNuggetsBBQSauce"], [/\b(wing)/i, "chickenWings"],
  [/\b(chicken)\b/i, "chicken"], [/\b(turkey)\b/i, "turkey"], [/\b(duck)\b/i, "duck"], [/\b(salmon)\b/i, "salmonFilet"],
  [/\b(tuna|sashimi)\b/i, "sashimiTuna"], [/\b(shrimp|prawn)\b/i, "shrimp"], [/\b(crab)\b/i, "crab"], [/\b(lobster)\b/i, "lobster"],
  [/\b(fish|cod|tilapia|halibut|trout)\b/i, "fish"], [/\b(ribs?)\b/i, "ribs"], [/\b(steak|ribeye|sirloin|filet)\b/i, "steakPlate"],
  [/\b(beef|ground beef|brisket)\b/i, "steakPlate"], [/\b(meatball)/i, "meatballs"], [/\b(meatloaf)/i, "meatLoaf"],
  [/\b(pork|ham|tenderloin)\b/i, "porkLoin"], [/\b(salami|pepperoni)\b/i, "salami"], [/\b(jerky)\b/i, "jerkyBeef"],
  [/\b(falafel)\b/i, "falafel"], [/\b(hummus)\b/i, "hummus"], [/\b(lentil|dal|dahl)\b/i, "lentils"], [/\b(beans?|chili)\b/i, "beansPan"],
  [/\b(tofu|edamame)\b/i, "sproutedMungBean"], [/\b(avocado|guac)/i, "avocado"], [/\b(guacamole)\b/i, "guacamole"],
  [/\b(fries|french fries|chips)\b/i, "frenchFries"], [/\b(potato chips|crisps)\b/i, "chipsPotato"], [/\b(sweet potato)\b/i, "potatoesRedSweet"],
  [/\b(potato|mash)/i, "potato"], [/\b(broccoli)\b/i, "broccoli"], [/\b(carrot)/i, "carrot"], [/\b(corn)\b/i, "corn"],
  [/\b(spinach|kale|chard|lettuce)\b/i, "lettuce"], [/\b(veg|vegetable|veggies)/i, "vegetables"], [/\b(mushroom)/i, "mushroom"],
  [/\b(tomato)/i, "tomato"], [/\b(cucumber)\b/i, "cucumber"], [/\b(onion)\b/i, "onion"], [/\b(garlic)\b/i, "garlic"],
  [/\b(banana)/i, "bananas"], [/\b(apple)\b/i, "apple"], [/\b(orange|clementine|mandarin)\b/i, "orange"], [/\b(grape)/i, "grapesRed"],
  [/\b(strawberr)/i, "strawberry"], [/\b(blueberr)/i, "blueberries"], [/\b(raspberr)/i, "raspberry"], [/\b(cherr)/i, "cherries"],
  [/\b(mango)\b/i, "mango"], [/\b(pineapple)\b/i, "pineapple"], [/\b(watermelon)\b/i, "watermelon"], [/\b(melon|cantaloupe)\b/i, "cantaloupe"],
  [/\b(peach|nectarine)\b/i, "peach"], [/\b(pear)\b/i, "pear"], [/\b(kiwi)\b/i, "kiwi"], [/\b(fruit)\b/i, "fruitSalad"],
  [/\b(almond)/i, "almond"], [/\b(walnut)/i, "walnut"], [/\b(cashew)/i, "cashews"], [/\b(pistachio)/i, "pistachio"],
  [/\b(peanut)/i, "peanut"], [/\b(nuts?|trail mix)\b/i, "nutsMixed"], [/\b(popcorn)\b/i, "popcorn"], [/\b(pretzel)/i, "pretzel"],
  [/\b(chocolate bar|snickers|kitkat|kit kat|twix)\b/i, "candyBar"], [/\b(chocolate|cocoa)\b/i, "chocolateBars"],
  [/\b(candy|gummy|gummies|sweets|lollies)\b/i, "gummyBears"], [/\b(cookie|biscuit|oreo)/i, "biscuit"],
  [/\b(brownie)\b/i, "cakeSquareChocolate"], [/\b(cheesecake)\b/i, "cakeSliceCheesecake"], [/\b(cake)\b/i, "cakeSliceChocolateCherry"],
  [/\b(cupcake)\b/i, "cupcakeChocolate"], [/\b(muffin)\b/i, "muffin"], [/\b(donut|doughnut)\b/i, "doughnut"],
  [/\b(cinnamon roll)\b/i, "cinnamonRoll"], [/\b(pie)\b/i, "pie"], [/\b(ice cream|gelato|sundae)\b/i, "iceCreamSundae"],
  [/\b(frozen yogurt|froyo|soft serve)\b/i, "softServeChocolateSwirls"], [/\b(honey)\b/i, "honey"], [/\b(maple syrup|syrup)\b/i, "mapleSyrup"],
  [/\b(jam|jelly|preserves)\b/i, "jamRed"], [/\b(ketchup)\b/i, "ketchup"], [/\b(mustard)\b/i, "mustard"], [/\b(mayo|mayonnaise|aioli)\b/i, "mayo"],
  [/\b(bbq|barbecue)\b/i, "sauceBBQWorcestershire"], [/\b(salsa)\b/i, "salsa"], [/\b(gravy)\b/i, "gravy"], [/\b(sour cream)\b/i, "sourCream"],
  [/\b(olive oil|oil)\b/i, "oil"], [/\b(olive)/i, "oliveGreen"], [/\b(sugar)\b/i, "sugarWhite"], [/\b(gum)\b/i, "mintGum"],
  [/\b(pop[- ]?tart)/i, "popTarts"], [/\b(cracker)/i, "crackersDigestives"], [/\b(bar)\b/i, "candyBar"],
];

export function guessIcon(name: string, beverage?: string): Icon {
  for (const [re, icon] of ICON_GUESSES) if (re.test(name)) return icon;
  if (beverage === "alcohol") return "alcoholCocktail";
  if (beverage === "beverage") return "water";
  return DEFAULT_ICON;
}

// Merge the flat convenience fields with the official dictionary (dictionary wins).
export function collectNutrients(args: LogFoodArgs): Nutrients {
  const merged: Record<string, number> = {};
  for (const [arg, key] of Object.entries(ARG_TO_KEY)) {
    const v = (args as unknown as Record<string, unknown>)[arg];
    if (typeof v === "number" && Number.isFinite(v)) merged[key] = v;
  }
  if (args.nutrients) {
    for (const [k, v] of Object.entries(args.nutrients)) if (typeof v === "number" && Number.isFinite(v)) merged[k] = v;
  }
  return cleanNutrients(merged);
}

// Builds the MacroFactorFood JSON object. With serving "one" (default) the nutrients are the
// TOTAL for the portion eaten; with a measured/custom serving they describe that amount.
export function buildFoodPayload(args: LogFoodArgs, opts: BuildOpts = {}): MacroFactorFood {
  let nutrients = collectNutrients(args);
  let children: MacroFactorFood[] | undefined;
  if (args.recipe && args.recipe.length) {
    children = args.recipe.map((c) => buildFoodPayload({ ...c, recipe: undefined }, opts));
    // Parent nutrients must equal the sum of the children; derive them when the caller gave none.
    if (nutrients.energy == null) nutrients = sumNutrients(children.map((c) => c.nutrients));
  }
  const icon: Icon = args.icon && isIcon(args.icon) ? args.icon : guessIcon(args.name, args.beverage);
  const food: MacroFactorFood = {
    source: opts.source || DEFAULT_SOURCE,
    icon,
    name: args.name.trim(),
    nutrients,
    serving: args.serving ?? "one",
  };
  if (args.brand) food.brand = args.brand.trim();
  if (args.barcode) food.barcode = String(args.barcode).trim();
  if (args.notes) food.notes = args.notes;
  if (args.beverage) food.beverage = args.beverage;
  if (args.llm_prompt) food.llmPrompt = args.llm_prompt;
  if (children) food.recipe = children;
  return food;
}

export type RecipeIngredient = LogFoodArgs;

// A recipe is just a food whose nutrients are the SUM of its recipe[] children. Each child is a
// complete MacroFactorFood (the official schema types recipe as [MacroFactorFood], and Swift's
// decoder rejects the WHOLE payload if a child lacks a required field).
export function buildRecipePayload(
  recipeName: string,
  ingredients: RecipeIngredient[],
  extra: Partial<LogFoodArgs> = {},
  opts: BuildOpts = {},
): MacroFactorFood {
  return buildFoodPayload({ ...extra, name: recipeName, recipe: ingredients, calories: undefined, nutrients: undefined }, opts);
}

// Throws with a readable message if a payload would be rejected by the app's decoder.
export function validateFoodPayload(food: unknown): MacroFactorFood {
  const r = MacroFactorFoodSchema.safeParse(food);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`invalid MacroFactorFood payload — ${issues}`);
  }
  if (r.data.nutrients.energy == null) throw new Error("invalid MacroFactorFood payload — nutrients.energy (kcal) is required");
  return r.data;
}

// One-line macro summary for tool replies.
export function macroSummary(n: Nutrients): string {
  const parts = [`${n.energy ?? 0} kcal`];
  if (n.protein != null) parts.push(`${n.protein}g P`);
  if (n.carbs != null) parts.push(`${n.carbs}g C`);
  if (n.fat != null) parts.push(`${n.fat}g F`);
  return parts.join(", ");
}
