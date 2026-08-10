import { describe, expect, it } from "vitest";

import { handleGameNameRoute } from "../src/routes/game-name-routes";
import { GameNameService } from "../src/services/game-name-service";
import type { SessionReader } from "../src/routes/auth-guard";
import { InMemoryGameNameStore } from "./support/in-memory-business-stores";

/**
 * 名称管理 HTTP 合同直接经过真实路由、领域服务与内存端口；只替换持久化与会话外部边界，
 * 从而让每个断言都能捕获错误路径匹配、认证绕过、身份键误算、写入覆盖或错误信息泄漏。
 */
describe("简体中文游戏名称管理 HTTP 路由", () => {
  const confirmedAt = "2026-08-10T00:00:00.000Z";
  const identityKey = "kirby and the forgotten land|nintendo|game";

  it.each([
    { method: "GET", path: "/api/game-names?status=pending", body: undefined },
    { method: "POST", path: "/api/game-names/backfill", body: {} },
    { method: "POST", path: "/api/game-names/suggestions", body: { candidates: [] } },
    { method: "PATCH", path: "/api/game-names/game-1", body: validManualPatch() },
  ])("未认证时拒绝 $method $path 且不执行名称服务", async ({ method, path, body }) => {
    // 若共享守卫被绕过，抛错服务会把响应变成 500；因此本测试观察真实 401，而不是只断言会话替身被调用。
    const service = rejectingService("未认证请求不应进入名称服务");
    const response = await routeRequest(service, deniedSessions, path, method, body);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ code: "UNAUTHORIZED", error: "请先登录。" });
  });

  it("只列出 status=pending 的待确认公开字段", async () => {
    // 如果路由忽略 status 或直接序列化仓储行，本测试会因错误状态码或多余敏感字段失败。
    const store = new InMemoryGameNameStore();
    store.seedPending(pendingGame("game-pending", identityKey));
    const response = await routeRequest(new GameNameService(store), allowedSessions, "/api/game-names?status=pending", "GET");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ games: [pendingGame("game-pending", identityKey)] });
  });

  it("回填只报告精确词条命中的空名称游戏并保留未命中项", async () => {
    // 若回填按模糊标题匹配或覆盖全部 pending，未命中的 game-unmatched 会错误出现在 updatedGameIds 中。
    const store = new InMemoryGameNameStore();
    store.seedCatalog({
      identityKey,
      displayNameZhCn: "星之卡比 探索发现",
      source: "publisher",
      evidenceUrl: "https://www.nintendo.com/example/kirby",
      confirmedAt,
    });
    store.seedPending(pendingGame("game-matched", identityKey));
    store.seedPending(pendingGame("game-unmatched", "kirby and the forgotten land|other publisher|game"));

    const response = await routeRequest(new GameNameService(store), allowedSessions, "/api/game-names/backfill", "POST", {});

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ updatedGameIds: ["game-matched"], remainingCount: 1 });
  });

  it("建议仅按标题、发行商与类型组成的精确身份返回已确认词条或 null", async () => {
    // 候选 key 只用于前端关联；若服务把它当成目录身份，伪造 key 或同标题异发行商都会错误命中。
    const store = new InMemoryGameNameStore();
    store.seedCatalog({
      identityKey,
      displayNameZhCn: "星之卡比 探索发现",
      source: "publisher",
      evidenceUrl: "https://www.nintendo.com/example/kirby",
      confirmedAt,
    });
    const response = await routeRequest(new GameNameService(store), allowedSessions, "/api/game-names/suggestions", "POST", {
      candidates: [
        { candidateKey: "browser-key-hit", canonicalTitle: " Kirby and the Forgotten Land ", publisher: "Nintendo", productType: "game" },
        { candidateKey: identityKey, canonicalTitle: "Kirby and the Forgotten Land", publisher: "Other Publisher", productType: "game" },
        { candidateKey: "browser-key-type-miss", canonicalTitle: "Kirby and the Forgotten Land", publisher: "Nintendo", productType: "dlc" },
      ],
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      suggestions: [
        { candidateKey: "browser-key-hit", displayNameZhCn: "星之卡比 探索发现" },
        { candidateKey: identityKey, displayNameZhCn: null },
        { candidateKey: "browser-key-type-miss", displayNameZhCn: null },
      ],
    });
  });

  it.each([
    { body: [], label: "非普通顶层对象" },
    { body: { candidates: [null] }, label: "非对象候选" },
    { body: { candidates: [{ candidateKey: "candidate", canonicalTitle: "Kirby", publisher: "Nintendo", productType: "unknown" }] }, label: "未知商品类型" },
  ])("建议在目录查询前以 422 拒绝$label", async ({ body }) => {
    // 若候选 JSON 未逐项收窄，浏览器可用不完整身份触发错误目录查询，或把类型断言伪装成运行时验证。
    const response = await routeRequest(rejectingService("非法建议不应进入名称服务"), allowedSessions, "/api/game-names/suggestions", "POST", body);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("待处理列表拒绝缺失或未知状态筛选", async () => {
    // 若路由静默忽略查询参数，管理员可能把不完整结果误认为其他名称状态的全集。
    const response = await routeRequest(rejectingService("非法筛选不应进入名称服务"), allowedSessions, "/api/game-names?status=confirmed", "GET");

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ code: "VALIDATION_ERROR", error: "名称状态筛选无效。" });
  });

  it("不消费额外子路径或错误 HTTP 方法", async () => {
    // startsWith 或宽松方法判断会抢占未来路由；两个请求必须交还总 dispatcher，而不是返回名称业务响应。
    const service = rejectingService("未匹配路径不应进入名称服务");
    await expect(handleGameNameRoute(new Request("http://localhost/api/game-names/backfill/extra", { method: "POST" }), allowedSessions, service)).resolves.toBeNull();
    await expect(handleGameNameRoute(new Request("http://localhost/api/game-names/game-1", { method: "POST" }), allowedSessions, service)).resolves.toBeNull();
  });

  it.each([
    { patch: { ...validManualPatch(), displayNameZhCn: "   " }, label: "空白名称" },
    { patch: { ...validManualPatch(), displayNameZhCn: "名".repeat(121) }, label: "超长名称" },
    { patch: { ...validManualPatch(), source: "crawler" }, label: "未知来源" },
    { patch: { ...validManualPatch(), saveToCatalog: "yes" }, label: "非布尔复用标记" },
    { patch: { ...validManualPatch(), evidenceUrl: "http://example.com/kirby" }, label: "非 HTTPS 证据" },
    { patch: [], label: "非普通对象" },
  ])("PATCH 在写入前以 422 拒绝$label", async ({ patch }) => {
    // 每个非法值若穿透路由都会调用抛错服务并得到 500；422 证明 JSON 已先按公开合同收窄。
    const response = await routeRequest(rejectingService("非法补丁不应进入名称服务"), allowedSessions, "/api/game-names/game-1", "PATCH", patch);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("PATCH 对未知游戏返回 404 而不暴露领域或数据库内部文本", async () => {
    // 未知 ID 是可预期资源状态；若被当成普通 Error，会错误返回 500 或把服务内部文案直接泄漏。
    const response = await routeRequest(new GameNameService(new InMemoryGameNameStore()), allowedSessions, "/api/game-names/missing-game", "PATCH", validManualPatch());
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(JSON.parse(body)).toEqual({ code: "NOT_FOUND", error: "游戏不存在。" });
    expect(body).not.toContain("SQL");
  });

  it("PATCH 对已存在但缺少精确身份的游戏保持 422", async () => {
    // 存在性与可复用身份是两条独立业务边界：返回 404 会误导管理员，继续写入则可能让浏览器文本决定未来目录归属。
    const store = new InMemoryGameNameStore();
    store.seedPending({ ...pendingGame("game-missing-identity", identityKey), identityKey: null });
    const response = await routeRequest(new GameNameService(store), allowedSessions, "/api/game-names/game-missing-identity", "PATCH", validManualPatch());

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      code: "VALIDATION_ERROR",
      error: "该游戏缺少精确官方身份，暂不能保存中文名称。",
    });
  });

  it("PATCH 成功只返回确认后的窄响应，不返回旧名称、证据网页或存储细节", async () => {
    // 成功响应按字面量核对字段集合；任何直接序列化 pending、catalog 或仓储返回值都会带出多余字段并使断言失败。
    const store = new InMemoryGameNameStore();
    store.seedPending(pendingGame("game-1", identityKey));
    const response = await routeRequest(new GameNameService(store), allowedSessions, "/api/game-names/game-1", "PATCH", validManualPatch());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toEqual({ gameId: "game-1", displayNameZhCn: "星之卡比 探索发现", source: "manual" });
    expect(body).not.toContain("legacyNameZh");
    expect(body).not.toContain("Kirby and the Forgotten Land");
    expect(body).not.toContain("https://");
  });

  it("PATCH 可更正已确认游戏名称并保留其非 pending 状态", async () => {
    // 详情页修正面对的是已有 display_name_zh_cn 的游戏；若 API 仍把“非 pending”误判为未知资源，会返回 404 而阻断纠错。
    const store = new InMemoryGameNameStore();
    store.seedConfirmedManual({
      ...pendingGame("game-confirmed", identityKey),
      displayNameZhCn: "星之卡比 探索发现（旧译）",
      confirmedAt,
    });
    const service = new GameNameService(store);
    const response = await routeRequest(service, allowedSessions, "/api/game-names/game-confirmed", "PATCH", {
      displayNameZhCn: "星之卡比 探索发现",
      source: "publisher",
      evidenceUrl: "https://www.nintendo.com/example/kirby",
      saveToCatalog: true,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ gameId: "game-confirmed", displayNameZhCn: "星之卡比 探索发现", source: "manual" });
    expect(store.inspectGame("game-confirmed")).toEqual({
      displayNameZhCn: "星之卡比 探索发现",
      state: "confirmed",
      source: "manual",
    });
    expect(await service.listPending()).toEqual([]);
    expect(await service.resolveForConfirmedGame(identityKey, null)).toEqual({
      displayNameZhCn: "星之卡比 探索发现",
      source: "catalog",
    });
  });

  it("数据库或外部内容异常统一返回固定中文 500", async () => {
    // marker 同时模拟 SQL、数据库 URL 与外部网页正文；响应不得包含 Error.message、stack 或任一输入片段。
    const marker = "SELECT secret FROM games; postgres://secret; <html>external-page</html>";
    const response = await routeRequest(rejectingService(marker), allowedSessions, "/api/game-names/backfill", "POST", {});
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(body)).toEqual({ code: "INTERNAL_ERROR", error: "游戏名称暂时无法处理，请稍后重试。" });
    expect(body).not.toContain(marker);
    expect(body).not.toContain("postgres://");
    expect(body).not.toContain("external-page");
  });
});

