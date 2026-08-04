import { readFile, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute, extname, join } from "node:path";

import type { ServerDependencies } from "./dependencies";

export interface ServerAppConfig {
  staticDirectory: string;
  maximumBodyBytes: number;
}

/**
 * Node Fetch 应用组合器。它保持平台中立路由的 Request/Response 契约，先处理健康检查与 API，
 * 再在归一化的客户端构建根内读取静态文件；路径越界和超大请求在进入认证、订阅或数据库服务前拒绝。
 */
export function createServerApp(config: ServerAppConfig, dependencies: ServerDependencies): { fetch(request: Request): Promise<Response> } {
  const staticRoot = resolve(config.staticDirectory);
  return {
    async fetch(request: Request): Promise<Response> {
      // URL 构造器会自动折叠 %2e%2e；先检查原始 URL，避免攻击者利用规范化把越界意图伪装成普通客户端路由。
      const rawPath = request.url.split(/[?#]/, 1)[0] ?? "";
      if (/(?:^|\/)(?:\.\.|%2e%2e)(?:\/|$)/i.test(rawPath)) return new Response("Not Found", { status: 404 });
      const url = new URL(request.url);
      if (url.pathname === "/api/health") return Response.json({ ok: true, service: "switch-price-monitor" });
      if (url.pathname.startsWith("/api/")) {
        const prepared = await limitRequestBody(request, config.maximumBodyBytes);
        if (!prepared) return Response.json({ code: "PAYLOAD_TOO_LARGE", error: "请求内容过大。" }, { status: 413 });
        const response = await dependencies.dispatchApi(prepared);
        return response ?? Response.json({ code: "NOT_FOUND", error: "接口不存在。" }, { status: 404 });
      }
      return serveClientFile(staticRoot, url.pathname, request.method);
    },
  };
}

/** 根据 Content-Length 和实际流长度双重限制正文；HTTP 层不得把大 JSON 交给认证或订阅服务缓冲。 */
async function limitRequestBody(request: Request, maximumBodyBytes: number): Promise<Request | null> {
  if (request.body === null || ["GET", "HEAD"].includes(request.method)) return request;
  const declared = request.headers.get("content-length");
  if (declared && Number.isSafeInteger(Number(declared)) && Number(declared) > maximumBodyBytes) return null;
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maximumBodyBytes) return null;
  return new Request(request, { body: bytes, duplex: "half" } as RequestInit & { duplex: "half" });
}

/** 静态资源只允许位于构建根；不可解码、NUL 或 .. 越界路径统一 404，不泄露文件系统位置。 */
async function serveClientFile(root: string, pathname: string, method: string): Promise<Response> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return new Response("Not Found", { status: 404 });
  }
  if (decoded.includes("\0")) return new Response("Not Found", { status: 404 });
  const requested = resolve(root, `.${decoded}`);
  const relativePath = relative(root, requested);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) return new Response("Not Found", { status: 404 });
  const candidate = await regularFile(requested);
  const file = candidate ? requested : join(root, "index.html");
  if (!candidate && (decoded.startsWith("/assets/") || !isClientRoute(decoded))) return new Response("Not Found", { status: 404 });
  const body = await readFile(file);
  return new Response(method === "HEAD" ? null : body, { status: 200, headers: { "content-type": contentType(file) } });
}

/** 只有已知 SPA 页面路径允许回退 index.html；任意未知路径都返回 404，避免把越界/拼写错误伪装成成功页面。 */
function isClientRoute(pathname: string): boolean {
  return pathname === "/" || ["/login", "/recover", "/setup", "/dashboard", "/settings", "/subscriptions", "/history", "/products"].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

async function regularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** 仅按扩展名设置有限 MIME 白名单，未知构建产物使用二进制默认值而不猜测可执行脚本类型。 */
function contentType(path: string): string {
  return ({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon",
  } as Record<string, string>)[extname(path).toLowerCase()] ?? "application/octet-stream";
}
