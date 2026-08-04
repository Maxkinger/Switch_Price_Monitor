import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { createServerApp } from "./app";
import type { ServerConfig } from "./config";
import type { ServerDependencies } from "./dependencies";

export interface RunningServer {
  close(): Promise<void>;
  finished(): Promise<void>;
  address(): { port: number };
}

/**
 * 启动 Node 原生 HTTP 适配器并把每个请求转换为标准 Fetch Request；
 * close 先停止新连接，再等待 Node 完成已有响应，超时后主动销毁连接，避免 NAS 发布时请求无限悬挂。
 */
export async function startServer(config: ServerConfig, dependencies: ServerDependencies): Promise<RunningServer> {
  const app = createServerApp(config, dependencies);
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer(async (incoming, outgoing) => {
    try {
      const request = await toRequest(incoming, config.maximumBodyBytes);
      if (!request) {
        await writeResponse(outgoing, Response.json({ code: "PAYLOAD_TOO_LARGE", error: "请求内容过大。" }, { status: 413 }));
        return;
      }
      await writeResponse(outgoing, await app.fetch(request));
    } catch {
      await writeResponse(outgoing, Response.json({ code: "INTERNAL_ERROR", error: "服务器暂时无法处理请求。" }, { status: 500 }));
    }
  });
  // 仅维护本服务器接受的 socket，以便超过优雅期限时释放卡死客户端；正常 close 始终先给进行中的响应完成机会。
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    // 容器必须监听所有容器接口，Compose/NAS 端口映射才能把 LAN 请求送到应用；PostgreSQL 仍只在 Compose 私网可达。
    server.listen(config.port, "0.0.0.0", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  let finishedResolve!: () => void;
  const finished = new Promise<void>((resolveFinished) => { finishedResolve = resolveFinished; });
  let closing: Promise<void> | undefined;
  return {
    address: () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("服务器尚未监听 TCP 端口。");
      return { port: address.port };
    },
    close: () => {
      if (closing) return closing;
      closing = new Promise<void>((resolveClose) => {
        const timer = setTimeout(() => {
          for (const socket of sockets) socket.destroy();
          resolveClose();
          finishedResolve();
        }, config.shutdownGraceMs);
        server.close(() => {
          clearTimeout(timer);
          resolveClose();
          finishedResolve();
        });
      });
      return closing;
    },
    finished: () => finished,
  };
}

/** 将 Node IncomingMessage 读取为有上限的 Fetch Request；超限正文在进入业务路由前即停止读取。 */
async function toRequest(incoming: IncomingMessage, maximumBodyBytes: number): Promise<Request | null> {
  const contentLength = Number(incoming.headers["content-length"] ?? 0);
  if (contentLength > maximumBodyBytes) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of incoming) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maximumBodyBytes) return null;
    chunks.push(buffer);
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(", "));
    else if (value !== undefined) headers.set(key, value);
  }
  const body = ["GET", "HEAD"].includes(incoming.method ?? "GET") ? undefined : Buffer.concat(chunks);
  return new Request(`http://${headers.get("host") ?? "127.0.0.1"}${incoming.url ?? "/"}`, {
    method: incoming.method,
    headers,
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

/** 把 Fetch Response 的多值 Cookie 与正文安全写回 Node；内部错误只在 app 层转为公开 JSON。 */
async function writeResponse(outgoing: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  const setCookies = response.headers.getSetCookie?.();
  if (setCookies && setCookies.length > 0) headers["set-cookie"] = setCookies;
  outgoing.writeHead(response.status, headers);
  if (response.body && response.status !== 204) outgoing.end(Buffer.from(await response.arrayBuffer()));
  else outgoing.end();
}
