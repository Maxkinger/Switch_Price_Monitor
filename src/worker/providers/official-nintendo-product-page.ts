import type { OfficialProductCandidate, RegionCode } from "../../shared/domain";
import { ProviderNetworkError, type ProductType } from "./types";

/** 官方商品 URL 规则只允许精确的主机和路径组合，避免管理员输入把 Worker 变成访问任意主机的请求代理。 */
interface OfficialProductUrlRule {
  readonly hostname: string;
  readonly pathnamePrefix: string;
}

/** 每区货币与其已验证的任天堂官方商品入口。港区官网搜索明确返回 ec.nintendo.com 链接，因此该入口必须单独白名单化。 */
const officialRegionRules: Record<RegionCode, { currency: string; productUrls: readonly OfficialProductUrlRule[] }> = {
  US: { currency: "USD", productUrls: [{ hostname: "www.nintendo.com", pathnamePrefix: "/us/" }] },
  JP: { currency: "JPY", productUrls: [{ hostname: "store-jp.nintendo.com", pathnamePrefix: "/item/software/" }] },
  MX: { currency: "MXN", productUrls: [{ hostname: "www.nintendo.com", pathnamePrefix: "/es-mx/" }] },
  BR: { currency: "BRL", productUrls: [{ hostname: "www.nintendo.com", pathnamePrefix: "/pt-br/" }] },
  HK: {
    currency: "HKD",
    productUrls: [
      { hostname: "www.nintendo.com", pathnamePrefix: "/hk/" },
      { hostname: "ec.nintendo.com", pathnamePrefix: "/HK/zh/titles/" },
    ],
  },
};

/** 候选只接受系统可持久化的商品类别，避免官网临时营销标签混入本体、DLC 与升级包匹配。 */
const supportedProductTypes: readonly ProductType[] = ["game", "upgrade-pack", "dlc", "season-pass", "bundle", "other"];

/** 供发现服务注入的官方商品页解析契约；返回 null 表示公开页面无法证明该候选，不产生任何持久化副作用。 */
export interface OfficialNintendoProductPageResolver {
  resolve(regionCode: RegionCode, productUrl: string, signal: AbortSignal): Promise<OfficialProductCandidate | null>;
}

/**
 * 读取管理员提交的任天堂官方商品页公开 JSON-LD 或港区 eShop 元数据。解析器只在地区主机、路径前缀与币种同时吻合时返回候选，
 * 使官方搜索交回的香港 eShop 链接也可被重新验证，同时不会把任意网页或跨区价格当作本区商品。
 */
export function createOfficialNintendoProductPageResolver(fetchPage: typeof fetch = fetch): OfficialNintendoProductPageResolver {
  return {
    async resolve(regionCode, productUrl, signal) {
      if (!isOfficialNintendoProductUrl(regionCode, productUrl)) return null;
      let response: Response;
      try {
        // 仅请求已验证的公开官方 HTTPS 页面，不发送 Cookie、Nintendo Account、购买状态或浏览器会话。
        response = await fetchPage(productUrl, { headers: { accept: "text/html,application/xhtml+xml" }, signal });
      } catch (error) {
        // 传输失败交由服务/路由转换成安全中文提示；解析异常则以 null 表示本页不够可信，避免重试无效内容。
        throw new ProviderNetworkError(error instanceof Error ? error.message : "official Nintendo product page request failed");
      }
      if (!response.ok) return null;
      const html = await response.text();
      return parseOfficialProductPage(html, regionCode, productUrl) ?? parseHongKongEshopProductPage(html, regionCode, productUrl);
    },
  };
}

/**
 * 验证 URL 的协议、精确主机和地区路径。显式白名单而非 `endsWith` 比较可阻止 `nintendo.com.example` 等子域名伪装，
 * 并要求具体地区的页面路径，防止把首页、搜索页或另一服商品页请求并误解析。
 */
export function isOfficialNintendoProductUrl(regionCode: RegionCode, productUrl: string): boolean {
  try {
    const rules = officialRegionRules[regionCode].productUrls;
    const url = new URL(productUrl);
    return url.protocol === "https:" && rules.some((rule) => url.hostname === rule.hostname && url.pathname.startsWith(rule.pathnamePrefix));
  } catch {
    return false;
  }
}

/** 从公开 JSON-LD 中找出匹配 Product 节点；页面中其他结构化节点不能提供候选身份或价格。 */
function parseOfficialProductPage(html: string, regionCode: RegionCode, productUrl: string): OfficialProductCandidate | null {
  const scripts = html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const script of scripts) {
    const document = parseJsonObject(script[1]);
    if (!document) continue;
    for (const product of productEntries(document)) {
      const candidate = toCandidate(product, regionCode, productUrl);
      if (candidate) return candidate;
    }
  }
  return null;
}

/**
 * 港区 eShop 的公开商品页当前暴露 `search.*` 元标签而非可用的 Product JSON-LD。
 * 缺少官方可验证报价时仍返回 null 价格：该候选只能用于身份确认，不能伪造折扣、历史最低价或采集快照。
 */
function parseHongKongEshopProductPage(html: string, regionCode: RegionCode, productUrl: string): OfficialProductCandidate | null {
  if (regionCode !== "HK" || !isHongKongEshopProductUrl(productUrl)) return null;
  const title = readMetaContent(html, "search.name");
  if (!title) return null;
  return {
    regionCode,
    productUrl,
    canonicalTitle: title,
    publisher: readMetaContent(html, "search.publisher"),
    productType: classifyProductType(title),
    currency: officialRegionRules.HK.currency,
    coverUrl: readCoverUrl(readMetaContent(html, "search.thumbnail")),
    currentPriceMinor: null,
    regularPriceMinor: null,
  };
}

