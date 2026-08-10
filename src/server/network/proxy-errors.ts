/**
 * 代理失败只向上层暴露稳定类别和固定中文摘要。
 * 底层 socket、DNS、TLS 与代理 URL 可能含有敏感拓扑或凭据，故只能作为未序列化 cause 留在当前进程诊断。
 */
export type ProxyFailureCategory = "proxy-authentication-required" | "dns" | "connect-timeout" | "tls" | "connection" | "unknown-transport";

/** 出站层据此判断是否允许一次直连回退，而不依赖易变的底层错误文本。 */
export class ProxyTransportError extends Error {
  public constructor(public readonly category: ProxyFailureCategory, cause?: unknown) {
    super("代理连接失败。", cause === undefined ? undefined : { cause });
    this.name = "ProxyTransportError";
  }
}

/** 仅识别自身固定错误，避免把业务解析异常误判为可直连回退的代理传输失败。 */
export function isProxyTransportError(error: unknown): error is ProxyTransportError { return error instanceof ProxyTransportError; }

/** 将稳定 Node 错误 code/name 映射为安全类别；原始 message 永不进入 API 响应或日志。 */
export function classifyProxyError(error: unknown): ProxyTransportError {
  if (error instanceof ProxyTransportError) return error;
  const candidate = error as { code?: unknown; name?: unknown } | null;
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  const name = typeof candidate?.name === "string" ? candidate.name : "";
  if (["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "ENETUNREACH"].includes(code)) return new ProxyTransportError("dns", error);
  if (["ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(code) || name === "TimeoutError") return new ProxyTransportError("connect-timeout", error);
  if (["CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"].includes(code) || name === "TLSError") return new ProxyTransportError("tls", error);
  if (["ECONNREFUSED", "ECONNRESET", "EPIPE", "EHOSTUNREACH"].includes(code)) return new ProxyTransportError("connection", error);
  return new ProxyTransportError("unknown-transport", error);
}
