import { describe, expect, it, vi } from "vitest";
import {
  AiGameNameSuggestionError,
  AiProviderNotConfiguredError,
  DeepSeekGameNameSuggestionService,
  type AiGameNameCandidate,
} from "../src/services/deepseek-game-name-suggestion-service";
import type { AiProviderCredentials } from "../src/repositories/ports";

/** 每个候选只提供服务合同允许的公开身份字段；单项测试可在运行时追加敏感哨兵，验证服务会重新构造严格白名单。 */
function candidate(candidateKey: string): AiGameNameCandidate {
  return {
    candidateKey,
    canonicalTitle: "Overcooked! 2",
    publisher: "Ghost Town Games",
    productType: "game",
  };
}

/** 将模型消息包装成 Chat Completions 成功响应，保持外部 API 的层级而不访问真实网络。 */
function modelResponse(content: string): Response {
  return Response.json({ choices: [{ message: { content } }] });
}

/** 每次建议都由 reader 返回瞬时凭据；测试替身可验证服务未在构造期固化已删除或刚更新的配置。 */
function configuredReader(apiKey = "test-key", model = "deepseek-v4-flash") {
  return { getCredentials: async (): Promise<AiProviderCredentials> => ({ apiKey, model, apiBaseUrl: "https://api.deepseek.com" }) };
}

