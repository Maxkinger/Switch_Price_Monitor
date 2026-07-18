import type { RegionCode } from "../../shared/domain";
import { createOfficialNintendoProvider } from "./official-nintendo";
import { createNintendoPriceApiProvider } from "./official-nintendo-price-api";
import type { PriceProvider, RegionalProduct } from "./types";

/** 五区 eShop 的持久化货币映射是官方适配器的首道安全检查，避免错误地区商品在发出网络请求前就污染采集链路。 */
const regionCurrencies: Record<RegionCode, string> = {
  US: "USD",
  JP: "JPY",
  MX: "MXN",
  BR: "BRL",
  HK: "HKD",
};

/**
 * 地区官方来源注册表把“哪个地区可以使用哪种任天堂公开入口”集中在 Worker 侧。
 * 它只返回已验证或具备严格结构校验的官方提供方；第三方来源不会在这里注册，防止尚未获准的站点被意外请求。
 */
export class OfficialProviderRegistry {
  private readonly nintendoPriceApi: PriceProvider;

  public constructor(private readonly fetcher: typeof fetch = fetch) {
    // JP/HK API 适配器会自行再次核验各自地区、币种与本区价格 ID；在注册表和适配器两层约束可抵抗错误调用方。
    this.nintendoPriceApi = createNintendoPriceApiProvider(fetcher);
  }

  /**
   * 按地区返回按优先级排序的官方来源。JP 与 HK 优先使用各自已准入、返回地区价格 ID 的公开 API，若不可用再尝试同一商品的官方 JSON-LD；
   * US、MX、BR 不复用 JP/HK API 规则，只使用本区商品链接的结构化公开数据，并由后续 ProviderChain 校验商品身份。
   */
  public providersFor(product: RegionalProduct): PriceProvider[] {
    if (regionCurrencies[product.regionCode] !== product.currency) return [];

    const officialPage = createOfficialNintendoProvider(this.fetcher);
    // 相同 official 来源标签代表两个独立的任天堂官方读取策略；来源链只会接受首个通过身份校验的结果，不会重复写入快照。
    return product.regionCode === "JP" || product.regionCode === "HK" ? [this.nintendoPriceApi, officialPage] : [officialPage];
  }
}

/** 以工厂函数暴露注册表，保持调用点不依赖具体类，测试也可注入受控 fetch 而不访问真实任天堂站点。 */
export function createOfficialProviderRegistry(fetcher: typeof fetch = fetch): OfficialProviderRegistry {
  return new OfficialProviderRegistry(fetcher);
}
