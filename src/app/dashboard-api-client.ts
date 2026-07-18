/**
 * 仪表盘浏览器 DTO 只复述 Worker 已公开的 JSON 契约，不导入 Worker 实现或 D1 类型。
 * 这样前端构建不会携带服务端适配器、价格来源网络逻辑或潜在的运行时秘密。
 */
export interface DashboardPrice {
  amountMinor: number;
  cnyFen: number | null;
  source: string;
  capturedAt: string;
}

/** 单区概览保留真实价格状态；无价格和过期由 Worker 判断，浏览器不得自行推断。 */
export interface DashboardRegion {
  regionalProductId: string;
  regionCode: string;
  currency: string;
  current: DashboardPrice | null;
  historicalLow: DashboardPrice | null;
  isStale: boolean;
}

/** 仪表盘卡片数据，暂停订阅也会返回以便管理员恢复，但不由页面计入实时采集统计。 */
export interface DashboardSubscription {
  subscriptionId: string;
  gameId: string;
  nameZh: string;
  nameEn: string;
  enabled: boolean;
  regionalProductIds: string[];
  allRegionHistoricalLow: (DashboardPrice & { regionalProductId: string; regionCode: string; currency: string; cnyFen: number }) | null;
  regions: DashboardRegion[];
}

/** 首页需要的统计与卡片集合；ISO 时间交给页面按管理员的阅读场景格式化。 */
export interface DashboardOverview {
  stats: {
    monitoredSubscriptionCount: number;
    availableRegionPriceCount: number;
    lastCapturedAt: string | null;
    nextDailyReportAt: string | null;
  };
  subscriptions: DashboardSubscription[];
}

/** 订阅详情只含管理员安全展示和编辑所需字段，不会透出商品链接、会话或通知配置。 */
export interface SubscriptionDetail {
  subscriptionId: string;
  game: { id: string; nameZh: string; nameEn: string; productType: string };
  enabled: boolean;
  globalTargetCnyFen: number | null;
  regionTargets: Array<{ regionCode: string; targetAmountMinor: number }>;
  regions: Array<DashboardRegion & { monitored: boolean }>;
}

/** 历史查询返回不可变快照，趋势视图只使用其中具备人民币换算的记录。 */
export interface HistorySnapshot extends DashboardPrice {
  regionCode: string;
  currency: string;
}

/**
 * 立即刷新完成结果只携带服务端聚合计数和执行时刻；页面据此提示管理员并重新读取持久化仪表盘，
 * 不在浏览器内保存供应商页面、地区商品链接、原始价格响应或任何会话数据。
 */
export interface CompletedRefreshResult {
  status: "completed";
  executedAt: string;
  attempted: number;
  collected: number;
  stale: number;
}

import type { ConfirmedRegionalProduct, RegionCode } from "../shared/domain";
import type { RegionResolutionResponse } from "./api-client";
import type { ApiRequestTracker } from "./api-request-tracker";

/** PATCH 的三个互斥更新形状严格对应 Worker 现有校验，避免前端拼接未支持的自由字段。 */
export type SubscriptionUpdate =
  | { enabled: boolean }
  | { regionalProductIds: string[] }
  | { globalTargetCnyFen: number | null; regionTargets: Array<{ regionCode: string; targetAmountMinor: number }> };

/**
 * 已有订阅补全只提交本次新确认的官方候选与明确跳过地区；游戏 ID、已有商品 ID 和启用地区范围不在浏览器载荷中，
 * Worker 会从受认证订阅与保存设置重新读取这些安全边界并在写入前重新验证每个官方链接。
 */
export interface MissingRegionCompletionInput {
  regions: ConfirmedRegionalProduct[];
  skippedRegionCodes: RegionCode[];
}

/** 补全成功只返回订阅与新增地区代码，页面必须重新读取详情，不能在本地拼接价格、历史或监控状态。 */
export interface MissingRegionCompletionResult {
  subscriptionId: string;
  addedRegionCodes: RegionCode[];
}

/**
 * 可展示的站内 API 错误。只保留 Worker 已脱敏的中文摘要、状态和刷新冷却时刻，
 * 不保存 Response、Cookie、请求体或 HTML，避免管理员浏览器内存持有无关敏感内容。
 */
