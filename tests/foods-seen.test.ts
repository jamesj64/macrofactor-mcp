import { describe, expect, it } from "vitest";
import { parseFoodsSeen, toLocalHHMM } from "../src/db/today";
import { setUserTz } from "../src/db/utils";

setUserTz("America/Los_Angeles");

describe("foods-seen parsing", () => {
  it("parses pipe-delimited lines from the MF Nightly Text action", () => {
    const body = [
      "Greek yogurt|Chobani|8:15 AM|1|150|20|8|4|8",
      "Chicken breast||2026-09-02T13:05:00-07:00|2|330|62|0|7|8",
      "13",
      "Black coffee||||2",
    ].join("\n");
    const { rows, shape } = parseFoodsSeen(body);
    expect(shape).toBe("text-lines");
    expect(rows.map((r) => [r.name, r.brand, r.time, r.calories, r.protein])).toEqual([
      ["Greek yogurt", "Chobani", "08:15", 150, 20],
      ["Chicken breast", null, "08:00", 330, 62],
      ["Chicken breast", null, "13:05", 330, 62],
      ["Black coffee", null, null, 2, null],
    ]);
  });

  it("expands consumption count using hours consumed", () => {
    const { rows } = parseFoodsSeen([{ name: "Oats", "Time Last Consumed": "7:30 PM", "Consumption Count": 3, "Hours Consumed (24 hr)": "7, 12, 19", Energy: 300 }]);
    expect(rows.map((r) => r.time)).toEqual(["07:00", "12:00", "19:30"]);
  });

  it("accepts wrapped text and dictionaries with nutrients", () => {
    expect(parseFoodsSeen({ lines: "Apple||||95" }).rows[0]).toMatchObject({ name: "Apple", calories: 95 });
    const { rows } = parseFoodsSeen({ items: [{ Name: "Rice", nutrients: { energy: 200, carbs: 45 }, "Time Last Consumed": "13:05" }] });
    expect(rows[0]).toMatchObject({ name: "Rice", calories: 200, carbs: 45, time: "13:05" });
  });

  it("converts times into the user's zone", () => {
    expect(toLocalHHMM("2026-09-02T20:15:00Z")).toBe("13:15");
    expect(toLocalHHMM("1:05 PM")).toBe("13:05");
    expect(toLocalHHMM("Sep 2, 2026 at 9:41 AM")).toBe("09:41");
  });
});
