import type {
  GameDisplayName,
  GameNameBackfillResult,
  GameNameCatalogEntry,
  GameNameStore,
  PendingGameName,
} from "../repositories/ports";

/** 管理员保存时可提交的受控展示名称命令；身份键只从服务查询的既有游戏取得，客户端不能伪造复用范围。 */
export interface SaveManualGameNameInput {
  displayNameZhCn: string;
  source: GameNameCatalogEntry["source"];
  evidenceUrl: string | null;
  saveToCatalog: boolean;
}

/** 最终确认阶段需要的名称决策。source 仅说明展示状态，不能替代目录中可审计的具体来源标签。 */
export type ResolvedGameDisplayName = Pick<GameDisplayName, "displayNameZhCn"> & {
  source: "catalog" | "manual" | "pending";
};

/** 名称候选的可预期表单错误；API 只转换此类型，仓储或数据库故障仍保持内部错误而不会被当成管理员输入问题。 */
export class GameNameValidationError extends Error {}

/** 游戏不存在是稳定资源状态；独立错误类型让 API 返回 404，同时不依赖可能变化的中文 message 做分类，已确认游戏仍可继续更正。 */
export class GameNameNotFoundError extends Error {}

/**
 * 简体中文名称服务集中词条优先级、人工覆盖校验与回填调度。
 * 它只根据精确 identityKey 复用词条，不调用翻译、AI 或模糊标题匹配；这保证中文展示文本不会反向污染官方商品身份。
 */
export class GameNameService {
  public constructor(private readonly store: GameNameStore) {}

  /**
   * 管理员候选若出现就先执行统一长度校验，再由精确目录决定最终优先级；目录未命中时才把该候选标记为当前游戏 manual 名称。
   * identityKey 必须由调用方在官方重验后生成，本方法不接收标题、发行商或类型，因此人工文本无法反向改变或扩大词条身份。
   */
  public async resolveForConfirmedGame(identityKey: string, submittedName: string | null): Promise<ResolvedGameDisplayName> {
    const manualName = submittedName === null ? null : normalizeDisplayName(submittedName);
    const catalog = await this.store.findCatalogEntry(identityKey);
    if (catalog !== null) return { displayNameZhCn: catalog.displayNameZhCn, source: "catalog" };
    return manualName === null
      ? { displayNameZhCn: null, source: "pending" }
      : { displayNameZhCn: manualName, source: "manual" };
  }

  /** 待处理项始终由存储层按当前空展示名筛选，服务不从 legacyNameZh 推断或提升历史候选。 */
  public async listPending(): Promise<PendingGameName[]> {
    return this.store.listPending();
  }

  /** 回填委托给单个受控存储操作，使重复调度只报告真实更新而不会覆盖任何已确认的人工名称。 */
  public async backfill(now: string): Promise<GameNameBackfillResult> {
    return this.store.applyCatalogBackfill(now);
  }

  /**
   * 保存当前游戏的人工最终名称，并且仅在管理员明确选择时复用为同一身份的未来词条。
   * 身份查询覆盖 pending 与已确认游戏，支持详情页纠错；名称和 HTTPS 证据在写入前校验，避免空白/超长文本或不安全链接被误作可审计的中文确认事实。
   */
  public async saveManual(gameId: string, input: SaveManualGameNameInput, now: string): Promise<void> {
    const displayNameZhCn = normalizeDisplayName(input.displayNameZhCn);
    validateEvidenceUrl(input.source, input.evidenceUrl);
    const game = await this.store.findGameIdentity(gameId);
    if (game === null) throw new GameNameNotFoundError("游戏不存在。");
    if (game.identityKey === null) throw new GameNameValidationError("该游戏缺少精确官方身份，暂不能保存中文名称。");
    await this.store.saveGameName({
      gameId,
      identityKey: game.identityKey,
      displayNameZhCn,
      source: input.source,
      evidenceUrl: input.evidenceUrl,
      saveToCatalog: input.saveToCatalog,
      confirmedAt: now,
    });
  }
}

/** 修剪后长度必须落在数据库同一边界内，服务先拒绝可给 API 稳定错误而非依赖底层约束文本。 */
function normalizeDisplayName(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 120) {
    throw new GameNameValidationError("中文显示名称长度应为 1 到 120 个字符。");
  }
  return normalized;
}

/**
 * manual 是管理员针对单一游戏的最终责任确认，允许没有公开链接；其余可复用来源必须提供 HTTPS 证据。
 * 这避免无出处的 publisher、内地平台或香港参考文本自动回填到其他游戏，同时拒绝不安全协议进入管理界面。
 */
function validateEvidenceUrl(source: GameNameCatalogEntry["source"], evidenceUrl: string | null): void {
  if (evidenceUrl === null) {
    if (source === "manual") return;
    throw new GameNameValidationError("非人工名称来源必须提供 HTTPS 证据链接。");
  }
  let url: URL;
  try {
    url = new URL(evidenceUrl);
  } catch {
    throw new GameNameValidationError("名称证据链接必须使用 HTTPS。");
  }
  if (url.protocol !== "https:") throw new GameNameValidationError("名称证据链接必须使用 HTTPS。");
}
