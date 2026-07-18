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
      { hostname: "ec.nintendo.com", pathnamePrefix: "/HK/zh/aocs/" },
      { hostname: "ec.nintendo.com", pathnamePrefix: "/HK/zh/bundles/" },
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
 * 港区本体详情公开的一层关联引用。引用只用于发现待复核的官方 URL，不含发行商或价格；这些关键身份必须从关联商品自己的详情重新读取，
 * 防止把本体字段继承给 DLC、升级包或组合商品后直接写入订阅。
 */
export interface OfficialNintendoRelatedProductReference {
  readonly regionCode: "HK";
  readonly productUrl: string;
  readonly canonicalTitle: string;
  readonly productType: Extract<ProductType, "bundle" | "dlc" | "upgrade-pack">;
  readonly coverUrl: string | null;
}

/** 关联解析器只允许读取港区 titles 本体的一层官方关系；返回 null 表示页面结构或任一关系不能安全验证。 */
export interface OfficialNintendoRelatedProductResolver {
  resolveRelated(regionCode: RegionCode, productUrl: string, signal: AbortSignal): Promise<OfficialNintendoRelatedProductReference[] | null>;
}

/**
 * 读取管理员提交的任天堂官方商品页公开 JSON-LD 或港区 eShop 元数据。解析器只在地区主机、路径前缀与币种同时吻合时返回候选，
 * 使官方搜索交回的香港 eShop 链接也可被重新验证，同时不会把任意网页或跨区价格当作本区商品。
 */
export function createOfficialNintendoProductPageResolver(
  fetchPage: typeof fetch = fetch,
): OfficialNintendoProductPageResolver & OfficialNintendoRelatedProductResolver {
  return {
    async resolve(regionCode, productUrl, signal) {
      if (!isOfficialNintendoProductUrl(regionCode, productUrl)) return null;
      const html = await fetchOfficialProductHtml(fetchPage, productUrl, signal);
      if (html === null) return null;
      return parseOfficialProductPage(html, regionCode, productUrl) ?? parseHongKongEshopProductPage(html, regionCode, productUrl);
    },
    async resolveRelated(regionCode, productUrl, signal) {
      // 关联展开是比普通详情更窄的能力：只接受港区 titles 数字资源，bundles/aocs 即使是官方 URL 也不能继续形成第二跳。
      if (regionCode !== "HK" || readHongKongEshopTitleId(productUrl) === null) return null;
      const html = await fetchOfficialProductHtml(fetchPage, productUrl, signal);
      return html === null ? null : parseHongKongRelatedProducts(html, productUrl);
    },
  };
}

/**
 * 官方详情和关系解析共用同一个只读请求边界。请求不携带 Cookie、Nintendo Account 或购买状态；HTTP 非成功代表本次不能验证，
 * 网络异常则转换为统一 ProviderNetworkError，避免上层泄漏外部响应正文或错误对象。
 */
async function fetchOfficialProductHtml(fetchPage: typeof fetch, productUrl: string, signal: AbortSignal): Promise<string | null> {
  let response: Response;
  try {
    response = await fetchPage(productUrl, { headers: { accept: "text/html,application/xhtml+xml" }, signal });
  } catch (error) {
    throw new ProviderNetworkError(error instanceof Error ? error.message : "official Nintendo product page request failed");
  }
  return response.ok ? response.text() : null;
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
 * 港区 eShop 普通商品页可使用 `search.*` 元标签；组合商品页则只在 Next RSC 的 BundleItem 片段中公开身份字段。
 * 两条解析路径都不从可见文字推断价格，缺少官方可验证报价时保持 null，避免伪造折扣、历史最低价或采集快照。
 */
function parseHongKongEshopProductPage(html: string, regionCode: RegionCode, productUrl: string): OfficialProductCandidate | null {
  if (regionCode !== "HK" || !isHongKongEshopProductUrl(productUrl)) return null;
  if (isHongKongEshopBundleUrl(productUrl)) return parseHongKongEshopBundlePage(html, productUrl);
  if (isHongKongEshopAddOnUrl(productUrl)) return parseHongKongEshopAddOnPage(html, productUrl);
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

/**
 * 从港区 aocs 详情的 DlcItem 建立候选。关系引用中的标题和类型都不能直接持久化，因此这里再次绑定 URL ID，
 * 并要求该商品自己的标题与发行商完整；价格仍由后续官方价格 API 获取，不能从 RSC 可见文字猜测。
 */
function parseHongKongEshopAddOnPage(html: string, productUrl: string): OfficialProductCandidate | null {
  const expectedId = readHongKongEshopAddOnId(productUrl);
  if (expectedId === null) return null;
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const fragment of readHongKongProductFragments(script[1])) {
      if (!isRecord(fragment) || fragment.__typename !== "DlcItem" || readIdentifier(fragment.nsUid) !== expectedId) continue;
      const title = readNonEmptyString(fragment.formalName);
      const publisher = readPublisher(fragment.publisher);
      if (!title || !publisher) continue;
      return {
        regionCode: "HK",
        productUrl,
        canonicalTitle: title,
        publisher,
        productType: classifyProductType(title),
        currency: officialRegionRules.HK.currency,
        coverUrl: readCoverUrl(fragment.heroBannerUrl),
        currentPriceMinor: null,
        regularPriceMinor: null,
      };
    }
  }
  return null;
}

