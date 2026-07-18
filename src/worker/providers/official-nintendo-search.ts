import type { OfficialProductCandidate, OfficialProductSearch, OfficialSearchResult, RegionCode } from "../../shared/domain";
import { ProviderNetworkError, type ProductType } from "./types";

/** 任天堂美、墨、巴官网公开搜索页共用的只读搜索端点；它只承载官网商品索引，绝不是价格回退来源。 */
const officialAlgoliaSearchEndpoint = "https://U3B6GR4UA3-dsn.algolia.net/1/indexes/*/queries";

/**
 * 此值来自任天堂美区公开搜索页面的浏览器配置，属于公开检索配置而非本系统或用户的秘密。
 * 它只允许在 Worker 内请求官网同一公开索引，绝不返回浏览器、写入 D1、记录日志或用于任何第三方价格站。
 */
const officialAlgoliaPublicSearchKey = "a29c6927638bfd8cee23993e51e721c9";

/** 同一公开搜索端点下，只有这三个任天堂官网游戏索引已逐项验证；未知地区不能猜测索引或复用相邻地区结果。 */
type OfficialAlgoliaRegionCode = Extract<RegionCode, "US" | "MX" | "BR">;

/**
 * 每个地区档案把公开索引、币种与官方 URL 前缀绑定在 Worker 源码中。
 * 这是地区隔离边界：浏览器只能提交搜索词，不能改变索引、币种或把一个地区的商品地址伪装成另一区商品。
 */
interface OfficialAlgoliaSearchProfile {
  readonly regionCode: OfficialAlgoliaRegionCode;
  readonly gameIndex: string;
  readonly currency: string;
  readonly officialPathPrefix: string;
}

/** 美区、墨西哥区、巴西区均使用任天堂各自公开语言/国家索引；路径前缀同时约束搜索命中的官方商品地址。 */
const officialAlgoliaProfiles: readonly OfficialAlgoliaSearchProfile[] = [
  { regionCode: "US", gameIndex: "store_game_en_us", currency: "USD", officialPathPrefix: "/us/" },
  { regionCode: "MX", gameIndex: "store_game_es_mx", currency: "MXN", officialPathPrefix: "/es-mx/" },
  { regionCode: "BR", gameIndex: "store_game_pt_br", currency: "BRL", officialPathPrefix: "/pt-br/" },
];

/** 所有 Algolia 命中都只允许补齐到任天堂官网主机，禁止外部索引字段诱导 Worker 访问第三方地址。 */
const officialNintendoStoreOrigin = "https://www.nintendo.com";

/** 香港官网搜索为 Next/RSC 页面；请求只携带关键词，返回的 NSUID 仍须转换并验证为 eShop 官方商品页。 */
const officialHongKongSearchEndpoint = "https://www.nintendo.com/hk/search";

/** 日本任天堂首页公开调用的软件搜索 API；它不是 My Nintendo Store 的排队页面，也不需要 Nintendo Account 会话。 */
const officialJapaneseSearchEndpoint = "https://search.nintendo.jp/nintendo_soft/search.json";

/**
 * 任天堂五区官方名称搜索适配器。美、墨、巴使用各自公开索引；港、日使用已验证的官网页面/API。
 * 任何未列明地区、网络失败或结构变化都会安全降级到官方链接确认，不会借用其他地区索引或第三方数据。
 */
export function createOfficialNintendoSearch(fetchOfficialSearch: typeof fetch = fetch, timeoutMs = 12_000): OfficialProductSearch {
  return {
    async search(regionCode, query, signal) {
      const profile = readOfficialAlgoliaProfile(regionCode);
      if (profile) return searchOfficialAlgolia(fetchOfficialSearch, profile, query, signal, timeoutMs);
      if (regionCode === "HK") return searchOfficialHongKong(fetchOfficialSearch, query, signal, timeoutMs);
      if (regionCode === "JP") return searchOfficialJapan(fetchOfficialSearch, query, signal, timeoutMs);
      return unavailableSearch();
    },
  };
}

/** 从已审核的地区档案中查找搜索配置；未列入档案的地区必须安全降级，不能由调用方推导请求参数。 */
function readOfficialAlgoliaProfile(regionCode: RegionCode): OfficialAlgoliaSearchProfile | null {
  return officialAlgoliaProfiles.find((profile) => profile.regionCode === regionCode) ?? null;
}

