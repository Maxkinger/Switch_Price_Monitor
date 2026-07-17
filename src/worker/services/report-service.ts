import type { PriceSource } from "../../shared/domain";

/** Telegram 对单条消息的硬性限制；正文预留页码空间，避免最后追加“第 n/m 页”后超出平台限制。 */
const telegramMessageLimit = 4096;
const pageContentLimit = 4000;

/** 日报读取模型只保留展示所需字段，避免格式化器接触订阅内部配置、会话或任何 Telegram 凭据。 */
export interface ReportPrice {
  amountMinor: number;
  cnyFen: number | null;
  source: PriceSource;
  capturedAt: string;
}

/** 单个地区的最新价格和本币历史最低价；current 为 null 表示所有来源失败，仅能在页面显示旧数据状态。 */
export interface DailyReportRegion {
  regionalProductId: string;
  regionCode: string;
  currency: string;
  current: ReportPrice | null;
  historicalLow: ReportPrice | null;
}

/** 全区历史最低价必须已有人民币换算，才能作为跨币种购买成本比较结果。 */
export interface AllRegionHistoricalLow extends ReportPrice {
  regionalProductId: string;
  regionCode: string;
  currency: string;
  cnyFen: number;
}

/** 日报仅汇总启用订阅；停用订阅保留在数据库用于历史查询，但不应继续产生 Telegram 消息。 */
export interface DailyReportSubscription {
  subscriptionId: string;
  nameZh: string;
  enabled: boolean;
  allRegionHistoricalLow: AllRegionHistoricalLow | null;
  regions: DailyReportRegion[];
}

/** 报告输入由调度器在一次读取中构造；timezone 既用于日报标题，也用于所有历史最低价日期的统一展示。 */
export interface DailyReportInput {
  subscriptions: DailyReportSubscription[];
  timezone: string;
  generatedAt: string;
}

/** Telegram 发送层只需要文本；消息 ID、Token 和 Chat ID 均不属于报告格式化服务。 */
export interface TelegramMessage {
  text: string;
}

/**
 * 生成简体中文日报并分页。每个订阅块尽量完整保留在同一条消息，超长商品名等极端情况才按字符切分，
 * 因而不会因 Telegram 长度限制静默丢失某个地区、来源标记或历史最低价。
 */
export function buildDailyReport(input: DailyReportInput): TelegramMessage[] {
  const header = `🍳 Switch 价格日报\n生成时间：${formatLocalDateTime(input.generatedAt, input.timezone)}（${input.timezone}）\n\n`;
  const sections = input.subscriptions.filter((subscription) => subscription.enabled).map(formatSubscription);
  if (sections.length === 0) return [{ text: `${header}暂无启用的订阅。\n\n第 1/1 页` }];

  const pages = splitPages(header, sections);
  return pages.map((page, index) => ({ text: `${page.trimEnd()}\n\n第 ${index + 1}/${pages.length} 页` }));
}

/** 将一款商品的当前价、全区最低价与分区最低价集中成一个文本块，便于分页器保持商品信息连续。 */
function formatSubscription(subscription: DailyReportSubscription): string {
  const currentRows = subscription.regions.map((region) => {
    if (!region.current) return `• ${regionLabel(region.regionCode)}：暂无成功价格`;
    return `• ${regionLabel(region.regionCode)}：${formatMoney(region.current.amountMinor, region.currency)}（${formatCny(region.current.cnyFen)}） ${formatSource(region.current.source)}`;
  });
  const allRegionLow = subscription.allRegionHistoricalLow
    ? `${regionLabel(subscription.allRegionHistoricalLow.regionCode)} ${formatMoney(subscription.allRegionHistoricalLow.amountMinor, subscription.allRegionHistoricalLow.currency)}（${formatCny(subscription.allRegionHistoricalLow.cnyFen)}，${formatLocalDate(subscription.allRegionHistoricalLow.capturedAt)}）`
    : "暂无可比较的人民币历史记录";
  const regionalLows = subscription.regions.map((region) => {
    if (!region.historicalLow) return `• ${regionLabel(region.regionCode)}：暂无历史记录`;
    return `• ${regionLabel(region.regionCode)}：${formatMoney(region.historicalLow.amountMinor, region.currency)}（${formatCny(region.historicalLow.cnyFen)}，${formatLocalDate(region.historicalLow.capturedAt)}）`;
  });
  return `《${subscription.nameZh}》\n当前价格：\n${currentRows.join("\n")}\n全区历史最低：${allRegionLow}\n各区历史最低：\n${regionalLows.join("\n")}\n\n`;
}

/**
 * 在不超过保守正文长度的前提下追加商品块。若某个块本身异常长，按字符拆分仍优先保证文本完整，
 * 因为 Telegram 只传文本且任何截断都会使管理员无法判断是哪一区数据缺失。
 */
function splitPages(header: string, sections: string[]): string[] {
  const pages: string[] = [];
  let current = header;
  for (const section of sections) {
    let remaining = section;
    while (remaining.length > 0) {
      const available = pageContentLimit - current.length;
      if (remaining.length <= available) {
        current += remaining;
        remaining = "";
      } else if (current.length > header.length) {
        pages.push(current);
        current = header;
      } else {
        current += remaining.slice(0, available);
        remaining = remaining.slice(available);
        pages.push(current);
        current = header;
      }
    }
  }
  if (current.length > header.length) pages.push(current);
  return pages;
}

/** 把五区常用币种从最小货币单位恢复为用户熟悉的店铺标价；未知币种保留代码而不臆造符号。 */
function formatMoney(amountMinor: number, currency: string): string {
  const fractionDigits = currency === "JPY" ? 0 : 2;
  const amount = amountMinor / (fractionDigits === 0 ? 1 : 100);
  const value = new Intl.NumberFormat("en-US", { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }).format(amount);
  const prefix = { USD: "US$", JPY: "JP¥", MXN: "MX$", BRL: "R$", HKD: "HK$" }[currency];
  return prefix ? `${prefix}${value}` : `${currency} ${value}`;
}

/** 人民币分可为空：汇率失败时仍展示本币价格，但日报必须诚实提示无法换算而不是用零元代替。 */
function formatCny(cnyFen: number | null): string {
  return cnyFen === null ? "人民币待换算" : `约 ¥${(cnyFen / 100).toFixed(2)}`;
}

/** 官方与第三方来源采用明确不同文案，确保第三方回退价格不会被阅读者误认为可触发即时提醒的官方价格。 */
function formatSource(source: PriceSource): string {
  if (source === "official") return "官方";
  const names: Record<Exclude<PriceSource, "official">, string> = {
    "eshop-prices": "eShop-Prices",
    "nt-deals": "NT Deals",
    "deku-deals": "Deku Deals",
    "green-pipe": "Green Pipe",
  };
  return `第三方：${names[source]}`;
}

/** 将固定的五区代码转换为简体中文名称；未知地区保留代码，避免日报在未来扩区时丢失关键信息。 */
function regionLabel(regionCode: string): string {
  return { US: "美国区", JP: "日本区", MX: "墨西哥区", BR: "巴西区", HK: "香港区" }[regionCode] ?? regionCode;
}

/** 历史最低价的日期由快照 UTC 日期截取，避免因页面展示时区变化而改变同一条不可变历史记录的标识。 */
function formatLocalDate(capturedAt: string): string {
  return capturedAt.slice(0, 10);
}

/** 日报标题使用管理员设置的时区，保证每天 09:00 的消息显示与触发语义一致的本地时间。 */
function formatLocalDateTime(value: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value));
  const fields = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day} ${fields.hour}:${fields.minute}`;
}