const allowedSessions: SessionReader = { authenticate: async () => true };
const deniedSessions: SessionReader = { authenticate: async () => false };

/** 真实 handler 返回 null 代表没有匹配；本 helper 将其视为测试装配错误，避免可选链把漏注册误当成成功。 */
async function routeRequest(
  service: GameNameService,
  sessions: SessionReader,
  path: string,
  method: string,
  body?: unknown,
): Promise<Response> {
  const response = await handleGameNameRoute(new Request(`http://localhost${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      // 成功与验证用例使用受控非秘密 token；拒绝替身仍会把同一 Cookie 判为无效，覆盖伪造会话而不暴露真实凭据。
      ...(sessions === allowedSessions ? { cookie: "session=valid-test-token" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), sessions, service);
  if (response === null) throw new Error("名称管理测试请求未被路由处理");
  return response;
}

/** 标准人工补丁只含 Task 2 服务允许的四字段，后续用例逐个变异以证明每条边界都有独立保护。 */
function validManualPatch(): Record<string, unknown> {
  return {
    displayNameZhCn: "星之卡比 探索发现",
    source: "manual",
    evidenceUrl: null,
    saveToCatalog: true,
  };
}

/** 待处理夹具字段均为管理页公开识别信息，不包含价格、地区 URL、会话或数据库实现字段。 */
function pendingGame(gameId: string, key: string) {
  return {
    gameId,
    subscriptionId: `subscription-${gameId}`,
    identityKey: key,
    officialTitle: "Kirby and the Forgotten Land",
    publisher: "Nintendo",
    productType: "game" as const,
    legacyNameZh: "Kirby and the Forgotten Land",
  };
}

/** 抛错替身只用于证明守卫、验证和脱敏边界先于领域调用；不对替身调用次数或参数作无业务意义断言。 */
function rejectingService(message: string): GameNameService {
  return {
    listPending: async () => { throw new Error(message); },
    backfill: async () => { throw new Error(message); },
    resolveForConfirmedGame: async () => { throw new Error(message); },
    saveManual: async () => { throw new Error(message); },
  } as unknown as GameNameService;
}
