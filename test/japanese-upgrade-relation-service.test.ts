import { describe, expect, it, vi } from "vitest";

import type { OfficialProductCandidate } from "../src/shared/domain";
import { JapaneseUpgradeBatchLimitError } from "../src/worker/providers/japanese-upgrade-browser";
import type { JapaneseUpgradeRootCandidate } from "../src/worker/providers/official-japanese-upgrade-root";
import {
  createJapaneseUpgradeRelationService,
  japaneseUpgradeConfirmationKey,
} from "../src/worker/services/japanese-upgrade-relation-service";
import { officialCandidateKey } from "../src/worker/services/official-product-discovery-service";

/**
 * 关系服务测试只替换三个窄外部边界；断言始终针对服务输出的候选或拒绝结论，
 * 不依赖真实任天堂网络、Browser Run 会话或管理员数据，因此可重复验证安全降级规则。
 */
describe("Japanese upgrade relation service", () => {
  it("builds an automatic candidate only from root, unique browser relation and matching JPY quote", async () => {
    // 自动候选的标题、发行商和价格必须全部重新来自官方根、Browser 关系与报价，不能沿用美区锚点的展示或金额。
    const anchor = overcookedUpgradeUs();
    const root = overcookedRoot();
    const service = createJapaneseUpgradeRelationService(
      { search: vi.fn().mockResolvedValue(root) },
      { resolve: vi.fn().mockResolvedValue(new Map([[root.productUrl, { status: "success", upgradeUrl }]])) },
      { resolve: vi.fn().mockResolvedValue(validQuote()) },
    );

    await expect(service.discover([anchor])).resolves.toEqual(new Map([[
      officialCandidateKey(anchor),
      { status: "automatic", candidate: overcookedUpgradeJp() },
    ]]));
  });

  it("isolates root, browser, and quote failures so every discovery anchor receives a safe result", async () => {
    // 单项外部失败不能中断同批其他锚点；失败项固定要求人工链接，避免向页面泄漏上游异常正文。
    const first = overcookedUpgradeUs({ productUrl: "https://www.nintendo.com/us/store/products/first-upgrade-pack/" });
    const second = overcookedUpgradeUs({ productUrl: "https://www.nintendo.com/us/store/products/second-upgrade-pack/" });
    const firstRoot = overcookedRoot({ productUrl: "https://store-jp.nintendo.com/item/software/D70010000106253/" });
    const roots = {
      search: vi.fn(async (anchor: OfficialProductCandidate) => anchor.productUrl === first.productUrl ? firstRoot : Promise.reject(new Error("root detail"))),
    };
    const service = createJapaneseUpgradeRelationService(
      roots,
      { resolve: vi.fn().mockResolvedValue(new Map([[firstRoot.productUrl, { status: "success", upgradeUrl }]])) },
      { resolve: vi.fn().mockRejectedValue(new Error("price detail")) },
    );

    await expect(service.discover([first, second])).resolves.toEqual(new Map([
      [officialCandidateKey(first), { status: "needs-manual-link", message: manualMessage }],
      [officialCandidateKey(second), { status: "needs-manual-link", message: manualMessage }],
    ]));
  });

  it("deduplicates shared roots before one browser batch while retaining a result for every anchor", async () => {
    // 不同锚点可经唯一根检索落到同一日区本体；Browser Run 每个入口最多一次，结果仍须按锚点分别返回。
    const first = overcookedUpgradeUs({ productUrl: "https://www.nintendo.com/us/store/products/first-upgrade-pack/" });
    const second = overcookedUpgradeUs({ productUrl: "https://www.nintendo.com/us/store/products/second-upgrade-pack/" });
    const root = overcookedRoot();
    const browser = { resolve: vi.fn().mockResolvedValue(new Map([[root.productUrl, { status: "success", upgradeUrl }]])) };
    const service = createJapaneseUpgradeRelationService(
      { search: vi.fn().mockResolvedValue(root) },
      browser,
      { resolve: vi.fn().mockResolvedValue(validQuote()) },
    );

    const result = await service.discover([first, second]);

    expect(browser.resolve).toHaveBeenCalledTimes(1);
    expect(browser.resolve.mock.calls[0]?.[0]).toEqual([root]);
    expect(result.get(officialCandidateKey(first))).toEqual({ status: "automatic", candidate: overcookedUpgradeJp() });
    expect(result.get(officialCandidateKey(second))).toEqual({ status: "automatic", candidate: overcookedUpgradeJp() });
  });

  it("returns an empty discovery map without starting root or browser work", async () => {
    // 空批次不应占用官网搜索或 Browser Run 配额，避免前端空状态产生无意义的外部调用。
    const roots = { search: vi.fn() };
    const browser = { resolve: vi.fn() };
    const service = createJapaneseUpgradeRelationService(roots, browser, { resolve: vi.fn() });

    await expect(service.discover([])).resolves.toEqual(new Map());
    expect(roots.search).not.toHaveBeenCalled();
    expect(browser.resolve).not.toHaveBeenCalled();
  });

  it("rejects four discovery anchors before root or browser calls", async () => {
    // 三项是一次请求可使用的深度核验硬上限，超过时必须整体拒绝，不能静默处理前几项或已启动浏览器。
    const roots = { search: vi.fn() };
    const browser = { resolve: vi.fn() };
    const service = createJapaneseUpgradeRelationService(roots, browser, { resolve: vi.fn() });
    const anchors = Array.from({ length: 4 }, (_, index) => overcookedUpgradeUs({
      productUrl: `https://www.nintendo.com/us/store/products/overcooked-${index}-upgrade-pack/`,
    }));

    await expect(service.discover(anchors)).rejects.toBeInstanceOf(JapaneseUpgradeBatchLimitError);
    expect(roots.search).not.toHaveBeenCalled();
    expect(browser.resolve).not.toHaveBeenCalled();
  });

  it("rejects duplicate discovery keys before root, browser, or price work", async () => {
    // 相同地区和官方 URL 会映射为同一结果键；必须整体拒绝而非并发覆盖，避免后一项污染前一项的候选状态。
    const roots = { search: vi.fn() };
    const browser = { resolve: vi.fn() };
    const prices = { resolve: vi.fn() };
    const service = createJapaneseUpgradeRelationService(roots, browser, prices);
    const anchor = overcookedUpgradeUs();

    await expect(service.discover([anchor, { ...anchor }])).rejects.toBeInstanceOf(JapaneseUpgradeBatchLimitError);
    expect(roots.search).not.toHaveBeenCalled();
    expect(browser.resolve).not.toHaveBeenCalled();
    expect(prices.resolve).not.toHaveBeenCalled();
  });

  it("resolves a manual canonical link from root identity and an exact JPY quote without Browser Run", async () => {
    // 人工输入仅能是完全 canonical 的日区软件链接；候选阶段不调用浏览器，最终关系仍由保存前复核负责。
    const root = overcookedRoot();
    const browser = { resolve: vi.fn() };
    const service = createJapaneseUpgradeRelationService(
      { search: vi.fn().mockResolvedValue(root) },
      browser,
      { resolve: vi.fn().mockResolvedValue(validQuote()) },
    );

    await expect(service.resolveManual(overcookedUpgradeUs(), upgradeUrl)).resolves.toEqual(overcookedUpgradeJp());
    expect(browser.resolve).not.toHaveBeenCalled();
  });

  it("rejects manual links whose original spelling, quote identity, or upgrade anchor is not safe", async () => {
    // URL 规范化不能把非 canonical 输入悄悄改写为可保存链接；同一 ID、日元和升级包身份缺一不可。
    const roots = { search: vi.fn().mockResolvedValue(overcookedRoot()) };
    const prices = { resolve: vi.fn().mockResolvedValue({ ...validQuote(), officialPriceId: "70050000064986" }) };
    const service = createJapaneseUpgradeRelationService(roots, { resolve: vi.fn() }, prices);

    await expect(service.resolveManual(overcookedUpgradeUs(), "https://store-jp.nintendo.com/item/software/D70050000064985")).resolves.toBeNull();
    await expect(service.resolveManual(overcookedUpgradeUs(), upgradeUrl)).resolves.toBeNull();
    await expect(service.resolveManual({ ...overcookedUpgradeUs(), productType: "game" }, upgradeUrl)).resolves.toBeNull();
  });

  it("keeps manual_link only when Browser Run fails but the exact JPY quote is valid", async () => {
    // Browser Run 的受控失败状态不能抹掉管理员已经粘贴的严格官方链接；返回值必须保留 manual 语义而非升级为自动。
    const anchor = overcookedUpgradeUs();
    const candidate = overcookedUpgradeJp();
    const item = { anchor, candidate, matchSource: "manual_link" as const };
    const root = overcookedRoot();
    const service = createJapaneseUpgradeRelationService(
      { search: vi.fn().mockResolvedValue(root) },
      { resolve: vi.fn().mockResolvedValue(new Map([[root.productUrl, { status: "timeout" }]])) },
      { resolve: vi.fn().mockResolvedValue(validQuote()) },
    );

    await expect(service.verifyForConfirmation([item])).resolves.toEqual(new Map([[
      japaneseUpgradeConfirmationKey(item),
      { status: "verified-manual", candidate: overcookedUpgradeJp() },
    ]]));
  });

  it("keeps manual_link when Browser Run successfully proves the same canonical URL", async () => {
    // Browser 成功支持管理员链接时只补强关系证据，审计来源仍须保持 manual_link，不能悄悄提升为 automatic。
    const item = { anchor: overcookedUpgradeUs(), candidate: overcookedUpgradeJp(), matchSource: "manual_link" as const };
    const root = overcookedRoot();
    const service = createJapaneseUpgradeRelationService(
      { search: vi.fn().mockResolvedValue(root) },
      { resolve: vi.fn().mockResolvedValue(new Map([[root.productUrl, { status: "success", upgradeUrl }]])) },
      { resolve: vi.fn().mockResolvedValue(validQuote()) },
    );

    await expect(service.verifyForConfirmation([item])).resolves.toEqual(new Map([[
      japaneseUpgradeConfirmationKey(item), { status: "verified-manual", candidate: overcookedUpgradeJp() },
    ]]));
  });

  it.each([
    ["equal regular price", validQuote({ currentPriceMinor: 700, regularPriceMinor: 700 }), { status: "needs-manual-link", message: manualMessage }],
    ["inverted regular price", validQuote({ currentPriceMinor: 701, regularPriceMinor: 700 }), { status: "needs-manual-link", message: manualMessage }],
    ["missing regular price", validQuote({ currentPriceMinor: 700, regularPriceMinor: null }), { status: "automatic", candidate: overcookedUpgradeJp({ regularPriceMinor: null }) }],
  ] as const)("uses strict JPY price ordering for %s", async (_name, quote, expected) => {
    // 同价或倒挂不能证明真实报价，只有 null 表示官方未提供常规价且仍可作为当前可购价格；断言服务输出而非替身调用次数。
    const root = overcookedRoot();
    const service = createJapaneseUpgradeRelationService(
      { search: vi.fn().mockResolvedValue(root) },
      { resolve: vi.fn().mockResolvedValue(new Map([[root.productUrl, { status: "success", upgradeUrl }]])) },
      { resolve: vi.fn().mockResolvedValue(quote) },
    );

    await expect(service.discover([overcookedUpgradeUs()])).resolves.toEqual(new Map([[
      officialCandidateKey(overcookedUpgradeUs()), expected,
    ]]));
  });

  it("marks a matching automatic relation verified only after root, canonical URL, and quote revalidation", async () => {
    // automatic 来源不能只相信浏览器提交的标志；根身份和报价刷新后仍需 Browser 成功且 URL 与提交候选逐字相同。
    const item = { anchor: overcookedUpgradeUs(), candidate: overcookedUpgradeJp(), matchSource: "automatic" as const };
    const root = overcookedRoot();
    const service = createJapaneseUpgradeRelationService(
      { search: vi.fn().mockResolvedValue(root) },
      { resolve: vi.fn().mockResolvedValue(new Map([[root.productUrl, { status: "success", upgradeUrl }]])) },
      { resolve: vi.fn().mockResolvedValue(validQuote({ currentPriceMinor: 650, regularPriceMinor: 1000 })) },
    );

    await expect(service.verifyForConfirmation([item])).resolves.toEqual(new Map([[
      japaneseUpgradeConfirmationKey(item),
      { status: "verified-automatic", candidate: overcookedUpgradeJp({ currentPriceMinor: 650, regularPriceMinor: 1000 }) },
    ]]));
  });

  it.each(["browser-unavailable", "timeout", "blocked-or-missing", "multiple-matches", "invalid-official-url"] as const)(
    "rejects automatic confirmation on %s",
    async (status) => {
      // 自动来源只接受 Browser 成功的唯一官方关系；所有安全失败状态都必须在保存前被拒绝，不能降格成自动候选。
      const anchor = overcookedUpgradeUs();
      const candidate = overcookedUpgradeJp();
      const root = overcookedRoot();
      const service = createJapaneseUpgradeRelationService(
        { search: async () => root },
        { resolve: async () => new Map([[root.productUrl, { status }]]) },
        { resolve: async () => validQuote() },
      );
      const item = { anchor, candidate, matchSource: "automatic" as const };

      await expect(service.verifyForConfirmation([item])).resolves.toEqual(new Map([[
        japaneseUpgradeConfirmationKey(item), { status: "rejected" },
      ]]));
    },
  );

  it("rejects a manual link when Browser Run succeeds with a different URL", async () => {
    // 人工链接只能在浏览器证明同一 URL 或无法安全取得关系时保存；成功指向另一升级包是明确反证，不能回退人工通过。
    const item = { anchor: overcookedUpgradeUs(), candidate: overcookedUpgradeJp(), matchSource: "manual_link" as const };
    const root = overcookedRoot();
    const service = createJapaneseUpgradeRelationService(
      { search: vi.fn().mockResolvedValue(root) },
      { resolve: vi.fn().mockResolvedValue(new Map([[root.productUrl, {
        status: "success", upgradeUrl: "https://store-jp.nintendo.com/item/software/D70050000064986/",
      }]])) },
      { resolve: vi.fn().mockResolvedValue(validQuote()) },
    );

    await expect(service.verifyForConfirmation([item])).resolves.toEqual(new Map([[
      japaneseUpgradeConfirmationKey(item), { status: "rejected" },
    ]]));
  });

  it("rejects invalid confirmation fields before starting root or browser work", async () => {
    // manual_selection 不属于日区升级人工链接流程；候选的地区、货币、类型或非 canonical URL 也不能接触外部核验边界。
    const roots = { search: vi.fn() };
    const browser = { resolve: vi.fn() };
    const service = createJapaneseUpgradeRelationService(roots, browser, { resolve: vi.fn() });
    const invalid = {
      anchor: overcookedUpgradeUs(),
      candidate: overcookedUpgradeJp({ productUrl: "https://store-jp.nintendo.com/item/software/D70050000064985" }),
      matchSource: "manual_selection" as const,
    };

    await expect(service.verifyForConfirmation([invalid])).resolves.toEqual(new Map([[
      japaneseUpgradeConfirmationKey(invalid), { status: "rejected" },
    ]]));
    expect(roots.search).not.toHaveBeenCalled();
    expect(browser.resolve).not.toHaveBeenCalled();
  });

  it("deduplicates confirmation roots, writes every result, and rejects a browser batch exception without details", async () => {
    // 批处理基础设施异常不是可用于人工兜底的单项状态；所有待核验项都要有确定拒绝结果，且共享根仅传给 Browser 一次。
    const root = overcookedRoot();
    const first = { anchor: overcookedUpgradeUs(), candidate: overcookedUpgradeJp(), matchSource: "automatic" as const };
    const second = {
      anchor: overcookedUpgradeUs({ productUrl: "https://www.nintendo.com/us/store/products/overcooked-second-upgrade-pack/" }),
      candidate: overcookedUpgradeJp(),
      matchSource: "manual_link" as const,
    };
    const browser = { resolve: vi.fn().mockRejectedValue(new Error("browser detail must not leak")) };
    const service = createJapaneseUpgradeRelationService(
      { search: vi.fn().mockResolvedValue(root) },
      browser,
      { resolve: vi.fn().mockResolvedValue(validQuote()) },
    );

    await expect(service.verifyForConfirmation([first, second])).resolves.toEqual(new Map([
      [japaneseUpgradeConfirmationKey(first), { status: "rejected" }],
      [japaneseUpgradeConfirmationKey(second), { status: "rejected" }],
    ]));
    expect(browser.resolve).toHaveBeenCalledTimes(1);
    expect(browser.resolve.mock.calls[0]?.[0]).toEqual([root]);
  });

  it("rejects four confirmation items before root or browser calls and skips all dependencies for empty input", async () => {
    // 确认入口与发现入口共享三项上限和空批次节流，避免恶意大批量提交先消耗 Browser Run 再报错。
    const roots = { search: vi.fn() };
    const browser = { resolve: vi.fn() };
    const service = createJapaneseUpgradeRelationService(roots, browser, { resolve: vi.fn() });
    const item = { anchor: overcookedUpgradeUs(), candidate: overcookedUpgradeJp(), matchSource: "automatic" as const };

    await expect(service.verifyForConfirmation([])).resolves.toEqual(new Map());
    await expect(service.verifyForConfirmation(Array.from({ length: 4 }, () => item))).rejects.toBeInstanceOf(JapaneseUpgradeBatchLimitError);
    expect(roots.search).not.toHaveBeenCalled();
    expect(browser.resolve).not.toHaveBeenCalled();
  });

  it("rejects duplicate confirmation keys before root, browser, or price work", async () => {
    // 相同锚点、候选 URL 和来源若重复，Map 无法表达两个独立结果；提前拒绝可防止第二项静默覆盖第一项。
    const roots = { search: vi.fn() };
    const browser = { resolve: vi.fn() };
    const prices = { resolve: vi.fn() };
    const service = createJapaneseUpgradeRelationService(roots, browser, prices);
    const item = { anchor: overcookedUpgradeUs(), candidate: overcookedUpgradeJp(), matchSource: "automatic" as const };

    await expect(service.verifyForConfirmation([item, { ...item }])).rejects.toBeInstanceOf(JapaneseUpgradeBatchLimitError);
    expect(roots.search).not.toHaveBeenCalled();
    expect(browser.resolve).not.toHaveBeenCalled();
    expect(prices.resolve).not.toHaveBeenCalled();
  });
});

