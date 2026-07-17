import { describe, expect, it, vi } from "vitest";

import { createFrankfurterExchangeRateProvider } from "../src/worker/providers/frankfurter-exchange-rate";
import { ProviderNetworkError } from "../src/worker/providers/types";

describe("Frankfurter exchange-rate provider", () => {
  it("inverts CNY-base responses into one foreign currency's CNY rate", async () => {
    // Frankfurter 的 base=CNY 响应表示一元人民币能换多少外币；价格快照需要相反方向，因此必须取倒数而不是直接保存原值。
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json([
      { date: "2026-07-17", base: "CNY", quote: "USD", rate: 0.1470588235 },
      { date: "2026-07-17", base: "CNY", quote: "JPY", rate: 23.25581395 },
    ]));
    const provider = createFrankfurterExchangeRateProvider(fetcher);

    const rates = await provider.getDailyRates(["USD", "JPY"], new AbortController().signal);
    // 上游响应是有限精度的十进制近似值；断言换算方向与六位有效精度，而不把来源本身的舍入误差误判为业务错误。
    expect(rates).toMatchObject([
      { currency: "USD", source: "frankfurter" },
      { currency: "JPY", source: "frankfurter" },
    ]);
    expect(rates[0]?.cnyRate).toBeCloseTo(6.8, 6);
    expect(rates[1]?.cnyRate).toBeCloseTo(0.043, 6);
    // 生产代码传入标准 URL 对象而非拼接字符串；按查询参数断言可同时覆盖编码规则与货币请求，不绑定 URL 的展示形式。
    const [requestUrl, requestOptions] = fetcher.mock.calls[0] ?? [];
    expect(requestUrl).toBeInstanceOf(URL);
    const url = requestUrl as URL;
    expect(url.searchParams.get("base")).toBe("CNY");
    expect(url.searchParams.get("quotes")).toBe("USD,JPY");
    expect(requestOptions).toMatchObject({ signal: expect.any(AbortSignal) });
  });

  it("turns transport failures into the retryable provider network error", async () => {
    // ProviderChain 只会对该错误重试一次；把传输错误显式包装可避免对格式错误响应重复请求。
    const provider = createFrankfurterExchangeRateProvider(vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network down")));

    await expect(provider.getDailyRates(["USD"], new AbortController().signal)).rejects.toBeInstanceOf(ProviderNetworkError);
  });
});