/**
 * 解析港区 titles 本体根对象中的直接关系。任何数组结构、类型、标题或数字 ID 不完整时整批拒绝，避免自动匹配使用被静默裁剪的集合；
 * 同一 URL 以 Map 去重，upgradeInfo 最后以更严格的 upgrade-pack 类型覆盖普通 DLC，但保持稳定的官方出现顺序。
 */
function parseHongKongRelatedProducts(html: string, productUrl: string): OfficialNintendoRelatedProductReference[] | null {
  const expectedRootId = readHongKongEshopTitleId(productUrl);
  if (expectedRootId === null) return null;
  const roots: JsonRecord[] = [];
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const fragment of readHongKongProductFragments(script[1])) {
      if (isRecord(fragment) && fragment.__typename === "ApplicationItem" && readIdentifier(fragment.nsUid) === expectedRootId) roots.push(fragment);
    }
  }
  // 页面必须能唯一绑定一个请求本体；没有根或重复同 ID 根都可能来自页面结构变化，不能猜测使用其中一个。
  if (roots.length !== 1 || !readNonEmptyString(roots[0].formalName)) return null;
  return readHongKongDirectRelations(roots[0]);
}

/** 从已绑定的 ApplicationItem 读取三种直接关系；只访问根对象的固定字段，不递归扫描关系对象内部。 */
function readHongKongDirectRelations(root: JsonRecord): OfficialNintendoRelatedProductReference[] | null {
  const bundles = readRelationArray(root.includedBundleItems);
  const dlcContainer = root.dlcItems;
  const dlcs = isRecord(dlcContainer) ? readRelationArray(dlcContainer.items) : dlcContainer == null ? [] : null;
  const upgrades = readRelationArray(root.upgradeInfo);
  if (bundles === null || dlcs === null || upgrades === null) return null;

  const references = new Map<string, OfficialNintendoRelatedProductReference>();
  for (const item of bundles) {
    const reference = toHongKongRelatedReference(item, "BundleItem", "bundle", "bundles");
    if (reference === null) return null;
    references.set(reference.productUrl, reference);
  }
  for (const item of dlcs) {
    // 港区会把附加内容组合包以 BundleItem 放入 dlcItems.items；必须遵从官方 __typename 选择 bundles 路径，未知类型仍整批拒绝。
    const reference = isRecord(item) && item.__typename === "BundleItem"
      ? toHongKongRelatedReference(item, "BundleItem", "bundle", "bundles")
      : toHongKongRelatedReference(item, "DlcItem", "dlc", "aocs");
    if (reference === null) return null;
    references.set(reference.productUrl, reference);
  }
  for (const upgrade of upgrades) {
    if (!isRecord(upgrade)) return null;
    const upgradeId = readIdentifier(upgrade.upgradeDlcItemNsUid);
    const item = upgrade.upgradeDlcItem;
    const reference = toHongKongRelatedReference(item, "DlcItem", "upgrade-pack", "aocs");
    if (upgradeId === null || reference === null || !reference.productUrl.endsWith(`/${upgradeId}`)) return null;
    references.set(reference.productUrl, reference);
  }
  return references.size <= 50 ? [...references.values()] : null;
}