/** 浏览器和价格 API 都以此严格 canonical 日区路径为共同身份；D 后纯数字同时是官方报价 ID。 */
const upgradeUrl = "https://store-jp.nintendo.com/item/software/D70050000064985/";

/** 前端已在默认区确认的升级包锚点；服务只能以它的升级类型启动日区关系发现。 */
function overcookedUpgradeUs(overrides: Partial<OfficialProductCandidate> = {}): OfficialProductCandidate {
  return {
    regionCode: "US",
    productUrl: "https://www.nintendo.com/us/store/products/overcooked-2-nintendo-switch-2-edition-upgrade-pack-switch-2/",
    canonicalTitle: "Overcooked! 2 – Nintendo Switch 2 Edition Upgrade Pack",
    publisher: "Team17",
    productType: "upgrade-pack",
    currency: "USD",
    coverUrl: null,
    currentPriceMinor: 999,
    regularPriceMinor: null,
    ...overrides,
  };
}

/** 官方日区检索已唯一确认的可购买本体；其身份字段是最终升级包候选唯一可信的标题与发行商来源。 */
function overcookedRoot(overrides: Partial<JapaneseUpgradeRootCandidate> = {}): JapaneseUpgradeRootCandidate {
  return {
    productUrl: "https://store-jp.nintendo.com/item/software/D70010000106252/",
    canonicalTitle: "Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition",
    publisher: "Team17",
    ...overrides,
  };
}

/** 期望的 JP 候选刻意固定封面为空，防止不存在公开证据的图片字段被管理员提交内容污染。 */
function overcookedUpgradeJp(overrides: Partial<OfficialProductCandidate> = {}): OfficialProductCandidate {
  return {
    regionCode: "JP",
    productUrl: upgradeUrl,
    canonicalTitle: "Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition アップグレードパス",
    publisher: "Team17",
    productType: "upgrade-pack",
    currency: "JPY",
    coverUrl: null,
    currentPriceMinor: 700,
    regularPriceMinor: 1000,
    ...overrides,
  };
}

/** 价格夹具保留解析器的完整公开报价形状，方便各测试只替换与安全判定直接相关的字段。 */
function validQuote(overrides: { officialPriceId?: string; currency?: "JPY"; currentPriceMinor?: number; regularPriceMinor?: number | null } = {}) {
  return {
    officialPriceId: "70050000064985",
    currency: "JPY" as const,
    currentPriceMinor: 700,
    regularPriceMinor: 1000,
    ...overrides,
  };
}

/** 人工降级文案是产品已确认的稳定 UI 契约，测试以固定值防止外部错误内容进入界面。 */
const manualMessage = "日区自动核验暂不可用，请重新核验或粘贴官方链接。";
