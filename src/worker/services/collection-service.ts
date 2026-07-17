import type { PriceSnapshot, PriceSource } from "../../shared/domain";
import type { PriceProvider, ProviderResult, RegionalProduct } from "../providers/types";

/**
 * 价格来源链的最小端口。ProviderChain 实现此接口，而测试可注入固定结果，
 * 让采集业务规则不依赖网络、超时细节或具体第三方网站。
 */
export interface RegionalPriceCollector {
  fetch(product: RegionalProduct, providers: PriceProvider[]): Promise<ProviderResult | null>;
}

/** 快照写入端口与 PriceRepository.append 对齐；采集服务只允许追加，不暴露更新/删除能力。 */
export interface PriceSnapshotWriter {
  append(snapshot: PriceSnapshot): Promise<void>;
}

/**
 * 当日外币对人民币中间价。调度器在每轮采集前一次性取得并传入所有商品，
 * isStale 明确保留上一次成功汇率的事实，不能因有数值就伪装成当日汇率。
 */
export interface DailyCnyRate {
  cnyRate: number;
  isStale: boolean;
}

/** 单个地区商品的一次采集输入；providers 已按管理员设置排好官方优先与第三方回退顺序。 */
export interface CollectionInput {
  product: RegionalProduct;
  providers: PriceProvider[];
  rate: DailyCnyRate | null;
  capturedAt: string;
}

/** 成功采集结果供健康计数、降价规则和 UI 复用；不返回任何外部页面原文或秘密请求数据。 */
export interface CollectedOutcome {
  kind: "collected";
  source: PriceSource;
  /** 返回本次原始最小货币单位，使上层只在两个官方快照可比较时判断降价，不用重新读取或猜测刚写入的记录。 */
  amountMinor: number;
  cnyFen: number | null;
  isRateStale: boolean;
}

/** 全部来源无法验证时，只报告过期，不写新快照；上层据此保留最后一次成功价格。 */
export interface StaleOutcome {
  kind: "stale";
}

export type CollectionOutcome = CollectedOutcome | StaleOutcome;

/**
 * 连接来源链、汇率和不可变快照的应用服务。它不处理 Cron、通知或 D1 健康计数，
 * 因此每个环节都可独立验证：来源链负责可信价格，后续健康服务负责失败次数，报告服务负责消息。
 */
export class CollectionService {
  public constructor(
    private readonly collector: RegionalPriceCollector,
    private readonly snapshots: PriceSnapshotWriter,
  ) {}

  /**
   * 成功时保存一条带来源和人民币估算的本币快照；失败时绝不生成零价格、空价格或覆盖旧记录。
   * 即使汇率缺失，已验证的本币价格仍值得入库，保证日报可以继续展示原始货币。
   */
  public async collect(input: CollectionInput): Promise<CollectionOutcome> {
    const result = await this.collector.fetch(input.product, input.providers);
    if (!result) return { kind: "stale" };

    const cnyFen = input.rate ? toCnyFen(result.amountMinor, result.currency, input.rate.cnyRate) : null;
    await this.snapshots.append({
      regionalProductId: input.product.id,
      amountMinor: result.amountMinor,
      currency: result.currency,
      cnyFen,
      source: result.source,
      capturedAt: input.capturedAt,
    });
    return {
      kind: "collected",
      source: result.source,
      amountMinor: result.amountMinor,
      cnyFen,
      isRateStale: input.rate?.isStale ?? true,
    };
  }
}

/**
 * 把来源的最小货币单位换算为人民币分：先按币种小数位还原一单位外币，再乘 CNY 中间价和 100 分。
 * 当前五区中 JPY 为零小数位，其余为两位；未知币种按两位保守处理，新增币种时必须在这里显式审核。
 */
function toCnyFen(amountMinor: number, currency: string, cnyRate: number): number | null {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0 || !Number.isFinite(cnyRate) || cnyRate <= 0) return null;
  const currencyMinorFactor = currency === "JPY" ? 1 : 100;
  const converted = Math.round((amountMinor / currencyMinorFactor) * cnyRate * 100);
  return Number.isSafeInteger(converted) ? converted : null;
}