/** 缺失关系字段视为空数组，但出现非数组结构表示官方契约不完整，必须整批安全回退。 */
function readRelationArray(value: unknown): unknown[] | null {
  return value == null ? [] : Array.isArray(value) ? value : null;
}

/** 将一个直接关系收窄为固定港区 URL；类型、标题或数字 ID 任一不符合时返回 null，调用方据此拒绝整批关系。 */
function toHongKongRelatedReference(
  value: unknown,
  expectedTypeName: "BundleItem" | "DlcItem",
  productType: OfficialNintendoRelatedProductReference["productType"],
  path: "bundles" | "aocs",
): OfficialNintendoRelatedProductReference | null {
  if (!isRecord(value) || value.__typename !== expectedTypeName) return null;
  const id = readIdentifier(value.nsUid);
  const canonicalTitle = readNonEmptyString(value.formalName);
  if (id === null || canonicalTitle === null) return null;
  return {
    regionCode: "HK",
    productUrl: `https://ec.nintendo.com/HK/zh/${path}/${id}`,
    canonicalTitle,
    productType,
    coverUrl: readCoverUrl(value.heroBannerUrl),
  };
}

/**
 * 从港区组合商品页的 RSC `BundleItem` 片段建立候选。该页面可含推荐商品或其他数据片段，
 * 因此必须要求 `nsUid` 与已白名单化 URL 的数字 ID 完全一致，并同时具备标题和发行商；任一字段缺失即拒绝，
 * 防止把另一条官方商品的公开元数据绑定到当前订阅，价格仍只能由官方价格 API 后续取得。
 */
function parseHongKongEshopBundlePage(html: string, productUrl: string): OfficialProductCandidate | null {
  const expectedId = readHongKongEshopBundleId(productUrl);
  if (expectedId === null) return null;
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const fragment of readHongKongProductFragments(script[1])) {
      if (!isRecord(fragment) || fragment.__typename !== "BundleItem" || readIdentifier(fragment.nsUid) !== expectedId) continue;
      const title = readNonEmptyString(fragment.formalName);
      const publisher = readPublisher(fragment.publisher);
      if (!title || !publisher) continue;
      return {
        regionCode: "HK",
        productUrl,
        canonicalTitle: title,
        publisher,
        productType: "bundle",
        currency: officialRegionRules.HK.currency,
        coverUrl: readCoverUrl(fragment.heroBannerUrl),
        currentPriceMinor: null,
        regularPriceMinor: null,
      };
    }
  }
  return null;
}

