import type { AppSettings } from "../../shared/domain";
import type { PendingNotificationEvent } from "../repositories/notification-event-repository";
import { buildDailyReport, type DailyReportSubscription, type TelegramMessage } from "./report-service";
import type { RetentionCleanupResult } from "./retention-service";
import type { TelegramDeliveryResult } from "./telegram-service";

/** 调度器只依赖时区和日报时刻，隔离完整设置对象可避免将未来的秘密字段误传入任务逻辑。 */
export interface DailyReportSettingsReader {
  get(): Promise<{ timezone: string; dailyReportTime: string } | null>;
}

/** 仪表盘读取模型是日报唯一价格来源，确保浏览器与 Telegram 使用相同的当前价和历史最低价计算规则。 */
export interface DailyReportOverviewReader {
  getOverview(): Promise<{ subscriptions: DailyReportSubscription[] }>;
}

/** Telegram 端口只暴露安全投递结果；调度器不会读取、记录或回传配置凭据。 */
export interface DailyReportTelegramSender {
  send(messages: TelegramMessage[]): Promise<TelegramDeliveryResult[]>;
}

/** 待发送事件读取端口只提供未确认消息；调度器不直接访问 D1，从而能单独验证失败重试与投递审计边界。 */
export interface PendingNotificationEventReader {
  pending(): Promise<PendingNotificationEvent[]>;
}

/** 成功投递标记端口限定为一次性状态变更，禁止调度器写入 Telegram 原始响应或任何秘密。 */
export interface NotificationEventDeliveryMarker {
  markDelivered(dedupeKey: string, sentAt: string): Promise<boolean>;
}

/** 维护任务只读取历史保留策略；缩小接口可防止六小时任务误依赖日报时区或 Telegram 配置。 */
export interface MaintenanceSettingsReader {
  get(): Promise<{ priceHistoryRetention: AppSettings["priceHistoryRetention"] } | null>;
}

/** 维护端口只暴露受控清理，不返回原始价格或日志内容，避免调度边界扩大数据暴露面。 */
export interface RetentionMaintenanceRunner {
  cleanup(now: string, policy: AppSettings["priceHistoryRetention"]): Promise<RetentionCleanupResult>;
}

/** 依赖注入让时间判断、数据库读取和 Telegram 网络投递可分别在 Worker 测试中验证。 */
export interface SchedulerDependencies {
  settings: DailyReportSettingsReader;
  overview: DailyReportOverviewReader;
  telegram?: DailyReportTelegramSender;
}

/** 六小时维护不需要 Telegram 或仪表盘读取；独立依赖使其在通知未配置时仍能安全控制数据量。 */
export interface MaintenanceDependencies {
  settings: MaintenanceSettingsReader;
  retention: RetentionMaintenanceRunner;
}

/**
 * 即时通知与日报共用 Telegram 发送边界，但不依赖设置或完整仪表盘读取。
 * Secret 缺失时必须在读取 pending 前返回，避免未配置 Telegram 的部署反复扫描私有事件表。
 */
export interface PendingNotificationDeliveryDependencies {
  events: PendingNotificationEventReader;
  telegram?: DailyReportTelegramSender;
  marker: NotificationEventDeliveryMarker;
}

/** 调度结果仅用于 Worker 内部诊断和测试，不含价格正文、Telegram 响应或任何秘密。 */
export type ScheduledResult =
  | { kind: "not-due" }
  | { kind: "setup-not-complete" }
  | { kind: "telegram-not-configured" }
  | { kind: "daily-report-dispatched"; deliveries: TelegramDeliveryResult[] };

/** 六小时维护结果只提供执行状态和聚合删除数量，供 Worker 诊断使用而不泄漏历史内容。 */
export type ScheduledMaintenanceResult =
  | { kind: "setup-not-complete" }
  | { kind: "maintenance-completed"; cleanup: RetentionCleanupResult };

/** 即时通知结果只含聚合数量；不将游戏名、正文、HTTP 状态或 Telegram 凭据带入 Worker 诊断结果。 */
export type PendingNotificationDeliveryResult =
  | { kind: "telegram-not-configured" }
  | { kind: "pending-notifications-dispatched"; attempted: number; delivered: number };

