import type { AppSettings } from "../../shared/domain";
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
 * Cron 的 scheduledTime 为 UTC 毫秒，管理员时间则是 IANA 时区中的 HH:mm。使用 Intl 格式化部件而非手写偏移量，
 * 才能正确覆盖未来可选的夏令时地区；设置服务已在写入时验证时区与时间格式。
 */
function isDailyReportDue(now: string, timezone: string, dailyReportTime: string): boolean {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
  const fields = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${fields.hour}:${fields.minute}` === dailyReportTime;
}
