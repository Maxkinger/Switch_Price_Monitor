import type { PriceSource } from "../../shared/domain";
import type { PriceProvider, ProviderResult, RegionalProduct } from "./types";

/** 第三方站点不得伪装为官方来源；类型层排除 official，确保 UI 和通知规则始终能显示其实际来源。 */
type ThirdPartySource = Exclude<PriceSource, "official">;

/**
 * 把每个已启用的第三方请求/解析器包装为同一契约。实际请求函数由来源验证 ADR 指定，
 * 此处不包含站点 HTML 选择器或凭据，避免页面结构变化时污染官方优先和身份校验规则。
 */
export function createThirdPartyProvider(
  source: ThirdPartySource,
  fetchThirdParty: (product: RegionalProduct, signal: AbortSignal) => Promise<Omit<ProviderResult, "source"> | null>,
): PriceProvider {
  return {
    source,
    async fetch(product, signal) {
      const result = await fetchThirdParty(product, signal);
      return result ? { ...result, source } : null;
    },
  };
}