/**
 * 在每分钟 Cron 唤醒时按管理员时区决定是否发送日报。只有命中精确 HH:mm 且 Telegram Secret 完整时
 * 才读取价格和发送消息，因此配置缺失、非日报分钟都不会扩大 D1 读取或外部网络访问。
 */
export async function runScheduled(now: string, dependencies: SchedulerDependencies): Promise<ScheduledResult> {
  const settings = await dependencies.settings.get();
  if (!settings) return { kind: "setup-not-complete" };
  if (!isDailyReportDue(now, settings.timezone, settings.dailyReportTime)) return { kind: "not-due" };
  if (!dependencies.telegram) return { kind: "telegram-not-configured" };

  const overview = await dependencies.overview.getOverview();
  const messages = buildDailyReport({ subscriptions: overview.subscriptions, timezone: settings.timezone, generatedAt: now });
  return { kind: "daily-report-dispatched", deliveries: await dependencies.telegram.send(messages) };
}

/**
 * 在六小时 Cron 触发时执行数据保留。未完成首次设置时不猜测策略也不删除任何数据；
 * 已初始化后，RetentionService 负责严格的日历边界与固定九十天日志规则，未来价格采集可在同一频率入口追加。
 */
export async function runScheduledMaintenance(now: string, dependencies: MaintenanceDependencies): Promise<ScheduledMaintenanceResult> {
  const settings = await dependencies.settings.get();
  if (!settings) return { kind: "setup-not-complete" };
  return { kind: "maintenance-completed", cleanup: await dependencies.retention.cleanup(now, settings.priceHistoryRetention) };
}

/**
 * 投递采集异常、恢复及后续价格事件。每个事件独立发送并仅在 Telegram 明确确认成功后标记 delivered，
 * 因而网络失败会保留 pending 供下一分钟 Cron 重试；串行处理同时保持管理员聊天中的事件顺序。
 */
export async function runPendingNotificationDelivery(now: string, dependencies: PendingNotificationDeliveryDependencies): Promise<PendingNotificationDeliveryResult> {
  if (!dependencies.telegram) return { kind: "telegram-not-configured" };

  const events = await dependencies.events.pending();
  let delivered = 0;
  for (const event of events) {
    const [result] = await dependencies.telegram.send([buildPendingNotificationMessage(event)]);
    if (result?.delivered && await dependencies.marker.markDelivered(event.dedupeKey, now)) {
      delivered += 1;
    }
  }
  return { kind: "pending-notifications-dispatched", attempted: events.length, delivered };
}

/**
 * Cron 的 scheduledTime 为 UTC 毫秒，管理员时间则是 IANA 时区中的 HH:mm。使用 Intl 格式化部件而非手写偏移量，
 * 才能正确覆盖未来可选的夏令时地区；设置服务已在写入时验证时区与时间格式。
 */
function isDailyReportDue(now: string, timezone: string, dailyReportTime: string): boolean {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
  const fields = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${fields.hour}:${fields.minute}` === dailyReportTime;
}

/**
 * 将内部事件类型转换为简体中文即时提醒。关联商品或地区已被删除时采用中性占位文案，
 * 绝不回退到 regional_product_id 等内部标识；详细错误摘要将在采集执行器持久化安全摘要后补充。
 */
function buildPendingNotificationMessage(event: PendingNotificationEvent): TelegramMessage {
  const game = event.gameNameZh ? `《${event.gameNameZh}》` : "某个商品";
  const region = immediateRegionLabel(event.regionCode);
  const messages: Record<PendingNotificationEvent["eventType"], string> = {
    "collection-failure": `⚠️ 采集异常\n${game}${region}已连续 3 次无法获取价格，请检查商品链接与已启用价格来源。`,
    "collection-recovered": `✅ 采集恢复\n${game}${region}已恢复获取价格。`,
    "official-price-drop": `🔻 官方降价提醒\n${game}${region}检测到官方价格下降。`,
    "target-price": `🎯 目标价提醒\n${game}${region}当前价格已达到设定目标。`,
  };
  return { text: messages[event.eventType] };
}

/** 即时提醒沿用管理员熟悉的“美区”等简称；未知或缺失地区不猜测，明确提示为某地区。 */
function immediateRegionLabel(regionCode: string | null): string {
  if (!regionCode) return "某地区";
  return { US: "美区", JP: "日区", MX: "墨西哥区", BR: "巴西区", HK: "港区" }[regionCode] ?? regionCode;
}