/** eShop 兜底解析只承认港区精确的大小写路径，避免同一主机上的账户、购买或其他国家页面被误作商品页。 */
function isHongKongEshopProductUrl(productUrl: string): boolean {
  try {
    const url = new URL(productUrl);
    return url.protocol === "https:" && url.hostname === "ec.nintendo.com" && /^\/HK\/zh\/titles\/\d+$/.test(url.pathname);
  } catch {
    return false;
  }
}

/** 只从单个 meta 标签读取被命名的公开字段；避免用整页正则猜测标题、发行商或价格。 */
function readMetaContent(html: string, name: string): string | null {
  for (const match of html.matchAll(/<meta\b([^>]*)>/gi)) {
    if (readHtmlAttribute(match[1], "name") !== name) continue;
    return readNonEmptyString(readHtmlAttribute(match[1], "content"));
  }
  return null;
}

/** 元标签属性必须使用带引号的明确值，防止畸形 HTML 触发隐式转换或把相邻标签文本混入候选字段。 */
function readHtmlAttribute(attributes: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`\\b${escapedName}\\s*=\\s*["']([^"']*)["']`, "i").exec(attributes);
  return match?.[1] ?? null;
}

/** JSON-LD 只接受普通对象根节点，拒绝无身份字段的数组或解析失败文本，防止异常页面扩大解析面。 */
function parseJsonObject(value: string): JsonRecord | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 官方页面可能以单 Product 或 `@graph` 放置 Product；两种公开结构都保留，其他节点一律跳过。 */
function* productEntries(document: JsonRecord): Generator<JsonRecord> {
  const entries = Array.isArray(document["@graph"]) ? document["@graph"] : [document];
  for (const entry of entries) if (isRecord(entry) && isProductType(entry["@type"])) yield entry;
}

/** 将 Product 和本区 Offer 同时验证后转为瞬时候选；价格只由当前公开 Offer 决定，不从页面文字推断。 */
function toCandidate(product: JsonRecord, regionCode: RegionCode, productUrl: string): OfficialProductCandidate | null {
  const rule = officialRegionRules[regionCode];
  const title = readNonEmptyString(product.name);
  const offer = selectOffer(product.offers, rule.currency);
  if (!title || !offer) return null;
  const currentPriceMinor = toMinorUnits(offer.price, rule.currency);
  if (currentPriceMinor === null) return null;
  return {
    regionCode,
    productUrl,
    canonicalTitle: title,
    publisher: readPublisher(product.publisher),
    productType: classifyProductType(title),
    currency: rule.currency,
    coverUrl: readCoverUrl(product.image),
    currentPriceMinor,
    // JSON-LD Offer 没有受统一保证的常规价字段；仅返回 null，前端因此不会伪造原价或折扣。
    regularPriceMinor: null,
  };
}

/** Offer 可为对象或数组，且必须带有本区预期币种和字符串/数字价格，不能从无关推荐商品借用报价。 */
function selectOffer(value: unknown, expectedCurrency: string): { price: string } | null {
  const offers = Array.isArray(value) ? value : [value];
  for (const offer of offers) {
    if (!isRecord(offer) || readNonEmptyString(offer.priceCurrency) !== expectedCurrency) continue;
    const price = typeof offer.price === "string" || typeof offer.price === "number" ? String(offer.price) : null;
    if (price !== null) return { price };
  }
  return null;
}

/** JSON-LD `@type` 可为字符串或数组；只有 Product 才可以提供本解析器承认的商品与 Offer 语义。 */
function isProductType(value: unknown): boolean {
  return (Array.isArray(value) ? value : [value]).some((entry) => entry === "Product");
}

/** 发行商缺失不是官方链接无效的理由；缺失值保留 null，后续跨区自动匹配只在双方都有发行商时才比较。 */
function readPublisher(value: unknown): string | null {
  return isRecord(value) ? readNonEmptyString(value.name) : readNonEmptyString(value);
}

/** 封面只使用 HTTPS 绝对地址；缺失或异常让前端显示本地占位封面，避免加载潜在的非安全外部资源。 */
function readCoverUrl(value: unknown): string | null {
  const image = Array.isArray(value) ? value[0] : value;
  if (typeof image !== "string" || !image.trim()) return null;
  try {
    const url = new URL(image);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** 标题关键字仅用于候选的稳定类型标签；未匹配时保守视为游戏，防止把升级包误显示成 DLC。 */
function classifyProductType(title: string): ProductType {
  const normalized = title.toLocaleLowerCase();
  if (normalized.includes("upgrade pack")) return "upgrade-pack";
  if (normalized.includes("season pass")) return "season-pass";
  if (normalized.includes("dlc") || normalized.includes("downloadable content")) return "dlc";
  if (normalized.includes("bundle")) return "bundle";
  return supportedProductTypes.includes("game") ? "game" : "other";
}

/** 将十进制公开价格精确换算为货币最小单位；日元为零小数，其余首版地区均使用两位小数。 */
function toMinorUnits(price: string, currency: string): number | null {
  const digits = currency === "JPY" ? 0 : 2;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(price);
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > digits && /[1-9]/.test(fraction.slice(digits))) return null;
  const amount = Number(match[1]) * 10 ** digits + Number(fraction.slice(0, digits).padEnd(digits, "0"));
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
}

/** 外部页面字段不做隐式转换，空白标题和发行商对身份确认没有价值。 */
function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** 普通对象断言阻止数组、null 与原型对象穿透到 JSON-LD 字段读取。 */
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 解析器内部只操作未知 JSON 的普通键值对象，不将页面原始类型泄漏到服务与 API 边界。 */
type JsonRecord = Record<string, unknown>;