describe("DeepSeek 中文游戏名称建议服务", () => {
  it("配置缺失时在请求前返回专用错误且绝不外发", async () => {
    // 配置可能被管理员刚删除、密文被篡改或主密钥不可用；此时必须在构造 HTTP 请求前停止，不能把空 Authorization 发送到供应商。
    const request = vi.fn<typeof globalThis.fetch>();
    const service = new DeepSeekGameNameSuggestionService({ getCredentials: async () => null }, request);

    await expect(service.suggest([candidate("official-1")])).rejects.toBeInstanceOf(AiProviderNotConfiguredError);
    expect(request).not.toHaveBeenCalled();
  });

  it("每次建议重新读取配置，保存或清除后无需重启且清除不外发", async () => {
    // reader 模拟同一 Node 进程中的设置保存/删除：若服务把构造期凭据闭包缓存，第二次应错误继续使用旧 Key 并触发该回归。
    let credentials: AiProviderCredentials | null = null;
    const reader = { getCredentials: async () => credentials };
    const request = vi.fn<typeof globalThis.fetch>().mockResolvedValue(modelResponse(JSON.stringify([
      { candidateKey: "official-1", displayNameZhCn: "胡闹厨房 2", confidence: "high" },
    ])));
    const service = new DeepSeekGameNameSuggestionService(reader, request);

    await expect(service.suggest([candidate("official-1")])).rejects.toBeInstanceOf(AiProviderNotConfiguredError);
    credentials = { apiKey: "newly-saved-key", model: "deepseek-chat", apiBaseUrl: "https://api.deepseek.com" };
    await expect(service.suggest([candidate("official-1")])).resolves.toHaveLength(1);
    credentials = null;
    await expect(service.suggest([candidate("official-1")])).rejects.toBeInstanceOf(AiProviderNotConfiguredError);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("只向固定 DeepSeek 端点发送精确白名单和该调用专用 Authorization", async () => {
    // 运行时对象故意夹带会话、价格、URL 与其他系统秘密；任何对象展开或直接序列化都会让唯一一次外部请求正文命中哨兵。
    const request = vi.fn<typeof globalThis.fetch>().mockResolvedValue(modelResponse("not-json"));
    const apiKey = "deepseek-key-runtime-sentinel";
    const unsafeCandidate = {
      ...candidate("official-1"),
      session: "session-runtime-sentinel",
      price: 2999,
      productUrl: "https://runtime-url-sentinel.invalid/product",
      telegramToken: "telegram-runtime-sentinel",
    } as AiGameNameCandidate;
    const service = new DeepSeekGameNameSuggestionService(configuredReader(apiKey), request);

    await expect(service.suggest([unsafeCandidate])).resolves.toEqual([
      { candidateKey: "official-1", displayNameZhCn: null, confidence: "low" },
    ]);

    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0] ?? [];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(init?.method).toBe("POST");
    // 禁止自动跟随供应商响应中的重定向，确保 Authorization 不会因运行时跳转离开固定 DeepSeek 调用边界。
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toEqual({ "content-type": "application/json", authorization: `Bearer ${apiKey}` });
    const body = String(init?.body);
    expect(body).not.toContain(apiKey);
    expect(body).not.toContain("session-runtime-sentinel");
    expect(body).not.toContain("2999");
    expect(body).not.toContain("runtime-url-sentinel");
    expect(body).not.toContain("telegram-runtime-sentinel");
    const payload = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
    expect(JSON.parse(payload.messages[1]?.content ?? "null")).toEqual({
      candidates: [{ candidateKey: "official-1", canonicalTitle: "Overcooked! 2", publisher: "Ghost Town Games", productType: "game" }],
    });
  });

  it("只重建已输入候选的有效高置信度名称，并让重复、未知、低置信度和超长项安全降级", async () => {
    // 若模型返回的键可直接穿透，攻击者能把建议关联到非本批商品；低质量或超过数据库同一 120 字符上限的文本也绝不能预填页面。
    const request = vi.fn<typeof globalThis.fetch>().mockResolvedValue(modelResponse(JSON.stringify([
      { candidateKey: "official-1", displayNameZhCn: "  胡闹厨房 2  ", confidence: "high", ignored: "not-returned" },
      { candidateKey: "official-1", displayNameZhCn: "重复键", confidence: "high" },
      { candidateKey: "unknown", displayNameZhCn: "未知键", confidence: "high" },
      { candidateKey: "official-2", displayNameZhCn: "低置信度", confidence: "low" },
      { candidateKey: "official-3", displayNameZhCn: "名".repeat(121), confidence: "medium" },
    ])));
    const service = new DeepSeekGameNameSuggestionService(configuredReader("test-key", "deepseek-v4-pro"), request);

    await expect(service.suggest([
      candidate("official-1"), candidate("official-2"), candidate("official-3"),
    ])).resolves.toEqual([
      { candidateKey: "official-1", displayNameZhCn: null, confidence: "low" },
      { candidateKey: "official-2", displayNameZhCn: null, confidence: "low" },
      { candidateKey: "official-3", displayNameZhCn: null, confidence: "low" },
    ]);
  });

  it("模型完整且一一对应时只返回修剪后的允许字段", async () => {
    // 若服务保留模型附带字段或没有修剪名称，浏览器会取得未经审计的内容，且后续人工保存可能与 1..120 字符规则不一致。
    const request = vi.fn<typeof globalThis.fetch>().mockResolvedValue(modelResponse(JSON.stringify([
      { candidateKey: "official-1", displayNameZhCn: "  胡闹厨房 2  ", confidence: "medium", extra: "discard" },
    ])));
    const service = new DeepSeekGameNameSuggestionService(configuredReader(), request);

    await expect(service.suggest([candidate("official-1")])).resolves.toEqual([
      { candidateKey: "official-1", displayNameZhCn: "胡闹厨房 2", confidence: "medium" },
    ]);
  });

  it("模型同一输入键出现一条畸形和一条有效结果时仍把该键整体降级", async () => {
    // 重复统计必须先于名称、置信度等字段筛选；否则攻击者可用一条畸形记录隐藏同键冲突，让另一条未经唯一性确认的文本进入页面。
    const request = vi.fn<typeof globalThis.fetch>().mockResolvedValue(modelResponse(JSON.stringify([
      { candidateKey: "official-1", displayNameZhCn: 42, confidence: "high" },
      { candidateKey: "official-1", displayNameZhCn: "胡闹厨房 2", confidence: "high" },
    ])));
    const service = new DeepSeekGameNameSuggestionService(configuredReader(), request);

    await expect(service.suggest([candidate("official-1")])).resolves.toEqual([
      { candidateKey: "official-1", displayNameZhCn: null, confidence: "low" },
    ]);
  });

  it("模型名称含 C1 控制字符时降级而不把不可见文本交给浏览器", async () => {
    // C1 控制区与现有 C0/DEL 约束同属不可展示输入；漏掉它会允许日志或界面控制序列混入管理员草稿。
    const request = vi.fn<typeof globalThis.fetch>().mockResolvedValue(modelResponse(JSON.stringify([
      { candidateKey: "official-1", displayNameZhCn: "胡闹\u0085厨房", confidence: "high" },
    ])));
    const service = new DeepSeekGameNameSuggestionService(configuredReader(), request);

    await expect(service.suggest([candidate("official-1")])).resolves.toEqual([
      { candidateKey: "official-1", displayNameZhCn: null, confidence: "low" },
    ]);
  });

  it("拒绝空批次和超过十项的批次，避免不可控提示词体积", async () => {
    // 若缺少批次边界，单个管理员请求可放大外部成本和超时风险；校验必须发生在网络请求之前。
    const request = vi.fn<typeof globalThis.fetch>();
    const service = new DeepSeekGameNameSuggestionService(configuredReader(), request);

    await expect(service.suggest([])).rejects.toThrow("AI 名称建议候选数量无效。");
    await expect(service.suggest(Array.from({ length: 11 }, (_, index) => candidate(`official-${index}`))))
      .rejects.toThrow("AI 名称建议候选数量无效。");
    expect(request).not.toHaveBeenCalled();
  });

  it("将非成功响应和网络失败转换为固定脱敏可用性错误", async () => {
    // 外部正文可能含供应商诊断或代理细节；服务只允许调用方得知可重试的固定状态，不能回显 Key 或响应内容。
    const unavailable = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("provider-internal-detail", { status: 429 }));
    const failed = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("network-internal-detail"));

    await expect(new DeepSeekGameNameSuggestionService(configuredReader(), unavailable).suggest([candidate("official-1")]))
      .rejects.toEqual(new AiGameNameSuggestionError("AI 名称建议暂时不可用。"));
    await expect(new DeepSeekGameNameSuggestionService(configuredReader(), failed).suggest([candidate("official-1")]))
      .rejects.toThrow("AI 名称建议暂时不可用。");
  });

  it("在十秒超时后只返回固定脱敏可用性错误", async () => {
    // 若超时信号被移除、时长漂移或拒绝原因直接透出，外部连接可能无限占用且管理员会看到网络细节；此处以受控信号模拟真实 fetch 对 abort 的拒绝。
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const request = vi.fn<typeof globalThis.fetch>().mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("provider-timeout-detail", "TimeoutError")), { once: true });
    }));
    const service = new DeepSeekGameNameSuggestionService(configuredReader(), request);

    const pending = service.suggest([candidate("official-1")]);
    // 动态 reader 先完成一次微任务；确认 fetch 已绑定 abort 监听后再触发，避免测试把调度时序误判为超时合同失败。
    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toThrow("AI 名称建议暂时不可用。");
    expect(timeout).toHaveBeenCalledWith(10_000);
  });
});
