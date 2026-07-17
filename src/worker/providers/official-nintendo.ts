import { ProviderNetworkError, type PriceProvider, type ProductType, type ProviderResult, type RegionalProduct } from "./types";

/**
 * 从已验证的任天堂地区商品页读取公开 HTML。函数保持可注入，令单元测试无需联网，
 * 也使将来某个地区需要不同请求策略时可在适配器层显式配置，而不是向浏览器泄漏商店访问逻辑。
 */
export function createOfficialNintendoProvider(fetchPage: typeof fetch = fetch): PriceProvider {
  return {
    source: "official",
    async fetch(product, signal) {
      let response: Response;
      try {
        response = await fetchPage(product.productUrl, {
          headers: { accept: "text/html,application/xhtml+xml" },
          signal,
        });
      } catch (error) {
        // 只有连接、DNS 或 Abort 等传输问题包装为可重试网络错误；页面结构错误不应重复请求。
        throw new ProviderNetworkError(error instanceof Error ? error.message : "official Nintendo request failed");
      }

      // 4xx/5xx 不可证明目标商品有有效公开价格，交由来源链尝试下一提供方而不是尝试解析错误页面。
      if (!response.ok) return null;
      const parsed = parseOfficialJsonLd(await response.text(), product.currency);
      // 来源与采集时间属于本系统快照元数据，而非任天堂页面字段；统一在适配器边界补齐，避免下游猜测来源。
      return parsed ? { ...parsed, source: "official", capturedAt: new Date().toISOString() } : null;
    },
  };
}

/**
 * 在 `<script type="application/ld+json">` 中查找 Product/Offer。JSON-LD 是官方为搜索引擎提供的公开结构，
 * 比页面文字或按钮位置更稳定；但它仍受区域页面结构约束，未通过 ADR-002 验证的地区不会被自动假定兼容。
 */
function parseOfficialJsonLd(html: string, expectedCurrency: string): Omit<ProviderResult, "source" | "capturedAt"> | null {
  const scripts = html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const script of scripts) {
    const document = parseJsonObject(script[1]);
    if (!document) continue;
    for (const product of productEntries(document)) {
      const offer = selectOffer(product.offers);
      const title = readString(product.name);
      const currency = offer ? readString(offer.priceCurrency) : null;
      const price = offer ? readStringOrNumber(offer.price) : null;
      if (!offer || !title || !currency || !price || currency !== expectedCurrency) continue;

      const amountMinor = toMinorUnits(price, currency);
      if (amountMinor === null) continue;
      return {
        amountMinor,
        currency,
        title,
        publisher: readPublisher(product.publisher),
        productType: classifyProductType(title, product["@type"]),
      };
    }
  }
  return null;
}

/** 只接受对象根节点，防止外部页面中异常 JSON 或数组被误当作商品记录。 */
function parseJsonObject(value: string): JsonRecord | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 支持标准 `@graph` 与单 Product 两种 JSON-LD 形态；其他节点（面包屑、图片）不会进入价格解析。 */
function* productEntries(document: JsonRecord): Generator<JsonRecord> {
  const entries = Array.isArray(document["@graph"]) ? document["@graph"] : [document];
  for (const entry of entries) {
    if (!isRecord(entry) || !isProductType(entry["@type"])) continue;
    yield entry;
  }
}

/** Offer 可为单对象或数组；只取第一个具有价格和币种的公开 Offer，绝不从无关推荐商品借用金额。 */
function selectOffer(value: unknown): JsonRecord | null {
  const offers = Array.isArray(value) ? value : [value];
  return offers.find(isRecord) ?? null;
}

/** JSON-LD 的 `@type` 可以是字符串或数组；Product 才有可采集的报价语义。 */
function isProductType(value: unknown): boolean {
  return (Array.isArray(value) ? value : [value]).some((entry) => entry === "Product");
}

/** JSON-LD 价格为字符串或数字；其他类型（如对象、空值）一律拒绝，避免隐式转换产生错误金额。 */
function readStringOrNumber(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

/** 去除空白字符串；不强制转换对象，避免把站点模板对象序列化为“价格”或“标题”。 */
function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** 发行商可能缺失；缺失由 ProviderChain 根据管理员是否确认发行商决定是否接受。 */
function readPublisher(value: unknown): string | null {
  return isRecord(value) ? readString(value.name) : readString(value);
}

/**
 * 把十进制字符串精确转换为最小货币单位。仅五区常用币种使用的 0/2 位小数在此显式处理；
 * 不接受多余有效小数，避免 JavaScript 浮点乘法把 9.99 等价格变成错误整数。
 */
function toMinorUnits(price: string, currency: string): number | null {
  const decimalDigits = currency === "JPY" ? 0 : 2;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(price);
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > decimalDigits && /[1-9]/.test(fraction.slice(decimalDigits))) return null;
  const multiplier = 10 ** decimalDigits;
  const amount = Number(match[1]) * multiplier + Number(fraction.slice(0, decimalDigits).padEnd(decimalDigits, "0"));
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
}

/**
 * 公开 JSON-LD 对升级包通常仅通过标题标识。明确识别附加内容关键字后才回退为游戏，
 * 这样升级包、季票和组合包不会被当作本体；非英语地区须在 ADR-002 的分区验证中补充关键字或专用解析器。
 */
function classifyProductType(title: string, schemaType: unknown): ProductType {
  const normalized = title.toLocaleLowerCase();
  if (normalized.includes("upgrade pack")) return "upgrade-pack";
  if (normalized.includes("season pass")) return "season-pass";
  if (normalized.includes("dlc") || normalized.includes("downloadable content")) return "dlc";
  if (normalized.includes("bundle")) return "bundle";
  return isProductType(schemaType) ? "game" : "other";
}

/** 只把普通 JSON 对象传入字段读取函数，避免原型对象或数组影响外部页面解析。 */
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type JsonRecord = Record<string, unknown>;
