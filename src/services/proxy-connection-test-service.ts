import type { OutboundNetwork, TransportPath } from "../server/network/outbound-network";
import type { ProxySettings } from "../shared/proxy-settings";

/** 连接测试只允许固定目标；管理员不能把设置页变成任意 URL 探测器或内网转发器。 */
const fixedHttpTarget = "https://www.nintendo.com/robots.txt";
const fixedBrowserTarget = "https://store-jp.nintendo.com/robots.txt";

/** 连接测试的安全三态，代理主机、完整 URL 和底层错误不会进入响应。 */
export type ProxyConnectionTestStatus = "proxy-success" | "direct-fallback-success" | "failed";

export interface ProxyConnectionTestResult {
  http: ProxyConnectionTestStatus;
  browser: ProxyConnectionTestStatus;
}

/** 浏览器探测只接收固定 URL 和已校验草稿；它不读取数据库，也不暴露页面正文或 Cookie。 */
export interface ProxyBrowserConnectionProbe {
  probe(settings: ProxySettings, target: string, signal: AbortSignal): Promise<ProxyConnectionTestStatus>;
}

/** 同一管理员只能同时运行一组 HTTP/浏览器探测，避免测试按钮制造并发 Chromium 和代理流量。 */
export class ProxyConnectionTestBusyError extends Error {
  public constructor() {
    super("代理连接测试正在进行。");
    this.name = "ProxyConnectionTestBusyError";
  }
}

/**
 * 使用统一出站层测试固定 HTTPS 目标。
 * 任何完整 HTTP 响应都证明传输可达；4xx/5xx 仍由测试视为连接成功，不因业务状态码再次直连。
 */
export class ProxyConnectionTestService {
  private inFlight = false;

  public constructor(
    private readonly outbound: Pick<OutboundNetwork, "probe">,
    private readonly browser?: ProxyBrowserConnectionProbe,
    private readonly timeoutMs = 8_000,
  ) {}

  /** 测试草稿不读取或写入持久化设置；即使保存开关关闭也临时启用端点，返回两个固定通道的安全路径分类。 */
  public async test(settings: ProxySettings): Promise<ProxyConnectionTestResult> {
    if (this.inFlight) throw new ProxyConnectionTestBusyError();
    this.inFlight = true;
    const candidate = Object.freeze({ ...settings, enabled: true });
    try {
      const httpSignal = AbortSignal.timeout(this.timeoutMs);
      const browserSignal = AbortSignal.timeout(this.timeoutMs);
      const [http, browser] = await Promise.all([
        this.testHttp(candidate, httpSignal),
        this.browser ? this.browser.probe(candidate, fixedBrowserTarget, browserSignal).catch(() => "failed" as const) : Promise.resolve("failed" as const),
      ]);
      return { http, browser };
    } finally {
      this.inFlight = false;
    }
  }

  /** HTTP 连接失败只影响 HTTP 三态；浏览器通道继续独立运行，避免一个诊断通道遮蔽另一个。 */
  private async testHttp(settings: ProxySettings, signal: AbortSignal): Promise<ProxyConnectionTestStatus> {
    try {
      const result = await this.outbound.probe(settings, fixedHttpTarget, { method: "GET", signal });
      return statusForPath(result.path);
    } catch {
      return "failed";
    }
  }
}

/** 统一映射出站路径；direct 只会在代理关闭时出现，不向管理员伪装成代理成功。 */
function statusForPath(path: TransportPath): ProxyConnectionTestStatus {
  return path === "proxy" ? "proxy-success" : path === "direct-fallback" ? "direct-fallback-success" : "failed";
}
