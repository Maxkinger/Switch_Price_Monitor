import { describe, expect, it } from "vitest";

import { evaluateHealthTransition, evaluateOfficialDrop, evaluateTarget } from "../src/worker/services/price-rules";

/**
 * 价格规则保持纯函数，测试不接触 D1、Telegram 或外部商店。
 * 这保证通知判断在采集重试、日报生成或未来 UI 改造后仍有稳定且可审计的业务语义。
 */
describe("price monitoring rules", () => {
  it("does not create an immediate alert for a third-party drop", () => {
    // 第三方价格可以展示和进入日报，但其准确性不能单独证明官方促销，因此不得触发即时降价通知。
    expect(
      evaluateOfficialDrop(
        { amountMinor: 1_000, source: "official" },
        { amountMinor: 800, source: "nt-deals" },
      ),
    ).toBe(false);
  });

  it("triggers an immediate alert only when consecutive official prices decrease", () => {
    // 当前和上一条必须都来自官方；价格相同或上涨都不是降价，避免采集重复和汇率显示变化造成误推送。
    expect(evaluateOfficialDrop({ amountMinor: 1_000, source: "official" }, { amountMinor: 800, source: "official" })).toBe(true);
    expect(evaluateOfficialDrop({ amountMinor: 800, source: "official" }, { amountMinor: 800, source: "official" })).toBe(false);
    expect(evaluateOfficialDrop({ amountMinor: 800, source: "official" }, { amountMinor: 1_000, source: "official" })).toBe(false);
  });

  it("triggers a target only on the first crossing and resets after recovery", () => {
    // 命中状态持久化在目标价记录中：首次降到目标价或以下提醒，持续低价不重复提醒，回升后重置以允许下次再次跌破。
    expect(evaluateTarget(5_000, 4_900, "unmet")).toBe("trigger");
    expect(evaluateTarget(5_000, 4_800, "met")).toBe("none");
    expect(evaluateTarget(5_000, 5_100, "met")).toBe("reset");
  });

  it("alerts once at the third consecutive failure and once again when collection recovers", () => {
    // 失败阈值必须跨 Cron 轮次持久化：第三次失败告警一次，后续失败静默；下一次成功只发送一条恢复通知并清零。
    expect(evaluateHealthTransition({ consecutiveFailures: 2, failureNotified: false }, false)).toEqual({
      consecutiveFailures: 3,
      failureNotified: true,
      notification: "failure",
    });
    expect(evaluateHealthTransition({ consecutiveFailures: 3, failureNotified: true }, false)).toEqual({
      consecutiveFailures: 4,
      failureNotified: true,
      notification: "none",
    });
    expect(evaluateHealthTransition({ consecutiveFailures: 4, failureNotified: true }, true)).toEqual({
      consecutiveFailures: 0,
      failureNotified: false,
      notification: "recovered",
    });
  });
});
