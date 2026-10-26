import { describe, expect, it } from "vitest";
import { localParts, planBuckets, startOfLocalDay, zonedTime } from "../src/server/lib/time";

const local = (tz: string, utcMs: number) => {
  const p = localParts(tz, utcMs);
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute };
};

describe("zonedTime", () => {
  it("starts a day at the transition when clocks spring forward at midnight west of UTC", () => {
    const santiago = zonedTime("America/Santiago", 2026, 9, 6);
    expect(santiago).toBe(Date.UTC(2026, 8, 6, 4));
    expect(local("America/Santiago", santiago)).toEqual({ year: 2026, month: 9, day: 6, hour: 1, minute: 0 });

    const havana = zonedTime("America/Havana", 2026, 3, 8);
    expect(havana).toBe(Date.UTC(2026, 2, 8, 5));
    expect(local("America/Havana", havana)).toEqual({ year: 2026, month: 3, day: 8, hour: 1, minute: 0 });
  });

  it("keeps the first valid instant east of UTC, fall-back days and normal days", () => {
    const beirut = zonedTime("Asia/Beirut", 2026, 3, 29);
    expect(beirut).toBe(Date.UTC(2026, 2, 28, 22));
    expect(local("Asia/Beirut", beirut)).toEqual({ year: 2026, month: 3, day: 29, hour: 1, minute: 0 });

    const fallBack = zonedTime("America/Santiago", 2026, 4, 5);
    expect(fallBack).toBe(Date.UTC(2026, 3, 5, 4));
    expect(local("America/Santiago", fallBack)).toEqual({ year: 2026, month: 4, day: 5, hour: 0, minute: 0 });

    const toronto = zonedTime("America/Toronto", 2026, 6, 15);
    expect(toronto).toBe(Date.UTC(2026, 5, 15, 4));
    expect(local("America/Toronto", toronto)).toEqual({ year: 2026, month: 6, day: 15, hour: 0, minute: 0 });
  });

  it("handles a day that overflows into the spring-forward date", () => {
    expect(zonedTime("America/Santiago", 2026, 9, 5 + 1)).toBe(zonedTime("America/Santiago", 2026, 9, 6));
    expect(zonedTime("America/Havana", 2026, 2, 28 + 8)).toBe(zonedTime("America/Havana", 2026, 3, 8));
  });
});

describe("day buckets across a spring-forward midnight", () => {
  it("startOfLocalDay keeps the previous day's last hour out of the new day", () => {
    // 00:30 local on Sep 6 doesn't exist; 01:30 (-03) is the first hour of the day
    expect(startOfLocalDay("America/Santiago", Date.UTC(2026, 8, 6, 4, 30))).toBe(Date.UTC(2026, 8, 6, 4));
    // 23:30 (-04) on Sep 5 still belongs to Sep 5
    expect(startOfLocalDay("America/Santiago", Date.UTC(2026, 8, 6, 3, 30))).toBe(Date.UTC(2026, 8, 5, 4));
  });

  it("planBuckets gives the short day 23 hours", () => {
    const tz = "America/Santiago";
    const plan = planBuckets(tz, zonedTime(tz, 2026, 9, 5), zonedTime(tz, 2026, 9, 8), "day");
    expect(plan.buckets.map((b) => b.label)).toEqual(["2026-09-05", "2026-09-06", "2026-09-07"]);
    const [sep5, sep6, sep7] = plan.buckets.map((b) => b.start);
    expect(sep6 - sep5).toBe(24 * 3_600_000);
    expect(sep7 - sep6).toBe(23 * 3_600_000);
  });
});
