import type {
  GameNameDecision,
  GameNameSyncResult,
} from "../../shared/domain";
import type { GameNameSource } from "../../shared/game-name";
import { hasChineseText } from "../../shared/traditional-to-simplified";
import {
  GameNameRepository,
  type GameNameSyncItem,
} from "../repositories/game-name-repository";
import type { GameNameService, OfficialGameNameResolution } from "./game-name-service";

/** 同步服务只消费官方名称解析窄接口，不能接触搜索候选、页面正文或大陆适配器的外部响应。 */
type OfficialGameNameResolver = Pick<GameNameService, "resolveOfficialName">;

/** 名称同步的可预期选择与归属错误；未来受保护路由可安全映射为 422，而不暴露 D1 或任天堂响应细节。 */
export class GameNameSyncError extends Error {}

/**
 * 既有游戏名称同步以订阅 ID 为唯一授权边界：仓储重建英文锚点和已监控 HK URL，名称服务只负责官方解析，
 * 本服务决定官方立即写入、人工名称保护及管理员最终回退，任何浏览器载荷都不能指定 game ID 或来源枚举。
 */
export class GameNameSyncService {
  public constructor(
    private readonly repository: GameNameRepository,
    private readonly gameNames: OfficialGameNameResolver,
  ) {}

  /**
   * 逐项同步非人工来源；`manual_chinese` 代表既有管理员决定，普通同步只返回待决策而不请求外部源或覆盖。
   * 所有订阅先完成去重和归属读取，未知 ID 在任何官方请求与写入前受控失败，避免批量请求产生部分更新。
   */
  public async sync(subscriptionIds: string[], now: string): Promise<GameNameSyncResult[]> {
    const items = await this.readRequestedItems(subscriptionIds);
    const resolutions = await Promise.all(items.map(async (item) => item.source === "manual_chinese"
      ? null
      : this.gameNames.resolveOfficialName(item.anchor, item.hongKongProductUrl)));

    const results: GameNameSyncResult[] = [];
    for (const [index, item] of items.entries()) {
      const official = resolutions[index];
      if (official === null || official.kind === "unavailable") {
        results.push({ subscriptionId: item.subscriptionId, status: "needs-decision", nameEn: item.nameEn });
        continue;
      }
      await this.updateOrThrow(item.subscriptionId, official.nameZh, official.kind, now);
      results.push({ subscriptionId: item.subscriptionId, status: "updated_official", nameEn: item.nameEn });
    }
    return results;
  }

  /**
   * 提交管理员决定前再次解析官方名称，防止预览后官网恢复却被旧人工输入覆盖；官方成功始终优先写入。
   * 仅当最终重验仍不可用时，含汉字的 1–200 字名称写 manual_chinese，空/缺失名称写受仓储保护的 name_en 英文回退。
   */
  public async confirmDecisions(decisions: GameNameDecision[], now: string): Promise<void> {
    const normalized = normalizeDecisions(decisions);
    const items = await this.readRequestedItems(normalized.map((decision) => decision.subscriptionId));
    // 先完成整批最终官方重验，再进入任何 D1 更新；外部异常不会让同一次管理员决策只保存前半部分。
    const officialNames = await Promise.all(items.map((item) => this.gameNames.resolveOfficialName(
      item.anchor,
      item.hongKongProductUrl,
    )));

    for (const [index, item] of items.entries()) {
      const official = officialNames[index];
      const decision = normalized[index];
      if (official.kind !== "unavailable") {
        await this.updateOrThrow(item.subscriptionId, official.nameZh, official.kind, now);
        continue;
      }
      const nameZh = decision.nameZh ?? item.nameEn;
      const source: GameNameSource = decision.nameZh === null ? "official_english_fallback" : "manual_chinese";
      await this.updateOrThrow(item.subscriptionId, nameZh, source, now);
    }
  }

  /**
   * 空数组、重复 ID 与未知订阅都在外部解析和写入前拒绝；按请求顺序重排仓储结果，
   * 使返回值和最终决定不会因 SQL 排序或 D1 实现差异串到另一订阅。
   */
  private async readRequestedItems(subscriptionIds: string[]): Promise<GameNameSyncItem[]> {
    if (subscriptionIds.length === 0) throw new GameNameSyncError("请至少选择一个游戏名称。");
    if (new Set(subscriptionIds).size !== subscriptionIds.length) throw new GameNameSyncError("同一批次不能重复选择同一订阅。");
    const items = await this.repository.findForSync(subscriptionIds);
    const bySubscription = new Map(items.map((item) => [item.subscriptionId, item]));
    if (bySubscription.size !== subscriptionIds.length) throw new GameNameSyncError("所选订阅不存在或缺少可同步的地区商品。");
    return subscriptionIds.map((subscriptionId) => bySubscription.get(subscriptionId) as GameNameSyncItem);
  }

  /** 零行更新表示订阅在读取后被删除或失去归属；不得把并发失效伪装成已保存成功。 */
  private async updateOrThrow(
    subscriptionId: string,
    nameZh: string,
    source: GameNameSource,
    now: string,
  ): Promise<void> {
    const updated = await this.repository.updateForSubscription(subscriptionId, nameZh, source, now);
    if (!updated) throw new GameNameSyncError("所选订阅已失效，请刷新后重试。");
  }
}

/** 内部决策把 null 作为英文回退哨兵；它不会跨越公共接口或写入数据库的名称字段。 */
interface NormalizedGameNameDecision {
  subscriptionId: string;
  nameZh: string | null;
}

/**
 * 先验证整批人工输入再读取或写入：空白等价于缺失并表示英文回退；
 * 其它值必须含汉字且按 Unicode 字符计不超过 200，避免假名、纯英文或超长内容被误标为人工中文。
 */
function normalizeDecisions(decisions: GameNameDecision[]): NormalizedGameNameDecision[] {
  if (decisions.length === 0) throw new GameNameSyncError("请至少提交一个游戏名称决定。");
  const subscriptionIds = decisions.map((decision) => decision.subscriptionId);
  if (new Set(subscriptionIds).size !== subscriptionIds.length) throw new GameNameSyncError("同一批次不能重复决定同一订阅。");
  return decisions.map((decision) => ({
    subscriptionId: decision.subscriptionId,
    nameZh: normalizeManualChineseName(decision.nameZh),
  }));
}

/** 运行时仍验证 unknown 形态，防止未来 JSON 路由绕过 TypeScript 可选字符串契约后写入错误来源。 */
function normalizeManualChineseName(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new GameNameSyncError("人工中文名称必须包含汉字且长度为 1–200 个字符。");
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  if (Array.from(normalized).length > 200 || !hasChineseText(normalized)) {
    throw new GameNameSyncError("人工中文名称必须包含汉字且长度为 1–200 个字符。");
  }
  return normalized;
}
