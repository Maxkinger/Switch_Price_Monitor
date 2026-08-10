import type { OutboundNetwork, TransportPath } from "../server/network/outbound-network";
import type { ProxySettings } from "../shared/proxy-settings";

/** 固定 HTTP 目标防止管理员将设置页连接测试扩展成任意 URL 探测器或内网转发器。 */
const fixedHttpTarget = "https://www.nintendo.com/robots.txt";
/** 浏览器目标单独固定为日区商城，确保 Chromium 代理路径也只访问已批准的官方 origin。 */
const fixedBrowserTarget = "https://store-jp.nintendo.com/robots.txt";

/** 页面可展示的连接结果只包含安全路径分类，不包含代理端点、响应正文或底层网络错误。 */
export type ProxyConnectionTestStatus = "proxy-success" | "direct-fallback-success" | "failed";

/** 两条独立通道都需要返回，HTTP 成功不得掩盖浏览器失败，反之亦然。 */
export interface ProxyConnectionTestResult {
  http: ProxyConnectionTestStatus;
  browser: ProxyConnectionTestStatus;
}

/** 浏览器探测器只接收已校验草稿、固定 URL 与取消信号；它不能读取数据库、Cookie 或页面正文。 */
export interface ProxyBrowserConnectionProbe {
  probe(settings: ProxySettings, target: string, signal: AbortSignal): Promise<ProxyConnectionTestStatus>;
}

/** 同一管理员同时运行多组探测会制造不必要的 Chromium 与代理流量，故明确拒绝并映射为可重试 409。 */
export class ProxyConnectionTestBusyError extends Error {
  public constructor() {
    super("代理连接测试正在进行。");
    this.name = "ProxyConnectionTestBusyError";
  }
}

/**
 * 通过统一出站层执行临时草稿测试。测试不会读取或写入持久化设置，关闭的草稿也会临时启用以验证填写端点。
 * 任何已收到的 HTTP 响应都表明传输建立；4xx/5xx 是目标业务结果，不能再触发一次直连。
 */
export class ProxyConnectionTestService {
  private inFlight = false;

  public constructor(
    private readonly outbound: Pick<OutboundNetwork, "probe">,
    private readonly browser?: ProxyBrowserConnectionProbe,
    private readonly timeoutMs = 8_000,
  ) {}

  public async test(settings: ProxySettings): Promise<ProxyConnectionTestResult> {
    if (this.inFlight) throw new ProxyConnectionTestBusyError();
    this.inFlight = true;
    // 逐字段复制避免调用者在异步测试途中修改 React 草稿；只覆盖 enabled，其他端点字段仍须保持已验证值。
    const candidate = Object.freeze({ ...settings, enabled: true });
    try {
      const [http, browser] = await Promise.all([
        this.testHttp(candidate, AbortSignal.timeout(this.timeoutMs)),
        this.browser
          ? this.browser.probe(candidate, fixedBrowserTarget, AbortSignal.timeout(this.timeoutMs)).catch(() => "failed" as const)
          : Promise.resolve("failed" as const),
      ]);
      return { http, browser };
    } finally {
      // 网络、浏览器或超时失败也必须释放互斥锁，否则管理员无法修正端点后重新测试。
      this.inFlight = false;
    }
  }

  /** HTTP 失败只影响自身三态，浏览器通道仍会独立完成，方便定位代理对不同客户端的兼容性。 */
  private async testHttp(settings: ProxySettings, signal: AbortSignal): Promise<ProxyConnectionTestStatus> {
    try {
      const result = await this.outbound.probe(settings, fixedHttpTarget, { method: "GET", signal });
      return statusForPath(result.path);
    } catch {
      return "failed";
    }
  }
}

/** direct 仅表示关闭代理时的普通业务路径，测试草稿始终启用，故不能被页面伪装成代理连接成功。 */
function statusForPath(path: TransportPath): ProxyConnectionTestStatus {
  return path === "proxy" ? "proxy-success" : path === "direct-fallback" ? "direct-fallback-success" : "failed";
}
