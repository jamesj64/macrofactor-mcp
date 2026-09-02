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
    expect(rows.map((r) => [r.name, r.brand, r.date, r.time, r.calories, r.protein])).toEqual([
      ["Greek yogurt", "Chobani", null, "08:15", 150, 20],
      ["Chicken breast", null, "2026-09-02", "13:05", 330, 62],
      ["Black coffee", null, null, null, 2, null],
    ]);
    expect(rows[1].lifetime_count).toBe(2);
    expect(rows[1].usual_hours).toEqual([8, 13]);
  });

  it("keeps one row per food (count/hours are lifetime stats) and parses dates from Shortcuts' date text", () => {
    const { rows } = parseFoodsSeen([{ name: "Oats", "Time Last Consumed": "Aug 30, 2026 at 7:30 PM", "Consumption Count": 47, "Hours Consumed (24 hr)": "7, 12, 19", Energy: 300 }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ date: "2026-08-30", time: "19:30", lifetime_count: 47, usual_hours: [7, 12, 19] });
  });

  it("accepts wrapped text and dictionaries with nutrients", () => {
    expect(parseFoodsSeen({ lines: "Apple||||95" }).rows[0]).toMatchObject({ name: "Apple", calories: 95 });
    const { rows } = parseFoodsSeen({ items: [{ Name: "Rice", nutrients: { energy: 200, carbs: 45 }, "Time Last Consumed": "13:05" }] });
    expect(rows[0]).toMatchObject({ name: "Rice", calories: 200, carbs: 45, time: "13:05" });
  });

  it("converts offset times into the user's zone and keeps wall-clock text as written", () => {
    expect(toLocalHHMM("2026-09-02T20:15:00Z")).toBe("13:15");
    expect(toLocalHHMM("2026-09-03T00:30:00Z")).toBe("17:30");
    expect(toLocalHHMM("1:05 PM")).toBe("13:05");
    expect(toLocalHHMM("Sep 2, 2026 at 9:41 AM")).toBe("09:41");
    expect(toLocalHHMM("9/2/26, 8:15 AM")).toBe("08:15");
    expect(toLocalHHMM("Sep 2, 2026 at 11:50 PM")).toBe("23:50");
  });
  it("derives the calendar date from either form", () => {
    expect(parseFoodsSeen("A||Sep 2, 2026 at 11:50 PM||1").rows[0].date).toBe("2026-09-02");
    expect(parseFoodsSeen("B||2026-09-03T06:59:00Z||1").rows[0].date).toBe("2026-09-02");
    expect(parseFoodsSeen("C||8:15 AM||1").rows[0].date).toBeNull();
  });
});
