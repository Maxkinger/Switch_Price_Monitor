import { describe, expect, it, vi } from "vitest";

import { createApiRequestTracker } from "../src/app/api-request-tracker";

/** 请求计数器是全局加载层的唯一事实来源；测试并发与重复结束，防止任一请求提前隐藏或把遮罩永久留在页面上。 */
describe("API 请求计数器", () => {
  it("keeps loading active until every concurrent request ends and ignores a repeated end", () => {
    const tracker = createApiRequestTracker();
    const listener = vi.fn();
    const unsubscribe = tracker.subscribe(listener);
    const firstDone = tracker.begin();
    const secondDone = tracker.begin();

    expect(tracker.getPendingCount()).toBe(2);
    firstDone();
    expect(tracker.getPendingCount()).toBe(1);
    secondDone();
    secondDone();
    expect(tracker.getPendingCount()).toBe(0);
    expect(listener).toHaveBeenCalledTimes(4);

    unsubscribe();
  });
});
