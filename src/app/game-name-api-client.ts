import type { ApiRequestTracker } from "./api-request-tracker";

/** 名称管理页只接受服务端支持的商品类型枚举，不能用任意浏览器文本扩大目录身份范围。 */
export type GameNameProductType = "game" | "upgrade-pack" | "dlc" | "season-pass" | "bundle" | "other";

/**
 * 待补充名称 DTO 只包含管理员辨认官方商品所需的公开字段。
 * identityKey 可能为空，此时服务端会拒绝保存；legacyNameZh 仅是可编辑候选，前端不能自动确认。
 */
export interface PendingGameNameDto {
  gameId: string;
  subscriptionId: string;
  identityKey: string | null;
  officialTitle: string;
  publisher: string | null;
  productType: GameNameProductType;
  legacyNameZh: string;
}

/** 名称目录回填只报告真实更新 ID 和剩余数量；页面随后必须重读队列，不能据此自行删行。 */
export interface GameNameBackfillResponse {
  updatedGameIds: string[];
  remainingCount: number;
}

/** 向导名称建议只提交已公开的官方身份字段；candidateKey 仅用于关联返回顺序，不参与目录键。 */
export interface GameNameSuggestionCandidate {
  candidateKey: string;
  canonicalTitle: string;
  publisher: string | null;
  productType: GameNameProductType;
}

/**
 * AI 端点返回的数据已经由服务端过滤为可展示的最小形态。low 置信度必须没有名称，
 * 浏览器只能把非空名称作为待确认草稿，不能将模型输出解释成已经保存或已经核验的目录词条。
 */
export interface AiGameNameSuggestion {
  candidateKey: string;
  displayNameZhCn: string | null;
  confidence: "high" | "medium" | "low";
}

/** 管理员保存命令明确区分当前游戏覆盖和可复用目录词条，证据链接只允许由服务端最终校验。 */
export interface SaveGameNameInput {
  displayNameZhCn: string;
  source: "publisher" | "mainland-platform" | "hk-reference" | "manual";
  evidenceUrl: string | null;
  saveToCatalog: boolean;
}

/**
 * 可展示的名称 API 错误只保留服务端脱敏摘要和 HTTP 状态。
 * 不保存 Response、请求正文、Cookie 或证据页面，避免名称管理表单在内存中积累无关敏感数据。
 */
export class GameNameApiError extends Error {
  public constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "GameNameApiError";
  }
}

/**
 * 创建五个同源名称端点的无状态客户端，覆盖待补充读取、回填、目录建议、AI 建议与人工保存。
 * 浏览器只携带 HttpOnly Cookie 的 same-origin 凭据，
 * 不读取会话、不访问公开证据站，也不根据官方标题自行翻译或生成中文名称。
 */
export function createGameNameApiClient(request: typeof fetch = fetch, tracker?: ApiRequestTracker) {
  /** 统一 JSON 边界在所有成功、422、401 与网络失败路径释放全局请求计数，避免遮罩永久残留。 */
  async function requestJson<TResponse>(path: string, method: "GET" | "POST" | "PATCH", body?: unknown): Promise<TResponse> {
    const finish = tracker?.begin();
    try {
      const response = await request(path, {
        method,
        credentials: "same-origin",
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new GameNameApiError(payload.error ?? "游戏名称请求未完成，请稍后重试。", response.status);
      return payload as TResponse;
    } finally {
      finish?.();
    }
  }

  return {
    /** 待补充列表使用唯一受支持的 pending 筛选，未知状态不能在浏览器端被静默解释。 */
    async listPending(): Promise<{ games: PendingGameNameDto[] }> {
      return requestJson<{ games: PendingGameNameDto[] }>("/api/game-names?status=pending", "GET");
    },

    /** 回填请求不附带浏览器候选；服务端只按精确目录身份更新仍为空的游戏名称。 */
    async backfill(): Promise<GameNameBackfillResponse> {
      return requestJson<GameNameBackfillResponse>("/api/game-names/backfill", "POST");
    },

    /** 批量建议只包裹候选数组，服务端会逐字段重建并重新计算官方身份键。 */
    async suggestNames(candidates: GameNameSuggestionCandidate[]): Promise<{ suggestions: Array<{ candidateKey: string; displayNameZhCn: string | null }> }> {
      return requestJson("/api/game-names/suggestions", "POST", { candidates });
    },

    /** AI 建议只读取本批官方公开身份字段，不会保存名称、创建游戏或绕过管理员最终确认。 */
    async suggestAiNames(candidates: GameNameSuggestionCandidate[]): Promise<{ suggestions: AiGameNameSuggestion[] }> {
      return requestJson<{ suggestions: AiGameNameSuggestion[] }>("/api/game-names/ai-suggestions", "POST", { candidates });
    },

    /** 单条保存对 gameId 做单段编码；中文名、来源与复用选择由服务端再次校验后才可写入。 */
    async saveGameName(gameId: string, input: SaveGameNameInput): Promise<{ gameId: string; displayNameZhCn: string; source: "manual" }> {
      return requestJson(`/api/game-names/${encodeURIComponent(gameId)}`, "PATCH", input);
    },
  };
}