/** 美、墨、巴的请求参数只来自不可变地区档案，避免浏览器将公开索引当作可任意检索的代理。 */
async function searchOfficialAlgolia(
  fetchOfficialSearch: typeof fetch,
  profile: OfficialAlgoliaSearchProfile,
  query: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<OfficialSearchResult> {
  const response = await fetchOfficialResponse(fetchOfficialSearch, officialAlgoliaSearchEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-algolia-application-id": "U3B6GR4UA3",
      "x-algolia-api-key": officialAlgoliaPublicSearchKey,
    },
    body: JSON.stringify({ requests: [{ indexName: profile.gameIndex, query, params: "hitsPerPage=20" }] }),
  }, signal, timeoutMs);
  if (!response) return unavailableSearch();
  return { status: "available", candidates: parseOfficialAlgoliaSearch(await response.json(), profile) };
}

/** 香港官网服务端数据只通过固定搜索入口取得；RSC 字段改变或缺少 software.items 时不能伪装成“没有结果”。 */
async function searchOfficialHongKong(
  fetchOfficialSearch: typeof fetch,
  query: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<OfficialSearchResult> {
  const softwareCandidates = await searchOfficialHongKongSoftware(fetchOfficialSearch, query, signal, timeoutMs);
  // Magento 商城搜索会拒绝 Cloudflare Worker，名称检索只依赖可用的香港普通官网；组合商品将在已验证本体详情的一层官方关系中补齐。
  return softwareCandidates === null ? unavailableSearch() : { status: "available", candidates: softwareCandidates };
}

/** 港区普通官网搜索仅负责软件索引；RSC 结构缺失表示该官方索引本次无法可靠使用。 */
async function searchOfficialHongKongSoftware(
  fetchOfficialSearch: typeof fetch,
  query: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<OfficialProductCandidate[] | null> {
  const url = new URL(officialHongKongSearchEndpoint);
  url.searchParams.set("k", query);
  const response = await fetchOfficialResponse(fetchOfficialSearch, url.toString(), { headers: { accept: "text/html" } }, signal, timeoutMs);
  if (!response) return null;
  return parseOfficialHongKongSearch(await response.text());
}

/** 日本官网公开软件 API 的参数固定为下载软件的受控搜索；不访问会触发 JavaScript 排队的 My Nintendo Store 搜索页。 */
async function searchOfficialJapan(
  fetchOfficialSearch: typeof fetch,
  query: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<OfficialSearchResult> {
  const url = new URL(officialJapaneseSearchEndpoint);
  url.search = new URLSearchParams({ q: query, limit: "20", page: "1", opt_search: "1" }).toString();
  const response = await fetchOfficialResponse(fetchOfficialSearch, url.toString(), { headers: { accept: "application/json" } }, signal, timeoutMs);
  if (!response) return unavailableSearch();
  const candidates = parseOfficialJapaneseSearch(await response.json());
  return candidates === null ? unavailableSearch() : { status: "available", candidates };
}

/**
 * 所有官方搜索共用超时、调用方取消与网络错误处理。超时/非成功 HTTP 只能代表本次自动搜索不可用；
 * 非超时传输异常保留为 ProviderNetworkError，供路由统一转换为安全提示而不回显任天堂响应正文。
 */
async function fetchOfficialResponse(
  fetchOfficialSearch: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Response | null> {
  const timeoutController = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; timeoutController.abort(); }, timeoutMs);
  const forwardAbort = () => timeoutController.abort();
  signal.addEventListener("abort", forwardAbort, { once: true });
  try {
    const response = await fetchOfficialSearch(input, { ...init, signal: timeoutController.signal });
    return response.ok ? response : null;
  } catch (error) {
    if (timedOut) {
      return null;
    }
    if (signal.aborted) {
      return null;
    }
    throw new ProviderNetworkError(error instanceof Error ? error.message : "official Nintendo search request failed");
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", forwardAbort);
  }
}

/** 将无搜索适配器、HTTP 失败和页面变更统一为可操作的安全状态，不泄露外部响应或内部请求细节。 */
function unavailableSearch(): OfficialSearchResult {
  return { status: "unavailable", message: "该区官方搜索暂不可用，请粘贴任天堂官方商品链接。" };
}

/**
 * 将任天堂官网公开搜索响应收窄为商品候选。响应是外部数据，即使来自官网也不能信任其字段类型、价格或链接；
 * 每条命中独立拒绝，保留其余可验证候选，避免一条异常记录阻断管理员查看正常搜索结果。
 */
function parseOfficialAlgoliaSearch(value: unknown, profile: OfficialAlgoliaSearchProfile): OfficialProductCandidate[] {
  if (!isRecord(value) || !Array.isArray(value.results)) return [];
  return value.results.flatMap((result) => isRecord(result) && Array.isArray(result.hits)
    ? result.hits.flatMap((hit) => {
      const candidate = toOfficialAlgoliaCandidate(hit, profile);
      return candidate ? [candidate] : [];
    })
    : []);
}

/**
 * 从香港官网 RSC 字符串载荷中找出 `software.items`。RSC 是外部页面数据，即使来自官网也需先 JSON 解码、
 * 再逐项验证地区和 eShop 链接；找不到该结构表示页面契约已变，必须安全降级而不是把页面文字当候选。
 */
function parseOfficialHongKongSearch(html: string): OfficialProductCandidate[] | null {
  let foundSoftwareItems = false;
  const candidates: OfficialProductCandidate[] = [];
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const software of readHongKongSoftwareValues(script[1])) {
      if (!isRecord(software) || !Array.isArray(software.items)) continue;
      foundSoftwareItems = true;
      for (const item of software.items) {
        const candidate = toOfficialHongKongCandidate(item);
        if (candidate) candidates.push(candidate);
      }
    }
  }
  return foundSoftwareItems ? candidates : null;
}

