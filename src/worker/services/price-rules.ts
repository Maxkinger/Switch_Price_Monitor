import type { PriceSource } from "../../shared/domain";

/**
 * 价格规则只接收判定所需的金额和来源，刻意不接收汇率、显示文案或商品信息。
 * 这能确保“官方降价”基于同一地区的原始货币快照，而不会被人民币换算或 UI 格式变化误触发。
 */
interface ComparablePrice {
  amountMinor: number;
  source: PriceSource;
}

/** 目标价的持久化状态与 subscription_region_targets.target_state 的存储值一致。 */
export type TargetState = "unmet" | "met";

/** 采集轮写入通知事件前需要执行的唯一状态变迁。 */
export type TargetTransition = "trigger" | "reset" | "none";

/** D1 的 regional_product_health 中与通知去重相关的最小状态，避免规则层依赖完整数据库行。 */
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
 * 判断目标价的状态机。目标价本身使用同一货币的最小单位，价格小于等于目标即命中；
 * 已命中时保持低价不重复通知，只有回升到目标之上才返回 reset，使下次再次跌破可以重新提醒。
 */
export function evaluateTarget(targetAmountMinor: number, currentAmountMinor: number, priorState: TargetState): TargetTransition {
  const isMet = currentAmountMinor <= targetAmountMinor;
  if (priorState === "unmet" && isMet) return "trigger";
  if (priorState === "met" && !isMet) return "reset";
  return "none";
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
