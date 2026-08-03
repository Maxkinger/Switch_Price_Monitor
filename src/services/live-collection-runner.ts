import type { PriceProvider, RegionalProduct } from "../providers/types";
import type { CollectionInput, CollectionOutcome, DailyCnyRate } from "./collection-service";
import { evaluateOfficialDrop } from "./price-rules";

/** 启用地区商品读取端口保证运行器不直接拼接 D1 查询，也便于用多区夹具验证一项失败不会中断整批。 */
export interface EnabledRegionalProductReader {
  enabledRegionalProducts(): Promise<RegionalProduct[]>;
}

/** 每日汇率端口一次性接收本轮所有币种，避免按商品重复访问外部汇率服务并造成结果时间不一致。 */
export interface DailyCnyRateReader {
  get(currencies: string[], now: string): Promise<Map<string, DailyCnyRate>>;
}

/** 官方提供方注册表只输出当前地区允许的服务端来源；未接入第三方时不会返回任何未获准站点。 */
export interface OfficialProviderReader {
  providersFor(product: RegionalProduct): PriceProvider[];
}

/** 采集端口与 CollectionService 对齐，强制运行器以追加快照和来源标记的既有业务规则写入结果。 */
export interface RegionalCollectionService {
  collect(input: CollectionInput): Promise<CollectionOutcome>;
}

/** 健康端口在每个地区结束后记录成功或失败，保障连续失败和恢复通知的状态不在批次间丢失。 */
export interface RegionalHealthRecorder {
  record(regionalProductId: string, didSucceed: boolean, now: string): Promise<unknown>;
}

/** 上一条官方快照只暴露规则比较所需的金额与来源，禁止运行器读取完整历史或第三方原始响应。 */
export interface PreviousOfficialPriceReader {
  latestOfficialFor(regionalProductId: string): Promise<{ amountMinor: number; source: "official" } | null>;
}

/** 即时事件端口只允许预留受控类型和去重键；Telegram 凭据和消息正文始终留在后续调度服务。 */
export interface ImmediateNotificationEventWriter {
  reserve(event: { regionalProductId: string; eventType: "official-price-drop"; dedupeKey: string; createdAt: string }): Promise<boolean>;
}

/** 依赖按职责拆分，使 Worker 接线可以使用 D1 实现，而单元测试无需网络或真实数据库即可验证批次语义。 */
export interface LiveCollectionDependencies {
  products: EnabledRegionalProductReader;
  rates: DailyCnyRateReader;
  officialProviders: OfficialProviderReader;
  collection: RegionalCollectionService;
  health: RegionalHealthRecorder;
  /** 这两个依赖同时存在时才判定即时官方降价，便于部署分阶段接线且不让缺失通知配置阻断采集。 */
  previousOfficial?: PreviousOfficialPriceReader;
  events?: ImmediateNotificationEventWriter;
}

/** 批次结果只公开聚合计数，既便于 Cron 诊断，也不会把商品链接、外部响应或内部 ID 写进日志。 */
export interface LiveCollectionResult {
  attempted: number;
  collected: number;
  stale: number;
}

/**
 * 真实采集运行器复用定时与手动刷新路径。它先一次读取启用商品和所需币种汇率，
 * 再串行完成每个地区的官方采集与健康状态写回；串行执行避免同一商品来源被并发重复请求。
 */
export class LiveCollectionRunner {
  public constructor(private readonly dependencies: LiveCollectionDependencies) {}

  /**
   * 单个地区返回 stale 仍继续处理后续地区，且总是写回该地区健康状态。
   * 未取得汇率时传入 null，使 CollectionService 仍保存已验证的本币价格并显式标记人民币估算不可用。
   */
  public async run(now: string): Promise<LiveCollectionResult> {
    const products = await this.dependencies.products.enabledRegionalProducts();
    const rates = await this.dependencies.rates.get(products.map((product) => product.currency), now);
    let collected = 0;
    let stale = 0;

    for (const product of products) {
      const outcome = await this.dependencies.collection.collect({
        product,
        providers: this.dependencies.officialProviders.providersFor(product),
        rate: rates.get(product.currency) ?? null,
        capturedAt: now,
      });
      const didSucceed = outcome.kind === "collected";
      await this.dependencies.health.record(product.id, didSucceed, now);
      if (didSucceed && outcome.source === "official" && this.dependencies.previousOfficial && this.dependencies.events) {
        const previous = await this.dependencies.previousOfficial.latestOfficialFor(product.id);
        if (previous && evaluateOfficialDrop(previous, { amountMinor: outcome.amountMinor, source: outcome.source })) {
          await this.dependencies.events.reserve({
            regionalProductId: product.id,
            eventType: "official-price-drop",
            // 同一地区商品、事件类型和采集时刻构成稳定唯一键，Cron 重试不会重复取得 Telegram 发送资格。
            dedupeKey: `${product.id}:official-price-drop:${now}`,
            createdAt: now,
          });
        }
      }
      if (didSucceed) collected += 1;
      else stale += 1;
    }

    return { attempted: products.length, collected, stale };
  }
}
