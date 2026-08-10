import type { PriceSource } from "../shared/domain";

/**
 * 价格规则只接收判定所需的金额和来源，刻意不接收汇率、显示文案或商品信息。
 * 这能确保“官方降价”基于同一地区的原始货币快照，而不会被人民币换算或 UI 格式变化误触发。
 */
interface ComparablePrice {
  amountMinor: number;
  source: PriceSource;
}

/** PostgreSQL `regional_product_health` 中与通知去重相关的最小状态，避免规则层依赖完整数据库行。 */
export interface ProductHealthState {
  consecutiveFailures: number;
  failureNotified: boolean;
}

/** 本轮采集后是否应请求 Telegram 服务发送异常或恢复消息。 */
export type HealthNotification = "failure" | "recovered" | "none";

/** 计算后的状态必须写回 regional_product_health，才能让下一次 Cron 延续同一告警窗口。 */
export interface HealthTransition extends ProductHealthState {
  notification: HealthNotification;
}

/**
 * 只有上一条和当前条目都来自官方且当前原始本币金额更低时才算即时降价。
 * 第三方回退、相同价格和上涨均返回 false，避免把来源切换或重复采集误报给 Telegram。
 */
export function evaluateOfficialDrop(previous: ComparablePrice, current: ComparablePrice): boolean {
  return previous.source === "official" && current.source === "official" && current.amountMinor < previous.amountMinor;
}

/**
 * 处理每次采集的连续失败计数与通知去重。第三次失败才触发一次 failure，之后继续失败只累积计数；
 * 一旦恢复成功便归零，且只有曾发出 failure 的商品才发 recovered，避免正常首轮采集产生多余 Telegram 消息。
 */
export function evaluateHealthTransition(prior: ProductHealthState, didSucceed: boolean): HealthTransition {
  if (didSucceed) {
    return {
      consecutiveFailures: 0,
      failureNotified: false,
      notification: prior.failureNotified ? "recovered" : "none",
    };
  }

  const consecutiveFailures = prior.consecutiveFailures + 1;
  const shouldNotifyFailure = consecutiveFailures === 3 && !prior.failureNotified;
  return {
    consecutiveFailures,
    failureNotified: prior.failureNotified || shouldNotifyFailure,
    notification: shouldNotifyFailure ? "failure" : "none",
  };
}
