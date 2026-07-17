import type { PriceSource } from "../../shared/domain";
import type { PriceProvider } from "./types";

/**
 * 可在设置中显示的第三方价格站点，但不包含官方来源；官方价格必须始终由独立的
 * 任天堂适配器处理，避免来源标记、降价通知规则与可信度边界被混淆。
 */
type ThirdPartySource = Exclude<PriceSource, "official">;

/**
 * 未获得 API 或书面许可时的第三方来源注册表。它只记住本次调用请求的来源并返回空数组，
 * 从架构层保证 ProviderChain 没有可执行的第三方请求，避免在管理员仅勾选设置选项时
 * 擅自抓取网页、绕过网站访问规则或把未经验证的价格写进历史。
 */
class DisabledThirdPartyProviderRegistry {
  /**
   * 使用调用顺序保存最近一次请求的唯一来源，便于设置页或日志准确提示管理员哪些站点尚未接入。
   * 该状态绝不持久化为“已失败价格”，因为它表达的是产品准入状态而非一次临时网络错误。
   */
  private requestedUnavailableSources: ThirdPartySource[] = [];

  /**
   * 返回不可用来源的副本，防止调用方修改内部记录而导致 UI 提示与实际执行边界不一致。
   */
  get unavailableSources(): readonly ThirdPartySource[] {
    return [...this.requestedUnavailableSources];
  }

  /**
   * 接受管理员按优先级选择的第三方来源，但当前阶段永远不构造 PriceProvider。
   * 去重保留首次出现顺序，既避免重复提示同一站点，也为未来在逐一获准后按设置顺序接入留出稳定契约。
   */
  providersFor(sources: readonly ThirdPartySource[]): PriceProvider[] {
    this.requestedUnavailableSources = [...new Set(sources)];
    return [];
  }
}

/**
 * 创建第三方来源准入边界。调用方可以安全地查询配置结果，但在来源验证完成之前，
 * 该工厂不会创建解析器、不会调用 fetch，也不会把第三方返回伪装成任天堂官方价格。
 */
export function createThirdPartyProviderRegistry(): DisabledThirdPartyProviderRegistry {
  return new DisabledThirdPartyProviderRegistry();
}