export class DashboardApiError extends Error {
  public constructor(message: string, public readonly status: number, public readonly nextAllowedAt?: string) {
    super(message);
    this.name = "DashboardApiError";
  }
}

/**
 * 创建仪表盘同源客户端。所有路径均为固定的 `/api/*`，并强制携带 same-origin 凭据，
 * 使 HttpOnly 会话 Cookie 只由浏览器处理，前端不读取、不拼接也不转交给外部来源。
 */
export function createDashboardApiClient(request: typeof fetch = fetch, tracker?: ApiRequestTracker) {
  /**
   * 统一 JSON 传输层只解析 Worker 明确返回的 JSON。非 2xx 都变成受控错误，
   * 401 留给应用壳层清除内存状态，422 留给表单保留草稿，429 留给刷新冷却提示。
   */
  async function requestJson<TResponse>(path: string, method: "GET" | "POST" | "PATCH", body?: unknown): Promise<TResponse> {
    const finish = tracker?.begin();
    try {
      const response = await request(path, {
        method,
        credentials: "same-origin",
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string; nextAllowedAt?: string };
      if (!response.ok) {
        throw new DashboardApiError(payload.error ?? "请求未完成，请稍后重试。", response.status, payload.nextAllowedAt);
      }
      return payload as TResponse;
    } finally {
      // 所有受认证读取/写入均由 finally 结算，防止 401、429 或网络异常让遮罩无法退出。
      finish?.();
    }
  }

  return {
    /** 读取已登录管理员的首页概览；服务端会决定价格来源、过期状态和下次日报，不由浏览器猜测。 */
    async getDashboard(): Promise<DashboardOverview> {
      return requestJson<DashboardOverview>("/api/dashboard", "GET");
    },

    /** 按受控订阅 ID 读取详情；调用方只可来自本站路由解析结果，不能传外站 URL。 */
    async getSubscription(subscriptionId: string): Promise<SubscriptionDetail> {
      return requestJson<SubscriptionDetail>(`/api/subscriptions/${encodeURIComponent(subscriptionId)}`, "GET");
    },

    /** 历史接口只接受订阅与可选地区代码，缺失人民币换算的快照仍保留给单区历史提示。 */
    async getHistory(subscriptionId: string, regionCode: string | null): Promise<{ snapshots: HistorySnapshot[] }> {
      const query = new URLSearchParams({ subscriptionId });
      if (regionCode) query.set("region", regionCode);
      return requestJson<{ snapshots: HistorySnapshot[] }>(`/api/history?${query.toString()}`, "GET");
    },

    /**
     * 手动刷新在 Worker 完成统一采集后才返回；调用页仍要重新读取详情或仪表盘，
     * 以避免浏览器依据聚合计数自行拼接价格、汇率、历史最低价或过期状态。
     */
    async refreshNow(): Promise<CompletedRefreshResult> {
      return requestJson<CompletedRefreshResult>("/api/refresh", "POST");
    },

    /** 保存一类订阅配置后由页面重新读取详情，避免本地合并覆盖 Worker 的校验结果或并发变更。 */
    async updateSubscription(subscriptionId: string, update: SubscriptionUpdate): Promise<unknown> {
      return requestJson<unknown>(`/api/subscriptions/${encodeURIComponent(subscriptionId)}`, "PATCH", update);
    },

    /** 让 Worker 从当前订阅官方锚点和保存设置解析缺失地区；请求体为空，不能由浏览器附带地区范围。 */
    async resolveMissingRegions(subscriptionId: string): Promise<RegionResolutionResponse[]> {
      return requestJson<RegionResolutionResponse[]>(`/api/subscriptions/${encodeURIComponent(subscriptionId)}/resolve-regions`, "POST", {});
    },

    /** 提交人工确认或明确跳过的缺失地区；服务端会原子追加并由详情重新读取结果。 */
    async completeMissingRegions(subscriptionId: string, input: MissingRegionCompletionInput): Promise<MissingRegionCompletionResult> {
      return requestJson<MissingRegionCompletionResult>(`/api/subscriptions/${encodeURIComponent(subscriptionId)}/complete-regions`, "POST", input);
    },
  };
}