/**
 * 从单个 RSC script 中解码第一类页面数据 push。Next 可能把完整 JSON 对象或 RSC 文本片段放进该字符串；
 * 两种形式都只抽取名称为 software 的完整 JSON 对象，脚本其余内容不能作为候选数据解释。
 */
function readHongKongSoftwareValues(script: string): unknown[] {
  const prefix = "self.__next_f.push([1,";
  if (!script.startsWith(prefix) || !script.endsWith("])")) return [];
  const encodedPayload = script.slice(prefix.length, -2);
  let decodedPayload: unknown;
  try {
    decodedPayload = JSON.parse(encodedPayload);
  } catch {
    return [];
  }
  if (typeof decodedPayload !== "string") return [];
  const directPayload = parseJsonValue(decodedPayload);
  if (directPayload !== null) return [...findNamedValues(directPayload, "software")];
  return readRscNamedObjects(decodedPayload, "software");
}

/** 完整 JSON 载荷优先普通解析；失败仅说明它可能是 RSC 多记录文本，不能直接当作异常或候选。 */
function parseJsonValue(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/**
 * RSC 多记录文本没有整体 JSON 根节点。此扫描器只接受引号字段名后紧邻的平衡对象，
 * 并在 JSON.parse 成功后返回，避免正则跨越多个记录把外部文本拼接成伪造候选。
 */
function readRscNamedObjects(value: string, name: string): unknown[] {
  const marker = `"${name}":`;
  const results: unknown[] = [];
  let offset = 0;
  while (offset < value.length) {
    const markerIndex = value.indexOf(marker, offset);
    if (markerIndex < 0) break;
    const start = value.indexOf("{", markerIndex + marker.length);
    const objectText = start < 0 ? null : readBalancedJsonObject(value, start);
    if (objectText) {
      const object = parseJsonValue(objectText);
      if (object !== null) results.push(object);
      offset = start + objectText.length;
    } else {
      offset = markerIndex + marker.length;
    }
  }
  return results;
}

/** 在保留字符串转义语义的前提下读取一个平衡 JSON 对象；未闭合内容代表页面结构变化，安全返回 null。 */
function readBalancedJsonObject(value: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return value.slice(start, index + 1);
  }
  return null;
}

/** 递归寻找 RSC 已解码对象中的命名字段；输入来自 JSON，仍限制为数组和普通对象以免异常结构扩大读取面。 */
function* findNamedValues(value: unknown, name: string): Generator<unknown> {
  if (Array.isArray(value)) {
    for (const item of value) yield* findNamedValues(item, name);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === name) yield child;
    yield* findNamedValues(child, name);
  }
}

