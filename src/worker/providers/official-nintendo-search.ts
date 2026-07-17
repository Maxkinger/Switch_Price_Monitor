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
export function createOfficialNintendoSearch(fetchOfficialSearch: typeof fetch = fetch): OfficialProductSearch {
  return {
    async search(regionCode, query, signal) {
      if (regionCode !== "US") return unavailableSearch();

      let response: Response;
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
          signal,
        });
      } catch (error) {
        // 只有连接、DNS 或中止等传输失败才作为网络错误上抛，路由可将其安全转换为官方链接确认提示。
        throw new ProviderNetworkError(error instanceof Error ? error.message : "official Nintendo search request failed");
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
  const productUrl = readOfficialUsProductUrl(value.productLink);
  const canonicalTitle = readNonEmptyString(value.productTitle);
  const productType = readProductType(value.productType);
  const price = readUsPrice(value.price);
  if (!productUrl || !canonicalTitle || !productType || !price) return null;
  return {
    regionCode: "US",
    productUrl,
    canonicalTitle,
    publisher: readNonEmptyString(value.publisher),
    productType,
    currency: "USD",
    coverUrl: readOfficialCoverUrl(value.imageUrl),
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

/** 价格必须是美元分的非负安全整数；没有已验证当前价时整条命中拒绝，避免页面显示推测金额。 */
function readUsPrice(value: unknown): { currentPriceMinor: number; regularPriceMinor: number | null } | null {
  if (!isRecord(value) || value.currency !== "USD" || !isMinorAmount(value.salePrice)) return null;
  if (value.regPrice !== undefined && !isMinorAmount(value.regPrice)) return null;
  return { currentPriceMinor: value.salePrice, regularPriceMinor: value.regPrice ?? null };
}

/** 商品类型必须来自既有持久化枚举，不能将任天堂临时展示标签直接写入订阅确认模型。 */
function readProductType(value: unknown): ProductType | null {
  return typeof value === "string" && supportedProductTypes.includes(value as ProductType) ? value as ProductType : null;
}

/** 公开搜索文本字段只接受去除空白后仍有内容的字符串，拒绝对象、数组和空字符串的隐式转换。 */
function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** 美区搜索结果以分为单位，必须为非负安全整数，避免浮点价格污染历史最低价与折扣计算。 */
function isMinorAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** 将外部 JSON 收窄为普通对象，避免数组、null 或带原型对象绕过字段验证。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
