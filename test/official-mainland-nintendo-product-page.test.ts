import { describe, expect, it, vi } from "vitest";

import { createOfficialMainlandNintendoProductPageResolver } from "../src/worker/providers/official-mainland-nintendo-product-page";

/** 腾讯大陆商品页测试只使用内存响应，避免真实网络波动掩盖“同一纯数字 ID、同一路径”的安全边界。 */
describe("official mainland Nintendo product page provider", () => {
  it("returns a non-empty title only from the exact Tencent software page for the requested numeric ID", async () => {
    // 此用例会在提供方改用搜索、标题匹配或不同数字 ID 时失败；大陆名称只能来自香港 titles ID 的同号页面。
    const fetchPage = vi.fn<typeof fetch>().mockResolvedValue(responseWithUrl(
      "<!doctype html><html><head><title>星之卡比 探索发现</title></head><body>外部正文不得返回给调用方</body></html>",
      "https://www.nintendoswitch.com.cn/software/70010000000001",
    ));
    const resolver = createOfficialMainlandNintendoProductPageResolver(fetchPage);

    await expect(resolver.resolve("70010000000001")).resolves.toBe("星之卡比 探索发现");
    expect(fetchPage).toHaveBeenCalledExactlyOnceWith(
      "https://www.nintendoswitch.com.cn/software/70010000000001",
      expect.objectContaining({ headers: { accept: "text/html,application/xhtml+xml" } }),
    );
  });

  it("rejects a non-decimal identifier before making any request", async () => {
    // URL 拼接前必须拒绝斜杠、符号和空值，否则调用方错误可能把固定软件页能力扩大成任意路径请求器。
    const fetchPage = vi.fn<typeof fetch>();
    const resolver = createOfficialMainlandNintendoProductPageResolver(fetchPage);

    await expect(resolver.resolve("../search")).resolves.toBeNull();
    await expect(resolver.resolve("70010000000001?from=hk")).resolves.toBeNull();
    await expect(resolver.resolve(null)).resolves.toBeNull();
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("rejects a successful response whose final URL is not the exact same software path", async () => {
    // HTTP 客户端可能自动跟随重定向；即使最终页面也在腾讯域名，同号路径之外的标题都不能证明与香港商品 ID 对应。
    const fetchPage = vi.fn<typeof fetch>().mockResolvedValue(responseWithUrl(
      "<title>同名但未绑定商品 ID 的页面</title>",
      "https://www.nintendoswitch.com.cn/software/70010000000002",
    ));
    const resolver = createOfficialMainlandNintendoProductPageResolver(fetchPage);

    await expect(resolver.resolve("70010000000001")).resolves.toBeNull();
  });

  it("rejects redirected responses and non-standard Tencent origins even when the visible path and ID match", async () => {
    // “精确官方 URL”同时排除自动重定向、非标准端口和凭据形式；只比较 hostname/path 会把并非固定来源的响应错误标为大陆官方。
    const redirected = responseWithUrl(
      "<title>重定向后的同号标题</title>",
      "https://www.nintendoswitch.com.cn/software/70010000000001",
    );
    Object.defineProperty(redirected, "redirected", { value: true });
    const fetchPage = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(redirected)
      .mockResolvedValueOnce(responseWithUrl(
        "<title>非标准端口上的同号标题</title>",
        "https://www.nintendoswitch.com.cn:8443/software/70010000000001",
      ));
    const resolver = createOfficialMainlandNintendoProductPageResolver(fetchPage);

    await expect(resolver.resolve("70010000000001")).resolves.toBeNull();
    await expect(resolver.resolve("70010000000001")).resolves.toBeNull();
  });

  it("returns unavailable for failed responses, missing titles, and network errors", async () => {
    // 外部故障只表示本次大陆来源不可验证；提供方不得泄漏响应正文或异常，也不能阻断上层香港官方回退。
    const failed = createOfficialMainlandNintendoProductPageResolver(vi.fn<typeof fetch>().mockResolvedValue(responseWithUrl(
      "<title>错误页面中的文字不能采用</title>",
      "https://www.nintendoswitch.com.cn/software/70010000000001",
      404,
    )));
    const missingTitle = createOfficialMainlandNintendoProductPageResolver(vi.fn<typeof fetch>().mockResolvedValue(responseWithUrl(
      "<html><body>没有标题</body></html>",
      "https://www.nintendoswitch.com.cn/software/70010000000001",
    )));
    const networkFailure = createOfficialMainlandNintendoProductPageResolver(vi.fn<typeof fetch>().mockRejectedValue(new Error("private upstream detail")));

    await expect(failed.resolve("70010000000001")).resolves.toBeNull();
    await expect(missingTitle.resolve("70010000000001")).resolves.toBeNull();
    await expect(networkFailure.resolve("70010000000001")).resolves.toBeNull();
  });
});

/**
 * Worker Response 的最终 URL 通常由 fetch 填充；内存 Response 没有请求上下文，因此测试显式固定只读 url，
 * 让断言覆盖生产中的自动重定向结果，而不是把请求 URL 误当作最终身份。
 */
function responseWithUrl(body: string, url: string, status = 200): Response {
  const response = new Response(body, { status });
  Object.defineProperty(response, "url", { value: url });
  return response;
}
