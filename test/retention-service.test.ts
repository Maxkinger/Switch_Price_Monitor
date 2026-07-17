import { describe, expect, it } from "vitest";

import { priceRetentionCutoff, fetchLogRetentionCutoff } from "../src/worker/services/retention-service";

describe("retention cutoffs", () => {
  it("calculates calendar-year price cutoffs and keeps forever history", () => {
    // 价格保留按日历年而不是 365 天，避免闰年和月末日期让用户选择的“一年/两年”提前删除记录。
    expect(priceRetentionCutoff("2028-02-29T12:00:00.000Z", "one-year")).toBe("2027-02-28T12:00:00.000Z");
    expect(priceRetentionCutoff("2028-02-29T12:00:00.000Z", "two-years")).toBe("2026-02-28T12:00:00.000Z");
    expect(priceRetentionCutoff("2028-02-29T12:00:00.000Z", "forever")).toBeNull();
  });

  it("uses a fixed ninety-day cutoff for diagnostic logs", () => {
    // 诊断日志不受用户价格历史偏好影响，固定 90 天可控制存储并保留最近异常排查证据。
    expect(fetchLogRetentionCutoff("2026-07-16T00:00:00.000Z")).toBe("2026-04-17T00:00:00.000Z");
  });
});