/** 香港候选只能由官方 `hongkong` 项、数字 NSUID 及精确 eShop 模板共同形成，避免 RSC 中新闻或外链混入商品结果。 */
function toOfficialHongKongCandidate(value: unknown): OfficialProductCandidate | null {
  if (!isRecord(value) || value.region !== "hongkong") return null;
  const canonicalTitle = readNonEmptyString(value.title);
  const productUrl = readOfficialHongKongProductUrl(value.pageLink, value.nsuid);
  if (!canonicalTitle || !productUrl) return null;
  const imageHero = isRecord(value.imageHero) ? value.imageHero.url : null;
  return {
    regionCode: "HK",
    productUrl,
    canonicalTitle,
    publisher: readNonEmptyString(value.publisher),
    productType: classifyOfficialProductType(canonicalTitle),
    currency: "HKD",
    coverUrl: readOfficialCoverUrl(imageHero),
    // 港区搜索页不承诺返回可购买价格；保留 null 以防 UI 或历史价格逻辑把缺失数据误报为免费。
    currentPriceMinor: null,
    regularPriceMinor: null,
  };
}

/** 只有香港官网实际返回的固定模板与纯数字 NSUID 才可组成 eShop 商品链接，禁止用任意模板替换占位符。 */
function readOfficialHongKongProductUrl(template: unknown, nsuid: unknown): string | null {
  if (template !== "https://ec.nintendo.com/HK/zh/titles/{NSUID}" || typeof nsuid !== "string" || !/^\d+$/.test(nsuid)) return null;
  return `https://ec.nintendo.com/HK/zh/titles/${nsuid}`;
}

/**
 * 日本官网软件 API 的结果包含下载软件标识、标题、发行商和日元价格。只有纯数字 id/nsuid 且 sform 为下载版时，
 * 才能按官网公开的一一映射生成 My Nintendo Store URL；实体卡、聚合项和不明 ID 不得猜测成可购买下载商品。
 */
function parseOfficialJapaneseSearch(value: unknown): OfficialProductCandidate[] | null {
  if (!isRecord(value) || !isRecord(value.result) || !Array.isArray(value.result.items)) return null;
  return value.result.items.flatMap((item) => {
    const candidate = toOfficialJapaneseCandidate(item);
    return candidate ? [candidate] : [];
  });
}

/** 从单条日本软件 API 记录读取可验证下载候选；标题和价格字段不完整时仍拒绝，避免后续跨区比对接受半成品身份。 */
function toOfficialJapaneseCandidate(value: unknown): OfficialProductCandidate | null {
  if (!isRecord(value)) return null;
  const id = readNonEmptyString(value.id);
  const nsuid = readNonEmptyString(value.nsuid);
  const canonicalTitle = readNonEmptyString(value.title);
  const productType = canonicalTitle === null ? null : readOfficialJapaneseDownloadProductType(value.sform, canonicalTitle);
  if (!id || !nsuid || id !== nsuid || !/^\d+$/.test(id) || !canonicalTitle || productType === null) return null;
  const regularPriceMinor = readJapaneseYenAmount(value.price);
  const currentPriceMinor = readJapaneseYenAmount(value.current_price) ?? regularPriceMinor;
  return {
    regionCode: "JP",
    productUrl: `https://store-jp.nintendo.com/item/software/D${id}/`,
    canonicalTitle,
    publisher: readNonEmptyString(value.maker),
    productType,
    currency: "JPY",
    // API 仅返回图像散列而非带格式扩展名的公开 URL；宁可使用页面占位封面，也不能猜测 CDN 地址。
    coverUrl: null,
    currentPriceMinor,
    regularPriceMinor,
  };
}

/**
 * 日区软件 API 的形态同时决定是否可以安全构造 Store URL 与候选类型。`BEE_DL`、`HAC_DL` 是已验证的下载软件，
 * 其细分类型仍可从官方标题中的升级包等受控词判断；`DL_DLC` 则是本次实测的独立组合商品，必须强制写成 bundle。
 * 实体卡带、未知形态或其他 DLC 枚举没有经过 Store URL/价格 API 准入，不能仅因带有数字 ID 就进入订阅流程。
 */
function readOfficialJapaneseDownloadProductType(value: unknown, title: string): ProductType | null {
  if (value === "BEE_DL" || value === "HAC_DL") return classifyOfficialProductType(title);
  if (value === "DL_DLC") return "bundle";
  return null;
}

