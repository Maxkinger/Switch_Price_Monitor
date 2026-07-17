import type { OfficialProductCandidate, OfficialProductSearch, OfficialSearchResult } from "../../shared/domain";
import { ProviderNetworkError, type ProductType } from "./types";

/** 任天堂美区官网公开搜索页当前使用的只读搜索端点；该端点只承载官网公开商品索引，不是价格回退来源。 */
const officialUsSearchEndpoint = "https://U3B6GR4UA3-dsn.algolia.net/1/indexes/*/queries";

/**
 * 此值来自任天堂美区公开搜索页面的浏览器配置，属于公开检索配置而非本系统或用户的秘密。
 * 它只允许在 Worker 内请求官网同一公开索引，绝不返回浏览器、写入 D1、记录日志或用于任何第三方价格站。
 */
const officialUsPublicSearchKey = "a29c6927638bfd8cee23993e51e721c9";

/** 美区游戏候选索引按官网约定附加语言和国家后缀，禁止借此索引搜索其他地区。 */
const officialUsGameIndex = "store_game_en_us";

/** 官方候选只使用本区主机上的相对或绝对商品地址，阻止公开搜索返回的意外外链进入管理员确认流程。 */
const officialUsStoreOrigin = "https://www.nintendo.com";

/** 与现有订阅确认路由保持一致的受控商品类别；未知类别不能被当作游戏、本体或升级包保存。 */
const supportedProductTypes: readonly ProductType[] = ["game", "upgrade-pack", "dlc", "season-pass", "bundle", "other"];

/**
 * 任天堂美区官网公开搜索适配器。它只处理已经验证字段结构的美区游戏索引；其他地区一律返回官方链接确认提示，
 * 避免把美区索引或任何第三方数据错误用于香港、日区、墨西哥区和巴西区的商品匹配。
 */
export function createOfficialNintendoSearch(fetchOfficialSearch: typeof fetch = fetch, timeoutMs = 12_000): OfficialProductSearch {
  return {
    async search(regionCode, query, signal) {
      if (regionCode !== "US") return unavailableSearch();

      let response: Response;
      // 公开 Algolia 索引偶发保持连接但不返回；独立控制器把超时与调用方取消合并，避免管理员页面永久停在“搜索中”。
      const timeoutController = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; timeoutController.abort(); }, timeoutMs);
      const forwardAbort = () => timeoutController.abort();
      signal.addEventListener("abort", forwardAbort, { once: true });
      try {
        // 搜索请求只发送用户输入的名称和官网固定索引；不附带 Cookie、Nintendo Account、购买记录或浏览器会话。
        response = await fetchOfficialSearch(officialUsSearchEndpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-algolia-application-id": "U3B6GR4UA3",
            "x-algolia-api-key": officialUsPublicSearchKey,
          },
          body: JSON.stringify({
            requests: [{ indexName: officialUsGameIndex, query, params: "hitsPerPage=20" }],
          }),
          signal: timeoutController.signal,
        });
      } catch (error) {
        // 超时与 HTTP 非成功一样只能证明自动搜索不可用；返回官方链接入口能让管理员继续完成验证流程。
        if (timedOut) return unavailableSearch();
        // 只有连接、DNS 或中止等传输失败才作为网络错误上抛，路由可将其安全转换为官方链接确认提示。
        throw new ProviderNetworkError(error instanceof Error ? error.message : "official Nintendo search request failed");
      } finally {
        // 每次请求都清理计时器和监听器，避免已完成搜索在后续无意义地触发中止或累积 Worker 资源。
        clearTimeout(timeout);
        signal.removeEventListener("abort", forwardAbort);
      }

      // 非成功状态无法证明候选字段可信，必须退回人工官方链接而不是把 HTTP 错误页解析成“无结果”。
      if (!response.ok) return unavailableSearch();
      return { status: "available", candidates: parseUsOfficialSearch(await response.json()) };
    },
  };
}

/** 将无搜索适配器、HTTP 失败和页面变更统一为可操作的安全状态，不泄露外部响应或内部请求细节。 */
function unavailableSearch(): OfficialSearchResult {
  return { status: "unavailable", message: "该区官方搜索暂不可用，请粘贴任天堂官方商品链接。" };
}

/**
 * 将任天堂官网公开搜索响应收窄为商品候选。响应是外部数据，即使来自官网也不能信任其字段类型、价格或链接；
 * 每条命中独立拒绝，保留其余可验证候选，避免一条异常记录阻断管理员查看正常搜索结果。
 */