/** 组合商品 URL 的最后一段是 eShop 公开 `nsUid`；只接受纯数字，避免 RSC 中另一种标识或查询参数被混作价格商品 ID。 */
function readHongKongEshopBundleId(productUrl: string): string | null {
  try {
    return /^\/HK\/zh\/bundles\/(\d+)$/.exec(new URL(productUrl).pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** 只有精确港区 titles 数字路径可作为一层关系根；查询参数和片段会使身份不再唯一，因此一律拒绝。 */
function readHongKongEshopTitleId(productUrl: string): string | null {
  try {
    const url = new URL(productUrl);
    return url.protocol === "https:" && url.hostname === "ec.nintendo.com" && url.search === "" && url.hash === ""
      ? /^\/HK\/zh\/titles\/(\d+)$/.exec(url.pathname)?.[1] ?? null
      : null;
  } catch {
    return null;
  }
}

/** aocs 详情必须以精确官方主机、无查询参数的数字路径绑定 DlcItem，避免同页其他商品或跟踪参数改变身份。 */
function readHongKongEshopAddOnId(productUrl: string): string | null {
  try {
    const url = new URL(productUrl);
    return url.protocol === "https:" && url.hostname === "ec.nintendo.com" && url.search === "" && url.hash === ""
      ? /^\/HK\/zh\/aocs\/(\d+)$/.exec(url.pathname)?.[1] ?? null
      : null;
  } catch {
    return null;
  }
}

/** RSC 的 nsUid 在不同页面构建中可为字符串或安全整数；只接受无前后空白的十进制值，拒绝浮点和对象等松散类型。 */
function readIdentifier(value: unknown): string | null {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}

/**
 * Next 以 `self.__next_f.push([1, JSON 字符串])` 承载 RSC 文本。先完整解码该 JSON 字符串，再仅扫描紧邻命名字段的
 * 平衡 JSON 对象；不把脚本中任意文本或多个片段拼接为对象，页面改版或恶意内容会安全降级为 null。
 */
function readHongKongRscNamedObjects(script: string, name: string): unknown[] {
  const normalized = script.trim();
  const prefix = "self.__next_f.push([1,";
  if (!normalized.startsWith(prefix) || !normalized.endsWith("])")) return [];
  let payload: unknown;
  try {
    payload = JSON.parse(normalized.slice(prefix.length, -2));
  } catch {
    return [];
  }
  return typeof payload === "string" ? readRscNamedObjects(payload, name) : [];
}

/**
 * 港区 eShop 的 Next RSC 在不同构建版本中分别使用 `fragment` 与 `serverFragment` 承载已解析商品对象。
 * 这里只接受这两个已在任天堂公开页面观察并由测试固定的精确字段名，不递归扫描任意对象；重复同 ID 根仍交由调用方的唯一性校验安全拒绝。
 */
function readHongKongProductFragments(script: string): unknown[] {
  return [
    ...readHongKongRscNamedObjects(script, "fragment"),
    ...readHongKongRscNamedObjects(script, "serverFragment"),
  ];
}

/** RSC 记录没有共同 JSON 根节点；该扫描器只解析字段名之后紧邻的单个平衡对象，保证提取边界可审计。 */
function readRscNamedObjects(value: string, name: string): unknown[] {
  const marker = `"${name}":`;
  const results: unknown[] = [];
  let offset = 0;
  while (offset < value.length) {
    const markerIndex = value.indexOf(marker, offset);
    if (markerIndex < 0) break;
    const start = value.indexOf("{", markerIndex + marker.length);
    const objectText = start < 0 ? null : readBalancedJsonObject(value, start);
    if (objectText !== null) {
      const object = parseJsonObject(objectText);
      if (object !== null) results.push(object);
      offset = start + objectText.length;
    } else {
      offset = markerIndex + marker.length;
    }
  }
  return results;
}

/** 在保持 JSON 字符串转义语义的前提下读取一个对象；未闭合结构代表公开页面契约不再满足，必须拒绝而非猜测。 */
function readBalancedJsonObject(value: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return value.slice(start, index + 1);
  }
  return null;
}

/** eShop 兜底解析只承认港区精确的大小写资源路径，避免同一主机上的账户、购买或其他国家页面被误作商品页。 */
function isHongKongEshopProductUrl(productUrl: string): boolean {
  try {
    const url = new URL(productUrl);
    return url.protocol === "https:" && url.hostname === "ec.nintendo.com" && /^\/HK\/zh\/(?:titles|aocs|bundles)\/\d+$/.test(url.pathname);
  } catch {
    return false;
  }
}

/** aocs 判断只依赖已验证的精确路径，不允许标题词或调用方声明把普通本体当成附加内容。 */
function isHongKongEshopAddOnUrl(productUrl: string): boolean {
  return readHongKongEshopAddOnId(productUrl) !== null;
}

/** 组合商品判断复用已验证的精确路径；不能因标题含有 Edition 等营销词就把本体、升级包或季票升级为 bundle。 */
function isHongKongEshopBundleUrl(productUrl: string): boolean {
  try {
    const url = new URL(productUrl);
    return url.protocol === "https:" && url.hostname === "ec.nintendo.com" && /^\/HK\/zh\/bundles\/\d+$/.test(url.pathname);
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

/** 标题关键字仅用于候选的稳定类型标签；港区官方繁简体“升级通行证”与英文 Upgrade Pack 等价，未匹配时保守视为游戏。 */
function classifyProductType(title: string): ProductType {
  const normalized = title.toLocaleLowerCase();
  if (normalized.includes("upgrade pack") || normalized.includes("升級通行證") || normalized.includes("升级通行证")) return "upgrade-pack";
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