/** 日元没有小数位；API 金额必须是非负安全整数，浮点、字符串和异常值都不能参与候选价格展示。 */
function readJapaneseYenAmount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** 从单条搜索命中读取所有受控字段；只要身份、币种、价格精度或官方主机有一个不成立就拒绝该候选。 */
function toOfficialAlgoliaCandidate(value: unknown, profile: OfficialAlgoliaSearchProfile): OfficialProductCandidate | null {
  if (!isRecord(value)) return null;
  // 任天堂 2026 年公开索引以 url/title/eshopDetails 表示商品；不可回退读取旧字段，避免结构变化时误把不完整命中写入确认流程。
  const productUrl = readOfficialAlgoliaProductUrl(value.url, profile);
  const canonicalTitle = readNonEmptyString(value.title);
  const productType = readOfficialAlgoliaProductType(value);
  const price = readOfficialAlgoliaPrice(value.eshopDetails, profile);
  if (!productUrl || !canonicalTitle || !productType || !price) return null;
  return {
    regionCode: profile.regionCode,
    productUrl,
    canonicalTitle,
    publisher: readNonEmptyString(value.softwarePublisher),
    productType,
    currency: profile.currency,
    coverUrl: readOfficialCoverUrl(value.productImageSquare),
    currentPriceMinor: price.currentPriceMinor,
    regularPriceMinor: price.regularPriceMinor,
  };
}

/**
 * 只接受地区档案对应的 Nintendo 商店链接。相对链接会补齐固定官网主机，绝对链接则必须精确匹配主机与该区路径前缀，
 * 防止搜索索引的错误字段把外部页面带入下一阶段的 Worker 解析请求。
 */
function readOfficialAlgoliaProductUrl(value: unknown, profile: OfficialAlgoliaSearchProfile): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value, officialNintendoStoreOrigin);
    if (url.protocol !== "https:" || url.origin !== officialNintendoStoreOrigin || !url.pathname.startsWith(profile.officialPathPrefix)) return null;
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
 * 这三个公开索引都把价格放在 eshopDetails 且以本区货币主单位返回；系统内部统一以最小两位小数单位保存，
 * 因此必须验证金额精度和档案币种。常规价是候选页原价展示的基线，缺失时不伪造当前价。
 */
function readOfficialAlgoliaPrice(value: unknown, profile: OfficialAlgoliaSearchProfile): { currentPriceMinor: number; regularPriceMinor: number | null } | null {
  if (!isRecord(value) || value.currency !== profile.currency) return null;
  const regularPriceMinor = readTwoDecimalMajorAmount(value.regularPrice);
  if (regularPriceMinor === null) return null;
  const discountPriceMinor = value.discountPrice === null ? null : readTwoDecimalMajorAmount(value.discountPrice);
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
function readOfficialAlgoliaProductType(value: Record<string, unknown>): ProductType | null {
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

/**
 * 港日公开搜索结果未共享 Algolia 的商品枚举，只能按三语官方标题中的稳定类别词保守分类。
 * 未识别时默认游戏而非 DLC：候选仍要经过商品页二次验证，不能仅因搜索摘要误把附加内容自动升级为本体。
 */
function classifyOfficialProductType(title: string): ProductType {
  const normalized = title.toLocaleLowerCase();
  if (normalized.includes("upgrade pack") || normalized.includes("アップグレードパス") || normalized.includes("升級通行證")) return "upgrade-pack";
  if (normalized.includes("season pass") || normalized.includes("シーズンパス")) return "season-pass";
  if (normalized.includes("downloadable content") || normalized.includes("追加コンテンツ") || normalized.includes("追加內容") || normalized.includes("dlc")) return "dlc";
  if (normalized.includes("bundle") || normalized.includes("セット") || normalized.includes("組合")) return "bundle";
  return "game";
}

/** 公开搜索文本字段只接受去除空白后仍有内容的字符串，拒绝对象、数组和空字符串的隐式转换。 */
function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** 将任天堂各区索引的两位小数主单位安全转换为内部最小单位；超过精度或安全整数范围的金额不能参与价格比较。 */
function readTwoDecimalMajorAmount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const minor = Math.round(value * 100);
  return Number.isSafeInteger(minor) && Math.abs(value - minor / 100) < 0.000_001 ? minor : null;
}

/** 将外部 JSON 收窄为普通对象，避免数组、null 或带原型对象绕过字段验证。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
