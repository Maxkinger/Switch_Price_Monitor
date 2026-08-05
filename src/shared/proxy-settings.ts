/**
 * 网络代理共享领域模型。
 * 此文件同时进入浏览器与 Node 构建，故只能使用 Web 标准 URL 能力；代理认证、完整连接 URL 和 Node 网络模块均不能越过这条边界。
 */
export const proxyProtocols = ["http", "https", "socks5"] as const;

/** 代理协议仅限首版已确认的三种无认证传输，避免页面或 API 悄然接受 PAC、代理链等未审计模式。 */
export type ProxyProtocol = (typeof proxyProtocols)[number];

/**
 * 一份代理草稿只保存可公开管理的端点字段。
 * `host` 永远是不含方括号的标准主机名、IPv4 或 IPv6；用户名、密码和认证 URL 不属于该模型。
 */
export interface ProxySettings {
  enabled: boolean;
  protocol: ProxyProtocol;
  host: string;
  port: number;
}

/**
 * 默认值仅为关闭状态下的可编辑草稿，首次 PostgreSQL 升级不会据此创建任何代理连接。
 * 选用常见本机端口帮助管理员填写，但启用前仍会由服务端再次校验全部字段。
 */
export const defaultProxySettings: ProxySettings = {
  enabled: false,
  protocol: "http",
  host: "127.0.0.1",
  port: 7890,
};

/**
 * 将主机规范为 URL 解析器认可的稳定形式，且拒绝一切可扩展为完整 URL 或认证信息的语法。
 * IPv6 临时加方括号只为让 URL 正确解析；持久化和日志边界仍保存不含方括号的纯主机，避免调用方拼接不同形式的连接地址。
 */
export function normalizeProxyHost(value: string): string | null {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) return null;
  if (/[\u0000-\u0020\u007f/@?#\\]/.test(value)) return null;

  const candidate = value.includes(":") ? `[${value}]` : value;
  try {
    const parsed = new URL(`http://${candidate}`);
    if (parsed.port !== "" || parsed.username !== "" || parsed.password !== "" || parsed.pathname !== "/") return null;
    const hostname = parsed.hostname;
    if (!hostname) return null;
    // WHATWG URL 会为 IPv6 保留方括号；领域模型只保存裸地址，供 HTTP Agent 与 Playwright 统一按需补回。
    return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  } catch {
    return null;
  }
}

/**
 * 校验代理草稿的全部字段并只返回固定中文摘要。
 * 即使代理关闭也不放宽主机与端口约束，避免管理员以后切换开关时利用旧草稿绕过服务端校验或形成认证 URL。
 */
export function validateProxySettings(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "代理设置无效。";
  const settings = value as Partial<ProxySettings>;
  if (typeof settings.enabled !== "boolean") return "代理设置无效。";
  if (typeof settings.protocol !== "string" || !proxyProtocols.includes(settings.protocol as ProxyProtocol)) return "代理协议无效。";
  if (typeof settings.host !== "string" || normalizeProxyHost(settings.host) === null) return "代理主机无效。";
  if (typeof settings.port !== "number" || !Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65_535) return "代理端口无效。";
  return null;
}