function parseUsOfficialSearch(value: unknown): OfficialProductCandidate[] {
  if (!isRecord(value) || !Array.isArray(value.results)) return [];
  return value.results.flatMap((result) => isRecord(result) && Array.isArray(result.hits)
    ? result.hits.flatMap((hit) => {
      const candidate = toUsCandidate(hit);
      return candidate ? [candidate] : [];
    })
    : []);
}

/** 从单条搜索命中读取所有受控字段；只要身份、币种、价格精度或官方主机有一个不成立就拒绝该候选。 */
function toUsCandidate(value: unknown): OfficialProductCandidate | null {
  if (!isRecord(value)) return null;
  // 任天堂 2026 年公开索引以 url/title/eshopDetails 表示商品；不可回退读取旧字段，避免结构变化时误把不完整命中写入确认流程。
  const productUrl = readOfficialUsProductUrl(value.url);
  const canonicalTitle = readNonEmptyString(value.title);
  const productType = readUsProductType(value);
  const price = readUsPrice(value.eshopDetails);
  if (!productUrl || !canonicalTitle || !productType || !price) return null;
  return {
    regionCode: "US",
    productUrl,
    canonicalTitle,
    publisher: readNonEmptyString(value.softwarePublisher),
    productType,
    currency: "USD",
    coverUrl: readOfficialCoverUrl(value.productImageSquare),
    currentPriceMinor: price.currentPriceMinor,
    regularPriceMinor: price.regularPriceMinor,
  };
}

/**
 * 只接受 Nintendo 美区商店链接。相对链接会补齐固定官网主机，绝对链接则必须精确匹配主机与 `/us/` 前缀，
 * 防止搜索索引的错误字段把外部页面带入下一阶段的 Worker 解析请求。
 */
function readOfficialUsProductUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value, officialUsStoreOrigin);
    if (url.protocol !== "https:" || url.origin !== officialUsStoreOrigin || !url.pathname.startsWith("/us/")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** 封面仅在 HTTPS 下回传；图片缺失或异常时保留 null，让前端使用本地占位封面而非尝试加载不可信地址。 */
function readOfficialCoverUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * 美区公开索引把价格放在 eshopDetails 且以美元主单位（例如 9.99）返回；系统内部统一使用分，
 * 因此必须先验证精确到美分的安全数值。常规价是候选身份核对所需的基线，缺失时不伪造当前价。
 */
function readUsPrice(value: unknown): { currentPriceMinor: number; regularPriceMinor: number | null } | null {
  if (!isRecord(value) || value.currency !== "USD") return null;
  const regularPriceMinor = readUsdMajorAmount(value.regularPrice);
  if (regularPriceMinor === null) return null;
  const discountPriceMinor = value.discountPrice === null ? null : readUsdMajorAmount(value.discountPrice);
  if (discountPriceMinor === null && value.discountPrice !== null) return null;
  const currentPriceMinor = discountPriceMinor ?? regularPriceMinor;
  // 任天堂公开折扣价不应高于常规价；相反值表示响应异常，不能进入后续历史最低价或折扣展示。
  if (currentPriceMinor > regularPriceMinor) return null;
  return { currentPriceMinor, regularPriceMinor };
}

/**
 * 官网索引使用商城枚举而不是持久化商品类别。升级标记优先于 TITLE，随后把受控商城类型映射到领域枚举；
 * 未知值一律拒绝，防止把临时营销分类、DLC 或本体混淆后保存为错误订阅。
 */
function readUsProductType(value: Record<string, unknown>): ProductType | null {
  if (value.isUpgrade === true) return "upgrade-pack";
  const details = value.eshopDetails;
  if (!isRecord(details) || typeof details.productType !== "string") return null;
  if (details.productType === "TITLE") return "game";
  if (details.productType === "BUNDLE") return "bundle";
  if (details.productType === "DLC") {
    return value.dlcType === "Expansion Pass" || value.dlcType === "Season Pass" ? "season-pass" : "dlc";
  }
  return null;
}

/** 公开搜索文本字段只接受去除空白后仍有内容的字符串，拒绝对象、数组和空字符串的隐式转换。 */
function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** 将任天堂美元主单位安全转换为分；超过两位小数或超出安全整数范围的金额不可信，不能参与价格比较。 */
function readUsdMajorAmount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const minor = Math.round(value * 100);
  return Number.isSafeInteger(minor) && Math.abs(value - minor / 100) < 0.000_001 ? minor : null;
}

/** 将外部 JSON 收窄为普通对象，避免数组、null 或带原型对象绕过字段验证。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
