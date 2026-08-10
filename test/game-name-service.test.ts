import { describe, expect, it } from "vitest";
import { GameNameService } from "../src/services/game-name-service";
import { InMemoryGameNameStore } from "./support/in-memory-business-stores";

/**
 * 简体中文展示名称服务以精确身份键为边界的业务测试。
 * 每个期望值均由已确认的名称、身份和时间字面量给出，防止测试复用生产规范化逻辑而掩盖同名异商品误命中的风险。
 */
describe("简体中文游戏名称服务", () => {
  const now = "2026-08-10T00:00:00.000Z";
  const identityKey = "overcooked 2|ghost town games|game";

  it("优先返回与精确身份键匹配的词条名称", async () => {
    // 若服务忽略词条或错误回退到空值，此断言必须失败；词条只影响展示名称，不会按标题模糊匹配其他官方商品。
    const store = new InMemoryGameNameStore();
    store.seedCatalog({
      identityKey,
      displayNameZhCn: "胡闹厨房 2",
      source: "publisher",
      evidenceUrl: "https://example.com/overcooked-2",
      confirmedAt: now,
    });
    const service = new GameNameService(store);

    expect(await service.resolveForConfirmedGame(identityKey, null)).toEqual({
      displayNameZhCn: "胡闹厨房 2",
      source: "catalog",
    });
  });

  it("不会把同标题不同发行商或类型的词条误命中", async () => {
    // 若实现只以标题检索，下面不同发行商的身份会错误取得“胡闹厨房 2”，从而把同名 DLC 或其他发行商商品误译为同一游戏。
    const store = new InMemoryGameNameStore();
    store.seedCatalog({
      identityKey,
      displayNameZhCn: "胡闹厨房 2",
      source: "publisher",
      evidenceUrl: null,
      confirmedAt: now,
    });
    const service = new GameNameService(store);

    expect(await service.resolveForConfirmedGame("overcooked 2|team17|game", null)).toEqual({
      displayNameZhCn: null,
      source: "pending",
    });
  });

  it("目录未命中时接受修剪后的管理员确认候选", async () => {
    // 若服务继续忽略 submittedName，新订阅确认即使经过官方锚点重验也只能停在 pending，管理员无法在同一次确认中补足展示名称。
    const service = new GameNameService(new InMemoryGameNameStore());

    expect(await service.resolveForConfirmedGame(identityKey, "  胡闹厨房 2 人工确认  ")).toEqual({
      displayNameZhCn: "胡闹厨房 2 人工确认",
      source: "manual",
    });
  });

  it("词条命中时仍拒绝非法长度的管理员候选", async () => {
    // 若先查词条再校验候选，同一个非法浏览器请求会随目录是否命中产生不同结果，绕过数据库统一的 1..120 字符业务边界。
    const store = new InMemoryGameNameStore();
    store.seedCatalog({
      identityKey,
      displayNameZhCn: "胡闹厨房 2",
      source: "publisher",
      evidenceUrl: "https://example.com/overcooked-2",
      confirmedAt: now,
    });
    const service = new GameNameService(store);

    await expect(service.resolveForConfirmedGame(identityKey, "名".repeat(121)))
      .rejects.toThrow("中文显示名称长度应为 1 到 120 个字符。");
  });

  it("人工覆盖会将当前游戏从待处理列表移除", async () => {
    // 若保存路径只写词条而未确认当前游戏，待处理列表仍会包含该 ID，管理员会反复处理已经审计过的名称。
    const store = new InMemoryGameNameStore();
    const gameId = "game-overcooked-2";
    store.seedPending({
      gameId,
      subscriptionId: "subscription-overcooked-2",
      identityKey,
      officialTitle: "Overcooked! 2",
      publisher: "Ghost Town Games",
      productType: "game",
      legacyNameZh: "Overcooked! 2",
    });
    const service = new GameNameService(store);

    await service.saveManual(gameId, {
      displayNameZhCn: "胡闹厨房 2：美食家版",
      source: "manual",
      evidenceUrl: null,
      saveToCatalog: false,
    }, now);

    expect((await service.listPending()).map((item) => item.gameId)).not.toContain(gameId);
  });

  it("允许更正已确认游戏的人工名称并更新同身份目录", async () => {
    // 若保存路径只从 pending 列表找游戏，详情页中的已确认记录会被误报为 404，管理员无法纠正错别字或已过时的公开名称。
    // 该更正仍只使用已保存的精确 identityKey，不能由新名称、浏览器标题或历史 legacyNameZh 反向改变目录归属。
    const store = new InMemoryGameNameStore();
    store.seedConfirmedManual({
      gameId: "game-confirmed-correction",
      subscriptionId: "subscription-confirmed-correction",
      identityKey,
      officialTitle: "Overcooked! 2",
      publisher: "Ghost Town Games",
      productType: "game",
      legacyNameZh: "旧的中文候选",
      displayNameZhCn: "胡闹厨房 2（旧译）",
      confirmedAt: now,
    });
    const service = new GameNameService(store);

    await service.saveManual("game-confirmed-correction", {
      displayNameZhCn: "胡闹厨房 2：美食家版",
      source: "publisher",
      evidenceUrl: "https://example.com/overcooked-2-gourmet",
      saveToCatalog: true,
    }, "2026-08-10T01:00:00.000Z");

    expect(store.inspectGame("game-confirmed-correction")).toEqual({
      displayNameZhCn: "胡闹厨房 2：美食家版",
      state: "confirmed",
      source: "manual",
    });
    expect(await service.listPending()).toEqual([]);
    expect(await service.resolveForConfirmedGame(identityKey, null)).toEqual({
      displayNameZhCn: "胡闹厨房 2：美食家版",
      source: "catalog",
    });
  });

  it("拒绝修剪后为空的人工中文显示名称", async () => {
    // 若省略 trim 后长度校验，空白名称会被确认并从待办消失，造成无标题记录且无法追溯人工判定。
    const store = new InMemoryGameNameStore();
    store.seedPending({
      gameId: "game-invalid-name",
      subscriptionId: "subscription-invalid-name",
      identityKey,
      officialTitle: "Overcooked! 2",
      publisher: "Ghost Town Games",
      productType: "game",
      legacyNameZh: "Overcooked! 2",
    });
    const service = new GameNameService(store);

    await expect(service.saveManual("game-invalid-name", {
      displayNameZhCn: "   ",
      source: "manual",
      evidenceUrl: null,
      saveToCatalog: false,
    }, now)).rejects.toThrow("中文显示名称长度应为 1 到 120 个字符。");
  });

  it("拒绝超过 120 个字符的人工中文显示名称", async () => {
    // 若服务未在数据库写入前守住上界，超长文本会在管理操作后才以底层约束错误失败，且无法给调用方稳定的可修正文案。
    const store = new InMemoryGameNameStore();
    store.seedPending({
      gameId: "game-overlong-name",
      subscriptionId: "subscription-overlong-name",
      identityKey,
      officialTitle: "Overcooked! 2",
      publisher: "Ghost Town Games",
      productType: "game",
      legacyNameZh: "Overcooked! 2",
    });
    const service = new GameNameService(store);

    await expect(service.saveManual("game-overlong-name", {
      displayNameZhCn: "名".repeat(121),
      source: "manual",
      evidenceUrl: null,
      saveToCatalog: false,
    }, now)).rejects.toThrow("中文显示名称长度应为 1 到 120 个字符。");
  });

  it("目录回填只在首次命中空名称游戏时更新", async () => {
    // 若仓储每次回填都重复更新，confirmedAt 会不断漂移并把调度重试伪装成新的名称确认事件。
    const store = new InMemoryGameNameStore();
    store.seedCatalog({
      identityKey,
      displayNameZhCn: "胡闹厨房 2",
      source: "publisher",
      evidenceUrl: null,
      confirmedAt: now,
    });
    store.seedPending({
      gameId: "game-backfill",
      subscriptionId: "subscription-backfill",
      identityKey,
      officialTitle: "Overcooked! 2",
      publisher: "Ghost Town Games",
      productType: "game",
      legacyNameZh: "Overcooked! 2",
    });
    const service = new GameNameService(store);

    expect(await service.backfill(now)).toEqual({ updatedGameIds: ["game-backfill"], remainingCount: 0 });
    expect(await service.backfill("2026-08-10T01:00:00.000Z")).toEqual({ updatedGameIds: [], remainingCount: 0 });
  });

  it("保存词条只影响同一身份的未来建议且不改写已有人工名称", async () => {
    // 若词条回填覆盖 manual，管理员对某个具体游戏的复核会被后来通用建议抹掉，审计来源与显示文本将不再一致。
    const store = new InMemoryGameNameStore();
    const futureGameId = "game-future";
    store.seedConfirmedManual({
      gameId: "game-manual",
      subscriptionId: "subscription-manual",
      identityKey,
      officialTitle: "Overcooked! 2",
      publisher: "Ghost Town Games",
      productType: "game",
      legacyNameZh: "Overcooked! 2",
      displayNameZhCn: "人工核对名称",
      confirmedAt: now,
    });
    store.seedPending({
      gameId: futureGameId,
      subscriptionId: "subscription-future",
      identityKey,
      officialTitle: "Overcooked! 2",
      publisher: "Ghost Town Games",
      productType: "game",
      legacyNameZh: "Overcooked! 2",
    });
    const service = new GameNameService(store);

    await service.saveManual(futureGameId, {
      displayNameZhCn: "胡闹厨房 2",
      source: "publisher",
      evidenceUrl: "https://example.com/overcooked-2",
      saveToCatalog: true,
    }, now);

    expect(store.inspectGame("game-manual")).toEqual({
      displayNameZhCn: "人工核对名称",
      state: "confirmed",
      source: "manual",
    });
    expect(await service.resolveForConfirmedGame(identityKey, null)).toEqual({
      displayNameZhCn: "胡闹厨房 2",
      source: "catalog",
    });
  });

  it("拒绝非 HTTPS 的可审计证据链接", async () => {
    // 若接受 HTTP 或非 URL 文本，管理员无法将来源视为安全证据，且展示名称审计会把不可信链接带入后续界面。
    const store = new InMemoryGameNameStore();
    store.seedPending({
      gameId: "game-http-evidence",
      subscriptionId: "subscription-http-evidence",
      identityKey,
      officialTitle: "Overcooked! 2",
      publisher: "Ghost Town Games",
      productType: "game",
      legacyNameZh: "Overcooked! 2",
    });
    const service = new GameNameService(store);

    await expect(service.saveManual("game-http-evidence", {
      displayNameZhCn: "胡闹厨房 2",
      source: "publisher",
      evidenceUrl: "http://example.com/overcooked-2",
      saveToCatalog: true,
    }, now)).rejects.toThrow("名称证据链接必须使用 HTTPS。");
  });

  it("要求非人工来源提供 HTTPS 证据链接", async () => {
    // 若 publisher 等来源可无证据入库，未来自动回填无法追溯公开佐证，管理员也无法区分有来源词条与主观人工命名。
    const store = new InMemoryGameNameStore();
    store.seedPending({
      gameId: "game-missing-evidence",
      subscriptionId: "subscription-missing-evidence",
      identityKey,
      officialTitle: "Overcooked! 2",
      publisher: "Ghost Town Games",
      productType: "game",
      legacyNameZh: "Overcooked! 2",
    });
    const service = new GameNameService(store);

    await expect(service.saveManual("game-missing-evidence", {
      displayNameZhCn: "胡闹厨房 2",
      source: "publisher",
      evidenceUrl: null,
      saveToCatalog: true,
    }, now)).rejects.toThrow("非人工名称来源必须提供 HTTPS 证据链接。");
  });
});
