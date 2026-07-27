import type { JapaneseUpgradeRootCandidate } from "./official-japanese-upgrade-root";

/**
 * 日区升级包关系核验的跨平台契约与纯 URL 规则。
 * 此模块不导入 Browser Binding、Cloudflare 类型或 Playwright，使 Node 运行时可复用相同的业务结果、批量限制和输入安全约束；实际浏览器生命周期仅由 Worker 适配器实现。
 */

/** 单项关系核验只返回已脱敏的业务分类，绝不向上层暴露页面正文、会话标识或底层运行时异常。 */
export type JapaneseUpgradeBrowserResult =
  | { status: "success"; upgradeUrl: string }
  | { status: "browser-unavailable" | "timeout" | "blocked-or-missing" | "multiple-matches" | "invalid-official-url" };

/** 请求级批处理只承诺输入顺序对应的独立安全结论；各平台适配器自行决定如何满足隔离和资源释放要求。 */
export interface JapaneseUpgradeBrowserBatch {
  resolve(roots: JapaneseUpgradeRootCandidate[], signal: AbortSignal): Promise<Map<string, JapaneseUpgradeBrowserResult>>;
}

/** 超过已批准的三项深度核验上限时使用的受控错误；路由层可据此返回明确的 422，而不会部分处理输入。 */
export class JapaneseUpgradeBatchLimitError extends Error {}

/**
 * 仅接受同站相对路径或精确的日区商城 HTTPS 下载软件链接，并统一为带尾斜杠的绝对 URL。
 * 严格拒绝非 HTTPS、其他主机、端口、凭据、查询、片段和非 D 数字软件路径，防止外部 href 将任意平台适配器导向外站或带状态参数的页面。
 */
export function normalizeJapaneseUpgradeUrl(value: string | null): string | null {
  if (value === null || /\s/u.test(value)) return null;
  try {
    const url = new URL(value, "https://store-jp.nintendo.com");
    const match = /^\/item\/software\/(D[0-9]+)\/?$/.exec(url.pathname);
    return url.protocol === "https:"
      && url.hostname === "store-jp.nintendo.com"
      && url.port === ""
      && url.username === ""
      && url.password === ""
      && url.search === ""
      && url.hash === ""
      && match !== null
      ? `https://store-jp.nintendo.com/item/software/${match[1]}/`
      : null;
  } catch {
    return null;
  }
}
