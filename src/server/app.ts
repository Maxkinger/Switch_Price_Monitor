import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { Hono } from "hono";

/** Node HTTP 层只依赖一个平台中立 API 分发函数；null 明确表示应继续处理 API 404 或静态前端。 */
export interface ServerDependencies {
  dispatchApi(request: Request): Promise<Response | null>;
}

interface ServerAppConfig {
  staticDirectory: string;
  maximumBodyBytes: number;
}

/** 可由 Node adapter 和纯 Fetch 测试共同消费的最小应用接口。 */
export interface ServerApp {
  fetch(request: Request): Promise<Response>;
}

/**
 * Hono 仅把标准 Fetch Request 接到一个总入口；业务路由仍接收调用方原始的同源 Request，
 * 不复制认证 Cookie、请求体或 URL，也不启用 CORS。静态文件读取发生在所有 API 分发之后。
 */
export function createServerApp(
  config: ServerAppConfig,
  dependencies: ServerDependencies,
): ServerApp {
  const app = new Hono();
  /**
   * Hono 默认错误处理会把原始 Error 打到 console，其中可能含数据库 URL、Telegram 凭据、SQL 或外部响应。
   * Node 入口必须覆盖它：既不读取 error.message/stack，也不记录异常对象，只返回固定安全 JSON。
   * 已知路由自行返回的 4xx/5xx Response 不会进入此回调，因而原有领域状态和文案保持不变。
   */
  app.onError(() => Response.json(
    { code: "INTERNAL_ERROR", error: "服务暂时无法处理请求，请稍后重试。" },
    { status: 500 },
  ));
  app.all("*", async (context) => {
    const request = context.req.raw;
    if (await exceedsBodyLimit(request, config.maximumBodyBytes)) {
      return Response.json(
        { code: "PAYLOAD_TOO_LARGE", error: "请求内容过大。" },
        { status: 413 },
      );
    }

    const pathname = new URL(request.url).pathname;
    // 健康检查固定且不读取数据库或秘密，供本地、容器和 NAS 健康探针安全使用。
    if (pathname === "/api/health" && request.method === "GET") {
      return Response.json({ ok: true, service: "switch-price-monitor" });
    }

    const apiResponse = await dependencies.dispatchApi(request);
    if (apiResponse) return apiResponse;
    if (pathname.startsWith("/api/")) {
      return Response.json(
        { code: "NOT_FOUND", error: "接口不存在。" },
        { status: 404 },
      );
    }

    return serveStaticOrSpa(request, config.staticDirectory);
  });

  return {
    // 直接把 Request 交给 Hono；context.req.raw 保留该实例，路由可安全克隆正文但不会被适配层重建。
    fetch: (request) => Promise.resolve(app.fetch(request)),
  };
}

/**
 * 在业务路由解析 JSON 前检查真实流字节数。Content-Length 只用于快速拒绝，缺失或伪造为较小值时仍逐块读取克隆流；
 * 读取的是 clone，原始 Request 会完整交给现有路由，且超限后立即取消克隆以停止无意义缓冲。
 */
async function exceedsBodyLimit(request: Request, maximumBodyBytes: number): Promise<boolean> {
  if (request.body === null) return false;
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && /^\d+$/u.test(contentLength)) {
    const declared = Number(contentLength);
    if (Number.isSafeInteger(declared) && declared > maximumBodyBytes) return true;
  }

  const reader = request.clone().body?.getReader();
  if (!reader) return false;
  let consumed = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return false;
      consumed += chunk.value.byteLength;
      if (consumed > maximumBodyBytes) {
        /**
         * clone() 使用 tee 流；等待 cancel promise 会连带等待仍交给业务层的原始分支，
         * 从而在返回 413 前形成死锁。这里只发起本分支取消并吞掉清理拒绝，响应无需等待另一分支消费。
         */
        void reader.cancel().catch(() => undefined);
        return true;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** 静态 MIME 白名单只覆盖前端构建常见格式；未知扩展使用二进制，禁止浏览器凭内容猜测可执行类型。 */
const mimeTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * 静态服务先拒绝编码穿越和绝对路径形态，再用 realpath 同时校验规范根与最终目标。
 * 因此 `..`、双重编码和根内指向外部的符号链接都不能读取文件；安全的普通客户端路由才回退 index.html。
 */
async function serveStaticOrSpa(request: Request, staticDirectory: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return notFoundResponse();
  const decodedPath = safelyDecodePath(new URL(request.url).pathname);
  if (decodedPath === null) return notFoundResponse();

  const canonicalRoot = await realpath(staticDirectory).catch(() => null);
  if (canonicalRoot === null) return notFoundResponse();
  const relativePath = decodedPath.slice(1);
  const candidate = resolve(canonicalRoot, relativePath);
  if (!isWithinRoot(canonicalRoot, candidate)) return notFoundResponse();

  const fileResponse = await readSafeFile(candidate, canonicalRoot, request.method);
  if (fileResponse === unsafeStaticTarget) return notFoundResponse();
  if (fileResponse !== null) return fileResponse;

  const indexPath = resolve(canonicalRoot, "index.html");
  const indexResponse = await readSafeFile(indexPath, canonicalRoot, request.method);
  return indexResponse === unsafeStaticTarget ? notFoundResponse() : indexResponse ?? notFoundResponse();
}

/**
 * 最多三轮解码足以捕获普通、双重和三重转义攻击；若解码后仍含百分号编码则保守拒绝。
 * 反斜线按跨平台分隔风险处理，NUL、双斜线和任一 `..` 段都不能成为文件系统相对路径。
 */
function safelyDecodePath(pathname: string): string | null {
  let decoded = pathname;
  try {
    for (let index = 0; index < 3; index += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    return null;
  }
  if (
    decoded.includes("\0")
    || decoded.includes("\\")
    || /%[0-9a-f]{2}/iu.test(decoded)
    || !decoded.startsWith("/")
    || decoded.startsWith("//")
    || decoded.split("/").some((segment) => segment === "..")
  ) {
    return null;
  }
  return decoded;
}

/** path.relative 同时处理同前缀兄弟目录，不能只用字符串 startsWith 判断根包含关系。 */
function isWithinRoot(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === "" || (
    pathFromRoot !== ".."
    && !pathFromRoot.startsWith(`..${sep}`)
    && !isAbsolute(pathFromRoot)
  );
}

const unsafeStaticTarget = Symbol("unsafe-static-target");

/**
 * 只有规范化后的普通文件才可读取。缺失文件返回 null 以允许 SPA 回退；
 * 已存在但 realpath 越根的符号链接返回独立标记，调用方必须直接 404，不能用 index.html 掩盖一次逃逸尝试。
 */
async function readSafeFile(
  candidate: string,
  canonicalRoot: string,
  method: string,
): Promise<Response | typeof unsafeStaticTarget | null> {
  const canonicalFile = await realpath(candidate).catch(() => null);
  if (canonicalFile === null) return null;
  if (!isWithinRoot(canonicalRoot, canonicalFile)) return unsafeStaticTarget;
  const metadata = await stat(canonicalFile).catch(() => null);
  if (!metadata?.isFile()) return null;
  const bytes = await readFile(canonicalFile);
  return new Response(method === "HEAD" ? null : new Uint8Array(bytes), {
    headers: {
      "content-type": mimeTypes[extname(canonicalFile).toLowerCase()] ?? "application/octet-stream",
      "x-content-type-options": "nosniff",
    },
  });
}

/** 非法静态路径只返回固定空 404，不暴露宿主绝对路径、文件存在性或读取异常。 */
function notFoundResponse(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
