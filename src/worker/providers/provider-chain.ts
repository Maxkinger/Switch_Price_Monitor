import type { PriceProvider, ProviderResult, RegionalProduct } from "./types";
import { ProviderNetworkError } from "./types";

export type { PriceProvider, ProviderResult, RegionalProduct } from "./types";
export { ProviderNetworkError } from "./types";

/**
 * 官方优先的来源编排器。调用方按设置传入已经排序且启用的提供方；本类只负责超时、一次网络重试、
 * 身份验证和顺序回退，不读取设置、不写 D1，因此可在单元测试和 Cron 采集中复用。
 */
export class ProviderChain {
  public constructor(private readonly timeoutMs = 15_000) {}

  /**
   * 逐个尝试来源，返回第一条既成功又通过商品身份验证的价格。所有来源失败或返回不匹配商品时返回 null，
   * 由上层保留最后成功快照并标记过期，而不是用未经验证的价格覆盖历史。
   */
  public async fetch(product: RegionalProduct, providers: PriceProvider[]): Promise<ProviderResult | null> {
    for (const provider of providers) {
      const result = await this.fetchProvider(provider, product);
      if (result && this.matchesConfirmedProduct(product, provider.source, result)) return result;
    }
    return null;
  }

  /**
   * 单个来源仅在 ProviderNetworkError 时补发一次请求。任何非网络错误直接视为该来源失败，
   * 因为重试错误的 HTML/JSON 结构或错误的商品链接既没有价值，也可能触发第三方限流。
   */
  private async fetchProvider(provider: PriceProvider, product: RegionalProduct): Promise<ProviderResult | null> {
    try {
      return await this.fetchWithTimeout(provider, product);
    } catch (error) {
      if (!(error instanceof ProviderNetworkError)) return null;
    }

    try {
      return await this.fetchWithTimeout(provider, product);
    } catch {
      return null;
    }
  }

  /**
   * 用 AbortController 把每个来源限制在 15 秒（或测试传入的更小值）。提供方收到 signal 后必须传给 fetch；
   * 本方法同时拒绝超时 Promise，确保不遵守 signal 的实现也不会阻塞后续来源的回退。
   */
  private async fetchWithTimeout(provider: PriceProvider, product: RegionalProduct): Promise<ProviderResult | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await Promise.race([
        provider.fetch(product, controller.signal),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(new ProviderNetworkError("price provider timed out")), { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 只有来源、币种、规范化标题、发行商（若管理员已确认）与商品类型全部一致才接受。
   * 对标题仅忽略大小写和标点，既容忍商店排版差异，也不会把“Deluxe”“Gourmet”等有意义文字吞掉。
   */
  private matchesConfirmedProduct(product: RegionalProduct, expectedSource: ProviderResult["source"], result: ProviderResult): boolean {
    return result.source === expectedSource
      && result.currency === product.currency
      && normalizeIdentity(result.title) === normalizeIdentity(product.canonicalTitle)
      && result.productType === product.productType
      && (product.publisher === null || normalizeIdentity(result.publisher ?? "") === normalizeIdentity(product.publisher));
  }
}

/** 去除仅用于排版的差异后比较 Unicode 文本；保留文字和数字以避免错误合并不同版本名称。 */
function normalizeIdentity(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}
