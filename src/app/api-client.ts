import type {
  ConfirmedSubscriptionInput,
  OfficialProductCandidate,
  OfficialSearchResult,
  RegionCode,
  SubscriptionConfirmationResult,
  SubscriptionRegionPreview
} from "../shared/domain";

/**
 * 商品接口返回的跨区匹配状态。
 *
 * 此类型刻意只描述本站 Worker 返回的 DTO，不暴露任天堂或第三方站点的请求细节。
 * 浏览器始终只和同源的 `/api/products/*` 通信，由 Worker 负责官方页面访问与校验。
 */
export type RegionResolutionResponse =
  | {
      candidateKey: string;
      regionCode: RegionCode;
      status: "automatic";
      candidate: OfficialProductCandidate;
    }
  | {
      candidateKey: string;
      regionCode: RegionCode;
      status: "needs-manual-selection";
      message: string;
      candidates: OfficialProductCandidate[];
    }
  | {
      candidateKey: string;
      regionCode: RegionCode;
      status: "needs-manual-link";
      message: string;
    };

/**
 * 当本站 API 无法完成请求时抛出的受控错误。
 *
 * 页面可以安全显示该消息；`status` 只用于识别 401 并由认证壳层清除过期向导状态，
 * 不会把底层抓取器、数据库或外站响应的细节泄漏给浏览器。
 */
export class ProductApiError extends Error {
  public constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ProductApiError";
  }
}

/**
 * 创建“添加订阅”向导的同源 API 客户端。
 *
 * 价格来源（任天堂官方站、后续配置的第三方回退站）全部在 Worker 内部处理，
 * 此模块禁止拼接或请求外部商品地址，以免泄漏密钥、绕开来源标记或触发跨域限制。
 */
export function createProductApiClient(request: typeof fetch = fetch) {
  /** 统一发送 JSON 请求，并将非成功状态转换成可展示的错误。 */
  async function postJson<TResponse>(path: string, body: unknown): Promise<TResponse> {
    const response = await request(path, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
    };

    if (!response.ok) {
      throw new ProductApiError(payload.error ?? "请求未完成，请稍后重试。", response.status);
    }

    return payload as TResponse;
  }

  return {
    /** 在当前默认搜索区检索任天堂官方候选商品。 */
    async searchProducts(query: string): Promise<OfficialSearchResult> {
      return postJson<OfficialSearchResult>("/api/products/search", { query });
    },

    /** 通过用户粘贴的官方商店链接核验一个地区商品。 */
    async resolveOfficialLink(regionCode: RegionCode, productUrl: string): Promise<OfficialProductCandidate> {
      const payload = await postJson<{ candidate: OfficialProductCandidate }>("/api/products/resolve-link", {
        regionCode,
        productUrl
      });

      return payload.candidate;
    },

    /** 为已选默认区商品匹配其他启用地区的官方候选结果。 */
    async resolveRegions(candidates: OfficialProductCandidate[]): Promise<RegionResolutionResponse[]> {
      const payload = await postJson<{ regions: RegionResolutionResponse[] }>("/api/products/resolve-regions", {
        candidates,
      });

      return payload.regions;
    },

    /** 在确认写入前预览各地区会使用的价格来源与回退规则。 */
    async previewSources(candidates: OfficialProductCandidate[]): Promise<SubscriptionRegionPreview[]> {
      const payload = await postJson<{ regions: SubscriptionRegionPreview[] }>("/api/products/preview-sources", {
        candidates
      });

      return payload.regions;
    },

    /** 将用户核验后的多款商品一次性确认成订阅。 */
    async confirmSubscriptions(
      subscriptions: ConfirmedSubscriptionInput[]
    ): Promise<SubscriptionConfirmationResult[]> {
      const payload = await postJson<{ subscriptions: SubscriptionConfirmationResult[] }>(
        "/api/products/confirm-subscriptions",
        { subscriptions }
      );

      return payload.subscriptions;
    }
  };
}
